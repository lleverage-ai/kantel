package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"golang.org/x/sys/unix"
)

func linkVM(t *testing.T, vm, target string) {
	t.Helper()
	if err := os.MkdirAll(vm, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(vm, fc.RootfsFile)); err != nil {
		t.Fatal(err)
	}
}

// A sandbox's base is the version its rootfs link is under; one linking the unversioned image has none.
func TestBaseOfIsTheVersionItsRootfsLinks(t *testing.T) {
	for target, want := range map[string]string{
		"/var/lib/kantel-host/images/v/host-images-20261103/sandbox.ext4": "host-images-20261103",
		"/var/lib/kantel-host/images/sandbox.ext4":                        "",
		"/srv/v/../sandbox.ext4":                                          "",
	} {
		vm := filepath.Join(t.TempDir(), "vm")
		linkVM(t, vm, target)
		if got := baseOf(vm); got != want {
			t.Errorf("baseOf(-> %s) = %q, want %q", target, got, want)
		}
	}
	if got := baseOf(t.TempDir()); got != "" {
		t.Errorf("baseOf a directory with no rootfs = %q", got)
	}
}

// What the tier's sandboxes, snapshots and templates are on is kept from a prune.
func TestBasesInUse(t *testing.T) {
	root := t.TempDir()
	images := "/var/lib/kantel-host/images/v/"
	linkVM(t, filepath.Join(root, "sandboxes", "sbx_1", "vm"), images+"one/sandbox.ext4")
	linkVM(t, filepath.Join(root, "templates", "default.next.building", "vm"), images+"five/sandbox.ext4")
	if err := os.MkdirAll(filepath.Join(root, "snapshots", "snap_1"), 0o700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: "snap_1", SandboxID: "sbx_gone"}, Rootfs: images + "three/sandbox.ext4"})
	if err := os.WriteFile(filepath.Join(root, "snapshots", "snap_1", "meta.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "templates", "default"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "templates", "default", "rootfs"), []byte(images+"four/sandbox.ext4\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A snapshot whose metadata isn't written yet (its sandbox names its base) is no reference, and no error.
	if err := os.MkdirAll(filepath.Join(root, "snapshots", "snap_2"), 0o700); err != nil {
		t.Fatal(err)
	}
	m := &Manager{cfg: Config{Root: root}}
	got, err := m.BasesInUse()
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"one", "three", "four", "five"} {
		if !got[v] {
			t.Errorf("%s isn't in use: %v", v, got)
		}
	}
	if len(got) != 4 {
		t.Errorf("in use: %v", got)
	}
}

