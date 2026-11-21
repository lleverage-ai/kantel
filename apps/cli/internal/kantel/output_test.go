package kantel

import (
	"encoding/base64"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

const commandOutput = "GET /v1/sandboxes/sbx_test1/commands/cmd_1/output"

// keptOutput answers readCommandOutput from stdout and stderr as Kantel keeps them, a MiB at most a part.
func keptOutput(stdout, stderr string, ended bool) func(call) any {
	return func(c call) any {
		kept := stdout
		if url.Values(c.Query).Get("stream") == "stderr" {
			kept = stderr
		}
		offset, _ := strconv.Atoi(url.Values(c.Query).Get("offset"))
		offset = min(offset, len(kept))
		end := min(offset+1<<20, len(kept))
		return map[string]any{
			"commandId": "cmd_1", "stream": url.Values(c.Query).Get("stream"), "encoding": "base64",
			"content": base64.StdEncoding.EncodeToString([]byte(kept[offset:end])),
			"offset":  offset, "size": len(kept), "ended": ended, "truncated": false, "limit": 64 << 20,
		}
	}
}

func TestAttachReadsOutputPastOneMiB(t *testing.T) {
	mib := strings.Repeat("a", 1<<20)
	whole := mib + strings.Repeat("b", 1<<20) + "end\n"
	r := run(t, []string{"attach", "sbx_test1", "cmd_1"}, opts{routes: routes{
		commandOne: views(
			running(map[string]any{"stdout": mib[:100]}),
			running(map[string]any{"stdout": mib, "truncated": true}),
			command(map[string]any{"stdout": mib, "stderr": "warn\n", "truncated": true}),
		),
		commandOutput: keptOutput(whole, "warn\n", true),
	}})
	eq(t, "exit", r.Code, 0)
	if r.Stdout != whole {
		t.Fatalf("stdout: %d bytes, want all %d", len(r.Stdout), len(whole))
	}
	eq(t, "stderr", r.Stderr, "warn\n")
	// Read on from what its record showed, in base64.
	var offsets []string
	for _, c := range r.Calls {
		if c.Method+" "+c.Path == commandOutput && url.Values(c.Query).Get("stream") == "stdout" {
			offsets = append(offsets, url.Values(c.Query).Get("offset"))
			eq(t, "encoding", url.Values(c.Query).Get("encoding"), "base64")
		}
	}
	// From its start, a MiB at a time, never from its record.
	if strings.Join(offsets, " ") != "0 1048576 2097152" {
		t.Fatalf("stdout read from %v", offsets)
	}
}

func TestAttachSaysWhereTheRestOfItsOutputIs(t *testing.T) {
	mib := strings.Repeat("a", 1<<20)
	ended := command(map[string]any{"stdout": mib, "truncated": true})
	// Its sandbox stopped: resume it to read on.
	stopped := run(t, []string{"attach", "sbx_test1", "cmd_1"}, opts{routes: routes{
		commandOne:    func(call) any { return ended },
		commandOutput: func(call) any { return kantelError(409, "conflict", "The sandbox is stopped; resume it first") },
	}})
	eq(t, "exit", stopped.Code, 0)
	eq(t, "stdout", len(stopped.Stdout), 1<<20)
	contains(t, "stderr", stopped.Stderr, "the rest of its stdout is kept in the sandbox, which isn't running: resume it, then kantel attach sbx_test1 cmd_1")
	// A gateway from before readCommandOutput: its record is all there is.
	old := run(t, []string{"attach", "sbx_test1", "cmd_1"}, opts{routes: routes{commandOne: func(call) any { return ended }}})
	eq(t, "exit", old.Code, 0)
	eq(t, "stdout", len(old.Stdout), 1<<20)
	eq(t, "stderr", old.Stderr, "kantel: the output was cut at 1 MiB\n")
	// Cut where Kantel keeps it.
	cut := run(t, []string{"attach", "sbx_test1", "cmd_1"}, opts{routes: routes{
		commandOne: func(call) any { return ended },
		commandOutput: func(c call) any {
			answer := keptOutput(mib+"more", "", true)(c).(map[string]any)
			answer["truncated"] = url.Values(c.Query).Get("stream") == "stdout"
			return answer
		},
	}})
	eq(t, "stdout", cut.Stdout, mib+"more")
	contains(t, "stderr", cut.Stderr, "kantel: the stdout was cut at 64 MiB")
}
