package isolate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// An isolate asks for 128 to 512 MiB in steps of 64, or nothing (the default); anything else is refused before
// anything is made.
func TestCreateRefusesAnIsolateMemoryOffTheSteps(t *testing.T) {
	for _, memoryMiB := range []int{0, 128, 256, 448, 512} {
		if !validMemory(memoryMiB) {
			t.Fatalf("%d MiB refused", memoryMiB)
		}
	}
	m := &Manager{cfg: Config{Root: t.TempDir()}}
	for _, memoryMiB := range []int{-64, 64, 100, 200, 576, 1024} {
		_, err := m.Create(context.Background(), proto.CreateParams{SandboxID: "sbx_1", MemoryMiB: memoryMiB})
		var perr *proto.Error
		if !errors.As(err, &perr) || perr.Code != proto.ErrInvalid {
			t.Fatalf("Create with %d MiB = %v, want %s", memoryMiB, err, proto.ErrInvalid)
		}
	}
}

// A lower spare target ends the surplus spare runtimes at once; account runtimes stay.
func TestSetPoolsEndsSurplusSpares(t *testing.T) {
	root := t.TempDir()
	spare := func(name string) *runtime {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		return &runtime{dir: dir}
	}
	a, b, owned := spare("a"), spare("b"), spare("owned")
	m := &Manager{spare: []*runtime{a, b}, spareWant: 2, runtimes: map[string]*runtime{"acct": owned}}
	m.closed.Store(true) // no filler: this checks only what is ended
	m.SetPools(map[string]int{"default": 1})
	if got := m.Warm()["default"]; got != 1 {
		t.Fatalf("%d spares, want 1", got)
	}
	if _, err := os.Stat(b.dir); !os.IsNotExist(err) {
		t.Fatal("the surplus spare's files are still there")
	}
	m.SetPools(map[string]int{})
	if got := m.Warm()["default"]; got != 0 {
		t.Fatalf("%d spares, want 0", got)
	}
	if _, err := os.Stat(owned.dir); err != nil {
		t.Fatalf("an account's runtime was ended: %v", err)
	}
}
