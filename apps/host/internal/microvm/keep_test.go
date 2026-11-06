package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// keepFixture is a microVM tier with no machines: snapshots are written as a stop would leave them.
type keepFixture struct {
	t    *testing.T
	root string
	m    *Manager
}

func newKeepFixture(t *testing.T) *keepFixture {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, AutoSnapshots: 2}, log: slog.New(slog.NewTextHandler(io.Discard, nil)), sandboxes: map[string]*sandbox{}}
	return &keepFixture{t: t, root: root, m: m}
}

// auto writes an automatic snapshot of sbx_1: its disk, and with memory its state, memory and a bundle drive.
func (f *keepFixture) auto(id string, createdAt int64, memory bool) {
	f.t.Helper()
	dir := f.m.snapshotDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		f.t.Fatal(err)
	}
	files := map[string]string{fc.DiskFile: "disk of " + id}
	sm := snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: id, SandboxID: "sbx_1", Kind: "auto", CreatedAt: createdAt, Memory: memory, Tier: Tier, Base: "v1"}, Size: "small"}
	if memory {
		files["state"], files["mem"], files[bundleDriveFile(0)] = "state of "+id, "mem of "+id, "bundle"
		sm.BundleDrives, sm.BundleSlots = 1, []string{"sha256:abc"}
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			f.t.Fatal(err)
		}
	}
	raw, _ := json.Marshal(sm)
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
		f.t.Fatal(err)
	}
}

func (f *keepFixture) keep(from, id string) proto.SnapshotInfo {
	f.t.Helper()
	info, err := f.m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: id, From: from, Name: "kept"})
	if err != nil {
		f.t.Fatal(err)
	}
	return info
}

func (f *keepFixture) read(id, name string) string {
	f.t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.m.snapshotDir(id), name))
	if err != nil {
		f.t.Fatalf("%s of %s: %v", name, id, err)
	}
	return string(raw)
}

func (f *keepFixture) gone(id string) bool {
	_, err := os.Stat(f.m.snapshotDir(id))
	return errors.Is(err, os.ErrNotExist)
}

// A kept snapshot is a saved one of its source's files, its memory too, and its source stays in the history as it was.
func TestKeepSnapshotMakesASavedSnapshotOfAnAutomaticOne(t *testing.T) {
	f := newKeepFixture(t)
	f.auto("snap_a", 1, true)
	info := f.keep("snap_a", "snap_k")
	if info.ID != "snap_k" || info.Kind != "saved" || info.Name != "kept" || info.SandboxID != "sbx_1" || !info.Memory || info.Base != "v1" {
		t.Fatalf("kept %+v", info)
	}
	if got := f.read("snap_k", fc.DiskFile); got != "disk of snap_a" {
		t.Fatalf("disk %q", got)
	}
	if got := f.read("snap_k", "mem"); got != "mem of snap_a" {
		t.Fatalf("mem %q", got)
	}
	kept, err := f.m.readSnapshot("snap_k")
	if err != nil {
		t.Fatal(err)
	}
	if kept.Size != "small" || kept.BundleDrives != 1 || len(kept.BundleSlots) != 1 || kept.Kind != "saved" {
		t.Fatalf("kept meta %+v", kept)
	}
	src, err := f.m.readSnapshot("snap_a")
	if err != nil || src.Kind != "auto" || !src.Memory {
		t.Fatalf("source after keep %+v, %v", src, err)
	}
	// Each is whole without the other.
	if err := f.m.DeleteSnapshot("snap_a"); err != nil {
		t.Fatal(err)
	}
	if got := f.read("snap_k", "mem"); got != "mem of snap_a" {
		t.Fatalf("mem after its source went %q", got)
	}
}

// The host's own removals of automatic snapshots, more stops (pruneAuto) and the sandbox's delete, leave a kept one
// whole: its memory too.
func TestPruneAndSandboxDeleteLeaveAKeptSnapshot(t *testing.T) {
	f := newKeepFixture(t)
	f.auto("snap_a", 1, true)
	f.keep("snap_a", "snap_k")
	// Newer stops: the source loses its memory, then goes.
	f.auto("snap_b", 2, true)
	f.m.pruneAuto("sbx_1")
	if src, _ := f.m.readSnapshot("snap_a"); src.Memory {
		t.Fatal("the source kept its memory past a newer stop")
	}
	f.auto("snap_c", 3, true)
	f.m.pruneAuto("sbx_1")
	if !f.gone("snap_a") {
		t.Fatal("the source outlived AutoSnapshots newer ones")
	}
	kept, err := f.m.readSnapshot("snap_k")
	if err != nil || kept.Kind != "saved" || !kept.Memory || kept.BundleDrives != 1 {
		t.Fatalf("kept after prunes %+v, %v", kept, err)
	}
	for _, name := range []string{fc.DiskFile, "state", "mem", bundleDriveFile(0)} {
		f.read("snap_k", name)
	}

	dir := filepath.Join(f.root, "sandboxes", "sbx_1")
	if err := os.MkdirAll(filepath.Join(dir, "vm"), 0o700); err != nil {
		t.Fatal(err)
	}
	f.m.sandboxes["sbx_1"] = &sandbox{dir: dir, meta: meta{ID: "sbx_1", State: proto.StateStopped}}
	if err := f.m.Delete(context.Background(), "sbx_1"); err != nil {
		t.Fatal(err)
	}
	if !f.gone("snap_b") || !f.gone("snap_c") {
		t.Fatal("the sandbox's delete left its automatic snapshots")
	}
	if got := f.read("snap_k", fc.DiskFile); got != "disk of snap_a" {
		t.Fatalf("kept disk after the sandbox's delete %q", got)
	}
	if got := f.read("snap_k", "mem"); got != "mem of snap_a" {
		t.Fatalf("kept mem after the sandbox's delete %q", got)
	}
	if got := f.m.Snapshots("sbx_1"); len(got) != 1 || got[0].ID != "snap_k" {
		t.Fatalf("snapshots after the delete %+v", got)
	}
}

