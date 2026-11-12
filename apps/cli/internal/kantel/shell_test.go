package kantel

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// kantel ssh to an isolate: the pseudo-shell (the "ssh to an isolate" part of packages/cli/test/cli.test.ts, and
// packages/cli/test/shell.test.ts for its script and trailer).

const testMarker = "__kantel_00ff__"

func TestShellParsesExportsAsJustBashAndBashPrintThem(t *testing.T) {
	text := "declare -x E=\"\"\ndeclare -x PATH=\"/usr/bin\"\n" +
		"declare -x X=$'a\"b\\\\c$d`e\\nnl\\x41\\101'\ndeclare -x Z\n" +
		"declare -x Q=\"say \\\"hi\\\" \\$HOME\"\n"
	got := parseExports(text)
	want := map[string]string{"E": "", "PATH": "/usr/bin", "X": "a\"b\\c$d`e\nnlAA", "Z": "", "Q": `say "hi" $HOME`}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("exports: got %q, want %q", got, want)
	}
	if parseExports("export X=1\n") != nil {
		t.Error("an unknown line was read")
	}
}

func TestShellHoldsBackTheMarker(t *testing.T) {
	eq(t, "plain", shownLength("hello", testMarker), 5)
	eq(t, "its start", shownLength("hello__kan", testMarker), 5)
	eq(t, "the marker", shownLength("hello"+testMarker+"0\n/workspace\n", testMarker), 5)
}

func TestShellCarriesTheDirectoryAndVariables(t *testing.T) {
	state := &shellState{vars: map[string]string{}, unset: map[string]bool{}}
	applyTrailer(state, readTrailer(testMarker+"0\n/workspace\ndeclare -x HOME=\"/workspace\"\ndeclare -x PWD=\"/workspace\"\n", testMarker))
	next := readTrailer("out"+testMarker+"3\n/workspace/app\ndeclare -x A=\"1\"\ndeclare -x PWD=\"/workspace/app\"\n", testMarker)
	eq(t, "status", next.status, 3)
	applyTrailer(state, next)
	eq(t, "cwd", state.cwd, "/workspace/app")
	eq(t, "vars", fmt.Sprint(state.vars), "map[A:1]")
	eq(t, "unset", fmt.Sprint(state.unset), "map[HOME:true]")
	eq(t, "script", shellScript("ls", testMarker, state), strings.Join([]string{
		"cd '/workspace/app'", "unset HOME", "export A='1'", "ls",
		`__kantel_status=$?; printf '%s%s\n' '` + testMarker + `' "$__kantel_status"; pwd; export -p; exit "$__kantel_status"`,
	}, "\n"))
	if readTrailer("no marker", testMarker) != nil {
		t.Error("a trailer with no marker")
	}
}

func TestShellMapsADirectoryToTheMicrovm(t *testing.T) {
	eq(t, "none", microvmPath(""), "/home/user/workspace")
	eq(t, "workspace", microvmPath("/workspace"), "/home/user/workspace")
	eq(t, "in it", microvmPath("/workspace/a b"), "/home/user/workspace/a b")
	eq(t, "elsewhere", microvmPath("/tmp"), "/tmp")
	eq(t, "login", loginShellIn("/home/user/it's"), `cd '/home/user/it'\''s' 2>/dev/null; exec "${SHELL:-/bin/bash}" -l`)
}

// isolateAnswer is what a line the fake isolate runs answers.
type isolateAnswer struct {
	stdout, stderr string
	exitCode       int
	needsMicrovm   map[string]any
	// rerun: the sandbox upgraded itself and ran it again, answering this.
	rerun *isolateAnswer
	// cwd and exports: what the line left, as its trailer says, where it changed them itself (cd app && git status).
	cwd     string
	exports map[string]string
}

// fakeIsolate is an isolate behind the commands API: it reads the pseudo-shell's script (the directory and variables
// it sets, the line, and the trailer's marker), runs cd, export, pwd, echo and false itself, asks answer for anything
// else, and answers with the trailer as a shell would print it.
type fakeIsolate struct {
	mu       sync.Mutex
	lines    []string
	scripts  []string
	commands map[string]map[string]any
	answer   func(line string) *isolateAnswer
}

