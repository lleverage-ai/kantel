package kantel

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

func TestListAndInfo(t *testing.T) {
	r := run(t, []string{"list"}, opts{routes: routes{
		"GET /v1/sandboxes": func(call) any { return map[string]any{"items": []any{sandbox(nil)}} },
	}})
	eq(t, "exit", r.Code, 0)
	contains(t, "list", r.Stdout, "sbx_test1  brisk-otter  isolate  running")
	if strings.Contains(r.Stdout, "\x1b[") {
		t.Errorf("colour in a pipe: %q", r.Stdout)
	}

	r = run(t, []string{"info", "sbx_test1", "--json"}, opts{routes: routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any { return sandbox(map[string]any{"future": "kept"}) },
	}})
	// --json prints Kantel's answer as it is, fields this kantel doesn't know included.
	contains(t, "info --json", r.Stdout, `"future": "kept"`)
}

func TestErrorsAndExitCodes(t *testing.T) {
	r := run(t, []string{"info", "sbx_nope", "--json"}, opts{})
	eq(t, "exit", r.Code, 1)
	eq(t, "stdout", r.Stdout, "")
	var body map[string]map[string]any
	if err := json.Unmarshal([]byte(r.Stderr), &body); err != nil {
		t.Fatalf("stderr isn't JSON: %q", r.Stderr)
	}
	eq(t, "code", body["error"]["code"], any("not_found"))

	r = run(t, []string{"whoami"}, opts{routes: routes{
		"GET /v1/whoami": func(call) any { return kantelError(401, "unauthenticated", "A bearer is needed") },
	}})
	eq(t, "unauthenticated exit", r.Code, 4)
	contains(t, "hint", r.Stderr, "Sign in with: kantel login")

	r = run(t, []string{"info"}, opts{})
	eq(t, "usage exit", r.Code, 2)
	contains(t, "usage", r.Stderr, "kantel: info needs <id>\nUsage: kantel info <id> [flags]")

	r = run(t, []string{"nwe"}, opts{})
	eq(t, "typo exit", r.Code, 2)
	contains(t, "typo", r.Stderr, `there is no command "nwe". Did you mean kantel new?`)

	r = run(t, []string{"new", "--tpye", "microvm"}, opts{})
	contains(t, "flag typo", r.Stderr, "unknown flag --tpye. Did you mean --type?")

	r = run(t, []string{"snapshot", "lsit"}, opts{})
	eq(t, "subcommand typo exit", r.Code, 2)
}

func TestNewSendsWhatWasAsked(t *testing.T) {
	r := run(t, []string{"new", "--type", "microvm", "--vcpus", "8", "--memory", "16", "--auto-stop", "never", "-e", "A=1", "--label", "k=v"},
		opts{routes: routes{"POST /v1/sandboxes": func(c call) any { return sandbox(map[string]any{"type": "microvm"}) }}})
	eq(t, "exit", r.Code, 0)
	body := r.Calls[0].Body
	got, _ := json.Marshal(body)
	want := `{"autoStopMinutes":null,"env":{"A":"1"},"labels":{"k":"v"},"resources":{"memoryMb":16384,"vcpus":8},"type":"microvm","wait":true}`
	eq(t, "body", string(got), want)
	if r.Calls[0].Key == "" {
		t.Error("no Idempotency-Key on create")
	}
	contains(t, "out", r.Stdout, "Created sbx_test1 (brisk-otter)")

	r = run(t, []string{"new", "--disk", "60"}, opts{})
	eq(t, "disk without microvm", r.Code, 2)
}

func TestDeleteNeedsYes(t *testing.T) {
	r := run(t, []string{"delete", "sbx_test1"}, opts{})
	eq(t, "exit", r.Code, 2)
	eq(t, "calls", len(r.Calls), 0)
	contains(t, "says how", r.Stderr, "kantel delete sbx_test1 --yes")
}

