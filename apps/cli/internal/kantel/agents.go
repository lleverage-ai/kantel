package kantel

// Copy-paste setup for coding agents: Claude Code, Codex and Cursor (or any MCP client) run `kantel mcp`, the installed
// `kantel` (kantel.dev/cli.sh puts it in ~/.local/bin); pi, which has no MCP, gets an AGENTS.md block telling it to use
// the CLI. Each snippet carries Kantel's URL, but never a key: always the $KANTEL_API_KEY placeholder, with a scoped
// key suggested for the agent. `kantel agent setup` (agentsetup.go) does all of it in one command.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// keyPlaceholder is what every snippet has where the key goes.
const keyPlaceholder = "$KANTEL_API_KEY"

// agentKeyCommand makes a key for an agent: it can make and drive sandboxes, but not manage the account.
const agentKeyCommand = "kantel key create agent --preset agent"

// installCommand installs kantel from Kantel's latest release, without sudo, from bash, zsh or fish.
const installCommand = "curl -fsSL https://kantel.dev/cli.sh | sh"

// harnesses are the agents `kantel agents` has a setup for.
var harnesses = []string{"claude", "codex", "pi", "cursor"}

const (
	agentsStart = "<!-- kantel:start -->"
	agentsEnd   = "<!-- kantel:end -->"
)

// toolTimeoutSeconds is the tool timeout to give `kantel mcp` in a client: its longest wait (an exec's 10 minute
// timeout, or command_get's longest waitMs) and a minute to spare.
const toolTimeoutSeconds = 660

var claudeTimeoutNote = strings.Join([]string{
	"Claude Code waits for a tool call as long as MCP_TOOL_TIMEOUT says, about 28 hours when it isn't set. If",
	fmt.Sprintf(`you've set it lower, give Kantel its own: "timeout": %d in the kantel entry of ~/.claude.json or`, toolTimeoutSeconds*1000),
	".mcp.json.",
}, "\n")

var codexTimeoutNote = strings.Join([]string{
	"Codex gives a tool call 60 s unless told otherwise, and Kantel's can wait up to 10 minutes, so add",
	fmt.Sprintf("tool_timeout_sec = %d under [mcp_servers.kantel] in ~/.codex/config.toml (codex mcp add has no flag", toolTimeoutSeconds),
	"for it). The config.toml below has it.",
}, "\n")

// mcpLaunch is how an MCP client starts Kantel's MCP server: a program and its arguments.
type mcpLaunch struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

// byName says whether it is `kantel mcp`, found on the PATH.
func (l mcpLaunch) byName() bool {
	return l.Command == "kantel" && len(l.Args) == 1 && l.Args[0] == "mcp"
}

func (l mcpLaunch) words() []string { return append([]string{l.Command}, l.Args...) }

// mcpOnPath is `kantel mcp`, found on the PATH.
var mcpOnPath = mcpLaunch{Command: "kantel", Args: []string{"mcp"}}

// launchFor is `kantel mcp` by name when kantel is on the PATH; otherwise this binary by its absolute path, so a setup
// still works before ~/.local/bin is on the PATH, or in an MCP client started without it. Not knowing where this
// binary is, it stays with the name.
func launchFor(onPath bool, self string) mcpLaunch {
	if onPath || self == "" {
		return mcpOnPath
	}
	return mcpLaunch{Command: self, Args: []string{"mcp"}}
}

// onPath says whether an executable name is in one of the PATH's directories, and where.
func onPath(name string, env cli.Env) (string, bool) {
	for _, dir := range filepath.SplitList(env.Get("PATH")) {
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		path := filepath.Join(dir, name)
		if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return path, true
		}
	}
	return "", false
}

// launchOf is how the setups this run prints or makes start `kantel mcp`.
func launchOf(c *cli.Context) mcpLaunch {
	_, found := onPath("kantel", c.IO.Env)
	return launchFor(found, c.IO.Self)
}

func shellLine(words []string) string {
	quoted := make([]string, len(words))
	for i, w := range words {
		quoted[i] = ShellQuote(w)
	}
	return strings.Join(quoted, " ")
}

// jsonText is v as JSON, with <, > and & as they are.
func jsonText(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimSuffix(b.String(), "\n")
}

// jsonIndented is v as JSON indented two spaces, with <, > and & as they are.
func jsonIndented(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
	return strings.TrimSuffix(b.String(), "\n")
}

