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

// A running detached command's status has its output so far, which a later look only adds to, then its result.
func TestARunningDetachedCommandShowsItsOutputSoFar(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	gate := filepath.Join(t.TempDir(), "go")
	cmd := "echo 'Reading package lists...'; echo warn >&2; while [ ! -e " + gate + " ]; do sleep 0.05; done; echo Done"
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_o", Command: cmd}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	var status ExecStatus
	for time.Now().Before(deadline) {
		var err error
		if status, err = client.CommandStatus(ctx, "cmd_o", 0); err != nil {
			t.Fatal(err)
		}
		if status.Stdout != "" && strings.Contains(status.Stderr, "warn\n") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	// (A login shell may say more on stderr first, on a machine whose profile it can't read.)
	if status.State != ExecRunning || status.Stdout != "Reading package lists...\n" || !strings.HasSuffix(status.Stderr, "warn\n") || status.Result != nil {
		t.Fatalf("while it runs: %+v", status)
	}
	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if result := waitEnded(t, client, "cmd_o"); result.Stdout != "Reading package lists...\nDone\n" {
		t.Fatalf("result %+v", result)
	}
}

// A running command's output so far never ends in part of a UTF-8 sequence, which would read as U+FFFD now and as
// itself once the rest has come.
func TestRunningOutputHoldsBackAPartialSequence(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"ab", "ab"},
		{"a\xe2\x82", "a"},
		{"a\xe2\x82\xac", "a\xe2\x82\xac"},
		{"a\xf0\x9f", "a"},
		{"\xc3", ""},
		{"", ""},
	} {
		b := &cappedBuffer{max: 100}
		_, _ = b.Write([]byte(tc.in))
		if got := string(b.whole()); got != tc.want {
			t.Errorf("whole(%q) = %q, want %q", tc.in, got, tc.want)
		}
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

// A running foreground command with an ID has its output so far in its status too, as a detached one does: what attach
// shows of a command whose call outlived its connection. Its answer then has the whole of it.
func TestARunningForegroundCommandShowsItsOutputSoFar(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	gate := filepath.Join(t.TempDir(), "go")
	cmd := "echo 'Reading package lists...'; echo warn >&2; while [ ! -e " + gate + " ]; do sleep 0.05; done; echo Done"
	answered := make(chan ExecResult, 1)
	failed := make(chan error, 1)
	go func() {
		res, err := client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_fo", Command: cmd, TimeoutMs: 30_000})
		if err != nil {
			failed <- err
			return
		}
		answered <- res
	}()
	deadline := time.Now().Add(10 * time.Second)
	var status ExecStatus
	for time.Now().Before(deadline) {
		var err error
		status, err = client.CommandStatus(ctx, "cmd_fo", 0)
		if err == nil && status.Stdout != "" && strings.Contains(status.Stderr, "warn\n") {
			break
		}
		if err != nil && !IsNotFound(err) {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status.State != ExecRunning || status.Stdout != "Reading package lists...\n" || !strings.HasSuffix(status.Stderr, "warn\n") || status.Result != nil {
		t.Fatalf("while it runs: %+v", status)
	}
	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-answered:
		if res.ExitCode != 0 || res.Stdout != "Reading package lists...\nDone\n" {
			t.Fatalf("answer %+v", res)
		}
	case err := <-failed:
		t.Fatal(err)
	case <-time.After(10 * time.Second):
		t.Fatal("the command wasn't answered")
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

// A foreground command kept past its connection (Keep) runs on when its request's connection goes, as a pause or a move
// of its sandbox with its memory resets the host's connections to the guest, and its result is kept for whichever host
// asks for it by its ID.
func TestAKeptForegroundCommandOutlivesItsConnection(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	gate := filepath.Join(t.TempDir(), "go")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_, _ = client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_k", Keep: true, Command: "echo before; while [ ! -e " + gate + " ]; do sleep 0.05; done; echo after"})
		close(done)
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		status, err := client.CommandStatus(context.Background(), "cmd_k", 0)
		if err == nil && status.Stdout == "before\n" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("it never ran: %+v, %v", status, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done
	status, err := client.CommandStatus(context.Background(), "cmd_k", 0)
	if err != nil || status.State != ExecRunning {
		t.Fatalf("once its connection went: %+v, %v", status, err)
	}
	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	result := waitEnded(t, client, "cmd_k")
	if result.ExitCode != 0 || result.Stdout != "before\nafter\n" {
		t.Fatalf("its kept result: %+v", result)
	}
}

// One kept past its connection keeps its result once answered too (the answer may never have reached the host), in a
// ring of its own: many of them never push out a detached command's result.
func TestAKeptForegroundCommandKeepsItsResultApartFromDetachedOnes(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_d", Command: "echo detached"}); err != nil {
		t.Fatal(err)
	}
	waitEnded(t, client, "cmd_d")
	res, err := client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_a", Keep: true, Command: "echo hi; exit 3"})
	if err != nil || res.Stdout != "hi\n" || res.ExitCode != 3 {
		t.Fatalf("answer %+v, %v", res, err)
	}
	if result := waitEnded(t, client, "cmd_a"); result.ExitCode != 3 || result.Stdout != "hi\n" {
		t.Fatalf("kept after its answer: %+v", result)
	}
	for i := range maxKeptCommands {
		if _, err := client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_k" + strconv.Itoa(i), Keep: true, Command: "true"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := client.CommandStatus(ctx, "cmd_a", 0); !IsNotFound(err) {
		t.Fatalf("the oldest kept one after %d more: %v", maxKeptCommands, err)
	}
	if result := waitEnded(t, client, "cmd_d"); result.Stdout != "detached\n" {
		t.Fatalf("the detached one's result: %+v", result)
	}
	// Without Keep a foreground command is forgotten once answered, as before.
	if _, err := client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_f", Command: "true"}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CommandStatus(ctx, "cmd_f", 0); !IsNotFound(err) {
		t.Fatalf("a foreground one not kept, after its answer: %v", err)
	}
}

// A kill that overtakes its command's start (the host cancels its call and sends the kill, which can reach the guest
// first) makes the start refused: a command kept past its call is never left running by a kill that was answered.
func TestAKillThatOvertakesItsStartKeepsItFromRunning(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	marker := filepath.Join(t.TempDir(), "ran")
	if killed, err := client.KillCommand(ctx, "cmd_o"); killed || !IsNotFound(err) {
		t.Fatalf("kill before its start: %v, %v", killed, err)
	}
	if _, err := client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_o", Keep: true, Command: "touch " + marker}); !IsConflict(err) {
		t.Fatalf("its start after the kill: %v", err)
	}
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_o", Command: "touch " + marker}); !IsConflict(err) {
		t.Fatalf("a detached start after the kill: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("the command ran: %v", err)
	}
}