var (
	scriptMarker = regexp.MustCompile(`printf '%s%s\\n' '([^']+)'`)
	scriptCd     = regexp.MustCompile(`^cd '(.*)'$`)
	scriptExport = regexp.MustCompile(`^export (\w+)='(.*)'$`)
	lineCd       = regexp.MustCompile(`^cd (\S+)$`)
	lineExport   = regexp.MustCompile(`^export (\w+)=(\S*)$`)
	lineVar      = regexp.MustCompile(`\$(\w+)`)
)

func newFakeIsolate(answer func(line string) *isolateAnswer) *fakeIsolate {
	if answer == nil {
		answer = func(string) *isolateAnswer { return nil }
	}
	return &fakeIsolate{commands: map[string]map[string]any{}, answer: answer}
}

func (f *fakeIsolate) record(marker, cwd string, vars map[string]string, line string, got isolateAnswer) map[string]any {
	id := fmt.Sprintf("cmd_%d", len(f.commands)+1)
	names := make([]string, 0, len(vars))
	for name := range vars {
		names = append(names, name)
	}
	sort.Strings(names)
	stdout := got.stdout
	if marker != "" {
		stdout += fmt.Sprintf("%s%d\n%s\n", marker, got.exitCode, cwd)
		for _, name := range names {
			stdout += "declare -x " + name + "=\"" + vars[name] + "\"\n"
		}
	}
	made := command(map[string]any{"id": id, "command": line, "exitCode": got.exitCode, "stdout": stdout, "stderr": got.stderr})
	if got.needsMicrovm != nil {
		made["needsMicrovm"] = got.needsMicrovm
	}
	f.commands[id] = made
	if got.rerun != nil {
		rerun := f.record(marker, cwd, vars, line, *got.rerun)
		rerun["rerunOf"] = id
		made["rerunAs"] = rerun["id"]
	}
	return made
}

func (f *fakeIsolate) routes(sandboxFields map[string]any) routes {
	r := routes{
		"POST /v1/sandboxes/sbx_test1/ssh": func(call) any {
			return kantelError(501, "not_supported", "SSH needs a microVM; this is an isolate")
		},
		"GET /v1/sandboxes/sbx_test1": func(call) any { return sandbox(sandboxFields) },
		commands: func(c call) any {
			f.mu.Lock()
			defer f.mu.Unlock()
			script, _ := c.Body["command"].(string)
			f.scripts = append(f.scripts, script)
			parts := strings.Split(script, "\n")
			trailer := parts[len(parts)-1]
			parts = parts[:len(parts)-1]
			m := scriptMarker.FindStringSubmatch(trailer)
			if m == nil {
				got := f.answer(script)
				if got == nil {
					got = &isolateAnswer{}
				}
				return f.record("", "", nil, script, *got)
			}
			cwd := "/workspace"
			vars := map[string]string{"HOME": "/workspace", "PATH": "/usr/bin"}
			for len(parts) > 1 {
				part := parts[0]
				parts = parts[1:]
				if cd := scriptCd.FindStringSubmatch(part); cd != nil {
					cwd = cd[1]
				} else if set := scriptExport.FindStringSubmatch(part); set != nil {
					vars[set[1]] = set[2]
				}
			}
			line := parts[0]
			f.lines = append(f.lines, line)
			got := f.answer(line)
			switch cd, set := lineCd.FindStringSubmatch(line), lineExport.FindStringSubmatch(line); {
			case got != nil:
			case cd != nil:
				if strings.HasPrefix(cd[1], "/") {
					cwd = cd[1]
				} else {
					cwd += "/" + cd[1]
				}
			case set != nil:
				vars[set[1]] = set[2]
			case line == "pwd":
				got = &isolateAnswer{stdout: cwd + "\n"}
			case strings.HasPrefix(line, "echo "):
				got = &isolateAnswer{stdout: lineVar.ReplaceAllStringFunc(line[5:], func(v string) string { return vars[v[1:]] }) + "\n"}
			case line == "false":
				got = &isolateAnswer{exitCode: 1}
			}
			if got == nil {
				got = &isolateAnswer{}
			}
			if got.cwd != "" {
				cwd = got.cwd
			}
			for name, value := range got.exports {
				vars[name] = value
			}
			return f.record(m[1], cwd, vars, line, *got)
		},
	}
	for n := 1; n <= 20; n++ {
		id := fmt.Sprintf("cmd_%d", n)
		r["GET /v1/sandboxes/sbx_test1/commands/"+id] = func(call) any {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.commands[id]
		}
	}
	return r
}

