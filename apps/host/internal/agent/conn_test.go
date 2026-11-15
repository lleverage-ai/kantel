package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// The control plane's refusals of a host's credential stop the daemon; any other close is retried.
func TestRevokedClose(t *testing.T) {
	for code, want := range map[websocket.StatusCode]bool{
		4003:                            true, // the gateway's own close for a wrong or revoked credential
		4401:                            true, // an upgrade refused as 401
		4403:                            true, // an upgrade refused as 403
		4404:                            false,
		4502:                            false,
		websocket.StatusGoingAway:       false,
		websocket.StatusInternalError:   false,
		websocket.StatusNormalClosure:   false,
		websocket.StatusPolicyViolation: false,
	} {
		err := fmt.Errorf("read: %w", websocket.CloseError{Code: code, Reason: "why"})
		if _, got := revokedClose(err); got != want {
			t.Errorf("close %d: revoked %v, want %v", code, got, want)
		}
	}
	if _, got := revokedClose(errors.New("connection reset")); got {
		t.Error("a dropped connection isn't a revocation")
	}
}

// Gateway-driven updates (a welcome's version and host.update) stage the same file, so they run one at a time, and one
// that fails lets the next go ahead.
func TestGatewayUpdatesRunOneAtATime(t *testing.T) {
	h := &Host{}
	var running, most atomic.Int32
	update := func(ctx context.Context, p proto.UpdateParams) error {
		now := running.Add(1)
		defer running.Add(-1)
		for {
			seen := most.Load()
			if now <= seen || most.CompareAndSwap(seen, now) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		if p.Version == "bad" {
			return errors.New("the download didn't check out")
		}
		return nil
	}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := range 8 {
		version := "1.2.3"
		if i%2 == 0 {
			version = "bad"
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- h.gatewayUpdate(context.Background(), proto.UpdateParams{Version: version}, update)
		}()
	}
	wg.Wait()
	close(errs)
	failed := 0
	for err := range errs {
		if err != nil {
			failed++
		}
	}
	if most.Load() != 1 {
		t.Fatalf("%d updates ran at once, want 1", most.Load())
	}
	if failed != 4 {
		t.Fatalf("%d updates failed, want 4: a failed one must still let the others run", failed)
	}
}

// A start's error once its tier let go of the sandbox's memory is sent with memoryDropped (FeatureStartMemoryDropped,
// which a host with the microVM tier reports); any other error is sent as before, without it.
func TestAStartsErrorSaysItsMemoryWentOnlyWhenItDid(t *testing.T) {
	refused := &proto.Error{Code: proto.ErrCapacity, Message: "no room"}
	for name, c := range map[string]struct {
		err  error
		want proto.Error
	}{
		"its memory gone":            {&proto.MemoryDroppedError{Err: fmt.Errorf("boot: %w", refused)}, proto.Error{Code: proto.ErrCapacity, Message: "no room", MemoryDropped: true}},
		"a plain error, memory gone": {&proto.MemoryDroppedError{Err: errors.New("no free sandbox addresses")}, proto.Error{Code: proto.ErrInternal, Message: "no free sandbox addresses", MemoryDropped: true}},
		"its memory kept":            {refused, proto.Error{Code: proto.ErrCapacity, Message: "no room"}},
	} {
		got := toError(c.err)
		if *got != c.want {
			t.Fatalf("%s: %+v, want %+v", name, *got, c.want)
		}
		raw, _ := json.Marshal(got)
		if strings.Contains(string(raw), "memoryDropped") != c.want.MemoryDropped {
			t.Fatalf("%s: sent %s", name, raw)
		}
	}
	// The tier's own error is left as it was.
	if refused.MemoryDropped {
		t.Fatal("the tier's error was changed")
	}
	h := newLifecycleHost(t, newLifecycleTier())
	if !slices.Contains(h.makeFacts().Features, proto.FeatureStartMemoryDropped) {
		t.Fatalf("a microVM host doesn't report %s: %v", proto.FeatureStartMemoryDropped, h.makeFacts().Features)
	}
	delete(h.tiers, microvm.Tier)
	h.order = nil
	if slices.Contains(h.makeFacts().Features, proto.FeatureStartMemoryDropped) {
		t.Fatal("a host without the microVM tier reports it")
	}
}