// An automatic snapshot whose memory was already pruned is kept as its disk alone, and says so.
func TestKeepSnapshotOfAPrunedSnapshotHasNoMemory(t *testing.T) {
	f := newKeepFixture(t)
	f.auto("snap_a", 1, true)
	f.auto("snap_b", 2, true)
	f.m.pruneAuto("sbx_1")
	info := f.keep("snap_a", "snap_k")
	if info.Memory {
		t.Fatal("kept a pruned snapshot with memory")
	}
	kept, _ := f.m.readSnapshot("snap_k")
	if kept.Memory || kept.BundleDrives != 0 || kept.BundleSlots != nil {
		t.Fatalf("kept meta %+v", kept)
	}
	for _, name := range []string{"state", "mem", bundleDriveFile(0)} {
		if _, err := os.Stat(filepath.Join(f.m.snapshotDir("snap_k"), name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s kept without memory: %v", name, err)
		}
	}
}

// A memory file that can't be linked (gone under the meta that names it) leaves the kept snapshot with its disk alone.
func TestKeepSnapshotWithoutItsMemoryFileKeepsTheDisk(t *testing.T) {
	f := newKeepFixture(t)
	f.auto("snap_a", 1, true)
	if err := os.Remove(filepath.Join(f.m.snapshotDir("snap_a"), "mem")); err != nil {
		t.Fatal(err)
	}
	if info := f.keep("snap_a", "snap_k"); info.Memory {
		t.Fatal("kept with memory it doesn't have")
	}
	if _, err := os.Stat(filepath.Join(f.m.snapshotDir("snap_k"), "state")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("state kept without its memory: %v", err)
	}
	f.read("snap_k", fc.DiskFile)
}

func TestKeepSnapshotRefusals(t *testing.T) {
	f := newKeepFixture(t)
	f.auto("snap_a", 1, false)
	f.keep("snap_a", "snap_k")
	code := func(err error) string {
		var pe *proto.Error
		if !errors.As(err, &pe) {
			t.Fatalf("error %v isn't a proto.Error", err)
		}
		return pe.Code
	}
	_, err := f.m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "snap_k", From: "snap_a"})
	if code(err) != proto.ErrConflict {
		t.Fatalf("an existing ID: %v", err)
	}
	_, err = f.m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "snap_x", From: "snap_none"})
	if code(err) != proto.ErrNotFound {
		t.Fatalf("an unknown source: %v", err)
	}
	_, err = f.m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "../x", From: "snap_a"})
	if code(err) != proto.ErrInvalid {
		t.Fatalf("a bad ID: %v", err)
	}
	// A live fork's own snapshot, whose disk the fork takes, isn't one to keep.
	raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: "snap_t", SandboxID: "sbx_1", Kind: "auto"}, Transient: true})
	if err := os.MkdirAll(f.m.snapshotDir("snap_t"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.m.snapshotDir("snap_t"), "meta.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = f.m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "snap_y", From: "snap_t"})
	if code(err) != proto.ErrNotFound {
		t.Fatalf("a transient source: %v", err)
	}
	if !f.gone("snap_x") || !f.gone("snap_y") {
		t.Fatal("a refused keep left a directory")
	}
}

// A source whose memory is still in the RAM spool: the kept snapshot's memory is another of the spool's links, so the
// spool's move to the disk lands in both.
func TestKeepSnapshotOfSpooledMemory(t *testing.T) {
	f := newKeepFixture(t)
	sp := newSpool(filepath.Join(f.root, "spool"), 1<<20, slog.New(slog.NewTextHandler(io.Discard, nil)))
	f.m.spool = sp
	f.auto("snap_a", 1, true)
	path := spoolFile(t, sp, 4096)
	src := filepath.Join(f.m.snapshotDir("snap_a"), "mem")
	_ = os.Remove(src)
	sp.mu.Lock()
	sp.targets[path] = append(sp.targets[path], src)
	if err := os.Symlink(path, src); err != nil {
		t.Fatal(err)
	}
	sp.mu.Unlock()
	if info := f.keep("snap_a", "snap_k"); !info.Memory {
		t.Fatal("kept spooled memory as none")
	}
	kept := filepath.Join(f.m.snapshotDir("snap_k"), "mem")
	if dest, err := os.Readlink(kept); err != nil || dest != path {
		t.Fatalf("kept memory links %q, %v; want the spool file", dest, err)
	}
	sp.queue <- path
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the spool file never moved")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for _, mem := range []string{src, kept} {
		info, err := os.Lstat(mem)
		if err != nil || !info.Mode().IsRegular() || info.Size() != 4096 {
			t.Fatalf("%s after the spool's move: %v, %v", mem, info, err)
		}
	}
}