// claudeSetup is Claude Code's one line.
func claudeSetup(url string, launch mcpLaunch) string {
	return fmt.Sprintf("claude mcp add kantel -e KANTEL_URL=%s -e KANTEL_API_KEY=%s -- %s", url, keyPlaceholder, shellLine(launch.words()))
}

// codexSetup is Codex's one line.
func codexSetup(url string, launch mcpLaunch) string {
	return fmt.Sprintf("codex mcp add kantel --env KANTEL_URL=%s --env KANTEL_API_KEY=%s -- %s", url, keyPlaceholder, shellLine(launch.words()))
}

// codexToml is the same for Codex's ~/.codex/config.toml.
func codexToml(url string, launch mcpLaunch) string {
	args := make([]string, len(launch.Args))
	for i, a := range launch.Args {
		args[i] = jsonText(a)
	}
	return strings.Join([]string{
		"[mcp_servers.kantel]",
		"command = " + jsonText(launch.Command),
		"args = [" + strings.Join(args, ", ") + "]",
		fmt.Sprintf(`env = { KANTEL_URL = %s, KANTEL_API_KEY = "%s" }`, jsonText(url), keyPlaceholder),
		fmt.Sprintf("tool_timeout_sec = %d", toolTimeoutSeconds),
	}, "\n")
}

type snippetEnv struct {
	URL string `json:"KANTEL_URL"`
	Key string `json:"KANTEL_API_KEY"`
}

type snippetServer struct {
	Command string     `json:"command"`
	Args    []string   `json:"args"`
	Env     snippetEnv `json:"env"`
}

type snippetServers struct {
	MCPServers struct {
		Kantel snippetServer `json:"kantel"`
	} `json:"mcpServers"`
}

// mcpServers is Cursor's .cursor/mcp.json, and the mcpServers JSON most other MCP clients read.
func mcpServers(url string, launch mcpLaunch) snippetServers {
	var s snippetServers
	s.MCPServers.Kantel = snippetServer{Command: launch.Command, Args: append([]string{}, launch.Args...),
		Env: snippetEnv{URL: url, Key: keyPlaceholder}}
	return s
}

// cheatSheet is the commands an agent needs, for the AGENTS.md block and the skill alike.
const cheatSheet = "- Create one: `id=$(kantel new --type microvm --json | jq -r .id)`. A microVM is a full Linux with root and\n" +
	"  Docker: use one for anything touching code (clone, install, build, test, run), any runtime, a server or a long job.\n" +
	"- `--type isolate` (the default without `--type`) starts in milliseconds and costs almost nothing, but is only a\n" +
	"  shell over files in /workspace: curl, jq, grep, rg, sed, awk, sort, diff, gzip. It has no git, node, python, package\n" +
	"  manager, Docker or SSH. Use one only for HTTP calls and text or JSON work, such as reading issues or logs with a token.\n" +
	"  If it says `command not found` or `not available in an isolate`, make a microVM instead; if unsure, use a microVM.\n" +
	"- Run a command: `kantel exec \"$id\" -- npm test`. Its output and exit code are the command's (30 s limit;\n" +
	"  `--timeout 0` = no limit, following its output).\n" +
	"- A job you don't wait for: `kantel exec \"$id\" --detach -- npm run build` prints the command's ID; then\n" +
	"  `kantel attach \"$id\" <command>` follows its output, and `kantel kill \"$id\" <command>` stops it and what it\n" +
	"  started. It has no time limit; a host whose kantel-host predates exec-control still ends it after about 2 minutes\n" +
	"  on a microVM and can't kill it (`pkill -f` does).\n" +
	"- Copy files: `kantel push \"$id\" .` (git-tracked files, to /home/user/<dir>); into a sandbox that already has\n" +
	"  a clone of the repository (one from a snapshot), `kantel sync \"$id\" --git` sends only a patch; or\n" +
	"  `kantel scp ./file \"$id\":/home/user/` and `kantel scp \"$id\":/home/user/out.zip .` (`-r` for a directory).\n" +
	"- A URL for a port: `kantel host \"$id\" 3000` (private, with a token; `--public` for none).\n" +
	"- When done: `kantel stop \"$id\"`. It keeps the disk, costs nothing stopped, and `kantel resume \"$id\"`\n" +
	"  brings it back. Don't delete sandboxes: tell the user the IDs you made.\n" +
	"- Always pass the sandbox ID. `kantel help` lists every command; `--json` prints Kantel's answer as JSON."

