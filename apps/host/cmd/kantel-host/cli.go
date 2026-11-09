package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

// The CLI's conventions, as Kantel's other CLIs (kantel, kantel-admin) have them: help on stdout with exit 0, a
// usage error as `kantel-host: <message>` and the command's usage line on stderr with exit 2, any other failure as
// `kantel-host: <message>` with exit 1. Flags are GNU-style in help (--name <value>); Go's flag package reads both
// --name and -name.

// Where the CLI writes: the process's own streams, swapped in tests.
var (
	stdout io.Writer = os.Stdout
	stderr io.Writer = os.Stderr
)

// command is one of kantel-host's commands, as help lists it.
type command struct {
	name    string // "sandboxes show"
	args    string // what follows the name in its usage line, before [flags]: "<id>"
	group   string
	summary string // sentence case, without a full stop
	details string
}

// The groups top-level help lists the commands in, in order.
var groups = []string{"Setting up", "Running", "Internal"}

var commands = []command{
	{name: "install", group: "Setting up", args: "--url <kantel> --token <kth_…>",
		summary: "Install kantel-host, register this machine with Kantel and start the service (as root)",
		details: "--dry-run prints every download, file, directory, unit, command and registration it would make, and\n" +
			"changes nothing. Run it again to update the settings or the images: it keeps the host's registration."},
	{name: "plan", group: "Setting up", args: "--url <kantel> --token <kth_…>",
		summary: "Print what install would do, with install's flags: always a dry run, whatever they say"},
	{name: "doctor", group: "Setting up",
		summary: "Check what this machine can run",
		details: "Exits 1 unless every required check passes. Run it as root, as the service runs."},
	{name: "uninstall", group: "Setting up",
		summary: "Stop and remove the service and its microVMs, keeping the files (as root)",
		details: "--purge also deletes the sandboxes, snapshots, images, settings and the binary. It can't be undone,\n" +
			"so it needs --yes as well. Uninstalling doesn't tell Kantel: revoke the host there too."},
	{name: "status", group: "Running",
		summary: "Show the service, its connection and its sandboxes",
		details: "Exits 0 when the service is active, 3 when it isn't (stopped, failed or not installed), and 1 when\n" +
			"status can't be read at all, such as a settings file only root can read."},
	{name: "sandboxes", group: "Running",
		summary: "List the sandboxes the service holds, from its control socket (as root)",
		details: "It only reads: stop or delete a sandbox through Kantel, with kantel stop or the console, which keep\n" +
			"its record."},
	{name: "sandboxes show", group: "Running", args: "<id>",
		summary: "Show one of the service's sandboxes in full (as root)"},
	{name: "logs", group: "Running",
		summary: "Show the service's log, from its systemd journal",
		details: "Runs journalctl -u kantel-host with --follow and --lines, so the unit's name needn't be known."},
	{name: "update", group: "Running",
		summary: "Update kantel-host now and restart the service (as root)",
		details: "The service also updates itself when Kantel asks it to. Its sandboxes keep running."},
	{name: "run", group: "Internal",
		summary: "Run the daemon itself (the kantel-host service runs this)"},
	{name: "bench", group: "Internal",
		summary: "Measure sandbox create, resume and fork on this machine",
		details: "It runs its own host from the settings file, without a control plane: stop the service first. The\n" +
			"results are JSON on stdout, and each measurement as it's made on stderr."},
	{name: "manifest", group: "Internal", args: "<dir>",
		summary: "Write <dir>/manifest.json for the images in <dir> (for releases)"},
	{name: "version",
		summary: "Print kantel-host's version"},
	{name: "help", args: "[<command>]",
		summary: "Show help for kantel-host or one of its commands"},
}

func findCommand(name string) (command, bool) {
	for _, c := range commands {
		if c.name == name {
			return c, true
		}
	}
	return command{}, false
}

func (c command) usageLine() string {
	line := "kantel-host " + c.name
	if c.args != "" {
		line += " " + c.args
	}
	return line + " [flags]"
}

