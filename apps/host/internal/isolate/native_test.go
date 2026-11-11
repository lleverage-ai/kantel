package isolate

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func nativeManager(t *testing.T, cfg Config) *Manager {
	t.Helper()
	cfg.Runtime = "native"
	if cfg.Root == "" {
		cfg.Root = t.TempDir()
	}
	cfg.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	return m
}

func TestNativeRuntimeOverUnixSockets(t *testing.T) {
	m := nativeManager(t, Config{Binary: os.Args[0], Assets: t.TempDir()})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := m.Create(ctx, proto.CreateParams{SandboxID: "iso_unix", Owner: "acct"}); err != nil {
		t.Fatal(err)
	}
	res, err := m.Exec(ctx, proto.ExecParams{SandboxID: "iso_unix", Command: "cat x"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The runtime reached the host's store over its socket (a blob it doesn't have: 404).
	if res.Stdout != "ran cat x\n" || res.Stderr != "store 404 Not Found" {
		t.Fatalf("exec: %+v", res)
	}
	m.mu.Lock()
	dir := m.runtimes["acct"].dir
	m.mu.Unlock()
	if st, err := os.Stat(dir); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("runtime directory: %v %v", st.Mode(), err)
	}
	for _, name := range []string{"runtime.sock", "store.sock", "egress.sock"} {
		st, err := os.Stat(filepath.Join(dir, name))
		if err != nil || st.Mode()&os.ModeSocket == 0 {
			t.Fatalf("%s: %v", name, err)
		}
		if name != "runtime.sock" && st.Mode().Perm() != 0o600 {
			t.Fatalf("%s is %v", name, st.Mode().Perm())
		}
	}
	if st, err := os.Stat(m.cfg.RunDir); err != nil || st.Mode().Perm() != 0o711 {
		t.Fatalf("run directory: %v %v", st.Mode(), err)
	}
}

func TestVersionTakesUnix(t *testing.T) {
	for out, want := range map[string]bool{
		`{"version":"1","unixSockets":true}`:  true,
		`{"version":"1","unixSockets":false}`: false,
		`{"version":"1"}`:                     false,
		`kantel-isolate 1.0`:                  false,
	} {
		if got := versionTakesUnix([]byte(out)); got != want {
			t.Errorf("%s: %v", out, got)
		}
	}
}

