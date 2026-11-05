package guest

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// waitEnded polls a command's status until it has ended.
func waitEnded(t *testing.T, client *Client, id string) ExecResult {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		status, err := client.CommandStatus(context.Background(), id, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if status.State == ExecEnded {
			if status.Result == nil {
				t.Fatal("an ended command came without its result")
			}
			return *status.Result
		}
	}
	t.Fatalf("command %s never ended", id)
	return ExecResult{}
}

func TestDetachedCommandKeepsItsResult(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	started, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_a", Command: "sleep 0.3; echo done; echo oops >&2; exit 3"})
	if err != nil {
		t.Fatal(err)
	}
	if started.Pid == 0 {
		t.Fatal("no pid")
	}
	status, err := client.CommandStatus(ctx, "cmd_a", 0)
	if err != nil || status.State != ExecRunning {
		t.Fatalf("at once: %+v, %v", status, err)
	}
	result := waitEnded(t, client, "cmd_a")
	if result.ExitCode != 3 || result.Stdout != "done\n" || !strings.Contains(result.Stderr, "oops\n") || result.TimedOut {
		t.Fatalf("result %+v", result)
	}
	// Still there to read again.
	again, err := client.CommandStatus(ctx, "cmd_a", 0)
	if err != nil || again.State != ExecEnded || again.Result.ExitCode != 3 {
		t.Fatalf("read again: %+v, %v", again, err)
	}
	// Its ID is taken, and an unknown one is not found.
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_a", Command: "true"}); err == nil {
		t.Fatal("a second command with the same ID was started")
	}
	if _, err := client.CommandStatus(ctx, "cmd_none", 0); !IsNotFound(err) {
		t.Fatalf("unknown ID: %v", err)
	}
}

func TestDetachedCommandHasNoLimitButTheCallers(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	// The foreground default (120 s) isn't the detached one's: with no timeout it is never timed out. With one, it is.
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_t", Command: "sleep 30", TimeoutMs: 200}); err != nil {
		t.Fatal(err)
	}
	result := waitEnded(t, client, "cmd_t")
	if !result.TimedOut || result.ExitCode != 124 {
		t.Fatalf("result %+v", result)
	}
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_n", Command: "sleep 0.2; echo ok"}); err != nil {
		t.Fatal(err)
	}
	if result := waitEnded(t, client, "cmd_n"); result.TimedOut || result.ExitCode != 0 || result.Stdout != "ok\n" {
		t.Fatalf("result %+v", result)
	}
}

func TestDetachedCommandOutputIsCapped(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	if _, err := client.StartCommand(context.Background(), ExecRequest{Cwd: os.TempDir(), ID: "cmd_big", Command: "head -c 5000 /dev/zero", MaxOutputBytes: 1000}); err != nil {
		t.Fatal(err)
	}
	result := waitEnded(t, client, "cmd_big")
	if len(result.Stdout) != 1000 || !result.Truncated {
		t.Fatalf("kept %d bytes, truncated %v", len(result.Stdout), result.Truncated)
	}
}

// alive is whether the process pid exists (and isn't a zombie left for its parent).
func alive(pid int) bool {
	if syscall.Kill(pid, 0) != nil {
		return false
	}
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	fields := strings.Fields(string(raw))
	return len(fields) < 3 || fields[2] != "Z"
}

func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for alive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("process %d still runs", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func readPid(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(path); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
				return pid
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no pid in %s", path)
	return 0
}

func TestKillEndsADetachedCommandsProcessGroup(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	// A child of its own in the background, which a kill of the shell alone would leave running.
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_k", Command: "sleep 60 & echo $! > " + pidFile + "; wait"}); err != nil {
		t.Fatal(err)
	}
	child := readPid(t, pidFile)
	killed, err := client.KillCommand(ctx, "cmd_k")
	if err != nil || !killed {
		t.Fatalf("kill: %v, %v", killed, err)
	}
	result := waitEnded(t, client, "cmd_k")
	if result.ExitCode != 137 {
		t.Fatalf("result %+v", result)
	}
	waitGone(t, child)
	// Killing it again: it has ended.
	if again, err := client.KillCommand(ctx, "cmd_k"); err != nil || again {
		t.Fatalf("kill again: %v, %v", again, err)
	}
	if _, err := client.KillCommand(ctx, "cmd_none"); !IsNotFound(err) {
		t.Fatalf("unknown ID: %v", err)
	}
}

func TestKillEndsAForegroundCommandByItsID(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	answered := make(chan ExecResult, 1)
	failed := make(chan error, 1)
	go func() {
		res, err := client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_f", Command: "sleep 60 & echo $! > " + pidFile + "; wait"})
		if err != nil {
			failed <- err
			return
		}
		answered <- res
	}()
	child := readPid(t, pidFile)
	killed, err := client.KillCommand(ctx, "cmd_f")
	if err != nil || !killed {
		t.Fatalf("kill: %v, %v", killed, err)
	}
	select {
	case res := <-answered:
		if res.ExitCode != 137 || res.TimedOut {
			t.Fatalf("answer %+v", res)
		}
	case err := <-failed:
		t.Fatal(err)
	case <-time.After(10 * time.Second):
		t.Fatal("the command wasn't answered")
	}
	waitGone(t, child)
	// A foreground command is forgotten once it ends.
	if _, err := client.CommandStatus(ctx, "cmd_f", 0); !IsNotFound(err) {
		t.Fatalf("after its end: %v", err)
	}
}

func TestClosingAForegroundRequestEndsItsCommand(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_, _ = client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), Command: "sleep 60 & echo $! > " + pidFile + "; wait"})
		close(done)
	}()
	child := readPid(t, pidFile)
	cancel()
	<-done
	waitGone(t, child)
}
