package kantel

// kantel ssh to an isolate, which has no SSH: a pseudo-shell over the commands API. packages/cli/src/shell.ts and
// isolateShell in packages/cli/src/commands.ts are the TypeScript CLI's copy; keep them alike.
//
// An isolate keeps no shell between commands, so each line is one command. To carry cd and export over to the next
// line, the line is followed by a trailer: a marker that can't be in the output by chance, the line's exit status, pwd
// and export -p. The next line goes to that directory first, with the exported variables that differ from the
// sandbox's own set again.

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// shellLimitSeconds is how long one line of the pseudo-shell may run: an isolate's longest. Ctrl-C stops it sooner.
const shellLimitSeconds = 600

// shellHelp is what help prints at the pseudo-shell's prompt.
const shellHelp = "Each line runs as one command in the sandbox, in the directory the last one left, with the variables it exported.\n" +
	"Built-in commands:\n" +
	"  help      This help\n" +
	"  upgrade   Upgrade this isolate to a microVM now, then switch to SSH on it\n" +
	"  exit      Leave (or Ctrl-D)\n" +
	"Ctrl-C stops the command that is running."

var (
	// shellOwn are the exported variables the shell sets itself, never carried over.
	shellOwn  = map[string]bool{"PWD": true, "OLDPWD": true, "SHLVL": true, "_": true}
	shellName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	// trailerHead is the trailer's exit status and directory, after the marker.
	trailerHead = regexp.MustCompile(`^(\d+)\n([^\n]*)\n`)
	exitLine    = regexp.MustCompile(`^exit(?:\s+(\d+))?$`)
	yes         = regexp.MustCompile(`(?i)^y(es)?$`)
)

// shellMarker is a marker for one session's trailers: __kantel_ and random hex, which a command won't print by chance.
func shellMarker() string {
	random := make([]byte, 8)
	_, _ = rand.Read(random)
	return "__kantel_" + hex.EncodeToString(random) + "__"
}

// shellState is what the session carries from line to line.
type shellState struct {
	// cwd is the directory the next line runs in; "" before the first report, for the sandbox's default.
	cwd string
	// baseline is the sandbox's own exported variables, from the first report: what a variable is compared with.
	baseline map[string]string
	// vars are the exported variables set or changed in the session.
	vars map[string]string
	// unset are the sandbox's own variables unset in the session.
	unset map[string]bool
}

func singleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// shellScript is the command a line runs as: the session's directory and variables set first (a directory gone since
// is said, and the line runs in the sandbox's default), then the line on its own line, then the trailer, ending with
// the line's own exit status. A line that ends the shell itself (exit 3, a syntax error) has no trailer, and the
// session keeps what it had.
func shellScript(line, marker string, state *shellState) string {
	var parts []string
	if state.cwd != "" {
		parts = append(parts, "cd "+singleQuote(state.cwd))
	}
	for _, name := range sortedKeys(state.unset) {
		parts = append(parts, "unset "+name)
	}
	for _, name := range sortedKeys(state.vars) {
		parts = append(parts, "export "+name+"="+singleQuote(state.vars[name]))
	}
	trailer := `__kantel_status=$?; printf '%s%s\n' '` + marker + `' "$__kantel_status"; pwd; export -p; exit "$__kantel_status"`
	return strings.Join(append(parts, line, trailer), "\n")
}

// shownLength is how much of stdout is the command's own output and can be shown: up to the marker, or short of its
// first part.
func shownLength(stdout, marker string) int {
	if at := strings.Index(stdout, marker); at >= 0 {
		return at
	}
	// Hold back an end that may be the start of the marker, until the rest comes.
	for keep := min(len(marker)-1, len(stdout)); keep > 0; keep-- {
		if strings.HasSuffix(stdout, marker[:keep]) {
			return len(stdout) - keep
		}
	}
	return len(stdout)
}

// trailer is what a line's trailer said: its exit status, the directory and the exported variables (nil if
// unreadable).
type trailer struct {
	status  int
	cwd     string
	exports map[string]string
}