func (f *fakeIsolate) Lines() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.lines...)
}

var sshAccess = map[string]any{
	"host": "ssh.kantel.test", "port": 2222, "user": "sbx_test1", "command": "ssh -p 2222 sbx_test1@ssh.kantel.test",
	"expiresAt": time.Now().Add(10 * time.Minute).UnixMilli(),
}

// sshAfterUpgrade lets SSH in once the isolate has been upgraded.
func sshAfterUpgrade(r routes) routes {
	var mu sync.Mutex
	upgraded := false
	refuse := r["POST /v1/sandboxes/sbx_test1/ssh"]
	r["POST /v1/sandboxes/sbx_test1/upgrade"] = func(call) any {
		mu.Lock()
		upgraded = true
		mu.Unlock()
		return sandbox(map[string]any{"type": "microvm"})
	}
	r["POST /v1/sandboxes/sbx_test1/ssh"] = func(c call) any {
		mu.Lock()
		defer mu.Unlock()
		if upgraded {
			return sshAccess
		}
		return refuse(c)
	}
	return r
}

// stubSSH records the ssh runs in place of running ssh.
func stubSSH(t *testing.T) *[][]string {
	t.Helper()
	var runs [][]string
	sshRunner = func(_ *cli.Context, args []string, _ map[string]string) error {
		runs = append(runs, args)
		return nil
	}
	t.Cleanup(func() { sshRunner = runSSH })
	return &runs
}

var needsGit = map[string]any{"command": "git", "reason": "An isolate has no git; a microVM does."}

func TestSSHIsolatePipedLines(t *testing.T) {
	runs := stubSSH(t)
	f := newFakeIsolate(nil)
	r := run(t, []string{"ssh", "sbx_test1"}, opts{routes: f.routes(nil),
		stdin: "cd app\nexport GREETING=hi\npwd\necho $GREETING\nfalse\n"})
	eq(t, "exit", r.Code, 1)
	eq(t, "stdout", r.Stdout, "/workspace/app\nhi\n")
	eq(t, "stderr", r.Stderr, "")
	// The first runs nothing: where the shell starts, and its own variables.
	eq(t, "lines", strings.Join(f.Lines(), "|"), ":|cd app|export GREETING=hi|pwd|echo $GREETING|false")
	eq(t, "script", strings.Join(strings.Split(f.scripts[4], "\n")[:3], "|"), "cd '/workspace/app'|export GREETING='hi'|echo $GREETING")
	eq(t, "ssh runs", len(*runs), 0)
}

func TestSSHIsolateSaysWhatWentWrongAndGoesOn(t *testing.T) {
	stubSSH(t)
	f := newFakeIsolate(nil)
	rs := f.routes(nil)
	run3 := rs[commands]
	var mu sync.Mutex
	posts := 0
	rs[commands] = func(c call) any {
		mu.Lock()
		posts++
		n := posts
		mu.Unlock()
		if n == 3 {
			return reply{Status: 409, Body: map[string]any{"error": map[string]any{
				"code": "conflict", "message": "The sandbox is stopped (auto-stop); resume it first",
				"details": map[string]any{"code": "sandbox_stopped", "sandboxId": "sbx_test1", "state": "stopped",
					"hint": "Resume it with kantel resume sbx_test1"},
			}}}
		}
		return run3(c)
	}
	r := run(t, []string{"ssh", "sbx_test1"}, opts{routes: rs, stdin: "echo one\necho two\necho three"})
	eq(t, "stdout", r.Stdout, "one\nthree\n")
	contains(t, "stderr", r.Stderr, "The sandbox is stopped (auto-stop); resume it first")
	contains(t, "stderr", r.Stderr, "Resume it with: kantel resume sbx_test1")
	eq(t, "exit", r.Code, 0)
}

