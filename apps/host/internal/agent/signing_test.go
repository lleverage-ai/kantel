package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/signing"
)

// signingTier keeps each sandbox's signing key's public half as the microVM tier keeps it in meta.json.
type signingTier struct {
	Tier // unimplemented methods panic

	name string
	mu   sync.Mutex
	set  map[string][]*proto.GitSigning
}

func (f *signingTier) Get(id string) (proto.SandboxInfo, error) {
	if id != "sbx_1" {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: id}
	}
	return proto.SandboxInfo{ID: id, Tier: f.name, State: proto.StateRunning}, nil
}

func (f *signingTier) SetSigning(_ context.Context, id string, cfg *proto.GitSigning) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.set == nil {
		f.set = map[string][]*proto.GitSigning{}
	}
	f.set[id] = append(f.set[id], cfg)
	return nil
}

// isolateTier is a tier without Git signing.
type isolateTier struct{ Tier }

func (isolateTier) Get(id string) (proto.SandboxInfo, error) {
	if id != "sbx_1" {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: id}
	}
	return proto.SandboxInfo{ID: id, Tier: isolate.Tier, State: proto.StateRunning}, nil
}

// newSigningHost is a host with tier, whose Kantel answers signing.fetch with each version in turn.
func newSigningHost(t *testing.T, name string, tier Tier) (*Host, *[]string) {
	t.Helper()
	var mu sync.Mutex
	var calls []string
	h := &Host{
		cfg: Config{Root: t.TempDir()}, log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		tiers: map[string]Tier{name: tier}, order: []string{name}, bySlot: map[int]egress.Rules{},
	}
	version := int64(0)
	h.callKantel = func(_ context.Context, method string, params any) (json.RawMessage, error) {
		mu.Lock()
		defer mu.Unlock()
		raw, _ := json.Marshal(params)
		calls = append(calls, method+" "+string(raw))
		version++
		return json.Marshal(proto.SigningKey{Version: version})
	}
	h.signing = signing.NewManager(signing.NewStore(h.fetchSigning))
	return h, &calls
}

func TestSigningFetchAsksKantel(t *testing.T) {
	h, calls := newSigningHost(t, microvm.Tier, &signingTier{name: microvm.Tier})
	key, err := h.fetchSigning(context.Background(), "sbx_1")
	if err != nil || key.Version != 1 || key.Enabled {
		t.Fatalf("%+v %v", key, err)
	}
	if want := []string{`signing.fetch {"sandboxId":"sbx_1"}`}; !slices.Equal(*calls, want) {
		t.Fatalf("calls %v", *calls)
	}
	// An answer that isn't a key: the error doesn't quote it (it would hold the private key).
	h.callKantel = func(context.Context, string, any) (json.RawMessage, error) {
		return json.RawMessage(`{"privateKey": 7}`), nil
	}
	if _, err := h.fetchSigning(context.Background(), "sbx_1"); err == nil || strings.Contains(err.Error(), "privateKey") {
		t.Fatalf("a bad answer: %v", err)
	}
	h.callKantel = func(context.Context, string, any) (json.RawMessage, error) { return nil, errDisconnected }
	if _, err := h.fetchSigning(context.Background(), "sbx_1"); !errors.Is(err, errDisconnected) {
		t.Fatal(err)
	}
}

func TestSandboxSigningUpdatesTheKeyAndTheGuest(t *testing.T) {
	tier := &signingTier{name: microvm.Tier}
	h, calls := newSigningHost(t, microvm.Tier, tier)
	store := h.signing.Store()
	if _, err := store.Get(context.Background(), "sbx_1"); err != nil {
		t.Fatal(err)
	}
	// A new key: the host's copy goes, the floor rises, and the tier takes the public half.
	key := &proto.GitSigning{Format: "ssh", KeyID: "key_2", Fingerprint: "SHA256:x", PublicKey: "ssh-ed25519 AAAA", Version: 2}
	params, _ := json.Marshal(proto.SigningParams{SandboxID: "sbx_1", Signing: key, Version: 2})
	if _, err := h.Call(context.Background(), proto.MethodSigning, params, nil); err != nil {
		t.Fatal(err)
	}
	if store.MinVersion("sbx_1") != 2 {
		t.Fatalf("floor %d", store.MinVersion("sbx_1"))
	}
	if got := tier.set["sbx_1"]; len(got) != 1 || *got[0] != *key {
		t.Fatalf("the tier got %+v", got)
	}
	if _, err := store.Get(context.Background(), "sbx_1"); err != nil || len(*calls) != 2 {
		t.Fatalf("the key wasn't fetched again: %v, %v", err, *calls)
	}
	// Cleared.
	params, _ = json.Marshal(proto.SigningParams{SandboxID: "sbx_1", Version: 3})
	if _, err := h.Call(context.Background(), proto.MethodSigning, params, nil); err != nil {
		t.Fatal(err)
	}
	if got := tier.set["sbx_1"]; len(got) != 2 || got[1] != nil || store.MinVersion("sbx_1") != 3 {
		t.Fatalf("the tier got %+v, floor %d", got, store.MinVersion("sbx_1"))
	}
	// Refused: no sandbox ID, or a sandbox the host hasn't.
	for _, p := range []proto.SigningParams{{}, {SandboxID: "sbx_2", Version: 4}} {
		params, _ = json.Marshal(p)
		if _, err := h.Call(context.Background(), proto.MethodSigning, params, nil); err == nil {
			t.Fatalf("%+v answered", p)
		}
	}
}

