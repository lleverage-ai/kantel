package microvm

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/memplan"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// With memory over-commit on, admission asks AdmitMemory with what the tier holds (running and starting sandboxes,
// resumes, builds in full), not the budget's memory; the disk is still the budget's.
func TestAdmitMemoryByUse(t *testing.T) {
	m, _ := testManager(t)
	m.sandboxes = map[string]*sandbox{
		"sbx_run":     {meta: meta{ID: "sbx_run", Size: "default", State: proto.StateRunning}},
		"sbx_stopped": {meta: meta{ID: "sbx_stopped", Size: "large", State: proto.StateStopped}},
	}
	m.resuming = map[string]proto.Size{"sbx_res": {MemoryMiB: 1024}}
	m.builds = map[string]proto.Size{"tsn_a": {MemoryMiB: 2048}}
	// A budget with no memory at all: by reservation nothing fits.
	m.cfg.Budget = func() (int64, int64) { return 0, 80 }
	var asked memplan.VM
	var held []memplan.VM
	m.cfg.AdmitMemory = func(vm memplan.VM, h []memplan.VM) error {
		asked, held = vm, h
		return nil
	}
	m.mu.Lock()
	err := m.admit(proto.Size{MemoryMiB: 4096, DiskGiB: 10}, "sandbox", memplan.VM{ID: "sbx_new", SizeMiB: 4096})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if asked.ID != "sbx_new" || asked.SizeMiB != 4096 {
		t.Fatalf("asked %+v", asked)
	}
	byID := map[string]memplan.VM{}
	var builds int
	for _, vm := range held {
		if vm.Full {
			builds++
			continue
		}
		byID[vm.ID] = vm
	}
	defaultSize, _ := m.size("default")
	if len(held) != 3 || builds != 1 || byID["sbx_run"].SizeMiB != int64(defaultSize.MemoryMiB) || byID["sbx_res"].SizeMiB != 1024 {
		t.Fatalf("held %+v", held)
	}
	// AdmitMemory's refusal is a capacity error with its reason.
	m.cfg.AdmitMemory = func(memplan.VM, []memplan.VM) error { return errors.New("this host is short of memory now") }
	m.mu.Lock()
	err = m.admit(proto.Size{MemoryMiB: 4096, DiskGiB: 10}, "sandbox", memplan.VM{ID: "sbx_new", SizeMiB: 4096})
	m.mu.Unlock()
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.ErrCapacity || !strings.Contains(pe.Message, "short of memory") {
		t.Fatalf("got %v", err)
	}
	// The disk is still admitted by the budget.
	m.cfg.AdmitMemory = func(memplan.VM, []memplan.VM) error { return nil }
	m.mu.Lock()
	err = m.admit(proto.Size{MemoryMiB: 1, DiskGiB: 81}, "sandbox", memplan.VM{ID: "sbx_new", SizeMiB: 1})
	m.mu.Unlock()
	if !errors.As(err, &pe) || pe.Code != proto.ErrCapacity || !strings.Contains(pe.Message, "disk") {
		t.Fatalf("got %v", err)
	}
}

// Free page reporting goes in every boot's balloon when on, and in the templates' fingerprint, so a template made
// without it (whose snapshot's balloon never reports) is made again.
func TestFreePageReportingBootAndFingerprint(t *testing.T) {
	off, on := &Manager{}, &Manager{cfg: Config{FreePageReporting: true}}
	if off.bootConfig(shape{}, "vmlinux", "", "", 3, 0, 0).FreePageReporting || !on.bootConfig(shape{}, "vmlinux", "", "", 3, 0, 0).FreePageReporting {
		t.Fatal("boot config")
	}
	if strings.Contains(off.templateFingerprint(shape{}), "free-page-reporting") || !strings.Contains(on.templateFingerprint(shape{}), ",free-page-reporting") {
		t.Fatalf("fingerprints %q, %q", off.templateFingerprint(shape{}), on.templateFingerprint(shape{}))
	}
	// The user templates' runtime too: a snapshot made with reporting off isn't restored once it is on (it is booted
	// afresh, with a reporting balloon), nor one made with it on once it is off; with it off, as before.
	for _, rootfs := range []string{"", "/images/templates/key.ext4"} {
		madeOff, madeOn := off.runtimeFingerprint(rootfs), on.runtimeFingerprint(rootfs)
		if madeOff == madeOn || strings.Contains(madeOff, "free-page-reporting") || !strings.HasSuffix(madeOn, "+free-page-reporting") {
			t.Fatalf("runtimes for %q: %q, %q", rootfs, madeOff, madeOn)
		}
	}
}

// A user template's snapshot made before free page reporting was turned on fails the restore check, and the create
// boots afresh; one made with it restores.
func TestTemplateSnapshotNeedsTheReportingBalloon(t *testing.T) {
	m, _ := testManager(t)
	size := proto.Size{VCPUs: 2, MemoryMiB: 2048, DiskGiB: 10}
	write := func(id, runtime string) {
		t.Helper()
		dir := m.templateSnapshotDir(id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		meta := templateSnapshotMeta{SnapshotID: id, Rootfs: m.cfg.Rootfs, Runtime: runtime, VCPUs: 2, MemoryMiB: 2048, DiskGiB: 10}
		raw, err := json.Marshal(meta)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("tsn_before", m.runtimeFingerprint(m.cfg.Rootfs))
	m.cfg.FreePageReporting = true
	write("tsn_after", m.runtimeFingerprint(m.cfg.Rootfs))
	if _, err := m.restorableTemplateSnapshot("tsn_before", size); err == nil || !strings.Contains(err.Error(), "balloon") {
		t.Fatalf("a snapshot without the reporting balloon: %v", err)
	}
	if _, err := m.restorableTemplateSnapshot("tsn_after", size); err != nil && strings.Contains(err.Error(), "balloon") {
		t.Fatalf("a snapshot with it: %v", err)
	}
}
