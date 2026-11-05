package microvm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A create from a snapshot holding memory is the snapshot's own size when it asks for that machine by any name.
func TestRestoreSizeIsTheSnapshotsOwnMachine(t *testing.T) {
	root := t.TempDir()
	sizes := []proto.Size{
		{Name: "default", VCPUs: 4, MemoryMiB: 8192, DiskGiB: 20},
		{Name: "large", VCPUs: 4, MemoryMiB: 8192, DiskGiB: 50},
		{Name: "small", VCPUs: 1, MemoryMiB: 1024, DiskGiB: 10},
	}
	m := &Manager{cfg: Config{Root: root, Sizes: sizes}}
	write := func(id, size string, memory bool) {
		t.Helper()
		dir := filepath.Join(root, "snapshots", id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: id, Memory: memory}, Size: size})
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("snap_large", "large", true)
	write("snap_custom", CustomSizeName(4, 8192, 30), true)
	write("snap_disk", "large", false)

	cases := []struct {
		from, asked, want string
	}{
		// Another name for the same vCPUs and memory: the snapshot's own.
		{"snap_large", "default", "large"},
		{"snap_large", CustomSizeName(4, 8192, 60), "large"},
		{"snap_custom", "large", CustomSizeName(4, 8192, 30)},
		// Another machine stays as asked, for the restore to refuse; the disk alone may be any size.
		{"snap_large", "small", "small"},
		{"snap_disk", "default", "default"},
		{"snap_gone", "default", "default"},
	}
	for _, c := range cases {
		asked, err := m.size(c.asked)
		if err != nil {
			t.Fatal(err)
		}
		if got := m.restoreSize(c.from, asked); got.Name != c.want {
			t.Errorf("from %s asking %s: got %s, want %s", c.from, c.asked, got.Name, c.want)
		}
	}
}
