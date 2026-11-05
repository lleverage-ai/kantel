package isolate

import (
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// The sampler never waits on a sandbox mid-operation: Shared answers at once, naming it Held under the account it ran
// in, and leaves out a sandbox it never saw running.
func TestSharedDoesNotWaitOnAHeldSandbox(t *testing.T) {
	a := &sandbox{meta: meta{ID: "iso_a", Owner: "acct", State: proto.StateRunning}}
	b := &sandbox{meta: meta{ID: "iso_b", Owner: "acct", State: proto.StateRunning}}
	m := &Manager{sandboxes: map[string]*sandbox{"iso_a": a, "iso_b": b}}
	first := m.Shared()
	if len(first) != 1 || len(first[0].Sandboxes) != 2 || len(first[0].Held) != 0 {
		t.Fatalf("first: %+v", first)
	}
	// iso_b is mid-operation, and iso_c, new, too.
	b.mu.Lock()
	defer b.mu.Unlock()
	c := &sandbox{meta: meta{ID: "iso_c", Owner: "acct", State: proto.StateRunning}}
	c.mu.Lock()
	defer c.mu.Unlock()
	m.mu.Lock()
	m.sandboxes["iso_c"] = c
	m.mu.Unlock()
	done := make(chan struct{})
	go func() {
		m.Shared()
		close(done)
	}()
	select {
	case <-time.After(2 * time.Second):
		t.Fatal("Shared waited on a held sandbox")
	case <-done:
	}
	got := m.Shared()
	if len(got) != 1 || len(got[0].Sandboxes) != 1 || got[0].Sandboxes[0].SandboxID != "iso_a" {
		t.Fatalf("read: %+v", got)
	}
	if len(got[0].Held) != 1 || got[0].Held[0] != "iso_b" {
		t.Fatalf("held: %+v", got[0].Held)
	}
}
