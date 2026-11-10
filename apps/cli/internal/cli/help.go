package cli

import (
	"fmt"
	"strings"
)

func argUsage(a Arg) string {
	name := a.Name
	if a.Variadic {
		name += "…"
	}
	if a.Optional {
		return "[" + name + "]"
	}
	return "<" + name + ">"
}

// synopsis is a command's usage line without the program's name: `exec <id> [command…] -- <command…>`.
func (p *Program) synopsis(c *Command) string {
	line := c.Usage
	if line == "" {
		parts := []string{c.Name}
		for _, a := range c.Args {
			parts = append(parts, argUsage(a))
		}
		line = strings.Join(parts, " ")
	}
	if c.Rest != "" {
		if c.RestOptional {
			line += " [-- <" + c.Rest + ">]"
		} else {
			line += " -- <" + c.Rest + ">"
		}
	}
	return line
}

func flagRows(flags []Flag) []Field {
	var rows []Field
	for _, f := range flags {
		if f.Hidden {
			continue
		}
		name := "--" + f.Name
		if f.Short != "" {
			name = "-" + f.Short + ", " + name
		}
		if f.Value != "" {
			name += " " + f.Value
		}
		if f.Multiple {
			name += "…"
		}
		rows = append(rows, Field{name, f.Description})
	}
	return rows
}

func indent(text string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = "  " + l
	}
	return strings.Join(lines, "\n")
}

func (p *Program) commandList(commands []*Command, width int) string {
	var lines []string
	for _, c := range commands {
		lines = append(lines, "  "+Pad(p.synopsis(c), width)+"  "+c.Summary)
	}
	return strings.Join(lines, "\n")
}

func visible(commands []*Command) []*Command {
	var out []*Command
	for _, c := range commands {
		if !c.Hidden {
			out = append(out, c)
		}
	}
	return out
}

func (p *Program) mainHelp(s Styler) string {
	width := 0
	for _, c := range visible(p.Commands()) {
		width = max(width, Width(p.synopsis(c)))
	}
	var sections []string
	for _, sec := range p.Sections {
		shown := visible(sec.Commands)
		if len(shown) == 0 {
			continue
		}
		heading := ""
		if sec.Title != "" {
			heading = s.Paint(Bold, sec.Title+":") + "\n"
		}
		sections = append(sections, heading+p.commandList(shown, width))
	}
	lines := []string{
		fmt.Sprintf("%s %s: %s", p.Name, p.Version, p.Tagline), "",
		s.Paint(Bold, "Usage:") + " " + p.Name + " <command> [flags]", "",
		strings.Join(sections, "\n\n"), "",
		s.Paint(Bold, "Flags on every command:") + "\n" + indent(PlainFields(flagRows(p.GlobalFlags))),
	}
	if len(p.Footer) > 0 {
		lines = append(lines, "")
		lines = append(lines, p.Footer...)
	}
	return strings.Join(lines, "\n")
}

func (p *Program) groupHelp(group string, s Styler) string {
	g, _ := p.group(group)
	var commands []*Command
	if group == p.SandboxGroup && p.SandboxGroup != "" {
		seen := map[string]bool{}
		for _, alias := range sortedKeys(p.Aliases) {
			if strings.HasPrefix(alias, group+" ") && !seen[p.Aliases[alias]] {
				seen[p.Aliases[alias]] = true
			}
		}
		for _, c := range p.Commands() {
			if seen[c.Name] {
				commands = append(commands, c)
			}
		}
	} else {
		for _, c := range p.Commands() {
			if strings.HasPrefix(c.Name, group+" ") && !c.Hidden {
				commands = append(commands, c)
			}
		}
	}
	width := 0
	for _, c := range commands {
		width = max(width, Width(p.synopsis(c)))
	}
	return strings.Join([]string{
		s.Paint(Bold, p.Name+" "+group+":") + " " + g.Summary + ".", "",
		p.commandList(commands, width), "",
		fmt.Sprintf(`"%s help %s <command>" shows a command's flags.`, p.Name, group),
	}, "\n")
}

func (p *Program) commandHelp(c *Command, s Styler) string {
	lines := []string{s.Paint(Bold, "Usage:") + " " + p.Name + " " + p.synopsis(c) + " [flags]", "", c.Summary + "."}
	if c.Details != "" {
		lines = append(lines, "", c.Details)
	}
	if own := flagRows(c.Flags); len(own) > 0 {
		lines = append(lines, "", s.Paint(Bold, "Flags:")+"\n"+indent(PlainFields(own)))
	}
	if len(c.Examples) > 0 {
		var shown []string
		for _, e := range c.Examples {
			shown = append(shown, "  "+s.Paint(Dim, "# "+e.What)+"\n  "+e.Line)
		}
		lines = append(lines, "", s.Paint(Bold, "Examples:")+"\n"+strings.Join(shown, "\n\n"))
	}
	lines = append(lines, "", s.Paint(Bold, "Flags on every command:")+"\n"+indent(PlainFields(flagRows(p.GlobalFlags))))
	return strings.Join(lines, "\n")
}

// FlagSchema is a flag as help --json describes it.
type FlagSchema struct {
	Name        string   `json:"name"`
	Short       string   `json:"short,omitempty"`
	Type        string   `json:"type"`
	Value       string   `json:"value,omitempty"`
	Repeatable  bool     `json:"repeatable,omitempty"`
	Choices     []string `json:"choices,omitempty"`
	Description string   `json:"description"`
}

// ArgSchema is an argument as help --json describes it.
type ArgSchema struct {
	Name     string `json:"name"`
	Required bool   `json:"required"`
	Variadic bool   `json:"variadic,omitempty"`
}

