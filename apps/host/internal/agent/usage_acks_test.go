package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// usageHub is a control plane for kantel-host's whole link (Run): it welcomes each connection, with UsageAcks or
// without, and hands each one to the test's script, one function per connection in turn.
type usageHub struct {
	t     *testing.T
	acks  bool
	mu    sync.Mutex
	conns int
	// script[n] plays connection n; past the last, a connection is held until the test ends.
	script []func(next func() (proto.UsageSample, bool), ack func(uint64), drop func())
}

func (u *usageHub) serve(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx := r.Context()
	if _, _, err := c.Read(ctx); err != nil { // the hello
		return
	}
	welcome, _ := json.Marshal(proto.Message{Type: "welcome", Welcome: &proto.Welcome{HostID: "host_a", HeartbeatSeconds: 60, UsageAcks: u.acks}})
	if c.Write(ctx, websocket.MessageText, welcome) != nil {
		return
	}
	u.mu.Lock()
	n := u.conns
	u.conns++
	u.mu.Unlock()
	if n >= len(u.script) {
		<-ctx.Done()
		return
	}
	next := func() (proto.UsageSample, bool) {
		for {
			_, raw, err := c.Read(ctx)
			if err != nil {
				return proto.UsageSample{}, false
			}
			var m proto.Message
			if json.Unmarshal(raw, &m) == nil && m.Type == "usage" && m.Usage != nil {
				return *m.Usage, true
			}
		}
	}
	ack := func(seq uint64) {
		raw, _ := json.Marshal(proto.Message{Type: "usage.ack", Acked: int64(seq)})
		_ = c.Write(ctx, websocket.MessageText, raw)
	}
	// drop ends the connection abruptly, with no close frame: what the host wrote into it and the hub didn't take is
	// lost with it, as with a reset or a stall the gateway gave up on.
	drop := func() { c.CloseNow() }
	u.script[n](next, ack, drop)
}

// queuedUsage is the Seq of each tick in h's backlog.
func queuedUsage(h *Host) []uint64 {
	h.mu.Lock()
	s := h.usage
	h.mu.Unlock()
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return seqs(s.queue)
}

// runUsageHost runs a host with 1-second ticks against hub until the test ends.
func runUsageHost(t *testing.T, hub *usageHub) *Host {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(hub.serve))
	t.Cleanup(srv.Close)
	h := newLifecycleHost(t, newLifecycleTier())
	// No tier: the host's own readings are the ticks.
	h.tiers, h.order = map[string]Tier{}, nil
	h.cfg.ControlPlane, h.cfg.Credential, h.cfg.HostID, h.cfg.UsageIntervalSeconds = srv.URL, "khc_test", "host_a", 1
	h.version = "test"
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = h.Run(ctx, nil)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return h
}

// A hub with acks: the ticks the first connection carried and the hub never took (it died under them) come again on
// the next, in order and before the newer ones, so the hub has every tick of the run once, from 1, with no gap.
func TestUsageTicksLostWithAConnectionComeAgainOnTheNext(t *testing.T) {
	stored, carried := make(chan []uint64, 1), make(chan []uint64, 1)
	hub := &usageHub{t: t, acks: true}
	hub.script = []func(func() (proto.UsageSample, bool), func(uint64), func()){
		func(next func() (proto.UsageSample, bool), _ func(uint64), drop func()) {
			// Read and never taken: these are the ticks a dying connection loses.
			var lost []uint64
			for len(lost) < 3 {
				u, ok := next()
				if !ok {
					return
				}
				lost = append(lost, u.Seq)
			}
			carried <- lost
			drop()
		},
		func(next func() (proto.UsageSample, bool), ack func(uint64), _ func()) {
			var got []uint64
			for len(got) < 6 {
				u, ok := next()
				if !ok {
					return
				}
				got = append(got, u.Seq)
				ack(u.Seq)
			}
			stored <- got
		},
	}
	h := runUsageHost(t, hub)
	select {
	case got := <-stored:
		if lost := <-carried; !slices.Equal(lost, []uint64{1, 2, 3}) {
			t.Fatalf("the first connection carried %v", lost)
		}
		if !slices.Equal(got, []uint64{1, 2, 3, 4, 5, 6}) {
			t.Fatalf("the hub took %v, want 1 to 6: the lost ones again, then on", got)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the second connection never had six ticks")
	}
	// Acked, they leave the backlog.
	deadline := time.Now().Add(5 * time.Second)
	for {
		queue := queuedUsage(h)
		first := uint64(0)
		if len(queue) > 0 {
			first = queue[0]
		}
		if first == 0 || first > 6 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("tick %d still queued after its ack", first)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A hub from before acks (no UsageAcks in its welcome): a tick is done with once written, as before, so what a dying
// connection carried isn't sent again, and the backlog doesn't grow waiting for acks.
func TestUsageWithAHubWithoutAcksTicksAreSentOnce(t *testing.T) {
	second := make(chan []uint64, 1)
	hub := &usageHub{t: t, acks: false}
	hub.script = []func(func() (proto.UsageSample, bool), func(uint64), func()){
		func(next func() (proto.UsageSample, bool), _ func(uint64), drop func()) {
			var first []uint64
			for len(first) < 3 {
				u, ok := next()
				if !ok {
					return
				}
				first = append(first, u.Seq)
			}
			drop()
		},
		func(next func() (proto.UsageSample, bool), _ func(uint64), _ func()) {
			var got []uint64
			for len(got) < 3 {
				u, ok := next()
				if !ok {
					return
				}
				got = append(got, u.Seq)
			}
			second <- got
		},
	}
	h := runUsageHost(t, hub)
	select {
	case got := <-second:
		if got[0] <= 3 || !slices.IsSorted(got) {
			t.Fatalf("the second connection had %v after 1 to 3: sent again", got)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the second connection never had three ticks")
	}
	if queued := len(queuedUsage(h)); queued > 1 {
		t.Fatalf("%d ticks queued with no acks to wait for", queued)
	}
}
