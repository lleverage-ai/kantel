package isolate

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// runtimeAt is a runtime whose HTTP API is handler, as the VM runtime's is over vsock.
func runtimeAt(t *testing.T, handler http.Handler) *runtime {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &runtime{done: make(chan struct{}), client: &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", srv.Listener.Addr().String())
	}}}}
}

// workerdWorker answers as the workerd isolate worker did (apps/host/isolate/src/host.ts, before kantel-isolate): a
// /healthz that names no runtime, and every POST's body read for a sandboxId, refused 400 without one, before its
// path is looked at.
func workerdWorker(posts *atomic.Int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/healthz" {
			_, _ = io.WriteString(w, `{"ok":true,"want":4,"idle":4,"sessions":0}`)
			return
		}
		posts.Add(1)
		var body struct {
			SandboxID string `json:"sandboxId"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.SandboxID == "" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"sandboxId required"}`)
			return
		}
		http.NotFound(w, r)
	})
}

func TestRestoredWorkerdTemplate(t *testing.T) {
	// A host updated over an isolate image from before kantel-isolate restores workerd's template: it comes up, with
	// no /reseed asked of it.
	m := &Manager{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	var posts atomic.Int64
	if err := m.restored(context.Background(), runtimeAt(t, workerdWorker(&posts))); err != nil {
		t.Fatalf("restoring workerd's template: %v", err)
	}
	if posts.Load() != 0 {
		t.Fatalf("asked workerd's worker %d POSTs", posts.Load())
	}
	if info := m.RuntimeInfo(); info == nil || info.JavaScript || info.MemoryEnforced {
		t.Fatalf("workerd's runtime info: %+v", info)
	}

	// kantel-isolate is reseeded, and a refusal (any but 404 or 405) fails the start.
	var reseeds atomic.Int64
	answer := func(status int) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/healthz" {
				_, _ = io.WriteString(w, `{"ok":true,"runtime":"deno_core","capabilities":{"javascript":true,"python":true},"memoryEnforced":true}`)
				return
			}
			if r.URL.Path == "/reseed" {
				reseeds.Add(1)
			}
			w.WriteHeader(status)
		})
	}
	if err := m.restored(context.Background(), runtimeAt(t, answer(http.StatusOK))); err != nil || reseeds.Load() != 1 {
		t.Fatalf("kantel-isolate: %v, %d reseeds", err, reseeds.Load())
	}
	if err := m.restored(context.Background(), runtimeAt(t, answer(http.StatusBadRequest))); err == nil {
		t.Fatal("a kantel-isolate that refused /reseed came up")
	}
}

func TestSettled(t *testing.T) {
	answering := func(body string) *runtime {
		return runtimeAt(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) }))
	}
	ctx := context.Background()
	// Never warm, or its pool never full: an error by the deadline, not a template of an unready runtime.
	for _, body := range []string{
		`{"ok":true,"runtime":"deno_core","want":4,"idle":4,"warm":false}`,
		`{"ok":true,"runtime":"deno_core","want":4,"idle":1,"warm":true}`,
		`{"ok":true,"want":4,"idle":1}`,
	} {
		began := time.Now()
		if _, err := answering(body).settled(ctx, 4, 100*time.Millisecond); err == nil || !strings.Contains(err.Error(), "didn't settle") {
			t.Fatalf("%s: %v", body, err)
		}
		if time.Since(began) > 5*time.Second {
			t.Fatalf("%s: took %v", body, time.Since(began))
		}
	}
	if h, err := answering(`{"ok":true,"runtime":"deno_core","want":4,"idle":4,"warm":true}`).settled(ctx, 4, time.Second); err != nil || !*h.Warm {
		t.Fatalf("a warm runtime: %+v %v", h, err)
	}
}
