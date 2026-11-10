package cli

import (
	"fmt"
	"sort"
	"strings"
)

// Shell completion: each shell's script is a thin one that asks the program itself,
// `<program> __complete -- <words before the cursor…> <the word at it>`, which answers one candidate a line as
// `value<TAB>description` from the same table as its help. With none the shell offers files, as for a local path.

// Candidate is what may come next: what to type, and what it is.
type Candidate struct{ Value, Description string }

// Shells are the shells completion scripts are made for.
var Shells = []string{"bash", "zsh", "fish"}

// CandidateLines is the candidates as __complete prints them, those that begin with current only.
func CandidateLines(candidates []Candidate, current string) string {
	seen := map[string]bool{}
	var b strings.Builder
	for _, c := range candidates {
		if !strings.HasPrefix(c.Value, current) || seen[c.Value] {
			continue
		}
		seen[c.Value] = true
		b.WriteString(c.Value + "\t" + strings.Join(strings.Fields(c.Description), " ") + "\n")
	}
	return b.String()
}

// positionalCount is how many arguments argv gives a command so far (not flags, nor their values), or -1 after --.
func positionalCount(argv []string, flags []Flag) int {
	count := 0
	for i := 0; i < len(argv); i++ {
		t := argv[i]
		switch {
		case t == "--":
			return -1
		case strings.HasPrefix(t, "--"):
			if name, _, has := strings.Cut(t[2:], "="); !has {
				if f := findFlag(flags, name); f != nil && f.Type == String {
					i++
				}
			}
		case len(t) > 1 && t[0] == '-':
			for _, f := range flags {
				if f.Short == t[1:] && f.Type == String {
					i++
				}
			}
		default:
			count++
		}
	}
	return count
}

// GlobalValues are the values argv gives the flags every command takes (`--url x`, `--url=x`), before any --.
func (p *Program) GlobalValues(argv []string) *Parsed {
	parsed := &Parsed{strings: map[string][]string{}, bools: map[string]bool{}, Explicit: map[string]bool{}}
	for i := 0; i < len(argv); i++ {
		t := argv[i]
		if t == "--" {
			break
		}
		if !strings.HasPrefix(t, "--") {
			continue
		}
		name, value, has := strings.Cut(t[2:], "=")
		f := p.flag(name)
		if f == nil || f.Type != String {
			continue
		}
		if !has {
			if i+1 >= len(argv) {
				break
			}
			i++
			value = argv[i]
		}
		parsed.strings[name] = []string{value}
	}
	return parsed
}

func (p *Program) completions(c *Context, words []string, current string) []Candidate {
	var cmd *Command
	r := resolution{kind: "unknown"}
	if len(words) > 0 {
		r = p.resolve(words)
		cmd = r.command
	}
	flags := append([]Flag{}, p.GlobalFlags...)
	if cmd != nil {
		flags = append(flags, cmd.Flags...)
	}
	if strings.HasPrefix(current, "-") {
		var out []Candidate
		for _, f := range flags {
			if !f.Hidden {
				out = append(out, Candidate{"--" + f.Name, f.Description})
			}
		}
		return out
	}
	if n := len(words); n > 0 && strings.HasPrefix(words[n-1], "--") && !strings.Contains(words[n-1], "=") {
		if f := findFlag(flags, words[n-1][2:]); f != nil && f.Type == String {
			var out []Candidate
			for _, v := range f.Choices {
				out = append(out, Candidate{Value: v})
			}
			return out
		}
	}
	subcommandsOf := func(prefix string) []Candidate {
		var out []Candidate
		for _, other := range p.Commands() {
			if rest, ok := strings.CutPrefix(other.Name, prefix+" "); ok && !other.Hidden {
				out = append(out, Candidate{strings.Fields(rest)[0], other.Summary})
			}
		}
		return out
	}
	switch r.kind {
	case "unknown":
		if r.word != "" {
			return nil
		}
		var out []Candidate
		for _, other := range visible(p.Commands()) {
			if !strings.Contains(other.Name, " ") {
				out = append(out, Candidate{other.Name, other.Summary})
			}
		}
		for _, g := range p.Groups {
			if g.Name != p.SandboxGroup {
				out = append(out, Candidate{g.Name, g.Summary})
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Value < out[j].Value })
		return out
	case "group":
		if r.unknown == "" {
			return subcommandsOf(r.group)
		}
		return nil
	case "moved":
		return nil
	}
	count := positionalCount(r.argv, flags)
	if count < 0 {
		return nil
	}
	var out []Candidate
	if count == 0 {
		out = subcommandsOf(cmd.Name)
	}
	if count < len(cmd.Args) && p.Complete != nil {
		c.Parsed = p.GlobalValues(words)
		out = append(out, p.Complete(c, cmd.Args[count])...)
	}
	return out
}