func TestRetriesAProxysFailureOnARead(t *testing.T) {
	n := 0
	r := run(t, []string{"info", "sbx_test1"}, opts{routes: routes{
		"GET /v1/sandboxes/sbx_test1": func(call) any {
			n++
			if n < 3 {
				return reply{Status: 502, Text: "bad gateway"}
			}
			return sandbox(nil)
		},
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "tries", n, 3)
}

func TestHelpJSONAndExamples(t *testing.T) {
	r := run(t, []string{"help", "--json"}, opts{})
	var schema cli.Schema
	if err := json.Unmarshal([]byte(r.Stdout), &schema); err != nil {
		t.Fatal(err)
	}
	eq(t, "calls", len(r.Calls), 0)
	eq(t, "version", schema.SchemaVersion, 1)
	// Every example names a real command and real flags.
	p := Program()
	for _, c := range p.Commands() {
		for _, e := range c.Examples {
			i := strings.Index(e.Line, "kantel ")
			part := e.Line[i+len("kantel "):]
			if j := strings.IndexAny(part, "|)"); j >= 0 {
				part = part[:j]
			}
			words := shellWords(part)
			argv := words
			if k := indexOf(words, "--"); k >= 0 {
				argv = append(append(append([]string{}, words[:k]...), "--help"), words[k:]...)
			} else {
				argv = append(argv, "--help")
			}
			r := run(t, argv, opts{})
			if r.Code != 0 || !strings.Contains(r.Stdout, "Usage: kantel "+c.Name) {
				t.Errorf("example %q: exit %d, %s", e.Line, r.Code, r.Stderr)
			}
		}
	}
}

func TestCompletion(t *testing.T) {
	complete := func(o opts, words ...string) string {
		return run(t, append([]string{"__complete", "--"}, words...), o).Stdout
	}
	eq(t, "group", complete(opts{}, "sn"), "snapshot\tTake, save, browse and delete snapshots\n")
	eq(t, "values", complete(opts{}, "new", "--type", ""), "isolate\t\nmicrovm\t\n")
	got := complete(opts{routes: routes{"GET /v1/sandboxes": func(call) any {
		return map[string]any{"items": []any{sandbox(nil)}}
	}}}, "info", "")
	eq(t, "sandbox IDs", got, "sbx_test1\tbrisk-otter (running)\n")
	for _, shell := range cli.Shells {
		contains(t, shell, run(t, []string{"completion", shell}, opts{}).Stdout, "kantel __complete --")
	}
}

func TestColourAtATerminalOnly(t *testing.T) {
	list := routes{"GET /v1/sandboxes": func(call) any { return map[string]any{"items": []any{sandbox(nil)}} }}
	r := run(t, []string{"list"}, opts{routes: list, tty: true})
	contains(t, "state", r.Stdout, "\x1b[32mrunning\x1b[39m")
	plain := run(t, []string{"list"}, opts{routes: list})
	eq(t, "same text", cli.Plain(r.Stdout), plain.Stdout)
	r = run(t, []string{"list"}, opts{routes: list, tty: true, env: cli.Env{"KANTEL_URL": "$FAKE", "KANTEL_API_KEY": "k", "NO_COLOR": "1"}})
	if strings.Contains(r.Stdout, "\x1b[") {
		t.Error("colour with NO_COLOR")
	}
}

func shellWords(line string) []string {
	var words []string
	var cur strings.Builder
	quote := rune(0)
	in := false
	for _, r := range line {
		switch {
		case quote != 0 && r == quote:
			quote = 0
		case quote != 0:
			cur.WriteRune(r)
		case r == '\'' || r == '"':
			quote, in = r, true
		case r == ' ':
			if in || cur.Len() > 0 {
				words = append(words, cur.String())
				cur.Reset()
				in = false
			}
		default:
			cur.WriteRune(r)
			in = true
		}
	}
	if in || cur.Len() > 0 {
		words = append(words, cur.String())
	}
	return words
}

func indexOf(words []string, w string) int {
	for i, x := range words {
		if x == w {
			return i
		}
	}
	return -1
}
