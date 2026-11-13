package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A template (the control plane's, packages/compute/src/templates.ts) is an image sandboxes are made from. A build
// (template.build) takes the image's root filesystem (rootfs.go: the host's own image, or a base pulled by digest and
// made into one), boots it once with the vCPUs and memory asked, runs the template's setup as root, and snapshots it
// as template-snapshots/<id>: state, mem, disk.ext4, rootfs (a link to the root filesystem: with versioned host images,
// the version of the host's image its build booted, which a prune keeps and a restore links, base.go) and meta.json. A
// sandbox
// made from a template is the machine its create asks for (a named size or a custom shape): it restores that snapshot
// when it was built with that machine's vCPUs and memory, or else boots the root filesystem and runs the setup itself.
// Template snapshots are a cache the control plane throws away and builds again; they are never sandboxes' own
// snapshots (snapshots/), and deleting one leaves its root filesystem, which sandboxes made from it read. A create shares the snapshot's lock while it copies and loads its files, so a delete
// waits for it; one that finds the snapshot gone, being replaced or broken boots the template fresh instead.

const templateSnapshotsDir = "template-snapshots"

// templateRootfsLink is the template snapshot's link to its root filesystem.
const templateRootfsLink = "rootfs"

// setupTimeout bounds a template's setup.
const setupTimeout = 30 * time.Minute

// templateCache is the tier's templates: their root filesystems, and one build or delete of each template snapshot at
// a time, with the restores reading it.
type templateCache struct {
	rootfs    *rootfsBuilder
	snapshots keyedLocks
	// runBuilder builds a custom image in a build microVM (bootBuilder; tests replace it).
	runBuilder func(ctx context.Context, job builderJob) (builderOutput, error)
}

func newTemplateCache(root string, run runner, registry string) *templateCache {
	return &templateCache{rootfs: newRootfsBuilder(filepath.Join(root, "images", "templates"), run, registry)}
}

// CanBuildTemplates says whether this host can build templates' images now: Docker installed and its daemon
// answering. Restoring a built template, or booting one whose root filesystem is made, doesn't need it.
func (m *Manager) CanBuildTemplates(ctx context.Context) error { return m.tpl.rootfs.ready(ctx) }

// CanBuildTemplateImages says whether this host builds templates' custom images (a Dockerfile, an image reference): its
// settings switch the builder on, and it boots images through Kantel's initramfs, which puts the guest agent into an
// image that isn't Kantel's. The host's Docker isn't needed, or used: the build microVM runs its own.
func (m *Manager) CanBuildTemplateImages() error {
	if m.cfg.TemplateBuilder == nil {
		return &proto.Error{Code: proto.ErrUnsupported, Message: "this host doesn't build templates' custom images: its settings don't switch templateBuilder on"}
	}
	if m.cfg.Initrd == "" {
		return &proto.Error{Code: proto.ErrUnsupported, Message: "this host doesn't build templates' custom images: they boot through the injected guest agent (injectGuestAgent), which is off"}
	}
	return nil
}

// templateRootfs is a template's root filesystem and its image's ID: the host's own image (Config.Rootfs, which a boot
// links as the version it resolves to then, pinRootfs) for a base with no digest, which the control plane sends only
// for its default base, with no Docker and no ID; else the base pulled by its digest and made into one (rootfs.go).
func (m *Manager) templateRootfs(ctx context.Context, img templateImage) (string, string, error) {
	if err := img.validate(); err != nil {
		return "", "", err
	}
	if img.BaseDigest == "" {
		return m.cfg.Rootfs, "", nil
	}
	return m.tpl.rootfs.rootfs(ctx, img)
}

// templateImageKind is what a template snapshot's builtFrom.image says it was made of: a Kantel base. A custom image's
// is its kind (proto.TemplateImageDockerfile, proto.TemplateImageRef).
const templateImageKind = "kantel-base"

// templateBuiltFrom is what a template snapshot was made of: its provenance.
type templateBuiltFrom struct {
	// Image is templateImageKind, or a custom image's kind.
	Image       string `json:"image"`
	BaseImage   string `json:"baseImage,omitempty"`
	BaseDigest  string `json:"baseDigest,omitempty"`
	ImageDigest string `json:"imageDigest,omitempty"`
	// RootfsKey names the pulled base's or custom image's root filesystem; empty for the host's own image.
	RootfsKey string `json:"rootfsKey,omitempty"`
	// DockerfileDigest (a Dockerfile's sha256:) or ImageRef (the reference pulled), for a custom image.
	DockerfileDigest string `json:"dockerfileDigest,omitempty"`
	ImageRef         string `json:"imageRef,omitempty"`
}

// custom says whether it was made of a custom image.
func (b templateBuiltFrom) custom() bool { return b.Image != "" && b.Image != templateImageKind }

// templateSnapshotMeta is a template snapshot's meta.json, written last: a directory without one isn't whole.
type templateSnapshotMeta struct {
	SnapshotID string `json:"snapshotId"`
	KeyHash    string `json:"keyHash"`
	// Rootfs is the root filesystem's path: images/templates/<key>.ext4, or the host's image as its build booted it (the
	// host image version's file, with image patching: base.go), which a prune keeps and a restore links.
	Rootfs string `json:"rootfs"`
	// Base is the host images version Rootfs is ("" for a pulled base, or images that aren't versioned).
	Base string `json:"base,omitempty"`
	// Runtime is the Firecracker and kernel it was made with, and the host's image when Rootfs is Config.Rootfs itself
	// (runtimeFingerprint): it restores only onto those.
	Runtime string `json:"runtime"`
	// CPU and PortableRuntime are what it was made on as other hosts can compare it (fingerprint.go): its host's CPU
	// and its runtime (portableRuntime). Absent from one made before they were kept.
	CPU             *proto.CPUFingerprint `json:"cpu,omitempty"`
	PortableRuntime string                `json:"portableRuntime,omitempty"`
	BuiltFrom       templateBuiltFrom     `json:"builtFrom"`
	VCPUs           int                   `json:"vcpus"`
	MemoryMiB       int                   `json:"memoryMiB"`
	DiskGiB         int                   `json:"diskGiB"`
	SizeBytes       int64                 `json:"sizeBytes"`
	CreatedAt       int64                 `json:"createdAt"`
	Timings         timings               `json:"timings,omitempty"`
	// Guest is what the template's image has, as its agent reported it at the build, before the setup ran (nil: an
	// agent too old to say). Not the host's shared report (Manager.guest): that is the default image's. A restore of
	// the snapshot reports this, as a fresh boot of the template reports what its own agent says at the same point.
	Guest *proto.GuestCapabilities `json:"guest,omitempty"`
}

func (k templateSnapshotMeta) result() proto.TemplateBuildResult {
	res := proto.TemplateBuildResult{
		Ref: k.SnapshotID, ImageDigest: k.BuiltFrom.ImageDigest, SizeBytes: k.SizeBytes, Timings: k.Timings,
		CPU: k.CPU, Runtime: k.PortableRuntime,
	}
	if k.BuiltFrom.custom() {
		res.RootfsKey, res.Source = k.BuiltFrom.RootfsKey, k.BuiltFrom.Image
		res.DockerfileDigest, res.ImageRef = k.BuiltFrom.DockerfileDigest, k.BuiltFrom.ImageRef
	}
	return res
}

func (m *Manager) templateSnapshotDir(id string) string {
	return filepath.Join(m.cfg.Root, templateSnapshotsDir, id)
}

// linkTemplateRootfs points dir's templateRootfsLink at rootfs, in one rename.
func linkTemplateRootfs(dir, rootfs string) error {
	link := filepath.Join(dir, templateRootfsLink)
	tmp := link + ".new"
	_ = os.Remove(tmp)
	if err := os.Symlink(rootfs, tmp); err != nil {
		return err
	}
	return os.Rename(tmp, link)
}

// runtimeFingerprint is the Firecracker and kernel the tier runs over rootfs now (kernelFor: a host image version's
// own kernel for its file), with the host's image when rootfs is Config.Rootfs itself: an update replaces that in
// place, whereas a host image version's file, like a pulled base's root filesystem under its key, never changes.
// With free page reporting on, it says so too: the balloon is a device the snapshot keeps, so one made without
// reporting is booted afresh instead (and one made with it isn't restored once it is off). So do the sticky drives.
func (m *Manager) runtimeFingerprint(rootfs string) string {
	var fp string
	if rootfs == m.cfg.Rootfs {
		fp = fc.Fingerprint(m.cfg.Firecracker, m.cfg.Kernel, m.cfg.Rootfs)
	} else {
		fp = fc.Fingerprint(m.cfg.Firecracker, m.kernelFor(rootfs))
	}
	// A snapshot restores the drives it was made with: one from before the sticky drives is booted afresh instead.
	fp += fmt.Sprintf("+sticky=%d", StickyDrives)
	if m.cfg.FreePageReporting {
		fp += "+free-page-reporting"
	}
	return fp
}

func badTemplateSnapshot() error {
	return &proto.Error{Code: proto.ErrInvalid, Message: "bad template snapshot ID"}
}

func (m *Manager) readTemplateSnapshot(id string) (templateSnapshotMeta, error) {
	if !validID(id) {
		return templateSnapshotMeta{}, badTemplateSnapshot()
	}
	raw, err := os.ReadFile(filepath.Join(m.templateSnapshotDir(id), "meta.json"))
	if err != nil {
		return templateSnapshotMeta{}, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no template snapshot %s on this host", id)}
	}
	var out templateSnapshotMeta
	return out, json.Unmarshal(raw, &out)
}

// keepTemplateSnapshot completes a template snapshot whose state, mem and disk.ext4 are in dir: its link to its root
// filesystem (replaced in one rename, so a prune's walk never finds it missing: BasesUnder), its size, and its
// meta.json.
func keepTemplateSnapshot(dir string, kept *templateSnapshotMeta) error {
	if err := linkTemplateRootfs(dir, kept.Rootfs); err != nil {
		return err
	}
	kept.Base = images.VersionOf(kept.Rootfs)
	kept.SizeBytes = diskUsage(filepath.Join(dir, fc.DiskFile)) + diskUsage(filepath.Join(dir, "mem"))
	raw, err := json.MarshalIndent(kept, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileDurably(filepath.Join(dir, "meta.json"), raw, 0o600)
}

// TemplateBuildMachine is the machine a template build boots, as a create of the same shape would get it: the named size
// with exactly the vCPUs, memory and disk asked, else that custom shape (CustomSizeName), which this host makes within
// its limits (ErrInvalid beyond them).
func (m *Manager) TemplateBuildMachine(p proto.TemplateBuildParams) (proto.Size, error) {
	if p.VCPUs <= 0 || p.MemoryMiB <= 0 || p.DiskGiB <= 0 {
		return proto.Size{}, &proto.Error{Code: proto.ErrInvalid, Message: "a template build needs its vcpus, memoryMiB and diskGiB"}
	}
	for _, size := range m.cfg.Sizes {
		if size.VCPUs == p.VCPUs && size.MemoryMiB == p.MemoryMiB && size.DiskGiB == p.DiskGiB {
			return size, nil
		}
	}
	return m.size(CustomSizeName(p.VCPUs, p.MemoryMiB, p.DiskGiB))
}

// BuildTemplate is template.build: the image's root filesystem (the host's own, or pulled and made, or from the cache),
// booted once, its setup run as root, snapshotted as template-snapshots/<SnapshotID>. A retry of a build that finished
// answers it again.
func (m *Manager) BuildTemplate(ctx context.Context, p proto.TemplateBuildParams) (proto.TemplateBuildResult, error) {
	if !validID(p.SnapshotID) {
		return proto.TemplateBuildResult{}, badTemplateSnapshot()
	}
	size, err := m.TemplateBuildMachine(p)
	if err != nil {
		return proto.TemplateBuildResult{}, err
	}
	img := templateImage{BaseImage: p.BaseImage, BaseDigest: p.BaseDigest}
	if err := img.validate(); err != nil {
		return proto.TemplateBuildResult{}, err
	}
	if p.Image != nil {
		if err := m.CanBuildTemplateImages(); err != nil {
			return proto.TemplateBuildResult{}, err
		}
		if err := validateTemplateImage(p.Image); err != nil {
			return proto.TemplateBuildResult{}, err
		}
	}
	defer m.tpl.snapshots.lock(p.SnapshotID)()
	dir := m.templateSnapshotDir(p.SnapshotID)
	if kept, err := m.readTemplateSnapshot(p.SnapshotID); err == nil && kept.KeyHash == p.KeyHash {
		return kept.result(), nil
	}
	// Its machine's memory and disk, admitted beside the sandboxes and the other builds and held until it has ended,
	// its image pull included: whether its control plane still waits or not, and whether its snapshot was deleted
	// meanwhile or not. A custom image's build microVM writes two drives of the machine's disk size (Docker's storage,
	// and the image's root filesystem), so twice its disk is held.
	release, err := m.holdBuild(p.SnapshotID, buildHold(size, p.Image != nil))
	if err != nil {
		return proto.TemplateBuildResult{}, err
	}
	defer release()
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return proto.TemplateBuildResult{}, err
	}
	t := timings{}
	start := time.Now()
	builtFrom := templateBuiltFrom{Image: templateImageKind, BaseImage: p.BaseImage, BaseDigest: p.BaseDigest}
	var rootfs, imageDigest string
	if p.Image != nil {
		// Built or pulled in a build microVM, under the template's egress with the operator's registries: never on the
		// host's Docker.
		var key string
		rootfs, imageDigest, key, err = m.customRootfs(ctx, p.SnapshotID, p.Owner, p.Image, img, size, p.Egress, p.Env)
		if err != nil {
			return proto.TemplateBuildResult{}, err
		}
		builtFrom.Image, builtFrom.RootfsKey = p.Image.Kind, key
		if p.Image.Kind == proto.TemplateImageDockerfile {
			builtFrom.DockerfileDigest = dockerfileDigest(p.Image.Dockerfile)
		} else {
			builtFrom.ImageRef = p.Image.Ref
		}
		t.step("image", &start)
	} else {
		rootfs, imageDigest, err = m.templateRootfs(ctx, img)
		if err != nil {
			return proto.TemplateBuildResult{}, err
		}
		if img.BaseDigest != "" {
			builtFrom.RootfsKey = img.key()
		}
		t.step("rootfs", &start)
	}
	builtFrom.ImageDigest = imageDigest
	// The build is a sandbox to the egress proxy while its setup runs, named after the snapshot, with the template's
	// grants; it has no network once the setup is done.
	build := &sandbox{meta: meta{ID: p.SnapshotID, Env: p.Env, Egress: p.Egress, Owner: p.Owner}}
	// The host's image boots as the version it resolves to now, which the snapshot keeps (its rootfs link, from the
	// build's directory on) and a restore links: a prune keeps that version while the snapshot is there.
	// Its runtime as it boots, before the setup runs (which may take many minutes, while the host's files change).
	var madeOn string
	booted, caps, booting, err := m.bootSnapshot(ctx, snapshotBoot{
		dir: dir, name: p.SnapshotID, rootfs: rootfs, size: size, egress: egressMode(p.Egress),
		record: func(building, rootfs, runtime string) error {
			madeOn = runtime
			return linkTemplateRootfs(building, rootfs)
		},
		prepare: func(ctx context.Context, client *guest.Client, link network.Link) error {
			build.link = &link
			m.attach(build, link.Slot)
			defer m.detach(link.Slot)
			if err := client.SetIdentity(ctx, m.identity(build, true)); err != nil {
				return fmt.Errorf("identity: %w", err)
			}
			return runSetup(ctx, client, p.Setup, p.Env)
		},
	})
	if err != nil {
		return proto.TemplateBuildResult{}, err
	}
	for k, v := range booted {
		t["boot."+k] = v
	}
	kept := templateSnapshotMeta{
		SnapshotID: p.SnapshotID, KeyHash: p.KeyHash, Rootfs: booting, Runtime: m.runtimeFingerprint(booting),
		CPU: m.CPU(), PortableRuntime: madeOn,
		BuiltFrom: builtFrom,
		VCPUs:     size.VCPUs, MemoryMiB: size.MemoryMiB, DiskGiB: size.DiskGiB, CreatedAt: time.Now().UnixMilli(), Timings: t,
		Guest: caps,
	}
	if err := keepTemplateSnapshot(dir, &kept); err != nil {
		_ = os.RemoveAll(dir)
		return proto.TemplateBuildResult{}, err
	}
	m.log.Info("template snapshot ready", "snapshot", p.SnapshotID, "timings", t)
	return kept.result(), nil
}

// DeleteTemplate is template.delete: the template snapshot's directory goes, and nothing else (not its root
// filesystem, which sandboxes made from it read). One that isn't there is gone already. It waits for the creates
// restoring the snapshot to have loaded it; creates that come meanwhile boot the template fresh.
func (m *Manager) DeleteTemplate(id string) error {
	if !validID(id) {
		return badTemplateSnapshot()
	}
	defer m.tpl.snapshots.lock(id)()
	return os.RemoveAll(m.templateSnapshotDir(id))
}

// templateOrigin is where a sandbox made from a template starts as a machine of size: its template snapshot when t
// names one this host can restore that was built with size's vCPUs and memory (over the root filesystem it records:
// the host image version it was built on, for the host's image), else its root filesystem (made if it isn't yet)
// booted fresh, which then runs the setup (the host's image as the version it resolves to now). Either holds the base
// lock until it is linked (origin.unhold).
func (m *Manager) templateOrigin(ctx context.Context, t proto.TemplateBoot, size proto.Size) (sandboxOrigin, error) {
	if t.Snapshot != "" {
		if !validID(t.Snapshot) {
			return sandboxOrigin{}, badTemplateSnapshot()
		}
		origin, err := m.leaseTemplateSnapshot(t.Snapshot, size)
		if err == nil {
			origin.unhold = m.holdBases()
			return origin, nil
		}
		// A cache miss: thrown away (or being replaced) while the create was on its way, made with another Firecracker,
		// kernel or machine, or broken. The template's image and setup still make the sandbox.
		m.log.Warn("template snapshot can't be restored here; booting the template fresh", "snapshot", t.Snapshot, "error", err)
	}
	tt := timings{}
	start := time.Now()
	rootfs := ""
	if t.Image != nil {
		// A custom image boots only the root filesystem a build on this host made: a create never builds one.
		if err := m.CanBuildTemplateImages(); err != nil {
			return sandboxOrigin{}, err
		}
		if err := validateTemplateImage(t.Image); err != nil {
			return sandboxOrigin{}, err
		}
		var path string
		ok := false
		if validKey(t.RootfsKey) {
			path, _, ok = m.tpl.rootfs.cached(t.RootfsKey)
		}
		if !ok {
			return sandboxOrigin{}, &proto.Error{Code: proto.ErrNotFound, Message: "the template's image isn't built on this host"}
		}
		return sandboxOrigin{rootfs: path, setup: t.Setup, source: "boot", timings: tt, askGuest: true, unhold: m.holdBases()}, nil
	}
	if t.RootfsKey != "" {
		if !validKey(t.RootfsKey) {
			return sandboxOrigin{}, &proto.Error{Code: proto.ErrInvalid, Message: "bad template root filesystem key"}
		}
		if path, _, ok := m.tpl.rootfs.cached(t.RootfsKey); ok {
			rootfs = path
		}
	}
	if rootfs == "" {
		path, _, err := m.templateRootfs(ctx, templateImage{BaseImage: t.BaseImage, BaseDigest: t.BaseDigest})
		if err != nil {
			return sandboxOrigin{}, err
		}
		rootfs = path
		tt.step("rootfs", &start)
	}
	// Its agent is asked, the host's image's too: the sandbox reports its template's own report, as a restore of the
	// template's snapshot does, not the host's shared one (Manager.guest), which no sandbox may have made yet.
	return sandboxOrigin{rootfs: rootfs, setup: t.Setup, source: "boot", timings: tt, askGuest: true, unhold: m.holdBases()}, nil
}

// leaseTemplateSnapshot is a template snapshot's origin for a machine of size, sharing its lock until the origin's
// release: a delete waits for the create to have copied its disk and loaded its state and memory. An error is a
// snapshot not to restore.
func (m *Manager) leaseTemplateSnapshot(id string, size proto.Size) (sandboxOrigin, error) {
	release, ok := m.tpl.snapshots.tryShare(id)
	if !ok {
		return sandboxOrigin{}, errors.New("it is being built or deleted")
	}
	origin, err := m.restorableTemplateSnapshot(id, size)
	if err != nil {
		release()
		return sandboxOrigin{}, err
	}
	origin.release = release
	return origin, nil
}

// restorableTemplateSnapshot is a template snapshot's origin when it is whole and made with the runtime the tier runs
// and size's vCPUs and memory: a restore keeps the machine the snapshot was taken of, so another would give the
// sandbox a machine other than the one it was placed and booted fresh as. Its disk is size's or smaller: a smaller
// one is grown to size's once the sandbox runs (origin.templateDiskGiB), and a bigger one can't be shrunk.
func (m *Manager) restorableTemplateSnapshot(id string, size proto.Size) (sandboxOrigin, error) {
	kept, err := m.readTemplateSnapshot(id)
	if err != nil {
		return sandboxOrigin{}, err
	}
	if kept.Runtime != m.runtimeFingerprint(kept.Rootfs) {
		return sandboxOrigin{}, fmt.Errorf("made with another Firecracker, kernel, host image or balloon (%s)", kept.Runtime)
	}
	if kept.VCPUs != size.VCPUs || kept.MemoryMiB != size.MemoryMiB {
		return sandboxOrigin{}, fmt.Errorf("built as %d vCPUs and %d MiB, not %d and %d", kept.VCPUs, kept.MemoryMiB, size.VCPUs, size.MemoryMiB)
	}
	if kept.DiskGiB > size.DiskGiB {
		return sandboxOrigin{}, fmt.Errorf("built with a %d GiB disk, more than %d", kept.DiskGiB, size.DiskGiB)
	}
	dir := m.templateSnapshotDir(id)
	origin := sandboxOrigin{rootfs: kept.Rootfs, state: filepath.Join(dir, "state"), mem: filepath.Join(dir, "mem"), disk: filepath.Join(dir, fc.DiskFile), source: "snapshot", templateSnapshot: id, templateDiskGiB: kept.DiskGiB, guest: kept.Guest, runtime: kept.PortableRuntime}
	for _, file := range []string{origin.rootfs, origin.state, origin.mem, origin.disk} {
		if !fileExists(file) {
			return sandboxOrigin{}, fmt.Errorf("%s is missing", file)
		}
	}
	return origin, nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// runSetup runs a template's setup as root with env, failing with the end of its output when it exits non-zero.
func runSetup(ctx context.Context, client *guest.Client, setup string, env map[string]string) error {
	if setup == "" {
		return nil
	}
	res, err := client.Exec(ctx, guest.ExecRequest{Command: setup, User: "root", Env: env, TimeoutMs: setupTimeout.Milliseconds()})
	if err != nil {
		return fmt.Errorf("the template's setup: %w", err)
	}
	return setupFailure(res)
}

// setupFailure is a setup's result as an error: nil when it exited 0.
func setupFailure(res guest.ExecResult) error {
	if res.ExitCode == 0 && !res.TimedOut {
		return nil
	}
	why := fmt.Sprintf("exited with %d", res.ExitCode)
	if res.TimedOut {
		why = fmt.Sprintf("took longer than %s", setupTimeout)
	}
	return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("the template's setup %s: %s", why, tailText(res.Stdout+"\n"+res.Stderr, 2000))}
}
