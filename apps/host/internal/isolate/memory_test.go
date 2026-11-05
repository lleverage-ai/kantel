package isolate

import (
	"context"
	"errors"
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
