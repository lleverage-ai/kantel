package kantel

// `kantel agent setup`: one command that sets up the coding agents on this computer to use Kantel. For each agent it
// installs the kantel skill and Kantel's block in AGENTS.md or CLAUDE.md, as kantel init does, and registers Kantel's
// MCP server: through the agent's own CLI where it has one (claude mcp add, codex mcp add), or in its mcp.json
// (Cursor). It plans first, so --dry-run shows every file and command and changes nothing, and a second run finds
// nothing to change. Nothing it writes holds a key: the MCP server uses kantel's own sign-in.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// codingAgent is an agent agent setup knows: how to find it, and what it reads.
type codingAgent struct {
	Name, Label string
	// CLIs are its command's names; Dir is its directory in the home.
	CLIs []string
	Dir  string
}

var codingAgentList = []codingAgent{
	{Name: "claude", Label: "Claude Code", CLIs: []string{"claude"}, Dir: ".claude"},
	{Name: "codex", Label: "Codex", CLIs: []string{"codex"}, Dir: ".codex"},
	{Name: "cursor", Label: "Cursor", CLIs: []string{"cursor", "cursor-agent"}, Dir: ".cursor"},
	{Name: "pi", Label: "pi", CLIs: []string{"pi"}, Dir: ".pi"},
}

func agentNames() []string {
	names := make([]string, len(codingAgentList))
	for i, a := range codingAgentList {
		names[i] = a.Name
	}
	return names
}

func agentLabel(name string) string {
	for _, a := range codingAgentList {
		if a.Name == name {
			return a.Label
		}
	}
	return name
}

// detectAgents is the agents on this computer: their command on the PATH, or their directory in the home.
func detectAgents(env cli.Env, home string) []string {
	var found []string
	for _, a := range codingAgentList {
		present := false
		for _, name := range a.CLIs {
			if _, ok := onPath(name, env); ok {
				present = true
			}
		}
		if info, err := os.Stat(filepath.Join(home, a.Dir)); err == nil && info.IsDir() {
			present = true
		}
		if present {
			found = append(found, a.Name)
		}
	}
	return found
}

// Step states: planned, then done.
const (
	stepCreate    = "create"
	stepUpdate    = "update"
	stepRun       = "run"
	stepUnchanged = "unchanged"
	stepSkipped   = "skipped"
	stepCreated   = "created"
	stepUpdated   = "updated"
	stepRan       = "ran"
	stepFailed    = "failed"
)

// setupStep is one file to write or command to run.
type setupStep struct {
	Agents []string `json:"agents"`
	// What is what it sets up: instructions (the AGENTS.md or CLAUDE.md block), skill, mcp, or tool-timeout.
	What    string   `json:"what"`
	Path    string   `json:"path,omitempty"`
	Command []string `json:"command,omitempty"`
	// Outside says it changes something outside the current project, which needs --yes (or a yes at a terminal).
	Outside bool   `json:"outsideProject"`
	State   string `json:"state"`
	Note    string `json:"note,omitempty"`
	apply   func() error
}

func (s *setupStep) pending() bool {
	return s.State == stepCreate || s.State == stepUpdate || s.State == stepRun
}

// target is the step's file or command line, for people to read.
func (s *setupStep) target() string {
	if s.Path != "" {
		return s.Path
	}
	return shellLine(s.Command)
}

type setupResult struct {
	Agents   []string  `json:"agents"`
	Detected []string  `json:"detected"`
	Scope    string    `json:"scope"`
	DryRun   bool      `json:"dryRun"`
	Changed  bool      `json:"changed"`
	MCP      mcpLaunch `json:"mcp"`
	// Credential is where the MCP server's credential comes from: saved (kantel login), environment (only in this
	// run's KANTEL_API_KEY or --key, which the agents get only where it is set for them too), or none.
	Credential string       `json:"credential"`
	Steps      []*setupStep `json:"steps"`
}

// setupPlan is what agent setup works out before it changes anything.
type setupPlan struct {
	c       *cli.Context
	steps   []*setupStep
	byPath  map[string]*setupStep
	cwd     string
	launch  mcpLaunch
	env     map[string]string
	global  bool
	failure error
}