// CompletionScript hooks program's completion into shell, for its startup file or its completion directory.
func CompletionScript(program, shell string) string {
	fn := "_" + strings.ReplaceAll(program, "-", "_")
	switch shell {
	case "bash":
		return strings.Join([]string{
			fmt.Sprintf("# %s completion for bash. Load it with: source <(%s completion bash)", program, program),
			fn + "() {",
			"\tlocal cur=\"${COMP_WORDS[COMP_CWORD]}\"",
			"\tlocal IFS=$'\\n'",
			fmt.Sprintf("\tCOMPREPLY=($(%s __complete -- \"${COMP_WORDS[@]:1:COMP_CWORD-1}\" \"$cur\" 2>/dev/null | cut -f1))", program),
			"}",
			fmt.Sprintf("complete -o default -F %s %s", fn, program),
			"",
		}, "\n")
	case "zsh":
		return strings.Join([]string{
			"#compdef " + program,
			fmt.Sprintf("# %s completion for zsh. Load it with: source <(%s completion zsh)", program, program),
			fn + "() {",
			"\tlocal -a lines items",
			"\tlocal line",
			fmt.Sprintf("\tlines=(\"${(@f)$(%s __complete -- \"${(@)words[2,CURRENT-1]}\" \"${words[CURRENT]}\" 2>/dev/null)}\")", program),
			"\tfor line in \"${lines[@]}\"; do",
			"\t\t[[ -z \"$line\" ]] && continue",
			"\t\titems+=(\"${${line%%$'\\t'*}//:/\\\\:}:${line#*$'\\t'}\")",
			"\tdone",
			"\tif (( ${#items} )); then",
			fmt.Sprintf("\t\t_describe -t commands '%s' items", program),
			"\telse",
			"\t\t_files",
			"\tfi",
			"}",
			fmt.Sprintf("if (( $+functions[compdef] )); then compdef %s %s; fi", fn, program),
			"",
		}, "\n")
	case "fish":
		return strings.Join([]string{
			fmt.Sprintf("# %s completion for fish. Load it with: %s completion fish | source", program, program),
			fmt.Sprintf("# or keep it: %s completion fish > ~/.config/fish/completions/%s.fish", program, program),
			"function __" + fn + "_complete",
			"\tset -l words (commandline -opc)",
			fmt.Sprintf("\tset -l out (%s __complete -- $words[2..-1] (commandline -ct) 2>/dev/null)", program),
			"\tif test (count $out) -gt 0",
			"\t\tprintf '%s\\n' $out",
			"\telse",
			"\t\t__fish_complete_path (commandline -ct)",
			"\tend",
			"end",
			fmt.Sprintf("complete -c %s -f -a '(__%s_complete)'", program, fn),
			"",
		}, "\n")
	}
	return ""
}

// CompletionCommand is `completion <bash|zsh|fish>`.
func CompletionCommand(p *Program, what string) *Command {
	return &Command{
		Name:    "completion",
		Summary: "The script that completes " + what + " in bash, zsh or fish",
		Args:    []Arg{{Name: "shell"}},
		Details: strings.Join([]string{
			"Prints the script that completes " + what + " in your shell. Load it:",
			fmt.Sprintf("  bash: echo 'source <(%s completion bash)' >> ~/.bashrc", p.Name),
			fmt.Sprintf("  zsh:  echo 'source <(%s completion zsh)' >> ~/.zshrc", p.Name),
			fmt.Sprintf("  fish: %s completion fish > ~/.config/fish/completions/%s.fish", p.Name, p.Name),
		}, "\n"),
		Run: func(c *Context) error {
			for _, s := range Shells {
				if s == c.Arg(0) {
					fmt.Fprint(c.IO.Stdout, CompletionScript(p.Name, s))
					return nil
				}
			}
			return Usage(fmt.Sprintf(`the shell must be one of %s, not "%s"`, strings.Join(Shells, ", "), c.Arg(0)))
		},
	}
}
