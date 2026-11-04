package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
)

type joinVector struct {
	Entries []e2e.Entry `json:"entries"`
	Word    string      `json:"word"`
	Race    struct {
		Entry e2e.Entry `json:"entry"`
		Word  string    `json:"word"`
	} `json:"race"`
}

// fakeGateway is the hosts API's chain endpoint as kantel-host join sees it: it takes an append only at the seq its
// chain is at (409 otherwise), like the real one. before runs ahead of each append; drop throws its answer away.
type fakeGateway struct {
	mu      sync.Mutex
	chain   []e2e.Entry
	before  func(g *fakeGateway)
	drop    bool
	appends int
}

func (g *fakeGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != hostChainPath || r.Header.Get("Authorization") != "Bearer cred" {
		http.Error(w, "no", http.StatusNotFound)
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if r.Method == http.MethodGet {
		_ = json.NewEncoder(w).Encode(map[string]any{"entries": g.chain})
		return
	}
	var body struct {
		From    int         `json:"from"`
		Entries []e2e.Entry `json:"entries"`
	}
	raw, _ := io.ReadAll(r.Body)
	if json.Unmarshal(raw, &body) != nil {
		http.Error(w, "bad", http.StatusBadRequest)
		return
	}
	g.appends++
	if g.before != nil {
		g.before(g)
	}
	if body.From != len(g.chain) {
		http.Error(w, `{"error":{"code":"conflict"}}`, http.StatusConflict)
		return
	}
	g.chain = append(g.chain, body.Entries...)
	if g.drop {
		// The append went in; the host never hears so.
		if hj, ok := w.(http.Hijacker); ok {
			conn, _, _ := hj.Hijack()
			_ = conn.Close()
			return
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"entries": g.chain})
}

func joinSetup(t *testing.T) (joinVector, *fakeGateway, string, string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "e2e", "vectors", "join.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v joinVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	g := &fakeGateway{chain: append([]e2e.Entry{}, v.Entries...)}
	srv := httptest.NewServer(g)
	t.Cleanup(srv.Close)
	root := t.TempDir()
	cfg, _ := json.Marshal(map[string]any{"controlPlane": srv.URL, "hostId": "host_two", "credential": "cred", "root": root})
	path := filepath.Join(root, "config.json")
	if err := os.WriteFile(path, cfg, 0o600); err != nil {
		t.Fatal(err)
	}
	return v, g, path, filepath.Join(root, "e2e")
}

func held(t *testing.T, dir string) []e2e.Entry {
	t.Helper()
	store, err := e2e.OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	return store.Space("acc_org").Entries(0)
}

// kantel-host e2e join against the hosts API: a host.add that loses its seq to another append isn't kept, the next
// join publishes one on the chain the gateway took, and only then is it in the host's chain.
func TestJoinThatLosesTheAppendRaceJoinsAgain(t *testing.T) {
	v, g, cfg, dir := joinSetup(t)
	// An admin's member.add gets in between the host's fetch and its append.
	g.before = func(g *fakeGateway) {
		g.chain = append(g.chain, v.Race.Entry)
		g.before = nil
	}
	if err := e2eCmd([]string{"join", "--config", cfg, v.Word}); err == nil {
		t.Fatal("a refused append was reported as joined")
	}
	if got := held(t, dir); len(got) != len(v.Entries) {
		t.Fatalf("the refused host.add is in the host's chain (%d entries)", len(got))
	}
	if err := e2eCmd([]string{"join", "--config", cfg, v.Race.Word}); err != nil {
		t.Fatalf("the host couldn't join the chain the gateway took: %v", err)
	}
	got := held(t, dir)
	if len(got) != len(v.Entries)+2 || got[len(v.Entries)] != v.Race.Entry || got[len(got)-1] != g.chain[len(g.chain)-1] {
		t.Fatalf("the host holds %d entries, the gateway %d", len(got), len(g.chain))
	}
	if _, err := e2e.VerifyChain(g.chain, ""); err != nil {
		t.Fatal(err)
	}
	// Joined: running it again publishes nothing.
	n := g.appends
	if err := e2eCmd([]string{"join", "--config", cfg, v.Race.Word}); err != nil || g.appends != n {
		t.Fatalf("again: %v, %d appends", err, g.appends-n)
	}
}

// The gateway takes the host.add but the answer is lost: join again finds it in the chain, publishes nothing, and keeps
// it; a gateway that then serves another entry at its seq is refused.
func TestJoinWhoseAnswerWasLostKeepsTheHostAdd(t *testing.T) {
	v, g, cfg, dir := joinSetup(t)
	g.drop = true
	if err := e2eCmd([]string{"join", "--config", cfg, v.Word}); err == nil {
		t.Fatal("a join with no answer was reported as published")
	}
	if got := held(t, dir); len(got) != len(v.Entries) {
		t.Fatalf("an unconfirmed host.add is in the host's chain (%d entries)", len(got))
	}
	g.drop = false
	n := g.appends
	if err := e2eCmd([]string{"join", "--config", cfg, v.Word}); err != nil || g.appends != n {
		t.Fatalf("again: %v, %d appends", err, g.appends-n)
	}
	got := held(t, dir)
	if len(got) != len(v.Entries)+1 || got[len(v.Entries)] != g.chain[len(v.Entries)] {
		t.Fatalf("the host holds %d entries", len(got))
	}
	// The gateway now says another entry is at that seq.
	g.chain = append(append([]e2e.Entry{}, v.Entries...), v.Race.Entry)
	if err := e2eCmd([]string{"join", "--config", cfg, v.Race.Word}); err == nil {
		t.Fatal("the host gave up the host.add the gateway took")
	}
	if after := held(t, dir); len(after) != len(got) || after[len(v.Entries)] != got[len(v.Entries)] {
		t.Fatal("the host's chain changed")
	}
}
