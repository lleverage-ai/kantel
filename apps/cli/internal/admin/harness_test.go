package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// kantel-admin through cli.Run, with a fake Kantel (and kantel.dev, and GitHub) behind its HTTP client, a fake spawn
// and a temporary home.

type call struct {
	Method, URL, Path string
	Body              any
	Auth              string
}

// reply is an answer with a status, or text as it is.
type reply struct {
	Status int
	Body   any
	Text   string
}

func kantelError(status int, code, message string) reply {
	return reply{Status: status, Body: map[string]any{"error": map[string]any{"code": code, "message": message}}}
}

// routes are by "METHOD https://origin/path" or "METHOD /path".
type routes map[string]func(call) any

// fakeHTTP answers every request from routes, whatever its host; unreachable fails each as a refused connection.
type fakeHTTP struct {
	routes      routes
	unreachable bool
	mu          sync.Mutex
	calls       []call
}

func (f *fakeHTTP) RoundTrip(req *http.Request) (*http.Response, error) {
	if f.unreachable {
		return nil, errors.New("connect: connection refused")
	}
	c := call{Method: req.Method, URL: req.URL.String(), Path: req.URL.Path, Auth: req.Header.Get("Authorization")}
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		_ = json.Unmarshal(raw, &c.Body)
	}
	f.mu.Lock()
	f.calls = append(f.calls, c)
	f.mu.Unlock()
	w := httptest.NewRecorder()
	origin := req.URL.Scheme + "://" + req.URL.Host
	route, ok := f.routes[req.Method+" "+origin+req.URL.Path]
	if !ok {
		route, ok = f.routes[req.Method+" "+req.URL.Path]
	}
	if !ok {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"No route ` + req.Method + " " + req.URL.Path + `"}}`))
		return w.Result(), nil
	}
	answer := route(c)
	status := 200
	if rep, ok := answer.(reply); ok {
		status = rep.Status
		if rep.Text != "" {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(rep.Text))
			return w.Result(), nil
		}
		answer = rep.Body
	}
	if s, ok := answer.(string); ok {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(s))
		return w.Result(), nil
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(answer)
	return w.Result(), nil
}

type spawned struct {
	Command string
	Args    []string
	Input   *string
	Capture bool
}

type opts struct {
	routes      routes
	unreachable bool
	// env is the environment; default KANTEL_URL=https://kantel.test and KANTEL_API_KEY=ksk_admin.
	env      cli.Env
	platform string
	root     bool
	tty      bool
	// ran answers a spawn; default exit 0 and no output.
	ran func(spawned) (Ran, error)
}

type result struct {
	Code     int
	Out, Err string
	Calls    []call
	Spawned  []spawned
}

// tester is a temporary home, with kantel's config in it, for one test's runs.
type tester struct {
	t         *testing.T
	home      string
	configDir string
}

func newTester(t *testing.T) *tester {
	home := t.TempDir()
	return &tester{t: t, home: home, configDir: filepath.Join(home, ".config", "kantel")}
}

func (tt *tester) run(argv []string, o opts) result {
	tt.t.Helper()
	f := &fakeHTTP{routes: o.routes, unreachable: o.unreachable}
	env := o.env
	if env == nil {
		env = cli.Env{"KANTEL_URL": "https://kantel.test", "KANTEL_API_KEY": "ksk_admin"}
	}
	platform := o.platform
	if platform == "" {
		platform = "linux"
	}
	var calls []spawned
	sys := System{Platform: platform, IsRoot: o.root,
		Spawn: func(_ context.Context, command string, args []string, so SpawnOptions) (Ran, error) {
			s := spawned{Command: command, Args: append([]string{}, args...), Input: so.Input, Capture: so.Capture}
			calls = append(calls, s)
			if o.ran != nil {
				return o.ran(s)
			}
			return Ran{}, nil
		}}
	var stdout, stderr bytes.Buffer
	code := cli.Run(Program(sys), argv, &cli.IO{
		Stdout: &stdout, Stderr: &stderr, Stdin: strings.NewReader(""),
		StdoutTTY: o.tty, StderrTTY: o.tty, Env: env, Home: tt.home, ConfigDir: tt.configDir, Cwd: tt.home,
		HTTP: &http.Client{Transport: f}, Now: time.Now,
		Sleep: func(context.Context, time.Duration) error { return nil },
	})
	f.mu.Lock()
	defer f.mu.Unlock()
	return result{Code: code, Out: stdout.String(), Err: stderr.String(), Calls: f.calls, Spawned: calls}
}

// install makes an install in the home, with env as its .env (none when empty), and answers the .env's path.
func (tt *tester) install(env string) string {
	tt.t.Helper()
	dir := filepath.Join(tt.home, ".kantel", "src", "deploy", "compose")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		tt.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "compose.yaml"), []byte("name: harbour\n"), 0o644); err != nil {
		tt.t.Fatal(err)
	}
	path := filepath.Join(dir, ".env")
	if env != "" {
		if err := os.WriteFile(path, []byte(env), 0o600); err != nil {
			tt.t.Fatal(err)
		}
	}
	return path
}

func (tt *tester) read(path string) string {
	tt.t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		tt.t.Fatal(err)
	}
	return string(raw)
}

const defaultEnv = "KANTEL_GATEWAY_PORT=58123\nKANTEL_SMTP_PASSWORD=hunter2\n"

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

func lacks(t *testing.T, what, got, unwanted string) {
	t.Helper()
	if strings.Contains(got, unwanted) {
		t.Errorf("%s: %q contains %q", what, got, unwanted)
	}
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
