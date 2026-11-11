//go:build vmtest

// Real-VM tests of the isolate tier: isolate VMs (Firecracker microVMs running the isolate runtime, kantel-isolate)
// booted, snapshotted and restored through the tier's own code (package isolate), and commands run in their sandboxes
// as the control plane runs them (Host.Call).
//
//	KANTEL_VMTEST_IMAGES=/images KANTEL_VMTEST_FIRECRACKER=/opt/kantel/firecracker \
//	  go test -tags vmtest -run IsolateVM -v ./internal/agent/
//
// KANTEL_VMTEST_IMAGES holds vmlinux-x86_64 and isolate-amd64.ext4 (KANTEL_VMTEST_ISOLATE_IMAGE names another file
// there, such as an older image to compare with). KANTEL_VMTEST_SHELL_ONLY=1 leaves out node and python, for an image
// whose runtime has neither (workerd's). Like the isolation tests, run them in a privileged container
// (apps/host/test/isolate.sh does).
package agent

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func TestIsolateVM(t *testing.T) {
	images := os.Getenv("KANTEL_VMTEST_IMAGES")
	firecracker := os.Getenv("KANTEL_VMTEST_FIRECRACKER")
	if images == "" || firecracker == "" || os.Geteuid() != 0 {
		t.Skip("needs root, KANTEL_VMTEST_IMAGES and KANTEL_VMTEST_FIRECRACKER")
	}
	image := os.Getenv("KANTEL_VMTEST_ISOLATE_IMAGE")
	if image == "" {
		image = "isolate-amd64.ext4"
	}
	shellOnly := os.Getenv("KANTEL_VMTEST_SHELL_ONLY") == "1"
	root := t.TempDir()
	cfg := Config{
		Root: root, Kernel: filepath.Join(images, "vmlinux-x86_64"), IsolateImage: filepath.Join(images, image),
		Firecracker: firecracker, Tiers: []string{"isolate"}, Egress: "open",
	}
	cfg.Defaults()
	h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)

	exec := func(id, command string, timeoutMs int64) (proto.ExecResult, time.Duration) {
		t.Helper()
		began := time.Now()
		res := vmCall[proto.ExecResult](t, h, proto.MethodExec, proto.ExecParams{SandboxID: id, Command: command, TimeoutMs: timeoutMs})
		return res, time.Since(began)
	}
	want := func(id, command, stdout string) time.Duration {
		t.Helper()
		res, took := exec(id, command, 30_000)
		if res.ExitCode != 0 || strings.TrimSpace(res.Stdout) != stdout {
			t.Fatalf("%s: %q: exit %d, stdout %q, stderr %q (want %q)", id, command, res.ExitCode, res.Stdout, res.Stderr, stdout)
		}
		t.Logf("%s: %q: %s in %v", id, command, stdout, took.Round(time.Millisecond))
		return took
	}
	create := func(id, owner string) (proto.SandboxInfo, time.Duration) {
		t.Helper()
		began := time.Now()
		info := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: id, Tier: "isolate", Owner: owner})
		took := time.Since(began)
		raw, _ := json.Marshal(info.Timings)
		t.Logf("create %s (account %s): %v, source %s, timings %s", id, owner, took.Round(time.Millisecond), info.Source, raw)
		return info, took
	}

	// The first create boots the template (the VM with the runtime up and isolates loaded), snapshots it and restores
	// the account's VM from it.
	a, coldCreate := create("sbx_iso_a", "acct_a")
	if a.State != proto.StateRunning {
		t.Fatalf("a: %+v", a)
	}
	if raw, err := os.ReadFile(filepath.Join(root, "isolate", "template", "ready")); err == nil {
		t.Logf("template: %s", raw)
	}
	firstA := want("sbx_iso_a", "echo hello", "hello")
	want("sbx_iso_a", "echo hello", "hello")

	// Files: a command's writes are the next one's files.
	want("sbx_iso_a", "mkdir -p src && echo 'one two' > src/a.txt && echo done", "done")
	want("sbx_iso_a", "cat src/a.txt | wc -w", "2")
	want("sbx_iso_a", "cd src && ls", "a.txt")

	if !shellOnly {
		want("sbx_iso_a", `node -e 'console.log(1 + 1)'`, "2")
		want("sbx_iso_a", `node -e 'require("fs").writeFileSync("from-node.txt", "written by node")' && cat from-node.txt`, "written by node")
		want("sbx_iso_a", `python3 -c 'print(6 * 7)'`, "42")
		want("sbx_iso_a", `python3 -c 'print(open("/workspace/src/a.txt").read().strip())'`, "one two")
		// Each run is a fresh isolate (python's restored from one memory snapshot): its random numbers its own.
		for _, command := range []string{`node -e 'console.log(Math.random())'`, `python3 -c 'import random; print(random.random())'`} {
			one, _ := exec("sbx_iso_a", command, 30_000)
			two, _ := exec("sbx_iso_a", command, 30_000)
			t.Logf("%q twice: %q, %q", command, strings.TrimSpace(one.Stdout), strings.TrimSpace(two.Stdout))
			if one.ExitCode != 0 || strings.TrimSpace(one.Stdout) == strings.TrimSpace(two.Stdout) {
				t.Errorf("%q drew the same number in two runs (exit %d: %s)", command, one.ExitCode, one.Stderr)
			}
		}
	}

	// Containment: a command that never ends is stopped, and the sandbox goes on.
	loops := []string{"while true; do :; done"}
	if !shellOnly {
		loops = append(loops, `node -e 'for (;;) {}'`, `python3 -c 'while True: pass'`)
	}
	for _, loop := range loops {
		res, took := exec("sbx_iso_a", loop, 5_000)
		t.Logf("loop %q: exit %d, timed out %v, in %v, stderr %q", loop, res.ExitCode, res.TimedOut, took.Round(time.Millisecond), firstLine(res.Stderr))
		if res.ExitCode == 0 {
			t.Fatalf("loop %q ended with exit 0", loop)
		}
		if took > 20*time.Second {
			t.Fatalf("loop %q took %v to stop", loop, took)
		}
		want("sbx_iso_a", "cat src/a.txt", "one two")
	}

	// Another account: its own VM, restored from the template snapshot.
	time.Sleep(2 * time.Second)
	b, warmCreate := create("sbx_iso_b", "acct_b")
	if b.State != proto.StateRunning {
		t.Fatalf("b: %+v", b)
	}
	firstB := want("sbx_iso_b", "echo hello", "hello")
	if res, _ := exec("sbx_iso_b", "cat src/a.txt", 10_000); res.ExitCode == 0 {
		t.Fatalf("b sees a's files: %q", res.Stdout)
	}
	// The restored VM's clock was set from the host's (SetIdentity).
	res, _ := exec("sbx_iso_b", "date +%s", 10_000)
	if guest, err := strconv.ParseInt(strings.TrimSpace(res.Stdout), 10, 64); err != nil {
		t.Fatalf("date: %q %q", res.Stdout, res.Stderr)
	} else if skew := time.Now().Unix() - guest; skew < -5 || skew > 5 {
		t.Fatalf("restored VM's clock is %ds off", skew)
	}
	// Each VM restored from one snapshot has random numbers of its own, in the isolates its template had loaded too
	// (the shell's, and node's and python's pools): two more accounts' VMs, each asked first thing.
	draws := map[string][]string{}
	for _, id := range []string{"sbx_iso_c", "sbx_iso_d"} {
		create(id, "acct_"+id)
		commands := []string{"echo $RANDOM $RANDOM"}
		if !shellOnly {
			commands = append(commands, `node -e 'console.log(Math.random(), crypto.randomUUID())'`,
				`python3 -c 'import random, os; print(random.random(), os.urandom(8).hex())'`)
		}
		for _, command := range commands {
			res, _ := exec(id, command, 10_000)
			if res.ExitCode != 0 {
				t.Fatalf("%s: %q: exit %d: %s", id, command, res.ExitCode, res.Stderr)
			}
			draws[id] = append(draws[id], strings.TrimSpace(res.Stdout))
		}
	}
	t.Logf("random draws: c %q, d %q", draws["sbx_iso_c"], draws["sbx_iso_d"])
	for i := range draws["sbx_iso_c"] {
		if draws["sbx_iso_c"][i] == draws["sbx_iso_d"][i] {
			t.Errorf("two VMs restored from one template drew the same numbers: %q", draws["sbx_iso_c"][i])
		}
	}
	// A second sandbox of account a: its VM is already up.
	_, sameAccount := create("sbx_iso_a2", "acct_a")
	firstA2 := want("sbx_iso_a2", "echo hello", "hello")

	t.Logf("TIMINGS cold create (template boot + snapshot + restore) %v; first command %v", coldCreate.Round(time.Millisecond), firstA.Round(time.Millisecond))
	t.Logf("TIMINGS restore create (new account, template restored) %v; first command %v", warmCreate.Round(time.Millisecond), firstB.Round(time.Millisecond))
	t.Logf("TIMINGS same-account create %v; first command %v", sameAccount.Round(time.Millisecond), firstA2.Round(time.Millisecond))
	for _, id := range []string{"sbx_iso_a", "sbx_iso_a2", "sbx_iso_b", "sbx_iso_c", "sbx_iso_d"} {
		vmCall[any](t, h, proto.MethodDelete, map[string]string{"sandboxId": id})
	}
}

