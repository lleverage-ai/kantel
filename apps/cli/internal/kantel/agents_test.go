package kantel

// kantel agents and kantel init (the agents part of packages/cli/test/cli.test.ts).

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

const agentSecret = "ksk_supersecret_5n2p8r"

// local are a run's own home, working directory, binary and terminal, for commands that make no calls.
type local struct {
	env             cli.Env
	home, cwd, self string
	configDir       string
	stdin           string
	tty             bool
}

// runLocal runs kantel with a home, working directory and binary of its own.
func runLocal(t *testing.T, argv []string, l local) result {
	t.Helper()
	if l.configDir == "" {
		l.configDir = t.TempDir()
	}
	var stdout, stderr bytes.Buffer
	code := cli.Run(Program(), argv, &cli.IO{
		Stdout: &stdout, Stderr: &stderr, Stdin: strings.NewReader(l.stdin),
		StdoutTTY: l.tty, StderrTTY: l.tty, StdinTTY: l.tty, Env: l.env, Home: l.home, ConfigDir: l.configDir, Cwd: l.cwd,
		Now: time.Now, Sleep: func(context.Context, time.Duration) error { return nil }, OpenURL: func(string) {}, Self: l.self,
	})
	return result{Code: code, Stdout: stdout.String(), Stderr: stderr.String()}
}

// agentsDirs is a home, a project, and two PATHs: one with an installed kantel on it, one with nothing.
type agentsDirs struct {
	home, project, bin, empty string
	env, bare                 cli.Env
}

func newAgentsDirs(t *testing.T) agentsDirs {
	root := t.TempDir()
	d := agentsDirs{home: filepath.Join(root, "home"), project: filepath.Join(root, "project"), bin: filepath.Join(root, "bin"),
		empty: filepath.Join(root, "empty")}
	for _, dir := range []string{d.home, d.project, d.bin, d.empty} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeExecutable(t, filepath.Join(d.bin, "kantel"), "#!/bin/sh\n")
	d.bare = cli.Env{"KANTEL_URL": "https://kantel.example/v1", "KANTEL_API_KEY": agentSecret, "PATH": d.empty, "HOME": d.home}
	d.env = cli.Env{"KANTEL_URL": "https://kantel.example/v1", "KANTEL_API_KEY": agentSecret, "PATH": d.empty + ":" + d.bin, "HOME": d.home}
	return d
}

func writeExecutable(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o755); err != nil {
		t.Fatal(err)
	}
}

func (d agentsDirs) run(t *testing.T, argv []string, env cli.Env, self string) result {
	return runLocal(t, argv, local{env: env, home: d.home, cwd: d.project, self: self})
}

const selfPath = "/home/me/.local/bin/kantel"

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func notContains(t *testing.T, what, got, unwanted string) {
	t.Helper()
	if strings.Contains(got, unwanted) {
		t.Errorf("%s: %q contains %q", what, got, unwanted)
	}
}

func TestAgentsNeverPrintsTheKey(t *testing.T) {
	d := newAgentsDirs(t)
	for _, argv := range [][]string{{"agents"}, {"agents", "claude"}, {"agents", "all", "--json"}, {"agents", "--key", agentSecret}} {
		r := d.run(t, argv, d.env, selfPath)
		eq(t, "exit", r.Code, 0)
		notContains(t, "secret", r.Stdout, agentSecret)
		contains(t, "placeholder", r.Stdout, "$KANTEL_API_KEY")
		contains(t, "url", r.Stdout, "https://kantel.example")
	}
	claude := d.run(t, []string{"agents", "claude"}, d.env, selfPath)
	contains(t, "claude", claude.Stdout, claudeSetup("https://kantel.example", mcpOnPath))
	contains(t, "scoped key", claude.Stdout, "kantel key create agent --preset agent")
	notContains(t, "codex", claude.Stdout, "codex mcp add")
}

func TestAgentsOneLines(t *testing.T) {
	url := "https://kantel.example"
	eq(t, "claude", claudeSetup(url, mcpOnPath),
		"claude mcp add kantel -e KANTEL_URL=https://kantel.example -e KANTEL_API_KEY=$KANTEL_API_KEY -- kantel mcp")
	eq(t, "codex", codexSetup(url, mcpOnPath),
		"codex mcp add kantel --env KANTEL_URL=https://kantel.example --env KANTEL_API_KEY=$KANTEL_API_KEY -- kantel mcp")
	contains(t, "toml", codexToml(url, mcpOnPath), "command = \"kantel\"\nargs = [\"mcp\"]\n")
	contains(t, "toml", codexToml(url, mcpOnPath), "\ntool_timeout_sec = 660")
	eq(t, "mcpServers", jsonText(mcpServers(url, mcpOnPath)),
		`{"mcpServers":{"kantel":{"command":"kantel","args":["mcp"],"env":{"KANTEL_URL":"https://kantel.example","KANTEL_API_KEY":"$KANTEL_API_KEY"}}}}`)
}

