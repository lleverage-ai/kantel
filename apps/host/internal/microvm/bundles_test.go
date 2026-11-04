package microvm

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	if err := snapshotDrives(next, snap, 3, slots); err != nil {
		t.Fatal(err)
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
}
