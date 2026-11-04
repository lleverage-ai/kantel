package microvm

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func TestSharedShapeOff(t *testing.T) {
	if c := sharedShape(Config{Sizes: DefaultSizes}, 0, 8); c != nil {
		t.Fatalf("shared templates are off unless the config says, got %+v", c)
	}
	var c *sharedConfig
	if _, ok := c.fits(DefaultSizes[0]); ok {
		t.Fatal("no shared config fits nothing")
	}
}

func TestSharedShapeFromSizes(t *testing.T) {
	c := sharedShape(Config{SharedTemplate: true, Sizes: DefaultSizes}, 64*1024, 16)
	// As many vCPUs as the machine has, the smallest named disk.
	if c.maxVCPUs != 16 || c.diskGiB != 10 {
		t.Fatalf("shape %+v", c)
	}
	// The default size's count first, then the rest of the named sizes', smallest first.
	if want := []int{4, 1}; !reflect.DeepEqual(c.first, want) {
		t.Fatalf("first %v, want %v", c.first, want)
	}
	// Every named size fits its count's template, with no memory to plug where it has its count's least.
	for _, s := range DefaultSizes {
		sh, ok := c.fits(s)
		if !ok {
			t.Errorf("%s doesn't fit", s.Name)
		}
		if s.Name == "default" && sh.MemoryMiB != s.MemoryMiB {
			t.Errorf("default boots its template with %d MiB, want its own %d", sh.MemoryMiB, s.MemoryMiB)
		}
	}
	// A count boots with 512 MiB a vCPU (at least 1 GiB) and grows to 8 GiB a vCPU, within the machine's memory.
	for _, tc := range []struct {
		vcpus, base, top int
	}{
		{1, 1024, 8192},
		{2, 1024, 16384},
		{3, 1536, 24576},
		{4, 2048, 32768},
		{16, 8192, 64 * 1024},
	} {
		sh := c.shape(tc.vcpus)
		if sh.VCPUs != tc.vcpus || sh.MemoryMiB != tc.base || sh.MemoryMiB+sh.HotplugMiB != tc.top || sh.DiskGiB != 10 {
			t.Errorf("shape(%d) %+v, want %d MiB growing to %d", tc.vcpus, sh, tc.base, tc.top)
		}
	}
	if sh := c.shape(2); sh.Name != "shared-2vcpu" {
		t.Errorf("shape(2) named %q", sh.Name)
	}
	// Custom shapes, as the control plane gives them.
	for _, s := range []proto.Size{
		{Name: "custom-2c-3072m-20g", VCPUs: 2, MemoryMiB: 3072, DiskGiB: 20},
		{Name: "custom-3c-2048m-20g", VCPUs: 3, MemoryMiB: 2048, DiskGiB: 20},
		{Name: "custom-8c-65536m-80g", VCPUs: 8, MemoryMiB: 65536, DiskGiB: 80},
	} {
		if _, ok := c.fits(s); !ok {
			t.Errorf("%s doesn't fit", s.Name)
		}
	}
	for _, s := range []proto.Size{
		{Name: "more-vcpus", VCPUs: 17, MemoryMiB: 16384, DiskGiB: 20},
		{Name: "more-memory", VCPUs: 2, MemoryMiB: 16384 + 512, DiskGiB: 20},
		{Name: "less-memory", VCPUs: 1, MemoryMiB: 512, DiskGiB: 10},
		{Name: "smaller-disk", VCPUs: 2, MemoryMiB: 2048, DiskGiB: 5},
	} {
		if _, ok := c.fits(s); ok {
			t.Errorf("%s fits", s.Name)
		}
	}
}