// readTrailer is the trailer after the marker in stdout, or nil when there is none (the line ended the shell, or its
// output was cut).
func readTrailer(stdout, marker string) *trailer {
	at := strings.Index(stdout, marker)
	if at < 0 {
		return nil
	}
	rest := stdout[at+len(marker):]
	m := trailerHead.FindStringSubmatch(rest)
	if m == nil || !strings.HasPrefix(m[2], "/") {
		return nil
	}
	status, _ := strconv.Atoi(m[1])
	return &trailer{status: status, cwd: m[2], exports: parseExports(rest[len(m[0]):])}
}

// parseExports reads export -p's lines, declare -x NAME="value", declare -x NAME=$'value' or declare -x NAME; nil when
// a line isn't one of those, so a shell that prints them otherwise only loses its variables, not its directory.
func parseExports(text string) map[string]string {
	vars := map[string]string{}
	i := 0
	for i < len(text) {
		if !strings.HasPrefix(text[i:], "declare -x ") {
			return nil
		}
		i += len("declare -x ")
		j := i
		for j < len(text) && (text[j] == '_' || text[j] >= 'A' && text[j] <= 'Z' || text[j] >= 'a' && text[j] <= 'z' ||
			j > i && text[j] >= '0' && text[j] <= '9') {
			j++
		}
		if j == i {
			return nil
		}
		name := text[i:j]
		i = j
		value := ""
		if i < len(text) && text[i] == '=' {
			i++
			var ok bool
			switch {
			case strings.HasPrefix(text[i:], "$'"):
				value, i, ok = ansiC(text, i+2)
			case i < len(text) && text[i] == '"':
				value, i, ok = doubleQuoted(text, i+1)
			}
			if !ok {
				return nil
			}
		}
		if i >= len(text) || text[i] != '\n' {
			return nil
		}
		i++
		vars[name] = value
	}
	return vars
}

// doubleQuoted is a "…" value from from (after the quote): its text and where it ends.
func doubleQuoted(text string, from int) (string, int, bool) {
	var out strings.Builder
	for i := from; i < len(text); i++ {
		ch := text[i]
		switch {
		case ch == '"':
			return out.String(), i + 1, true
		case ch == '\\' && i+1 < len(text) && strings.IndexByte("\\\"$`\n", text[i+1]) >= 0:
			i++
			out.WriteByte(text[i])
		default:
			out.WriteByte(ch)
		}
	}
	return "", 0, false
}

var ansiEscapes = map[byte]string{
	'a': "\a", 'b': "\b", 'e': "\x1b", 'E': "\x1b", 'f': "\f", 'n': "\n", 'r': "\r", 't': "\t", 'v': "\v",
	'\\': "\\", '\'': "'", '"': "\"", '?': "?",
}

// ansiC is a $'…' value from from (after the quote): its text and where it ends.
func ansiC(text string, from int) (string, int, bool) {
	var out strings.Builder
	isHex := func(b byte) bool { return b >= '0' && b <= '9' || b >= 'a' && b <= 'f' || b >= 'A' && b <= 'F' }
	isOctal := func(b byte) bool { return b >= '0' && b <= '7' }
	for i := from; i < len(text); i++ {
		ch := text[i]
		if ch == '\'' {
			return out.String(), i + 1, true
		}
		if ch != '\\' {
			out.WriteByte(ch)
			continue
		}
		i++
		if i >= len(text) {
			return "", 0, false
		}
		next := text[i]
		if simple, ok := ansiEscapes[next]; ok {
			out.WriteString(simple)
			continue
		}
		switch {
		case next == 'x' && i+1 < len(text) && isHex(text[i+1]):
			j := i + 1
			for j < len(text) && j < i+3 && isHex(text[j]) {
				j++
			}
			n, _ := strconv.ParseUint(text[i+1:j], 16, 8)
			out.WriteRune(rune(n))
			i = j - 1
		case isOctal(next):
			j := i
			for j < len(text) && j < i+3 && isOctal(text[j]) {
				j++
			}
			n, _ := strconv.ParseUint(text[i:j], 8, 16)
			out.WriteRune(rune(n))
			i = j - 1
		default:
			out.WriteByte('\\')
			out.WriteByte(next)
		}
	}
	return "", 0, false
}

