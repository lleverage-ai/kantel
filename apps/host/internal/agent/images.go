package agent

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// keepImageVersions is how many of the newest image versions a prune keeps whatever uses them, so a version that
// was current a moment ago is still there to go back to.
const keepImageVersions = 2

// imagePatching is the host's part in versioned host images (Config.ImagePatching).
type imagePatching struct {
	// updater follows the control plane's image channel; nil with image patching off.
	updater *images.Updater
	// facts is Facts.Images, updated when a version is activated.
	facts atomic.Pointer[proto.HostImages]
	// busy is a check in flight: a welcome that arrives meanwhile doesn't queue another.
	busy atomic.Bool
	stop chan struct{}
	// held are the image files a tier was given for the daemon's lifetime (the isolate VM tier's, isolateImages):
	// their versions are kept by every prune.
	held []string
}

// isolateImages are the kernel and root filesystem the isolate VM tier runs on, with image patching: the immutable
// files the configured paths resolve to now, so its template and every runtime restored from it stay on one version
// whatever an activation does to current. It takes new images when the daemon next starts (a self-update restarts
// it), and rebuilds its template then, its fingerprint having changed. Without image patching, the paths as they are.
func (h *Host) isolateImages(cfg Config) (kernel, rootfs string) {
	if !cfg.ImagePatching {
		return cfg.Kernel, cfg.IsolateImage
	}
	resolve := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			if abs, err := filepath.Abs(r); err == nil {
				return abs
			}
			return r
		}
		return p
	}
	rootfs, kernel = resolve(cfg.IsolateImage), resolve(cfg.Kernel)
	// One version's kernel with its root filesystem: an activation between the two resolutions can't pair them across.
	if v := images.VersionOf(rootfs); v != "" && images.VersionOf(kernel) != "" && images.VersionOf(kernel) != v {
		if same := filepath.Join(filepath.Dir(rootfs), filepath.Base(kernel)); fileExists(same) {
			kernel = same
		}
	}
	h.patching.held = append(h.patching.held, kernel, rootfs)
	return kernel, rootfs
}

// imageTier is a tier whose sandboxes are pinned to image versions (microvm).
type imageTier interface {
	// BasesInUse are the versions its sandboxes, snapshots and templates are on.
	BasesInUse() map[string]bool
	// LockBases holds off every new or moving reference to a version (a create, a template swap, a warm sandbox's move,
	// a snapshot's save) until unlock: a prune holds it from BasesInUse until its removals are done.
	LockBases() (unlock func())
	// ImagesChanged says a new version is current, so stale templates start rebuilding.
	ImagesChanged()
	// PinBases pins what was made before the images were versioned to the version it is on (a no-op once done): until
	// it has, an activation would move those references with current and a prune couldn't see them, so neither runs.
	PinBases() error
}