// outside says whether path is outside the project, where it really is: a link in the project (.cursor linked to
// ~/.cursor) is followed, so writing through it needs --yes as writing outside does.
func (p *setupPlan) outside(path string) bool {
	root := resolved(p.cwd)
	rel, err := filepath.Rel(root, resolved(path))
	return err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel)
}

// resolved is path with every link in it followed, part by part, including a link whose destination doesn't exist
// yet (writing through it creates the file there) and links within links; what doesn't exist is kept as written.
func resolved(path string) string { return resolveLinks(filepath.Clean(path), 0) }

func resolveLinks(path string, depth int) string {
	if depth > 40 {
		return path // a loop: Lstat and the write will fail on it anyway
	}
	parts := strings.Split(path, string(filepath.Separator))
	at := string(filepath.Separator)
	if !filepath.IsAbs(path) {
		at = "."
	}
	for i, part := range parts {
		if part == "" {
			continue
		}
		next := filepath.Join(at, part)
		info, err := os.Lstat(next)
		if err != nil {
			// Nothing here: the rest is as written.
			return filepath.Join(append([]string{next}, parts[i+1:]...)...)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(next)
			if err != nil {
				return filepath.Join(append([]string{next}, parts[i+1:]...)...)
			}
			if !filepath.IsAbs(target) {
				target = filepath.Join(at, target)
			}
			next = resolveLinks(filepath.Clean(target), depth+1)
		}
		at = next
	}
	return at
}

// file plans a file whose content is desired(what it holds now, or nil): unchanged when that is what it holds.
func (p *setupPlan) file(agent, what, path string, desired func(existing *string) (string, error)) {
	if s, ok := p.byPath[path]; ok {
		if !has(s.Agents, agent) {
			s.Agents = append(s.Agents, agent)
		}
		return
	}
	s := &setupStep{Agents: []string{agent}, What: what, Path: path, Outside: p.outside(path)}
	p.steps = append(p.steps, s)
	p.byPath[path] = s
	existing, err := readTextIfAny(path)
	var content string
	if err == nil {
		content, err = desired(existing)
	}
	switch {
	case err != nil:
		s.State, s.Note = stepSkipped, err.Error()
		p.failure = err
	case existing != nil && *existing == content:
		s.State = stepUnchanged
	case existing == nil:
		s.State = stepCreate
	default:
		s.State = stepUpdate
	}
	s.apply = func() error {
		// The file as it was planned from, or setup would write over what changed while it waited for a yes.
		now, err := readTextIfAny(path)
		if err != nil {
			return err
		}
		if (now == nil) != (existing == nil) || (now != nil && *now != *existing) {
			return cli.Fail(path + " changed while setup was waiting, so it was left alone: run kantel agent setup again")
		}
		return writeText(path, content)
	}
}

// command plans a command, run with the agent's CLI found at bin.
func (p *setupPlan) command(agent, what, bin string, words []string, outside bool, state string) *setupStep {
	s := &setupStep{Agents: []string{agent}, What: what, Command: words, Outside: outside, State: state}
	s.apply = func() error { return runAgentCLI(p.c, bin, words[1:]) }
	p.steps = append(p.steps, s)
	return s
}

// runAgentCLI runs an agent's CLI in this directory, with this environment, and fails with what it said.
func runAgentCLI(c *cli.Context, bin string, args []string) error {
	cmd := exec.CommandContext(c.Ctx, bin, args...)
	cmd.Dir = c.IO.Cwd
	for _, k := range sortedKeysOf(c.IO.Env) {
		cmd.Env = append(cmd.Env, k+"="+c.IO.Env[k])
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		said := strings.TrimSpace(string(out))
		if said != "" {
			return fmt.Errorf("%s %s failed: %s", filepath.Base(bin), strings.Join(args[:min(2, len(args))], " "), said)
		}
		return fmt.Errorf("%s %s failed: %v", filepath.Base(bin), strings.Join(args[:min(2, len(args))], " "), err)
	}
	return nil
}

