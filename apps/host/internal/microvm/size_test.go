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

// Hosts keep no warm pool: the idle VMs an older host left in pool/ are ended and the directory is removed on start.
func TestNewClearsAnOldWarmPool(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "pool", "default-123", "vm")
	if err := os.MkdirAll(old, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(old, "disk.ext4"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	m, err := New(Config{Root: root, Sizes: DefaultSizes, SpoolMaxMiB: -1, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, err := os.Stat(filepath.Join(root, "pool")); !os.IsNotExist(err) {
		t.Fatalf("pool/ is still there: %v", err)
	}
}

// A custom shape boots with no template, so its report is kept in the root, by the image version it booted on: a host
// that restarts with no templates still says what each image has.
func TestACustomBootsReportOutlivesARestart(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root}}
	m.noteBootGuest("", &proto.GuestCapabilities{Arch: "aarch64"})
	m.noteBootGuest("host-images-20261104.812", &proto.GuestCapabilities{Arch: "x86_64"})

	again, err := New(Config{Root: root, Sizes: DefaultSizes, SpoolMaxMiB: -1, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if got := again.guestOf(""); got == nil || got.Arch != "aarch64" {
		t.Fatalf("after a restart with no templates the report is %+v, want the custom boot's", got)
	}
	if got := again.guestOf("host-images-20261104.812"); got == nil || got.Arch != "x86_64" {
		t.Fatalf("after a restart the versioned image's report is %+v, want the custom boot's on it", got)
	}
}
