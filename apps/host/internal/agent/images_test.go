package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func writeFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// baseTier is a tier whose sandboxes are on image versions, and which records how a prune holds its base lock.
type baseTier struct {
	Tier // unimplemented methods panic

	inUse   map[string]bool
	locked  bool
	walked  bool // BasesInUse ran with the lock held
	unlock  func()
	unlocks int
	pinErr  error
	walkErr error
}

func (b *baseTier) PinBases() error { return b.pinErr }

func (b *baseTier) BasesInUse() (map[string]bool, error) {
	b.walked = b.locked
	return b.inUse, b.walkErr
}

func (b *baseTier) ImagesChanged() {}

func (b *baseTier) LockBases() func() {
	b.locked = true
	return func() {
		b.unlocks++
		if b.unlock != nil {
			b.unlock()
		}
		b.locked = false
	}
}

// A prune holds the tiers' base lock from its walk of what is in use until it has removed what wasn't: a reference
// made or moved meanwhile waits, so the version it names can't go between the walk and the removal.
func TestAPruneHoldsTheBasesUntilItHasRemoved(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	store := images.Store{Dir: filepath.Join(h.cfg.Root, "images")}
	first := time.Now().Add(-time.Hour)
	for i, v := range []string{"a", "b", "c", "d", "e"} {
		dir := filepath.Join(store.Dir, "v", v)
		writeFile(t, filepath.Join(dir, "manifest.json"), "{}")
		at := first.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(dir, at, at); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Activate("e"); err != nil {
		t.Fatal(err)
	}
	gone := func(v string) bool {
		_, err := os.Stat(filepath.Join(store.Dir, "v", v))
		return errors.Is(err, os.ErrNotExist)
	}
	tier := &baseTier{inUse: map[string]bool{"a": true}}
	tier.unlock = func() {
		if !gone("b") || !gone("c") {
			t.Error("the base lock was let go before the unused versions were removed")
		}
	}
	h.tiers = map[string]Tier{microvm.Tier: tier}
	h.order = []string{microvm.Tier}
	h.patching.updater = &images.Updater{Store: store, Log: h.log}
	removed := h.pruneImages()
	slices.Sort(removed)
	if !slices.Equal(removed, []string{"b", "c"}) {
		t.Fatalf("removed %v, want [b c]", removed)
	}
	if !tier.walked || tier.unlocks != 1 || tier.locked {
		t.Fatalf("walked under the lock %v, unlocked %d times, still locked %v", tier.walked, tier.unlocks, tier.locked)
	}
	for _, v := range []string{"a", "d", "e"} {
		if gone(v) {
			t.Errorf("%s was removed", v)
		}
	}
}

// A microVM tier that didn't start this time still keeps its saved sandboxes', snapshots' and templates' versions: a
// prune reads them from its directory, beside what the running tiers use, and an unreadable one stops the prune.
func TestAPruneKeepsTheBasesOfAMicroVMTierThatDidNotStart(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	store := images.Store{Dir: filepath.Join(h.cfg.Root, "images")}
	first := time.Now().Add(-time.Hour)
	for i, v := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		dir := filepath.Join(store.Dir, "v", v)
		writeFile(t, filepath.Join(dir, "manifest.json"), "{}")
		writeFile(t, filepath.Join(dir, "sandbox.ext4"), "x")
		at := first.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(dir, at, at); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Activate("g"); err != nil {
		t.Fatal(err)
	}
	// What the microVM tier saved when it last ran: a stopped sandbox on a, a snapshot on b, a template on c.
	mv := filepath.Join(h.cfg.Root, "microvm")
	vm := filepath.Join(mv, "sandboxes", "sbx_1", "vm")
	if err := os.MkdirAll(vm, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(store.Dir, "v", "a", "sandbox.ext4"), filepath.Join(vm, "rootfs.ext4")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(mv, "snapshots", "snap_1", "meta.json"),
		`{"rootfs":"`+filepath.Join(store.Dir, "v", "b", "sandbox.ext4")+`"}`)
	writeFile(t, filepath.Join(mv, "templates", "default", "rootfs"), filepath.Join(store.Dir, "v", "c", "sandbox.ext4")+"\n")
	// Only another tier runs, on d.
	tier := &baseTier{inUse: map[string]bool{"d": true}}
	h.tiers = map[string]Tier{"isolate": tier}
	h.order = []string{"isolate"}
	h.patching.updater = &images.Updater{Store: store, Log: h.log}

	// One of its snapshots unreadable: nothing goes.
	bad := filepath.Join(mv, "snapshots", "snap_2", "meta.json")
	writeFile(t, bad, "{not json")
	if removed := h.pruneImages(); len(removed) != 0 {
		t.Fatalf("a prune with an unread reference of the stopped tier's removed %v", removed)
	}
	if err := os.Remove(bad); err != nil {
		t.Fatal(err)
	}
	removed := h.pruneImages()
	if !slices.Equal(removed, []string{"e"}) {
		t.Fatalf("removed %v, want [e]", removed)
	}
	// The unreadable one stopped the first prune at pinning, before any walk: only the second took the lock.
	if tier.locked || tier.unlocks != 1 {
		t.Fatalf("still locked %v, unlocked %d times", tier.locked, tier.unlocks)
	}
}

// An update or prune on a host whose microVM tier didn't start pins what that tier made before the images were
// versioned first, as a running tier's would be, and doesn't go ahead while one of its references can't be read.
func TestAnUpdateWaitsForAMicroVMTierThatDidNotStartToBePinned(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	store := images.Store{Dir: filepath.Join(h.cfg.Root, "images")}
	first := time.Now().Add(-time.Hour)
	for i, v := range []string{"a", "b", "c"} {
		dir := filepath.Join(store.Dir, "v", v)
		writeFile(t, filepath.Join(dir, "manifest.json"), "{}")
		writeFile(t, filepath.Join(dir, "sandbox.ext4"), "x")
		at := first.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(dir, at, at); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Activate("c"); err != nil {
		t.Fatal(err)
	}
	h.cfg.SandboxImage = filepath.Join(store.Dir, "current", "sandbox.ext4")
	// A stopped sandbox from before the images were versioned: it names the sandbox image itself.
	vm := filepath.Join(h.cfg.Root, "microvm", "sandboxes", "sbx_1", "vm")
	if err := os.MkdirAll(vm, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(h.cfg.SandboxImage, filepath.Join(vm, "rootfs.ext4")); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(h.cfg.Root, "microvm", "snapshots", "snap_2", "meta.json")
	writeFile(t, bad, "{not json")
	h.tiers = map[string]Tier{"isolate": &baseTier{inUse: map[string]bool{}}}
	h.order = []string{"isolate"}
	h.patching.updater = &images.Updater{Store: store, Log: h.log}

	if err := h.checkImages(context.Background(), h.patching.updater, proto.ImageChannel{Version: "d"}); err == nil || !strings.Contains(err.Error(), "snap_2") {
		t.Fatalf("an update went ahead with an unreadable reference of the stopped tier's: %v", err)
	}
	if removed := h.pruneImages(); len(removed) != 0 {
		t.Fatalf("a prune went ahead with an unreadable reference of the stopped tier's: removed %v", removed)
	}
	if err := os.Remove(bad); err != nil {
		t.Fatal(err)
	}
	removed := h.pruneImages()
	if !slices.Equal(removed, []string{"a"}) {
		t.Fatalf("removed %v, want [a]", removed)
	}
	if got, _ := os.Readlink(filepath.Join(vm, "rootfs.ext4")); got != filepath.Join(store.Dir, "v", "c", "sandbox.ext4") {
		t.Fatalf("the stopped tier's legacy sandbox links %q, want the version it was made on", got)
	}
}

// A tier that couldn't read every reference to a version (a snapshot's metadata it couldn't read) stops the prune:
// nothing is removed, the lock is let go, and the next prune, once it can read them, removes only what is unused.
func TestAPruneRemovesNothingWhenAReferenceCannotBeRead(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	store := images.Store{Dir: filepath.Join(h.cfg.Root, "images")}
	first := time.Now().Add(-time.Hour)
	for i, v := range []string{"a", "b", "c", "d", "e"} {
		dir := filepath.Join(store.Dir, "v", v)
		writeFile(t, filepath.Join(dir, "manifest.json"), "{}")
		at := first.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(dir, at, at); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Activate("e"); err != nil {
		t.Fatal(err)
	}
	tier := &baseTier{inUse: map[string]bool{}, walkErr: errors.New("snapshot snap_1: permission denied")}
	h.tiers = map[string]Tier{microvm.Tier: tier}
	h.order = []string{microvm.Tier}
	h.patching.updater = &images.Updater{Store: store, Log: h.log}
	if removed := h.pruneImages(); len(removed) != 0 {
		t.Fatalf("a prune with an unread reference removed %v", removed)
	}
	if tier.locked || tier.unlocks != 1 {
		t.Fatalf("still locked %v, unlocked %d times", tier.locked, tier.unlocks)
	}
	// Read now, and on b: b stays, the rest unused go.
	tier.walkErr, tier.inUse = nil, map[string]bool{"b": true}
	removed := h.pruneImages()
	slices.Sort(removed)
	if !slices.Equal(removed, []string{"a", "c"}) {
		t.Fatalf("removed %v, want [a c]", removed)
	}
}

// A prune keeps the versions the config's kernel and image paths name, through links or by path, and waits for a
// tier that hasn't pinned what it made before the images were versioned; an update does too.
func TestAPruneKeepsConfiguredVersionsAndWaitsForPinning(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	store := images.Store{Dir: filepath.Join(h.cfg.Root, "images")}
	first := time.Now().Add(-time.Hour)
	for i, v := range []string{"a", "b", "c", "d", "e", "f"} {
		dir := filepath.Join(store.Dir, "v", v)
		writeFile(t, filepath.Join(dir, "manifest.json"), "{}")
		for _, name := range []string{"vmlinux", "sandbox.ext4", "isolate.ext4"} {
			writeFile(t, filepath.Join(dir, name), "x")
		}
		at := first.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(dir, at, at); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Activate("f"); err != nil {
		t.Fatal(err)
	}
	// The kernel pinned by path, the sandbox image through a link of the operator's, the isolate image by default.
	h.cfg.Kernel = filepath.Join(store.Dir, "v", "a", "vmlinux")
	h.cfg.SandboxImage = filepath.Join(h.cfg.Root, "my-sandbox.ext4")
	if err := os.Symlink(filepath.Join(store.Dir, "v", "b", "sandbox.ext4"), h.cfg.SandboxImage); err != nil {
		t.Fatal(err)
	}
	h.cfg.IsolateImage = filepath.Join(store.Dir, "current", "isolate.ext4")
	tier := &baseTier{inUse: map[string]bool{}, pinErr: errors.New("disk full")}
	h.tiers = map[string]Tier{microvm.Tier: tier}
	h.order = []string{microvm.Tier}
	h.patching.updater = &images.Updater{Store: store, Log: h.log}
	gone := func(v string) bool {
		_, err := os.Stat(filepath.Join(store.Dir, "v", v))
		return errors.Is(err, os.ErrNotExist)
	}
	if removed := h.pruneImages(); len(removed) != 0 || tier.locked || tier.unlocks != 0 {
		t.Fatalf("a prune went ahead before the tier had pinned its bases: removed %v", removed)
	}
	if err := h.checkImages(context.Background(), h.patching.updater, proto.ImageChannel{Version: "g"}); err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("an update went ahead before the tier had pinned its bases: %v", err)
	}
	tier.pinErr = nil
	removed := h.pruneImages()
	slices.Sort(removed)
	if !slices.Equal(removed, []string{"c", "d"}) {
		t.Fatalf("removed %v, want [c d]", removed)
	}
	for _, v := range []string{"a", "b", "e", "f"} {
		if gone(v) {
			t.Errorf("%s was removed", v)
		}
	}
}

// A start whose rebase the gateway expects on images this host hasn't taken is refused before anything changes; on
// the images it has, it goes ahead. What counts is where the sandbox's tier would land (its config can hold it on
// another version than the store's current one), the same answer host.images's preflight gives.
func TestARebaseOntoImagesTheHostHasNotTakenIsRefused(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	h.cfg.ImagePatching, h.cfg.ImagesDir = true, filepath.Join(h.cfg.Root, "images")
	store := images.Store{Dir: h.cfg.ImagesDir}
	// The store has moved on to 20261104; the tier's config holds it on 20261103.
	for _, v := range []string{"host-images-20261103", "host-images-20261104"} {
		writeFile(t, filepath.Join(store.Dir, "v", v, "manifest.json"), "{}")
	}
	if err := store.Activate("host-images-20261104"); err != nil {
		t.Fatal(err)
	}
	h.tiers[microvm.Tier] = rebasingTier{tier, "host-images-20261103"}
	tier.stopped["sbx_1"] = true
	preflight, err := h.Call(context.Background(), proto.MethodHostImages, json.RawMessage(`{"sandboxId":"sbx_1"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := preflight.(proto.HostImages).Version; got != "host-images-20261103" {
		t.Fatalf("preflight says %s", got)
	}
	err = call(t, h, proto.MethodStart, proto.ResumeParams{SandboxID: "sbx_1", Rebase: true, RebaseTo: "host-images-20261104"})
	if err == nil || !strings.Contains(err.Error(), "this host's images are host-images-20261103, not host-images-20261104; it hasn't taken the update yet") {
		t.Fatalf("a rebase onto images the host hasn't taken: %v", err)
	}
	if info, _ := tier.Get("sbx_1"); info.State != proto.StateStopped {
		t.Fatalf("the refused start left the sandbox %s", info.State)
	}
	if err := call(t, h, proto.MethodStart, proto.ResumeParams{SandboxID: "sbx_1", Rebase: true, RebaseTo: "host-images-20261103"}); err != nil {
		t.Fatal(err)
	}
	if info, _ := tier.Get("sbx_1"); info.State != proto.StateRunning {
		t.Fatalf("the start left the sandbox %s", info.State)
	}
}

func TestHostImagesAnswersTheImagesAsTheyAreNow(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	if err := call(t, h, proto.MethodHostImages, struct{}{}); err == nil || !strings.Contains(err.Error(), "image patching is off") {
		t.Fatalf("host.images with image patching off: %v", err)
	}
	h.cfg.ImagePatching = true
	h.patching.facts.Store(&proto.HostImages{Version: "host-images-20261104"})
	raw, err := h.Call(context.Background(), proto.MethodHostImages, json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := raw.(proto.HostImages); !ok || got.Version != "host-images-20261104" {
		t.Fatalf("host.images answered %#v", raw)
	}

	// For a sandbox: its tier's version, which a root filesystem named by path can hold back from the store's.
	tier := newLifecycleTier()
	tier.stopped["sbx_1"] = true
	h.tiers[microvm.Tier] = tier
	if err := call(t, h, proto.MethodHostImages, proto.HostImagesParams{SandboxID: "sbx_1"}); err == nil || !strings.Contains(err.Error(), "isn't moved onto other images") {
		t.Fatalf("host.images for a sandbox whose tier doesn't rebase: %v", err)
	}
	h.tiers[microvm.Tier] = rebasingTier{tier, "host-images-20261101"}
	raw, err = h.Call(context.Background(), proto.MethodHostImages, json.RawMessage(`{"sandboxId":"sbx_1"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := raw.(proto.HostImages); !ok || got.Version != "host-images-20261101" {
		t.Fatalf("host.images for a sandbox answered %#v", raw)
	}
	if err := call(t, h, proto.MethodHostImages, proto.HostImagesParams{SandboxID: "sbx_none"}); err == nil {
		t.Fatal("host.images for a sandbox the host doesn't have answered")
	}
}

// rebasingTier is a lifecycle tier that rebases onto version.
type rebasingTier struct {
	*lifecycleTier
	version string
}

func (r rebasingTier) RebaseVersion() string { return r.version }

// refusingRebaseTier is a rebasing tier that won't move refused (a sandbox on a template's own base image).
type refusingRebaseTier struct {
	rebasingTier
	refused string
}

func (r refusingRebaseTier) CanRebase(sandboxID string) error {
	if sandboxID == r.refused {
		return &proto.Error{Code: proto.ErrConflict, Message: "sandbox " + sandboxID + " is on its template's own base image"}
	}
	return nil
}

// A sandbox its tier won't move onto the host's images (one on a template's pulled base) is refused by host.images's
// preflight, before a restart on latest stops it, and by the start; the tier's other sandboxes aren't.
func TestARebaseOfASandboxItsTierWontMoveIsRefusedAtThePreflight(t *testing.T) {
	tier := newLifecycleTier()
	h := newLifecycleHost(t, tier)
	h.cfg.ImagePatching = true
	tier.stopped["sbx_1"], tier.stopped["sbx_2"] = true, true
	h.tiers[microvm.Tier] = refusingRebaseTier{rebasingTier{tier, "host-images-20261104"}, "sbx_1"}
	if err := call(t, h, proto.MethodHostImages, proto.HostImagesParams{SandboxID: "sbx_1"}); err == nil || !strings.Contains(err.Error(), "its template's own base image") {
		t.Fatalf("host.images for a sandbox its tier won't move: %v", err)
	}
	if err := call(t, h, proto.MethodStart, proto.ResumeParams{SandboxID: "sbx_1", Rebase: true, RebaseTo: "host-images-20261104"}); err == nil {
		t.Fatal("a rebase of a sandbox its tier won't move started")
	}
	if info, _ := tier.Get("sbx_1"); info.State != proto.StateStopped {
		t.Fatalf("the refused start left the sandbox %s", info.State)
	}
	if err := call(t, h, proto.MethodHostImages, proto.HostImagesParams{SandboxID: "sbx_2"}); err != nil {
		t.Fatal(err)
	}
}

// With image patching the isolate VM tier is given the immutable files its configured paths resolve to at start: an
// activation since doesn't move what its template and runtimes restore over, and a prune keeps that version.
func TestTheIsolateTierStaysOnTheImagesItStartedWith(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	store := images.Store{Dir: filepath.Join(h.cfg.Root, "images")}
	first := time.Now().Add(-time.Hour)
	for i, v := range []string{"a", "b", "c", "d"} {
		dir := filepath.Join(store.Dir, "v", v)
		writeFile(t, filepath.Join(dir, "manifest.json"), "{}")
		writeFile(t, filepath.Join(dir, "vmlinux"), v)
		writeFile(t, filepath.Join(dir, "isolate.ext4"), v)
		at := first.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(dir, at, at); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Activate("a"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"vmlinux", "isolate.ext4"} {
		if err := os.Symlink(filepath.Join("current", name), filepath.Join(store.Dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	h.cfg.ImagePatching = true
	h.cfg.Kernel, h.cfg.IsolateImage = filepath.Join(store.Dir, "vmlinux"), filepath.Join(store.Dir, "isolate.ext4")
	kernel, rootfs := h.isolateImages(h.cfg)
	if images.VersionOf(kernel) != "a" || images.VersionOf(rootfs) != "a" {
		t.Fatalf("isolate images %s, %s; want version a's", kernel, rootfs)
	}
	if err := store.Activate("d"); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(rootfs); string(raw) != "a" {
		t.Fatalf("after an activation the isolate root filesystem reads %q", raw)
	}
	h.tiers = map[string]Tier{microvm.Tier: &baseTier{inUse: map[string]bool{}}}
	h.order = []string{microvm.Tier}
	h.patching.updater = &images.Updater{Store: store, Log: h.log}
	removed := h.pruneImages()
	if slices.Contains(removed, "a") || !slices.Contains(removed, "b") {
		t.Fatalf("removed %v: want b gone and a, which the isolate tier runs on, kept", removed)
	}
}

// A kernel the config names by a version's own path is the operator's pin: the isolate tier keeps it while its root
// filesystem follows current. Only the default kernel link is paired with the root filesystem's version.
func TestTheIsolateTierKeepsAPinnedKernel(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	store := images.Store{Dir: filepath.Join(h.cfg.Root, "images")}
	for _, v := range []string{"a", "b"} {
		dir := filepath.Join(store.Dir, "v", v)
		writeFile(t, filepath.Join(dir, "manifest.json"), "{}")
		writeFile(t, filepath.Join(dir, "vmlinux"), v)
		writeFile(t, filepath.Join(dir, "isolate.ext4"), v)
	}
	if err := store.Activate("b"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"vmlinux", "isolate.ext4"} {
		if err := os.Symlink(filepath.Join("current", name), filepath.Join(store.Dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	h.cfg.ImagePatching = true
	h.cfg.Kernel, h.cfg.IsolateImage = filepath.Join(store.Dir, "v", "a", "vmlinux"), filepath.Join(store.Dir, "isolate.ext4")
	kernel, rootfs := h.isolateImages(h.cfg)
	if images.VersionOf(kernel) != "a" || images.VersionOf(rootfs) != "b" {
		t.Fatalf("isolate images %s, %s; want the pinned kernel a with root filesystem b", kernel, rootfs)
	}
	h.cfg.Kernel = filepath.Join(store.Dir, "vmlinux")
	if kernel, _ := h.isolateImages(h.cfg); images.VersionOf(kernel) != "b" {
		t.Fatalf("default kernel %s; want b's, the root filesystem's", kernel)
	}
}