func sortedKeysOf[M ~map[string]V, V any](m M) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// envFlags is the MCP server's environment as an agent CLI's flags: KANTEL_URL alone, when it isn't the default.
func (p *setupPlan) envFlags(flag string) []string {
	var out []string
	for _, k := range sortedKeysOf(p.env) {
		out = append(out, flag, k+"="+p.env[k])
	}
	return out
}

// sameServer says whether an MCP client's entry for kantel starts the server as launch says, with env.
func sameServer(entry any, launch mcpLaunch, env map[string]string) bool {
	m, ok := entry.(map[string]any)
	if !ok || m["command"] != launch.Command {
		return false
	}
	args, _ := m["args"].([]any)
	if len(args) != len(launch.Args) {
		return false
	}
	for i, a := range args {
		if a != launch.Args[i] {
			return false
		}
	}
	got := map[string]string{}
	if e, ok := m["env"].(map[string]any); ok {
		for k, v := range e {
			s, ok := v.(string)
			if !ok {
				return false
			}
			got[k] = s
		}
	}
	return reflect.DeepEqual(got, env) || (len(got) == 0 && len(env) == 0)
}

// jsonFileEntry is a JSON file's mcpServers.kantel, or nil.
func jsonFileEntry(path string) (any, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return nil, false
	}
	servers, _ := doc["mcpServers"].(map[string]any)
	entry, ok := servers["kantel"]
	return entry, ok
}

// Claude Code.

func (p *setupPlan) claudeMCP() {
	c := p.c
	scope, path := "project", filepath.Join(p.cwd, ".mcp.json")
	if p.global {
		scope = "user"
		dir := c.IO.Env.Get("CLAUDE_CONFIG_DIR")
		if dir == "" {
			dir = c.IO.Home
		}
		path = filepath.Join(dir, ".claude.json")
	}
	add := append(append([]string{"claude", "mcp", "add", "--scope", scope, "kantel"}, p.envFlags("-e")...), "--")
	add = append(add, p.launch.words()...)
	entry, exists := jsonFileEntry(path)
	if exists && sameServer(entry, p.launch, p.env) {
		s := p.command("claude", "mcp", "", add, p.global, stepUnchanged)
		s.Note = "in " + path
		return
	}
	bin, ok := onPath("claude", c.IO.Env)
	if !ok {
		s := p.command("claude", "mcp", "", add, p.global, stepSkipped)
		s.Note = "claude isn't on your PATH: once it is, run this, or kantel agent setup again"
		return
	}
	if exists {
		s := p.command("claude", "mcp", bin, []string{"claude", "mcp", "remove", "--scope", scope, "kantel"}, p.global, stepRun)
		s.Note = "it starts kantel otherwise now"
	}
	s := p.command("claude", "mcp", bin, add, p.global, stepRun)
	if !p.global {
		s.Note = "Claude Code asks to use it the first time it starts in this project"
	}
}

// Codex.

// codexEntry is what ~/.codex/config.toml says of [mcp_servers.kantel]: enough to tell whether it is as agent setup
// would make it. Anything it can't read is taken as different, which only makes setup register it again.
type codexEntry struct {
	found   bool
	command string
	args    []string
	env     map[string]string
	timeout *float64
}

var (
	tomlHeader  = regexp.MustCompile(`^\s*\[\s*([^\[\]]+?)\s*\]\s*(#.*)?$`)
	tomlKey     = regexp.MustCompile(`^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$`)
	tomlInlineK = regexp.MustCompile(`("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')`)
)

func tomlName(raw string) string {
	parts := strings.Split(raw, ".")
	for i, part := range parts {
		parts[i] = strings.Trim(strings.TrimSpace(part), `"'`)
	}
	return strings.Join(parts, ".")
}

func tomlString(v string) (string, bool) {
	switch {
	case strings.HasPrefix(v, `"`):
		var s string
		if json.Unmarshal([]byte(v), &s) == nil {
			return s, true
		}
	case strings.HasPrefix(v, "'") && strings.HasSuffix(v, "'") && len(v) >= 2:
		return v[1 : len(v)-1], true
	}
	return "", false
}

