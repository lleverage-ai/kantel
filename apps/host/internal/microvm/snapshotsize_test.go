package microvm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A snapshot's size is what its files take on the disk now: a sparse disk's holes take nothing, a memory file still in
// RAM (a symlink into the spool) and its bundle drives count nothing, and a file linked into two snapshots counts once,
// for the older one.
func TestMeasuredSnapshotsCountWhatIsOnTheDisk(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root}}
	write := func(id string, createdAt int64, recorded int64) string {
		t.Helper()
		dir := m.snapshotDir(id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: id, SandboxID: "sbx_1", CreatedAt: createdAt, SizeBytes: recorded}})
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	allocated := func(path string) int64 {
		t.Helper()
		return snapshotBytes(path, nil)
	}

	older := write("snap_old", 1, 1<<40)
	// A disk of 64 MiB with 1 MiB written: sparse.
	disk, err := os.Create(filepath.Join(older, fc.DiskFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := disk.Truncate(64 << 20); err != nil {
		t.Fatal(err)
	}
	if _, err := disk.WriteAt(make([]byte, 1<<20), 0); err != nil {
		t.Fatal(err)
	}
	_ = disk.Close()
	if err := os.WriteFile(filepath.Join(older, "mem"), make([]byte, 2<<20), 0o600); err != nil {
		t.Fatal(err)
	}

	newer := write("snap_new", 2, 1<<40)
	// Its memory is the older one's file, linked; its state is still in RAM; it links a bundle image.
	if err := os.Link(filepath.Join(older, "mem"), filepath.Join(newer, "mem")); err != nil {
		t.Fatal(err)
	}
	spooled := filepath.Join(t.TempDir(), "spooled.mem")
	if err := os.WriteFile(spooled, make([]byte, 4<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(spooled, filepath.Join(newer, "state")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(newer, bundleDriveFile(0)), make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}

	sizes := map[string]int64{}
	for _, snap := range m.MeasuredSnapshots("") {
		sizes[snap.ID] = snap.SizeBytes
	}
	oldWant := allocated(filepath.Join(older, fc.DiskFile)) + allocated(filepath.Join(older, "mem")) + allocated(filepath.Join(older, "meta.json"))
	if sizes["snap_old"] != oldWant {
		t.Fatalf("the older snapshot is %d bytes, want %d", sizes["snap_old"], oldWant)
	}
	if sizes["snap_old"] >= 8<<20 {
		t.Fatalf("the sparse disk's holes were counted: %d bytes", sizes["snap_old"])
	}
	if want := allocated(filepath.Join(newer, "meta.json")); sizes["snap_new"] != want {
		t.Fatalf("the newer snapshot is %d bytes, want only its own meta.json's %d", sizes["snap_new"], want)
	}
	// Snapshots still answers what was recorded, without measuring.
	for _, snap := range m.Snapshots("") {
		if snap.SizeBytes != 1<<40 {
			t.Fatalf("Snapshots measured %s: %d", snap.ID, snap.SizeBytes)
		}
	}
	// A list of one sandbox's has only its own.
	if got := len(m.MeasuredSnapshots("sbx_1")); got != 2 {
		t.Fatalf("sbx_1 has %d snapshots, want 2", got)
	}
	if got := len(m.MeasuredSnapshots("sbx_other")); got != 0 {
		t.Fatalf("another sandbox's list has %d snapshots", got)
	}
}
