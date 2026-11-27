package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// --- Git signing ----------------------------------------------------------------------------------------------------

// signingSetter is a tier whose sandboxes' Git is signed on the host (the microVM tier).
type signingSetter interface {
	SetSigning(ctx context.Context, id string, cfg *proto.GitSigning) error
}

// fetchSigning is the signing.Store's fetch: signing.fetch to Kantel. Its errors never quote the answer, which holds
// the private key.
func (h *Host) fetchSigning(ctx context.Context, sandboxID string) (proto.SigningKey, error) {
	call := h.kantelCall
	if h.callKantel != nil {
		call = h.callKantel
	}
	raw, err := call(ctx, proto.MethodSigningFetch, proto.SandboxRef{SandboxID: sandboxID})
	if err != nil {
		return proto.SigningKey{}, err
	}
	var key proto.SigningKey
	if err := json.Unmarshal(raw, &key); err != nil {
		return proto.SigningKey{}, fmt.Errorf("signing.fetch: the answer isn't a signing key")
	}
	return key, nil
}

// requireSigning passes the signing key version a create, start, resume or fork names to the store: a key older than
// it is no longer fetched or used.
func (h *Host) requireSigning(sandboxID string, g *proto.GitSigning) {
	if h.signing != nil && g != nil {
		h.signing.Store().Require(sandboxID, g.Version)
	}
}

// forgetSigning drops what the host holds of a sandbox's signing (stop, delete): its key, listener and rate limit.
func (h *Host) forgetSigning(sandboxID string) {
	if h.signing != nil {
		h.signing.Forget(sandboxID)
	}
}

// setSigning is sandbox.signing: the sandbox's key changed (or went). The host's copy goes, the next signature fetches
// the new one, and the sandbox's record and running guest take the new public half.
func (h *Host) setSigning(ctx context.Context, t Tier, tier string, p proto.SigningParams) error {
	if h.signing != nil {
		store := h.signing.Store()
		store.Invalidate(p.SandboxID)
		store.Require(p.SandboxID, p.Version)
	}
	setter, ok := t.(signingSetter)
	if !ok {
		if p.Signing == nil {
			return nil
		}
		return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("the %s tier on this host doesn't sign Git commits", tier)}
	}
	return setter.SetSigning(ctx, p.SandboxID, p.Signing)
}

// --- signing events -------------------------------------------------------------------------------------------------

const (
	// signingBatch is the most records in one event.
	signingBatch = 100
	// signingInterval is the longest a record waits to be sent.
	signingInterval = 2 * time.Second
	// signingBuffer bounds what waits: past it records are dropped, never waited for.
	signingBuffer = 1000
)

// signingBatcher sends the host's signing decisions to Kantel in batches, as egressBatcher does the proxy's. add never
// blocks a signature: records made while disconnected, or past the buffer, are dropped and counted.
type signingBatcher struct {
	send     func([]proto.SigningRecord) error
	live     func() bool
	interval time.Duration

	mu      sync.Mutex
	buf     []proto.SigningRecord
	dropped int64

	kick chan struct{}
	stop chan struct{}
	once sync.Once
}

func newSigningBatcher(send func([]proto.SigningRecord) error, live func() bool) *signingBatcher {
	return &signingBatcher{send: send, live: live, interval: signingInterval, kick: make(chan struct{}, 1), stop: make(chan struct{})}
}

func (b *signingBatcher) add(r proto.SigningRecord) {
	live := b.live == nil || b.live()
	b.mu.Lock()
	defer b.mu.Unlock()
	if !live || len(b.buf) >= signingBuffer {
		b.dropped++
		return
	}
	b.buf = append(b.buf, r)
	if len(b.buf) >= signingBatch {
		select {
		case b.kick <- struct{}{}:
		default:
		}
	}
}

func (b *signingBatcher) run() {
	ticker := time.NewTicker(b.interval)
	defer ticker.Stop()
	for {
		select {
		case <-b.stop:
			return
		case <-ticker.C:
		case <-b.kick:
		}
		b.flush()
	}
}

// flush sends what waits, a batch at a time; a batch that can't be sent is dropped with the rest.
func (b *signingBatcher) flush() {
	for {
		b.mu.Lock()
		n := min(len(b.buf), signingBatch)
		if n == 0 {
			b.mu.Unlock()
			return
		}
		batch := slices.Clone(b.buf[:n])
		b.buf = slices.Delete(b.buf, 0, n)
		b.mu.Unlock()
		if err := b.send(batch); err != nil {
			b.mu.Lock()
			b.dropped += int64(n + len(b.buf))
			b.buf = b.buf[:0]
			b.mu.Unlock()
			return
		}
	}
}

func (b *signingBatcher) close() {
	b.once.Do(func() { close(b.stop) })
}

// sendSigning sends one batch as a "signing" event over the current connection.
func (h *Host) sendSigning(batch []proto.SigningRecord) error {
	h.mu.Lock()
	c := h.link
	h.mu.Unlock()
	if c == nil {
		return errDisconnected
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.send(ctx, proto.Message{Type: "event", Event: &proto.Event{Kind: "signing", At: time.Now().UnixMilli(), Signing: batch}})
}
