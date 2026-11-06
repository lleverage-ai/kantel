package microvm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// The tier's files by what they are for, each once: memory a stop's snapshot shares with its sandbox counts for the
// sandbox, and a file counted before (a bundle image) counts nothing here.
func TestDiskBreakdownCountsEachFileOnce(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root}}
	file := func(path string, n int) string {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, make([]byte, n), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	snapshot := func(id, kind string) string {
		t.Helper()
		dir := m.snapshotDir(id)
		raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: id, Kind: kind}})
		file(filepath.Join(dir, "meta.json"), 0)
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	allocated := func(path string) int64 { return fsutil.Allocated(path, nil) }

	file(filepath.Join(root, "images", "templates", "base.ext4"), 1<<20)
	file(filepath.Join(root, "templates", "default", "mem"), 2<<20)
	vm := filepath.Join(root, "sandboxes", "sbx_1", "vm")
	file(filepath.Join(vm, "disk.ext4"), 3<<20)
	mem := file(filepath.Join(vm, "mem"), 4<<20)
	bundle := file(filepath.Join(t.TempDir(), "bundle.erofs"), 1<<20)

	auto := snapshot("snap_auto", "auto")
	file(filepath.Join(auto, "disk.ext4"), 5<<20)
	if err := os.Link(mem, filepath.Join(auto, "mem")); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(bundle, filepath.Join(auto, "bundle0.erofs")); err != nil {
		t.Fatal(err)
	}
	saved := snapshot("snap_saved", "saved")
	file(filepath.Join(saved, "disk.ext4"), 6<<20)

	seen := fsutil.Seen{}
	bundles := fsutil.Allocated(bundle, seen)
	got := m.DiskBreakdown(seen)
	if got.Images != allocated(filepath.Join(root, "images")) || got.Templates != allocated(filepath.Join(root, "templates")) {
		t.Fatalf("images and templates: %+v", got)
	}
	if got.Sandboxes != allocated(filepath.Join(root, "sandboxes")) {
		t.Fatalf("sandboxes: %d", got.Sandboxes)
	}
	// The automatic snapshot's memory is the sandbox's, its bundle drive the cache's.
	if want := allocated(filepath.Join(auto, "disk.ext4")) + allocated(filepath.Join(auto, "meta.json")); got.Automatic != want {
		t.Fatalf("automatic snapshots are %d bytes, want %d", got.Automatic, want)
	}
	if want := allocated(saved); got.Saved != want {
		t.Fatalf("saved snapshots are %d bytes, want %d", got.Saved, want)
	}
	if bundles == 0 {
		t.Fatal("the bundle image counted nothing")
	}
}
