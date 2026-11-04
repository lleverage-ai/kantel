package microvm

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

func TestCustomSizeNameRoundTrips(t *testing.T) {
	for _, shape := range [][3]int{{1, 128, 1}, {5, 8192, 60}, {32, 65536, 4096}} {
		name := CustomSizeName(shape[0], shape[1], shape[2])
		if !isCustom(name) {
			t.Fatalf("%s isn't custom", name)
		}
		vcpus, memoryMiB, diskGiB, ok := parseCustomSize(name)
		if !ok || vcpus != shape[0] || memoryMiB != shape[1] || diskGiB != shape[2] {
			t.Fatalf("parse(%s) = %d, %d, %d, %v", name, vcpus, memoryMiB, diskGiB, ok)
		}
	}
	if got := CustomSizeName(5, 8192, 60); got != "custom-5c-8192m-60g" {
		t.Fatalf("CustomSizeName = %s", got)
	}
	for _, name := range []string{"default", "custom-", "custom-1c-1024m", "custom-1c-1024m-10g-x", "custom-01c-1024m-10g", "custom-1c-1024m-10gb", "custom--1c-1024m-10g", "custom-+1c-1024m-10g", "custom-1g-1024m-10c", "custom-c-1024m-10g", "custom-1c-1024m-99999999999g"} {
		if _, _, _, ok := parseCustomSize(name); ok {
			t.Fatalf("parse(%q) took it", name)
		}
	}
}

func TestSizeResolvesNamedAndCustom(t *testing.T) {
	m := &Manager{cfg: Config{Sizes: DefaultSizes}}
	for _, want := range DefaultSizes {
		got, err := m.size(want.Name)
		if err != nil || got != want {
			t.Fatalf("size(%s) = %+v, %v", want.Name, got, err)
		}
	}
	if got, err := m.size(""); err != nil || got.Name != "default" {
		t.Fatalf("size(\"\") = %+v, %v", got, err)
	}
	name := CustomSizeName(1, 1024, 10)
	got, err := m.size(name)
	if err != nil {
		t.Fatal(err)
	}
	if want := (proto.Size{Name: name, VCPUs: 1, MemoryMiB: 1024, DiskGiB: 10}); got != want {
		t.Fatalf("size(%s) = %+v, want %+v", name, got, want)
	}
}

func TestSizeRefusesBadCustomShapes(t *testing.T) {
	m := &Manager{cfg: Config{Sizes: DefaultSizes}, hostMemoryMiB: 16384}
	for _, name := range []string{
		"custom-0c-1024m-10g",
		"custom-33c-1024m-10g",
		"custom-1c-64m-10g",
		"custom-1c-32768m-10g",
		"custom-1c-1024m-0g",
		"custom-1c-1024m-4097g",
		"custom-garbage",
		"huge",
	} {
		_, err := m.size(name)
		var perr *proto.Error
		if !errors.As(err, &perr) || perr.Code != proto.ErrInvalid {
			t.Fatalf("size(%q) = %v, want %s", name, err, proto.ErrInvalid)
		}
	}
}

// A create asking for part of a shape, or a shape the host can't give, is refused before anything is made.
func TestCreateRefusesABadCustomShape(t *testing.T) {
	m := &Manager{cfg: Config{Root: t.TempDir(), Sizes: DefaultSizes}, hostMemoryMiB: 16384}
	for _, p := range []proto.CreateParams{
		{SandboxID: "sbx_1", VCPUs: 2},
		{SandboxID: "sbx_1", VCPUs: 2, MemoryMiB: 2048},
		{SandboxID: "sbx_1", VCPUs: -1, MemoryMiB: 2048, DiskGiB: 20},
		{SandboxID: "sbx_1", VCPUs: 1, MemoryMiB: 64, DiskGiB: 20},
		{SandboxID: "sbx_1", VCPUs: 1, MemoryMiB: 2048, DiskGiB: 5000},
	} {
		_, err := m.Create(context.Background(), p)
		var perr *proto.Error
		if !errors.As(err, &perr) || perr.Code != proto.ErrInvalid {
			t.Fatalf("Create(%+v) = %v, want %s", p, err, proto.ErrInvalid)
		}
	}
}

func TestPoolsAreKeptForNamedSizesOnly(t *testing.T) {
	m := &Manager{log: slog.New(slog.NewTextHandler(io.Discard, nil)), pool: map[string][]*warm{}, poolWant: map[string]int{}, filling: map[string]bool{}}
	m.SetPools(map[string]int{CustomSizeName(2, 2048, 20): 2})
	if len(m.poolWant) != 0 || len(m.filling) != 0 {
		t.Fatalf("a custom size got a pool: want %v, filling %v", m.poolWant, m.filling)
	}
	if _, err := m.warmOne(context.Background(), CustomSizeName(2, 2048, 20)); err == nil {
		t.Fatal("warmOne made a warm sandbox of a custom size")
	}
	if _, _, err := m.template(context.Background(), proto.Size{Name: CustomSizeName(2, 2048, 20), VCPUs: 2, MemoryMiB: 2048, DiskGiB: 20}); err == nil {
		t.Fatal("template made one for a custom size")
	}
}

// A lower pool target ends the surplus idle VMs at once (their files go), keeping the oldest; 0 ends them all.
func TestSetPoolsEndsSurplusWarmVMs(t *testing.T) {
	root := t.TempDir()
	idle := func(name string) *warm {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		return &warm{dir: dir, size: "default"}
	}
	a, b, c, d := idle("a"), idle("b"), idle("c"), idle("d")
	m := &Manager{
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		pool:     map[string][]*warm{"default": {a, b, c}, "large": {d}},
		poolWant: map[string]int{"default": 3, "large": 1},
		filling:  map[string]bool{},
	}
	m.SetPools(map[string]int{"default": 1})
	if got := m.Warm(); got["default"] != 1 || got["large"] != 0 {
		t.Fatalf("Warm() = %v, want default 1 and large 0", got)
	}
	if m.pool["default"][0] != a {
		t.Fatal("the oldest warm VM wasn't the one kept")
	}
	for _, gone := range []*warm{b, c, d} {
		if _, err := os.Stat(gone.dir); !os.IsNotExist(err) {
			t.Fatalf("%s is still there: %v", gone.dir, err)
		}
	}
	m.SetPools(map[string]int{})
	if len(m.pool) != 0 {
		t.Fatalf("pools left after turning them off: %v", m.Warm())
	}
	if _, err := os.Stat(a.dir); !os.IsNotExist(err) {
		t.Fatal("the last warm VM's files are still there")
	}
}

// A fill that finishes after the target dropped is ended, not kept; one still wanted is kept.
func TestAFillLandingAfterADropIsEnded(t *testing.T) {
	root := t.TempDir()
	idle := func(name string) *warm {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		return &warm{dir: dir, size: "default"}
	}
	m := &Manager{
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		pool:     map[string][]*warm{"default": {idle("a")}},
		poolWant: map[string]int{"default": 1},
		filling:  map[string]bool{},
	}
	late := idle("late")
	if m.admit("default", late) {
		t.Fatal("a warm VM past the target was kept")
	}
	if _, err := os.Stat(late.dir); !os.IsNotExist(err) {
		t.Fatal("the late warm VM's files are still there")
	}
	m.mu.Lock()
	m.poolWant["default"] = 2
	m.mu.Unlock()
	wanted := idle("wanted")
	if !m.admit("default", wanted) || m.Warm()["default"] != 2 {
		t.Fatalf("a wanted warm VM wasn't kept: %v", m.Warm())
	}
}
