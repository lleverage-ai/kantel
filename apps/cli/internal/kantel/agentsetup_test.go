package kantel

// kantel agent setup, against a fake home and a PATH whose claude and codex are this test binary, standing in for
// them: each records its arguments and writes its config as the real one does.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

func TestMain(m *testing.M) {
	if tool := os.Getenv("KANTEL_TEST_STUB"); tool != "" {
		os.Exit(agentCLIStub(tool, os.Args[1:]))
	}
	os.Exit(m.Run())
}

// agentCLIStub is claude or codex: it records its arguments in $KANTEL_STUB_LOG and does what mcp add and mcp remove
// do to the config.
func agentCLIStub(tool string, args []string) int {
	if f, err := os.OpenFile(os.Getenv("KANTEL_STUB_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		fmt.Fprintln(f, tool+" "+strings.Join(args, " "))
		f.Close()
	}
	if len(args) < 3 || args[0] != "mcp" {
		return 0
	}
	scope, name := "local", ""
	env := map[string]string{}
	var command []string
	for i := 2; i < len(args); i++ {
		switch args[i] {
		case "--scope":
			scope = args[i+1]
			i++
		case "-e", "--env":
			k, v, _ := strings.Cut(args[i+1], "=")
			env[k] = v
			i++
		case "--":
			command = args[i+1:]
			i = len(args)
		default:
			name = args[i]
		}
	}
	home := os.Getenv("HOME")
	switch tool + " " + args[1] {
	case "claude add", "claude remove":
		path := filepath.Join(home, ".claude.json")
		if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
			path = filepath.Join(dir, ".claude.json")
		}
		if scope == "project" {
			wd, _ := os.Getwd()
			path = filepath.Join(wd, ".mcp.json")
		}
		doc := map[string]any{}
		if raw, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(raw, &doc)
		}
		servers, _ := doc["mcpServers"].(map[string]any)
		if servers == nil {
			servers = map[string]any{}
		}
		if args[1] == "add" {
			if _, ok := servers[name]; ok {
				fmt.Printf("MCP server %s already exists in %s config\n", name, scope)
				return 1
			}
			servers[name] = map[string]any{"type": "stdio", "command": command[0], "args": command[1:], "env": env}
		} else {
			delete(servers, name)
		}
		doc["mcpServers"] = servers
		raw, _ := json.MarshalIndent(doc, "", "  ")
		_ = os.WriteFile(path, raw, 0o644)
	case "codex add":
		dir := os.Getenv("CODEX_HOME")
		if dir == "" {
			dir = filepath.Join(home, ".codex")
		}
		_ = os.MkdirAll(dir, 0o755)
		path := filepath.Join(dir, "config.toml")
		raw, _ := os.ReadFile(path)
		var kept []string
		skipping := false
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "[") {
				skipping = line == "[mcp_servers."+name+"]" || line == "[mcp_servers."+name+".env]"
			}
			if !skipping {
				kept = append(kept, line)
			}
		}
		text := strings.TrimRight(strings.Join(kept, "\n"), "\n")
		if text != "" {
			text += "\n\n"
		}
		quoted := make([]string, len(command)-1)
		for i, a := range command[1:] {
			quoted[i] = jsonText(a)
		}
		text += fmt.Sprintf("[mcp_servers.%s]\ncommand = %s\nargs = [%s]\n", name, jsonText(command[0]), strings.Join(quoted, ", "))
		if len(env) > 0 {
			text += "\n[mcp_servers." + name + ".env]\n"
			for _, k := range sortedKeysOf(env) {
				text += k + " = " + jsonText(env[k]) + "\n"
			}
		}
		_ = os.WriteFile(path, []byte(text), 0o644)
	}
	return 0
}

// setupDirs is a fake home, a project, a PATH with kantel on it and (as asked) claude and codex, and a log of what
// they were run with.
type setupDirs struct {
	agentsDirs
	log string
}

func newSetupDirs(t *testing.T, clis ...string) setupDirs {
	d := setupDirs{agentsDirs: newAgentsDirs(t)}
	d.log = filepath.Join(filepath.Dir(d.home), "stub.log")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range clis {
		writeExecutable(t, filepath.Join(d.bin, name), fmt.Sprintf("#!/bin/sh\nKANTEL_TEST_STUB=%s exec '%s' \"$@\"\n", name, self))
	}
	d.env = cli.Env{"PATH": d.bin, "HOME": d.home, "KANTEL_API_KEY": agentSecret, "KANTEL_STUB_LOG": d.log}
	return d
}

