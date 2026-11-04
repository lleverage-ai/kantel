package agent

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

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
}

// imageTier is a tier whose sandboxes are pinned to image versions (microvm).
type imageTier interface {
	// BasesInUse are the versions its sandboxes, snapshots and templates are on.
	BasesInUse() map[string]bool
	// ImagesChanged says a new version is current, so stale templates start rebuilding.
	ImagesChanged()
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
			if err := images.FetchFirecracker(cfg.Firecracker, firecrackerVersion); err != nil {
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
		if err := u.Check(checkCtx, *ch); err != nil {
			h.log.Error("host images update failed; new sandboxes stay on the current images", "to", ch.Version, "error", err)
		}
	}()
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
// snapshot or template on them.
func (h *Host) pruneImages() []string {
	u := h.patching.updater
	if u == nil {
		return nil
	}
	inUse := map[string]bool{}
	for _, name := range h.order {
		if t, ok := h.tiers[name].(imageTier); ok {
			for v := range t.BasesInUse() {
				inUse[v] = true
			}
		}
	}
	removed := u.Prune(func(v string) bool { return inUse[v] }, keepImageVersions)
	if len(removed) > 0 {
		h.log.Info("removed host image versions nothing uses", "versions", removed)
	}
	return removed
}