func readCodexEntry(text string) codexEntry {
	e := codexEntry{env: map[string]string{}}
	table := ""
	for _, line := range strings.Split(text, "\n") {
		if m := tomlHeader.FindStringSubmatch(line); m != nil && !strings.HasPrefix(strings.TrimSpace(line), "[[") {
			table = tomlName(m[1])
			if table == "mcp_servers.kantel" {
				e.found = true
			}
			continue
		}
		m := tomlKey.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		key, value := strings.Trim(m[1], `"'`), m[2]
		switch table {
		case "mcp_servers.kantel":
			switch key {
			case "command":
				e.command, _ = tomlString(value)
			case "args":
				var args []string
				if json.Unmarshal([]byte(value), &args) == nil {
					e.args = args
				} else {
					e.args = []string{"\x00unreadable"}
				}
			case "env":
				for _, kv := range tomlInlineK.FindAllStringSubmatch(value, -1) {
					if s, ok := tomlString(kv[2]); ok {
						e.env[strings.Trim(kv[1], `"'`)] = s
					}
				}
			case "tool_timeout_sec":
				if f, err := strconv.ParseFloat(strings.TrimSpace(strings.SplitN(value, "#", 2)[0]), 64); err == nil {
					e.timeout = &f
				}
			}
		case "mcp_servers.kantel.env":
			if s, ok := tomlString(value); ok {
				e.env[key] = s
			}
		}
	}
	return e
}

func (e codexEntry) same(launch mcpLaunch, env map[string]string) bool {
	return e.found && e.command == launch.Command && reflect.DeepEqual(append([]string{}, e.args...), append([]string{}, launch.Args...)) &&
		(reflect.DeepEqual(e.env, env) || (len(e.env) == 0 && len(env) == 0))
}

// withCodexTimeout is config.toml with tool_timeout_sec = 660 in [mcp_servers.kantel].
func withCodexTimeout(text string) (string, error) {
	lines := strings.Split(text, "\n")
	header, end := -1, len(lines)
	for i, line := range lines {
		m := tomlHeader.FindStringSubmatch(line)
		if m == nil || strings.HasPrefix(strings.TrimSpace(line), "[[") {
			continue
		}
		if header == -1 && tomlName(m[1]) == "mcp_servers.kantel" {
			header = i
		} else if header != -1 {
			end = i
			break
		}
	}
	if header == -1 {
		return "", errors.New("there is no [mcp_servers.kantel] in Codex's config.toml")
	}
	setting := fmt.Sprintf("tool_timeout_sec = %d", toolTimeoutSeconds)
	for i := header + 1; i < end; i++ {
		if m := tomlKey.FindStringSubmatch(lines[i]); m != nil && strings.Trim(m[1], `"'`) == "tool_timeout_sec" {
			lines[i] = setting
			return strings.Join(lines, "\n"), nil
		}
	}
	out := append(append(append([]string{}, lines[:header+1]...), setting), lines[header+1:]...)
	return strings.Join(out, "\n"), nil
}