// CommandSchema is a command as help --json describes it, made from the same table as its help.
type CommandSchema struct {
	Name     string       `json:"name"`
	Section  string       `json:"section"`
	Summary  string       `json:"summary"`
	Usage    string       `json:"usage"`
	Args     []ArgSchema  `json:"args"`
	Rest     *ArgSchema   `json:"rest,omitempty"`
	Flags    []FlagSchema `json:"flags"`
	Details  string       `json:"details,omitempty"`
	Examples []Example    `json:"examples"`
	Aliases  []string     `json:"aliases,omitempty"`
}

// Schema is every command, its arguments and flags, the flags every command takes and the exit codes: what
// help --json prints, for an agent or a tool to read rather than parse help. It needs no sign-in and no network, and
// SchemaVersion changes only when a field's meaning does.
type Schema struct {
	SchemaVersion int               `json:"schemaVersion"`
	Program       string            `json:"program"`
	Version       string            `json:"version"`
	ExitCodes     map[string]string `json:"exitCodes"`
	Errors        string            `json:"errors"`
	GlobalFlags   []FlagSchema      `json:"globalFlags"`
	Groups        []Group           `json:"groups"`
	Commands      []CommandSchema   `json:"commands"`
}

func (e Example) MarshalJSON() ([]byte, error) {
	return Marshal(struct {
		What string `json:"what"`
		Line string `json:"line"`
	}{e.What, e.Line}, ""), nil
}

func (g Group) MarshalJSON() ([]byte, error) {
	return Marshal(struct {
		Name    string `json:"name"`
		Summary string `json:"summary"`
	}{g.Name, g.Summary}, ""), nil
}

func flagsSchema(flags []Flag) []FlagSchema {
	out := []FlagSchema{}
	for _, f := range flags {
		if f.Hidden {
			continue
		}
		t := "string"
		if f.Type == Bool {
			t = "boolean"
		}
		fs := FlagSchema{Name: "--" + f.Name, Type: t, Value: f.Value, Repeatable: f.Multiple, Choices: f.Choices,
			Description: f.Description}
		if f.Short != "" {
			fs.Short = "-" + f.Short
		}
		out = append(out, fs)
	}
	return out
}

// CommandSchemaOf is one command's description.
func (p *Program) CommandSchemaOf(c *Command) CommandSchema {
	section := ""
	for _, s := range p.Sections {
		for _, sc := range s.Commands {
			if sc == c {
				section = s.Title
			}
		}
	}
	args := []ArgSchema{}
	for _, a := range c.Args {
		args = append(args, ArgSchema{Name: a.Name, Required: !a.Optional, Variadic: a.Variadic})
	}
	var rest *ArgSchema
	if c.Rest != "" {
		rest = &ArgSchema{Name: c.Rest, Required: !c.RestOptional}
	}
	var aliases []string
	for _, alias := range sortedKeys(p.Aliases) {
		if _, deprecated := p.Deprecated[alias]; p.Aliases[alias] == c.Name && !deprecated {
			aliases = append(aliases, alias)
		}
	}
	examples := c.Examples
	if examples == nil {
		examples = []Example{}
	}
	return CommandSchema{Name: c.Name, Section: section, Summary: c.Summary, Usage: p.Name + " " + p.synopsis(c) + " [flags]",
		Args: args, Rest: rest, Flags: flagsSchema(c.Flags), Details: c.Details, Examples: examples, Aliases: aliases}
}

// SchemaOf is the whole program's description.
func (p *Program) SchemaOf() Schema {
	codes := map[string]string{}
	for code, meaning := range p.ExitCodes {
		codes[fmt.Sprint(code)] = meaning
	}
	var commands []CommandSchema
	for _, c := range visible(p.Commands()) {
		commands = append(commands, p.CommandSchemaOf(c))
	}
	return Schema{SchemaVersion: 1, Program: p.Name, Version: p.Version, ExitCodes: codes,
		Errors:      `With --json a failure is the last line on stderr, as JSON: {"error": {"code", "message", "hint"?, "exitCode", …}}.`,
		GlobalFlags: flagsSchema(p.GlobalFlags), Groups: p.Groups, Commands: commands}
}

// HelpCommand is `help [command…]`, and help --json.
func HelpCommand(p *Program) *Command {
	return &Command{
		Name:    "help",
		Summary: "Every command, or one command's flags and examples",
		Args:    []Arg{{Name: "command", Optional: true, Variadic: true}},
		Details: "With --json it prints every command, its arguments, flags and examples, and the exit codes, as JSON\n" +
			"(or one command's, given its name): for an agent or a tool, with no sign-in and no network.",
		Run: func(c *Context) error {
			if len(c.Args) == 0 {
				if c.JSON {
					c.Out(IndentJSON(nil, p.SchemaOf()))
				} else {
					c.Out(p.mainHelp(c.Style))
				}
				return nil
			}
			r := p.resolve(c.Args)
			switch {
			case r.kind == "command" && c.JSON:
				c.Out(IndentJSON(nil, p.CommandSchemaOf(r.command)))
			case r.kind == "command":
				c.Out(p.commandHelp(r.command, c.Style))
			case r.kind == "group" && r.unknown == "" && !c.JSON:
				c.Out(p.groupHelp(r.group, c.Style))
			case r.kind == "moved" && !c.JSON:
				c.Out(r.word + " is for operators now: " + r.moved)
			default:
				return UsageHint(`there is no command "`+strings.Join(c.Args, " ")+`"`, p.helpHint())
			}
			return nil
		},
	}
}

// VersionCommand is `version`, and version --json.
func VersionCommand(p *Program) *Command {
	return &Command{
		Name:    "version",
		Summary: "The version (also --version)",
		Run: func(c *Context) error {
			c.Emit(nil, map[string]string{"version": p.Version}, func() string { return p.Version })
			return nil
		},
	}
}
