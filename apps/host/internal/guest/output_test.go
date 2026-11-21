package guest

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// readAll reads a command's whole kept stream in parts of at most part bytes, and answers it with the last part's
// answer.
func readAll(t *testing.T, client *Client, id, stream string, part int64) ([]byte, CommandOutput) {
	t.Helper()
	var all []byte
	for {
		out, err := client.CommandOutput(context.Background(), id, stream, int64(len(all)), part)
		if err != nil {
			t.Fatal(err)
		}
		if !out.Known {
			t.Fatalf("%s's %s isn't kept", id, stream)
		}
		data, err := base64.StdEncoding.DecodeString(out.Data)
		if err != nil {
			t.Fatal(err)
		}
		if out.Offset != int64(len(all)) {
			t.Fatalf("a part from %d answered from %d", len(all), out.Offset)
		}
		all = append(all, data...)
		if int64(len(all)) >= out.Size {
			return all, out
		}
		if len(data) == 0 {
			t.Fatalf("an empty part at %d of %d", len(all), out.Size)
		}
	}
}

func TestACommandKeepsItsWholeOutputPastItsResult(t *testing.T) {
	client := clientFor(t, (&Server{OutputDir: t.TempDir()}).Handler())
	ctx := context.Background()
	// 3 MiB of stdout, past the 1 MiB its result holds, and some stderr: detached, and in the foreground, streamed or not.
	const script = "head -c 3145728 /dev/zero | tr '\\0' a; echo oops >&2"
	want := bytes.Repeat([]byte("a"), 3<<20)
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_d", Command: script}); err != nil {
		t.Fatal(err)
	}
	if result := waitEnded(t, client, "cmd_d"); !result.Truncated || len(result.Stdout) != 1<<20 {
		t.Fatalf("its result: truncated %v, %d bytes", result.Truncated, len(result.Stdout))
	}
	if _, err := client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_f", Command: script}); err != nil {
		t.Fatal(err)
	}
	if err := client.ExecStream(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_s", Command: script, Stream: true}, func(ExecEvent) error { return nil }); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"cmd_d", "cmd_f", "cmd_s"} {
		stdout, last := readAll(t, client, id, StreamStdout, MaxOutputRead)
		if !bytes.Equal(stdout, want) || !last.Ended || last.Cut || last.Limit != OutputKeepBytes {
			t.Fatalf("%s's stdout: %d bytes, last part %+v", id, len(stdout), last)
		}
		if stderr, _ := readAll(t, client, id, StreamStderr, 3); !strings.HasSuffix(string(stderr), "oops\n") {
			t.Fatalf("%s's stderr: %q", id, stderr)
		}
	}
	// Past its end: nothing, from its size.
	past, err := client.CommandOutput(ctx, "cmd_d", StreamStdout, 10<<20, 10)
	if err != nil || past.Offset != 3<<20 || past.Data != "" || past.Size != 3<<20 {
		t.Fatalf("past its end: %+v, %v", past, err)
	}
	// An ID it never ran is not known; nor is any where the agent keeps no output.
	if out, err := client.CommandOutput(ctx, "cmd_none", StreamStdout, 0, 10); err != nil || out.Known {
		t.Fatalf("unknown: %+v, %v", out, err)
	}
	if _, err := client.CommandOutput(ctx, "cmd_d", "both", 0, 10); !IsRefused(err) {
		t.Fatalf("a stream that isn't one: %v", err)
	}
	none := clientFor(t, (&Server{}).Handler())
	if _, err := none.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_x", Command: "echo hi"}); err != nil {
		t.Fatal(err)
	}
	if out, err := none.CommandOutput(ctx, "cmd_x", StreamStdout, 0, 10); err != nil || out.Known {
		t.Fatalf("no output kept: %+v, %v", out, err)
	}
}