// A snapshot whose metadata can't be read or decoded may be the only reference to a version: BasesInUse says so
// rather than answering without it, and a pinning pass fails rather than being remembered as done. Once it can be
// read, both go ahead and see its base.
// A directory of references that can't be listed or looked into (here a link that loops, which even root can't
// follow) stops a prune's walk and a pinning pass, as an unreadable snapshot does; once it can be, both go ahead and a
// legacy sandbox is pinned. A glob would have passed over it.
func TestAnUnlistableReferenceStopsPruningAndPinning(t *testing.T) {
	for _, where := range []string{"sandboxes", filepath.Join("sandboxes", "sbx_2"), "templates", filepath.Join("templates", "large")} {
		t.Run(where, func(t *testing.T) {
			images := versionedImages(t)
			root := t.TempDir()
			m := &Manager{cfg: Config{Root: root, Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
			legacy := filepath.Join(root, "sandboxes", "sbx_1", "vm")
			linkVM(t, legacy, m.cfg.Rootfs)
			if err := os.MkdirAll(filepath.Join(root, "templates", "default"), 0o700); err != nil {
				t.Fatal(err)
			}
			broken := filepath.Join(root, where)
			moved := broken + ".kept"
			if err := os.Rename(broken, moved); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(broken), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Base(broken), broken); err != nil {
				t.Fatal(err)
			}
			if got, err := m.BasesInUse(); err == nil {
				t.Fatalf("an unlistable %s was passed over: %v", where, got)
			}
			if err := m.PinBases(); err == nil || m.pinned.Load() {
				t.Fatalf("a pinning pass that couldn't list %s succeeded: %v", where, err)
			}
			if err := os.Remove(broken); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(moved, broken); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if err := m.PinBases(); err != nil || !m.pinned.Load() {
				t.Fatalf("pinning once %s can be listed: %v", where, err)
			}
			if got := vmRootfs(legacy); got != filepath.Join(images, "v", "new", "sandbox.ext4") {
				t.Fatalf("the legacy sandbox is on %q, want it pinned to new", got)
			}
			got, err := m.BasesInUse()
			if err != nil || !got["new"] || len(got) != 1 {
				t.Fatalf("in use = %v, %v; want new alone", got, err)
			}
		})
	}
}

func TestAnUnreadableSnapshotStopsPruningAndPinning(t *testing.T) {
	images := versionedImages(t)
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	dir := m.snapshotDir("snap_1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	metaFile := filepath.Join(dir, "meta.json")
	if err := os.WriteFile(metaFile, []byte(`{"id":"snap_1","rootfs":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := m.BasesInUse(); err == nil {
		t.Fatalf("an undecodable snapshot was passed over: %v", got)
	}
	if err := m.PinBases(); err == nil || m.pinned.Load() {
		t.Fatalf("a pinning pass that couldn't read a snapshot succeeded: %v", err)
	}
	raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: "snap_1", Kind: "saved"}, Rootfs: filepath.Join(images, "v", "old", "sandbox.ext4")})
	if err := os.WriteFile(metaFile, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.PinBases(); err != nil || !m.pinned.Load() {
		t.Fatalf("pinning once the snapshot can be read: %v", err)
	}
	got, err := m.BasesInUse()
	if err != nil || !got["old"] || len(got) != 1 {
		t.Fatalf("in use = %v, %v; want old alone", got, err)
	}
}

// A pinning pass rewrites snapshot metadata: it holds the base lock to write, so it waits for what holds it to read
// (pruneAuto's rewrite of the same metadata, a snapshot's save) and they can't overlap.
func TestPinBasesWaitsForSnapshotWriters(t *testing.T) {
	images := versionedImages(t)
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	dir := m.snapshotDir("snap_1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := `{"id":"snap_1","sandboxId":"sbx_1","kind":"auto","createdAt":1793491200000,"memory":true}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	unhold := m.holdBases() // as pruneAuto holds it while it rewrites
	done := make(chan error, 1)
	go func() { done <- m.PinBases() }()
	select {
	case err := <-done:
		t.Fatalf("a pinning pass ran beside a snapshot writer: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	// The writer's rewrite (pruneAuto dropping memory) lands first; the pass then pins what it wrote.
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(strings.Replace(legacy, `"memory":true`, `"memory":false`, 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	unhold()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the pinning pass didn't go ahead once the writer was done")
	}
	snap, err := m.readSnapshot("snap_1")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Base != "new" || snap.Memory {
		t.Fatalf("after the pass: base %q, memory %v; want new, false", snap.Base, snap.Memory)
	}
}

// A rebase start is a cold boot on the target images: a machine still running on others (one its gateway recorded as
// errored) is refused, not answered as booted. An ordinary start stays a no-op for a running machine, and so does a
// rebase start whose machine is already on the target (that boot, retried).
func TestARebaseStartRefusesAMachineRunningOnOtherImages(t *testing.T) {
	images := versionedImages(t)
	root := t.TempDir()
	dir := filepath.Join(root, "sandboxes", "sbx_1")
	linkVM(t, filepath.Join(dir, "vm"), filepath.Join(images, "v", "old", "sandbox.ext4"))
	s := &sandbox{dir: dir, meta: meta{ID: "sbx_1", State: proto.StateRunning}}
	m := &Manager{cfg: Config{Root: root, Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true}, log: slog.New(slog.NewTextHandler(io.Discard, nil)), sandboxes: map[string]*sandbox{"sbx_1": s}}
	ctx := context.Background()
	var perr *proto.Error
	if _, err := m.Resume(ctx, proto.ResumeParams{SandboxID: "sbx_1", Rebase: true, RebaseTo: "new"}, true); !errors.As(err, &perr) || perr.Code != proto.ErrConflict {
		t.Fatalf("a rebase start of a machine running on old: %v", err)
	}
	if _, err := m.Resume(ctx, proto.ResumeParams{SandboxID: "sbx_1", Rebase: true}, true); !errors.As(err, &perr) || perr.Code != proto.ErrConflict {
		t.Fatalf("a rebase start with no named target, of a machine running on old: %v", err)
	}
	if info, err := m.Resume(ctx, proto.ResumeParams{SandboxID: "sbx_1"}, true); err != nil || info.Base != "old" {
		t.Fatalf("an ordinary start of a running machine: %+v, %v", info, err)
	}
	if err := relinkRootfs(s.vmDir(), filepath.Join(images, "v", "new", "sandbox.ext4")); err != nil {
		t.Fatal(err)
	}
	if info, err := m.Resume(ctx, proto.ResumeParams{SandboxID: "sbx_1", Rebase: true, RebaseTo: "new"}, true); err != nil || info.Base != "new" {
		t.Fatalf("a retried rebase start of a machine already on new: %+v, %v", info, err)
	}
}

// Each image version keeps its own guest report: a template rebuilt on a newer version doesn't change what a sandbox
// still on the older one is told it has, a rebase does, and the reports outlive a restart and the older template.
// A template from before reports were kept by version: once a start pins it, its report is kept as its version's, so
// the sandboxes on that version keep it after the template is rebuilt on another and the host restarts.
func TestALegacyTemplatesReportIsKeptAsItsVersions(t *testing.T) {
	images := versionedImages(t)
	root := t.TempDir()
	tpl := filepath.Join(root, "templates", "default")
	if err := os.MkdirAll(tpl, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"ready": "{}", guestFile: `{"arch":"x86_64","reportedAt":1}`} {
		if err := os.WriteFile(filepath.Join(tpl, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cfg := Config{Root: root, Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true, Sizes: DefaultSizes, SpoolMaxMiB: -1, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	m.Close()
	if got := m.guestOf("new"); got == nil || got.ReportedAt != 1 {
		t.Fatalf("the pinned template's version has %+v", got)
	}
	// Rebuilt on another version (its report replaced), then a restart.
	if err := os.WriteFile(filepath.Join(tpl, "rootfs"), []byte(filepath.Join(images, "v", "old", "sandbox.ext4")), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tpl, guestFile), []byte(`{"arch":"x86_64","reportedAt":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	again, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if got := again.guestOf("new"); got == nil || got.ReportedAt != 1 {
		t.Fatalf("after its template was rebuilt and a restart, the version has %+v", got)
	}
}

func TestGuestReportsFollowEachSandboxsBase(t *testing.T) {
	images := versionedImages(t)
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	template := func(dir, version string) string {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "rootfs"), []byte(filepath.Join(images, "v", version, "sandbox.ext4")), 0o600); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	m.noteGuest(template(filepath.Join(root, "templates", "default"), "old"), &proto.GuestCapabilities{ReportedAt: 1})
	dir := filepath.Join(root, "sandboxes", "sbx_1")
	linkVM(t, filepath.Join(dir, "vm"), filepath.Join(images, "v", "old", "sandbox.ext4"))
	s := &sandbox{dir: dir, meta: meta{ID: "sbx_1", State: proto.StateStopped}}
	// The background rebuild on new.
	m.noteGuest(template(filepath.Join(root, "templates", "default.next"), "new"), &proto.GuestCapabilities{ReportedAt: 2})
	if got := m.info(s).Guest; got == nil || got.ReportedAt != 1 {
		t.Fatalf("a sandbox on old is told %+v", got)
	}
	// A restart, with old's template gone: the kept report is read back.
	if err := os.RemoveAll(filepath.Join(root, "templates", "default")); err != nil {
		t.Fatal(err)
	}
	restarted := &Manager{cfg: m.cfg, log: m.log}
	restarted.loadGuests()
	if got := restarted.info(s).Guest; got == nil || got.ReportedAt != 1 {
		t.Fatalf("after a restart, a sandbox on old is told %+v", got)
	}
	if err := restarted.rebase(s, ""); err != nil {
		t.Fatal(err)
	}
	if got := restarted.info(s).Guest; got == nil || got.ReportedAt != 2 {
		t.Fatalf("after a rebase onto new, the sandbox is told %+v", got)
	}
	// A prune that removed old forgets its report.
	restarted.ForgetGuests([]string{"old"})
	if _, err := os.Stat(filepath.Join(root, guestsDir, "old.json")); !os.IsNotExist(err) || restarted.guestOf("old") != nil {
		t.Errorf("old's report outlived its prune: %v", err)
	}
}

// With background templates, a template made on other images is still used while one rebuild (and only one) makes
// its replacement: creates neither wait nor fail.
func TestAStaleTemplateIsUsedWhileOneRebuildRuns(t *testing.T) {
	root := t.TempDir()
	size := proto.Size{Name: "default", VCPUs: 1, MemoryMiB: 512, DiskGiB: 1}
	dir := filepath.Join(root, "templates", "default")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"ready": "{}", "images": "made on older images;" + templateShape(size)} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	started := make(chan shape, 4)
	release := make(chan struct{})
	m := &Manager{
		cfg:       Config{Root: root, BackgroundTemplates: true, Sizes: []proto.Size{size}},
		log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		templates: map[string]*sync.Mutex{"default": &sync.Mutex{}},
		rebuild: func(_ context.Context, s shape) error {
			started <- s
			<-release
			return errors.New("no VMs in a unit test")
		},
	}
	for range 3 {
		got, built, err := m.template(context.Background(), shape{Size: size})
		if err != nil || got != dir || built != nil {
			t.Fatalf("template = %s, %v, %v; want the old one, at once", got, built, err)
		}
	}
	m.ImagesChanged()
	close(release)
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("no rebuild started")
	}
	// The failed rebuild holds off the next for a minute, so creates don't start one each.
	if _, _, err := m.template(context.Background(), shape{Size: size}); err != nil {
		t.Fatal(err)
	}
	select {
	case s := <-started:
		t.Fatalf("a second rebuild of %s started", s.Name)
	case <-time.After(100 * time.Millisecond):
	}
	if _, err := os.Stat(filepath.Join(dir, "ready")); err != nil {
		t.Fatalf("the old template went: %v", err)
	}
}

// A shared template made on other images still counts as ready with background templates (creates restore it, not
// cold-boot), and an image change rebuilds it as it does a size's.
func TestAStaleSharedTemplateServesWhileItRebuilds(t *testing.T) {
	root := t.TempDir()
	cfg := Config{Root: root, BackgroundTemplates: true, SharedTemplate: true, Sizes: DefaultSizes}
	m := &Manager{cfg: cfg, log: slog.New(slog.NewTextHandler(io.Discard, nil)), templates: map[string]*sync.Mutex{}}
	m.shared = sharedShape(cfg, 16384, 8)
	sh := m.shared.shape(2)
	dir := filepath.Join(root, "templates", sh.Name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"ready": "{}", "images": "made on older images;" + m.shapeKey(sh)} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if !m.templateReady(sh) {
		t.Fatal("a stale shared template of the same shape isn't ready with background templates")
	}
	if other := m.shared.shape(3); m.templateReady(other) {
		t.Fatal("another count's template is ready")
	}
	started := make(chan shape, 4)
	m.rebuild = func(_ context.Context, s shape) error {
		started <- s
		return errors.New("no VMs in a unit test")
	}
	m.ImagesChanged()
	select {
	case s := <-started:
		if s.Name != sh.Name || s.HotplugMiB != sh.HotplugMiB {
			t.Fatalf("rebuilt %+v, want %+v", s, sh)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no rebuild started")
	}
	m.cfg.BackgroundTemplates = false
	if m.templateReady(sh) {
		t.Fatal("a stale template is ready without background templates")
	}
}

// A start with Rebase moves a stopped sandbox onto the current images, and forgets the memory taken over the old.
func TestRebaseMovesAStoppedSandboxOntoTheCurrentImages(t *testing.T) {
	root := t.TempDir()
	images := filepath.Join(root, "images")
	for _, v := range []string{"old", "new"} {
		if err := os.MkdirAll(filepath.Join(images, "v", v), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(images, "v", v, "sandbox.ext4"), []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join("v", "new"), filepath.Join(images, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("current", "sandbox.ext4"), filepath.Join(images, "sandbox.ext4")); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "sandboxes", "sbx_1")
	linkVM(t, filepath.Join(dir, "vm"), filepath.Join(images, "v", "old", "sandbox.ext4"))
	s := &sandbox{dir: dir, meta: meta{ID: "sbx_1", State: proto.StateStopped, Memory: true}}
	m := &Manager{cfg: Config{Root: root, Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if got := baseOf(s.vmDir()); got != "old" {
		t.Fatalf("base before = %q", got)
	}
	// Put on old an hour ago: a rebase's report is ordered after it.
	long := time.Now().Add(-time.Hour)
	if err := unix.Lutimes(filepath.Join(s.vmDir(), fc.RootfsFile), []unix.Timeval{unix.NsecToTimeval(long.UnixNano()), unix.NsecToTimeval(long.UnixNano())}); err != nil {
		t.Fatal(err)
	}
	before := m.info(s).BaseAt
	if before != long.UnixMilli() {
		t.Fatalf("baseAt before = %d, want %d", before, long.UnixMilli())
	}
	// A rebase the caller expects on another version is refused, and changes nothing.
	if err := m.rebase(s, "newer"); err == nil || !strings.Contains(err.Error(), "hasn't taken the update") {
		t.Fatalf("a rebase onto a version the host hasn't taken: %v", err)
	}
	if got := baseOf(s.vmDir()); got != "old" || !s.meta.Memory {
		t.Fatalf("a refused rebase moved the sandbox to %q (memory %v)", got, s.meta.Memory)
	}
	if err := m.rebase(s, "new"); err != nil {
		t.Fatal(err)
	}
	if got := baseOf(s.vmDir()); got != "new" {
		t.Fatalf("base after = %q, want new", got)
	}
	if s.meta.Memory {
		t.Fatal("the old memory is still resumable")
	}
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved meta
	if err := json.Unmarshal(raw, &saved); err != nil || saved.Memory {
		t.Fatalf("saved %s (%v)", raw, err)
	}
	if info := m.info(s); info.Base != "new" || info.BaseAt <= before {
		t.Fatalf("info's base = %q at %d, want new after %d", info.Base, info.BaseAt, before)
	}
}

// versionedImages is an images directory as package images leaves it: versions old and new, each with its kernel and
// root filesystem, current on new, and the default paths linked to current.
func versionedImages(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	images := filepath.Join(root, "images")
	for _, v := range []string{"old", "new"} {
		if err := os.MkdirAll(filepath.Join(images, "v", v), 0o755); err != nil {
			t.Fatal(err)
		}
		for _, f := range []string{"vmlinux", "sandbox.ext4"} {
			if err := os.WriteFile(filepath.Join(images, "v", v, f), []byte(v+" "+f), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.Symlink(filepath.Join("v", "new"), filepath.Join(images, "current")); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"vmlinux", "sandbox.ext4"} {
		if err := os.Symlink(filepath.Join("current", f), filepath.Join(images, f)); err != nil {
			t.Fatal(err)
		}
	}
	return images
}

// A sandbox or template boots the kernel of its own root filesystem's version, not the current one; a custom kernel,
// or image patching off, boots the configured kernel as before.
func TestTheKernelIsPinnedWithTheRootFilesystem(t *testing.T) {
	images := versionedImages(t)
	m := &Manager{cfg: Config{Kernel: filepath.Join(images, "vmlinux"), Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true}}
	old := filepath.Join(images, "v", "old", "sandbox.ext4")
	if got, want := m.kernelFor(old), filepath.Join(images, "v", "old", "vmlinux"); got != want {
		t.Fatalf("kernel over old = %s, want %s", got, want)
	}
	// A template build picks its root filesystem and the kernel with it.
	if got, want := m.kernelFor(m.baseRootfs()), filepath.Join(images, "v", "new", "vmlinux"); got != want {
		t.Fatalf("kernel over the current root filesystem = %s, want %s", got, want)
	}
	// An unversioned root filesystem boots the configured kernel.
	if got := m.kernelFor(m.cfg.Rootfs); got != m.cfg.Kernel {
		t.Fatalf("kernel over the unpinned root filesystem = %s", got)
	}
	custom := filepath.Join(t.TempDir(), "vmlinux")
	if err := os.WriteFile(custom, []byte("custom"), 0o644); err != nil {
		t.Fatal(err)
	}
	m.cfg.Kernel = custom
	if got := m.kernelFor(old); got != custom {
		t.Fatalf("a custom kernel was replaced by %s", got)
	}
	m.cfg.Kernel, m.cfg.PinBase = filepath.Join(images, "vmlinux"), false
	if got := m.kernelFor(old); got != m.cfg.Kernel {
		t.Fatalf("with image patching off, the kernel is %s", got)
	}
}

// A prune's LockBases holds off a reference being moved (here a rebase's relink) until it has removed what it found
// unused; the move then goes ahead.
func TestLockBasesHoldsOffNewReferences(t *testing.T) {
	images := versionedImages(t)
	root := t.TempDir()
	dir := filepath.Join(root, "sandboxes", "sbx_1")
	linkVM(t, filepath.Join(dir, "vm"), filepath.Join(images, "v", "old", "sandbox.ext4"))
	s := &sandbox{dir: dir, meta: meta{ID: "sbx_1", State: proto.StateStopped}}
	m := &Manager{cfg: Config{Root: root, Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	unlock := m.LockBases()
	done := make(chan error, 1)
	go func() { done <- m.rebase(s, "") }()
	select {
	case err := <-done:
		t.Fatalf("a rebase relinked while a prune held the bases: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if got := baseOf(s.vmDir()); got != "old" {
		t.Fatalf("base while held = %q", got)
	}
	unlock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the rebase didn't go ahead once the prune was done")
	}
	if got := baseOf(s.vmDir()); got != "new" {
		t.Fatalf("base after = %q, want new", got)
	}
}

// Dropping an older automatic snapshot's memory rewrites its metadata, which names its base: it waits for a prune
// holding the bases, so the prune's walk never reads it half written.
func TestPruneAutoWaitsForAPruneOfTheBases(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, AutoSnapshots: 3}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	unlock := m.LockBases()
	done := make(chan struct{})
	go func() {
		m.pruneAuto("sbx_1")
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("pruneAuto ran while a prune held the bases")
	case <-time.After(100 * time.Millisecond):
	}
	unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("pruneAuto didn't go ahead once the prune was done")
	}
}

// A rebase lands on the version Rootfs resolves to now; one named by a path that isn't a version's file has none.
func TestRebaseVersionIsWhatRootfsResolvesTo(t *testing.T) {
	images := versionedImages(t)
	m := &Manager{cfg: Config{Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true}}
	if got := m.RebaseVersion(); got != "new" {
		t.Fatalf("RebaseVersion = %q, want new", got)
	}
	m.cfg.Rootfs = filepath.Join(images, "v", "old", "sandbox.ext4")
	if got := m.RebaseVersion(); got != "old" {
		t.Fatalf("RebaseVersion with an older version's file = %q, want old", got)
	}
	m.cfg.PinBase = false
	if got := m.RebaseVersion(); got != "" {
		t.Fatalf("RebaseVersion with image patching off = %q", got)
	}
}

// Pinning a snapshot made before the images were versioned replaces its metadata durably: a pass that can't write
// leaves the old metadata readable and says so, and a retry pins it with every other field kept.
func TestPinBasesKeepsSnapshotMetadataThroughAFailedPass(t *testing.T) {
	images := versionedImages(t)
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, Rootfs: filepath.Join(images, "sandbox.ext4"), PinBase: true}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	dir := m.snapshotDir("snap_1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := `{"id":"snap_1","sandboxId":"sbx_1","kind":"saved","name":"before","createdAt":1793491200000,"size":"small"}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	if err := m.PinBases(); err == nil {
		t.Fatal("a pass that couldn't write the snapshot's metadata succeeded")
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "meta.json")); string(raw) != legacy {
		t.Fatalf("the failed pass changed the metadata: %s", raw)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := m.PinBases(); err != nil {
		t.Fatal(err)
	}
	snap, err := m.readSnapshot("snap_1")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Base != "new" || snap.Rootfs != filepath.Join(images, "v", "new", "sandbox.ext4") || snap.Name != "before" || snap.SandboxID != "sbx_1" || snap.Size != "small" || snap.Kind != "saved" || snap.CreatedAt != 1793491200000 {
		t.Fatalf("pinned snapshot = %+v", snap)
	}
}

// Close ends the background template builds (their VMs are disposable) and waits for them; none starts after.
func TestCloseEndsBackgroundBuilds(t *testing.T) {
	m := &Manager{log: slog.New(slog.NewTextHandler(io.Discard, nil)), templates: map[string]*sync.Mutex{}, rebuilding: map[string]bool{}}
	m.bg, m.bgStop = context.WithCancel(context.Background())
	started, ended := make(chan struct{}), make(chan error, 1)
	m.rebuild = func(ctx context.Context, _ shape) error {
		close(started)
		<-ctx.Done()
		time.Sleep(50 * time.Millisecond) // the VM being killed
		ended <- ctx.Err()
		return ctx.Err()
	}
	m.rebuildTemplate(shape{Size: proto.Size{Name: "default"}})
	<-started
	m.Close()
	select {
	case err := <-ended:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("the build ended with %v, want its context cancelled", err)
		}
	default:
		t.Fatal("Close returned before the build ended")
	}
	m.rebuild = func(context.Context, shape) error {
		t.Error("a build started after Close")
		return nil
	}
	m.rebuildTemplate(shape{Size: proto.Size{Name: "large"}})
	time.Sleep(50 * time.Millisecond)
}
