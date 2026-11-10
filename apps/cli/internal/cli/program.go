// Package cli is what kantel and kantel-admin are built on: a table of commands, from which their help, their JSON
// description (help --json), their shell completion and their docs reference are all made, and the conventions they
// keep to (packages/cli/CONVENTIONS.md): answers on stdout, everything else on stderr, the exit codes, --json errors,
// "did you mean", and colour only for a person at a terminal.
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
)

// Arg is one of a command's arguments.
type Arg struct {
	Name     string
	Optional bool
	// Variadic takes the rest of the words.
	Variadic bool
}

// Example is one of a command's examples: what it does, and the line to type.
type Example struct{ What, Line string }

// Command is one command.
type Command struct {
	// Name is its words, such as `snapshot save`.
	Name    string
	Summary string
	// Usage is its usage line, where its arguments say it badly, such as `env set <env> <NAME>[=<value>]`.
	Usage string
	// Hidden leaves it out of help: an older spelling, or the completion scripts' __complete.
	Hidden  bool
	Args    []Arg
	Flags   []Flag
	Details string
	// Rest is what it takes after --, such as exec's `command…`.
	Rest         string
	RestOptional bool
	Examples     []Example
	Run          func(*Context) error
}

// Section is a heading in the help and the commands under it.
type Section struct {
	Title    string
	Commands []*Command
}

// Group is a word that starts several commands, such as `snapshot`.
type Group struct{ Name, Summary string }

// Program is one command line.
type Program struct {
	Name    string
	Version string
	// Tagline follows the name and version at the top of the help.
	Tagline     string
	Sections    []Section
	Groups      []Group
	GlobalFlags []Flag
	// Aliases are other names for commands: `ls` for `list`, `sandbox create` for `new`.
	Aliases map[string]string
	// GroupAliases are other names for groups: `sb` for `sandbox`.
	GroupAliases map[string]string
	// Deprecated are aliases kept for scripts, with what to use now, said on stderr each time.
	Deprecated map[string]string
	// Moved are commands that went elsewhere, with where.
	Moved map[string]string
	// SubcommandAliases are other spellings of a subcommand's last word: `ls` for `list`, `rm` for `delete`.
	SubcommandAliases map[string]string
	// SandboxGroup is a group whose commands are top-level ones under another word (`sandbox` for new, list…).
	SandboxGroup string
	// Footer is the lines at the end of the main help.
	Footer []string
	// ExitCodes describe the exit codes, for help --json.
	ExitCodes map[int]string
	// Hint says what to do about one of Kantel's errors.
	Hint func(*api.Error) string
	// Complete answers the candidates for an argument, such as sandbox IDs, from Kantel; nil offers none.
	Complete func(c *Context, arg Arg) []Candidate
}

// IO is what a run reads, writes and calls: the process's by default, a test's fakes otherwise.
type IO struct {
	Stdout, Stderr       io.Writer
	Stdin                io.Reader
	StdoutTTY, StderrTTY bool
	StdinTTY             bool
	Env                  Env
	Home, ConfigDir, Cwd string
	HTTP                 *http.Client
	Now                  func() time.Time
	Sleep                func(ctx context.Context, d time.Duration) error
	OpenURL              func(url string)
	// Self is this program's own path, for the agent setups and the self-update.
	Self string
}

// Context is what a command's Run gets.
type Context struct {
	Ctx     context.Context
	IO      *IO
	Program *Program
	Command *Command
	// JSON is --json: answers as JSON on stdout, a failure as JSON on stderr.
	JSON   bool
	Args   []string
	Rest   []string
	Parsed *Parsed
	// Style colours stdout's text, ErrStyle stderr's, each only at a terminal.
	Style, ErrStyle Styler
	// Values holds what a program keeps for one run, such as its settings and client.
	Values map[string]any
}

// Arg is argument i, which the command's table says is there.
func (c *Context) Arg(i int) string {
	if i < len(c.Args) {
		return c.Args[i]
	}
	return ""
}

// Optional is argument i and whether it was given.
func (c *Context) Optional(i int) (string, bool) {
	if i < len(c.Args) {
		return c.Args[i], true
	}
	return "", false
}

