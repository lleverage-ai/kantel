package kantel

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// A fake Kantel for the tests: routes by "METHOD /v1/path", answering what the route returns (a reply as it is,
// else JSON), and recording each call.

type call struct {
	Method, Path string
	Query        map[string][]string
	Body         map[string]any
	Raw          []byte
	Auth         string
	Key          string
}

// reply is an answer with a status, for a route that fails.
type reply struct {
	Status int
	Body   any
	// Text is sent as it is, not as JSON (a proxy's page).
	Text string
}

func kantelError(status int, code, message string) reply {
	return reply{Status: status, Body: map[string]any{"error": map[string]any{"code": code, "message": message}}}
}

type routes map[string]func(call) any

type fake struct {
	server *httptest.Server
	mu     sync.Mutex
	calls  []call
}

func newFake(t *testing.T, r routes) *fake {
	f := &fake{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		raw, _ := io.ReadAll(req.Body)
		c := call{Method: req.Method, Path: req.URL.Path, Query: req.URL.Query(), Raw: raw,
			Auth: req.Header.Get("Authorization"), Key: req.Header.Get("Idempotency-Key")}
		_ = json.Unmarshal(raw, &c.Body)
		f.mu.Lock()
		f.calls = append(f.calls, c)
		f.mu.Unlock()
		route, ok := r[req.Method+" "+req.URL.Path]
		if !ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"No route ` + req.Method + " " + req.URL.Path + `"}}`))
			return
		}
		answer := route(c)
		status := 200
		if rep, ok := answer.(reply); ok {
			status = rep.Status
			if rep.Text != "" {
				w.Header().Set("Content-Type", "text/html")
				w.WriteHeader(status)
				_, _ = w.Write([]byte(rep.Text))
				return
			}
			answer = rep.Body
		}
		if answer == nil {
			w.WriteHeader(204)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(answer)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fake) Calls() []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]call(nil), f.calls...)
}

func (f *fake) Lines() []string {
	var out []string
	for _, c := range f.Calls() {
		out = append(out, c.Method+" "+c.Path)
	}
	return out
}

type result struct {
	Code           int
	Stdout, Stderr string
	Calls          []call
	Opened         []string
}

type opts struct {
	routes routes
	env    cli.Env
	stdin  string
	tty    bool
	// configDir is the config directory; default a temporary one.
	configDir string
}

// run runs kantel with argv against a fake Kantel.
func run(t *testing.T, argv []string, o opts) result {
	t.Helper()
	f := newFake(t, o.routes)
	env := o.env
	if env == nil {
		env = cli.Env{"KANTEL_URL": f.server.URL, "KANTEL_API_KEY": "ksk_test"}
	}
	for k, v := range env {
		if v == "$FAKE" {
			env[k] = f.server.URL
		}
	}
	dir := o.configDir
	if dir == "" {
		dir = t.TempDir()
	}
	var stdout, stderr bytes.Buffer
	var opened []string
	code := cli.Run(Program(), argv, &cli.IO{
		Stdout: &stdout, Stderr: &stderr, Stdin: strings.NewReader(o.stdin),
		StdoutTTY: o.tty, StderrTTY: o.tty, Env: env, Home: dir, ConfigDir: dir, Cwd: dir,
		HTTP: f.server.Client(), Now: time.Now,
		Sleep:   func(context.Context, time.Duration) error { return nil },
		OpenURL: func(u string) { opened = append(opened, u) },
	})
	return result{Code: code, Stdout: stdout.String(), Stderr: stderr.String(), Calls: f.Calls(), Opened: opened}
}

func sandbox(fields map[string]any) map[string]any {
	s := map[string]any{
		"id": "sbx_test1", "accountId": "acc_1", "name": "brisk-otter", "subdomain": "brisk-otter", "type": "isolate",
		"state": "running", "visibility": "private", "capabilities": map[string]any{}, "labels": map[string]any{},
		"autoStopMinutes": 60, "grants": []any{}, "createdBy": map[string]any{"kind": "user", "id": "usr_1"},
		"createdAt": time.Now().UnixMilli(), "cost": map[string]any{"currency": "USD", "ratePerHour": 0.01, "total": 0.02},
		"usage": map[string]any{"runningSeconds": 120},
	}
	for k, v := range fields {
		s[k] = v
	}
	return s
}

func eq[T comparable](t *testing.T, what string, got, want T) {
	t.Helper()
	if got != want {
		t.Errorf("%s: got %v, want %v", what, got, want)
	}
}

func contains(t *testing.T, what, got, want string) {
	t.Helper()
	if !strings.Contains(got, want) {
		t.Errorf("%s: %q doesn't contain %q", what, got, want)
	}
}