func TestAgentsRunsKantelMCPWhenOnThePath(t *testing.T) {
	d := newAgentsDirs(t)
	text := d.run(t, []string{"agents"}, d.env, selfPath).Stdout
	notContains(t, "npx", text, "npx")
	contains(t, "by name", text, "-- kantel mcp")
	notContains(t, "path note", text, "isn't on your PATH")
	contains(t, "claude timeout", text, `"timeout": 660000`)
	contains(t, "codex timeout", text, "tool_timeout_sec = 660 under [mcp_servers.kantel]")
	contains(t, "other timeout", text, "at least 660 s")
	var j struct {
		MCP        mcpLaunch       `json:"mcp"`
		MCPServers json.RawMessage `json:"mcpServers"`
		CodexToml  string          `json:"codexToml"`
		AgentsMd   string          `json:"agentsMd"`
	}
	out := d.run(t, []string{"agents", "--json"}, d.env, selfPath).Stdout
	if err := json.Unmarshal([]byte(out), &j); err != nil {
		t.Fatal(err)
	}
	eq(t, "mcp", jsonText(j.MCP), `{"command":"kantel","args":["mcp"]}`)
	contains(t, "mcpServers", string(j.MCPServers), `"command": "kantel"`)
	notContains(t, "npx", out, "npx")
	eq(t, "agentsMd", j.AgentsMd, agentsBlock)
}

func TestAgentsRunsThisKantelByItsPathOtherwise(t *testing.T) {
	d := newAgentsDirs(t)
	text := d.run(t, []string{"agents"}, d.bare, selfPath)
	eq(t, "exit", text.Code, 0)
	contains(t, "full path", text.Stdout, "-- /home/me/.local/bin/kantel mcp")
	contains(t, "says so", text.Stdout, "kantel isn't on your PATH")
	var j struct {
		MCP        mcpLaunch      `json:"mcp"`
		MCPServers snippetServers `json:"mcpServers"`
		CodexToml  string         `json:"codexToml"`
	}
	if err := json.Unmarshal([]byte(d.run(t, []string{"agents", "--json"}, d.bare, selfPath).Stdout), &j); err != nil {
		t.Fatal(err)
	}
	eq(t, "mcp", jsonText(j.MCP), `{"command":"/home/me/.local/bin/kantel","args":["mcp"]}`)
	eq(t, "mcpServers", j.MCPServers.MCPServers.Kantel.Command, selfPath)
	contains(t, "toml", j.CodexToml, "command = \"/home/me/.local/bin/kantel\"\nargs = [\"mcp\"]")
	// A path with a space is quoted for the shell in the one-liners.
	spaced := d.run(t, []string{"agents", "claude"}, d.bare, "/Users/me/Kantel CLI/kantel")
	contains(t, "quoted", spaced.Stdout, "-- '/Users/me/Kantel CLI/kantel' mcp")
	// Not knowing where this binary is, it stays with the name.
	unknown := d.run(t, []string{"agents", "claude"}, d.bare, "")
	contains(t, "by name", unknown.Stdout, "-- kantel mcp")
	// No Node anywhere: the binary is native.
	notContains(t, "node", text.Stdout, "node ")
}

