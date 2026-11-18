package kantel

// The docs site's command reference, docs/site/src/content/docs/tools/cli-reference.md, made from kantel's command
// table (what `kantel help --json` prints), so it can't drift from the commands. `go run ./cmd/kantel-docs` writes it,
// and TestReferenceIsCurrent fails when the committed page is stale. The format is the TypeScript CLI's
// (packages/cli/scripts/reference.ts).

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// ReferencePage is the reference's path from the repository's root.
const ReferencePage = "docs/site/src/content/docs/tools/cli-reference.md"

// ReferencePath is the reference's path, from the repository that holds dir (or one of its parents).
func ReferencePath(dir string) (string, error) {
	for d := dir; ; d = filepath.Dir(d) {
		if info, err := os.Stat(filepath.Join(d, "docs", "site")); err == nil && info.IsDir() {
			return filepath.Join(d, ReferencePage), nil
		}
		if filepath.Dir(d) == d {
			return "", errors.New("no docs/site above " + dir)
		}
	}
}

// mdText is text for Markdown: <, > and & as entities, so <id> isn't read as HTML; | escaped in a table's cell.
func mdText(value string, cell bool) string {
	escaped := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(value)
	if cell {
		return strings.ReplaceAll(escaped, "|", `\|`)
	}
	return escaped
}

// paragraphs is a command's details, which help wraps at about 110 columns, as paragraphs: a line that starts indented
// is code.
func paragraphs(details string) string {
	var blocks, prose, code []string
	fence := func() {
		blocks = append(blocks, strings.Join(append(append([]string{"```sh"}, code...), "```"), "\n"))
		code = nil
	}
	say := func() {
		blocks = append(blocks, mdText(strings.Join(prose, " "), false))
		prose = nil
	}
	for _, line := range strings.Split(details, "\n") {
		switch {
		case strings.TrimSpace(line) == "":
			if len(prose) > 0 {
				say()
			}
			if len(code) > 0 {
				fence()
			}
		case unicode.IsSpace([]rune(line)[0]):
			if len(prose) > 0 {
				say()
			}
			code = append(code, strings.TrimSpace(line))
		default:
			if len(code) > 0 {
				fence()
			}
			prose = append(prose, strings.TrimSpace(line))
		}
	}
	if len(prose) > 0 {
		say()
	}
	if len(code) > 0 {
		fence()
	}
	return strings.Join(blocks, "\n\n")
}

func flagTable(flags []cli.FlagSchema) string {
	rows := []string{"| Flag | What it does |", "| --- | --- |"}
	for _, f := range flags {
		name := f.Name
		if f.Short != "" {
			name = f.Short + ", " + name
		}
		if f.Value != "" {
			name += " " + f.Value
		}
		repeat := ""
		if f.Repeatable && !strings.Contains(strings.ToLower(f.Description), "repeat") {
			repeat = " (repeatable)"
		}
		rows = append(rows, "| `"+strings.ReplaceAll(name, "|", `\|`)+"` | "+mdText(f.Description, true)+repeat+" |")
	}
	return strings.Join(rows, "\n")
}

// anchor is the id Starlight gives a command's heading: `kantel snapshot save` is kantel-snapshot-save.
func anchor(name string) string { return "kantel-" + strings.ReplaceAll(name, " ", "-") }

func commandSection(c cli.CommandSchema) string {
	parts := []string{"### kantel " + c.Name, "", mdText(c.Summary, false) + ".", "", "```sh", c.Usage, "```"}
	if len(c.Aliases) > 0 {
		var also []string
		for _, a := range c.Aliases {
			also = append(also, "`kantel "+a+"`")
		}
		parts = append(parts, "", "Also: "+strings.Join(also, ", ")+".")
	}
	if c.Details != "" {
		parts = append(parts, "", paragraphs(c.Details))
	}
	if len(c.Flags) > 0 {
		parts = append(parts, "", flagTable(c.Flags))
	}
	if len(c.Examples) > 0 {
		lines := []string{"", "```sh"}
		for i, e := range c.Examples {
			if i > 0 {
				lines = append(lines, "")
			}
			lines = append(lines, "# "+e.What, e.Line)
		}
		parts = append(parts, append(lines, "```")...)
	}
	return strings.Join(parts, "\n")
}

// Reference is the whole page, from schema (Program().SchemaOf()).
func Reference(schema cli.Schema) string {
	var sections []string
	seen := map[string]bool{}
	for _, c := range schema.Commands {
		if !seen[c.Section] {
			seen[c.Section] = true
			sections = append(sections, c.Section)
		}
	}
	var index []string
	for _, s := range sections {
		var names []string
		for _, c := range schema.Commands {
			if c.Section == s {
				names = append(names, "[`"+c.Name+"`](#"+anchor(c.Name)+")")
			}
		}
		index = append(index, "- **"+s+":** "+strings.Join(names, ", "))
	}
	codes := make([]string, 0, len(schema.ExitCodes))
	for code := range schema.ExitCodes {
		codes = append(codes, code)
	}
	sort.Slice(codes, func(i, j int) bool {
		a, _ := strconv.Atoi(codes[i])
		b, _ := strconv.Atoi(codes[j])
		return a < b
	})
	var exitCodes []string
	for _, code := range codes {
		exitCodes = append(exitCodes, "| "+code+" | "+mdText(schema.ExitCodes[code], true)+" |")
	}
	version := ""
	if schema.Version != "0.0.0" {
		version = schema.Version + " "
	}
	lines := []string{
		"---",
		"title: Command reference",
		"description: Every kantel command, with its arguments, flags and examples, generated from the CLI's own command table.",
		"sidebar:",
		"  badge:",
		"    text: Experimental",
		"    variant: caution",
		"---",
		"",
		"<!-- Generated by apps/cli/cmd/kantel-docs from the CLI's command table. Don't edit: run `go run ./cmd/kantel-docs` in apps/cli. -->",
		"",
		"Every command of `kantel` " + version + "as `kantel help <command>` shows it. " +
			"[Command line](/tools/cli/) explains signing in and how the commands fit together. " +
			"`kantel help --json` prints the same as JSON, for a script or a coding agent, and needs no sign-in.",
		"",
	}
	lines = append(lines, index...)
	lines = append(lines, "", "## Flags on every command", "", flagTable(schema.GlobalFlags), "",
		"## Exit codes", "", "| Code | Meaning |", "| --- | --- |")
	lines = append(lines, exitCodes...)
	lines = append(lines, "", mdText(schema.Errors, false), "")
	for _, s := range sections {
		lines = append(lines, "## "+s, "")
		for _, c := range schema.Commands {
			if c.Section == s {
				lines = append(lines, commandSection(c), "")
			}
		}
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n"
}