func (p *setupPlan) codexMCP() {
	c := p.c
	home := c.IO.Env.Get("CODEX_HOME")
	if home == "" {
		home = filepath.Join(c.IO.Home, ".codex")
	}
	path := filepath.Join(home, "config.toml")
	add := append(append([]string{"codex", "mcp", "add", "kantel"}, p.envFlags("--env")...), "--")
	add = append(add, p.launch.words()...)
	existing, _ := readTextIfAny(path)
	entry := codexEntry{}
	if existing != nil {
		entry = readCodexEntry(*existing)
	}
	registered := entry.same(p.launch, p.env)
	timed := entry.timeout != nil && *entry.timeout == toolTimeoutSeconds
	if registered && timed {
		s := p.command("codex", "mcp", "", add, true, stepUnchanged)
		s.Note = fmt.Sprintf("in %s, with tool_timeout_sec = %d", path, toolTimeoutSeconds)
		return
	}
	bin, ok := onPath("codex", c.IO.Env)
	if !registered {
		if !ok {
			s := p.command("codex", "mcp", "", add, true, stepSkipped)
			s.Note = fmt.Sprintf("codex isn't on your PATH: once it is, run this and add tool_timeout_sec = %d under "+
				"[mcp_servers.kantel] in %s, or run kantel agent setup again", toolTimeoutSeconds, path)
			return
		}
		p.command("codex", "mcp", bin, add, true, stepRun)
	}
	// codex mcp add has no flag for the tool timeout, and drops one already there: it goes in config.toml after.
	state := stepUpdate
	if existing == nil {
		state = stepCreate
	}
	s := &setupStep{Agents: []string{"codex"}, What: "tool-timeout", Path: path, Outside: p.outside(path), State: state,
		Note: fmt.Sprintf("tool_timeout_sec = %d under [mcp_servers.kantel]: a Kantel tool call can wait up to 10 minutes", toolTimeoutSeconds)}
	s.apply = func() error {
		text, err := readTextIfAny(path)
		if err != nil {
			return err
		}
		if text == nil {
			return errors.New(path + " isn't there after codex mcp add")
		}
		updated, err := withCodexTimeout(*text)
		if err != nil {
			return err
		}
		return writeText(path, updated)
	}
	p.steps = append(p.steps, s)
}

// Cursor.

type jsonMember struct {
	key   string
	value json.RawMessage
}

// orderedMembers is a JSON object's members in their order.
func orderedMembers(raw []byte) ([]jsonMember, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, errors.New("isn't a JSON object")
	}
	var members []jsonMember
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := tok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		members = append(members, jsonMember{key, value})
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	return members, nil
}

func membersJSON(members []jsonMember) json.RawMessage {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range members {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsonText(m.key))
		b.WriteByte(':')
		b.Write(m.value)
	}
	b.WriteByte('}')
	return b.Bytes()
}

func setMember(members []jsonMember, key string, value json.RawMessage) []jsonMember {
	for i := range members {
		if members[i].key == key {
			members[i].value = value
			return members
		}
	}
	return append(members, jsonMember{key, value})
}

type cursorServer struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env,omitempty"`
}

// withKantelServer is an mcp.json with kantel in its mcpServers, as server says, and every other server and setting as
// it was; existing as it is when its kantel is that already.
func withKantelServer(existing *string, path string, launch mcpLaunch, env map[string]string) (string, error) {
	entry := json.RawMessage(jsonText(cursorServer{Command: launch.Command, Args: launch.Args, Env: env}))
	if existing == nil || strings.TrimSpace(*existing) == "" {
		return jsonIndented(map[string]any{"mcpServers": map[string]any{"kantel": entry}}) + "\n", nil
	}
	if found, ok := jsonFileEntry(path); ok && sameServer(found, launch, env) {
		return *existing, nil
	}
	top, err := orderedMembers([]byte(*existing))
	if err != nil {
		return "", fmt.Errorf("%s isn't a JSON object, so agent setup leaves it alone: fix it, or add kantel to its mcpServers yourself", path)
	}
	var servers []jsonMember
	for _, m := range top {
		if m.key == "mcpServers" {
			if servers, err = orderedMembers(m.value); err != nil {
				return "", fmt.Errorf("%s's mcpServers isn't a JSON object, so agent setup leaves it alone", path)
			}
		}
	}
	top = setMember(top, "mcpServers", membersJSON(setMember(servers, "kantel", entry)))
	var b bytes.Buffer
	if err := json.Indent(&b, membersJSON(top), "", "  "); err != nil {
		return "", err
	}
	return b.String() + "\n", nil
}

func (p *setupPlan) cursorMCP(base string) {
	path := filepath.Join(base, ".cursor", "mcp.json")
	p.file("cursor", "mcp", path, func(existing *string) (string, error) {
		return withKantelServer(existing, path, p.launch, p.env)
	})
}

// The command.

