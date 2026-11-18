package isolate

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// TestMain makes the test binary a stand-in kantel-isolate when it is run as one (`<binary> serve --listen ...`), so
// the native runtime's start is tested with its real command line.
func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == "serve" && os.Args[2] == "config.capnp" {
		os.Exit(fakeWorkerd())
	}
	if len(os.Args) > 1 && os.Args[1] == "serve" {
		os.Exit(fakeRuntime(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(`{"version":"test","v8":"test","v8Sandbox":false,"unixSockets":true}`)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// dialAddress is a --listen, --store or --egress value as kantel-isolate takes it: unix:<path>, a URL or host:port.
func dialAddress(at string) (network, address string) {
	if path, ok := strings.CutPrefix(at, "unix:"); ok {
		return "unix", path
	}
	return "tcp", strings.TrimPrefix(at, "http://")
}

// fakeWorkerd answers as workerd running the isolate worker did, from the config.capnp the host wrote in its
// directory: on the http socket's address, with a /healthz that names no runtime.
func fakeWorkerd() int {
	raw, err := os.ReadFile("config.capnp")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var addr string
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.Contains(line, `name = "http"`) {
			_, rest, _ := strings.Cut(line, `address = "`)
			addr, _, _ = strings.Cut(rest, `"`)
		}
	}
	l, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	_ = http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			_, _ = io.WriteString(w, `{"ok":true,"want":0,"idle":0,"sessions":0}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "exitCode": 0, "stdout": "workerd\n", "manifest": map[string]any{}})
	}))
	return 0
}

// fakeRuntime answers the runtime's HTTP API as kantel-isolate does, enough for the host's calls: /healthz with what
// it can do, /warm, /load, and /exec saying what it ran and the bridges it was given.
func fakeRuntime(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	listen := fs.String("listen", "", "")
	store := fs.String("store", "", "")
	egress := fs.String("egress", "", "")
	assets := fs.String("assets", "", "")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	for _, u := range []string{*store, *egress} {
		if !strings.HasPrefix(u, "http://127.0.0.1:") && !strings.HasPrefix(u, "unix:/") {
			fmt.Fprintln(os.Stderr, "not a loopback URL or a socket:", u)
			return 2
		}
	}
	storeNet, storeAddr := dialAddress(*store)
	storeClient := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, storeNet, storeAddr)
	}}}
	if st, err := os.Stat(*assets); err != nil || !st.IsDir() {
		fmt.Fprintln(os.Stderr, "no assets directory:", *assets, err, os.Getuid())
		return 2
	}
	var want, sessions atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "want": want.Load(), "idle": want.Load(), "sessions": sessions.Load(), "runtime": "deno_core",
			"version": "test", "capabilities": map[string]bool{"javascript": true, "python": false}, "memoryEnforced": true,
		})
	})
	mux.HandleFunc("POST /warm", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Size int64 }
		_ = json.NewDecoder(r.Body).Decode(&body)
		want.Store(body.Size)
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	// Each session's memory limit, as the deno_core runtime keeps it: set by whichever of /load and /exec makes the
	// session (memoryMiB from the request, 256 when it has none), and dropped by /evict (the runtime's idle expiry,
	// eviction at its cap or a /reseed).
	var memMu sync.Mutex
	memory := map[string]int{}
	assign := func(id string, memoryMiB int) int {
		memMu.Lock()
		defer memMu.Unlock()
		if m, ok := memory[id]; ok {
			return m
		}
		if memoryMiB == 0 {
			memoryMiB = 256
		}
		memory[id] = memoryMiB
		return memoryMiB
	}
	mux.HandleFunc("POST /load", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SandboxID string `json:"sandboxId"`
			MemoryMiB int    `json:"memoryMiB"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		sessions.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "hit": "miss", "ms": 1, "memoryMiB": assign(body.SandboxID, body.MemoryMiB)})
	})
	mux.HandleFunc("POST /evict", func(w http.ResponseWriter, _ *http.Request) {
		memMu.Lock()
		clear(memory)
		memMu.Unlock()
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	mux.HandleFunc("POST /exec", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SandboxID string          `json:"sandboxId"`
			Command   string          `json:"command"`
			Manifest  json.RawMessage `json:"manifest"`
			MemoryMiB int             `json:"memoryMiB"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		memoryMiB := assign(body.SandboxID, body.MemoryMiB)
		if body.Command == "memory" {
			_ = json.NewEncoder(w).Encode(map[string]any{"exitCode": 0, "stdout": fmt.Sprintf("%d\n", memoryMiB), "manifest": body.Manifest, "changed": []string{}})
			return
		}
		// Through the store bridge, as a command reading a file does: a blob it hasn't is a 404 from the host.
		store := "unreachable"
		if res, err := storeClient.Get("http://store/blobs/" + strings.Repeat("0", 64)); err == nil {
			store = res.Status
			res.Body.Close()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"exitCode": 0, "stdout": "ran " + body.Command + "\n", "stderr": "store " + store, "manifest": body.Manifest, "changed": []string{}})
	})
	// What another account's runtime could reach, for the isolation test: it dials a socket and says how that went.
	mux.HandleFunc("POST /probe", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Path string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		result := "connected"
		if c, err := net.DialTimeout("unix", body.Path, time.Second); err != nil {
			result = err.Error()
		} else {
			c.Close()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": result, "uid": os.Getuid()})
	})
	network, address := dialAddress(*listen)
	l, err := net.Listen(network, address)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	_ = http.Serve(l, mux)
	return 0
}

func TestNativeRuntime(t *testing.T) {
	m, err := New(Config{Root: t.TempDir(), Runtime: "native", Binary: os.Args[0], Assets: t.TempDir(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	if m.RuntimeInfo() != nil {
		t.Fatal("runtime info before any runtime answered")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	m.Prepare(ctx)
	select {
	case <-m.Prepared():
	default:
		t.Fatal("Prepare returned before it was done")
	}
	want := proto.IsolateRuntime{Runtime: "deno_core", Version: "test", JavaScript: true, Python: false, MemoryEnforced: true}
	if got := m.RuntimeInfo(); got == nil || *got != want {
		t.Fatalf("runtime info after Prepare: %+v", got)
	}
	info, err := m.Create(ctx, proto.CreateParams{SandboxID: "iso_native", Owner: "acct"})
	if err != nil {
		t.Fatal(err)
	}
	if info.Isolate == nil || *info.Isolate != want {
		t.Fatalf("create answered isolate %+v", info.Isolate)
	}
	res, err := m.Exec(ctx, proto.ExecParams{SandboxID: "iso_native", Command: "echo hi"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 0 || res.Stdout != "ran echo hi\n" {
		t.Fatalf("exec: %+v", res)
	}
}

func TestNativeRuntimeThatNeverStarts(t *testing.T) {
	// A binary that exits at once: the start fails with what it printed, not after the full wait.
	m, err := New(Config{Root: t.TempDir(), Runtime: "native", Binary: os.Args[0], Assets: "/nonexistent", Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	began := time.Now()
	_, err = m.Create(context.Background(), proto.CreateParams{SandboxID: "iso_never", Owner: "acct"})
	if err == nil || !strings.Contains(err.Error(), "no assets directory") {
		t.Fatalf("create: %v", err)
	}
	if time.Since(began) > 10*time.Second {
		t.Fatalf("took %v to fail", time.Since(began))
	}
}

func TestReseed(t *testing.T) {
	var got map[string]string
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/reseed" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(status)
	}))
	defer srv.Close()
	m := &Manager{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	r := &runtime{client: &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", srv.Listener.Addr().String())
	}}}}
	if err := m.reseed(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if len(got["entropy"]) < 64 {
		t.Fatalf("reseed sent %q", got)
	}
	// A runtime from before /reseed is left as it is; one that fails it fails the start.
	status = http.StatusNotFound
	if err := m.reseed(context.Background(), r); err != nil {
		t.Fatalf("a runtime without /reseed: %v", err)
	}
	status = http.StatusInternalServerError
	if err := m.reseed(context.Background(), r); err == nil {
		t.Fatal("a failed /reseed passed")
	}
}
