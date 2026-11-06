package microvm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A kept copy (snapshot.keep) links its source's files: they count once, for the saved copy, which keeps them once its
// automatic source is pruned or expires; deleting the source then leaves the copy's size as it was.
func TestMeasuredSnapshotsCountAKeptCopyForTheSave(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root}}
	write := func(id, kind string, createdAt int64) string {
		t.Helper()
		dir := m.snapshotDir(id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: id, SandboxID: "sbx_1", Kind: kind, CreatedAt: createdAt}})
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	source := write("snap_auto", "auto", 1)
	if err := os.WriteFile(filepath.Join(source, fc.DiskFile), make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	kept := write("snap_kept", "saved", 2)
	if err := os.Link(filepath.Join(source, fc.DiskFile), filepath.Join(kept, fc.DiskFile)); err != nil {
		t.Fatal(err)
	}
	measured := func() map[string]int64 {
		out := map[string]int64{}
		for _, snap := range m.MeasuredSnapshots("") {
			out[snap.ID] = snap.SizeBytes
		}
		return out
	}
	sizes := measured()
	disk := snapshotBytes(filepath.Join(kept, fc.DiskFile), nil)
	if want := disk + snapshotBytes(filepath.Join(kept, "meta.json"), nil); sizes["snap_kept"] != want {
		t.Fatalf("the kept copy is %d bytes, want its disk and meta, %d", sizes["snap_kept"], want)
	}
	if want := snapshotBytes(filepath.Join(source, "meta.json"), nil); sizes["snap_auto"] != want {
		t.Fatalf("its source is %d bytes, want only its own meta.json's %d", sizes["snap_auto"], want)
	}
	if err := os.RemoveAll(source); err != nil {
		t.Fatal(err)
	}
	if after := measured()["snap_kept"]; after != sizes["snap_kept"] {
		t.Fatalf("the kept copy went from %d to %d bytes once its source went", sizes["snap_kept"], after)
	}
}