// Str is a string flag's value and whether it was given.
func (c *Context) Str(name string) (string, bool) { return c.Parsed.Str(name) }

// StrOr is a string flag's value, or def.
func (c *Context) StrOr(name, def string) string {
	if v, ok := c.Parsed.Str(name); ok {
		return v
	}
	return def
}

// Bool is a boolean flag.
func (c *Context) Bool(name string) bool { return c.Parsed.Bool(name) }

// List is a repeatable flag's values.
func (c *Context) List(name string) []string { return c.Parsed.List(name) }

// Out writes a line to stdout.
func (c *Context) Out(text string) { fmt.Fprintln(c.IO.Stdout, text) }

// Note writes a line to stderr.
func (c *Context) Note(text string) { fmt.Fprintln(c.IO.Stderr, text) }

// Emit prints an answer: with --json the raw JSON Kantel sent (indented), or value as JSON when there is none; else
// human()'s text, if any.
func (c *Context) Emit(raw json.RawMessage, value any, human func() string) {
	if c.JSON {
		c.Out(IndentJSON(raw, value))
		return
	}
	if text := human(); text != "" {
		c.Out(text)
	}
}

// IndentJSON is raw indented two spaces, or value marshalled so when raw is empty.
func IndentJSON(raw json.RawMessage, value any) string {
	if len(raw) > 0 {
		var b bytes.Buffer
		if json.Indent(&b, raw, "", "  ") == nil {
			return b.String()
		}
	}
	out, _ := json.MarshalIndent(value, "", "  ")
	return string(out)
}

// Spin runs work behind a spinner on stderr, at a terminal only.
func (c *Context) Spin(text string, work func() error) error {
	_, err := Spin(c.IO.Stderr, c.ErrStyle.On, text, func() (struct{}, error) { return struct{}{}, work() })
	return err
}

// Commands is every command, in the help's order.
func (p *Program) Commands() []*Command {
	var all []*Command
	for _, s := range p.Sections {
		all = append(all, s.Commands...)
	}
	return all
}

