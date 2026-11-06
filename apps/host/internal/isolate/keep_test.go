package isolate

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// writeAuto writes an automatic snapshot of iso_1 with one file, as a stop leaves it.
func writeAuto(t *testing.T, m *Manager, id string, createdAt int64) {
	t.Helper()
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

func keepCode(t *testing.T, err error) string {
	t.Helper()
	var pe *proto.Error
	if !errors.As(err, &pe) {
		t.Fatalf("error %v isn't a proto.Error", err)
	}
	return pe.Code
}

// A keep waits for a sandbox's delete removing its source, and then finds no source: it never copies a half-removed
// snapshot, nor makes an empty one of it.
func TestKeepSnapshotWaitsForTheSourcesRemoval(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, AutoSnapshots: 5}, log: slog.New(slog.NewTextHandler(io.Discard, nil)), sandboxes: map[string]*sandbox{}}
	writeAuto(t, m, "snap_a", 1)
	dir := filepath.Join(root, "sandboxes", "iso_1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	m.sandboxes["iso_1"] = &sandbox{dir: dir, meta: meta{ID: "iso_1", State: proto.StateStopped}}
	// The delete is part way through removing the sandbox's automatic snapshots: it holds autoMu.
	m.autoMu.Lock()
	done := make(chan error, 1)
	go func() {
		_, err := m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "snap_k", From: "snap_a"})
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("a keep ran while the source was being removed: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	_ = os.RemoveAll(m.snapshotDir("snap_a"))
	m.autoMu.Unlock()
	select {
	case err := <-done:
		if keepCode(t, err) != proto.ErrNotFound {
			t.Fatalf("keep of a removed source: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the keep didn't go ahead once the removal was done")
	}
	if _, err := os.Stat(m.snapshotDir("snap_k")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused keep left a snapshot: %v", err)
	}
	// And the delete itself, run with a keep: the keep either copies the whole source first or finds it gone.
	writeAuto(t, m, "snap_b", 2)
	kept := make(chan error, 1)
	go func() {
		_, err := m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "snap_k2", From: "snap_b"})
		kept <- err
	}()
	if err := m.Delete(context.Background(), "iso_1"); err != nil {
		t.Fatal(err)
	}
	if err := <-kept; err != nil {
		if keepCode(t, err) != proto.ErrNotFound {
			t.Fatalf("keep beside a delete: %v", err)
		}
	} else if man, err := readManifest(filepath.Join(m.snapshotDir("snap_k2"), "manifest.json")); err != nil || man["/home/user/a"].SHA != "snap_b" {
		t.Fatalf("kept beside a delete: %v, %v", man, err)
	}
}

// A source whose manifest is gone has lost its files: the keep is refused, not made an empty workspace.
func TestKeepSnapshotRefusesASourceWithoutItsManifest(t *testing.T) {
	m := &Manager{cfg: Config{Root: t.TempDir(), AutoSnapshots: 5}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	writeAuto(t, m, "snap_a", 1)
	if err := os.Remove(filepath.Join(m.snapshotDir("snap_a"), "manifest.json")); err != nil {
		t.Fatal(err)
	}
	_, err := m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "snap_k", From: "snap_a"})
	if keepCode(t, err) != proto.ErrNotFound {
		t.Fatalf("keep without a manifest: %v", err)
	}
	if _, err := os.Stat(m.snapshotDir("snap_k")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a refused keep left a snapshot: %v", err)
	}
}

// A kept snapshot of an isolate is a saved one of its source's manifest: more stops' pruning and the sandbox's delete,
// which remove its automatic snapshots, leave it.
func TestKeptSnapshotOutlivesPruneAndSandboxDelete(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, AutoSnapshots: 1}, log: slog.New(slog.NewTextHandler(io.Discard, nil)), sandboxes: map[string]*sandbox{}}
	auto := func(id string, createdAt int64) { writeAuto(t, m, id, createdAt) }
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

// A sandbox made from a snapshot reads its source as a keep does: it waits for a removal under way, then finds the
// source gone rather than an empty workspace, and a source whose manifest is gone is refused.
func TestCreateFromASnapshotReadsItWholeOrNotAtAll(t *testing.T) {
	m := &Manager{cfg: Config{Root: t.TempDir(), AutoSnapshots: 5}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	writeAuto(t, m, "snap_a", 1)
	if man, err := m.snapshotManifest("snap_a", "acct"); err != nil || man["/home/user/a"].SHA != "snap_a" {
		t.Fatalf("read a snapshot: %v, %v", man, err)
	}
	if _, err := m.snapshotManifest("snap_a", "someone-else"); keepCode(t, err) != proto.ErrNotFound {
		t.Fatalf("another account's snapshot: %v", err)
	}
	// A delete or a prune is part way through removing it: it holds autoMu.
	m.autoMu.Lock()
	done := make(chan error, 1)
	go func() {
		_, err := m.snapshotManifest("snap_a", "acct")
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("a create read its source while it was being removed: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	_ = os.Remove(filepath.Join(m.snapshotDir("snap_a"), "manifest.json"))
	m.autoMu.Unlock()
	select {
	case err := <-done:
		if keepCode(t, err) != proto.ErrNotFound {
			t.Fatalf("a create from a source that lost its files: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the create didn't go ahead once the removal was done")
	}
	_ = os.RemoveAll(m.snapshotDir("snap_a"))
	if _, err := m.snapshotManifest("snap_a", "acct"); err == nil {
		t.Fatal("a create from a removed snapshot went ahead")
	}
}