func agentSetupCommand() *cli.Command {
	return &cli.Command{
		Name:    "agent setup",
		Summary: "Set up the coding agents on this computer to use Kantel: the skill, AGENTS.md and the MCP server",
		Flags: []cli.Flag{
			{Name: "for", Type: cli.String, Multiple: true, Value: "<claude|codex|cursor|pi>", Choices: agentNames(),
				Description: "Only these agents; repeat it (default the ones found here)"},
			{Name: "global", Type: cli.Bool, Description: "For every project: the skill under your home, and the MCP server at user scope"},
			{Name: "no-mcp", Type: cli.Bool, Description: "Don't register the MCP server"},
			{Name: "no-skill", Type: cli.Bool, Description: "Don't install the skill or the AGENTS.md and CLAUDE.md block"},
			{Name: "dry-run", Type: cli.Bool, Description: "Print every file and command it would write or run, and change nothing"},
			{Name: "yes", Type: cli.Bool, Short: "y", Description: "Yes, change files outside this project too (--global, Codex's config)"},
		},
		Details: "It finds Claude Code, Codex, Cursor and pi by their command on your PATH or their directory in your\n" +
			"home (~/.claude, ~/.codex, ~/.cursor, ~/.pi), and for each:\n\n" +
			"  Claude Code  CLAUDE.md block, .claude/skills/kantel, claude mcp add (project scope, or user)\n" +
			"  Codex        AGENTS.md block, .agents/skills/kantel, codex mcp add and tool_timeout_sec = 660\n" +
			"               in ~/.codex/config.toml (Codex's MCP servers are always your own)\n" +
			"  Cursor       AGENTS.md block, .cursor/mcp.json (or ~/.cursor/mcp.json), its other servers kept\n" +
			"  pi           AGENTS.md block, .agents/skills/kantel (pi has no MCP: it runs kantel)\n\n" +
			"It sets up this project unless --global, which installs the skill under your home and registers the\n" +
			"MCP server for every project, skipping the .md files, as kantel init --global does. Anything outside\n" +
			"this project needs --yes, or a yes when it asks at a terminal. Run again, it changes nothing that is\n" +
			"already set up, and says so.\n\n" +
			"Nothing it writes holds a key. The MCP server uses kantel's own sign-in (kantel login), and gets\n" +
			"KANTEL_URL only when Kantel isn't at " + cli.DefaultURL + ". To give an agent a scoped key of\n" +
			"its own instead: " + agentKeyCommand + ", and set KANTEL_API_KEY where it runs.",
		Examples: []cli.Example{
			{What: "See what it would do for the agents found here", Line: "kantel agent setup --dry-run"},
			{What: "Set up this project for Claude Code and Codex", Line: "kantel agent setup --for claude --for codex --yes"},
			{What: "Every project, for every agent found, from a script", Line: "kantel agent setup --global --yes"},
			{What: "The skill and AGENTS.md block only, no MCP", Line: "kantel agent setup --no-mcp"},
		},
		Run: runAgentSetup,
	}
}

