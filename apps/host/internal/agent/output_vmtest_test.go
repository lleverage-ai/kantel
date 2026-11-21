//go:build vmtest

// Real-VM test of a command's kept output (sandbox.exec.output): a microVM's guest agent keeps each stream of a
// command run with an ID on the sandbox's disk, past the 1 MiB its result holds, readable while it runs, after it ends,
// after the sandbox stops and starts again, and after its machine is killed.
//
//	KANTEL_VMTEST_IMAGES=/images KANTEL_VMTEST_FIRECRACKER=/opt/kantel/firecracker KANTEL_VMTEST_AGENT=/opt/kantel-guest \
//	  go test -tags vmtest -run CommandOutput -v ./internal/agent/
//
// KANTEL_VMTEST_AGENT is a static kantel-guest built from this tree, injected at boot (injectGuestAgent), so the test
// runs this tree's agent whatever the image ships. Run it in a privileged container (apps/host/test/isolation.sh shows
// how, with KANTEL_VMTEST_RUN=CommandOutput).
package agent

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// readOutput reads a command's whole kept stream through sandbox.exec.output, a MiB at a time, with its last answer.
func readOutput(t *testing.T, h *Host, sandbox, command, stream string) ([]byte, proto.ExecOutput) {
	t.Helper()
	var all []byte
	for {
		out := vmCall[proto.ExecOutput](t, h, proto.MethodExecOutput, proto.ExecOutputParams{SandboxID: sandbox, CommandID: command, Stream: stream, Offset: int64(len(all))})
		data, err := base64.StdEncoding.DecodeString(out.Data)
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, data...)
		if int64(len(all)) >= out.Size || len(data) == 0 {
			return all, out
		}
	}
}

// seqOutput is what `seq 1 n` prints.
func seqOutput(n int) []byte {
	var b bytes.Buffer
	for i := 1; i <= n; i++ {
		fmt.Fprintf(&b, "%d\n", i)
	}
	return b.Bytes()
}