// agentsBlock is the AGENTS.md (and CLAUDE.md) block: when to use a sandbox, and the installed kantel CLI.
const agentsBlock = agentsStart + "\n" +
	"## Sandboxes (Kantel)\n\n" +
	"Run builds, tests, code you don't trust, Docker and long jobs in a Kantel sandbox, never on this computer.\n" +
	"`KANTEL_URL` and `KANTEL_API_KEY` are set in the environment (or `kantel login` has been run). If `kantel`\n" +
	"isn't installed, ask the user to run `" + installCommand + "`.\n\n" +
	cheatSheet + "\n" +
	agentsEnd

// skillMD is the skill Claude Code (.claude/skills), Codex and pi (.agents/skills) load when a task needs a sandbox.
const skillMD = "---\n" +
	"name: kantel\n" +
	"description: Run code in a Kantel sandbox (a microVM with root, Docker, SSH, a desktop and Chromium, or an isolate, a quick shell for HTTP calls and text work) instead of on this computer. Use for builds, tests, untrusted code, Docker, servers that need a public URL, browser automation, long jobs, and API calls with a token kept out of reach.\n" +
	"---\n\n" +
	"# Kantel sandboxes\n\n" +
	"Kantel gives you sandboxes through the `kantel` command line. `KANTEL_URL` and `KANTEL_API_KEY` are set in the\n" +
	"environment, or `kantel login` has been run; `kantel whoami` checks which. If `kantel` isn't installed, ask the user\n" +
	"to run `" + installCommand + "`.\n\n" +
	cheatSheet + "\n\n" +
	"## More\n\n" +
	"- Start from a saved snapshot: `kantel new --from <name>`; save one with `kantel snapshot save \"$id\" <name>`.\n" +
	"- Copies of a sandbox: `kantel fork \"$id\" --count 3`.\n" +
	"- A microVM's desktop or Chromium: `kantel desktop \"$id\"`, `kantel browser \"$id\"` (prints a live view URL and a CDP\n" +
	"  URL for Playwright's `connectOverCDP`).\n" +
	"- SSH (microVMs): `kantel ssh \"$id\"` connects; `-- <command>` runs one there and `--print` prints the ssh command\n" +
	"  instead. Prefer `exec` for commands.\n" +
	"- Keep it running longer: `kantel extend \"$id\" 120` (minutes from now).\n" +
	"- Every command and flag: `kantel help`, `kantel help <command>`.\n"

// Where the skill goes, relative to a project (or the home, with --global).
var (
	claudeSkillPath = filepath.Join(".claude", "skills", "kantel", "SKILL.md")
	agentsSkillPath = filepath.Join(".agents", "skills", "kantel", "SKILL.md")
)

// upsertAgentsBlock is existing (an AGENTS.md, or nothing) with block in place of its Kantel block, or added at the end.
func upsertAgentsBlock(existing *string, block string) string {
	text := ""
	if existing != nil {
		text = *existing
	}
	if start := strings.Index(text, agentsStart); start != -1 {
		if end := strings.Index(text[start:], agentsEnd); end != -1 {
			end += start
			return text[:start] + block + text[end+len(agentsEnd):]
		}
	}
	if strings.TrimSpace(text) == "" {
		return block + "\n"
	}
	sep := "\n"
	if strings.HasSuffix(text, "\n") {
		sep = ""
	}
	return text + sep + "\n" + block + "\n"
}

// readTextIfAny is a file's text, or nil when there is no file.
func readTextIfAny(path string) (*string, error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	text := string(raw)
	return &text, nil
}

func indentText(text string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		if l != "" {
			lines[i] = "  " + l
		}
	}
	return strings.Join(lines, "\n")
}

