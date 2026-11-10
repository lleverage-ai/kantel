package agent

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// envTier keeps each sandbox's env as microvm and isolate keep it in meta.json, and runs a guest's commands as a
// shell would (sh -c with stdin) against a directory standing in for the guest's /.
type envTier struct {
	Tier // unimplemented methods panic

	mu      sync.Mutex
	name    string
	env     map[string]map[string]string
	state   map[string]string
	execs   []proto.ExecParams
	root    string
	failRun bool
}

func newEnvTier(t *testing.T, name string) *envTier {
	return &envTier{name: name, env: map[string]map[string]string{}, state: map[string]string{}, root: t.TempDir()}
}

func (f *envTier) Get(id string) (proto.SandboxInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	state, ok := f.state[id]
	if !ok {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: id}
	}
	return proto.SandboxInfo{ID: id, Tier: f.name, State: state}, nil
}

func (f *envTier) SetEnv(id string, env map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.state[id]; !ok {
		return &proto.Error{Code: proto.ErrNotFound, Message: id}
	}
	f.env[id] = maps.Clone(env)
	return nil
}

// Exec runs the command with the guest's paths moved under root: what a root shell in the guest would do.
func (f *envTier) Exec(ctx context.Context, p proto.ExecParams, _ func(string, string)) (proto.ExecResult, error) {
	f.mu.Lock()
	f.execs = append(f.execs, p)
	fail := f.failRun
	f.mu.Unlock()
	if fail {
		return proto.ExecResult{ExitCode: 1, Stderr: "mv: read-only file system\n"}, nil
	}
	if len(p.Argv) != 3 || p.Argv[0] != "/bin/sh" || p.Argv[1] != "-c" || p.User != "root" {
		return proto.ExecResult{}, errors.New("not a root sh -c")
	}
	script := strings.ReplaceAll(p.Argv[2], "/etc/kantel", filepath.Join(f.root, "etc/kantel"))
	stdin, err := base64.StdEncoding.DecodeString(p.Stdin)
	if err != nil {
		return proto.ExecResult{}, err
	}
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", script)
	cmd.Stdin = strings.NewReader(string(stdin))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	res := proto.ExecResult{}
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return proto.ExecResult{}, err
		}
		res.ExitCode = exit.ExitCode()
	}
	res.Stderr = stderr.String()
	return res, nil
}

func (f *envTier) guestFile() string { return filepath.Join(f.root, guest.EnvFile) }

func (f *envTier) execCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.execs)
}

func newEnvHost(t *testing.T, tier *envTier) *Host {
	t.Helper()
	return &Host{
		cfg: Config{Root: t.TempDir()}, log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		tiers: map[string]Tier{tier.name: tier}, order: []string{tier.name}, bySlot: map[int]egress.Rules{},
	}
}

// readEnvFile reads an env file as the guest agent's commandEnv does.
func readEnvFile(t *testing.T, path string) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok && k != "" {
			unq, err := strconv.Unquote(v)
			if err != nil {
				t.Fatalf("line %q: %v", line, err)
			}
			out[k] = unq
		}
	}
	return out
}

