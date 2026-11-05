package microvm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/bundles"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func TestValidateMounts(t *testing.T) {
	cache, err := bundles.New(bundles.Config{Dir: t.TempDir(), Mkfs: "/bin/true"})
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{cfg: Config{Bundles: cache, BundleDrives: 8}}
	d := "sha256:" + strings.Repeat("a", 64)
	ok := []proto.Mount{
		{Path: "/workspace/skills", Kind: proto.MountBundle, Digest: d},
		{Path: "/workspace/skills2", Kind: proto.MountBundle, Digest: d},
	}
	if err := m.validateMounts(ok); err != nil {
		t.Fatal(err)
	}
	code := func(mounts ...proto.Mount) string {
		var pe *proto.Error
		if err := m.validateMounts(mounts); errors.As(err, &pe) {
			return pe.Code
		} else if err != nil {
			return err.Error()
		}
		return ""
	}
	for name, c := range map[string]struct {
		mounts []proto.Mount
		want   string
	}{
		"bucket":      {[]proto.Mount{{Path: "/data", Kind: proto.MountBucket, BucketSourceID: "bs"}}, proto.ErrUnsupported},
		"system path": {[]proto.Mount{{Path: "/etc/x", Kind: proto.MountBundle, Digest: d}}, proto.ErrInvalid},
		"no digest":   {[]proto.Mount{{Path: "/x", Kind: proto.MountBundle, Digest: "sha256:abc"}}, proto.ErrInvalid},
		"overlap":     {[]proto.Mount{{Path: "/x", Kind: proto.MountBundle, Digest: d}, {Path: "/x/y", Kind: proto.MountBundle, Digest: d}}, proto.ErrInvalid},
		"same path":   {[]proto.Mount{{Path: "/x", Kind: proto.MountBundle, Digest: d}, {Path: "/x", Kind: proto.MountBundle, Digest: d}}, proto.ErrInvalid},
		"not cleaned": {[]proto.Mount{{Path: "/x/../y", Kind: proto.MountBundle, Digest: d}}, proto.ErrInvalid},
	} {
		if got := code(c.mounts...); got != c.want {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
	off := &Manager{cfg: Config{BundleDrives: 8}}
	if err := off.validateMounts(ok); err == nil {
		t.Fatal("a host without a bundle cache refuses bundle mounts")
	}
}

func TestBundleDriveFiles(t *testing.T) {
	vm, snap, next := t.TempDir(), t.TempDir(), t.TempDir()
	if err := emptyDrives(vm, 3); err != nil {
		t.Fatal(err)
	}
	if drives := bundleDrives(3); len(drives) != 3 || drives[2].ID != "bundle2" || drives[2].Path != "bundle2.erofs" {
		t.Fatalf("%+v", drives)
	}
	// Drive 1 holds an image (here, a file standing in for the cache's).
	image := filepath.Join(t.TempDir(), "image.erofs")
	if err := os.WriteFile(image, []byte("erofs image"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(filepath.Join(vm, "bundle1.erofs"))
	if err := os.Link(image, filepath.Join(vm, "bundle1.erofs")); err != nil {
		t.Fatal(err)
	}
	slots := []string{"", "sha256:x", ""}
	if err := keepDrives(vm, snap, slots); err != nil {
		t.Fatal(err)
	}
	made, err := snapshotDrives(next, snap, 3, slots)
	if err != nil || strings.Join(made, ",") != ",sha256:x," {
		t.Fatal(made, err)
	}
	a, _ := os.Stat(image)
	b, _ := os.Stat(filepath.Join(next, "bundle1.erofs"))
	if !os.SameFile(a, b) {
		t.Fatal("a VM restored from the snapshot has the same image on the same drive")
	}
	for _, i := range []int{0, 2} {
		if st, err := os.Stat(filepath.Join(next, bundleDriveFile(i))); err != nil || st.Size() != 0 {
			t.Fatalf("drive %d is an empty file: %v %v", i, st, err)
		}
	}
	if got := imageBytes(next, 1); got != int64(len("erofs image")) {
		t.Fatalf("imageBytes %d", got)
	}
	dropDrives(snap)
	if left, _ := filepath.Glob(filepath.Join(snap, "bundle*")); len(left) != 0 {
		t.Fatalf("the snapshot lets go of its images: %v", left)
	}
	// A snapshot that has lost an image: that drive is empty, and its slot says so.
	lost := t.TempDir()
	made, err = snapshotDrives(lost, snap, 3, slots)
	if err != nil || strings.Join(made, ",") != ",," || imageBytes(lost, 1) != 0 {
		t.Fatal(made, err)
	}
}

// TestCreateLetsGoOfTheBaseLockWhenDrivesFail: a create from a snapshot (with its memory, or its disk only) whose
// bundle drives can't be set up fails, keeps the shared image's bytes, and leaves the base lock free for a prune.
func TestCreateLetsGoOfTheBaseLockWhenDrivesFail(t *testing.T) {
	for _, memory := range []bool{true, false} {
		root := t.TempDir()
		// A real root filesystem to link, so the create gets past it to the drives.
		rootfs := filepath.Join(root, "sandbox.ext4")
		if err := os.WriteFile(rootfs, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		m := &Manager{cfg: Config{Root: root, Rootfs: rootfs, Sizes: DefaultSizes, BundleDrives: 2}, sandboxes: map[string]*sandbox{}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
		sdir := m.snapshotDir("snap-1")
		if err := os.MkdirAll(sdir, 0o700); err != nil {
			t.Fatal(err)
		}
		image := filepath.Join(sdir, "bundle0.erofs")
		if err := os.WriteFile(image, []byte("erofs image"), 0o600); err != nil {
			t.Fatal(err)
		}
		meta := fmt.Sprintf(`{"id":"snap-1","sandboxId":"sbx_0","memory":%v,"size":"default","bundleDrives":2,"bundleSlots":["sha256:x",""]}`, memory)
		if err := os.WriteFile(filepath.Join(sdir, "meta.json"), []byte(meta), 0o600); err != nil {
			t.Fatal(err)
		}
		// What an interrupted create left: its VM directory, with a drive that is a link to the image.
		vm := filepath.Join(root, "sandboxes", "sbx_1", "vm")
		if err := os.MkdirAll(vm, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Link(image, filepath.Join(vm, "bundle0.erofs")); err != nil {
			t.Fatal(err)
		}
		// It fails at the drive the leftover is in the way of, not before.
		_, err := m.Create(context.Background(), proto.CreateParams{SandboxID: "sbx_1", Tier: Tier, Size: "default", From: "snap-1"})
		if !errors.Is(err, fs.ErrExist) || !strings.Contains(err.Error(), "a bundle drive") {
			t.Fatalf("memory %v: the create fails setting up its bundle drives: %v", memory, err)
		}
		if raw, err := os.ReadFile(image); err != nil || string(raw) != "erofs image" {
			t.Fatalf("memory %v: the image keeps its bytes: %q %v", memory, raw, err)
		}
		locked := make(chan struct{})
		go func() {
			m.LockBases()()
			close(locked)
		}()
		select {
		case <-locked:
		case <-time.After(2 * time.Second):
			t.Fatalf("memory %v: the base lock is still held", memory)
		}
		// Its leftovers are gone, so a retry starts clean.
		if _, err := os.Stat(vm); !os.IsNotExist(err) {
			t.Fatalf("memory %v: %v", memory, err)
		}
	}
}

// TestABundleIsReservedFromItsFirstWait: a create's prefetch reserves the image of each bundle it mounts, so one a
// slow build makes while images in use fill the cache survives the build's own trim (one build); the pending mount's
// background finish keeps it, and once that gives it up (the sandbox stopped) the image is reclaimed.
func TestABundleIsReservedFromItsFirstWait(t *testing.T) {
	dir := t.TempDir()
	count := filepath.Join(dir, "builds")
	mkfs := filepath.Join(dir, "mkfs.erofs")
	script := fmt.Sprintf(`#!/bin/sh
case "$1" in --help) echo "--tar"; exit 0;; -V) echo "mkfs.erofs (fake)"; exit 0;; esac
# --force-uid=N --force-gid=N --tar=f OUT TAR
echo x >> %q
sleep 0.3
head -c $(wc -c < "$5") /dev/zero > "$4"
`, count)
	if err := os.WriteFile(mkfs, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	cache, err := bundles.New(bundles.Config{Dir: filepath.Join(dir, "cache"), MaxBytes: 12 << 10, Mkfs: mkfs})
	if err != nil {
		t.Fatal(err)
	}
	tars := map[string][]byte{}
	bundle := func(size int) string {
		raw := []byte(strings.Repeat("b", size))
		sum := sha256.Sum256(raw)
		d := "sha256:" + hex.EncodeToString(sum[:])
		tars[d] = raw
		return d
	}
	pinned, fresh := bundle(11<<10), bundle(9<<10)
	m := &Manager{cfg: Config{Bundles: cache, BundleDrives: 2, FetchBundle: func(_ context.Context, _, digest string) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader(string(tars[digest]))), nil
	}}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	builds := func() int {
		raw, _ := os.ReadFile(count)
		return strings.Count(string(raw), "x")
	}
	// An image in use (linked by another sandbox's drive) fills the cache.
	if _, _, err := cache.Link(context.Background(), pinned, filepath.Join(dir, "other-drive"), m.fetchFor("sbx_other")); err != nil {
		t.Fatal(err)
	}

	s := &sandbox{meta: meta{ID: "sbx_1", State: proto.StateStarting, Mounts: []proto.Mount{{Path: "/workspace/skills", Kind: proto.MountBundle, Digest: fresh}}}}
	s.mu.Lock()
	m.prefetchBundles(s)
	s.mu.Unlock()
	if !cache.Reserved(fresh) {
		t.Fatal("reserved from the prefetch")
	}
	if _, err := cache.Get(context.Background(), fresh, m.fetchFor(s.meta.ID)); err != nil {
		t.Fatal(err)
	}
	cache.Evict()
	if !cache.Has(fresh) || builds() != 2 {
		t.Fatalf("the image built for it is kept, built once: has=%v builds=%d", cache.Has(fresh), builds())
	}

	// The create answered with the mount pending; the sandbox stops before the background finish attaches it.
	s.mu.Lock()
	s.meta.State = proto.StateStopped
	s.meta.MountStatus = []proto.MountStatus{{Path: "/workspace/skills", Kind: proto.MountBundle, State: proto.MountPending}}
	m.finishBundles(s)
	s.mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		left := len(s.reserved)
		s.mu.Unlock()
		if left == 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if cache.Reserved(fresh) || cache.Has(fresh) || !cache.Has(pinned) || builds() != 2 {
		t.Fatalf("given up: released and reclaimed, the image in use kept: reserved=%v has=%v pinned=%v builds=%d",
			cache.Reserved(fresh), cache.Has(fresh), cache.Has(pinned), builds())
	}
}

// TestAnAdoptedSandboxsPendingBundleIsReservedBeforeItsWait: after a host restart, adopt() finds a running sandbox
// whose bundle mount is still pending and has finishBundles build it, with no reservation from a create. The finish
// reserves the image before it waits, so a full cache of images in use doesn't evict it as it is built (one build).
func TestAnAdoptedSandboxsPendingBundleIsReservedBeforeItsWait(t *testing.T) {
	dir := t.TempDir()
	count := filepath.Join(dir, "builds")
	mkfs := filepath.Join(dir, "mkfs.erofs")
	script := fmt.Sprintf(`#!/bin/sh
case "$1" in --help) echo "--tar"; exit 0;; -V) echo "mkfs.erofs (fake)"; exit 0;; esac
echo x >> %q
sleep 0.3
head -c $(wc -c < "$5") /dev/zero > "$4"
`, count)
	if err := os.WriteFile(mkfs, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	cache, err := bundles.New(bundles.Config{Dir: filepath.Join(dir, "cache"), MaxBytes: 12 << 10, Mkfs: mkfs})
	if err != nil {
		t.Fatal(err)
	}
	tars := map[string][]byte{}
	bundle := func(size int) string {
		raw := []byte(strings.Repeat("a", size))
		sum := sha256.Sum256(raw)
		d := "sha256:" + hex.EncodeToString(sum[:])
		tars[d] = raw
		return d
	}
	pinned, fresh := bundle(11<<10), bundle(9<<10)
	m := &Manager{cfg: Config{Bundles: cache, BundleDrives: 2, FetchBundle: func(_ context.Context, _, digest string) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader(string(tars[digest]))), nil
	}}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	builds := func() int {
		raw, _ := os.ReadFile(count)
		return strings.Count(string(raw), "x")
	}
	if _, _, err := cache.Link(context.Background(), pinned, filepath.Join(dir, "other-drive"), m.fetchFor("sbx_other")); err != nil {
		t.Fatal(err)
	}

	// As adopt() leaves it: running, its mount pending, nothing reserved.
	s := &sandbox{meta: meta{ID: "sbx_adopted", State: proto.StateRunning,
		Mounts:      []proto.Mount{{Path: "/workspace/skills", Kind: proto.MountBundle, Digest: fresh}},
		MountStatus: []proto.MountStatus{{Path: "/workspace/skills", Kind: proto.MountBundle, State: proto.MountPending}}}}
	m.finishBundles(s)
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatal(what)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	waitFor("reserved before its wait", func() bool { return cache.Reserved(fresh) })
	// Held here, the finish can't attach (or give up) once the build is done: the image must survive the build's trim.
	s.mu.Lock()
	waitFor("built", func() bool { return builds() == 2 && cache.Has(fresh) })
	cache.Evict()
	if !cache.Has(fresh) || !cache.Has(pinned) || builds() != 2 {
		t.Fatalf("kept, built once: has=%v pinned=%v builds=%d", cache.Has(fresh), cache.Has(pinned), builds())
	}
	s.mu.Unlock()
	// It has no machine (this test has none), so the finish gives it up, and it can be reclaimed.
	waitFor("released", func() bool { return !cache.Reserved(fresh) })
	cache.Evict()
	if cache.Has(fresh) || !cache.Has(pinned) || builds() != 2 {
		t.Fatalf("given up: reclaimed, no rebuild: has=%v pinned=%v builds=%d", cache.Has(fresh), cache.Has(pinned), builds())
	}
}

// TestDriveSetupNeverTruncatesAnImage: a VM directory left with a drive that is a link to a shared image (a create
// interrupted by a host restart, retried): setting up its drives fails, and the image keeps its bytes.
func TestDriveSetupNeverTruncatesAnImage(t *testing.T) {
	image := filepath.Join(t.TempDir(), "image.erofs")
	if err := os.WriteFile(image, []byte("erofs image"), 0o600); err != nil {
		t.Fatal(err)
	}
	snap := t.TempDir()
	if err := os.Link(image, filepath.Join(snap, "bundle0.erofs")); err != nil {
		t.Fatal(err)
	}
	for name, setup := range map[string]func(vm string) error{
		"emptyDrives": func(vm string) error { return emptyDrives(vm, 2) },
		"snapshotDrives, a slot with an image": func(vm string) error {
			_, err := snapshotDrives(vm, snap, 2, []string{"sha256:x", ""})
			return err
		},
		"snapshotDrives, an empty slot": func(vm string) error {
			_, err := snapshotDrives(vm, snap, 2, []string{"", ""})
			return err
		},
	} {
		vm := t.TempDir()
		if err := os.Link(image, filepath.Join(vm, "bundle0.erofs")); err != nil {
			t.Fatal(err)
		}
		if err := setup(vm); err == nil {
			t.Errorf("%s: a drive file already there is an error", name)
		}
		if raw, err := os.ReadFile(image); err != nil || string(raw) != "erofs image" {
			t.Fatalf("%s: the shared image keeps its bytes: %q %v", name, raw, err)
		}
	}
}

// Each setting of a sandbox's mount statuses says a later MountsAt, even within one millisecond or after the clock
// steps back, so the control plane can order reports of them.
func TestMountsAtOnlyMovesOn(t *testing.T) {
	s := &sandbox{}
	s.meta.MountsAt = time.Now().Add(time.Hour).UnixMilli() // a clock stepped back since
	last := s.meta.MountsAt
	for i := 0; i < 5; i++ {
		setMountStatus(s, []proto.MountStatus{{Path: "/mnt/a", Kind: proto.MountBundle, State: proto.MountReady}})
		if s.meta.MountsAt <= last {
			t.Fatalf("MountsAt %d isn't after %d", s.meta.MountsAt, last)
		}
		last = s.meta.MountsAt
	}
}