func runAgentSetup(c *cli.Context) error {
	picked, err := choices(c.List("for"), "--for", agentNames()...)
	if err != nil {
		return err
	}
	withMCP, withSkill := !c.Bool("no-mcp"), !c.Bool("no-skill")
	if !withMCP && !withSkill {
		return cli.Usage("--no-mcp with --no-skill leaves nothing to set up")
	}
	detected := detectAgents(c.IO.Env, c.IO.Home)
	wanted := picked
	if wanted == nil {
		if len(detected) == 0 {
			return &cli.Error{Message: "found no coding agent here: none of claude, codex, cursor or pi is on your PATH or has its directory in your home",
				Code: "not_found", Hint: "Name them with --for: kantel agent setup --for claude", Exit: cli.ExitFailed}
		}
		wanted = detected
	}
	var agents []string
	for _, name := range agentNames() {
		if has(wanted, name) {
			agents = append(agents, name)
		}
	}
	s, err := Settings(c)
	if err != nil {
		return err
	}
	stored, _ := cli.ReadStored(c.IO.ConfigDir)
	global := c.Bool("global")
	p := &setupPlan{c: c, byPath: map[string]*setupStep{}, cwd: c.IO.Cwd, launch: launchOf(c), env: map[string]string{}, global: global}
	// The URL goes in the agent's setup unless `kantel mcp` would find the same one by itself, from the saved sign-in
	// or the default: an explicit --url of the hosted Kantel still wins over a self-hosted one saved.
	plain := cli.DefaultURL
	if stored.URL != "" {
		if u, err := cli.NormaliseURL(stored.URL); err == nil {
			plain = cli.Origin(u)
		}
	}
	if url := cli.Origin(s.URL); url != plain {
		p.env["KANTEL_URL"] = url
	}
	base := c.IO.Cwd
	if global {
		base = c.IO.Home
	}
	block := func(existing *string) (string, error) { return upsertAgentsBlock(existing, agentsBlock), nil }
	skill := func(*string) (string, error) { return skillMD, nil }
	for _, agent := range agents {
		if withSkill && !global {
			md := "AGENTS.md"
			if agent == "claude" {
				md = "CLAUDE.md"
			}
			p.file(agent, "instructions", filepath.Join(base, md), block)
		}
		if withSkill && agent != "cursor" {
			path := agentsSkillPath
			if agent == "claude" {
				path = claudeSkillPath
			}
			p.file(agent, "skill", filepath.Join(base, path), skill)
		}
		if withMCP {
			switch agent {
			case "claude":
				p.claudeMCP()
			case "codex":
				p.codexMCP()
			case "cursor":
				p.cursorMCP(base)
			}
		}
	}
	if p.failure != nil {
		return p.failure
	}
	dryRun := c.Bool("dry-run")
	var outside []*setupStep
	for _, st := range p.steps {
		if st.pending() && st.Outside {
			outside = append(outside, st)
		}
	}
	if len(outside) > 0 && !dryRun && !c.Bool("yes") {
		if err := confirmOutside(c, outside, agents); err != nil {
			return err
		}
	}
	changed, failed := false, false
	if !dryRun {
		for _, st := range p.steps {
			if !st.pending() {
				continue
			}
			planned := st.State
			if err := st.apply(); err != nil {
				st.State, st.Note, failed = stepFailed, err.Error(), true
				continue
			}
			changed = true
			st.State = map[string]string{stepCreate: stepCreated, stepUpdate: stepUpdated, stepRun: stepRan}[planned]
		}
	}
	result := setupResult{Agents: agents, Detected: append([]string{}, detected...), Scope: "project", DryRun: dryRun,
		Changed: changed, MCP: p.launch, Credential: "none", Steps: p.steps}
	switch {
	case stored.APIKey != "":
		result.Credential = "saved"
	case s.APIKey != "":
		result.Credential = "environment"
	}
	if global {
		result.Scope = "global"
	}
	if c.JSON {
		c.Out(jsonIndented(result))
	} else {
		c.Out(describeSetup(c, result, withMCP))
	}
	if failed {
		return cli.ExitCode(cli.ExitFailed)
	}
	return nil
}

// confirmOutside asks at a terminal whether to change things outside this project, or refuses without one.
func confirmOutside(c *cli.Context, steps []*setupStep, agents []string) error {
	var targets []string
	for _, st := range steps {
		targets = append(targets, "  "+st.target())
	}
	if c.IO.StdinTTY && c.IO.StderrTTY {
		c.Note("This changes things outside this project:\n" + strings.Join(targets, "\n"))
		fmt.Fprint(c.IO.Stderr, "Go ahead? [y/N] ")
		answer, _ := bufio.NewReader(c.IO.Stdin).ReadString('\n')
		switch strings.ToLower(strings.TrimSpace(answer)) {
		case "y", "yes":
			return nil
		}
		return &cli.Error{Message: "changed nothing", Code: "declined", Exit: cli.ExitFailed}
	}
	line := setupCommandLine(c, agents)
	return &cli.Error{
		Message: "this changes things outside this project, so it needs --yes:\n" + strings.Join(targets, "\n"),
		Code:    "usage",
		Hint:    "To go ahead, run: " + line + " --yes (or " + line + " --dry-run to see everything it would do)",
		Exit:    cli.ExitUsage,
	}
}