// A native host updated by its binary alone has workerd and its worker, and no kantel-isolate: it runs workerd.
func TestNativeWorkerdFallback(t *testing.T) {
	bundle := t.TempDir()
	config := `const config :Workerd.Config = (
  services = [
    (name = "store", external = (address = "127.0.0.1:7001", http = ())),
    (name = "egress", external = (address = "127.0.0.1:7002", http = (style = proxy))),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8080", http = (), service = "isolate"),
  ],
);
`
	if err := os.WriteFile(filepath.Join(bundle, "config.capnp"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	m := nativeManager(t, Config{LegacyWorkerd: os.Args[0], LegacyBundle: bundle})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	info, err := m.Create(ctx, proto.CreateParams{SandboxID: "iso_workerd", Owner: "acct"})
	if err != nil {
		t.Fatal(err)
	}
	if info.Isolate == nil || info.Isolate.Runtime != "" || info.Isolate.JavaScript {
		t.Fatalf("workerd's runtime info: %+v", info.Isolate)
	}
	res, err := m.Exec(ctx, proto.ExecParams{SandboxID: "iso_workerd", Command: "echo"}, nil)
	if err != nil || res.Stdout != "workerd\n" {
		t.Fatalf("exec: %+v %v", res, err)
	}
}

// As root, each account's runtime is a uid of its own in a cgroup of its own, and can reach none of another
// account's sockets: neither its runtime's nor the host's store and egress bridges for it. (Run as root, as
// apps/host/test/isolate.sh does.)
func TestNativeRuntimesApart(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root")
	}
	runDir := fmt.Sprintf("/run/kantel-isolate-test-%d", os.Getpid())
	t.Cleanup(func() { _ = os.RemoveAll(runDir) })
	cgroups := fmt.Sprintf("/sys/fs/cgroup/kantel-isolate-test-%d", os.Getpid())
	t.Cleanup(func() { _ = os.Remove(cgroups) })
	m := nativeManager(t, Config{Binary: os.Args[0], Assets: t.TempDir(), RunDir: runDir, CgroupRoot: cgroups, MemoryMiB: 512})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	runtimes := map[string]*runtime{}
	for _, account := range []string{"acct_a", "acct_b"} {
		if _, err := m.Create(ctx, proto.CreateParams{SandboxID: "iso_" + account, Owner: account}); err != nil {
			t.Fatal(err)
		}
		m.mu.Lock()
		runtimes[account] = m.runtimes[account]
		m.mu.Unlock()
	}
	a, b := runtimes["acct_a"], runtimes["acct_b"]
	probe := func(r *runtime, path string) (string, int) {
		var out struct {
			Result string `json:"result"`
			UID    int    `json:"uid"`
		}
		if err := r.call(ctx, "/probe", map[string]string{"path": path}, &out); err != nil {
			t.Fatal(err)
		}
		return out.Result, out.UID
	}
	result, uidA := probe(a, filepath.Join(a.dir, "store.sock"))
	if result != "connected" {
		t.Fatalf("a can't reach its own store: %s", result)
	}
	_, uidB := probe(b, filepath.Join(b.dir, "store.sock"))
	if uidA == 0 || uidB == 0 || uidA == uidB {
		t.Fatalf("runtimes' uids: a %d, b %d", uidA, uidB)
	}
	for _, name := range []string{"runtime.sock", "store.sock", "egress.sock"} {
		if result, _ := probe(a, filepath.Join(b.dir, name)); !strings.Contains(result, "permission denied") {
			t.Errorf("a reaching b's %s: %s", name, result)
		}
	}
	for _, r := range []*runtime{a, b} {
		dir := filepath.Join(cgroups, filepath.Base(r.dir))
		procs, err := os.ReadFile(filepath.Join(dir, "cgroup.procs"))
		if err != nil || !strings.Contains(string(procs), strconv.Itoa(r.proc.Pid)) {
			t.Fatalf("%s's cgroup holds %q (%v), not its runtime %d", r.dir, procs, err, r.proc.Pid)
		}
		for file, want := range map[string]string{"memory.max": strconv.Itoa(512 << 20), "pids.max": strconv.Itoa(NativePids)} {
			if got, _ := os.ReadFile(filepath.Join(dir, file)); strings.TrimSpace(string(got)) != want {
				t.Errorf("%s: %q, want %s", file, got, want)
			}
		}
	}
	// A closed runtime's cgroup is gone, and its uid free again.
	m.Close()
	if _, err := os.Stat(filepath.Join(cgroups, filepath.Base(a.dir))); !os.IsNotExist(err) {
		t.Fatalf("a's cgroup after close: %v", err)
	}
}

// The runtime drops an idle session (after 15 minutes, at its live-isolate cap, or on /reseed) and the next /exec
// makes it again: that /exec must carry the sandbox's memory, or the isolate comes back at the runtime's default.
func TestExecCarriesTheSandboxMemory(t *testing.T) {
	m := nativeManager(t, Config{Binary: os.Args[0], Assets: t.TempDir()})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := m.Create(ctx, proto.CreateParams{SandboxID: "iso_mem", Owner: "acct", MemoryMiB: 512}); err != nil {
		t.Fatal(err)
	}
	memory := func() string {
		t.Helper()
		res, err := m.Exec(ctx, proto.ExecParams{SandboxID: "iso_mem", Command: "memory"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(res.Stdout)
	}
	evict := func() {
		t.Helper()
		m.mu.Lock()
		r := m.runtimes["acct"]
		m.mu.Unlock()
		if err := r.call(ctx, "/evict", map[string]any{}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if got := memory(); got != "512" {
		t.Fatalf("loaded isolate has %s MiB, want 512", got)
	}
	evict()
	if got := memory(); got != "512" {
		t.Fatalf("isolate made again by /exec has %s MiB, want 512", got)
	}
	// A sandbox made before memory was recorded (0 in its metadata) runs at the default, as /load gives it.
	s, err := m.get("iso_mem")
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.meta.MemoryMiB = 0
	s.mu.Unlock()
	evict()
	if got := memory(); got != strconv.Itoa(DefaultMemoryMiB) {
		t.Fatalf("older isolate made again by /exec has %s MiB, want %d", got, DefaultMemoryMiB)
	}
}
