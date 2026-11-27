package signing

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp/packet"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// fakeKantel answers signing.fetch with whatever answer is now, counting the fetches.
type fakeKantel struct {
	mu      sync.Mutex
	answer  proto.SigningKey
	err     error
	fetches atomic.Int64
	// gate, when set, holds each fetch until it is closed.
	gate chan struct{}
}

func (f *fakeKantel) fetch(ctx context.Context, sandboxID string) (proto.SigningKey, error) {
	f.fetches.Add(1)
	f.mu.Lock()
	gate := f.gate
	f.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return proto.SigningKey{}, ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.answer, f.err
}

func (f *fakeKantel) set(answer proto.SigningKey, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answer, f.err = answer, err
}

func enabledKey(t *testing.T, version int64) proto.SigningKey {
	t.Helper()
	k := newGPGKey(t, packet.PubKeyAlgoEdDSA, "", false)
	return proto.SigningKey{Version: version, Enabled: true, Format: FormatGPG, KeyID: "key_1", Fingerprint: "FP", AllowedEmails: []string{testEmail}, PrivateKey: k.private}
}

func TestStoreSharesOneFetchAndCachesIt(t *testing.T) {
	kantel := &fakeKantel{gate: make(chan struct{})}
	kantel.set(enabledKey(t, 1), nil)
	s := NewStore(kantel.fetch)
	var wg sync.WaitGroup
	results := make([]*cachedKey, 8)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e, err := s.Get(context.Background(), "sbx_1")
			if err != nil {
				t.Error(err)
			}
			results[i] = e
		}()
	}
	// Every caller waits on the one fetch.
	for deadline := time.Now().Add(5 * time.Second); kantel.fetches.Load() == 0 && time.Now().Before(deadline); {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(kantel.gate)
	wg.Wait()
	if n := kantel.fetches.Load(); n != 1 {
		t.Fatalf("%d fetches", n)
	}
	for _, e := range results {
		if e == nil || e != results[0] || !e.enabled || e.key.Format != FormatGPG {
			t.Fatalf("results %+v", results)
		}
	}
	if _, err := s.Get(context.Background(), "sbx_1"); err != nil || kantel.fetches.Load() != 1 {
		t.Fatalf("not cached: %v, %d fetches", err, kantel.fetches.Load())
	}
}

func TestStoreVersionFloors(t *testing.T) {
	kantel := &fakeKantel{}
	kantel.set(enabledKey(t, 4), nil)
	s := NewStore(kantel.fetch)
	if e, err := s.Get(context.Background(), "sbx_1"); err != nil || e.version != 4 {
		t.Fatalf("%+v %v", e, err)
	}
	// Kantel advertises a newer version: the cached key goes, and a fetch answering the old one is refused.
	s.Require("sbx_1", 5)
	if _, err := s.Get(context.Background(), "sbx_1"); !errors.Is(err, ErrStale) || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("a stale key: %v", err)
	}
	if kantel.fetches.Load() != 2 {
		t.Fatalf("%d fetches", kantel.fetches.Load())
	}
	// Not cached: the next Get fetches again, and takes the new version.
	kantel.set(enabledKey(t, 5), nil)
	if e, err := s.Get(context.Background(), "sbx_1"); err != nil || e.version != 5 {
		t.Fatalf("%+v %v", e, err)
	}
	// An older version than required changes nothing.
	s.Require("sbx_1", 3)
	if _, err := s.Get(context.Background(), "sbx_1"); err != nil || kantel.fetches.Load() != 3 || s.MinVersion("sbx_1") != 5 {
		t.Fatalf("%v, %d fetches, floor %d", err, kantel.fetches.Load(), s.MinVersion("sbx_1"))
	}
	// Invalidate refetches; Forget drops the floor too.
	s.Invalidate("sbx_1")
	if _, err := s.Get(context.Background(), "sbx_1"); err != nil || kantel.fetches.Load() != 4 {
		t.Fatalf("after Invalidate: %v, %d fetches", err, kantel.fetches.Load())
	}
	s.Forget("sbx_1")
	if s.MinVersion("sbx_1") != 0 {
		t.Fatal("Forget kept the floor")
	}
	s.mu.Lock()
	held := len(s.entries)
	s.mu.Unlock()
	if held != 0 {
		t.Fatal("Forget kept the key")
	}
}

func TestStoreNeverCachesFailures(t *testing.T) {
	kantel := &fakeKantel{}
	kantel.set(proto.SigningKey{}, errors.New("the host isn't connected"))
	s := NewStore(kantel.fetch)
	if _, err := s.Get(context.Background(), "sbx_1"); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	// A key that doesn't parse isn't cached either.
	kantel.set(proto.SigningKey{Version: 1, Enabled: true, Format: FormatGPG, PrivateKey: "nonsense"}, nil)
	if _, err := s.Get(context.Background(), "sbx_1"); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	// None configured is an answer, and cached.
	kantel.set(proto.SigningKey{Version: 2}, nil)
	for range 2 {
		if e, err := s.Get(context.Background(), "sbx_1"); err != nil || e.enabled || e.key != nil {
			t.Fatalf("%+v %v", e, err)
		}
	}
	if kantel.fetches.Load() != 3 {
		t.Fatalf("%d fetches", kantel.fetches.Load())
	}
}

// A caller that gives up doesn't end the fetch for the others.
func TestStoreCallerGivingUp(t *testing.T) {
	kantel := &fakeKantel{gate: make(chan struct{})}
	kantel.set(proto.SigningKey{Version: 1}, nil)
	s := NewStore(kantel.fetch)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := s.Get(ctx, "sbx_1"); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	close(kantel.gate)
	if _, err := s.Get(context.Background(), "sbx_1"); err != nil {
		t.Fatal(err)
	}
	if kantel.fetches.Load() != 1 {
		t.Fatalf("%d fetches", kantel.fetches.Load())
	}
}