// mainHelp is `kantel-host help`.
func mainHelp() string {
	width := 0
	for _, c := range commands {
		if c.group != "" {
			width = max(width, len(synopsis(c)))
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "kantel-host %s: runs Kantel sandboxes on this machine.\n\nUsage: kantel-host <command> [flags]\n", version)
	for _, g := range groups {
		fmt.Fprintf(&b, "\n%s:\n", g)
		for _, c := range commands {
			if c.group == g {
				fmt.Fprintf(&b, "  %-*s  %s\n", width, synopsis(c), c.summary)
			}
		}
	}
	b.WriteString("\nFlags:\n")
	b.WriteString(fieldLines([][2]string{
		{"-h, --help", "Show help: kantel-host help <command> shows a command's flags"},
		{"-V, --version", "Print the version (kantel-host version --json adds Go's version, the OS and the architecture)"},
	}))
	b.WriteString("\nSandboxes are stopped and deleted through Kantel, which keeps their record: kantel stop, or the console.\n")
	return b.String()
}

// synopsis is a command as the top-level help lists it: its name and its operands.
func synopsis(c command) string {
	if c.args == "" || strings.HasPrefix(c.args, "-") {
		return c.name
	}
	return c.name + " " + c.args
}

// fieldLines lays out rows of two columns, indented, as kantel's help does.
func fieldLines(rows [][2]string) string {
	width := 0
	for _, r := range rows {
		width = max(width, len(r[0]))
	}
	var b strings.Builder
	for _, r := range rows {
		fmt.Fprintf(&b, "  %-*s  %s\n", width, r[0], r[1])
	}
	return b.String()
}

// usageError is a command used wrongly: an unknown flag, a missing or extra operand, a bad value. It exits 2.
type usageError struct {
	cmd string // the command's name, for its usage line
	msg string
}

func (e *usageError) Error() string { return e.msg }

func usageErrorf(cmd, format string, args ...any) error {
	return &usageError{cmd: cmd, msg: fmt.Sprintf(format, args...)}
}

// exitCode is a command's own exit status, with nothing more to say (status's 3, journalctl's own exit).
type exitCode int

func (e exitCode) Error() string { return fmt.Sprintf("exit status %d", int(e)) }

// errHelpShown is a command's --help, printed: exit 0.
var errHelpShown = errors.New("help shown")

// cmdFlags is a command's flags, with help in kantel's format: Usage, the summary, the details, then Flags.
type cmdFlags struct {
	*flag.FlagSet
	cmd     command
	hidden  map[string]bool
	shorter map[string]string // long name: its one-letter alias
	out     bytes.Buffer
}

// newFlags is the named command's flags (the name must be in commands).
func newFlags(name string) *cmdFlags {
	cmd, ok := findCommand(name)
	if !ok {
		panic("kantel-host: no command " + name)
	}
	c := &cmdFlags{FlagSet: flag.NewFlagSet(name, flag.ContinueOnError), cmd: cmd, hidden: map[string]bool{}, shorter: map[string]string{}}
	// flag prints its error and calls Usage, into out: help is copied to stdout only for --help, and an error is
	// said in kantel-host's own words.
	c.SetOutput(&c.out)
	c.Usage = func() { c.printHelp(c.Output()) }
	return c
}

// hide leaves flags out of help: kept for older scripts, or aliases.
func (c *cmdFlags) hide(names ...string) {
	for _, n := range names {
		c.hidden[n] = true
	}
}

// alias makes -short another name for the flag --long, shown in help as "-short, --long".
func (c *cmdFlags) alias(short, long string) {
	c.Var(c.Lookup(long).Value, short, "")
	c.hidden[short] = true
	c.shorter[long] = short
}

// help is the command's help text.
func (c *cmdFlags) help() string {
	var b strings.Builder
	fmt.Fprintf(&b, "Usage: %s\n\n%s.\n", c.cmd.usageLine(), c.cmd.summary)
	if c.cmd.details != "" {
		fmt.Fprintf(&b, "\n%s\n", c.cmd.details)
	}
	var rows [][2]string
	c.VisitAll(func(f *flag.Flag) {
		if c.hidden[f.Name] {
			return
		}
		name, usage := flag.UnquoteUsage(f)
		if !strings.Contains(f.Usage, "`") && name != "" {
			name = f.Name // not Go's "string" or "int"
		}
		left := "--" + f.Name
		if s := c.shorter[f.Name]; s != "" {
			left = "-" + s + ", " + left
		}
		if name != "" {
			left += " <" + name + ">"
		}
		if !zeroDefault(f.DefValue) && !strings.Contains(usage, "(default") {
			usage += " (default " + f.DefValue + ")"
		}
		rows = append(rows, [2]string{left, usage})
	})
	rows = append(rows, [2]string{"-h, --help", "Show this help"})
	b.WriteString("\nFlags:\n")
	b.WriteString(fieldLines(rows))
	return b.String()
}

func (c *cmdFlags) printHelp(w io.Writer) { io.WriteString(w, c.help()) }

func zeroDefault(v string) bool {
	switch v {
	case "", "0", "false", "0s", "map[]", "[]":
		return true
	}
	return false
}

// parse reads the flags up to the first operand, as Go's flag does: --help prints help (errHelpShown), and a bad
// flag is a usageError.
func (c *cmdFlags) parse(args []string) error {
	c.out.Reset()
	err := c.Parse(args)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, flag.ErrHelp):
		io.WriteString(stdout, c.help())
		return errHelpShown
	}
	return &usageError{cmd: c.cmd.name, msg: flagMessage(err)}
}