func TestSSHIsolateStopped(t *testing.T) {
	stubSSH(t)
	f := newFakeIsolate(nil)
	r := run(t, []string{"ssh", "sbx_test1"}, opts{routes: f.routes(map[string]any{"state": "stopped"}), stdin: "ls\n"})
	eq(t, "exit", r.Code, 1)
	eq(t, "stderr", r.Stderr,
		"kantel: brisk-otter (sbx_test1) is stopped. Resume it with kantel resume sbx_test1, then run kantel ssh sbx_test1 again.\n")
	eq(t, "lines", len(f.Lines()), 0)
}

func TestSSHIsolateAtATerminal(t *testing.T) {
	stubSSH(t)
	f := newFakeIsolate(nil)
	r := run(t, []string{"ssh", "sbx_test1"}, opts{routes: f.routes(nil), stdin: "help\ncd app\nfalse\n", stdinTTY: true})
	eq(t, "exit", r.Code, 1)
	contains(t, "stderr", r.Stderr, "this is a pseudo-shell over Kantel's commands API")
	contains(t, "stderr", r.Stderr, "node and python work.")
	contains(t, "stderr", r.Stderr, "Auto-upgrade is off")
	contains(t, "stderr", r.Stderr, "upgrade   Upgrade this isolate to a microVM now")
	contains(t, "stderr", r.Stderr, "user@brisk-otter:/workspace$ ")
	contains(t, "stderr", r.Stderr, "[1] user@brisk-otter:/workspace/app$ ")
}

func TestSSHIsolateAsksToUpgrade(t *testing.T) {
	runs := stubSSH(t)
	var mu sync.Mutex
	upgraded := false
	f := newFakeIsolate(func(line string) *isolateAnswer {
		if line != "git status" {
			return nil
		}
		mu.Lock()
		defer mu.Unlock()
		if upgraded {
			return &isolateAnswer{stdout: "On branch main\n"}
		}
		return &isolateAnswer{exitCode: 127, stderr: "bash: git: command not found\n", needsMicrovm: needsGit}
	})
	rs := sshAfterUpgrade(f.routes(nil))
	upgrade := rs["POST /v1/sandboxes/sbx_test1/upgrade"]
	rs["POST /v1/sandboxes/sbx_test1/upgrade"] = func(c call) any {
		mu.Lock()
		upgraded = true
		mu.Unlock()
		return upgrade(c)
	}
	r := run(t, []string{"ssh", "sbx_test1"}, opts{routes: rs, stdin: "cd app\ngit status\ny\n", stdinTTY: true})
	eq(t, "exit", r.Code, 0)
	contains(t, "stderr", r.Stderr, "An isolate has no git; a microVM does. Upgrade this sandbox to a microVM now? [y/N] ")
	if strings.Contains(r.Stderr, "kantel upgrade sbx_test1 turns") {
		t.Error("the upgrade hint was given as well as the question")
	}
	if !regexp.MustCompile(`Upgraded to a microVM in \d+s\.`).MatchString(r.Stderr) {
		t.Errorf("no time for the upgrade: %q", r.Stderr)
	}
	eq(t, "stdout", r.Stdout, "On branch main\n")
	eq(t, "lines", strings.Join(f.Lines(), "|"), ":|cd app|git status|git status")
	for _, c := range r.Calls {
		if c.Path == "/v1/sandboxes/sbx_test1/upgrade" {
			body, _ := json.Marshal(c.Body)
			eq(t, "upgrade body", string(body), `{"wait":true}`)
		}
	}
	contains(t, "stderr", r.Stderr, "Switching to SSH on the microVM, in /home/user/workspace/app.")
	eq(t, "ssh", fmt.Sprint(*runs), fmt.Sprint([][]string{{"-t", "-p", "2222", "sbx_test1@ssh.kantel.test", "--",
		`cd '/home/user/workspace/app' 2>/dev/null; exec "${SHELL:-/bin/bash}" -l`}}))
}

