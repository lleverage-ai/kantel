package microvm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// moveHost is snapshotSyncHost with the default size and a place for sandboxes.
func moveHost(t *testing.T) *Manager {
	t.Helper()
	m, _ := snapshotSyncHost(t)
	m.cfg.Sizes = DefaultSizes
	m.sandboxes = map[string]*sandbox{}
	return m
}

// stoppedTestSandbox makes a stopped sandbox in m's root over version's image, as a stop leaves one: its disk, a sticky
// disk on its first drive and none on its second, a bundle drive linked to a cached image, its memory, and an egress
// with its host's CA.
func stoppedTestSandbox(t *testing.T, m *Manager, id, version string) *sandbox {
	t.Helper()
	s := &sandbox{dir: filepath.Join(m.cfg.Root, "sandboxes", id)}
	vm := s.vmDir()
	if err := os.MkdirAll(vm, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.linkRootfs(vm, versionFile(m, version)); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{
		fc.DiskFile:        bytes.Repeat([]byte{1}, 2*blockmap.BlockSize+5),
		stickyDriveFile(0): bytes.Repeat([]byte{3}, blockmap.BlockSize+9),
		stickyDriveFile(1): nil,
		bundleDriveFile(0): []byte("a bundle's image"),
		"mem":              []byte("its memory"),
		"state":            []byte("its machine"),
	} {
		if err := os.WriteFile(filepath.Join(vm, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s.meta = meta{
		ID: id, Size: "default", State: proto.StateStopped, CreatedAt: 1, Memory: true, Owner: "acc",
		Egress: &proto.Egress{Mode: "open", CACert: "the source host's CA"}, Env: map[string]string{"A": "1"},
		BundleDrives: 1, BundleSlots: []string{"sha256:bundle"}, StickyDrives: StickyDrives,
		StickyDisks: []stickyDisk{{DiskID: "sd1", Path: "/var/cache", Version: "v1", Slot: 0, State: proto.StickyMounted}},
		Runtime:     m.portableRuntime(versionFile(m, version)),
	}
	if err := m.writeMeta(s); err != nil {
		t.Fatal(err)
	}
	m.sandboxes[id] = s
	return s
}

// importTestSandbox moves version of a sandbox's object from one host to another as sandbox.import does, but with the
// files copied rather than fetched: its record read first and the import made ready, then each part's partial
// written with the holder's bytes, then the parts published together.
func importTestSandbox(t *testing.T, from, to *Manager, id, version string) error {
	t.Helper()
	record, err := from.ReadSandboxFile(id, version, proto.SandboxRecordFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := to.PrepareSandboxImport(context.Background(), id, version, to.ImportGeneration(id), record); err != nil {
		return err
	}
	parts := map[string]disksync.FetchedPart{}
	for _, part := range SandboxParts {
		src, raw, err := from.OpenSandboxPart(id, version, part, true)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(src.Name())
		src.Close()
		path, err := to.SandboxPartPartial(id, version, part)
		if err != nil {
			return err
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		parts[part] = disksync.FetchedPart{File: f, Map: raw}
	}
	return to.PublishFetchedSandbox(id, version, parts)
}

// A stopped sandbox's export is its files as they were, mapped, with a manifest whose digest its answer has; another
// host makes it a stopped sandbox of its own with the same files, over its own file of the image, with no memory, its
// bundle drives empty and its egress without the source host's CA. The source's sandbox is untouched.
func TestStoppedSandboxMovesToAnotherHost(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	s := stoppedTestSandbox(t, a, "sb1", "old")
	exported, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"})
	if err != nil {
		t.Fatal(err)
	}
	if !a.HoldsSandbox("sb1", "mov_1") || exported.MapDigest == "" {
		t.Fatalf("exported %+v", exported)
	}
	// What the sandbox writes after doesn't change its export.
	if err := os.WriteFile(filepath.Join(s.vmDir(), fc.DiskFile), []byte("written since"), 0o600); err != nil {
		t.Fatal(err)
	}
	var digests []disksync.PartDigest
	for _, part := range SandboxParts {
		f, raw, err := a.OpenSandboxPart("sb1", "mov_1", part, true)
		if err != nil {
			t.Fatalf("%s: %v", part, err)
		}
		f.Close()
		digests = append(digests, disksync.PartDigest{Part: part, Digest: blockmap.Digest(raw)})
	}
	if got := blockmap.Digest(disksync.Manifest(digests)); got != exported.MapDigest {
		t.Fatalf("the manifest's digest is %s, the export answered %s", got, exported.MapDigest)
	}
	again, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"})
	if err != nil || again.MapDigest != exported.MapDigest {
		t.Fatalf("asked again: %+v, %v", again, err)
	}

	if err := importTestSandbox(t, a, b, "sb1", "mov_1"); err != nil {
		t.Fatal(err)
	}
	if !b.HoldsSandbox("sb1", "mov_1") {
		t.Fatal("the target doesn't hold what it imported")
	}
	info, err := b.ImportedSandbox("sb1", "mov_1")
	if err != nil || info.State != proto.StateStopped || info.Memory || info.Base != "old" || info.Owner != "acc" {
		t.Fatalf("imported %+v, %v", info, err)
	}
	moved, _ := b.get("sb1")
	vm := moved.vmDir()
	if got := vmRootfs(vm); got != versionFile(b, "old") {
		t.Fatalf("its root filesystem is %s", got)
	}
	for name, want := range map[string][]byte{
		fc.DiskFile:        bytes.Repeat([]byte{1}, 2*blockmap.BlockSize+5),
		stickyDriveFile(0): bytes.Repeat([]byte{3}, blockmap.BlockSize+9),
		stickyDriveFile(1): {},
		bundleDriveFile(0): {},
	} {
		if got, err := os.ReadFile(filepath.Join(vm, name)); err != nil || !bytes.Equal(got, want) {
			t.Errorf("%s: %d bytes, %v", name, len(got), err)
		}
	}
	for _, name := range []string{"mem", "state", fc.DiskFile + ".done"} {
		if fileExists(filepath.Join(vm, name)) {
			t.Errorf("%s came with it", name)
		}
	}
	got := moved.meta
	if got.Egress == nil || got.Egress.CACert != "" || got.Egress.Mode != "open" || got.Env["A"] != "1" ||
		len(got.BundleSlots) != 1 || got.BundleSlots[0] != "" || len(got.StickyDisks) != 1 ||
		got.StickyDisks[0].DiskID != "sd1" || got.Imported != "mov_1" {
		t.Fatalf("its record %+v", got)
	}
	var onDisk meta
	raw, _ := os.ReadFile(filepath.Join(moved.dir, "meta.json"))
	if err := json.Unmarshal(raw, &onDisk); err != nil || onDisk.Imported != "mov_1" || onDisk.State != proto.StateStopped {
		t.Fatalf("its meta.json %+v, %v", onDisk, err)
	}
	if left, _ := os.ReadDir(filepath.Join(b.cfg.Root, sandboxImportsDir)); len(left) != 0 {
		t.Fatalf("left in the imports: %v", left)
	}
	// Asked again, it is made already.
	if err := b.PrepareSandboxImport(context.Background(), "sb1", "mov_1", 0, nil); err != nil {
		t.Fatal(err)
	}
	if src, _ := a.get("sb1"); src.meta.State != proto.StateStopped || !src.meta.Memory {
		t.Fatalf("the source's sandbox changed: %+v", src.meta)
	}

	if err := a.DeleteSandboxExport("sb1", "mov_1"); err != nil || a.HoldsSandbox("sb1", "mov_1") {
		t.Fatalf("the export is still there (%v)", err)
	}
}

// Only a stopped sandbox is exported; another host takes one only of a size it makes, over an image it can have,
// and never over a sandbox of that ID it has.
func TestSandboxMoveRefusals(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	s := stoppedTestSandbox(t, a, "sb1", "old")
	s.meta.State = proto.StateRunning
	var pe *proto.Error
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); !errors.As(err, &pe) || pe.Code != proto.ErrConflict {
		t.Fatalf("a running sandbox exported: %v", err)
	}
	if fileExists(a.sandboxExportDir("sb1", "mov_1")) {
		t.Fatal("a refused export left its directory")
	}
	s.meta.State = proto.StateStopped
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "../x"}); !errors.As(err, &pe) || pe.Code != proto.ErrInvalid {
		t.Fatalf("a bad version: %v", err)
	}
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); err != nil {
		t.Fatal(err)
	}
	record, _ := a.ReadSandboxFile("sb1", "mov_1", proto.SandboxRecordFile)

	// A size the target doesn't make.
	b.cfg.Sizes = []proto.Size{{Name: "small", VCPUs: 1, MemoryMiB: 1024, DiskGiB: 10}}
	if err := b.PrepareSandboxImport(context.Background(), "sb1", "mov_1", 0, record); err == nil {
		t.Fatal("made ready for a size the host doesn't make")
	}
	b.cfg.Sizes = DefaultSizes
	// An image version the target can't have.
	_ = os.Remove(versionFile(b, "old"))
	if err := b.PrepareSandboxImport(context.Background(), "sb1", "mov_1", 0, record); !errors.Is(err, ErrNoSnapshotImage) {
		t.Fatalf("made ready without its image: %v", err)
	}
	if fileExists(filepath.Join(b.cfg.Root, sandboxImportsDir, "sb1")) {
		t.Fatal("a refused import left its directory")
	}
	// A sandbox of that ID there already.
	c := moveHost(t)
	stoppedTestSandbox(t, c, "sb1", "old")
	if err := c.PrepareSandboxImport(context.Background(), "sb1", "mov_1", 0, record); !errors.As(err, &pe) || pe.Code != proto.ErrConflict {
		t.Fatalf("over a sandbox of its ID: %v", err)
	}
}

// A delete of a sandbox whose import is under way ends it: the import's directory goes, and it is never published,
// even by a fetch that wrote its partials before; a delete of an ID the host has only an import of is done.
func TestDeletingASandboxBeingImported(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	stoppedTestSandbox(t, a, "sb1", "old")
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); err != nil {
		t.Fatal(err)
	}
	record, _ := a.ReadSandboxFile("sb1", "mov_1", proto.SandboxRecordFile)
	if err := b.PrepareSandboxImport(context.Background(), "sb1", "mov_1", 0, record); err != nil {
		t.Fatal(err)
	}
	parts := map[string]disksync.FetchedPart{}
	for _, part := range SandboxParts {
		path, err := b.SandboxPartPartial("sb1", "mov_1", part)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		f, _ := os.Open(path)
		defer f.Close()
		parts[part] = disksync.FetchedPart{File: f}
	}
	if err := b.Delete(context.Background(), "sb1"); err != nil {
		t.Fatalf("a delete of an import: %v", err)
	}
	if fileExists(filepath.Join(b.cfg.Root, sandboxImportsDir, "sb1")) {
		t.Fatal("the import's directory is still there")
	}
	if err := b.PublishFetchedSandbox("sb1", "mov_1", parts); err == nil {
		t.Fatal("published after its delete")
	}
	if _, err := b.get("sb1"); err == nil {
		t.Fatal("the sandbox is there")
	}
	// A move made ready again, after, goes through.
	if err := importTestSandbox(t, a, b, "sb1", "mov_1"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.get("sb1"); err != nil {
		t.Fatal(err)
	}
}

// A sandbox moved to another host is deleted from its source with its automatic snapshots kept, as its history, and
// its exports gone; a plain delete removes both.
func TestDeleteMovedKeepsItsSnapshots(t *testing.T) {
	a := moveHost(t)
	for _, keep := range []bool{true, false} {
		stoppedTestSandbox(t, a, "sb1", "old")
		if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); err != nil {
			t.Fatal(err)
		}
		snap := saveTestSnapshot(t, a, "snap_auto", "old", false)
		snap.Kind = "auto"
		raw, _ := json.Marshal(snap)
		if err := os.WriteFile(filepath.Join(a.snapshotDir("snap_auto"), "meta.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		var err error
		if keep {
			err = a.DeleteMoved("sb1")
		} else {
			err = a.Delete(context.Background(), "sb1")
		}
		if err != nil {
			t.Fatal(err)
		}
		if fileExists(filepath.Join(a.cfg.Root, "sandboxes", "sb1")) || fileExists(a.sandboxExportDir("sb1", "mov_1")) {
			t.Fatalf("keep %v: the sandbox or its export is still there", keep)
		}
		if fileExists(a.snapshotDir("snap_auto")) != keep {
			t.Fatalf("keep %v: its automatic snapshot there: %v", keep, fileExists(a.snapshotDir("snap_auto")))
		}
	}
}

// A prune keeps the image a sandbox being imported is over.
func TestSandboxImportKeepsItsImage(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	stoppedTestSandbox(t, a, "sb1", "old")
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); err != nil {
		t.Fatal(err)
	}
	record, _ := a.ReadSandboxFile("sb1", "mov_1", proto.SandboxRecordFile)
	if err := b.PrepareSandboxImport(context.Background(), "sb1", "mov_1", 0, record); err != nil {
		t.Fatal(err)
	}
	in, err := BasesUnder(b.cfg.Root)
	if err != nil || !in["old"] {
		t.Fatalf("bases in use %v, %v", in, err)
	}
}

// stageTestImport makes version's import of a sandbox ready on to, with every part's partial written, and answers the
// parts as a fetch would publish them.
func stageTestImport(t *testing.T, from, to *Manager, id, version string) map[string]disksync.FetchedPart {
	t.Helper()
	record, _ := from.ReadSandboxFile(id, version, proto.SandboxRecordFile)
	if err := to.PrepareSandboxImport(context.Background(), id, version, to.ImportGeneration(id), record); err != nil {
		t.Fatal(err)
	}
	parts := map[string]disksync.FetchedPart{}
	for _, part := range SandboxParts {
		path, err := to.SandboxPartPartial(id, version, part)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		f, _ := os.Open(path)
		t.Cleanup(func() { f.Close() })
		parts[part] = disksync.FetchedPart{File: f}
	}
	return parts
}

// A newer move's import replaces an older one's: the older finds nowhere to write and isn't published, and the newer's
// files are untouched by it.
func TestAnOlderImportNeverWritesANewerOne(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	stoppedTestSandbox(t, a, "sb1", "old")
	for _, v := range []string{"mov_1", "mov_2"} {
		if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: v}); err != nil {
			t.Fatal(err)
		}
	}
	older := stageTestImport(t, a, b, "sb1", "mov_1")
	newer := stageTestImport(t, a, b, "sb1", "mov_2")
	if _, err := b.SandboxPartPartial("sb1", "mov_1", proto.SandboxPartDisk); err == nil {
		t.Fatal("the older import still has somewhere to write")
	}
	if err := b.PublishFetchedSandbox("sb1", "mov_1", older); err == nil {
		t.Fatal("the older import was published")
	}
	if err := b.PublishFetchedSandbox("sb1", "mov_2", newer); err != nil {
		t.Fatal(err)
	}
	if info, err := b.ImportedSandbox("sb1", "mov_2"); err != nil || info.State != proto.StateStopped {
		t.Fatalf("the newer import: %+v, %v", info, err)
	}
}