// setupCommandLine is this agent setup as a command line, without --yes, --dry-run or a key.
func setupCommandLine(c *cli.Context, agents []string) string {
	words := []string{"kantel", "agent", "setup"}
	for _, a := range c.List("for") {
		words = append(words, "--for", a)
	}
	for _, flag := range []string{"global", "no-mcp", "no-skill"} {
		if c.Bool(flag) {
			words = append(words, "--"+flag)
		}
	}
	for _, flag := range []string{"url", "account"} {
		if v, ok := c.Str(flag); ok {
			words = append(words, "--"+flag, v)
		}
	}
	if c.JSON {
		words = append(words, "--json")
	}
	return shellLine(words)
}

var whatSays = map[string]string{
	"instructions": "Kantel's block",
	"skill":        "the kantel skill",
	"mcp":          "Kantel's MCP server",
	"tool-timeout": "the tool timeout",
}

func labels(agents []string) string {
	names := make([]string, len(agents))
	for i, a := range agents {
		names[i] = agentLabel(a)
	}
	if len(names) <= 1 {
		return strings.Join(names, "")
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

func describeSetup(c *cli.Context, r setupResult, withMCP bool) string {
	var lines []string
	pending := false
	for _, st := range r.Steps {
		about := whatSays[st.What] + ", for " + labels(st.Agents)
		verb := ""
		switch st.State {
		case stepCreate, stepUpdate:
			verb, pending = "Would write "+st.Path, true
		case stepRun:
			verb, pending = "Would run: "+st.target(), true
		case stepCreated, stepUpdated:
			verb = "Wrote " + st.Path
		case stepRan:
			verb = "Ran: " + st.target()
		case stepUnchanged:
			verb = "Already set up: " + st.target()
		case stepSkipped:
			verb = "Skipped: " + st.target()
		case stepFailed:
			verb = "Failed: " + st.target()
		}
		if st.Outside && (st.State == stepCreate || st.State == stepUpdate || st.State == stepRun) {
			about += "; outside this project"
		}
		line := verb + " (" + about + ")"
		if st.Note != "" {
			line += "\n  " + st.Note
		}
		lines = append(lines, line)
	}
	lines = append(lines, "")
	switch {
	case r.DryRun && pending:
		lines = append(lines, "Changed nothing (--dry-run).")
	case !r.Changed && !hasState(r.Steps, stepFailed):
		lines = append(lines, "Nothing to change: Kantel is already set up for "+labels(r.Agents)+".")
	}
	if has(r.Agents, "pi") && withMCP {
		lines = append(lines, "pi has no MCP: it runs the kantel command, as its skill and AGENTS.md say.")
	}
	switch r.Credential {
	case "saved":
		lines = append(lines, "The agents use your kantel sign-in; nothing written holds a key. To give them a scoped key of their own",
			"instead: "+agentKeyCommand+", and set KANTEL_API_KEY where they run.")
	case "environment":
		lines = append(lines, "Nothing written holds a key, and your key isn't saved (it is in KANTEL_API_KEY or --key): the agents",
			"get it only where KANTEL_API_KEY is set for them too. Run kantel login to save a sign-in they use, or give",
			"them a scoped key of their own: "+agentKeyCommand+", and set KANTEL_API_KEY where they run.")
	default:
		lines = append(lines, "kantel isn't signed in on this computer: run kantel login, or give the agents a scoped key of their own:",
			agentKeyCommand+", and set KANTEL_API_KEY where they run.")
	}
	if !r.MCP.byName() && withMCP {
		lines = append(lines, "kantel isn't on your PATH, so the MCP server is started by its full path, "+r.MCP.Command+".")
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
}

func hasState(steps []*setupStep, state string) bool {
	for _, s := range steps {
		if s.State == state {
			return true
		}
	}
	return false
}