func TestSharedShapeSizesWiden(t *testing.T) {
	// A named size with less memory than its count would boot with lowers it; one with more than it grows to raises
	// it; one with more vCPUs than the machine raises the most.
	c := sharedShape(Config{SharedTemplate: true, Sizes: []proto.Size{
		{Name: "tiny", VCPUs: 2, MemoryMiB: 768, DiskGiB: 8},
		{Name: "huge", VCPUs: 2, MemoryMiB: 20480, DiskGiB: 40},
		{Name: "wide", VCPUs: 6, MemoryMiB: 4096, DiskGiB: 40},
	}}, 0, 4)
	if c.maxVCPUs != 6 || c.diskGiB != 8 {
		t.Fatalf("shape %+v", c)
	}
	sh := c.shape(2)
	if sh.MemoryMiB != 768 || sh.MemoryMiB+sh.HotplugMiB < 20480 {
		t.Fatalf("shape(2) %+v", sh)
	}
	for _, s := range c.sizes {
		if _, ok := c.fits(s); !ok {
			t.Errorf("%s doesn't fit", s.Name)
		}
	}
}

func TestSharedShapeOverrides(t *testing.T) {
	c := sharedShape(Config{SharedTemplate: true, Sizes: DefaultSizes, TemplateVCPUs: 4, TemplateMemoryMiB: 1000, TemplateMaxMemoryMiB: 1100, TemplateDiskGiB: 20}, 0, 64)
	sh := c.shape(3)
	// The hotpluggable memory is a whole number of Firecracker's slots, and never none.
	if c.maxVCPUs != 4 || sh.MemoryMiB != 1000 || sh.HotplugMiB != 128 || sh.DiskGiB != 20 {
		t.Fatalf("shape %+v / %+v", c, sh)
	}
	if _, ok := c.fits(proto.Size{VCPUs: 1, MemoryMiB: 1024, DiskGiB: 10}); ok {
		t.Error("a disk smaller than the template's fits")
	}
}

