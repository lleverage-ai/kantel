package isolate

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A kept snapshot of an isolate is a saved one of its source's manifest: more stops' pruning and the sandbox's delete,
// which remove its automatic snapshots, leave it.
func TestKeptSnapshotOutlivesPruneAndSandboxDelete(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, AutoSnapshots: 1}, log: slog.New(slog.NewTextHandler(io.Discard, nil)), sandboxes: map[string]*sandbox{}}
	auto := func(id string, createdAt int64) {
		dir := m.snapshotDir(id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := writeJSONFile(filepath.Join(dir, "manifest.json"), Manifest{"/home/user/a": {Kind: "file", SHA: id, Size: 3}}); err != nil {
			t.Fatal(err)
		}
		snap := snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: id, SandboxID: "iso_1", Kind: "auto", CreatedAt: createdAt, SizeBytes: 3, Tier: Tier}, Owner: "acct"}
		if err := writeJSONFile(filepath.Join(dir, "meta.json"), snap); err != nil {
			t.Fatal(err)
		}
	}
	auto("snap_a", 1)
	info, err := m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "snap_k", From: "snap_a", Name: "kept"})
	if err != nil {
		t.Fatal(err)
	}
	if info.Kind != "saved" || info.SandboxID != "iso_1" || info.SizeBytes != 3 || info.Name != "kept" {
		t.Fatalf("kept %+v", info)
	}
	auto("snap_b", 2)
	m.pruneAuto("iso_1")
	if _, err := m.readSnapshot("snap_a"); err == nil {
		t.Fatal("the source outlived AutoSnapshots newer ones")
	}
	dir := filepath.Join(root, "sandboxes", "iso_1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	m.sandboxes["iso_1"] = &sandbox{dir: dir, meta: meta{ID: "iso_1", State: proto.StateStopped}}
	if err := m.Delete(context.Background(), "iso_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(m.snapshotDir("snap_b")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the sandbox's delete left an automatic snapshot: %v", err)
	}
	kept, err := m.readSnapshot("snap_k")
	if err != nil || kept.Owner != "acct" || kept.Kind != "saved" {
		t.Fatalf("kept after the delete %+v, %v", kept, err)
	}
	man, err := readManifest(filepath.Join(m.snapshotDir("snap_k"), "manifest.json"))
	if err != nil || man["/home/user/a"].SHA != "snap_a" {
		t.Fatalf("kept manifest %v, %v", man, err)
	}
}