func TestCommandOutputOutlivesItsMachine(t *testing.T) {
	images := os.Getenv("KANTEL_VMTEST_IMAGES")
	firecracker := os.Getenv("KANTEL_VMTEST_FIRECRACKER")
	agent := os.Getenv("KANTEL_VMTEST_AGENT")
	if images == "" || firecracker == "" || agent == "" || os.Geteuid() != 0 {
		t.Skip("needs root, KANTEL_VMTEST_IMAGES, KANTEL_VMTEST_FIRECRACKER and KANTEL_VMTEST_AGENT")
	}
	cfg := Config{
		Root: t.TempDir(), Kernel: filepath.Join(images, "vmlinux-x86_64"), SandboxImage: filepath.Join(images, "sandbox-amd64.ext4"),
		Firecracker: firecracker, Tiers: []string{"microvm"}, Egress: "open", SpoolMaxMiB: -1,
		InjectGuestAgent: true, GuestAgent: agent,
	}
	cfg.Defaults()
	h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.Close)
	if !strings.Contains(strings.Join(h.Facts().Features, " "), proto.FeatureExecOutput) {
		t.Fatalf("the host doesn't report %s: %v", proto.FeatureExecOutput, h.Facts().Features)
	}
	const id = "sbx_output_1"
	vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: id, Tier: "microvm", Size: "default"})
	t.Cleanup(func() { _ = call(t, h, proto.MethodDelete, proto.SandboxRef{SandboxID: id}) })

	// A foreground command with an ID, as Kantel runs one: about 6.6 MB of stdout, its result cut at 1 MiB.
	const lines = 900_000
	want := seqOutput(lines)
	started := time.Now()
	res := vmCall[proto.ExecResult](t, h, proto.MethodExec, proto.ExecParams{SandboxID: id, CommandID: "cmd_seq", Command: fmt.Sprintf("seq 1 %d; echo done >&2", lines), TimeoutMs: 120_000})
	if res.ExitCode != 0 || !res.Truncated || len(res.Stdout) != 1<<20 {
		t.Fatalf("its result: exit %d, truncated %v, %d bytes of stdout", res.ExitCode, res.Truncated, len(res.Stdout))
	}
	t.Logf("cmd_seq ran in %s: %d bytes of stdout, its result %d bytes (truncated)", time.Since(started).Round(time.Millisecond), len(want), len(res.Stdout))
	check := func(when string) {
		t.Helper()
		started := time.Now()
		got, last := readOutput(t, h, id, "cmd_seq", proto.ExecStdout)
		if !bytes.Equal(got, want) || !last.Ended || last.Truncated || last.Size != int64(len(want)) {
			t.Fatalf("%s: read %d of %d bytes (equal %v), last part %+v", when, len(got), len(want), bytes.Equal(got, want), last)
		}
		if stderr, _ := readOutput(t, h, id, "cmd_seq", proto.ExecStderr); !strings.HasSuffix(string(stderr), "done\n") {
			t.Fatalf("%s: stderr %q", when, stderr)
		}
		t.Logf("%s: read all %d bytes of cmd_seq's stdout in %s (ended %v, truncated %v, limit %d)", when, len(got), time.Since(started).Round(time.Millisecond), last.Ended, last.Truncated, last.Limit)
	}
	check("once it ended")

	// A detached command, read while it runs past 1 MiB, then killed.
	vmCall[proto.ExecStatus](t, h, proto.MethodExec, proto.ExecParams{SandboxID: id, CommandID: "cmd_live", Detached: true, Command: "seq 1 300000; sleep 600"})
	deadline := time.Now().Add(time.Minute)
	for {
		out := vmCall[proto.ExecOutput](t, h, proto.MethodExecOutput, proto.ExecOutputParams{SandboxID: id, CommandID: "cmd_live", Stream: proto.ExecStdout, Offset: 1 << 20, Length: 16})
		if out.Size == int64(len(seqOutput(300_000))) {
			if out.Ended {
				t.Fatalf("cmd_live reads as ended while it runs: %+v", out)
			}
			data, _ := base64.StdEncoding.DecodeString(out.Data)
			if wantPart := seqOutput(300_000)[1<<20 : 1<<20+16]; !bytes.Equal(data, wantPart) {
				t.Fatalf("cmd_live's 16 bytes past 1 MiB: %q, want %q", data, wantPart)
			}
			t.Logf("cmd_live, running: %d bytes kept, 16 bytes read from 1 MiB: %q", out.Size, data)
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("cmd_live's output never all came: %+v", out)
		}
		time.Sleep(200 * time.Millisecond)
	}
	vmCall[proto.ExecKilled](t, h, proto.MethodExecKill, proto.ExecRef{SandboxID: id, CommandID: "cmd_live"})

	// A stop that lets its memory go, and a cold start.
	vmCall[map[string]any](t, h, proto.MethodStop, proto.StopParams{SandboxID: id, SnapshotID: "snap_output_1", Memory: new(bool)})
	vmCall[map[string]any](t, h, proto.MethodStart, proto.ResumeParams{SandboxID: id})
	check("after a stop and a start")

	// Its machine killed (as an out-of-memory host kills it) as a command runs, its output all written over 2 s
	// (guest.OutputSyncEvery) before, then started again: both commands' output is there, the running one's ended.
	crash := seqOutput(200_000)
	vmCall[proto.ExecStatus](t, h, proto.MethodExec, proto.ExecParams{SandboxID: id, CommandID: "cmd_crash", Detached: true, Command: "seq 1 200000; sleep 600"})
	deadline = time.Now().Add(time.Minute)
	for vmCall[proto.ExecOutput](t, h, proto.MethodExecOutput, proto.ExecOutputParams{SandboxID: id, CommandID: "cmd_crash", Stream: proto.ExecStdout, Length: 1}).Size != int64(len(crash)) {
		if time.Now().After(deadline) {
			t.Fatal("cmd_crash's output never all came")
		}
		time.Sleep(200 * time.Millisecond)
	}
	time.Sleep(3 * time.Second)
	killMachine(t, id)
	deadline = time.Now().Add(time.Minute)
	for {
		info := vmCall[proto.SandboxInfo](t, h, proto.MethodGet, proto.SandboxRef{SandboxID: id})
		if info.State != proto.StateRunning {
			t.Logf("after its machine was killed: %s (%s)", info.State, info.Error)
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the host never saw its machine go")
		}
		time.Sleep(200 * time.Millisecond)
	}
	vmCall[map[string]any](t, h, proto.MethodStart, proto.ResumeParams{SandboxID: id})
	check("after its machine was killed and it started again")
	// Read as cut: it ended with its machine, so what it wrote last may not have reached the disk (here all of it had).
	if got, last := readOutput(t, h, id, "cmd_crash", proto.ExecStdout); !bytes.Equal(got, crash) || !last.Ended || !last.Truncated {
		t.Fatalf("cmd_crash, running as its machine was killed: %d of %d bytes, last part %+v", len(got), len(crash), last)
	} else {
		t.Logf("cmd_crash, running as its machine was killed: all %d bytes kept, ended %v, read as cut %v", len(got), last.Ended, last.Truncated)
	}
}

// killMachine kills the sandbox's Firecracker with SIGKILL: the one whose working directory is the sandbox's VM
// directory (fc.Launch).
func killMachine(t *testing.T, sandbox string) {
	t.Helper()
	procs, _ := filepath.Glob("/proc/[0-9]*")
	for _, proc := range procs {
		comm, _ := os.ReadFile(filepath.Join(proc, "comm"))
		cwd, _ := os.Readlink(filepath.Join(proc, "cwd"))
		if strings.TrimSpace(string(comm)) != "firecracker" || !strings.Contains(cwd, "/"+sandbox+"/") {
			continue
		}
		pid, _ := strconv.Atoi(filepath.Base(proc))
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
			t.Fatal(err)
		}
		t.Logf("killed %s's firecracker (pid %d, in %s)", sandbox, pid, cwd)
		return
	}
	t.Fatalf("no firecracker runs %s", sandbox)
}