// A running microVM's env is replaced where the host keeps it, and its guest's env file rewritten in place, quoting
// and all: values the shell would expand or split come through exactly, as nothing passes through the shell but the
// file's bytes on stdin. An empty env removes the file, as the guest agent does at boot.
func TestSandboxEnvRewritesARunningMicroVMsEnvFile(t *testing.T) {
	tier := newEnvTier(t, microvm.Tier)
	tier.state["sbx_1"] = proto.StateRunning
	h := newEnvHost(t, tier)
	env := map[string]string{
		"GH_TOKEN": "kph_attached",
		"TRICKY":   "$(touch /tmp/pwned) `id` 'single' \"double\"\nsecond line\\",
		"EMPTY":    "",
	}
	if err := call(t, h, proto.MethodEnv, proto.EnvParams{SandboxID: "sbx_1", Env: env}); err != nil {
		t.Fatal(err)
	}
	if !maps.Equal(tier.env["sbx_1"], env) {
		t.Fatalf("the host keeps %v", tier.env["sbx_1"])
	}
	if got := readEnvFile(t, tier.guestFile()); !maps.Equal(got, env) {
		t.Fatalf("the guest's file holds %q", got)
	}
	last := tier.execs[len(tier.execs)-1]
	if strings.Contains(last.Argv[2], "kph_attached") || slices.ContainsFunc(last.Argv, func(a string) bool { return strings.Contains(a, "pwned") }) {
		t.Fatalf("a value went into the command: %q", last.Argv)
	}
	if info, _ := os.Stat(tier.guestFile()); info.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", info.Mode().Perm())
	}

	// Detached: the variables it had go, the file is exactly the new env.
	if err := call(t, h, proto.MethodEnv, proto.EnvParams{SandboxID: "sbx_1", Env: map[string]string{"ONLY": "this"}}); err != nil {
		t.Fatal(err)
	}
	if got := readEnvFile(t, tier.guestFile()); !maps.Equal(got, map[string]string{"ONLY": "this"}) {
		t.Fatalf("the guest's file holds %q", got)
	}
	if _, err := os.Stat(tier.guestFile() + ".new"); !os.IsNotExist(err) {
		t.Fatalf("the temporary file was left: %v", err)
	}

	// None at all: no file, and none to remove again is no error.
	for range 2 {
		if err := call(t, h, proto.MethodEnv, proto.EnvParams{SandboxID: "sbx_1"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(tier.guestFile()); !os.IsNotExist(err) {
		t.Fatalf("an empty env left the file: %v", err)
	}
	if len(tier.env["sbx_1"]) != 0 {
		t.Fatalf("the host keeps %v", tier.env["sbx_1"])
	}
}

// A stopped microVM, and an isolate (whose commands read the host's record), have only the host's record changed:
// the stopped one's guest gets the env with its identity when it boots.
func TestSandboxEnvOfAStoppedMicroVMOrAnIsolateChangesOnlyTheRecord(t *testing.T) {
	stopped := newEnvTier(t, microvm.Tier)
	stopped.state["sbx_1"] = proto.StateStopped
	iso := newEnvTier(t, isolate.Tier)
	iso.state["iso_1"] = proto.StateRunning
	for id, tier := range map[string]*envTier{"sbx_1": stopped, "iso_1": iso} {
		h := newEnvHost(t, tier)
		if err := call(t, h, proto.MethodEnv, proto.EnvParams{SandboxID: id, Env: map[string]string{"A": "1"}}); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		if !maps.Equal(tier.env[id], map[string]string{"A": "1"}) || tier.execCount() != 0 {
			t.Fatalf("%s: kept %v, %d commands run", id, tier.env[id], tier.execCount())
		}
	}
}

// An env from a change older than one the host has taken (delivered late, from another gateway) leaves the newer one.
func TestSandboxEnvOlderThanTheHostHasIsIgnored(t *testing.T) {
	tier := newEnvTier(t, microvm.Tier)
	tier.state["sbx_1"] = proto.StateStopped
	h := newEnvHost(t, tier)
	if err := call(t, h, proto.MethodEnv, proto.EnvParams{SandboxID: "sbx_1", Env: map[string]string{"NEW": "1"}, Revision: 20}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, h, proto.MethodEnv, proto.EnvParams{SandboxID: "sbx_1", Env: map[string]string{"OLD": "1"}, Revision: 10}); err != nil {
		t.Fatal(err)
	}
	if !maps.Equal(tier.env["sbx_1"], map[string]string{"NEW": "1"}) {
		t.Fatalf("kept %v, want the newer env", tier.env["sbx_1"])
	}
	if err := call(t, h, proto.MethodEnv, proto.EnvParams{SandboxID: "sbx_1", Env: map[string]string{"SAME": "1"}, Revision: 20}); err != nil {
		t.Fatal(err)
	}
	if !maps.Equal(tier.env["sbx_1"], map[string]string{"SAME": "1"}) {
		t.Fatalf("kept %v, want the same revision taken again", tier.env["sbx_1"])
	}
}

// A guest that can't write the file fails the call, saying so, with the host's record changed already (its next boot
// has the env); an unknown sandbox and a call without one are refused.
func TestSandboxEnvFailures(t *testing.T) {
	tier := newEnvTier(t, microvm.Tier)
	tier.state["sbx_1"] = proto.StateRunning
	tier.failRun = true
	h := newEnvHost(t, tier)
	err := call(t, h, proto.MethodEnv, proto.EnvParams{SandboxID: "sbx_1", Env: map[string]string{"A": "1"}})
	if err == nil || !strings.Contains(err.Error(), "read-only file system") {
		t.Fatalf("a failed rewrite: %v", err)
	}
	if !maps.Equal(tier.env["sbx_1"], map[string]string{"A": "1"}) {
		t.Fatalf("the host keeps %v", tier.env["sbx_1"])
	}
	var perr *proto.Error
	if err := call(t, h, proto.MethodEnv, proto.EnvParams{SandboxID: "sbx_nope"}); !errors.As(err, &perr) || perr.Code != proto.ErrNotFound {
		t.Fatalf("an unknown sandbox: %v", err)
	}
	if err := call(t, h, proto.MethodEnv, proto.EnvParams{}); !errors.As(err, &perr) || perr.Code != proto.ErrInvalid {
		t.Fatalf("no sandbox: %v", err)
	}
}

// Hosts say they take sandbox.env.
func TestFactsAdvertiseSandboxEnv(t *testing.T) {
	h := newEnvHost(t, newEnvTier(t, isolate.Tier))
	if facts := h.makeFacts(); !slices.Contains(facts.Features, proto.FeatureSandboxEnv) {
		t.Fatalf("features %v", facts.Features)
	}
}
