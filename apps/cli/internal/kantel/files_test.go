package kantel

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// command is a command as Kantel answers it, with fields changed; a nil value leaves the field out.
func command(fields map[string]any) map[string]any {
	c := map[string]any{
		"id": "cmd_1", "sandboxId": "sbx_test1", "command": "true", "state": "exited", "exitCode": 0,
		"stdout": "", "stderr": "", "truncated": false, "startedAt": time.Now().UnixMilli(),
	}
	for k, v := range fields {
		if v == nil {
			delete(c, k)
		} else {
			c[k] = v
		}
	}
	return c
}

func running(fields map[string]any) map[string]any {
	f := map[string]any{"state": "running", "exitCode": nil}
	for k, v := range fields {
		f[k] = v
	}
	return command(f)
}

// drop ends the connection without an answer, as a reset would.
func drop() any { panic(http.ErrAbortHandler) }

// views answers each in turn, then the last again; a func is called (drop, say).
func views(answers ...any) func(call) any {
	var mu sync.Mutex
	return func(call) any {
		mu.Lock()
		next := answers[0]
		if len(answers) > 1 {
			answers = answers[1:]
		}
		mu.Unlock()
		if f, ok := next.(func() any); ok {
			return f()
		}
		return next
	}
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func methods(calls []call) string {
	var out []string
	for _, c := range calls {
		out = append(out, c.Method)
	}
	return strings.Join(out, " ")
}

func sum(ds []time.Duration) time.Duration {
	var total time.Duration
	for _, d := range ds {
		total += d
	}
	return total
}

const commands = "POST /v1/sandboxes/sbx_test1/commands"
const commandOne = "GET /v1/sandboxes/sbx_test1/commands/cmd_1"

func TestExecRoutesOutputAndExitsWithItsCode(t *testing.T) {
	r := run(t, []string{"exec", "sbx_test1", "--cwd", "/app", "--env", "A=1", "--timeout", "5", "--", "sh", "-c", "echo hi; exit 3"},
		opts{routes: routes{commands: func(call) any { return command(map[string]any{"exitCode": 3, "stdout": "out\n", "stderr": "err\n"}) }}})
	eq(t, "exit", r.Code, 3)
	eq(t, "stdout", r.Stdout, "out\n")
	eq(t, "stderr", r.Stderr, "err\n")
	// Started with its limit and followed by its ID (here it had ended by its start's answer).
	eq(t, "body", string(r.Calls[0].Raw), `{"command":"sh -c 'echo hi; exit 3'","cwd":"/app","detached":true,"env":{"A":"1"},"timeoutMs":5000}`)
	eq(t, "auth", r.Calls[0].Auth, "Bearer ksk_test")
}

func TestExecExitsZeroOr124(t *testing.T) {
	ok := run(t, []string{"exec", "sbx_test1", "--", "true"}, opts{routes: routes{commands: func(call) any {
		return command(map[string]any{"stdout": "fine\n"})
	}}})
	eq(t, "ok exit", ok.Code, 0)
	eq(t, "ok stdout", ok.Stdout, "fine\n")
	slow := run(t, []string{"exec", "sbx_test1", "--timeout", "10", "--", "sleep 5"}, opts{routes: routes{commands: func(call) any {
		return command(map[string]any{"state": "timed_out", "exitCode": nil})
	}}})
	eq(t, "slow exit", slow.Code, 124)
	contains(t, "slow stderr", slow.Stderr, "timed out after 10 s")
	eq(t, "slow body", string(slow.Calls[0].Raw), `{"command":"sleep 5","detached":true,"timeoutMs":10000}`)
}

func TestExecJSONKeepsItsExitCode(t *testing.T) {
	answer := command(map[string]any{"exitCode": 2, "stdout": "x"})
	r := run(t, []string{"exec", "sbx_test1", "--json", "--", "false"}, opts{routes: routes{commands: func(call) any { return answer }}})
	eq(t, "exit", r.Code, 2)
	var got map[string]any
	if err := json.Unmarshal([]byte(r.Stdout), &got); err != nil {
		t.Fatal(err)
	}
	eq(t, "json", jsonOf(t, got), jsonOf(t, answer))
}

func TestExecNeedsACommandWhichMayComeWithoutDashes(t *testing.T) {
	none := run(t, []string{"exec", "sbx_test1"}, opts{})
	eq(t, "exit", none.Code, 2)
	contains(t, "stderr", none.Stderr, "give the command")
	eq(t, "calls", len(none.Calls), 0)
	r := run(t, []string{"exec", "sbx_test1", "make && make test"}, opts{routes: routes{commands: func(call) any { return command(nil) }}})
	eq(t, "exit", r.Code, 0)
	// With the default limit of 30 s.
	eq(t, "body", string(r.Calls[0].Raw), `{"command":"make \u0026\u0026 make test","detached":true,"timeoutMs":30000}`)
}

func TestExecDetachesAndAttachFollows(t *testing.T) {
	start := routes{commands: func(call) any { return running(nil) }}
	started := run(t, []string{"exec", "sbx_test1", "-d", "--", "npm", "run", "dev"}, opts{routes: start})
	eq(t, "exit", started.Code, 0)
	eq(t, "stdout", started.Stdout, "cmd_1\n")
	contains(t, "stderr", started.Stderr, "kantel attach sbx_test1 cmd_1")
	eq(t, "body", string(started.Calls[0].Raw), `{"command":"npm run dev","detached":true}`)

	// --timeout still limits a detached one.
	limited := run(t, []string{"exec", "sbx_test1", "-d", "--timeout", "5", "--", "sleep", "60"}, opts{routes: start})
	eq(t, "limited body", string(limited.Calls[0].Raw), `{"command":"sleep 60","detached":true,"timeoutMs":5000}`)

	attached := run(t, []string{"attach", "sbx_test1", "cmd_1"}, opts{routes: routes{commandOne: views(
		running(map[string]any{"stdout": "one\n"}),
		running(map[string]any{"stdout": "one\ntwo\n", "stderr": "warn\n"}),
		command(map[string]any{"exitCode": 4, "stdout": "one\ntwo\nthree\n", "stderr": "warn\n"}),
	)}})
	eq(t, "attach exit", attached.Code, 4)
	eq(t, "attach stdout", attached.Stdout, "one\ntwo\nthree\n")
	eq(t, "attach stderr", attached.Stderr, "warn\n")
}

func TestExecTimeoutZeroFollowsADetachedCommand(t *testing.T) {
	r := run(t, []string{"exec", "sbx_test1", "--timeout", "0", "--", "make"}, opts{routes: routes{
		commands:   func(call) any { return running(nil) },
		commandOne: func(call) any { return command(map[string]any{"stdout": "built\n"}) },
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "stdout", r.Stdout, "built\n")
	eq(t, "body", string(r.Calls[0].Raw), `{"command":"make","detached":true}`)
	// Its ID, and how to follow it again, from the start.
	contains(t, "stderr", r.Stderr, "kantel attach sbx_test1 cmd_1 follows it again")
}

func TestFollowsOnWhileKantelIsOutOfReach(t *testing.T) {
	r := run(t, []string{"exec", "sbx_test1", "--timeout", "0", "--", "apt-get install -y gcc"}, opts{routes: routes{
		commands: func(call) any { return running(nil) },
		commandOne: views(
			running(map[string]any{"stdout": "Reading package lists...\n"}),
			drop,
			kantelError(503, "unavailable", "The gateway is restarting"),
			kantelError(502, "bad_gateway", "Bad gateway"),
			running(map[string]any{"stdout": "Reading package lists...\nSetting up gcc\n"}),
			command(map[string]any{"stdout": "Reading package lists...\nSetting up gcc\nDone\n"}),
		),
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "stdout", r.Stdout, "Reading package lists...\nSetting up gcc\nDone\n")
	// The dropped connection was read again at once (the client's retry); Kantel's own 503 is follow's to wait out.
	if strings.Contains(r.Stderr, "couldn't reach") {
		t.Errorf("the client's retry was follow's: %q", r.Stderr)
	}
	contains(t, "stderr", r.Stderr, "kantel: Kantel can't answer for now (The gateway is restarting); trying again")
}

func TestGivesUpFollowingAfterTwoMinutes(t *testing.T) {
	r := run(t, []string{"attach", "sbx_test1", "cmd_1"}, opts{routes: routes{
		commandOne: func(call) any { return kantelError(503, "unavailable", "The gateway is down") },
	}})
	eq(t, "exit", r.Code, 1)
	contains(t, "stderr", r.Stderr, "Kantel can't answer for now (The gateway is down); cmd_1 may still be running: kantel attach sbx_test1 cmd_1")
	// Asked again for two minutes of waits, then no more: the last wait is cut to what is left.
	eq(t, "waited", sum(r.Slept), 120*time.Second)
	if len(r.Calls) >= 30 {
		t.Errorf("%d calls", len(r.Calls))
	}
}

func TestFollowsAPlainExecByItsID(t *testing.T) {
	r := run(t, []string{"exec", "sbx_test1", "--", "apt-get install -y gcc"}, opts{routes: routes{
		commands: func(call) any { return running(nil) },
		commandOne: views(
			running(map[string]any{"stdout": "Reading package lists...\n"}),
			running(map[string]any{"stdout": "Reading package lists...\nSetting up gcc\n"}),
			command(map[string]any{"exitCode": 3, "stdout": "Reading package lists...\nSetting up gcc\n", "stderr": "E: broken\n"}),
		),
	}})
	eq(t, "exit", r.Code, 3)
	eq(t, "stdout", r.Stdout, "Reading package lists...\nSetting up gcc\n")
	// Nothing of kantel's own on a plain exec's stderr: only the command's.
	eq(t, "stderr", r.Stderr, "E: broken\n")
	eq(t, "calls", methods(r.Calls), "POST GET GET GET")
	// Looked at soon after its start, so a short command's end comes quickly.
	if r.Slept[0] > 100*time.Millisecond {
		t.Errorf("first wait %v", r.Slept[0])
	}
}

func TestGivesAPlainExecsIDWhenItsConnectionResets(t *testing.T) {
	r := run(t, []string{"exec", "sbx_test1", "--timeout", "600", "--", "pnpm install"}, opts{routes: routes{
		commands:   func(call) any { return running(nil) },
		commandOne: views(running(map[string]any{"stdout": "Progress: 10%\n"}), drop),
	}})
	eq(t, "exit", r.Code, 1)
	eq(t, "stdout", r.Stdout, "Progress: 10%\n")
	contains(t, "stderr", r.Stderr, "; trying again")
	contains(t, "stderr", r.Stderr, "cmd_1 may still be running: kantel attach sbx_test1 cmd_1")
	// In JSON too: the ID on stderr, and not a success.
	j := run(t, []string{"exec", "sbx_test1", "--json", "--", "pnpm install"}, opts{routes: routes{
		commands:   func(call) any { return running(nil) },
		commandOne: func(call) any { return drop() },
	}})
	eq(t, "json exit", j.Code, 1)
	contains(t, "json stderr", j.Stderr, "cmd_1 may still be running: kantel attach sbx_test1 cmd_1")
}

func TestSaysHowToFindACommandWhoseStartWentUnanswered(t *testing.T) {
	r := run(t, []string{"exec", "sbx_test1", "--", "pnpm install"}, opts{routes: routes{commands: func(call) any { return drop() }}})
	eq(t, "exit", r.Code, 1)
	// Sent five times under one key (Go's transport may send a keyed request once more on a reused connection),
	// then given up on.
	if len(r.Calls) < 5 {
		t.Errorf("%d calls", len(r.Calls))
	}
	for _, c := range r.Calls {
		eq(t, "one key", c.Key, r.Calls[0].Key)
	}
	contains(t, "stderr", r.Stderr, "couldn't reach Kantel")
	contains(t, "stderr", r.Stderr, "it may have started: kantel ps sbx_test1 lists it")
}

func TestLeavesAPlainExecsLimitToKantel(t *testing.T) {
	looks := 0
	killed := false
	r := run(t, []string{"exec", "sbx_test1", "--timeout", "10", "--", "sleep 9999"}, opts{routes: routes{
		commands: func(call) any { return running(nil) },
		commandOne: func(call) any {
			looks++
			if looks < 120 {
				return running(map[string]any{"stdout": "a"})
			}
			return command(map[string]any{"state": "timed_out", "exitCode": nil, "stdout": "ab"})
		},
		"DELETE /v1/sandboxes/sbx_test1/commands/cmd_1": func(call) any {
			killed = true
			return command(map[string]any{"state": "killed", "exitCode": 137})
		},
	}})
	if sum(r.Slept) <= 100*time.Second {
		t.Errorf("waited %v", sum(r.Slept))
	}
	eq(t, "killed", killed, false)
	eq(t, "exit", r.Code, 124)
	eq(t, "stdout", r.Stdout, "ab")
	contains(t, "stderr", r.Stderr, "timed out after 10 s")
}

func TestAnswersAPlainExecAsJSONOnceItHasEnded(t *testing.T) {
	j := run(t, []string{"exec", "sbx_test1", "--json", "--", "false"}, opts{routes: routes{
		commands:   func(call) any { return running(nil) },
		commandOne: func(call) any { return command(map[string]any{"exitCode": 2, "stdout": "x"}) },
	}})
	eq(t, "exit", j.Code, 2)
	var got map[string]any
	if err := json.Unmarshal([]byte(j.Stdout), &got); err != nil {
		t.Fatal(err)
	}
	eq(t, "id", got["id"], any("cmd_1"))
	eq(t, "state", got["state"], any("exited"))
	eq(t, "stdout", got["stdout"], any("x"))
	eq(t, "stderr", j.Stderr, "")
	// A detached start is a success.
	started := run(t, []string{"exec", "sbx_test1", "--json", "-d", "--", "./serve"}, opts{routes: routes{commands: func(call) any { return running(nil) }}})
	eq(t, "detached exit", started.Code, 0)
}

func TestFollowsOnAfterADroppedConnection(t *testing.T) {
	r := run(t, []string{"attach", "sbx_test1", "cmd_1"}, opts{routes: routes{
		commandOne: views(drop, command(map[string]any{"stdout": "Done\n"})),
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "stdout", r.Stdout, "Done\n")
}

func TestDoesntAskAgainAfterAnAnswerThatWontChange(t *testing.T) {
	r := run(t, []string{"attach", "sbx_test1", "cmd_9"}, opts{routes: routes{
		"GET /v1/sandboxes/sbx_test1/commands/cmd_9": func(call) any { return kantelError(404, "not_found", "No such command") },
	}})
	eq(t, "exit", r.Code, 1)
	eq(t, "calls", len(r.Calls), 1)
}

func TestListsCommandsAndKillsOne(t *testing.T) {
	rs := routes{
		"GET /v1/sandboxes/sbx_test1/commands": func(call) any {
			return map[string]any{"items": []any{command(map[string]any{"command": "npm run dev"})}}
		},
		"DELETE /v1/sandboxes/sbx_test1/commands/cmd_1": func(call) any { return command(map[string]any{"state": "killed", "exitCode": nil}) },
	}
	listed := run(t, []string{"ps", "sbx_test1"}, opts{routes: rs})
	if !regexp.MustCompile(`cmd_1\s+exited 0`).MatchString(listed.Stdout) {
		t.Errorf("ps: %q", listed.Stdout)
	}
	contains(t, "ps", listed.Stdout, "npm run dev")
	k := run(t, []string{"kill", "sbx_test1", "cmd_1"}, opts{routes: rs})
	eq(t, "kill exit", k.Code, 0)
	eq(t, "kill", k.Stdout, "cmd_1 killed\n")
	// exec --status and --kill.
	status := run(t, []string{"exec", "sbx_test1", "--status", "cmd_1"}, opts{routes: routes{commandOne: func(call) any {
		return running(map[string]any{"command": "npm run dev", "stdout": "ready\n"})
	}}})
	eq(t, "status exit", status.Code, 0)
	eq(t, "status stdout", status.Stdout, "ready\n")
	eq(t, "status stderr", status.Stderr, "kantel: cmd_1 running: npm run dev\n")
	k = run(t, []string{"exec", "sbx_test1", "--kill", "cmd_1"}, opts{routes: rs})
	eq(t, "exec --kill", k.Stdout, "cmd_1 killed\n")
}

func TestPutStillWorksAsFilesPut(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	put := run(t, []string{"put", "sbx_test1", "notes.txt", "/home/user/notes.txt"}, opts{configDir: dir, routes: routes{
		"PUT /v1/sandboxes/sbx_test1/files": func(call) any { return map[string]any{"path": "/home/user/notes.txt", "kind": "file", "size": 6} },
	}})
	eq(t, "exit", put.Code, 0)
	eq(t, "calls", strings.Join((&fake{calls: put.Calls}).Lines(), ","), "PUT /v1/sandboxes/sbx_test1/files")
	eq(t, "path", put.Calls[0].Body["path"], any("/home/user/notes.txt"))
	eq(t, "content", put.Calls[0].Body["content"], any("hello\n"))
	contains(t, "stdout", put.Stdout, "Wrote /home/user/notes.txt")
	eq(t, "stderr", put.Stderr, `kantel: "kantel put" is going: use kantel files put <id> <local> <remote> (a file of up to 1 MiB), or kantel scp <local> <id>:<remote> for bigger files and directories`+"\n")
	if regexp.MustCompile(`(?m)^ {2}put `).MatchString(run(t, []string{"help"}, opts{}).Stdout) {
		t.Error("put in the help")
	}
	contains(t, "help put", run(t, []string{"help", "put"}, opts{}).Stdout, "Usage: kantel files put <id> <local> <remote>")
	missing := run(t, []string{"put", "sbx_test1"}, opts{})
	eq(t, "missing exit", missing.Code, 2)
	contains(t, "missing", missing.Stderr, "Usage: kantel files put")
}

func TestFilesPutWritesAgainWhenKantelCantBeReached(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writes := 0
	r := run(t, []string{"files", "put", "sbx_test1", "notes.txt", "/home/user/notes.txt"}, opts{configDir: dir, routes: routes{
		"PUT /v1/sandboxes/sbx_test1/files": func(call) any {
			writes++
			switch writes {
			case 1:
				return drop()
			case 2:
				return reply{Status: 502, Text: "Bad gateway"}
			}
			return map[string]any{"name": "notes.txt", "path": "/home/user/notes.txt", "kind": "file", "size": 6}
		},
	}})
	eq(t, "exit", r.Code, 0)
	if len(r.Calls) < 3 {
		t.Fatalf("%d calls", len(r.Calls))
	}
	// Each try sends the same body.
	for _, c := range r.Calls {
		eq(t, "same body", string(c.Raw), string(r.Calls[0].Raw))
	}
	eq(t, "content", r.Calls[0].Body["content"], any("hello\n"))
	eq(t, "slept", fmt.Sprint(r.Slept), fmt.Sprint([]time.Duration{500 * time.Millisecond, time.Second}))

	// Kantel's own refusal is final.
	refused := run(t, []string{"files", "put", "sbx_test1", "notes.txt", "/home/user/notes.txt"}, opts{configDir: dir, routes: routes{
		"PUT /v1/sandboxes/sbx_test1/files": func(call) any { return kantelError(503, "unavailable", "The compute API failed") },
	}})
	if refused.Code == 0 {
		t.Error("refused exit 0")
	}
	eq(t, "refused calls", len(refused.Calls), 1)
	eq(t, "refused slept", len(refused.Slept), 0)
}

func TestFilesPutRefusesOverOneMiBAndSendsBinaryAsBase64(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "big"), make([]byte, maxFile+1), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "bin"), []byte{0xff, 0, 0xfe}, 0o755)
	big := run(t, []string{"files", "put", "sbx_test1", "big", "x"}, opts{configDir: dir})
	eq(t, "big exit", big.Code, 1)
	contains(t, "big", big.Stderr, "kantel: big is 1.0 MiB: copy files over 1 MiB with exec or ssh")
	bin := run(t, []string{"files", "put", "sbx_test1", "bin", "x"}, opts{configDir: dir, routes: routes{
		"PUT /v1/sandboxes/sbx_test1/files": func(call) any { return map[string]any{"path": "/home/user/x", "kind": "file", "size": 3} },
	}})
	eq(t, "bin body", string(bin.Calls[0].Raw), `{"content":"/wD+","encoding":"base64","mode":"0755","path":"x"}`)
	eq(t, "bin stdout", bin.Stdout, "Wrote /home/user/x (3 B).\n")
	stdin := run(t, []string{"files", "put", "sbx_test1", "-", "x"}, opts{stdin: "from stdin", routes: routes{
		"PUT /v1/sandboxes/sbx_test1/files": func(call) any { return map[string]any{"path": "/home/user/x", "kind": "file", "size": 10} },
	}})
	eq(t, "stdin body", string(stdin.Calls[0].Raw), `{"content":"from stdin","encoding":"utf8","path":"x"}`)
}

func TestFilesLsCatGetAndRm(t *testing.T) {
	dir := t.TempDir()
	rs := routes{
		"GET /v1/sandboxes/sbx_test1/files/list": func(call) any {
			return map[string]any{"path": "/home/user", "nextCursor": "c2", "items": []any{
				map[string]any{"name": "app", "path": "/home/user/app", "kind": "directory", "size": 0},
				map[string]any{"name": "a.txt", "path": "/home/user/a.txt", "kind": "file", "size": 2048},
			}}
		},
		"GET /v1/sandboxes/sbx_test1/files": func(c call) any {
			return map[string]any{"path": "/home/user/a.txt", "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte("hi\n")), "size": 3, "offset": 0}
		},
		"DELETE /v1/sandboxes/sbx_test1/files": func(call) any { return nil },
	}
	ls := run(t, []string{"files", "ls", "sbx_test1"}, opts{routes: rs})
	eq(t, "ls", ls.Stdout, "KIND  SIZE     MODIFIED  NAME\ndir                      app/\nfile  2.0 KiB            a.txt\n\nMore: kantel files ls sbx_test1 /home/user --cursor c2\n")
	cat := run(t, []string{"files", "cat", "sbx_test1", "a.txt"}, opts{routes: rs})
	eq(t, "cat", cat.Stdout, "hi\n")
	get := run(t, []string{"files", "get", "sbx_test1", "a.txt"}, opts{configDir: dir, routes: rs})
	eq(t, "get", get.Stdout, "Wrote "+filepath.Join(dir, "a.txt")+" (3 B).\n")
	got, _ := os.ReadFile(filepath.Join(dir, "a.txt"))
	eq(t, "got", string(got), "hi\n")
	stdout := run(t, []string{"files", "get", "sbx_test1", "a.txt", "-"}, opts{routes: rs})
	eq(t, "get -", stdout.Stdout, "hi\n")
	rm := run(t, []string{"files", "rm", "sbx_test1", "a.txt"}, opts{routes: rs})
	eq(t, "rm", rm.Stdout, "Deleted a.txt.\n")
	eq(t, "rm query", rm.Calls[0].Query["path"][0], "a.txt")
}

type written struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
	Mode     string `json:"mode"`
}

func bodyOf(c call) written {
	var w written
	_ = json.Unmarshal(c.Raw, &w)
	return w
}

func decoded(w written) []byte {
	if w.Encoding == "base64" {
		b, _ := base64.StdEncoding.DecodeString(w.Content)
		return b
	}
	return []byte(w.Content)
}

func TestScpSendsAFileOverOneMiBInParts(t *testing.T) {
	dir := t.TempDir()
	big := bytes.Repeat([]byte{7}, 1024*1024+10)
	_ = os.WriteFile(filepath.Join(dir, "big.bin"), big, 0o644)
	var mu sync.Mutex
	var parts []written
	r := run(t, []string{"scp", "big.bin", "sbx_test1:/srv/big.bin"}, opts{configDir: dir, routes: routes{
		"GET /v1/sandboxes/sbx_test1/files/list": func(call) any { return map[string]any{"path": "/srv", "items": []any{}} },
		"PUT /v1/sandboxes/sbx_test1/files": func(c call) any {
			mu.Lock()
			parts = append(parts, bodyOf(c))
			mu.Unlock()
			return map[string]any{"path": "x", "size": 1}
		},
		commands: func(call) any { return command(nil) },
	}})
	eq(t, "exit", r.Code, 0)
	// The parts' names are this upload's own: a random suffix, then the part's number.
	partName := regexp.MustCompile(`^/srv/big\.bin\.kantel-part-([0-9a-f]{8})-([01])$`)
	m0, m1 := partName.FindStringSubmatch(parts[0].Path), partName.FindStringSubmatch(parts[1].Path)
	if m0 == nil || m1 == nil || m0[1] != m1[1] || m0[2] != "0" || m1[2] != "1" {
		t.Fatalf("parts: %s %s", parts[0].Path, parts[1].Path)
	}
	p0, p1 := parts[0].Path, parts[1].Path
	eq(t, "joined", bytes.Equal(append(decoded(parts[0]), decoded(parts[1])...), big), true)
	var joining string
	for _, c := range r.Calls {
		if strings.HasSuffix(c.Path, "/commands") {
			joining, _ = c.Body["command"].(string)
		}
	}
	eq(t, "join", joining, "cat "+p0+" "+p1+" > /srv/big.bin && rm -f "+p0+" "+p1)
	contains(t, "stdout", r.Stdout, "Copied big.bin (1.0 MiB) to /srv/big.bin.")
}

func TestScpDownloadsAFileIntoADirectoryAndADirectoryWithR(t *testing.T) {
	dir := t.TempDir()
	rs := routes{
		"GET /v1/sandboxes/sbx_test1/files/list": func(c call) any {
			if url.Values(c.Query).Get("path") == "out" {
				return map[string]any{"path": "/home/user/out", "items": []any{map[string]any{"name": "a.txt", "path": "/home/user/out/a.txt", "kind": "file", "size": 2}}}
			}
			return map[string]any{"path": "/home/user", "items": []any{
				map[string]any{"name": "out", "path": "/home/user/out", "kind": "directory", "size": 0},
				map[string]any{"name": "note.txt", "path": "/home/user/note.txt", "kind": "file", "size": 2},
			}}
		},
		"GET /v1/sandboxes/sbx_test1/files": func(c call) any {
			p := url.Values(c.Query).Get("path")
			return map[string]any{"path": p, "content": base64.StdEncoding.EncodeToString([]byte(p + "!")), "encoding": "base64", "size": 2}
		},
	}
	one := run(t, []string{"scp", "sbx_test1:note.txt", "."}, opts{configDir: dir, routes: rs})
	eq(t, "one exit", one.Code, 0)
	got, _ := os.ReadFile(filepath.Join(dir, "note.txt"))
	eq(t, "one", string(got), "note.txt!")
	refused := run(t, []string{"scp", "sbx_test1:out", "."}, opts{configDir: dir, routes: rs})
	eq(t, "refused exit", refused.Code, 2)
	contains(t, "refused", refused.Stderr, "add -r")
	tree := run(t, []string{"scp", "-r", "sbx_test1:out", "."}, opts{configDir: dir, routes: rs})
	eq(t, "tree exit", tree.Code, 0)
	got, _ = os.ReadFile(filepath.Join(dir, "out", "a.txt"))
	eq(t, "tree", string(got), "out/a.txt!")
	contains(t, "tree stdout", tree.Stdout, "Copied 1 file (10 B) to "+filepath.Join(dir, "out")+".")
}

func TestScpRRefusesAListingThatLeadsOutside(t *testing.T) {
	dir := t.TempDir()
	r := run(t, []string{"scp", "-r", "sbx_test1:out", "got"}, opts{configDir: dir, routes: routes{
		"GET /v1/sandboxes/sbx_test1/files/list": func(c call) any {
			if url.Values(c.Query).Get("path") == "out" {
				return map[string]any{"path": "/home/user/out", "items": []any{
					map[string]any{"name": "a.txt", "path": "/home/user/out/a.txt", "kind": "file", "size": 2},
					map[string]any{"name": "../../evil.txt", "path": "/home/evil.txt", "kind": "file", "size": 2},
				}}
			}
			return map[string]any{"path": "/home/user", "items": []any{map[string]any{"name": "out", "path": "/home/user/out", "kind": "directory", "size": 0}}}
		},
		"GET /v1/sandboxes/sbx_test1/files": func(call) any { return map[string]any{"path": "x", "content": "eA==", "encoding": "base64", "size": 1} },
	}})
	eq(t, "exit", r.Code, 1)
	contains(t, "stderr", r.Stderr, "which isn't safe here")
	if _, err := os.Stat(filepath.Join(dir, "evil.txt")); err == nil {
		t.Error("wrote evil.txt")
	}
	if _, err := os.Stat(filepath.Join(dir, "got")); err == nil {
		t.Error("made got")
	}
}

func bigPattern(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}

func TestScpReadsAFileOverOneMiBInRangedReads(t *testing.T) {
	dir := t.TempDir()
	big := bigPattern(2*1024*1024 + 300)
	r := run(t, []string{"scp", "sbx_test1:/srv/big.bin", "got.bin"}, opts{configDir: dir, routes: routes{
		"GET /v1/sandboxes/sbx_test1/files/list": func(call) any {
			return map[string]any{"path": "/srv", "items": []any{map[string]any{"name": "big.bin", "path": "/srv/big.bin", "kind": "file", "size": len(big)}}}
		},
		"GET /v1/sandboxes/sbx_test1/files": func(c call) any {
			offset, _ := strconv.Atoi(url.Values(c.Query).Get("offset"))
			length, _ := strconv.Atoi(url.Values(c.Query).Get("length"))
			return map[string]any{"path": "/srv/big.bin", "encoding": "base64", "size": len(big), "offset": offset,
				"content": base64.StdEncoding.EncodeToString(big[offset:min(offset+length, len(big))])}
		},
	}})
	eq(t, "exit", r.Code, 0)
	got, _ := os.ReadFile(filepath.Join(dir, "got.bin"))
	eq(t, "same", bytes.Equal(got, big), true)
	var reads []string
	for _, c := range r.Calls {
		if strings.HasSuffix(c.Path, "/commands") {
			t.Error("a command in the sandbox")
		}
		if strings.HasSuffix(c.Path, "/files") {
			reads = append(reads, url.Values(c.Query).Get("offset")+":"+url.Values(c.Query).Get("length"))
		}
	}
	eq(t, "reads", strings.Join(reads, " "), "0:1048576 1048576:1048576 2097152:1048576")
}

func TestFilesGetStopsWhenAFileChangesSize(t *testing.T) {
	dir := t.TempDir()
	size := 1024*1024 + 10
	r := run(t, []string{"files", "get", "sbx_test1", "/srv/log", "log"}, opts{configDir: dir, routes: routes{
		"GET /v1/sandboxes/sbx_test1/files": func(c call) any {
			offset, _ := strconv.Atoi(url.Values(c.Query).Get("offset"))
			part := bytes.Repeat([]byte{1}, min(1024*1024, size-offset))
			answer := map[string]any{"path": "/srv/log", "encoding": "base64", "content": base64.StdEncoding.EncodeToString(part), "size": size, "offset": offset}
			size += 5
			return answer
		},
	}})
	eq(t, "exit", r.Code, 1)
	contains(t, "stderr", r.Stderr, "changed size")
}

func TestScpReadsWithCommandsFromAnOlderControlPlane(t *testing.T) {
	dir := t.TempDir()
	big := bigPattern(1024*1024 + 300)
	window := regexp.MustCompile(`tail -c \+(\d+) .* head -c (\d+)`)
	r := run(t, []string{"scp", "sbx_test1:/srv/big.bin", "got.bin"}, opts{configDir: dir, routes: routes{
		"GET /v1/sandboxes/sbx_test1/files/list": func(call) any {
			return map[string]any{"path": "/srv", "items": []any{map[string]any{"name": "big.bin", "path": "/srv/big.bin", "kind": "file", "size": len(big)}}}
		},
		"GET /v1/sandboxes/sbx_test1/files": func(call) any { return kantelError(400, "invalid", "/srv/big.bin is larger than 1 MiB") },
		commands: func(c call) any {
			line, _ := c.Body["command"].(string)
			if strings.HasPrefix(line, "stat ") {
				return command(map[string]any{"stdout": fmt.Sprintf("%d\n", len(big))})
			}
			m := window.FindStringSubmatch(line)
			from, _ := strconv.Atoi(m[1])
			n, _ := strconv.Atoi(m[2])
			from--
			return command(map[string]any{"stdout": base64.StdEncoding.EncodeToString(big[from:min(from+n, len(big))])})
		},
	}})
	eq(t, "exit", r.Code, 0)
	got, _ := os.ReadFile(filepath.Join(dir, "got.bin"))
	eq(t, "same", bytes.Equal(got, big), true)
	n := 0
	for _, c := range r.Calls {
		if strings.HasSuffix(c.Path, "/commands") {
			n++
		}
	}
	eq(t, "commands", n, 4)
}

func TestScpNeedsTheSandboxOnOneSideOnly(t *testing.T) {
	neither := run(t, []string{"scp", "a", "b"}, opts{})
	eq(t, "neither", neither.Code, 2)
	both := run(t, []string{"scp", "sbx_1:a", "sbx_2:b"}, opts{})
	eq(t, "both", both.Code, 2)
	eq(t, "calls", len(both.Calls), 0)
	// A Windows drive is a local path.
	_, ok := parseRemote(`C:\x`)
	eq(t, "drive", ok, false)
}

// A download never writes through a link already in the target, wherever the link goes.
func TestDownloadRefusesALinkInTheTarget(t *testing.T) {
	target := t.TempDir()
	elsewhere := t.TempDir()
	if err := os.Symlink(elsewhere, filepath.Join(target, "cache")); err != nil {
		t.Skip(err)
	}
	if err := noLinkBelow(target, filepath.Join(target, "cache", "authorized_keys")); err == nil {
		t.Error("wrote through a link")
	}
	if err := noLinkBelow(target, filepath.Join(target, "fresh", "file")); err != nil {
		t.Errorf("a new path: %v", err)
	}
}