// TestIsolateNative runs the isolate tier with the native runtime (isolateRuntime "native": kantel-isolate on this
// machine, no VM), as a host without KVM does. It needs neither root nor KVM:
//
//	KANTEL_VMTEST_ISOLATE_BINARY=/path/kantel-isolate KANTEL_VMTEST_ISOLATE_ASSETS=/path/assets \
//	  go test -tags vmtest -run IsolateNative -v ./internal/agent/
func TestIsolateNative(t *testing.T) {
	binary, assets := os.Getenv("KANTEL_VMTEST_ISOLATE_BINARY"), os.Getenv("KANTEL_VMTEST_ISOLATE_ASSETS")
	if binary == "" || assets == "" {
		t.Skip("needs KANTEL_VMTEST_ISOLATE_BINARY and KANTEL_VMTEST_ISOLATE_ASSETS")
	}
	cfg := Config{Root: t.TempDir(), Tiers: []string{"isolate"}, IsolateRuntime: "native", IsolateBinary: binary, IsolateAssets: assets, Egress: "open"}
	cfg.Defaults()
	h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	select {
	case <-h.tiers["isolate"].(interface{ Prepared() <-chan struct{} }).Prepared():
	case <-time.After(time.Minute):
		t.Fatal("the native runtime never started")
	}
	if f := h.Facts(); f.Isolate == nil || !f.Isolate.JavaScript {
		t.Fatalf("facts: %+v", f.Isolate)
	}
	began := time.Now()
	info := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sbx_native", Tier: "isolate", Owner: "acct"})
	t.Logf("create: %v, isolate %+v", time.Since(began).Round(time.Millisecond), info.Isolate)
	for command, want := range map[string]string{
		"echo hello > a.txt && cat a.txt":                                           "hello",
		`node -e 'console.log(require("fs").readFileSync("a.txt", "utf8").trim())'`: "hello",
		`python3 -c 'print(open("a.txt").read().strip())'`:                          "hello",
	} {
		began := time.Now()
		res := vmCall[proto.ExecResult](t, h, proto.MethodExec, proto.ExecParams{SandboxID: "sbx_native", Command: command, TimeoutMs: 30_000})
		if res.ExitCode != 0 || strings.TrimSpace(res.Stdout) != want {
			t.Fatalf("%q: exit %d, %q, %q", command, res.ExitCode, res.Stdout, res.Stderr)
		}
		t.Logf("%q: %s in %v", command, want, time.Since(began).Round(time.Millisecond))
	}
	vmCall[any](t, h, proto.MethodDelete, map[string]string{"sandboxId": "sbx_native"})
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return line
}