func TestARunningCommandsKeptOutputGrows(t *testing.T) {
	dir := t.TempDir()
	client := clientFor(t, (&Server{OutputDir: dir}).Handler())
	ctx := context.Background()
	gate := filepath.Join(t.TempDir(), "go")
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_r", Command: "printf first; while [ ! -e " + gate + " ]; do sleep 0.02; done; printf ' then'"}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		out, err := client.CommandOutput(ctx, "cmd_r", StreamStdout, 0, 100)
		if err != nil {
			t.Fatal(err)
		}
		if out.Size == 5 {
			if out.Ended || out.Data != base64.StdEncoding.EncodeToString([]byte("first")) {
				t.Fatalf("while it runs: %+v", out)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("its first output never came: %+v", out)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	waitEnded(t, client, "cmd_r")
	if got, last := readAll(t, client, "cmd_r", StreamStdout, 100); string(got) != "first then" || !last.Ended {
		t.Fatalf("once ended: %q, %+v", got, last)
	}
	// An agent that restarts (a reboot) still reads it from the disk.
	again := clientFor(t, (&Server{OutputDir: dir}).Handler())
	if got, last := readAll(t, again, "cmd_r", StreamStdout, 100); string(got) != "first then" || !last.Ended || last.Cut {
		t.Fatalf("after a restart: %q, %+v", got, last)
	}
}

func TestKeptOutputIsCutAtItsLimitAndTheOldestDropped(t *testing.T) {
	dir := t.TempDir()
	server := &Server{OutputDir: dir}
	// 10 bytes a stream, and 45 in all: a start leaves 25 kept, room for its own 20. Each command fills its stderr, so
	// whatever its shell adds there (a login profile's complaint) changes nothing.
	server.outputs.stream, server.outputs.total = 10, 45
	client := clientFor(t, server.Handler())
	ctx := context.Background()
	// Cut at 10 bytes a stream.
	if _, err := client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_1", Command: "printf 0123456789abcdef; printf 0123456789 >&2"}); err != nil {
		t.Fatal(err)
	}
	got, last := readAll(t, client, "cmd_1", StreamStdout, 100)
	if string(got) != "0123456789" || !last.Cut || last.Limit != 10 {
		t.Fatalf("cut: %q, %+v", got, last)
	}
	// So is one ended with its machine (no end file), from its size.
	if err := os.Remove(filepath.Join(dir, "cmd_1", outputEndFile)); err != nil {
		t.Fatal(err)
	}
	if _, last := readAll(t, client, "cmd_1", StreamStdout, 100); !last.Cut || !last.Ended {
		t.Fatalf("with no end file: %+v", last)
	}
	// A running command's output is kept as a later one's start makes room; the oldest ended one's goes.
	gate := filepath.Join(t.TempDir(), "go")
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_2", Command: "printf 0123456789 >&2; printf 0123456789; while [ ! -e " + gate + " ]; do sleep 0.02; done"}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if out, err := client.CommandOutput(ctx, "cmd_2", StreamStdout, 0, 100); err == nil && out.Size == 10 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cmd_2's output never came")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_3", Command: "printf 0123456789; printf 0123456789 >&2"}); err != nil {
		t.Fatal(err)
	}
	if out, err := client.CommandOutput(ctx, "cmd_1", StreamStdout, 0, 100); err != nil || out.Known {
		t.Fatalf("the oldest ended command's output was kept: %+v, %v", out, err)
	}
	for _, id := range []string{"cmd_2", "cmd_3"} {
		if out, err := client.CommandOutput(ctx, id, StreamStdout, 0, 100); err != nil || !out.Known || out.Size != 10 {
			t.Fatalf("%s: %+v, %v", id, out, err)
		}
	}
	_ = os.WriteFile(gate, nil, 0o600)
	waitEnded(t, client, "cmd_2")
}

func TestAGuestFromBeforeKeptOutputIsAnUnknownRoute(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /exec/{id}", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, ExecStatus{}) })
	mux.HandleFunc("POST /exec/{id}/kill", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]bool{}) })
	_, err := clientFor(t, mux).CommandOutput(context.Background(), "cmd_1", StreamStdout, 0, 10)
	if !IsUnknownRoute(err) || !strings.Contains(err.Error(), "40") {
		t.Fatalf("an old guest: %v", err)
	}
}