func TestAgentsWritesTheBlockReplacingAnOldOne(t *testing.T) {
	d := newAgentsDirs(t)
	path := filepath.Join(d.project, "AGENTS.md")
	if err := os.WriteFile(path, []byte("# Agents\n\nBe kind.\n\n"+agentsStart+"\nold\n"+agentsEnd+"\n\nAfter.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := d.run(t, []string{"agents", "--write"}, d.env, selfPath)
	eq(t, "exit", r.Code, 0)
	written := readFile(t, path)
	eq(t, "start", strings.HasPrefix(written, "# Agents\n\nBe kind.\n\n<!-- kantel:start -->"), true)
	eq(t, "end", strings.HasSuffix(written, agentsEnd+"\n\nAfter.\n"), true)
	notContains(t, "old", written, "\nold\n")
	eq(t, "one block", strings.Count(written, agentsStart), 1)
	contains(t, "exec", written, "`kantel exec \"$id\" -- npm test`")
	notContains(t, "npx", written, "npx")
	notContains(t, "secret", written, agentSecret)
}

func TestUpsertAgentsBlock(t *testing.T) {
	text := func(s string) *string { return &s }
	eq(t, "nothing", upsertAgentsBlock(nil, "B"), "B\n")
	eq(t, "a file", upsertAgentsBlock(text("# Agents"), "B"), "# Agents\n\nB\n")
	eq(t, "replaced", upsertAgentsBlock(text("x\n"+agentsStart+"\na\n"+agentsEnd+"\ny\n"), agentsStart+"\nb\n"+agentsEnd),
		"x\n"+agentsStart+"\nb\n"+agentsEnd+"\ny\n")
}

func TestTheCheatSheetPromisesNothingAboutTheKey(t *testing.T) {
	contains(t, "block", agentsBlock, "Don't delete sandboxes: tell the user the IDs you made.")
	contains(t, "install", agentsBlock, "curl -fsSL https://kantel.dev/cli.sh | sh")
	for _, text := range []string{agentsBlock, skillMD} {
		notContains(t, "promise", text, "can't delete")
		notContains(t, "promise", text, "cannot delete")
	}
}

func TestInitWritesTheBlocksAndSkills(t *testing.T) {
	d := newAgentsDirs(t)
	if err := os.WriteFile(filepath.Join(d.project, "CLAUDE.md"), []byte("# Claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := d.run(t, []string{"init"}, d.env, selfPath)
	eq(t, "exit", r.Code, 0)
	notContains(t, "path note", r.Stdout, "isn't on your PATH")
	claude := readFile(t, filepath.Join(d.project, "CLAUDE.md"))
	eq(t, "claude", strings.HasPrefix(claude, "# Claude\n\n<!-- kantel:start -->"), true)
	agents := readFile(t, filepath.Join(d.project, "AGENTS.md"))
	contains(t, "agents", agents, "`id=$(kantel new --type microvm --json | jq -r .id)`")
	contains(t, "install", agents, "curl -fsSL https://kantel.dev/cli.sh | sh")
	notContains(t, "npx", agents+claude, "npx")
	for _, skill := range []string{".claude/skills/kantel/SKILL.md", ".agents/skills/kantel/SKILL.md"} {
		text := readFile(t, filepath.Join(d.project, skill))
		eq(t, "front matter", strings.HasPrefix(text, "---\nname: kantel\ndescription: "), true)
		notContains(t, "secret", text, agentSecret)
		notContains(t, "npx", text, "npx")
	}
	notContains(t, "secret", agents+claude, agentSecret)
	// Again: the block is replaced, not added twice.
	d.run(t, []string{"init"}, d.env, selfPath)
	eq(t, "one block", strings.Count(readFile(t, filepath.Join(d.project, "AGENTS.md")), agentsStart), 1)
	// --json says what it wrote.
	var j struct {
		Written      []string `json:"written"`
		KantelOnPath bool     `json:"kantelOnPath"`
	}
	if err := json.Unmarshal([]byte(d.run(t, []string{"init", "--json"}, d.env, selfPath).Stdout), &j); err != nil {
		t.Fatal(err)
	}
	eq(t, "written", len(j.Written), 4)
	eq(t, "on path", j.KantelOnPath, true)
}

func TestInitSaysWhenKantelIsntOnThePath(t *testing.T) {
	d := newAgentsDirs(t)
	r := d.run(t, []string{"init"}, d.bare, selfPath)
	eq(t, "exit", r.Code, 0)
	contains(t, "note", r.Stdout, "kantel isn't on your PATH")
}

func TestInitGlobalInstallsOnlyTheSkill(t *testing.T) {
	d := newAgentsDirs(t)
	r := d.run(t, []string{"init", "--global", "--for", "claude"}, d.env, selfPath)
	eq(t, "exit", r.Code, 0)
	if _, err := os.Stat(filepath.Join(d.home, ".claude/skills/kantel/SKILL.md")); err != nil {
		t.Error(err)
	}
	for _, absent := range []string{".agents/skills/kantel/SKILL.md", "CLAUDE.md"} {
		if _, err := os.Stat(filepath.Join(d.home, absent)); err == nil {
			t.Errorf("wrote %s", absent)
		}
	}
	eq(t, "bad --for", d.run(t, []string{"init", "--for", "cursor"}, d.env, selfPath).Code, 2)
}

func TestInitAndAgentsHelpPointAtAgentSetup(t *testing.T) {
	d := newAgentsDirs(t)
	for _, name := range []string{"init", "agents", "mcp"} {
		contains(t, name, d.run(t, []string{name, "--help"}, d.env, selfPath).Stdout, "kantel agent setup")
	}
}

// The guidance agents read, the skill's description included, never says an isolate runs JavaScript, and says what a
// microVM is for.
func TestTheGuidanceDescribesWhatAnIsolateIs(t *testing.T) {
	for name, text := range map[string]string{"block": agentsBlock, "skill": skillMD, "mcp": mcpInstructions} {
		notContains(t, name, text, "runs JavaScript")
		notContains(t, name, text, "JavaScript shell")
		contains(t, name, text, "python")
	}
	description := strings.SplitN(strings.SplitN(skillMD, "description: ", 2)[1], "\n", 2)[0]
	contains(t, "skill description", description, "an isolate, a quick shell with node and python for HTTP calls, data work and short scripts")
	contains(t, "skill description", description, "a microVM with root, Docker")
}
