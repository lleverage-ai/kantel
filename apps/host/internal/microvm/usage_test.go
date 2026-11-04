package microvm

import (
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// The sampler never waits on a sandbox mid-operation (a cold boot holds its lock for minutes): Processes answers at
// once, naming it Held.
func TestProcessesDoesNotWaitOnAHeldSandbox(t *testing.T) {
	s := &sandbox{meta: meta{ID: "sbx_1", State: proto.StateRunning}}
	m := &Manager{sandboxes: map[string]*sandbox{"sbx_1": s}}
	s.mu.Lock()
	defer s.mu.Unlock()
	done := make(chan []usage.Process, 1)
	go func() { done <- m.Processes() }()
	select {
	case <-time.After(2 * time.Second):
		t.Fatal("Processes waited on a held sandbox")
	case got := <-done:
		if len(got) != 1 || got[0].SandboxID != "sbx_1" || !got[0].Held || got[0].Pid != 0 {
			t.Fatalf("got %+v", got)
		}
	}
}