func TestSandboxSigningOfATierWithoutIt(t *testing.T) {
	h, _ := newSigningHost(t, isolate.Tier, isolateTier{})
	params, _ := json.Marshal(proto.SigningParams{SandboxID: "sbx_1", Signing: &proto.GitSigning{Format: "gpg"}, Version: 1})
	var perr *proto.Error
	if _, err := h.Call(context.Background(), proto.MethodSigning, params, nil); !errors.As(err, &perr) || perr.Code != proto.ErrUnsupported {
		t.Fatalf("a key for an isolate: %v", err)
	}
	// None is what it has already.
	params, _ = json.Marshal(proto.SigningParams{SandboxID: "sbx_1", Version: 2})
	if _, err := h.Call(context.Background(), proto.MethodSigning, params, nil); err != nil {
		t.Fatal(err)
	}
}

func TestFactsAdvertiseGitSigning(t *testing.T) {
	h, _ := newSigningHost(t, microvm.Tier, &signingTier{name: microvm.Tier})
	if !slices.Contains(h.makeFacts().Features, proto.FeatureGitSigning) {
		t.Fatalf("a microVM host doesn't report %s", proto.FeatureGitSigning)
	}
	h, _ = newSigningHost(t, isolate.Tier, isolateTier{})
	if slices.Contains(h.makeFacts().Features, proto.FeatureGitSigning) {
		t.Fatal("a host without microVMs reports it")
	}
}

// Stop and delete drop the host's copy of the key, and the store's floor with it.
func TestForgetSigningDropsTheKey(t *testing.T) {
	h, calls := newSigningHost(t, microvm.Tier, &signingTier{name: microvm.Tier})
	store := h.signing.Store()
	h.requireSigning("sbx_1", &proto.GitSigning{Version: 1})
	h.requireSigning("sbx_1", nil)
	if store.MinVersion("sbx_1") != 1 {
		t.Fatalf("floor %d", store.MinVersion("sbx_1"))
	}
	if _, err := store.Get(context.Background(), "sbx_1"); err != nil {
		t.Fatal(err)
	}
	h.forgetSandbox("sbx_1")
	if store.MinVersion("sbx_1") != 0 {
		t.Fatal("the floor stayed")
	}
	if _, err := store.Get(context.Background(), "sbx_1"); err != nil || len(*calls) != 2 {
		t.Fatalf("the key stayed: %v %v", err, *calls)
	}
	// A host without signing (a test's) has nothing to forget.
	(&Host{}).forgetSigning("sbx_1")
	(&Host{}).requireSigning("sbx_1", &proto.GitSigning{Version: 1})
}

func TestSigningBatcher(t *testing.T) {
	var mu sync.Mutex
	var batches [][]proto.SigningRecord
	fail, live := false, true
	b := newSigningBatcher(func(batch []proto.SigningRecord) error {
		mu.Lock()
		defer mu.Unlock()
		if fail {
			return errors.New("connection gone")
		}
		batches = append(batches, batch)
		return nil
	}, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return live
	})
	for i := range 250 {
		b.add(proto.SigningRecord{At: int64(i), SandboxID: "sbx_1", Allowed: i%2 == 0, Format: "gpg", ObjectType: "commit"})
	}
	b.flush()
	mu.Lock()
	if len(batches) != 3 || len(batches[0]) != signingBatch || len(batches[1]) != signingBatch || len(batches[2]) != 50 {
		t.Fatalf("batches of %d", len(batches))
	}
	if r := batches[2][49]; r.At != 249 || r.Allowed || r.SandboxID != "sbx_1" {
		t.Fatalf("record %+v", r)
	}
	live = false
	mu.Unlock()
	b.add(proto.SigningRecord{})
	b.flush()
	mu.Lock()
	if len(batches) != 3 || b.dropped != 1 {
		t.Fatalf("a record made while disconnected was kept: %d batches, %d dropped", len(batches), b.dropped)
	}
	live, fail = true, true
	mu.Unlock()
	b.add(proto.SigningRecord{})
	b.flush()
	b.mu.Lock()
	if len(b.buf) != 0 || b.dropped != 2 {
		t.Fatalf("a batch that couldn't be sent: %d left, %d dropped", len(b.buf), b.dropped)
	}
	b.mu.Unlock()
	for range signingBuffer + 10 {
		b.add(proto.SigningRecord{})
	}
	b.mu.Lock()
	if len(b.buf) != signingBuffer || b.dropped != 12 {
		t.Fatalf("buffer %d, dropped %d", len(b.buf), b.dropped)
	}
	b.mu.Unlock()
	b.close()
	b.close()
}

// The event Kantel receives: kind "signing", the records under "signing", with nothing of a key.
func TestSigningEventShape(t *testing.T) {
	raw, err := json.Marshal(proto.Event{Kind: "signing", At: 5, Signing: []proto.SigningRecord{{At: 4, SandboxID: "sbx_1", Allowed: false, Format: "ssh", ObjectType: "unknown", Reason: "no"}}})
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	_ = json.Unmarshal(raw, &back)
	records, _ := back["signing"].([]any)
	if back["kind"] != "signing" || len(records) != 1 {
		t.Fatalf("%s", raw)
	}
	if want := `{"at":4,"sandboxId":"sbx_1","allowed":false,"format":"ssh","objectType":"unknown","reason":"no"}`; !strings.Contains(string(raw), want) {
		t.Fatalf("%s", raw)
	}
}
