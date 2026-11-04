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

// What the tier's sandboxes, warm sandboxes, snapshots and templates are on is kept from a prune.
func TestBasesInUse(t *testing.T) {
	root := t.TempDir()
	images := "/var/lib/kantel-host/images/v/"
	linkVM(t, filepath.Join(root, "sandboxes", "sbx_1", "vm"), images+"one/sandbox.ext4")
	linkVM(t, filepath.Join(root, "pool", "default-1", "vm"), images+"two/sandbox.ext4")
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
	m := &Manager{cfg: Config{Root: root}}
	got := m.BasesInUse()
	for _, v := range []string{"one", "two", "three", "four", "five"} {
		if !got[v] {
			t.Errorf("%s isn't in use: %v", v, got)
		}
	}
	if len(got) != 5 {
		t.Errorf("in use: %v", got)
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
	started := make(chan proto.Size, 4)
	release := make(chan struct{})
	m := &Manager{
		cfg:       Config{Root: root, BackgroundTemplates: true, Sizes: []proto.Size{size}},
		log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		templates: map[string]*sync.Mutex{"default": &sync.Mutex{}},
		pool:      map[string][]*warm{}, poolWant: map[string]int{}, filling: map[string]bool{},
		rebuild: func(_ context.Context, s proto.Size) error {
			started <- s
			<-release
			return errors.New("no VMs in a unit test")
		},
	}
	for range 3 {
		got, built, err := m.template(context.Background(), size)
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
	if _, _, err := m.template(context.Background(), size); err != nil {
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
	if info := m.info(s); info.Base != "new" {
		t.Fatalf("info's base = %q", info.Base)
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