func (p *Program) byName(name string) *Command {
	if alias, ok := p.Aliases[name]; ok {
		name = alias
	}
	for _, c := range p.Commands() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func (p *Program) group(name string) (Group, bool) {
	for _, g := range p.Groups {
		if g.Name == name {
			return g, true
		}
	}
	return Group{}, false
}

func (p *Program) flag(name string) *Flag { return findFlag(p.GlobalFlags, name) }

type resolution struct {
	kind       string // command, group, moved, unknown
	command    *Command
	argv       []string
	deprecated string
	group      string
	unknown    string
	word       string
	moved      string
	// next is the word after an unknown first one, for a two-word "did you mean" (`hots list`).
	next string
}

// resolve finds the command argv names in its first one, two or three words (flags may come before them), and the
// rest of argv. The longest name wins: `env file rm` over `env file`, and `grant rm` over `grant`.
func (p *Program) resolve(argv []string) resolution {
	var words []int
	for i := 0; i < len(argv) && len(words) < 3; i++ {
		token := argv[i]
		if token == "--" {
			break
		}
		if strings.HasPrefix(token, "-") && token != "-" {
			name := strings.TrimLeft(token, "-")
			if !strings.Contains(name, "=") {
				if f := p.flag(name); f != nil && f.Type == String {
					i++
				}
			}
			continue
		}
		words = append(words, i)
	}
	if len(words) == 0 {
		return resolution{kind: "unknown"}
	}
	without := func(drop ...int) []string {
		var out []string
		for i, w := range argv {
			skip := false
			for _, d := range drop {
				if i == d {
					skip = true
				}
			}
			if !skip {
				out = append(out, w)
			}
		}
		return out
	}
	typed := argv[words[0]]
	first := typed
	if a, ok := p.GroupAliases[typed]; ok {
		first = a
	}
	second, pair := "", ""
	if len(words) > 1 {
		second = argv[words[1]]
		pair = first + " " + second
		if to, ok := p.Moved[pair]; ok {
			return resolution{kind: "moved", word: pair, moved: to}
		}
	}
	sub := func(prefix, word string) *Command {
		if c := p.byName(prefix + " " + word); c != nil {
			return c
		}
		if alias, ok := p.SubcommandAliases[word]; ok {
			return p.byName(prefix + " " + alias)
		}
		return nil
	}
	if len(words) > 2 {
		if c := sub(pair, argv[words[2]]); c != nil {
			return resolution{kind: "command", command: c, argv: without(words[0], words[1], words[2])}
		}
	}
	if single := p.byName(first); single != nil {
		if len(words) > 1 {
			if double := sub(first, second); double != nil {
				return resolution{kind: "command", command: double, argv: without(words[0], words[1])}
			}
		}
		r := resolution{kind: "command", command: single, argv: without(words[0])}
		if _, ok := p.Deprecated[first]; ok {
			r.deprecated = first
		}
		return r
	}
	if _, ok := p.group(first); !ok {
		return resolution{kind: "unknown", word: typed, next: second}
	}
	if len(words) < 2 {
		return resolution{kind: "group", group: first}
	}
	if c := sub(first, second); c != nil {
		return resolution{kind: "command", command: c, argv: without(words[0], words[1])}
	}
	return resolution{kind: "group", group: first, unknown: second}
}

// Run runs the program with argv (the words after its name) and answers its exit code.
func Run(p *Program, argv []string, io *IO) int {
	asJSON := WantsJSON(argv)
	c := &Context{
		Ctx: context.Background(), IO: io, Program: p, JSON: asJSON,
		Style:    Styler{On: ColourFor(io.StdoutTTY, io.Env, asJSON)},
		ErrStyle: Styler{On: ColourFor(io.StderrTTY, io.Env, asJSON)},
		Values:   map[string]any{},
		Parsed:   &Parsed{strings: map[string][]string{}, bools: map[string]bool{}},
	}
	code, err := p.dispatch(c, argv)
	if err != nil {
		return p.report(c, err, "")
	}
	return code
}

func (p *Program) report(c *Context, err error, usage string) int {
	var exit ExitCode
	if errors.As(err, &exit) {
		return int(exit)
	}
	f := FailureOf(err, p.Hint)
	fmt.Fprint(c.IO.Stderr, FailureText(p.Name, f, c.JSON, usage, c.ErrStyle))
	return f.Exit
}

func (p *Program) helpHint() string { return `"` + p.Name + ` help" lists the commands.` }

func (p *Program) dispatch(c *Context, argv []string) (int, error) {
	if len(argv) == 0 || argv[0] == "--help" || argv[0] == "-h" {
		c.Out(p.mainHelp(c.Style))
		return ExitOK, nil
	}
	if argv[0] == "--version" || argv[0] == "-V" {
		c.Out(p.Version)
		return ExitOK, nil
	}
	if argv[0] == "__complete" {
		typed := argv[1:]
		if len(typed) > 0 && typed[0] == "--" {
			typed = typed[1:]
		}
		current := ""
		if len(typed) > 0 {
			current = typed[len(typed)-1]
			typed = typed[:len(typed)-1]
		}
		fmt.Fprint(c.IO.Stdout, CandidateLines(p.completions(c, typed, current), current))
		return ExitOK, nil
	}
	r := p.resolve(argv)
	switch r.kind {
	case "moved":
		return 0, Usage(r.word + " is for operators now: " + r.moved)
	case "unknown":
		if r.word == "" {
			return 0, UsageHint("give a command", p.helpHint())
		}
		if r.next != "" {
			// Two words that are nearly a two-word command (`hots list`) suggest it, not just its first word.
			phrase := r.word + " " + r.next
			var names, near []string
			for _, c := range visible(p.Commands()) {
				if strings.Contains(c.Name, " ") {
					names = append(names, c.Name)
				}
			}
			for _, n := range Nearest(phrase, names, 3) {
				near = append(near, p.Name+" "+n)
			}
			if len(near) > 0 {
				return 0, UsageHint(`there is no command "`+phrase+`".`+DidYouMean(near), p.helpHint())
			}
		}
		var near []string
		for _, w := range Nearest(r.word, p.firstWords(), 3) {
			near = append(near, p.Name+" "+w)
		}
		return 0, UsageHint(`there is no command "`+r.word+`".`+DidYouMean(near), p.helpHint())
	case "group":
		if r.unknown == "" {
			c.Out(p.groupHelp(r.group, c.Style))
			return ExitOK, nil
		}
		var near []string
		for _, w := range Nearest(r.unknown, p.subcommands(r.group), 3) {
			near = append(near, p.Name+" "+r.group+" "+w)
		}
		code := p.report(c, Usage(`there is no command "`+r.group+" "+r.unknown+`".`+DidYouMean(near)), "")
		if !c.JSON {
			fmt.Fprintln(c.IO.Stderr, "\n"+p.groupHelp(r.group, c.ErrStyle))
		}
		return code, nil
	}
	if r.deprecated != "" {
		c.Note(fmt.Sprintf(`%s: "%s %s" is going: use %s`, p.Name, p.Name, r.deprecated, p.Deprecated[r.deprecated]))
	}
	code, err := p.execute(c, r.command, r.argv)
	var usage *Error
	if errors.As(err, &usage) && usage.Exit == ExitUsage {
		return p.report(c, err, p.Name+" "+p.synopsis(r.command)+" [flags]"), nil
	}
	return code, err
}

func (p *Program) execute(c *Context, cmd *Command, argv []string) (int, error) {
	parsed, err := Parse(argv, append(append([]Flag{}, p.GlobalFlags...), cmd.Flags...))
	if err != nil {
		return 0, err
	}
	c.Command, c.Parsed = cmd, parsed
	if parsed.Bool("help") {
		c.Out(p.commandHelp(cmd, c.Style))
		return ExitOK, nil
	}
	args := parsed.Args
	if cmd.Rest == "" && parsed.HasRest {
		// A command that takes nothing after -- gets what follows as more arguments.
		args = append(args, parsed.Rest...)
	} else {
		c.Rest = parsed.Rest
	}
	var missing []string
	for i, a := range cmd.Args {
		if i >= len(args) && !a.Optional {
			missing = append(missing, argUsage(a))
		}
	}
	if len(missing) > 0 {
		return 0, Usage(cmd.Name + " needs " + strings.Join(missing, " "))
	}
	variadic := len(cmd.Args) > 0 && cmd.Args[len(cmd.Args)-1].Variadic
	if !variadic && len(args) > len(cmd.Args) {
		if cmd.Rest != "" {
			return 0, Usage("put the " + cmd.Rest + " after --")
		}
		return 0, Usage(fmt.Sprintf(`%s takes no "%s"`, cmd.Name, args[len(cmd.Args)]))
	}
	c.Args = args
	if err := cmd.Run(c); err != nil {
		var exit ExitCode
		if errors.As(err, &exit) {
			return int(exit), nil
		}
		return 0, err
	}
	return ExitOK, nil
}

// firstWords is every word a command line may start with, for "did you mean".
func (p *Program) firstWords() []string {
	var words []string
	for _, c := range p.Commands() {
		if !c.Hidden {
			words = append(words, strings.Fields(c.Name)[0])
		}
	}
	for _, g := range p.Groups {
		words = append(words, g.Name)
	}
	return words
}

func (p *Program) subcommands(group string) []string {
	var words []string
	for _, c := range p.Commands() {
		if rest, ok := strings.CutPrefix(c.Name, group+" "); ok && !c.Hidden {
			words = append(words, strings.Fields(rest)[0])
		}
	}
	return words
}

// DefaultIO is the process's own streams and environment.
func DefaultIO() *IO {
	home, _ := os.UserHomeDir()
	cwd, _ := os.Getwd()
	env := EnvOf(os.Environ())
	self, _ := os.Executable()
	return &IO{
		Stdout: os.Stdout, Stderr: os.Stderr, Stdin: os.Stdin,
		StdoutTTY: isTerminal(os.Stdout), StderrTTY: isTerminal(os.Stderr), StdinTTY: isTerminal(os.Stdin),
		Env: env, Home: home, ConfigDir: ConfigDir(env, home), Cwd: cwd,
		HTTP: http.DefaultClient, Now: time.Now, OpenURL: openInBrowser, Self: self,
	}
}

func isTerminal(f *os.File) bool {
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// sortedKeys is a map's keys in order.
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