// applyTrailer takes in a line's trailer: the directory, and the exported variables against the sandbox's own (the
// first report is taken as those).
func applyTrailer(state *shellState, t *trailer) {
	state.cwd = t.cwd
	if t.exports == nil {
		return
	}
	for name := range shellOwn {
		delete(t.exports, name)
	}
	if state.baseline == nil {
		state.baseline = t.exports
		return
	}
	state.vars, state.unset = map[string]string{}, map[string]bool{}
	for name, value := range t.exports {
		if old, ok := state.baseline[name]; shellName.MatchString(name) && (!ok || old != value) {
			state.vars[name] = value
		}
	}
	for name := range state.baseline {
		if _, ok := t.exports[name]; !ok && shellName.MatchString(name) {
			state.unset[name] = true
		}
	}
}

// microvmPath is where an isolate's directory is in the microVM it became: /workspace's files are in
// /home/user/workspace.
func microvmPath(cwd string) string {
	switch {
	case cwd == "":
		return "/home/user/workspace"
	case cwd == "/workspace" || strings.HasPrefix(cwd, "/workspace/"):
		return "/home/user" + cwd
	}
	return cwd
}

// loginShellIn is the remote command that starts a login shell in dir over SSH.
func loginShellIn(dir string) string {
	return "cd " + singleQuote(dir) + ` 2>/dev/null; exec "${SHELL:-/bin/bash}" -l`
}

// rerunNote says a sandbox upgraded itself (autoUpgrade) and ran a command again.
func rerunNote(command *api.Command) string {
	what := ""
	if command.NeedsMicrovm != nil {
		what = " (" + command.NeedsMicrovm.Command + ")"
	}
	return "This needed a microVM" + what + ": the sandbox has been upgraded, and the command ran again there."
}

// shellRun is what one line came to: its exit code, the command it ended as, and whether the sandbox upgraded itself
// to run it again.
type shellRun struct {
	code    int
	command *api.Command
	rerun   bool
}

// isolateShell is kantel ssh to an isolate. With a command, it runs as kantel exec runs it. Without one, a pseudo-shell
// over the commands API: each line is a command, run in the directory and with the exported variables the last one
// left. From a terminal it has a prompt; from a pipe it runs the lines in order and exits with the last one's status.
// When a command needs a microVM it upgrades (by itself with autoUpgrade, else when asked), runs the command again,
// and at a terminal switches to SSH on the microVM, in the same directory.
func isolateShell(c *cli.Context, client *api.Client, sandbox *api.Sandbox, remote []string) error {
	sandboxID := sandbox.ID
	if len(remote) > 0 {
		// One command, as exec runs it, with its limit.
		limit := int64(execDefaultSeconds)
		started, err := client.RunCommand(c.Ctx, sandboxID, api.RunCommandBody{
			Command: CommandLine(remote), TimeoutMs: api.Ptr(limit * 1000), Detached: api.Ptr(true),
		})
		if err != nil {
			return err
		}
		return follow(c, client, sandboxID, started.ID, followOptions{first: started, limitSeconds: &limit,
			onRerun: func(command *api.Command) { c.Note(rerunNote(command)) }})
	}
	if sandbox.State != api.SandboxStateRunning && sandbox.State != api.SandboxStateStarting {
		resume, then := "kantel resume "+sandboxID, "kantel ssh "+sandboxID
		hint := ""
		switch sandbox.State {
		case api.SandboxStateStopping:
			hint = " Once it has stopped, resume it with " + resume + ", then run " + then + " again."
		case api.SandboxStateStopped, api.SandboxStatePaused, api.SandboxStateError:
			hint = " Resume it with " + resume + ", then run " + then + " again."
		}
		c.Note("kantel: " + sandbox.Name + " (" + sandboxID + ") is " + string(sandbox.State) + "." + hint)
		return cli.ExitCode(cli.ExitFailed)
	}
	s := &shellSession{c: c, client: client, sandbox: sandbox, interactive: c.IO.StdinTTY, marker: shellMarker(),
		state: &shellState{vars: map[string]string{}, unset: map[string]bool{}}, in: bufio.NewReader(c.IO.Stdin)}
	return exitWith(s.run())
}

// shellSession is one pseudo-shell.
type shellSession struct {
	c           *cli.Context
	client      *api.Client
	sandbox     *api.Sandbox
	interactive bool
	marker      string
	state       *shellState
	in          *bufio.Reader
	status      int
	microvm     bool

	// mu guards what a Ctrl-C acts on: the running command, an upgrade under way, or the prompt shown.
	mu        sync.Mutex
	running   string
	upgrading bool
	prompt    string
}

