package microvm

import (
	"reflect"
	"testing"

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