// A cancelled import (a move rolled back) is never made ready or published after, even by a call still under way that
// had made it ready; a sandbox it made is deleted, and one another move made is left.
func TestCancelledImport(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	stoppedTestSandbox(t, a, "sb1", "old")
	for _, v := range []string{"mov_1", "mov_2"} {
		if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: v}); err != nil {
			t.Fatal(err)
		}
	}
	parts := stageTestImport(t, a, b, "sb1", "mov_1")
	if deleted, err := b.CancelSandboxImport("sb1", "mov_1"); err != nil || deleted {
		t.Fatalf("cancelled: deleted %v, %v", deleted, err)
	}
	if err := b.PublishFetchedSandbox("sb1", "mov_1", parts); err == nil {
		t.Fatal("published after its cancel")
	}
	record, _ := a.ReadSandboxFile("sb1", "mov_1", proto.SandboxRecordFile)
	var pe *proto.Error
	if err := b.PrepareSandboxImport(context.Background(), "sb1", "mov_1", 0, record); !errors.As(err, &pe) || pe.Code != proto.ErrConflict {
		t.Fatalf("made ready after its cancel: %v", err)
	}
	if fileExists(filepath.Join(b.cfg.Root, sandboxImportsDir, "sb1")) {
		t.Fatal("the cancelled import left its directory")
	}
	// Another move's sandbox isn't the cancelled one's to delete; its own is.
	if err := importTestSandbox(t, a, b, "sb1", "mov_2"); err != nil {
		t.Fatal(err)
	}
	if deleted, err := b.CancelSandboxImport("sb1", "mov_1"); err != nil || deleted {
		t.Fatalf("a cancel of another move: deleted %v, %v", deleted, err)
	}
	if _, err := b.get("sb1"); err != nil {
		t.Fatal("a cancel of another move deleted the sandbox")
	}
	if deleted, err := b.CancelSandboxImport("sb1", "mov_2"); err != nil || !deleted {
		t.Fatalf("its own cancel: deleted %v, %v", deleted, err)
	}
	if _, err := b.get("sb1"); err == nil || fileExists(filepath.Join(b.cfg.Root, "sandboxes", "sb1")) {
		t.Fatal("the cancelled move's sandbox is still there")
	}
}