// pinBases runs every image tier's PinBases: an update or prune goes ahead only once all have succeeded.
func (h *Host) pinBases() error {
	var errs []error
	for _, name := range h.order {
		if t, ok := h.tiers[name].(imageTier); ok {
			if err := t.PinBases(); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

// configuredVersions are the store versions the host config's image and kernel paths resolve to: one pinned by path
// to an older version's file is in use for as long as the config names it (the defaults, through current, are the
// current version's).
func (h *Host) configuredVersions() map[string]bool {
	in := map[string]bool{}
	for _, p := range append([]string{h.cfg.Kernel, h.cfg.SandboxImage, h.cfg.IsolateImage}, h.patching.held...) {
		if p == "" {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(p); err == nil {
			if v := images.VersionOf(resolved); v != "" {
				in[v] = true
			}
		}
	}
	return in
}

func imageStore(cfg Config) images.Store { return images.Store{Dir: cfg.ImagesDir} }

func imageVerifier(cfg Config, log *slog.Logger) images.Verifier {
	return images.Verifier{
		Policy: cfg.ImageSignatures, Cosign: cfg.Cosign, Identity: cfg.ImageIdentity, Issuer: cfg.ImageIssuer,
		Key: cfg.ImageKey, Log: log,
	}
}

// PrepareImages readies image patching before the daemon starts its tiers: cosign for signature checks, the default
// image paths as links to the current version (moving plain files from an older install into a version of their
// own), and Firecracker at the version this binary pins (a new host binary, which the self-update delivers, pins a
// new one). Nothing here stops the host: a failure is logged and the host runs on what it has.
func PrepareImages(ctx context.Context, cfg Config, firecrackerVersion string, log *slog.Logger) {
	if !cfg.ImagePatching {
		return
	}
	if cfg.ImageSignatures != images.PolicyOff && !fileExists(cfg.Cosign) {
		if err := images.FetchCosign(ctx, cfg.Cosign); err != nil {
			log.Warn("couldn't fetch cosign: host images can't be checked, so updates are refused under imageSignatures require", "cosign", cfg.Cosign, "error", err)
		}
	}
	if err := imageStore(cfg).Link(images.Paths{Kernel: cfg.Kernel, SandboxImage: cfg.SandboxImage, IsolateImage: cfg.IsolateImage}); err != nil {
		log.Warn("couldn't link the default image paths to the versioned images", "dir", cfg.ImagesDir, "error", err)
	}
	if kvm, _ := hostinfo.KVM(); kvm && firecrackerVersion != "" {
		// Replaced by a rename: running VMs keep their process; the templates' fingerprint sees the new binary.
		if have := images.FirecrackerVersionOf(cfg.Firecracker); have != firecrackerVersion {
			log.Info("fetching Firecracker", "have", have, "want", firecrackerVersion)
			if err := images.FetchFirecracker(ctx, cfg.Firecracker, firecrackerVersion); err != nil {
				log.Warn("couldn't fetch Firecracker; running the one installed", "error", err)
			}
		}
	}
}

// startImagePatching makes the updater and starts the hourly prune. Called from New, before the facts are made.
func (h *Host) startImagePatching(kvm bool) {
	store := imageStore(h.cfg)
	h.patching.updater = &images.Updater{
		Store: store, Verifier: imageVerifier(h.cfg, h.log), Arch: images.Arch(), KVM: kvm, Log: h.log,
		OnActivate: h.imagesActivated,
	}
	current, _ := store.Current()
	h.patching.facts.Store(&proto.HostImages{
		Version: current, Firecracker: images.FirecrackerVersionOf(h.cfg.Firecracker),
		AutoUpdate: h.cfg.autoUpdateImages(), Signatures: h.cfg.ImageSignatures,
	})
	h.patching.stop = make(chan struct{})
	go h.pruneImagesEvery(h.patching.stop, time.Hour)
}

func (h *Host) stopImagePatching() {
	if stop := h.patching.stop; stop != nil {
		h.patching.stop = nil
		close(stop)
	}
}

// followImages starts a check of the images the control plane wants, in the background: the session never waits on
// a download. An E2E host is updated on the machine, as its binary is.
func (h *Host) followImages(ctx context.Context, ch *proto.ImageChannel) {
	u := h.patching.updater
	if ch == nil || u == nil || !h.cfg.ImagePatching || !h.cfg.autoUpdateImages() {
		return
	}
	if h.e2e != nil && h.e2e.Enrolled() {
		h.log.Info("not updating host images from the gateway: this host has joined an E2E space, so it is updated on the machine", "to", ch.Version)
		return
	}
	if current, ok := u.Store.Current(); ok && current == ch.Version {
		return
	}
	if !h.patching.busy.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer h.patching.busy.Store(false)
		// Not the session's: a reconnect mustn't abandon a download half-way.
		checkCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Hour)
		defer cancel()
		h.log.Info("updating host images", "to", ch.Version, "channel", ch.Channel)
		if err := h.checkImages(checkCtx, u, *ch); errors.Is(err, e2e.ErrEnrolled) {
			h.log.Info("not updating host images from the gateway: this host has joined an E2E space, so it is updated on the machine", "to", ch.Version)
		} else if err != nil {
			h.log.Error("host images update failed; new sandboxes stay on the current images", "to", ch.Version, "error", err)
		}
	}()
}

// checkImages runs an update the gateway asked for under the E2E store's enrolment lock, the one a join takes first,
// as gatewayUpdate runs a binary update: one that started before a join finishes (download, checks and activation)
// before the join completes, and none runs on a host that has joined (e2e.ErrEnrolled). The images are what every
// sandbox boots, so one the gateway picks could read an E2E space's sandboxes.
func (h *Host) checkImages(ctx context.Context, u *images.Updater, ch proto.ImageChannel) error {
	if err := h.pinBases(); err != nil {
		return err
	}
	if h.e2e == nil {
		return u.Check(ctx, ch)
	}
	return h.e2e.Unenrolled(func() error { return u.Check(ctx, ch) })
}

// rebaseTier is a tier that can move a sandbox onto other images (the microVM tier), and says which version it would.
type rebaseTier interface {
	RebaseVersion() string
}

// hostImages answers host.images: the host's images as they are now. With a sandboxId, Version is the version a
// rebase of that sandbox would land on (its tier's, which a config naming its root filesystem by path can hold back
// from the store's current one), and a sandbox whose tier doesn't rebase is refused as unsupported.
func (h *Host) hostImages(params json.RawMessage) (any, error) {
	if !h.cfg.ImagePatching {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "image patching is off on this host (imagePatching in its config)"}
	}
	var p proto.HostImagesParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &proto.Error{Code: proto.ErrInvalid, Message: "bad host.images params"}
		}
	}
	answer := proto.HostImages{}
	if have := h.patching.facts.Load(); have != nil {
		answer = *have
	}
	if p.SandboxID == "" {
		return answer, nil
	}
	version, err := h.rebaseVersion(p.SandboxID)
	if err != nil {
		return nil, err
	}
	answer.Version = version
	return answer, nil
}