// report says what went wrong, as kantel does when a command fails, with how to resume a sandbox that stopped.
func (s *shellSession) report(err error) {
	fmt.Fprint(s.c.IO.Stderr, cli.FailureText(s.c.Program.Name, cli.FailureOf(err, s.c.Program.Hint), false, "", s.c.ErrStyle))
}

// read shows prompt (at a terminal) and answers the next line; false at the end of the input (Ctrl-D).
func (s *shellSession) read(prompt string) (string, bool) {
	if s.interactive {
		s.mu.Lock()
		s.prompt = prompt
		s.mu.Unlock()
		fmt.Fprint(s.c.IO.Stderr, prompt)
		defer func() {
			s.mu.Lock()
			s.prompt = ""
			s.mu.Unlock()
		}()
	}
	line, err := s.in.ReadString('\n')
	if err != nil && (line == "" || !errors.Is(err, io.EOF)) {
		return "", false
	}
	return strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"), true
}

// interrupt is a Ctrl-C at a terminal: it stops the running command, not this.
func (s *shellSession) interrupt() {
	s.mu.Lock()
	running, upgrading, prompt := s.running, s.upgrading, s.prompt
	s.mu.Unlock()
	switch {
	case upgrading:
		s.c.Note("kantel: the upgrade carries on; it can't be stopped part way")
	case running != "":
		if _, err := s.client.KillCommand(s.c.Ctx, s.sandbox.ID, running); err != nil {
			s.report(err)
		}
	case prompt != "":
		// The terminal dropped the line typed so far, as a shell does: a fresh prompt.
		fmt.Fprint(s.c.IO.Stderr, "\n"+prompt)
	}
}

func (s *shellSession) setRunning(id string) {
	s.mu.Lock()
	s.running = id
	s.mu.Unlock()
}

// runLine runs a line through the commands API and follows it, taking in its trailer.
func (s *shellSession) runLine(line string) shellRun {
	var final *api.Command
	rerun := false
	defer s.setRunning("")
	limit := int64(shellLimitSeconds)
	started, err := s.client.RunCommand(s.c.Ctx, s.sandbox.ID, api.RunCommandBody{
		Command: shellScript(line, s.marker, s.state), TimeoutMs: api.Ptr(limit * 1000), Detached: api.Ptr(true),
	})
	if err != nil {
		// Said, with how to resume a sandbox that stopped; the session goes on.
		s.report(err)
		return shellRun{code: 1}
	}
	s.setRunning(started.ID)
	err = follow(s.c, s.client, s.sandbox.ID, started.ID, followOptions{
		first: started, limitSeconds: &limit, marker: s.marker, quietNeedsMicrovm: s.interactive,
		onRerun: func(command *api.Command) {
			rerun = true
			s.setRunning(*command.RerunAs)
			s.c.Note(rerunNote(command))
		},
		onEnd: func(command *api.Command) { final = command },
	})
	code := 0
	var exit cli.ExitCode
	switch {
	case errors.As(err, &exit):
		code = int(exit)
	case err != nil:
		s.report(err)
		return shellRun{code: 1, rerun: rerun}
	}
	if final != nil {
		if t := readTrailer(final.Stdout, s.marker); t != nil {
			applyTrailer(s.state, t)
		}
	}
	return shellRun{code: code, command: final, rerun: rerun}
}

// upgrade upgrades the sandbox to a microVM and says how long it took; false when it couldn't.
func (s *shellSession) upgrade() bool {
	s.c.Note("Upgrading " + s.sandbox.ID + " to a microVM…")
	from := time.Now()
	s.mu.Lock()
	s.upgrading = true
	s.mu.Unlock()
	upgraded, err := s.client.UpgradeSandbox(s.c.Ctx, s.sandbox.ID, api.UpgradeSandboxBody{Wait: api.Ptr(true)})
	s.mu.Lock()
	s.upgrading = false
	s.mu.Unlock()
	if err != nil {
		s.report(err)
		return false
	}
	if upgraded.State != api.SandboxStateRunning {
		s.c.Note("kantel: the upgrade left " + s.sandbox.ID + " " + string(upgraded.State))
		return false
	}
	s.microvm = true
	s.c.Note("Upgraded to a microVM in " + cli.Duration(time.Since(from).Seconds()) +
		". Its files are in /home/user/workspace, and /workspace links there.")
	return true
}