// parseInterspersed reads flags wherever they are among the operands, so `sandboxes show <id> --json` works as
// well as `sandboxes show --json <id>`, and returns the operands. After "--", everything is an operand.
func (c *cmdFlags) parseInterspersed(args []string) ([]string, error) {
	var rest []string
	for {
		before := len(args)
		if err := c.parse(args); err != nil {
			return nil, err
		}
		if c.NArg() == 0 {
			return rest, nil
		}
		// flag drops a "--" that ends the flags: what follows is all operands.
		if consumed := before - c.NArg(); consumed > 0 && args[consumed-1] == "--" {
			return append(rest, c.Args()...), nil
		}
		rest = append(rest, c.Arg(0))
		args = c.Args()[1:]
	}
}

// noArgs is a usageError for a command that takes no operands but got some.
func (c *cmdFlags) noArgs() error {
	if c.NArg() == 0 {
		return nil
	}
	return usageErrorf(c.cmd.name, "%s takes no arguments, and got %q", c.cmd.name, c.Arg(0))
}

var flagValueRe = regexp.MustCompile(`for flag -([^:\s]+)`)

// flagMessage says Go's flag errors with GNU flags: "flag provided but not defined: -foo" is "there is no flag
// --foo" (and a one-letter flag keeps its one dash).
func flagMessage(err error) string {
	msg := err.Error()
	if name, ok := strings.CutPrefix(msg, "flag provided but not defined: -"); ok {
		return "there is no flag " + gnu(name)
	}
	if name, ok := strings.CutPrefix(msg, "flag needs an argument: -"); ok {
		return gnu(name) + " needs a value"
	}
	if strings.HasPrefix(msg, "bad flag syntax: ") {
		return msg
	}
	return flagValueRe.ReplaceAllStringFunc(msg, func(m string) string {
		return "for " + gnu(strings.TrimPrefix(m, "for flag -"))
	})
}

// gnu is a flag's name as it's written: -n, --lines.
func gnu(name string) string {
	name = strings.TrimLeft(name, "-")
	if len(name) == 1 {
		return "-" + name
	}
	return "--" + name
}

// exit is the process's exit status for a command's error, saying what's wrong on stderr.
func exit(err error) int {
	var usage *usageError
	var code exitCode
	switch {
	case err == nil, errors.Is(err, errHelpShown):
		return 0
	case errors.As(err, &code):
		return int(code)
	case errors.As(err, &usage):
		fmt.Fprintf(stderr, "kantel-host: %s\n", usage.msg)
		if cmd, ok := findCommand(usage.cmd); ok {
			fmt.Fprintf(stderr, "Usage: %s\n", cmd.usageLine())
		}
		return 2
	}
	fmt.Fprintln(stderr, "kantel-host:", err)
	return 1
}
