package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/egress/protect"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// fakeLink is the control plane's side of a connection: it sees what the host sends and answers its calls.
type fakeLink struct {
	mu   sync.Mutex
	sent []proto.Message
	// answer, when set, is the control plane answering a call (nil: it never does).
	answer func(m proto.Message) *proto.Message
	c      *caller
}

func newFakeLink(answer func(m proto.Message) *proto.Message) *fakeLink {
	l := &fakeLink{answer: answer}
	l.c = newCaller(func(_ context.Context, m proto.Message) error {
		l.mu.Lock()
		l.sent = append(l.sent, m)
		l.mu.Unlock()
		if l.answer != nil {
			if res := l.answer(m); res != nil {
				// As the read loop does, on another goroutine than the caller's.
				go l.c.deliver(*res)
			}
		}
		return nil
	})
	return l
}

func TestCallerRoutesResultsByID(t *testing.T) {
	l := newFakeLink(func(m proto.Message) *proto.Message {
		if m.Method == "fails" {
			return &proto.Message{Type: "result", ID: m.ID, Error: &proto.Error{Code: proto.ErrNotFound, Message: "no such sandbox"}}
		}
		return &proto.Message{Type: "result", ID: m.ID, Result: json.RawMessage(`{"echo":` + string(m.Params) + `}`)}
	})
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := l.c.Call(context.Background(), "echo", map[string]int{"n": i})
			if err != nil {
				t.Errorf("call %d: %v", i, err)
				return
			}
			if want := fmt.Sprintf(`{"echo":{"n":%d}}`, i); string(res) != want {
				t.Errorf("call %d got %s, want %s", i, res, want)
			}
		}()
	}
	wg.Wait()
	_, err := l.c.Call(context.Background(), "fails", struct{}{})
	var perr *proto.Error
	if !errors.As(err, &perr) || perr.Code != proto.ErrNotFound {
		t.Fatalf("an error result: %v", err)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	ids := map[string]bool{}
	for _, m := range l.sent {
		if m.Type != "call" || !strings.HasPrefix(m.ID, "h") || ids[m.ID] {
			t.Fatalf("sent %+v", m)
		}
		ids[m.ID] = true
	}
	if l.c.deliver(proto.Message{Type: "result", ID: "h1"}) {
		t.Fatal("a result no call waits for was taken")
	}
}