// waitSize waits for a command's kept stdout to reach size.
func waitSize(t *testing.T, client *Client, id string, size int64) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if out, err := client.CommandOutput(context.Background(), id, StreamStdout, 0, 1); err == nil && out.Size >= size {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s's output never reached %d bytes", id, size)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDotIDsNeverReachOtherCommandsOutput(t *testing.T) {
	dir := t.TempDir()
	client := clientFor(t, (&Server{OutputDir: dir}).Handler())
	ctx := context.Background()
	gate := filepath.Join(t.TempDir(), "go")
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_a", Command: "printf kept; while [ ! -e " + gate + " ]; do sleep 0.02; done"}); err != nil {
		t.Fatal(err)
	}
	waitSize(t, client, "cmd_a", 4)
	// "." and ".." are valid IDs: they run, keep nothing, and remove nothing.
	for _, id := range []string{".", ".."} {
		if _, err := client.Exec(ctx, ExecRequest{Cwd: os.TempDir(), ID: id, Command: "echo hi"}); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
	}
	if got, _ := readAll(t, client, "cmd_a", StreamStdout, 100); string(got) != "kept" {
		t.Fatalf("cmd_a's output after . and ..: %q", got)
	}
	_ = os.WriteFile(gate, nil, 0o600)
	waitEnded(t, client, "cmd_a")
}

func TestCommandsRunningAtOnceShareTheTotal(t *testing.T) {
	server := &Server{OutputDir: t.TempDir()}
	server.outputs.stream, server.outputs.total = 10, 25
	client := clientFor(t, server.Handler())
	ctx := context.Background()
	// Both start before either writes: each may keep 10 bytes a stream, but the two together 25.
	gate := filepath.Join(t.TempDir(), "go")
	for _, id := range []string{"cmd_a", "cmd_b"} {
		if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: id, Command: "while [ ! -e " + gate + " ]; do sleep 0.02; done; printf 0123456789; printf 0123456789 >&2"}); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(gate, nil, 0o600)
	var kept int64
	cut := false
	for _, id := range []string{"cmd_a", "cmd_b"} {
		waitEnded(t, client, id)
		for _, stream := range []string{StreamStdout, StreamStderr} {
			_, last := readAll(t, client, id, stream, 100)
			kept += last.Size
			cut = cut || last.Cut
		}
	}
	if kept > 25 || kept < 20 || !cut {
		t.Fatalf("kept %d bytes of 40 under a total of 25, cut %v", kept, cut)
	}
}

func TestACutStreamStaysCutWhenItsEndFileCantBeWritten(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes into a read-only directory")
	}
	dir := t.TempDir()
	server := &Server{OutputDir: dir}
	server.outputs.stream = 10
	client := clientFor(t, server.Handler())
	ctx := context.Background()
	gate := filepath.Join(t.TempDir(), "go")
	if _, err := client.StartCommand(ctx, ExecRequest{Cwd: os.TempDir(), ID: "cmd_a", Command: "printf 0123456789abcdef; while [ ! -e " + gate + " ]; do sleep 0.02; done"}); err != nil {
		t.Fatal(err)
	}
	waitSize(t, client, "cmd_a", 10)
	// As a full disk refuses the end file.
	if err := os.Chmod(filepath.Join(dir, "cmd_a"), 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(dir, "cmd_a"), 0o700) })
	_ = os.WriteFile(gate, nil, 0o600)
	waitEnded(t, client, "cmd_a")
	if _, err := os.Stat(filepath.Join(dir, "cmd_a", outputEndFile)); err == nil {
		t.Fatal("the end file was written")
	}
	if _, last := readAll(t, client, "cmd_a", StreamStdout, 100); !last.Cut || !last.Ended {
		t.Fatalf("with no end file: %+v", last)
	}
}