// agentsGuide is the setup for one harness, or all of them, for Kantel at url (its origin), with the MCP clients
// starting the server as launch says.
func agentsGuide(url, harness string, launch mcpLaunch) string {
	intro := []string{
		"Kantel for coding agents, at " + url + ".",
		"",
		"Give the agent its own scoped key (it can make and drive sandboxes, but not delete them or manage the",
		"account), and put the secret it prints in KANTEL_API_KEY:",
		"",
		"  " + agentKeyCommand,
		"  export KANTEL_API_KEY=<the secret>",
		"",
		"The commands below read the key from there; nothing here prints it.",
	}
	if !launch.byName() {
		intro = append(intro,
			"",
			"kantel isn't on your PATH, so the MCP setups below start this kantel by its full path. To have them run",
			"`kantel mcp` instead, put the directory kantel is in (install-cli.sh links it in ~/.local/bin) on your",
			"PATH and run this again.")
	}
	sections := []string{strings.Join(intro, "\n")}
	wants := func(name string) bool { return harness == "all" || harness == name }
	if wants("claude") {
		sections = append(sections, "Claude Code:\n\n  "+claudeSetup(url, launch)+"\n\n"+claudeTimeoutNote)
	}
	if wants("codex") {
		sections = append(sections, strings.Join([]string{
			"Codex:", "", "  " + codexSetup(url, launch), "", codexTimeoutNote, "",
			"Or all of it in ~/.codex/config.toml, with the key in place of " + keyPlaceholder + ":", "",
			indentText(codexToml(url, launch)),
		}, "\n"))
	}
	if wants("pi") {
		sections = append(sections, strings.Join([]string{
			"pi (no MCP: it uses the CLI). Put this in AGENTS.md, or run `kantel agents --write`, and start pi with",
			"KANTEL_URL and KANTEL_API_KEY set:", "", agentsBlock,
		}, "\n"))
	}
	if wants("cursor") {
		sections = append(sections, strings.Join([]string{
			"Cursor (.cursor/mcp.json) and other MCP clients (their mcpServers JSON), with the key in place of",
			keyPlaceholder + ":", "",
			indentText(jsonIndented(mcpServers(url, launch))), "",
			fmt.Sprintf("If the client has a tool timeout, make it at least %d s: a Kantel tool call can wait up to 10", toolTimeoutSeconds),
			"minutes.",
		}, "\n"))
	}
	return strings.Join(sections, "\n\n")
}

// choices is a repeatable flag's values, each one of allowed; nil when there are none.
func choices(values []string, what string, allowed ...string) ([]string, error) {
	var picked []string
	for _, v := range values {
		if _, err := Choice(v, what, allowed...); err != nil {
			return nil, err
		}
		picked = append(picked, v)
	}
	return picked, nil
}

func has(list []string, item string) bool {
	for _, x := range list {
		if x == item {
			return true
		}
	}
	return false
}