// A publish waits for a prune's walk of what is in use (the base lock), so the image a sandbox being imported is over
// is seen in its import or in the sandbox, never in neither.
func TestPublishWaitsForAPrune(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	stoppedTestSandbox(t, a, "sb1", "old")
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); err != nil {
		t.Fatal(err)
	}
	parts := stageTestImport(t, a, b, "sb1", "mov_1")
	unlock := b.LockBases()
	done := make(chan error, 1)
	go func() { done <- b.PublishFetchedSandbox("sb1", "mov_1", parts) }()
	select {
	case err := <-done:
		unlock()
		t.Fatalf("published during a prune's walk (%v)", err)
	case <-time.After(100 * time.Millisecond):
	}
	in, err := BasesUnder(b.cfg.Root)
	unlock()
	if err != nil || !in["old"] {
		t.Fatalf("bases in use %v, %v", in, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// A sandbox made before sticky drives has none on the target either: the empty files fetched for them go.
func TestMovedSandboxWithoutStickyDrives(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	s := stoppedTestSandbox(t, a, "sb1", "old")
	s.meta.StickyDrives, s.meta.StickyDisks = 0, nil
	for k := range StickyDrives {
		_ = os.Remove(filepath.Join(s.vmDir(), stickyDriveFile(k)))
	}
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); err != nil {
		t.Fatal(err)
	}
	if err := importTestSandbox(t, a, b, "sb1", "mov_1"); err != nil {
		t.Fatal(err)
	}
	moved, _ := b.get("sb1")
	for k := range StickyDrives {
		if fileExists(filepath.Join(moved.vmDir(), stickyDriveFile(k))) {
			t.Fatalf("sticky drive %d's file came with it", k)
		}
	}
	if moved.meta.StickyDrives != 0 {
		t.Fatalf("its sticky drives: %d", moved.meta.StickyDrives)
	}
}

// An import whose record was read before a delete of the sandbox here is never made ready after it, so an import
// still under way as the sandbox is deleted doesn't bring it back; one read after is.
func TestADeleteFencesAnImportUnderWay(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	stoppedTestSandbox(t, a, "sb1", "old")
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); err != nil {
		t.Fatal(err)
	}
	record, _ := a.ReadSandboxFile("sb1", "mov_1", proto.SandboxRecordFile)
	since := b.ImportGeneration("sb1")
	if err := b.Delete(context.Background(), "sb1"); err == nil {
		t.Fatal("deleted a sandbox the host hasn't")
	}
	var pe *proto.Error
	if err := b.PrepareSandboxImport(context.Background(), "sb1", "mov_1", since, record); !errors.As(err, &pe) || pe.Code != proto.ErrConflict {
		t.Fatalf("made ready across a delete: %v", err)
	}
	if fileExists(filepath.Join(b.cfg.Root, sandboxImportsDir, "sb1")) {
		t.Fatal("the fenced import left its directory")
	}
	if err := b.PrepareSandboxImport(context.Background(), "sb1", "mov_1", b.ImportGeneration("sb1"), record); err != nil {
		t.Fatal(err)
	}
}

// A sandbox of the host's image takes its image version's guest report with it: the target may not have booted that
// version, so has no report of its own for it.
func TestAMovedSandboxKeepsItsGuestReport(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	stoppedTestSandbox(t, a, "sb1", "old")
	caps := &proto.GuestCapabilities{}
	a.keepGuest("old", caps)
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); err != nil {
		t.Fatal(err)
	}
	if err := importTestSandbox(t, a, b, "sb1", "mov_1"); err != nil {
		t.Fatal(err)
	}
	if info, err := b.ImportedSandbox("sb1", "mov_1"); err != nil || info.Guest == nil {
		t.Fatalf("its guest report on the target: %+v, %v", info.Guest, err)
	}
}