// switchToSSH ends the session in SSH on the microVM, in the directory the last line left; its exit code.
func (s *shellSession) switchToSSH() int {
	dir := microvmPath(s.state.cwd)
	s.c.Note("Switching to SSH on the microVM, in " + dir + ".")
	access, err := openSSHAccess(s.c, s.client, s.sandbox.ID)
	if err == nil {
		err = connectSSH(s.c, s.sandbox.ID, access, []string{loginShellIn(dir)}, sshOptions{tty: true})
	}
	var exit cli.ExitCode
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit):
		return int(exit)
	}
	s.report(err)
	s.c.Note("kantel ssh " + s.sandbox.ID + " connects to it.")
	return 1
}

// run is the session: the banner, then line after line until the end of the input or exit; its exit code.
func (s *shellSession) run() int {
	if s.interactive {
		interrupts := make(chan os.Signal, 1)
		signal.Notify(interrupts, os.Interrupt)
		done := make(chan struct{})
		defer func() {
			signal.Stop(interrupts)
			close(done)
		}()
		go func() {
			for {
				select {
				case <-interrupts:
					s.interrupt()
				case <-done:
					return
				}
			}
		}()
		autoUpgrade := "Auto-upgrade is off: when a command needs a microVM you're asked whether to upgrade, and upgrade does it now."
		if s.sandbox.AutoUpgrade != nil && *s.sandbox.AutoUpgrade {
			autoUpgrade = "Auto-upgrade is on: a command that needs a microVM (git, npm, a build) upgrades the sandbox and runs again there, and you're switched to SSH on it."
		}
		s.c.Note(s.sandbox.Name + " (" + s.sandbox.ID + ") is an isolate, which has no SSH: this is a pseudo-shell over Kantel's commands API.\n" +
			"It isn't a terminal: each line runs as one command, and full-screen programs such as vim or top don't work.\n" +
			"node and python work.\n" + autoUpgrade + "\n" +
			"Type help for the built-in commands, and exit or Ctrl-D to leave.")
	}
	// Where the shell starts, and the sandbox's own variables, for the next lines to compare with.
	s.runLine(":")
	for {
		cwd := s.state.cwd
		if cwd == "" {
			cwd = "~"
		}
		prompt := "user@" + s.sandbox.Name + ":" + cwd + "$ "
		if s.status != 0 {
			prompt = fmt.Sprintf("[%d] %s", s.status, prompt)
		}
		line, ok := s.read(prompt)
		if !ok {
			if s.interactive {
				fmt.Fprintln(s.c.IO.Stderr)
			}
			return s.status
		}
		word := strings.TrimSpace(line)
		if word == "" {
			continue
		}
		if m := exitLine.FindStringSubmatch(word); m != nil {
			if m[1] == "" {
				return s.status
			}
			n, _ := strconv.Atoi(m[1])
			return n & 255
		}
		switch word {
		case "help":
			s.c.Note(shellHelp)
			s.status = 0
			continue
		case "upgrade":
			switch {
			case s.microvm:
				s.c.Note("kantel: " + s.sandbox.ID + " is a microVM already")
				s.status = 0
			case !s.upgrade():
				s.status = 1
			case s.interactive:
				return s.switchToSSH()
			default:
				s.status = 0
			}
			continue
		}
		ran := s.runLine(line)
		s.status = ran.code
		if ran.rerun {
			s.microvm = true
			if s.interactive {
				return s.switchToSSH()
			}
			continue
		}
		if ran.command == nil || ran.command.NeedsMicrovm == nil || !s.interactive || s.microvm {
			continue
		}
		reason := strings.TrimSuffix(ran.command.NeedsMicrovm.Reason, ".")
		answer, ok := s.read(reason + ". Upgrade this sandbox to a microVM now? [y/N] ")
		if !ok {
			return s.status
		}
		if !yes.MatchString(strings.TrimSpace(answer)) {
			s.c.Note("Not upgraded. Type upgrade, or run kantel upgrade " + s.sandbox.ID + ", when you want it.")
			continue
		}
		if !s.upgrade() {
			continue
		}
		s.status = s.runLine(line).code
		return s.switchToSSH()
	}
}