// Once a shared template is ready the named sizes' templates are only disk: they go, the shared ones stay.
func TestDropSizeTemplates(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"default", "large", "small.building", "shared-4vcpu"} {
		if err := os.MkdirAll(filepath.Join(root, "templates", dir), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "templates", dir, "mem"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m, err := New(Config{Root: root, Sizes: DefaultSizes, SpoolMaxMiB: -1, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.dropSizeTemplates()
	entries, err := os.ReadDir(filepath.Join(root, "templates"))
	if err != nil {
		t.Fatal(err)
	}
	var left []string
	for _, e := range entries {
		left = append(left, e.Name())
	}
	if !reflect.DeepEqual(left, []string{"shared-4vcpu"}) {
		t.Fatalf("templates left %v, want only shared-4vcpu", left)
	}
}

type fakeDrive struct{ rescans int }

func (d *fakeDrive) RescanDrive(context.Context, string, string) error { d.rescans++; return nil }

type fakeDiskGuest struct{ asked []int64 }

func (g *fakeDiskGuest) GrowDisk(_ context.Context, bytes int64) error {
	g.asked = append(g.asked, bytes)
	return nil
}

func (g *fakeDiskGuest) Exec(context.Context, guest.ExecRequest) (guest.ExecResult, error) {
	return guest.ExecResult{}, errors.New("not called with a current agent")
}

// growDisk grows the file, always tells the VM and asks the guest to wait for the size it made; it never shrinks a
// larger disk (a cold snapshot of a larger size), and asking again changes nothing.
func TestGrowDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "disk.ext4")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(path, 4<<30); err != nil {
		t.Fatal(err)
	}
	drive, client := &fakeDrive{}, &fakeDiskGuest{}
	for range 2 {
		if err := growDisk(context.Background(), drive, client, path, 12<<30); err != nil {
			t.Fatal(err)
		}
	}
	info, _ := os.Stat(path)
	if info.Size() != 12<<30 {
		t.Fatalf("disk is %d bytes, want 12 GiB", info.Size())
	}
	if err := growDisk(context.Background(), drive, client, path, 2<<30); err != nil {
		t.Fatal(err)
	}
	info, _ = os.Stat(path)
	if info.Size() != 12<<30 {
		t.Fatalf("a smaller size shrank the disk to %d bytes", info.Size())
	}
	if want := []int64{12 << 30, 12 << 30, 12 << 30}; !reflect.DeepEqual(client.asked, want) {
		t.Fatalf("the guest was asked to wait for %v, want %v", client.asked, want)
	}
	if drive.rescans != 3 {
		t.Fatalf("%d rescans, want one a call (a restored VM's device has its snapshot's capacity)", drive.rescans)
	}
}

// The tier's own template builds (a shared template's, a rebuild on new images) hold the memory and disk their machine
// boots with against the host's budget until they end, as a control plane's builds do, without being named to it.
func TestOwnBuildsHoldTheBudget(t *testing.T) {
	m, _ := testManager(t)
	m.sandboxes = map[string]*sandbox{"sbx_run": {meta: meta{ID: "sbx_run", Size: "default", State: proto.StateRunning}}}
	m.cfg.Budget = func() (int64, int64) { return 8192, 80 }
	refused := func(err error) {
		t.Helper()
		var pe *proto.Error
		if !errors.As(err, &pe) || pe.Code != proto.ErrCapacity {
			t.Fatalf("got %v, want %s", err, proto.ErrCapacity)
		}
	}
	release, err := m.holdOwnBuild(shape{Size: proto.Size{Name: "shared-4vcpu", VCPUs: 4, MemoryMiB: 2048, DiskGiB: 20}, HotplugMiB: 30720})
	if err != nil {
		t.Fatal(err)
	}
	// Its boot memory and disk, not its hotplug range; counted, not named.
	if ids, memory, disk := m.TemplateBuilds(); len(ids) != 0 || memory != 2048 || disk != 20 {
		t.Fatalf("builds %v %d MiB %d GiB", ids, memory, disk)
	}
	// 4096 MiB and 60 GiB are left beside the running sandbox and the build: not a large create, nor a control plane's
	// build whose disk is more; another of the tier's builds of 4096 MiB is, and then nothing else.
	refused(m.register(&sandbox{meta: meta{ID: "sbx_big", Size: "large", State: proto.StateStarting}}, DefaultSizes[2]))
	_, err = m.holdBuild("tsn_a", proto.Size{VCPUs: 2, MemoryMiB: 1024, DiskGiB: 61})
	refused(err)
	another, err := m.holdOwnBuild(shape{Size: proto.Size{Name: "shared-2vcpu", VCPUs: 2, MemoryMiB: 4096, DiskGiB: 20}})
	if err != nil {
		t.Fatal(err)
	}
	refused(m.register(&sandbox{meta: meta{ID: "sbx_new", Size: "small", State: proto.StateStarting}}, DefaultSizes[0]))
	_, err = m.holdOwnBuild(shape{Size: proto.Size{Name: "shared-1vcpu", VCPUs: 1, MemoryMiB: 512, DiskGiB: 10}})
	refused(err)
	// Ended (failed, cancelled or done alike: their builders release them once the machine has gone): free again.
	release()
	another()
	if ids, memory, disk := m.TemplateBuilds(); len(ids) != 0 || memory != 0 || disk != 0 {
		t.Fatalf("builds after release %v %d %d", ids, memory, disk)
	}
	if err := m.register(&sandbox{meta: meta{ID: "sbx_new", Size: "default", State: proto.StateStarting}}, DefaultSizes[1]); err != nil {
		t.Fatal(err)
	}
}

// A shared template with no room on the host isn't built (and isn't recorded as failed): its count waits a little,
// cold-booting meanwhile, and tries again.
func TestSharedTemplateWaitsForRoom(t *testing.T) {
	m, _ := testManager(t)
	m.cfg.SharedTemplate = true
	m.shared = sharedShape(m.cfg, 0, 8)
	m.preparing, m.sharedFailed = map[int]bool{}, map[int]time.Time{}
	m.cfg.Budget = func() (int64, int64) { return 512, 80 }
	m.prepareShape(4)
	m.builders.Wait()
	if !m.sharedFailed[4].IsZero() {
		t.Fatal("a build was tried with no room for it")
	}
	if !m.sharedDeferred[4].After(time.Now()) || m.preparing[4] {
		t.Fatalf("deferred until %v, preparing %v", m.sharedDeferred[4], m.preparing[4])
	}
	if _, memory, disk := m.TemplateBuilds(); memory != 0 || disk != 0 {
		t.Fatalf("held %d MiB %d GiB", memory, disk)
	}
}
