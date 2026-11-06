package microvm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// writeSnapshot makes a snapshot's directory and meta.json under m, recording recorded as its size.
func writeSnapshot(t *testing.T, m *Manager, id, kind string, createdAt, recorded int64) string {
	t.Helper()
	dir := m.snapshotDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: id, SandboxID: "sbx_1", Kind: kind, CreatedAt: createdAt, SizeBytes: recorded}})
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// A snapshot is measured as its files are on the disk now: a sparse disk's holes take nothing, a memory file still in
// RAM (a symlink into the spool) and its bundle drives count nothing. A file linked into two snapshots is in both's
// size, in neither's unique bytes, and in one shared group of the two.
func TestMeasuredSnapshotsCountWhatIsOnTheDisk(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root}}
	older := writeSnapshot(t, m, "snap_old", "auto", 1, 1<<40)
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
	newer := writeSnapshot(t, m, "snap_new", "auto", 2, 1<<40)
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

	snaps, shared := m.MeasuredSnapshots("")
	got := map[string]proto.SnapshotInfo{}
	for _, snap := range snaps {
		got[snap.ID] = snap
	}
	mem := snapshotBytes(filepath.Join(older, "mem"))
	oldDisk := snapshotBytes(filepath.Join(older, fc.DiskFile))
	if oldDisk >= 8<<20 {
		t.Fatalf("the sparse disk's holes were counted: %d bytes", oldDisk)
	}
	oldMeta, newMeta := snapshotBytes(filepath.Join(older, "meta.json")), snapshotBytes(filepath.Join(newer, "meta.json"))
	if s := got["snap_old"]; s.SizeBytes != oldDisk+mem+oldMeta || s.UniqueBytes != oldDisk+oldMeta {
		t.Fatalf("the older snapshot: %d bytes, %d its own", s.SizeBytes, s.UniqueBytes)
	}
	if s := got["snap_new"]; s.SizeBytes != mem+newMeta || s.UniqueBytes != newMeta {
		t.Fatalf("the newer snapshot: %d bytes, %d its own", s.SizeBytes, s.UniqueBytes)
	}
	if want := []proto.SharedBytes{{Snapshots: []string{"snap_new", "snap_old"}, Bytes: mem}}; !reflect.DeepEqual(shared, want) {
		t.Fatalf("shared %+v, want %+v", shared, want)
	}
	// Snapshots still answers what was recorded, without measuring.
	for _, snap := range m.Snapshots("") {
		if snap.SizeBytes != 1<<40 {
			t.Fatalf("Snapshots measured %s: %d", snap.ID, snap.SizeBytes)
		}
	}
	// One sandbox's list has only its own, and only the groups they are in.
	if snaps, shared := m.MeasuredSnapshots("sbx_other"); len(snaps) != 0 || len(shared) != 0 {
		t.Fatalf("another sandbox's list has %d snapshots and %d groups", len(snaps), len(shared))
	}
}

// A keep (snapshot.keep) answers what of it is its own and the groups it shares, as the next snapshot.list measures
// them, so the control plane records the size a refresh then gives.
func TestKeepSnapshotAnswersWhatTheListMeasures(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root}}
	source := writeSnapshot(t, m, "snap_auto", "auto", 1, 0)
	if err := os.WriteFile(filepath.Join(source, fc.DiskFile), make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	kept, err := m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "snap_kept", From: "snap_auto", Name: "kept"})
	if err != nil {
		t.Fatal(err)
	}
	snaps, shared := m.MeasuredSnapshots("")
	for _, snap := range snaps {
		if snap.ID == kept.ID && (snap.SizeBytes != kept.SizeBytes || snap.UniqueBytes != kept.UniqueBytes) {
			t.Fatalf("the keep answered %d bytes, %d its own; the list measures %d, %d", kept.SizeBytes, kept.UniqueBytes, snap.SizeBytes, snap.UniqueBytes)
		}
	}
	if !reflect.DeepEqual(kept.Shared, shared) || len(shared) != 1 || shared[0].Bytes != snapshotBytes(filepath.Join(source, fc.DiskFile)) {
		t.Fatalf("the keep shares %+v; the list %+v", kept.Shared, shared)
	}
	// Its meta.json keeps none of it: the next measure is the host's to make.
	meta, err := m.readSnapshot(kept.ID)
	if err != nil || meta.UniqueBytes != 0 || meta.Shared != nil {
		t.Fatalf("the kept meta: %+v, %v", meta.SnapshotInfo, err)
	}
}