// rebaseVersion is the one answer to where a rebase of a sandbox lands: its tier's RebaseVersion (what the tier's
// root filesystem resolves to now, which a config naming it by path holds back from the store's current one). Both
// host.images's preflight and sandbox.start's check ask it, so what the preflight passes the start takes. A sandbox
// whose tier doesn't rebase, or a host without image patching, has none.
func (h *Host) rebaseVersion(sandboxID string) (string, error) {
	if !h.cfg.ImagePatching {
		return "", &proto.Error{Code: proto.ErrUnsupported, Message: "image patching is off on this host (imagePatching in its config)"}
	}
	t, name, err := h.tierOfNamed(sandboxID)
	if err != nil {
		return "", err
	}
	rt, ok := t.(rebaseTier)
	if !ok {
		return "", &proto.Error{Code: proto.ErrUnsupported, Message: "a " + name + " sandbox isn't moved onto other images"}
	}
	return rt.RebaseVersion(), nil
}

// rebaseTarget refuses a sandbox.start whose rebase the gateway expects to land on to when the sandbox's rebase
// would land on another version (rebaseVersion): the host hasn't taken that update, or its config holds the tier on
// another, and a rebase would land elsewhere.
func (h *Host) rebaseTarget(sandboxID, to string) error {
	have, err := h.rebaseVersion(sandboxID)
	if err != nil {
		return err
	}
	if have != to {
		return images.NotCurrent(have, to)
	}
	return nil
}

// imagesActivated is the updater's OnActivate: the facts say the new version, and the tiers start rebuilding what
// was made on the old one.
func (h *Host) imagesActivated(version string) {
	if f := h.patching.facts.Load(); f != nil {
		next := *f
		next.Version = version
		h.patching.facts.Store(&next)
	}
	for _, name := range h.order {
		if t, ok := h.tiers[name].(imageTier); ok {
			t.ImagesChanged()
		}
	}
}

func (h *Host) pruneImagesEvery(stop <-chan struct{}, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			h.pruneImages()
		}
	}
}

// pruneImages removes the image versions nothing uses: not current, not among the newest few, and no sandbox,
// snapshot or template on them. The tiers' base locks are held from their walk until the removals are done, so no
// reference to a version is made or moved between finding it unused and removing it.
func (h *Host) pruneImages() []string {
	u := h.patching.updater
	if u == nil {
		return nil
	}
	if err := h.pinBases(); err != nil {
		h.log.Warn("not pruning host images: what was made before they were versioned isn't pinned yet", "error", err)
		return nil
	}
	inUse := func() (func(string) bool, func()) {
		var unlocks []func()
		used := h.configuredVersions()
		for _, name := range h.order {
			if t, ok := h.tiers[name].(imageTier); ok {
				unlocks = append(unlocks, t.LockBases())
				for v := range t.BasesInUse() {
					used[v] = true
				}
			}
		}
		release := func() {
			for i := len(unlocks) - 1; i >= 0; i-- {
				unlocks[i]()
			}
		}
		return func(v string) bool { return used[v] }, release
	}
	removed := u.Prune(inUse, keepImageVersions)
	if len(removed) > 0 {
		h.log.Info("removed host image versions nothing uses", "versions", removed)
	}
	return removed
}
