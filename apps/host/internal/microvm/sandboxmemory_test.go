package microvm

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// fetchTestMemory moves version of a sandbox's memory from one host to another as sandbox.import does with Memory, but
// with the files copied rather than fetched: each part's partial written with the holder's bytes, then published with
// the machine's state.
func fetchTestMemory(t *testing.T, from, to *Manager, id, version string) error {
	t.Helper()
	parts := map[string]disksync.FetchedPart{}
	for _, part := range SandboxMemoryParts {
		src, raw, err := from.OpenSandboxMemoryPart(id, version, part, true)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(src.Name())
		src.Close()
		path, err := to.SandboxMemoryPartPartial(id, version, part)
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
	state, err := from.ReadSandboxMemoryFile(id, version, proto.SandboxStateFile)
	if err != nil {
		t.Fatal(err)
	}
	return to.PublishFetchedSandboxMemory(id, version, parts, map[string][]byte{proto.SandboxStateFile: state})
}

// A sandbox stopped keeping its memory moves with it: its export has its memory, its machine's state and its bundle
// drive's file as a second object's version, and the target makes it a sandbox stopped with that memory, the runtime
// it is of and its bundle drive as its guest has it mounted, so its start restores it.
func TestASandboxMovesWithItsMemory(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	s := stoppedTestSandbox(t, a, "sb1", "old")
	info, err := a.SandboxMemory("sb1")
	if err != nil {
		t.Fatal(err)
	}
	if !info.Memory || info.Runtime != s.meta.Runtime || info.Bytes <= 0 || info.Refused != "" {
		t.Fatalf("sandbox.memory = %+v", info)
	}
	exported, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1", Memory: true})
	if err != nil {
		t.Fatal(err)
	}
	if exported.MemoryMapDigest == "" || exported.MemoryMapDigest == exported.MapDigest || !a.HoldsSandboxMemory("sb1", "mov_1") {
		t.Fatalf("export = %+v", exported)
	}
	// Asked again, it answers what it made.
	again, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1", Memory: true})
	if err != nil || again.MemoryMapDigest != exported.MemoryMapDigest {
		t.Fatalf("again = %+v, %v", again, err)
	}
	record, err := a.ReadSandboxFile("sb1", "mov_1", proto.SandboxRecordFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.PrepareSandboxImport(context.Background(), "sb1", "mov_1", 0, record, ImportOptions{Memory: true}); err != nil {
		t.Fatal(err)
	}
	// The disk alone isn't published: its memory comes first.
	if _, err := b.SandboxMemoryPartPartial("sb1", "mov_1", "bundle9"); err == nil {
		t.Fatal("a part a memory hasn't was given a partial")
	}
	if err := fetchTestMemory(t, a, b, "sb1", "mov_1"); err != nil {
		t.Fatal(err)
	}
	if !b.HoldsSandboxMemory("sb1", "mov_1") || b.HoldsSandbox("sb1", "mov_1") {
		t.Fatal("the memory isn't held alone once fetched")
	}
	if err := importTestSandboxWith(t, a, b, "sb1", "mov_1", ImportOptions{Memory: true}); err != nil {
		t.Fatal(err)
	}
	moved, err := b.get("sb1")
	if err != nil {
		t.Fatal(err)
	}
	vm := moved.vmDir()
	for name, want := range map[string]string{"mem": "its memory", "state": "its machine", bundleDriveFile(0): "a bundle's image"} {
		got, err := os.ReadFile(filepath.Join(vm, name))
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v", name, got, err)
		}
	}
	if !moved.meta.Memory || moved.meta.Runtime != s.meta.Runtime || len(moved.meta.BundleSlots) != 1 || moved.meta.BundleSlots[0] != "sha256:bundle" {
		t.Fatalf("moved meta = %+v", moved.meta)
	}
	if moved.meta.Egress == nil || moved.meta.Egress.CACert != "" || moved.meta.Imported != "mov_1" {
		t.Fatalf("moved meta = %+v", moved.meta)
	}
	if _, err := os.Stat(filepath.Join(b.cfg.Root, sandboxImportsDir, "sb1")); !os.IsNotExist(err) {
		t.Fatalf("its import is left: %v", err)
	}
	if !b.HoldsSandboxMemory("sb1", "mov_1") {
		t.Fatal("the sandbox the version made doesn't hold its memory")
	}
	// The source's export goes, memory and all.
	if err := a.DeleteSandboxExport("sb1", "mov_1"); err != nil || a.HoldsSandboxMemory("sb1", "mov_1") {
		t.Fatalf("export delete: %v", err)
	}
}

// An import asked with its memory is never made a sandbox without it, and a sandbox stopped without memory, or with
// more bundle drives than a memory's parts, isn't exported with it.
func TestAMemoryMoveRefusals(t *testing.T) {
	a, b := moveHost(t), moveHost(t)
	stoppedTestSandbox(t, a, "sb1", "old")
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1", Memory: true}); err != nil {
		t.Fatal(err)
	}
	if err := importTestSandboxWith(t, a, b, "sb1", "mov_1", ImportOptions{Memory: true}); err == nil {
		t.Fatal("published without its memory")
	}
	if _, err := b.get("sb1"); err == nil {
		t.Fatal("a sandbox was made without its memory")
	}
	if _, err := a.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_2", Memory: true, Live: true}); !isCode(err, proto.ErrInvalid) {
		t.Fatalf("a live export with memory: %v", err)
	}

	c := moveHost(t)
	s := stoppedTestSandbox(t, c, "sb2", "old")
	s.meta.Memory = false
	if _, err := c.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb2", Version: "mov_1", Memory: true}); !isCode(err, proto.ErrConflict) {
		t.Fatalf("an export of no memory: %v", err)
	}
	if info, _ := c.SandboxMemory("sb2"); info.Memory || info.Runtime != "" {
		t.Fatalf("sandbox.memory of no memory = %+v", info)
	}
	s.meta.Memory = true
	s.meta.BundleDrives = proto.SandboxMemoryBundles + 1
	if info, _ := c.SandboxMemory("sb2"); info.Refused == "" {
		t.Fatalf("sandbox.memory of too many bundle drives = %+v", info)
	}
	if _, err := c.ExportSandbox(context.Background(), proto.SandboxExportParams{SandboxID: "sb2", Version: "mov_2", Memory: true}); !isCode(err, proto.ErrConflict) {
		t.Fatalf("an export of too many bundle drives: %v", err)
	}
}

// isCode says whether err is a proto.Error of code.
func isCode(err error, code string) bool {
	var pe *proto.Error
	return errors.As(err, &pe) && pe.Code == code
}