func (d setupDirs) setup(t *testing.T, args ...string) result {
	t.Helper()
	return runLocal(t, append([]string{"agent", "setup"}, args...), local{env: d.env, home: d.home, cwd: d.project, self: selfPath})
}

func (d setupDirs) calls(t *testing.T) []string {
	raw, err := os.ReadFile(d.log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}

// files is every file under the home and the project, by path, with its text.
func (d setupDirs) files(t *testing.T) map[string]string {
	out := map[string]string{}
	for _, root := range []string{d.home, d.project} {
		_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err == nil && !info.IsDir() {
				out[path] = readFile(t, path)
			}
			return nil
		})
	}
	return out
}

func (d setupDirs) mkdir(t *testing.T, dirs ...string) {
	for _, dir := range dirs {
		if err := os.MkdirAll(filepath.Join(d.home, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAgentSetupDetectsAgentsAndDryRuns(t *testing.T) {
	d := newSetupDirs(t, "codex")
	d.mkdir(t, ".claude", ".pi")
	r := d.setup(t, "--dry-run")
	eq(t, "exit", r.Code, 0)
	p := d.project
	for _, want := range []string{
		"Would write " + p + "/CLAUDE.md (Kantel's block, for Claude Code)",
		"Would write " + p + "/.claude/skills/kantel/SKILL.md (the kantel skill, for Claude Code)",
		"Skipped: claude mcp add --scope project kantel -- kantel mcp",
		"claude isn't on your PATH",
		"Would write " + p + "/AGENTS.md (Kantel's block, for Codex and pi)",
		"Would write " + p + "/.agents/skills/kantel/SKILL.md (the kantel skill, for Codex and pi)",
		"Would run: codex mcp add kantel -- kantel mcp (Kantel's MCP server, for Codex; outside this project)",
		"Would write " + d.home + "/.codex/config.toml (the tool timeout, for Codex; outside this project)",
		"Changed nothing (--dry-run).",
		"pi has no MCP",
		"kantel key create agent --preset agent",
	} {
		contains(t, "dry run", r.Stdout, want)
	}
	notContains(t, "cursor", r.Stdout, "Cursor")
	eq(t, "files", len(d.files(t)), 0)
	eq(t, "calls", len(d.calls(t)), 0)

	var j setupResult
	r = d.setup(t, "--dry-run", "--json")
	if err := json.Unmarshal([]byte(r.Stdout), &j); err != nil {
		t.Fatalf("%v: %s", err, r.Stdout)
	}
	eq(t, "agents", strings.Join(j.Agents, " "), "claude codex pi")
	eq(t, "detected", strings.Join(j.Detected, " "), "claude codex pi")
	eq(t, "dry run", j.DryRun, true)
	eq(t, "changed", j.Changed, false)
	eq(t, "scope", j.Scope, "project")
	notContains(t, "key", r.Stdout, "KANTEL_API_KEY=")
	notContains(t, "secret", r.Stdout, agentSecret)
	eq(t, "files", len(d.files(t)), 0)
}

func TestAgentSetupSetsUpAProjectThenChangesNothing(t *testing.T) {
	d := newSetupDirs(t, "claude", "codex")
	cursor := filepath.Join(d.project, ".cursor", "mcp.json")
	if err := os.MkdirAll(filepath.Dir(cursor), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cursor, []byte(`{"mcpServers": {"other": {"command": "x", "args": ["<y>"]}}, "z": 1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	args := []string{"--for", "claude", "--for", "codex", "--for", "cursor", "--for", "pi", "--yes"}
	r := d.setup(t, args...)
	eq(t, "exit", r.Code, 0)
	eq(t, "stderr", r.Stderr, "")
	eq(t, "calls", strings.Join(d.calls(t), "\n"), "claude mcp add --scope project kantel -- kantel mcp\ncodex mcp add kantel -- kantel mcp")
	for _, want := range []string{"Wrote " + d.project + "/CLAUDE.md", "Ran: claude mcp add --scope project kantel -- kantel mcp",
		"Wrote " + d.project + "/.cursor/mcp.json", "Wrote " + d.home + "/.codex/config.toml",
		"your key isn't saved"} {
		contains(t, "out", r.Stdout, want)
	}

	files := d.files(t)
	for _, f := range []string{"CLAUDE.md", "AGENTS.md", ".claude/skills/kantel/SKILL.md", ".agents/skills/kantel/SKILL.md", ".mcp.json"} {
		if _, ok := files[filepath.Join(d.project, f)]; !ok {
			t.Errorf("no %s", f)
		}
	}
	eq(t, "skill", files[filepath.Join(d.project, ".claude/skills/kantel/SKILL.md")], skillMD)
	contains(t, "claude's", files[filepath.Join(d.project, ".mcp.json")], `"command": "kantel"`)
	toml := files[filepath.Join(d.home, ".codex", "config.toml")]
	eq(t, "codex", toml, "[mcp_servers.kantel]\ntool_timeout_sec = 660\ncommand = \"kantel\"\nargs = [\"mcp\"]\n")
	// Cursor's other servers and settings stay, in their order.
	eq(t, "cursor", files[cursor], "{\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"x\",\n      \"args\": [\n        \"<y>\"\n      ]\n    },\n"+
		"    \"kantel\": {\n      \"command\": \"kantel\",\n      \"args\": [\n        \"mcp\"\n      ]\n    }\n  },\n  \"z\": 1\n}\n")
	// No key anywhere.
	for path, text := range files {
		notContains(t, path, text, agentSecret)
		notContains(t, path, text, `"KANTEL_API_KEY"`)
		notContains(t, path, text, "KANTEL_API_KEY =")
	}
	notContains(t, "calls", strings.Join(d.calls(t), "\n"), "KANTEL_API_KEY")

	// Again, it changes nothing, and says so.
	r = d.setup(t, args...)
	eq(t, "exit", r.Code, 0)
	contains(t, "again", r.Stdout, "Nothing to change: Kantel is already set up for Claude Code, Codex, Cursor and pi.")
	notContains(t, "again", r.Stdout, "Wrote")
	eq(t, "no more calls", len(d.calls(t)), 2)
	eq(t, "same files", jsonText(d.files(t)), jsonText(files))
	// And so needs no --yes.
	r = d.setup(t, "--for", "codex")
	eq(t, "no --yes needed", r.Code, 0)
	var j setupResult
	_ = json.Unmarshal([]byte(d.setup(t, append(args, "--json")...).Stdout), &j)
	eq(t, "changed", j.Changed, false)
	for _, s := range j.Steps {
		eq(t, "state of "+s.target(), s.State, stepUnchanged)
	}
}

func TestAgentSetupNeedsYesOutsideTheProject(t *testing.T) {
	d := newSetupDirs(t, "codex")
	r := d.setup(t, "--for", "codex")
	eq(t, "exit", r.Code, 2)
	contains(t, "says how", r.Stderr, "To go ahead, run: kantel agent setup --for codex --yes")
	contains(t, "says what", r.Stderr, "codex mcp add kantel -- kantel mcp")
	eq(t, "files", len(d.files(t)), 0)
	eq(t, "calls", len(d.calls(t)), 0)

	r = d.setup(t, "--for", "codex", "--json")
	eq(t, "exit", r.Code, 2)
	var failure map[string]map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(r.Stderr)), &failure); err != nil {
		t.Fatalf("stderr isn't JSON: %q", r.Stderr)
	}
	eq(t, "code", failure["error"]["code"], any("usage"))
	contains(t, "hint", failure["error"]["hint"].(string), "kantel agent setup --for codex --json --yes")

	// --global changes the home.
	r = d.setup(t, "--for", "pi", "--global")
	eq(t, "global", r.Code, 2)
	contains(t, "global", r.Stderr, "kantel agent setup --for pi --global --yes")
	// Within the project alone, it needs none.
	r = d.setup(t, "--for", "pi")
	eq(t, "project", r.Code, 0)
}

func TestAgentSetupAsksAtATerminal(t *testing.T) {
	d := newSetupDirs(t, "codex")
	ask := func(answer string) result {
		return runLocal(t, []string{"agent", "setup", "--for", "codex"}, local{env: d.env, home: d.home, cwd: d.project, self: selfPath,
			tty: true, stdin: answer})
	}
	r := ask("n\n")
	eq(t, "no", r.Code, 1)
	contains(t, "asks", r.Stderr, "Go ahead? [y/N]")
	eq(t, "calls", len(d.calls(t)), 0)
	r = ask("y\n")
	eq(t, "yes", r.Code, 0)
	eq(t, "calls", len(d.calls(t)), 1)
}

func TestAgentSetupCarriesTheURLAndThisBinarysPath(t *testing.T) {
	d := newSetupDirs(t, "claude", "codex")
	if err := os.Remove(filepath.Join(d.bin, "kantel")); err != nil {
		t.Fatal(err)
	}
	d.env["KANTEL_URL"] = "https://kantel.example"
	r := d.setup(t, "--for", "claude", "--for", "codex", "--for", "cursor", "--yes")
	eq(t, "exit", r.Code, 0)
	eq(t, "calls", strings.Join(d.calls(t), "\n"),
		"claude mcp add --scope project kantel -e KANTEL_URL=https://kantel.example -- /home/me/.local/bin/kantel mcp\n"+
			"codex mcp add kantel --env KANTEL_URL=https://kantel.example -- /home/me/.local/bin/kantel mcp")
	contains(t, "path note", r.Stdout, "kantel isn't on your PATH")
	cursor := readFile(t, filepath.Join(d.project, ".cursor", "mcp.json"))
	contains(t, "cursor", cursor, `"command": "/home/me/.local/bin/kantel"`)
	contains(t, "cursor", cursor, `"KANTEL_URL": "https://kantel.example"`)
	toml := readFile(t, filepath.Join(d.home, ".codex", "config.toml"))
	contains(t, "codex env", toml, "[mcp_servers.kantel.env]\nKANTEL_URL = \"https://kantel.example\"")
	contains(t, "codex timeout", toml, "[mcp_servers.kantel]\ntool_timeout_sec = 660\n")
	// Again: unchanged, the env read back from each.
	r = d.setup(t, "--for", "claude", "--for", "codex", "--for", "cursor", "--yes")
	contains(t, "again", r.Stdout, "Nothing to change")
	eq(t, "no more calls", len(d.calls(t)), 2)
}

func TestAgentSetupGlobal(t *testing.T) {
	d := newSetupDirs(t, "claude")
	delete(d.env, "KANTEL_API_KEY")
	configDir := t.TempDir()
	if _, err := cli.WriteStored(configDir, cli.Stored{APIKey: agentSecret}); err != nil {
		t.Fatal(err)
	}
	r := runLocal(t, []string{"agent", "setup", "--global", "--for", "claude", "--for", "cursor", "--yes"},
		local{env: d.env, home: d.home, cwd: d.project, self: selfPath, configDir: configDir})
	eq(t, "exit", r.Code, 0)
	eq(t, "calls", strings.Join(d.calls(t), "\n"), "claude mcp add --scope user kantel -- kantel mcp")
	files := d.files(t)
	eq(t, "skill", files[filepath.Join(d.home, ".claude/skills/kantel/SKILL.md")], skillMD)
	contains(t, "saved sign-in", r.Stdout, "The agents use your kantel sign-in")
	contains(t, "claude user config", files[filepath.Join(d.home, ".claude.json")], `"kantel"`)
	contains(t, "cursor", files[filepath.Join(d.home, ".cursor", "mcp.json")], `"kantel"`)
	for path := range files {
		if strings.HasSuffix(path, ".md") && !strings.HasSuffix(path, "SKILL.md") {
			t.Errorf("--global wrote %s", path)
		}
		if strings.HasPrefix(path, d.project) {
			t.Errorf("--global wrote in the project: %s", path)
		}
	}
	r = d.setup(t, "--global", "--for", "claude", "--for", "cursor")
	eq(t, "again, without --yes", r.Code, 0)
	contains(t, "again", r.Stdout, "Nothing to change")
}

func TestAgentSetupReplacesAnotherRegistration(t *testing.T) {
	d := newSetupDirs(t, "claude")
	old := `{"mcpServers": {"kantel": {"type": "stdio", "command": "npx", "args": ["kantel", "mcp"], "env": {}}}}`
	if err := os.WriteFile(filepath.Join(d.project, ".mcp.json"), []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	r := d.setup(t, "--for", "claude", "--no-skill")
	eq(t, "exit", r.Code, 0)
	eq(t, "calls", strings.Join(d.calls(t), "\n"),
		"claude mcp remove --scope project kantel\nclaude mcp add --scope project kantel -- kantel mcp")
	contains(t, "now", readFile(t, filepath.Join(d.project, ".mcp.json")), `"command": "kantel"`)
	eq(t, "no skill", len(d.files(t)), 1)
}

func TestAgentSetupAddsCodexsTimeoutAlone(t *testing.T) {
	d := newSetupDirs(t, "codex")
	d.mkdir(t, ".codex")
	config := filepath.Join(d.home, ".codex", "config.toml")
	if err := os.WriteFile(config, []byte("model = \"o3\"\n\n[mcp_servers.kantel]\ncommand = \"kantel\"\nargs = [\"mcp\"]\n\n[mcp_servers.other]\ncommand = \"x\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := d.setup(t, "--for", "codex", "--no-skill", "--yes")
	eq(t, "exit", r.Code, 0)
	eq(t, "calls", len(d.calls(t)), 0)
	eq(t, "config", readFile(t, config),
		"model = \"o3\"\n\n[mcp_servers.kantel]\ntool_timeout_sec = 660\ncommand = \"kantel\"\nargs = [\"mcp\"]\n\n[mcp_servers.other]\ncommand = \"x\"\n")
}

func TestAgentSetupMistakes(t *testing.T) {
	d := newSetupDirs(t)
	r := d.setup(t, "--for", "claude", "--no-mcp", "--no-skill")
	eq(t, "nothing to do", r.Code, 2)
	r = d.setup(t, "--for", "vim")
	eq(t, "unknown agent", r.Code, 2)
	contains(t, "unknown agent", r.Stderr, "--for must be one of claude, codex, cursor, pi")
	r = d.setup(t)
	eq(t, "none found", r.Code, 1)
	contains(t, "none found", r.Stderr, "found no coding agent here")
	contains(t, "none found", r.Stderr, "kantel agent setup --for claude")
	// A Cursor mcp.json it can't read is left alone, and nothing else is done.
	if err := os.MkdirAll(filepath.Join(d.project, ".cursor"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(d.project, ".cursor", "mcp.json"), []byte("{oops"), 0o644); err != nil {
		t.Fatal(err)
	}
	r = d.setup(t, "--for", "cursor")
	eq(t, "bad mcp.json", r.Code, 1)
	contains(t, "bad mcp.json", r.Stderr, "leaves it alone")
	if _, err := os.Stat(filepath.Join(d.project, "AGENTS.md")); err == nil {
		t.Error("wrote AGENTS.md")
	}
}

func TestReadCodexEntry(t *testing.T) {
	inline := readCodexEntry("[mcp_servers.kantel]\ncommand = \"kantel\"\nargs = [\"mcp\"]\nenv = { KANTEL_URL = \"https://k.example\" }\ntool_timeout_sec = 660.0\n")
	eq(t, "inline", inline.same(mcpOnPath, map[string]string{"KANTEL_URL": "https://k.example"}), true)
	eq(t, "timeout", *inline.timeout, 660.0)
	table := readCodexEntry("[mcp_servers.\"kantel\"]\ncommand = 'kantel'\nargs = [\"mcp\"]\n[mcp_servers.kantel.env]\nKANTEL_URL = \"u\"\n")
	eq(t, "table", table.same(mcpOnPath, map[string]string{"KANTEL_URL": "u"}), true)
	eq(t, "other env", table.same(mcpOnPath, nil), false)
	eq(t, "absent", readCodexEntry("[mcp_servers.other]\ncommand = \"kantel\"\n").found, false)
	_, err := withCodexTimeout("[x]\n")
	if err == nil {
		t.Error("no error without the table")
	}
	got, _ := withCodexTimeout("[mcp_servers.kantel]\ncommand = \"k\"\ntool_timeout_sec = 60\n[other]\ntool_timeout_sec = 1\n")
	eq(t, "replaced", got, "[mcp_servers.kantel]\ncommand = \"k\"\ntool_timeout_sec = 660\n[other]\ntool_timeout_sec = 1\n")
}

func TestAgentSetupHelpSaysNoKey(t *testing.T) {
	d := newSetupDirs(t)
	help := d.setup(t, "--help").Stdout
	contains(t, "help", help, "Nothing it writes holds a key")
	contains(t, "help", help, "kantel key create agent --preset agent")
	if !regexp.MustCompile(`--dry-run\s+Print every file and command`).MatchString(help) {
		t.Error("no --dry-run in help")
	}
}

// A link in the project to somewhere outside it (.cursor → ~/.cursor) is outside: writing through it needs --yes.
func TestAgentSetupFollowsLinksOutOfTheProject(t *testing.T) {
	d := newSetupDirs(t)
	global := filepath.Join(d.home, ".cursor")
	d.mkdir(t, ".cursor")
	if err := os.Symlink(global, filepath.Join(d.project, ".cursor")); err != nil {
		t.Skip(err)
	}
	r := d.setup(t, "--for", "cursor", "--no-skill")
	eq(t, "exit", r.Code, 2)
	contains(t, "says how", r.Stderr, "--yes")
	if _, err := os.Stat(filepath.Join(global, "mcp.json")); err == nil {
		t.Error("wrote the global mcp.json without --yes")
	}
}

// An explicit --url wins over a self-hosted one saved: the agent's setup carries it.
func TestAgentSetupCarriesAnExplicitHostedURLOverASavedOne(t *testing.T) {
	d := newSetupDirs(t)
	config := t.TempDir()
	if _, err := cli.WriteStored(config, cli.Stored{URL: "https://self.example/v1", APIKey: "ksk_saved"}); err != nil {
		t.Fatal(err)
	}
	delete(d.env, "KANTEL_API_KEY")
	r := runLocal(t, []string{"agent", "setup", "--for", "cursor", "--no-skill", "--url", cli.DefaultURL},
		local{env: d.env, home: d.home, cwd: d.project, self: selfPath, configDir: config})
	eq(t, "exit", r.Code, 0)
	contains(t, "cursor", readFile(t, filepath.Join(d.project, ".cursor", "mcp.json")), `"KANTEL_URL": "`+cli.DefaultURL+`"`)
}

// A link whose destination doesn't exist yet is followed too: writing through it creates a file outside the project.
func TestAgentSetupFollowsDanglingLinksOutOfTheProject(t *testing.T) {
	d := newSetupDirs(t)
	d.mkdir(t, ".cursor")
	if err := os.MkdirAll(filepath.Join(d.project, ".cursor"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(d.home, ".cursor", "mcp.json"), filepath.Join(d.project, ".cursor", "mcp.json")); err != nil {
		t.Skip(err)
	}
	r := d.setup(t, "--for", "cursor", "--no-skill")
	eq(t, "exit", r.Code, 2)
	if _, err := os.Stat(filepath.Join(d.home, ".cursor", "mcp.json")); err == nil {
		t.Error("created the global mcp.json without --yes")
	}
	// A link that stays in the project is the project's.
	inside := newSetupDirs(t)
	if err := os.MkdirAll(filepath.Join(inside.project, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(inside.project, "docs", "AGENTS.md"), filepath.Join(inside.project, "AGENTS.md")); err != nil {
		t.Fatal(err)
	}
	eq(t, "inside", inside.setup(t, "--for", "pi").Code, 0)
}

// A file that changes between the plan and its write is left alone.
func TestAgentSetupLeavesAFileThatChangedWhileItWaited(t *testing.T) {
	d := newSetupDirs(t)
	c := &cli.Context{IO: &cli.IO{Cwd: d.project}}
	p := &setupPlan{c: c, byPath: map[string]*setupStep{}, cwd: d.project}
	path := filepath.Join(d.project, ".cursor", "mcp.json")
	p.file("cursor", "mcp", path, func(*string) (string, error) { return "{\"mcpServers\":{}}\n", nil })
	// Someone else creates it meanwhile.
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"other":{}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := p.steps[0].apply(); err == nil {
		t.Error("wrote over a file created meanwhile")
	}
	eq(t, "kept", readFile(t, path), `{"mcpServers":{"other":{}}}`)
	// And one edited meanwhile.
	p = &setupPlan{c: c, byPath: map[string]*setupStep{}, cwd: d.project}
	p.file("cursor", "mcp", path, func(*string) (string, error) { return "planned\n", nil })
	if err := os.WriteFile(path, []byte("edited"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := p.steps[0].apply(); err == nil {
		t.Error("wrote over an edit")
	}
	eq(t, "kept edit", readFile(t, path), "edited")
}

// A link's destination is followed in its own parts: `hop/..`, where hop leads out of the project, goes up from there.
func TestAgentSetupFollowsALinkThroughDotDot(t *testing.T) {
	d := newSetupDirs(t)
	d.mkdir(t, "subdir")
	if err := os.Symlink(filepath.Join(d.home, "subdir"), filepath.Join(d.project, "hop")); err != nil {
		t.Skip(err)
	}
	if err := os.Symlink("hop/../AGENTS.md", filepath.Join(d.project, "AGENTS.md")); err != nil {
		t.Fatal(err)
	}
	r := d.setup(t, "--for", "pi", "--no-mcp")
	eq(t, "exit", r.Code, 2)
	if _, err := os.Stat(filepath.Join(d.home, "AGENTS.md")); err == nil {
		t.Error("created ~/AGENTS.md without --yes")
	}
	eq(t, "resolved", resolved(filepath.Join(d.project, "AGENTS.md")), filepath.Join(resolved(d.home), "AGENTS.md"))
}