// A line refused for want of a microVM may have changed the directory or variables before it was: its retry once the
// sandbox is upgraded starts where the line first did, not where the refusal left it (else cd app && git status runs
// cd app again, in /workspace/app). What the retry leaves is what the session goes on with.
func TestSSHIsolateRetriesTheLineFromWhereItStarted(t *testing.T) {
	runs := stubSSH(t)
	const line = "cd app && export STAGE=one && git status"
	var mu sync.Mutex
	upgraded := false
	f := newFakeIsolate(func(got string) *isolateAnswer {
		if got != line {
			return nil
		}
		mu.Lock()
		defer mu.Unlock()
		if upgraded {
			return &isolateAnswer{stdout: "On branch main\n", cwd: "/workspace/app", exports: map[string]string{"STAGE": "one"}}
		}
		return &isolateAnswer{exitCode: 127, stderr: "bash: git: command not found\n", needsMicrovm: needsGit,
			cwd: "/workspace/app", exports: map[string]string{"STAGE": "one"}}
	})
	rs := sshAfterUpgrade(f.routes(nil))
	upgrade := rs["POST /v1/sandboxes/sbx_test1/upgrade"]
	rs["POST /v1/sandboxes/sbx_test1/upgrade"] = func(c call) any {
		mu.Lock()
		upgraded = true
		mu.Unlock()
		return upgrade(c)
	}
	r := run(t, []string{"ssh", "sbx_test1"}, opts{routes: rs, stdin: "export KEEP=1\n" + line + "\ny\n", stdinTTY: true})
	eq(t, "exit", r.Code, 0)
	eq(t, "stdout", r.Stdout, "On branch main\n")
	eq(t, "lines", strings.Join(f.Lines(), "|"), ":|export KEEP=1|"+line+"|"+line)
	setUp := func(script string) string {
		parts := strings.Split(script, "\n")
		return strings.Join(parts[:len(parts)-2], "|")
	}
	eq(t, "first", setUp(f.scripts[2]), "cd '/workspace'|export KEEP='1'")
	eq(t, "retry", setUp(f.scripts[3]), "cd '/workspace'|export KEEP='1'")
	// The retry's trailer: SSH opens where it left the session.
	contains(t, "stderr", r.Stderr, "Switching to SSH on the microVM, in /home/user/workspace/app.")
	eq(t, "ssh runs", len(*runs), 1)
}

// Declined, the refused line's directory and variables stay the session's, as any line's do.
func TestSSHIsolateKeepsWhatTheRefusedLineLeftWhenNotUpgraded(t *testing.T) {
	stubSSH(t)
	const line = "cd app && export STAGE=one && git status"
	f := newFakeIsolate(func(got string) *isolateAnswer {
		if got == line {
			return &isolateAnswer{exitCode: 127, needsMicrovm: needsGit, cwd: "/workspace/app", exports: map[string]string{"STAGE": "one"}}
		}
		return nil
	})
	r := run(t, []string{"ssh", "sbx_test1"}, opts{routes: f.routes(nil), stdin: line + "\nn\npwd\necho $STAGE\n", stdinTTY: true})
	eq(t, "stdout", r.Stdout, "/workspace/app\none\n")
}

func TestSSHIsolateNotUpgradedWhenTheAnswerIsNo(t *testing.T) {
	runs := stubSSH(t)
	f := newFakeIsolate(func(line string) *isolateAnswer {
		if line == "git status" {
			return &isolateAnswer{exitCode: 127, needsMicrovm: needsGit}
		}
		return nil
	})
	r := run(t, []string{"ssh", "sbx_test1"}, opts{routes: f.routes(nil), stdin: "git status\nn\n", stdinTTY: true})
	eq(t, "exit", r.Code, 127)
	contains(t, "stderr", r.Stderr, "Not upgraded. Type upgrade, or run kantel upgrade sbx_test1, when you want it.")
	for _, c := range r.Calls {
		if strings.HasSuffix(c.Path, "/upgrade") {
			t.Error("upgraded")
		}
	}
	eq(t, "ssh runs", len(*runs), 0)
}

