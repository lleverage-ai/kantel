package cli

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
)

func TestParse(t *testing.T) {
	specs := []Flag{
		{Name: "name", Type: String}, {Name: "label", Type: String, Multiple: true},
		{Name: "all", Type: Bool}, {Name: "wait", Type: Bool}, {Name: "help", Type: Bool, Short: "h"},
	}
	p, err := Parse([]string{"a", "--name", "x", "--label=k=v", "--label", "j=w", "--all", "--no-wait", "-h", "b", "--", "ls", "--all"}, specs)
	if err != nil {
		t.Fatal(err)
	}
	if name, _ := p.Str("name"); name != "x" {
		t.Errorf("name %q", name)
	}
	if got := strings.Join(p.List("label"), ","); got != "k=v,j=w" {
		t.Errorf("labels %q", got)
	}
	if wait, set := p.BoolSet("wait"); wait || !set {
		t.Errorf("--no-wait: %v %v", wait, set)
	}
	if !p.Bool("all") || !p.Bool("help") {
		t.Error("booleans")
	}
	if strings.Join(p.Args, " ") != "a b" || strings.Join(p.Rest, " ") != "ls --all" || !p.HasRest {
		t.Errorf("args %v rest %v", p.Args, p.Rest)
	}
	for argv, want := range map[string]string{
		"--nmae x":    "unknown flag --nmae. Did you mean --name?",
		"--name":      "--name needs a value",
		"--all=maybe": `--all takes no value (or true or false), not "maybe"`,
		"-q":          "unknown flag -q",
	} {
		_, err := Parse(strings.Fields(argv), specs)
		var e *Error
		if !errors.As(err, &e) || e.Message != want || e.Exit != ExitUsage {
			t.Errorf("%s: %v", argv, err)
		}
	}
	// A negative number is a value, not a flag.
	if p, err := Parse([]string{"-5"}, specs); err != nil || p.Args[0] != "-5" {
		t.Errorf("-5: %v %v", p, err)
	}
}

func TestNearest(t *testing.T) {
	words := []string{"new", "list", "info", "snapshot", "sizes", "stop", "start"}
	for typed, want := range map[string]string{"nwe": "new", "lsit": "list", "snap": "snapshot", "stpo": "stop"} {
		if got := Nearest(typed, words, 3); len(got) == 0 || got[0] != want {
			t.Errorf("%s: %v", typed, got)
		}
	}
	if got := Nearest("frobnicate", words, 3); len(got) != 0 {
		t.Errorf("frobnicate: %v", got)
	}
	if got := DidYouMean([]string{"a", "b", "c"}); got != " Did you mean a, b or c?" {
		t.Error(got)
	}
}

func TestFailures(t *testing.T) {
	apiErr := &api.Error{Status: 401, Code: "unauthenticated", Message: "A bearer is needed"}
	f := FailureOf(apiErr, func(*api.Error) string { return "Sign in" })
	if f.Exit != ExitSignIn || f.Hint != "Sign in" {
		t.Errorf("%+v", f)
	}
	if got := FailureText("kantel", f, false, "", Styler{}); got != "kantel: unauthenticated: A bearer is needed\nSign in\n" {
		t.Errorf("%q", got)
	}
	var line map[string]Failure
	if err := json.Unmarshal([]byte(FailureText("kantel", f, true, "", Styler{})), &line); err != nil || line["error"].Code != "unauthenticated" {
		t.Errorf("json: %v %+v", err, line)
	}
	usage := FailureOf(Usage("info needs <id>"), nil)
	if got := FailureText("kantel", usage, false, "kantel info <id> [flags]", Styler{}); got != "kantel: info needs <id>\nUsage: kantel info <id> [flags]\n" {
		t.Errorf("%q", got)
	}
	unreachable := FailureOf(&api.UnreachableError{Origin: "https://k.test", Err: errors.New("refused")}, nil)
	if unreachable.Code != "unreachable" || unreachable.Exit != ExitFailed {
		t.Errorf("%+v", unreachable)
	}
	if !WantsJSON([]string{"list", "--json"}) || WantsJSON([]string{"exec", "x", "--", "jq", "--json"}) {
		t.Error("WantsJSON")
	}
}

func TestColourAndTables(t *testing.T) {
	if !ColourFor(true, Env{}, false) || ColourFor(false, Env{}, false) || ColourFor(true, Env{"NO_COLOR": "1"}, false) ||
		ColourFor(true, Env{"TERM": "dumb"}, false) || ColourFor(true, Env{}, true) || !ColourFor(false, Env{"FORCE_COLOR": "1"}, false) {
		t.Error("ColourFor")
	}
	s := Styler{On: true}
	table := Table(s, []string{"A", "B"}, [][]string{{s.State("running"), "x"}, {"longer", "y"}})
	if got := Plain(table); got != "A        B\nrunning  x\nlonger   y" {
		t.Errorf("%q", got)
	}
	if tone, ok := StateTone("error: out of memory"); !ok || tone != Red {
		t.Error("error tone")
	}
	if got := Fields(Styler{}, []Field{{"id", "x"}, {"empty", ""}, {"longer", "y"}}); got != "id      x\nlonger  y" {
		t.Errorf("%q", got)
	}
}

func TestNormaliseURL(t *testing.T) {
	for in, want := range map[string]string{
		"kantel.example":           "https://kantel.example/v1",
		"https://kantel.example/":  "https://kantel.example/v1",
		"http://localhost:8080/v1": "http://localhost:8080/v1",
		"localhost:8080":           "http://localhost:8080/v1",
	} {
		if got, err := NormaliseURL(in); err != nil || got != want {
			t.Errorf("%s: %s %v", in, got, err)
		}
	}
	if _, err := NormaliseURL("ftp://x"); err == nil {
		t.Error("ftp")
	}
}

func TestCompletionScripts(t *testing.T) {
	for _, shell := range Shells {
		script := CompletionScript("kantel-admin", shell)
		if !strings.Contains(script, "kantel-admin __complete --") || !strings.Contains(script, "_kantel_admin") {
			t.Errorf("%s: %s", shell, script)
		}
	}
	if got := CandidateLines([]Candidate{{"save", "Keep  it"}, {"take", ""}, {"save", "again"}}, "s"); got != "save\tKeep it\n" {
		t.Errorf("%q", got)
	}
}