func TestCallerTimesOutAndFailsFastWhenDisconnected(t *testing.T) {
	l := newFakeLink(nil)
	l.c.timeout = 50 * time.Millisecond
	started := time.Now()
	_, err := l.c.Call(context.Background(), proto.MethodSecretsFetch, proto.SandboxRef{SandboxID: "sbx_1"})
	var perr *proto.Error
	if !errors.As(err, &perr) || perr.Code != proto.ErrTimeout {
		t.Fatalf("unanswered call: %v", err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("the timeout didn't apply")
	}

	// A call waiting when the connection drops fails then, not at its timeout.
	l = newFakeLink(nil)
	done := make(chan error, 1)
	go func() {
		_, err := l.c.Call(context.Background(), "slow", struct{}{})
		done <- err
	}()
	for {
		l.c.mu.Lock()
		n := len(l.c.pending)
		l.c.mu.Unlock()
		if n == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	l.c.close()
	select {
	case err := <-done:
		if !errors.Is(err, errDisconnected) {
			t.Fatalf("after close: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a pending call outlived its connection")
	}
	if _, err := l.c.Call(context.Background(), "later", struct{}{}); !errors.Is(err, errDisconnected) {
		t.Fatalf("a call on a closed connection: %v", err)
	}
	// With no connection at all, the host's own calls fail at once too.
	if _, err := (&Host{}).kantelCall(context.Background(), proto.MethodSecretsFetch, struct{}{}); !errors.Is(err, errDisconnected) {
		t.Fatalf("no link: %v", err)
	}
}

const (
	testPlaceholder = "kph_0123456789abcdefghijABCDEFGHIJ0123456789"
	testValue       = "ghs_neverPersisted_42"
)

func secretsAnswer(m proto.Message) *proto.Message {
	if m.Method != proto.MethodSecretsFetch {
		return &proto.Message{Type: "result", ID: m.ID, Error: &proto.Error{Code: proto.ErrUnsupported, Message: m.Method}}
	}
	table := proto.SecretsTable{Version: 3, Entries: []proto.SecretEntry{{
		Placeholder: testPlaceholder, Name: "GITHUB_TOKEN", Value: testValue,
		Bindings: []proto.DestinationBinding{{Host: "api.github.com", PathPrefixes: []string{"/repos"}, Methods: []string{"GET"}}},
	}}}
	raw, _ := json.Marshal(table)
	return &proto.Message{Type: "result", ID: m.ID, Result: raw}
}

func TestFetchTable(t *testing.T) {
	l := newFakeLink(secretsAnswer)
	table, err := fetchTable(context.Background(), l.c.Call, "sbx_1")
	if err != nil {
		t.Fatal(err)
	}
	if table.Version != 3 || len(table.Entries) != 1 {
		t.Fatalf("table %+v", table)
	}
	e := table.Entries[0]
	if e.Placeholder != testPlaceholder || e.Name != "GITHUB_TOKEN" || e.Value != testValue || len(e.Bindings) != 1 ||
		e.Bindings[0].Host != "api.github.com" || e.Bindings[0].PathPrefixes[0] != "/repos" || e.Bindings[0].Methods[0] != "GET" {
		t.Fatalf("entry %+v", e)
	}
	var params proto.SandboxRef
	_ = json.Unmarshal(l.sent[0].Params, &params)
	if l.sent[0].Method != proto.MethodSecretsFetch || params.SandboxID != "sbx_1" {
		t.Fatalf("sent %+v", l.sent[0])
	}
	// An answer that isn't a table is an error that doesn't quote it: it may hold values.
	bad := newFakeLink(func(m proto.Message) *proto.Message {
		return &proto.Message{Type: "result", ID: m.ID, Result: json.RawMessage(`{"entries":"` + testValue + `"}`)}
	})
	if _, err := fetchTable(context.Background(), bad.c.Call, "sbx_1"); err == nil || strings.Contains(err.Error(), testValue) {
		t.Fatalf("a bad answer: %v", err)
	}
}

func TestEgressBatcher(t *testing.T) {
	var mu sync.Mutex
	var batches [][]proto.EgressRecord
	fail := false
	live := true
	b := newEgressBatcher(func(batch []proto.EgressRecord) error {
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
	at := time.UnixMilli(1_700_000_000_123)
	for i := range 250 {
		b.add(egress.Record{At: at, SandboxID: "sbx_1", Method: "GET", Host: "api.github.com", Port: 443, Path: fmt.Sprintf("/%d", i), Allowed: true, Inspected: true, Status: 200})
	}
	b.flush()
	mu.Lock()
	if len(batches) != 3 || len(batches[0]) != egressBatch || len(batches[1]) != egressBatch || len(batches[2]) != 50 {
		t.Fatalf("batches of %d", len(batches))
	}
	r := batches[0][0]
	if r.At != at.UnixMilli() || r.Path != "/0" || r.Swapped == nil || !r.Inspected {
		t.Fatalf("record %+v", r)
	}
	live = false
	mu.Unlock()
	b.add(egress.Record{At: at})
	b.flush()
	mu.Lock()
	if len(batches) != 3 || b.dropped != 1 {
		t.Fatalf("a record made while disconnected was kept: %d batches, %d dropped", len(batches), b.dropped)
	}
	live, fail = true, true
	mu.Unlock()
	b.add(egress.Record{At: at})
	b.flush()
	b.mu.Lock()
	if len(b.buf) != 0 || b.dropped != 2 {
		t.Fatalf("a batch that couldn't be sent: %d left, %d dropped", len(b.buf), b.dropped)
	}
	b.mu.Unlock()
	// Past the buffer, records are dropped rather than waited for.
	mu.Lock()
	fail = false
	mu.Unlock()
	for range egressBuffer + 10 {
		b.add(egress.Record{At: at})
	}
	b.mu.Lock()
	if len(b.buf) != egressBuffer || b.dropped != 12 {
		t.Fatalf("buffer %d, dropped %d", len(b.buf), b.dropped)
	}
	b.mu.Unlock()
	b.close()
	b.close()
}

// fakeTier is a microVM tier that keeps what it is given, as microvm keeps CreateParams in meta.json.
type fakeTier struct {
	Tier // unimplemented methods panic

	mu       sync.Mutex
	created  []proto.CreateParams
	egresses []*proto.Egress
	execs    []proto.ExecParams
	running  map[string]bool
}

func (f *fakeTier) Create(_ context.Context, p proto.CreateParams) (proto.SandboxInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, p)
	f.running[p.SandboxID] = true
	return proto.SandboxInfo{ID: p.SandboxID, Tier: microvm.Tier, State: proto.StateRunning}, nil
}

func (f *fakeTier) Get(id string) (proto.SandboxInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.running[id] {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: id}
	}
	return proto.SandboxInfo{ID: id, Tier: microvm.Tier, State: proto.StateRunning}, nil
}

func (f *fakeTier) SetEgress(_ string, e *proto.Egress) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.egresses = append(f.egresses, e)
	return nil
}

func (f *fakeTier) Exec(_ context.Context, p proto.ExecParams, _ func(string, string)) (proto.ExecResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.execs = append(f.execs, p)
	return proto.ExecResult{}, nil
}

func (f *fakeTier) Delete(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.running, id)
	return nil
}

// What a tier is given, and so what it persists, never holds a protected value or the CA's key: only the CA's
// certificate.
func TestTiersNeverGetValuesOrTheCAKey(t *testing.T) {
	dir := t.TempDir()
	tier := &fakeTier{running: map[string]bool{}}
	h := &Host{
		cfg: Config{Root: dir, ProxyDataPath: true}, log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		tiers: map[string]Tier{microvm.Tier: tier}, order: []string{microvm.Tier}, bySlot: map[int]egress.Rules{},
		cas: egress.NewCAStore(dir + "/egress-ca"),
	}
	h.secrets = protect.NewStore(h.fetchSecrets)
	l := newFakeLink(secretsAnswer)
	h.link = l.c
	// The host has the values in memory, as it would once the sandbox's first request needed them.
	if entries, err := h.secrets.Values(context.Background(), "sbx_1"); err != nil || entries[0].Value != testValue {
		t.Fatalf("Values: %v %v", entries, err)
	}

	upstreamCA := "-----BEGIN CERTIFICATE-----\nupstream\n-----END CERTIFICATE-----\n"
	create := proto.CreateParams{
		SandboxID: "sbx_1", Env: map[string]string{"GITHUB_TOKEN": testPlaceholder},
		Egress: &proto.Egress{Mode: "proxy", CACert: upstreamCA, Protected: &proto.Protected{Version: 3, Intercept: []string{"api.github.com"}}},
	}
	raw, _ := json.Marshal(create)
	if _, err := h.Call(context.Background(), proto.MethodCreate, raw, nil); err != nil {
		t.Fatal(err)
	}
	ca, err := h.cas.Get("sbx_1")
	if err != nil {
		t.Fatalf("no CA for a protected sandbox: %v", err)
	}
	tier.mu.Lock()
	got := tier.created[0]
	tier.mu.Unlock()
	if got.Egress == nil || !strings.HasPrefix(got.Egress.CACert, upstreamCA) || !strings.Contains(got.Egress.CACert, ca.CertPEM()) {
		t.Fatalf("CACert %q: want the upstream's then the sandbox's", got.Egress.CACert)
	}
	if create.Egress.CACert != upstreamCA {
		t.Fatal("the caller's egress was changed")
	}

	// A new intercept set makes a new CA, installed in the running guest.
	egressParams, _ := json.Marshal(proto.ResumeParams{SandboxID: "sbx_1", Egress: &proto.Egress{Mode: "proxy", Protected: &proto.Protected{Version: 4, Intercept: []string{"api.github.com", "uploads.github.com"}}}})
	if _, err := h.Call(context.Background(), proto.MethodEgress, egressParams, nil); err != nil {
		t.Fatal(err)
	}
	next, _ := h.cas.Get("sbx_1")
	if next.CertPEM() == ca.CertPEM() {
		t.Fatal("a new intercept set kept the old CA")
	}
	tier.mu.Lock()
	if len(tier.execs) != 1 || tier.execs[0].User != "root" {
		t.Fatalf("execs %+v", tier.execs)
	}
	stdin, _ := base64.StdEncoding.DecodeString(tier.execs[0].Stdin)
	if !strings.Contains(string(stdin), next.CertPEM()) {
		t.Fatalf("installed %q", stdin)
	}
	everything, _ := json.Marshal(struct {
		Created  []proto.CreateParams
		Egresses []*proto.Egress
		Execs    []proto.ExecParams
		Stdin    string
	}{tier.created, tier.egresses, tier.execs, string(stdin)})
	tier.mu.Unlock()
	for _, bad := range []string{testValue, "PRIVATE KEY"} {
		if strings.Contains(string(everything), bad) {
			t.Fatalf("a tier was given %q: %s", bad, everything)
		}
	}

	// Kantel's rotation notice drops the values; delete drops the CA too.
	secretsParams, _ := json.Marshal(proto.SecretsParams{SandboxID: "sbx_1", Version: 5})
	if _, err := h.Call(context.Background(), proto.MethodSecrets, secretsParams, nil); err != nil {
		t.Fatal(err)
	}
	ref, _ := json.Marshal(proto.SandboxRef{SandboxID: "sbx_1"})
	if _, err := h.Call(context.Background(), proto.MethodDelete, ref, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := h.cas.Get("sbx_1"); !errors.Is(err, egress.ErrNoCA) {
		t.Fatalf("CA after delete: %v", err)
	}
}