func TestSSHIsolateUpgradedItself(t *testing.T) {
	runs := stubSSH(t)
	f := newFakeIsolate(func(line string) *isolateAnswer {
		if line == "git clone https://example.test/app.git" {
			return &isolateAnswer{exitCode: 127, stderr: "bash: git: command not found\n", needsMicrovm: needsGit,
				rerun: &isolateAnswer{stdout: "Cloning into 'app'...\n"}}
		}
		return nil
	})
	rs := f.routes(map[string]any{"autoUpgrade": true})
	var mu sync.Mutex
	asked := 0
	rs["POST /v1/sandboxes/sbx_test1/ssh"] = func(call) any {
		mu.Lock()
		defer mu.Unlock()
		if asked++; asked == 1 {
			return kantelError(501, "not_supported", "SSH needs a microVM; this is an isolate")
		}
		return sshAccess
	}
	r := run(t, []string{"ssh", "sbx_test1"}, opts{routes: rs, stdin: "git clone https://example.test/app.git\n", stdinTTY: true})
	eq(t, "exit", r.Code, 0)
	contains(t, "stderr", r.Stderr, "Auto-upgrade is on")
	contains(t, "stderr", r.Stderr, "This needed a microVM (git): the sandbox has been upgraded, and the command ran again there.")
	eq(t, "stdout", r.Stdout, "Cloning into 'app'...\n")
	for _, c := range r.Calls {
		if strings.HasSuffix(c.Path, "/upgrade") {
			t.Error("upgraded by the CLI")
		}
	}
	if len(*runs) != 1 {
		t.Fatalf("ssh runs: %v", *runs)
	}
	args := (*runs)[0]
	eq(t, "remote", args[len(args)-1], `cd '/home/user/workspace' 2>/dev/null; exec "${SHELL:-/bin/bash}" -l`)
}

func TestSSHIsolateUpgradeBuiltIn(t *testing.T) {
	runs := stubSSH(t)
	f := newFakeIsolate(nil)
	r := run(t, []string{"ssh", "sbx_test1"}, opts{routes: sshAfterUpgrade(f.routes(nil)), stdin: "cd src\nupgrade\n", stdinTTY: true})
	eq(t, "exit", r.Code, 0)
	upgrades := 0
	for _, c := range r.Calls {
		if strings.HasSuffix(c.Path, "/upgrade") {
			upgrades++
		}
	}
	eq(t, "upgrades", upgrades, 1)
	contains(t, "stderr", r.Stderr, "Switching to SSH on the microVM, in /home/user/workspace/src.")
	if len(*runs) != 1 || (*runs)[0][0] != "-t" {
		t.Errorf("ssh runs: %v", *runs)
	}
}

func TestSSHIsolateOneCommand(t *testing.T) {
	runs := stubSSH(t)
	f := newFakeIsolate(func(line string) *isolateAnswer {
		if line == "git status" {
			return &isolateAnswer{exitCode: 127, stderr: "bash: git: command not found\n", needsMicrovm: needsGit}
		}
		return nil
	})
	r := run(t, []string{"ssh", "sbx_test1", "--", "git", "status"}, opts{routes: f.routes(nil)})
	eq(t, "exit", r.Code, 127)
	eq(t, "scripts", strings.Join(f.scripts, "|"), "git status")
	contains(t, "stderr", r.Stderr, "kantel: git needs a microVM. kantel upgrade sbx_test1 turns this isolate into one")
	eq(t, "ssh runs", len(*runs), 0)
}

func TestSSHMicrovmUnchanged(t *testing.T) {
	runs := stubSSH(t)
	r := run(t, []string{"ssh", "sbx_test1", "--", "uname"}, opts{routes: routes{
		"POST /v1/sandboxes/sbx_test1/ssh": func(call) any { return sshAccess },
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "ssh", fmt.Sprint(*runs), fmt.Sprint([][]string{{"-p", "2222", "sbx_test1@ssh.kantel.test", "--", "uname"}}))
}