// writeText writes a file, making its directories.
func writeText(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// codingAgents is the "Coding agents" section.
func codingAgents() cli.Section {
	return cli.Section{Title: "Coding agents", Commands: []*cli.Command{
		initCommand(),
		mcpCommand(),
		agentsCommand(),
		agentSetupCommand(),
	}}
}

func initCommand() *cli.Command {
	return &cli.Command{
		Name:    "init",
		Summary: "Teach this project's coding agents to use Kantel: AGENTS.md, CLAUDE.md and a kantel skill",
		Flags: []cli.Flag{
			{Name: "global", Type: cli.Bool, Description: "Install the skill for every project (~/.claude/skills, ~/.agents/skills) and skip the .md files"},
			{Name: "for", Type: cli.String, Multiple: true, Value: "<claude|codex|pi>", Choices: []string{"claude", "codex", "pi"},
				Description: "Only for these agents; repeat it (default all three)"},
		},
		Details: "It writes Kantel's block into AGENTS.md (Codex, pi, Cursor) and CLAUDE.md (Claude Code), replacing an\n" +
			"older one between its markers and leaving the rest, and the kantel skill into .agents/skills (Codex,\n" +
			"pi) and .claude/skills (Claude Code). Nothing it writes holds a key. For MCP instead: kantel agents.\n" +
			"kantel agent setup does this and registers the MCP server too, for the agents it finds.",
		Examples: []cli.Example{
			{What: "Teach this project's coding agents to use Kantel", Line: "kantel init"},
			{What: "For Claude Code alone, in every project", Line: "kantel init --global --for claude"},
		},
		Run: func(c *cli.Context) error {
			wanted, err := choices(c.List("for"), "--for", "claude", "codex", "pi")
			if err != nil {
				return err
			}
			if wanted == nil {
				wanted = []string{"claude", "codex", "pi"}
			}
			global := c.Bool("global")
			base := c.IO.Cwd
			if global {
				base = c.IO.Home
			}
			claude := has(wanted, "claude")
			others := has(wanted, "codex") || has(wanted, "pi")
			written := []string{}
			put := func(path, content string) error {
				if err := writeText(path, content); err != nil {
					return err
				}
				written = append(written, path)
				return nil
			}
			if !global {
				for _, f := range []struct {
					name  string
					wants bool
				}{{"AGENTS.md", others}, {"CLAUDE.md", claude}} {
					if !f.wants {
						continue
					}
					path := filepath.Join(base, f.name)
					existing, err := readTextIfAny(path)
					if err != nil {
						return err
					}
					if err := put(path, upsertAgentsBlock(existing, agentsBlock)); err != nil {
						return err
					}
				}
			}
			if claude {
				if err := put(filepath.Join(base, claudeSkillPath), skillMD); err != nil {
					return err
				}
			}
			if others {
				if err := put(filepath.Join(base, agentsSkillPath), skillMD); err != nil {
					return err
				}
			}
			s, err := Settings(c)
			if err != nil {
				return err
			}
			_, found := onPath("kantel", c.IO.Env)
			c.Emit(nil, map[string]any{"written": written, "kantelOnPath": found}, func() string {
				var lines []string
				for _, p := range written {
					lines = append(lines, "Wrote "+p)
				}
				lines = append(lines, "")
				if s.APIKey != "" {
					lines = append(lines, "Your agents use the same sign-in as you (or set KANTEL_API_KEY to a key of their own).")
				} else {
					lines = append(lines, "Sign in with kantel login, or give the agents a key: "+agentKeyCommand+".")
				}
				if !found {
					lines = append(lines, "",
						"kantel isn't on your PATH, and your agents run it by name: put the directory it's in on your PATH",
						"(install-cli.sh links it in ~/.local/bin).")
				}
				return strings.Join(lines, "\n")
			})
			return nil
		},
	}
}

func mcpCommand() *cli.Command {
	return &cli.Command{
		Name:    "mcp",
		Summary: "Serve Kantel's MCP server on stdio, for a coding agent",
		Details: "Its tools create sandboxes and run commands, files, ports and snapshots in them.\n" +
			"kantel agent setup registers it with Claude Code, Codex and Cursor.",
		Run: func(c *cli.Context) error {
			s, err := Settings(c)
			if err != nil {
				return err
			}
			if s.APIKey == "" {
				c.Note("kantel mcp: no API key is set (KANTEL_API_KEY), so Kantel will refuse the tools' calls")
			}
			account, err := Account(c)
			if err != nil {
				return err
			}
			client, err := Client(c)
			if err != nil {
				return err
			}
			server := newMCPServer(client, Version, account, func(line string) { c.Note(line) })
			return serveMCP(c.Ctx, server, c.IO.Stdin, c.IO.Stdout, c.IO.Stderr)
		},
	}
}

type agentsSnippets struct {
	URL        string         `json:"url"`
	MCP        mcpLaunch      `json:"mcp"`
	Claude     string         `json:"claude"`
	Codex      string         `json:"codex"`
	CodexToml  string         `json:"codexToml"`
	MCPServers snippetServers `json:"mcpServers"`
	AgentsMd   string         `json:"agentsMd"`
}

func agentsCommand() *cli.Command {
	return &cli.Command{
		Name:    "agents",
		Summary: "Setup for Claude Code, Codex, pi and Cursor (never with your key in it)",
		Args:    []cli.Arg{{Name: "claude|codex|pi|cursor|all", Optional: true}},
		Flags:   []cli.Flag{{Name: "write", Type: cli.Bool, Description: "Write the pi block into ./AGENTS.md, replacing an old one"}},
		Details: "It prints each agent's MCP setup to copy, with the $KANTEL_API_KEY placeholder where the key goes.\n" +
			"To have it done for you instead, for the agents on this computer: kantel agent setup.",
		Run: func(c *cli.Context) error {
			if c.Bool("write") {
				path := filepath.Join(c.IO.Cwd, "AGENTS.md")
				existing, err := readTextIfAny(path)
				if err != nil {
					return err
				}
				if err := os.WriteFile(path, []byte(upsertAgentsBlock(existing, agentsBlock)), 0o644); err != nil {
					return err
				}
				c.Emit(nil, map[string]string{"path": path}, func() string { return "Wrote Kantel's block into " + path + "." })
				return nil
			}
			harness := "all"
			if v, ok := c.Optional(0); ok {
				var err error
				if harness, err = Choice(v, "the agent", append(append([]string{}, harnesses...), "all")...); err != nil {
					return err
				}
			}
			s, err := Settings(c)
			if err != nil {
				return err
			}
			url := cli.Origin(s.URL)
			launch := launchOf(c)
			snippets := agentsSnippets{
				URL: url, MCP: launch, Claude: claudeSetup(url, launch), Codex: codexSetup(url, launch),
				CodexToml: codexToml(url, launch), MCPServers: mcpServers(url, launch), AgentsMd: agentsBlock,
			}
			if c.JSON {
				c.Out(jsonIndented(snippets))
				return nil
			}
			c.Out(agentsGuide(url, harness, launch))
			return nil
		},
	}
}
