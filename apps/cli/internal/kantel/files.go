package kantel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

const (
	// followRetry is how long follow keeps asking again while Kantel can't be reached, from the start of the first
	// look that failed, before it gives up and says how to follow again.
	followRetry = 120 * time.Second
	// followLook is how long one look at a followed command may take before it counts as Kantel out of reach.
	followLook = 30 * time.Second
	// execDefaultSeconds is a plain exec's limit when --timeout gives none: the API's default. Kantel enforces it, as
	// it does any detached command's timeoutMs.
	execDefaultSeconds = 30
)

// exitCodeOf is the exit code kantel exits with for a command: its own, 124 when it timed out, 137 when killed.
func exitCodeOf(command *api.Command) int {
	switch {
	case command.State == api.CommandStateTimedOut:
		return 124
	case command.ExitCode != nil:
		return int(*command.ExitCode)
	case command.State == api.CommandStateKilled:
		return 137
	case command.State == api.CommandStateRunning:
		return 0
	}
	return 1
}

// exitWith ends a command with code.
func exitWith(code int) error {
	if code == 0 {
		return nil
	}
	return cli.ExitCode(code)
}

// printOutput puts a finished command's output on our stdout and stderr, and what became of it on stderr.
func printOutput(c *cli.Context, command *api.Command) {
	if command.Stdout != "" {
		fmt.Fprint(c.IO.Stdout, command.Stdout)
	}
	if command.Stderr != "" {
		fmt.Fprint(c.IO.Stderr, command.Stderr)
	}
	if command.Truncated {
		c.Note("kantel: the output was cut at 1 MiB")
	}
	if command.State == api.CommandStateKilled {
		c.Note("kantel: the command was killed")
	}
	noteIsolate(c, command, true)
}

// noteIsolate says what an isolate did to a command: stopped it for its time or memory, or found it needs a microVM,
// and (when upgradeHint) what to do about that.
func noteIsolate(c *cli.Context, command *api.Command, upgradeHint bool) {
	if command.Terminated != nil {
		c.Note("kantel: the isolate stopped it: too much " + string(*command.Terminated) + " time")
	}
	if upgradeHint && command.NeedsMicrovm != nil && command.RerunAs == nil {
		c.Note("kantel: " + command.NeedsMicrovm.Command + " needs a microVM. kantel upgrade " + command.SandboxID +
			" turns this isolate into one, its files and settings kept; then run it again")
	}
}

// showCommand is exec --status: the command as JSON, or its state and output so far.
func showCommand(c *cli.Context, raw json.RawMessage, command *api.Command) error {
	if c.JSON {
		c.Out(cli.IndentJSON(raw, command))
		return nil
	}
	code := ""
	if command.ExitCode != nil {
		code = fmt.Sprintf(" %d", *command.ExitCode)
	}
	c.Note(fmt.Sprintf("kantel: %s %s%s: %s", command.ID, command.State, code, command.Command))
	printOutput(c, command)
	return nil
}

func killed(c *cli.Context, raw json.RawMessage, command *api.Command) error {
	c.Emit(raw, command, func() string { return command.ID + " " + string(command.State) })
	return nil
}

// transient is why a failure to reach Kantel, or Kantel unable to answer for now, may be got past by asking again; ""
// for an answer that won't change.
func transient(err error) string {
	var apiErr *api.Error
	if errors.As(err, &apiErr) {
		if apiErr.Status >= 500 || apiErr.Status == 429 || apiErr.Code == "unavailable" {
			return "Kantel can't answer for now (" + apiErr.Message + ")"
		}
		return ""
	}
	var unreachable *api.UnreachableError
	if errors.As(err, &unreachable) {
		return unreachable.Error()
	}
	return ""
}

// followOptions say how follow follows a command.
type followOptions struct {
	// first is the command as its start answered, and raw that answer.
	first *api.Command
	raw   json.RawMessage
	// announce says at the start how to follow it again (exec --timeout 0).
	announce bool
	// limitSeconds is its limit, said when it timed out.
	limitSeconds *int64
	// marker: its stdout is shown up to this, and what follows held back (the pseudo-shell's trailer, shell.go).
	marker string
	// onRerun, when set, is told its sandbox upgraded itself and ran it again, and says so instead of follow.
	onRerun func(*api.Command)
	// quietNeedsMicrovm says nothing of a command that needed a microVM: the caller asks about it.
	quietNeedsMicrovm bool
	// onEnd is given the command it came to, once it ends.
	onEnd func(*api.Command)
}

// follow follows a command by its ID: prints what it has written since the last look, every second or so, until it
// ends, and answers its exit code. Kantel keeps a command's first 1 MiB of each stream, so that is all it can show.
// Kantel out of reach for a while (a gateway restarting, a network blip, this connection reset) is asked again; given
// up on, it says the command may still be running and how to follow it again.
func follow(c *cli.Context, client *api.Client, sandboxID, commandID string, o followOptions) error {
	again := "kantel attach " + sandboxID + " " + commandID
	raw := o.raw
	look := func() (*api.Command, error) {
		// An outage's time so far: from the start of its first failed look, each look's time and each wait's. (The
		// waits are counted too, as asked for, since a test's sleep returns at once.)
		var outageFrom time.Time
		var waited time.Duration
		backoff := time.Second
		for {
			lookFrom := time.Now()
			elapsed := func() time.Duration {
				from := lookFrom
				if !outageFrom.IsZero() {
					from = outageFrom
				}
				return max(time.Since(from), waited)
			}
			limit := followLook
			if !outageFrom.IsZero() {
				limit = min(followLook, followRetry-elapsed())
			}
			// At least a second: a look with less would end on its deadline before Kantel could answer, and say so
			// rather than why Kantel was out of reach.
			limit = max(limit, time.Second)
			ctx, cancel := context.WithTimeout(c.Ctx, limit)
			var answer json.RawMessage
			command, err := client.GetCommand(ctx, sandboxID, commandID, api.Raw(&answer))
			// This look's own deadline, whatever the error it ended with.
			deadline := ctx.Err() != nil
			cancel()
			if err == nil {
				raw = answer
				return command, nil
			}
			if c.Ctx.Err() != nil {
				return nil, err
			}
			why := transient(err)
			if deadline {
				why = fmt.Sprintf("Kantel didn't answer within %d s", int(math.Round(limit.Seconds())))
			}
			if why == "" {
				return nil, err
			}
			if outageFrom.IsZero() {
				outageFrom = lookFrom
				if !c.JSON {
					c.Note("kantel: " + why + "; trying again")
				}
			}
			left := followRetry - elapsed()
			if left <= 0 {
				return nil, cli.Fail(why + "; " + commandID + " may still be running: " + again)
			}
			pause := min(backoff, left)
			if err := sleep(c, pause); err != nil {
				return nil, err
			}
			waited += pause
			backoff = min(backoff*2, 10*time.Second)
		}
	}
	command := o.first
	if command == nil {
		var err error
		if command, err = look(); err != nil {
			return err
		}
	}
	if !c.JSON && o.announce {
		c.Note(fmt.Sprintf("kantel: started %s; Ctrl-C leaves it running, and %s follows it again", command.ID, again))
	}
	shownOut, shownErr := 0, 0
	// Soon after its start, so a short command's end comes quickly, then every second.
	wait := 100 * time.Millisecond
	for {
		if !c.JSON {
			end := len(command.Stdout)
			if o.marker != "" {
				end = shownLength(command.Stdout, o.marker)
			}
			if end > shownOut {
				fmt.Fprint(c.IO.Stdout, command.Stdout[shownOut:end])
			}
			if len(command.Stderr) > shownErr {
				fmt.Fprint(c.IO.Stderr, command.Stderr[shownErr:])
			}
			shownOut, shownErr = max(shownOut, end), len(command.Stderr)
		}
		if command.State != api.CommandStateRunning {
			break
		}
		if err := sleep(c, wait); err != nil {
			return err
		}
		wait = min(wait*2, time.Second)
		var err error
		if command, err = look(); err != nil {
			return err
		}
	}
	// Its isolate upgraded itself to a microVM (autoUpgrade) and ran it again there: that one is what it came to.
	if command.RerunAs != nil {
		if o.onRerun != nil {
			o.onRerun(command)
		} else if !c.JSON {
			what := ""
			if command.NeedsMicrovm != nil {
				what = " (" + command.NeedsMicrovm.Command + ")"
			}
			c.Note("kantel: it needed a microVM" + what + "; " + sandboxID + " is one now, and it runs again there as " + *command.RerunAs)
		}
		return follow(c, client, sandboxID, *command.RerunAs, followOptions{limitSeconds: o.limitSeconds,
			marker: o.marker, onRerun: o.onRerun, quietNeedsMicrovm: o.quietNeedsMicrovm, onEnd: o.onEnd})
	}
	if o.onEnd != nil {
		o.onEnd(command)
	}
	if c.JSON {
		c.Out(cli.IndentJSON(raw, command))
	} else {
		if command.Truncated {
			c.Note("kantel: the output was cut at 1 MiB")
		}
		switch command.State {
		case api.CommandStateTimedOut:
			after := ""
			if o.limitSeconds != nil {
				after = fmt.Sprintf(" after %d s", *o.limitSeconds)
			}
			c.Note("kantel: the command timed out" + after + " and was killed")
		case api.CommandStateKilled:
			c.Note("kantel: the command was killed")
		}
		noteIsolate(c, command, !o.quietNeedsMicrovm)
	}
	return exitWith(exitCodeOf(command))
}

// fileTable is a directory's listing.
func fileTable(c *cli.Context, list *api.FileList) string {
	if len(list.Items) == 0 {
		return list.Path + " is empty."
	}
	var rows [][]string
	for _, e := range list.Items {
		kind, size, modified, name := "file", "", "", e.Name
		switch e.Kind {
		case api.FileEntryKindDirectory:
			kind, name = "dir", e.Name+"/"
		case api.FileEntryKindSymlink:
			kind = "link"
		case api.FileEntryKindFile:
			size = cli.Bytes(float64(e.Size))
		}
		if e.ModifiedAt != nil {
			modified = cli.Ago(*e.ModifiedAt, now(c))
		}
		rows = append(rows, []string{kind, size, modified, name})
	}
	return cli.Table(c.Style, []string{"KIND", "SIZE", "MODIFIED", "NAME"}, rows)
}

func fileCount(n int) string {
	if n == 1 {
		return "1 file"
	}
	return fmt.Sprintf("%d files", n)
}

// noteSkipped names on stderr what push or sync left out, and how to send it.
func noteSkipped(c *cli.Context, left []skipped) {
	byDefault := false
	for _, s := range left {
		c.Note("kantel: left out " + s.Path + " (" + s.Why + ")")
		byDefault = byDefault || s.ByDefault
	}
	if byDefault && !c.JSON {
		c.Note("kantel: --no-default-excludes sends credentials, sign-ins and .env files too")
	}
}

// logPath names a copied file on stderr, unless --json.
func logPath(c *cli.Context) func(string) {
	return func(p string) {
		if !c.JSON {
			c.Note(p)
		}
	}
}

var commandArgs = []cli.Arg{{Name: "id"}, {Name: "command"}}

func commandsAndFiles() cli.Section {
	return cli.Section{Title: "Commands and files", Commands: []*cli.Command{
		execCommand(),
		{
			Name:    "attach",
			Summary: "Follow a detached command's output until it ends, and exit with its code",
			Args:    commandArgs,
			Details: "Ctrl-C stops following; the command carries on. Its output from the start is printed first.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				return follow(c, client, c.Arg(0), c.Arg(1), followOptions{})
			},
		},
		{
			Name:    "ps",
			Summary: "A sandbox's commands, newest first, running ones included",
			Args:    IDArg,
			Flags:   []cli.Flag{cursorFlag},
			Run: func(c *cli.Context) error {
				id := c.Arg(0)
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				page, err := client.ListCommands(c.Ctx, id, &api.ListCommandsQuery{Cursor: StrPtr(c, "cursor")}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, page, func() string {
					if len(page.Items) == 0 {
						return "No commands yet."
					}
					var rows [][]string
					for _, command := range page.Items {
						state := string(command.State)
						if command.ExitCode != nil {
							state = fmt.Sprintf("%s %d", command.State, *command.ExitCode)
						}
						took := ""
						if command.DurationMs != nil {
							took = cli.Duration(float64(*command.DurationMs) / 1000)
						}
						line := command.Command
						if utf8.RuneCountInString(line) > 60 {
							line = string([]rune(line)[:59]) + "…"
						}
						rows = append(rows, []string{command.ID, c.Style.State(state), cli.Ago(command.StartedAt, now(c)), took, line})
					}
					return cli.Table(c.Style, []string{"ID", "STATE", "STARTED", "TOOK", "COMMAND"}, rows) +
						More(page.NextCursor, "kantel ps "+id)
				})
				return nil
			},
		},
		{
			Name:    "kill",
			Summary: "Stop a running command, and everything it started",
			Args:    commandArgs,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				command, err := client.KillCommand(c.Ctx, c.Arg(0), c.Arg(1), api.Raw(&raw))
				if err != nil {
					return err
				}
				return killed(c, raw, command)
			},
		},
		{
			Name:    "files ls",
			Summary: "List a directory in a sandbox",
			Args:    []cli.Arg{{Name: "id"}, {Name: "path", Optional: true}},
			Flags:   []cli.Flag{cursorFlag},
			Run: func(c *cli.Context) error {
				id := c.Arg(0)
				client, err := Client(c)
				if err != nil {
					return err
				}
				query := &api.ListFilesQuery{Cursor: StrPtr(c, "cursor")}
				if p, ok := c.Optional(1); ok {
					query.Path = &p
				}
				var raw json.RawMessage
				list, err := client.ListFiles(c.Ctx, id, query, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, list, func() string {
					return fileTable(c, list) + More(list.NextCursor, "kantel files ls "+id+" "+list.Path)
				})
				return nil
			},
		},
		{
			Name:    "files cat",
			Summary: "Print a file from a sandbox",
			Args:    []cli.Arg{{Name: "id"}, {Name: "path"}},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				if c.JSON {
					p := c.Arg(1)
					var raw json.RawMessage
					file, err := client.ReadFile(c.Ctx, c.Arg(0), &api.ReadFileQuery{Path: &p}, api.Raw(&raw))
					if err != nil {
						return err
					}
					c.Out(cli.IndentJSON(raw, file))
					return nil
				}
				content, err := getBytes(c.Ctx, client, c.Arg(0), c.Arg(1))
				if err != nil {
					return err
				}
				_, err = c.IO.Stdout.Write(content)
				return err
			},
		},
		{
			Name:    "files put",
			Summary: "Copy a local file (up to 1 MiB) into a sandbox",
			Args:    []cli.Arg{{Name: "id"}, {Name: "local"}, {Name: "remote"}},
			Details: "A local path of - reads stdin. A binary file is sent as base64; an executable keeps its mode.",
			Run: func(c *cli.Context) error {
				local := c.Arg(1)
				p := resolvePath(c.IO.Cwd, local)
				var content []byte
				var err error
				if local == "-" {
					content, err = io.ReadAll(c.IO.Stdin)
				} else {
					content, err = os.ReadFile(p)
				}
				if err != nil {
					return err
				}
				if len(content) > maxFile {
					return cli.Fail(local + " is " + cli.Bytes(float64(len(content))) + ": copy files over 1 MiB with exec or ssh")
				}
				mode := ""
				if local != "-" {
					if mode, err = executableMode(p); err != nil {
						return err
					}
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				entry, err := client.WriteFile(c.Ctx, c.Arg(0), writeBody(c.Arg(2), content, mode), api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, entry, func() string {
					return "Wrote " + entry.Path + " (" + cli.Bytes(float64(entry.Size)) + ")."
				})
				return nil
			},
		},
		{
			Name:    "files get",
			Summary: "Copy a file out of a sandbox",
			Args:    []cli.Arg{{Name: "id"}, {Name: "remote"}, {Name: "local", Optional: true}},
			Details: "The local path defaults to the file's name here; - writes it to stdout.",
			Examples: []cli.Example{
				{What: "Print a file", Line: "kantel files get sbx_4kq9x2mt /home/user/app/out.log -"},
				{What: "Copy one here", Line: "kantel files get sbx_4kq9x2mt /home/user/app/report.json"},
			},
			Run: func(c *cli.Context) error {
				remote := c.Arg(1)
				local, hasLocal := c.Optional(2)
				client, err := Client(c)
				if err != nil {
					return err
				}
				filePath, content, err := getFile(c.Ctx, client, c.Arg(0), remote)
				if err != nil {
					return err
				}
				if local == "-" {
					_, err := c.IO.Stdout.Write(content)
					return err
				}
				name := filePath
				if name == "" {
					name = remote
				}
				name = baseName(name)
				if !hasLocal && name == "" {
					return cli.Usage("give a local path to write it to")
				}
				if !hasLocal {
					local = name
				}
				target := resolvePath(c.IO.Cwd, local)
				if isDirectory(target) {
					target = filepath.Join(target, name)
				}
				if err := os.WriteFile(target, content, 0o666); err != nil {
					return err
				}
				written := struct {
					Path   string `json:"path"`
					Remote string `json:"remote"`
					Size   int    `json:"size"`
				}{target, filePath, len(content)}
				c.Emit(nil, written, func() string {
					return "Wrote " + target + " (" + cli.Bytes(float64(len(content))) + ")."
				})
				return nil
			},
		},
		{
			Name:    "files rm",
			Summary: "Delete a file, or a directory and everything in it",
			Args:    []cli.Arg{{Name: "id"}, {Name: "path"}},
			Run: func(c *cli.Context) error {
				p := c.Arg(1)
				client, err := Client(c)
				if err != nil {
					return err
				}
				if err := client.DeleteFile(c.Ctx, c.Arg(0), &api.DeleteFileQuery{Path: &p}); err != nil {
					return err
				}
				c.Emit(nil, map[string]string{"deleted": p}, func() string { return "Deleted " + p + "." })
				return nil
			},
		},
		scpCommand(),
		pushCommand(),
		syncCommand(),
	}}
}

func execCommand() *cli.Command {
	return &cli.Command{
		Name:    "exec",
		Summary: "Run a command in a sandbox, with its output and exit code",
		Args:    []cli.Arg{{Name: "id"}, {Name: "command", Optional: true, Variadic: true}},
		Rest:    "command…",
		Flags: []cli.Flag{
			{Name: "cwd", Type: cli.String, Value: "<dir>", Description: "Run it here (default the sandbox user's home)"},
			{Name: "env", Type: cli.String, Multiple: true, Value: "<K=V>", Description: "An environment variable; repeat it"},
			{Name: "timeout", Type: cli.String, Value: "<seconds>",
				Description: "Kill it after this long (default 30, at most 600); 0: no limit, following its output"},
			{Name: "detach", Type: cli.Bool, Short: "d",
				Description: "Start it and print its ID at once, with no time limit unless --timeout gives one"},
			{Name: "attach", Type: cli.String, Value: "<command>", Description: "Follow a detached command's output to its end"},
			{Name: "status", Type: cli.String, Value: "<command>", Description: "Show a command: its state and output so far"},
			{Name: "kill", Type: cli.String, Value: "<command>", Description: "Stop a detached command"},
			{Name: "stdin", Type: cli.Bool, Description: "Send this terminal's stdin to the command"},
		},
		Details: "One word is a shell command line: kantel exec <id> 'make && make test'. Several are a command and its\n" +
			"arguments, quoted for the shell; put them after -- when they have flags of their own:\n" +
			"kantel exec <id> -- ls -la. Its stdout and stderr come out on ours, and kantel exits with its exit\n" +
			"code (124 when it timed out). Its output comes as it is written, and kantel follows it on through a\n" +
			"reconnect; if it can't reach Kantel for two minutes it prints the command's ID and how to attach.\n" +
			"A server or a long job: --detach, then kantel attach <id> <command>.",
		Examples: []cli.Example{
			{What: "Run a shell command line", Line: "kantel exec sbx_4kq9x2mt 'cd my-app && npm test'"},
			{What: "A command with flags of its own, after --", Line: "kantel exec sbx_4kq9x2mt --cwd my-app -- npm run lint -- --fix"},
			{What: "A dev server, left running; attach follows it", Line: "kantel exec sbx_4kq9x2mt -d -- npm run dev"},
			{What: "A long build with no time limit, following its output", Line: "kantel exec sbx_4kq9x2mt --timeout 0 -- make -j8"},
		},
		Run: runExec,
	}
}

func runExec(c *cli.Context) error {
	sandboxID := c.Arg(0)
	client, err := Client(c)
	if err != nil {
		return err
	}
	if attach, ok := c.Str("attach"); ok {
		return follow(c, client, sandboxID, attach, followOptions{})
	}
	if status, ok := c.Str("status"); ok {
		var raw json.RawMessage
		command, err := client.GetCommand(c.Ctx, sandboxID, status, api.Raw(&raw))
		if err != nil {
			return err
		}
		return showCommand(c, raw, command)
	}
	if kill, ok := c.Str("kill"); ok {
		var raw json.RawMessage
		command, err := client.KillCommand(c.Ctx, sandboxID, kill, api.Raw(&raw))
		if err != nil {
			return err
		}
		return killed(c, raw, command)
	}
	words := c.Args[1:]
	if c.Parsed.HasRest {
		words = c.Rest
	}
	if len(words) == 0 {
		return cli.Usage("give the command: kantel exec <id> -- <command…>")
	}
	seconds, err := Whole(c, "timeout", 0)
	if err != nil {
		return err
	}
	unlimited := seconds != nil && *seconds == 0
	detach := c.Bool("detach")
	// Every command is started detached, so its ID comes back at once, and followed by it unless --detach: a plain one
	// with its limit (Kantel's default unless --timeout gives one), --timeout 0 with none. Its output comes as it is
	// written, and a reconnect or a reset connection on the way loses neither it nor its ID. A detached one runs with
	// no limit unless --timeout gives one, as MCP's sandbox_exec does.
	var limit *int64
	switch {
	case unlimited:
	case detach:
		limit = seconds
	case seconds != nil:
		limit = seconds
	default:
		limit = api.Ptr(int64(execDefaultSeconds))
	}
	body := api.RunCommandBody{Command: CommandLine(words), Cwd: StrPtr(c, "cwd"), Detached: api.Ptr(true)}
	if body.Env, err = Pairs(c.List("env"), "--env"); err != nil {
		return err
	}
	if limit != nil {
		body.TimeoutMs = api.Ptr(*limit * 1000)
	}
	if c.Bool("stdin") {
		input, err := io.ReadAll(c.IO.Stdin)
		if err != nil {
			return err
		}
		body.Stdin = api.Ptr(strings.ToValidUTF8(string(input), "�"))
	}
	var raw json.RawMessage
	result, err := client.RunCommand(c.Ctx, sandboxID, body, api.Raw(&raw))
	if err != nil {
		// Sent, and retried under its key, with no answer: whether it started is unknown, and its ID with it.
		why := transient(err)
		if why == "" {
			return err
		}
		return cli.Fail(why + "; it may have started: kantel ps " + sandboxID + " lists it")
	}
	if !detach {
		return follow(c, client, sandboxID, result.ID, followOptions{first: result, raw: raw, announce: unlimited, limitSeconds: limit})
	}
	if c.JSON {
		c.Out(cli.IndentJSON(raw, result))
		return exitWith(exitCodeOf(result))
	}
	if result.State == api.CommandStateRunning {
		c.Out(result.ID)
		c.Note(fmt.Sprintf("kantel: started %s. Follow it: kantel attach %s %s; stop it: kantel kill %s %s",
			result.ID, sandboxID, result.ID, sandboxID, result.ID))
		return nil
	}
	printOutput(c, result)
	if result.State == api.CommandStateTimedOut {
		after := ""
		if seconds != nil {
			after = fmt.Sprintf(" after %d s", *seconds)
		}
		c.Note("kantel: the command timed out" + after + " and was killed")
	}
	return exitWith(exitCodeOf(result))
}

func scpCommand() *cli.Command {
	return &cli.Command{
		Name:    "scp",
		Summary: "Copy files to or from a sandbox: <id>:<path> names a path in it",
		Args:    []cli.Arg{{Name: "from"}, {Name: "to"}},
		Flags:   []cli.Flag{{Name: "recursive", Type: cli.Bool, Short: "r", Description: "Copy a directory and everything in it"}},
		Details: "  kantel scp ./report.txt sbx_123:/home/user/      upload a file into a directory\n" +
			"  kantel scp sbx_123:out.zip .                      download one (relative paths are under a microVM's /home/user, an isolate's /workspace)\n" +
			"  kantel scp -r ./site sbx_123:/srv/site            upload a directory\n" +
			"It goes through Kantel's files API, so it works on isolates too. A file over 1 MiB comes down in parts;\n" +
			"one going up goes in parts that a command joins, which needs a microVM.",
		Examples: []cli.Example{
			{What: "A file into a sandbox", Line: "kantel scp ./data.csv sbx_4kq9x2mt:/home/user/"},
			{What: "A directory out of one", Line: "kantel scp -r sbx_4kq9x2mt:/home/user/app/dist ./dist"},
		},
		Run: runScp,
	}
}

func runScp(c *cli.Context) error {
	from, to := c.Arg(0), c.Arg(1)
	source, fromSandbox := parseRemote(from)
	target, toSandbox := parseRemote(to)
	if fromSandbox == toSandbox {
		return cli.Usage("name the sandbox on one side, and only one: kantel scp ./file sbx_123:/home/user/")
	}
	client, err := Client(c)
	if err != nil {
		return err
	}
	recursive := c.Bool("recursive")
	if toSandbox {
		// Uploading.
		local := resolvePath(c.IO.Cwd, from)
		name := baseName(local)
		into := remotePath(target.Path)
		intoDirectory := into == "" || strings.HasSuffix(into, "/")
		if !intoDirectory {
			if intoDirectory, err = remoteIsDirectory(c.Ctx, client, target.SandboxID, into); err != nil {
				return err
			}
		}
		remote := into
		if intoDirectory {
			remote = remoteJoin(into, name)
		}
		if isDirectory(local) {
			if !recursive {
				return cli.Usage(from + " is a directory: add -r to copy it")
			}
			files, err := walk(local)
			if err != nil {
				return err
			}
			done, where, err := uploadTreeTo(c, client, target.SandboxID, local, files, remote, logPath(c))
			if err != nil {
				return err
			}
			c.Emit(nil, copiedTo{done, where}, func() string {
				return fmt.Sprintf("Copied %s (%s) to %s.", fileCount(done.Files), cli.Bytes(float64(done.Bytes)), where)
			})
			return nil
		}
		size, err := uploadFile(c.Ctx, client, target.SandboxID, local, remote)
		if err != nil {
			return err
		}
		c.Emit(nil, copiedTo{copied{1, size}, remote}, func() string {
			return fmt.Sprintf("Copied %s (%s) to %s.", from, cli.Bytes(float64(size)), remote)
		})
		return nil
	}
	// Downloading.
	remote := remotePath(source.Path)
	local := resolvePath(c.IO.Cwd, to)
	name := path.Base(strings.TrimRight(remote, "/"))
	if name == "." || name == "/" || name == "" {
		name = "home"
	}
	here := local
	if isDirectory(local) {
		here = filepath.Join(local, name)
	}
	isDir, err := remoteIsDirectory(c.Ctx, client, source.SandboxID, remote)
	if err != nil {
		return err
	}
	if isDir {
		if !recursive {
			return cli.Usage(from + " is a directory: add -r to copy it")
		}
		done, err := downloadTree(c.Ctx, client, source.SandboxID, remote, here, logPath(c))
		if err != nil {
			return err
		}
		c.Emit(nil, copiedTo{done, here}, func() string {
			return fmt.Sprintf("Copied %s (%s) to %s.", fileCount(done.Files), cli.Bytes(float64(done.Bytes)), here)
		})
		return nil
	}
	content, err := getBytes(c.Ctx, client, source.SandboxID, remote)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(here), 0o777); err != nil {
		return err
	}
	if err := os.WriteFile(here, content, 0o666); err != nil {
		return err
	}
	c.Emit(nil, copiedTo{copied{1, len(content)}, here}, func() string {
		return fmt.Sprintf("Copied %s (%s) to %s.", from, cli.Bytes(float64(len(content))), here)
	})
	return nil
}

// copiedTo is what scp copied, and where.
type copiedTo struct {
	copied
	To string `json:"to"`
}

var (
	allowHomeFlag = func(what string) cli.Flag {
		return cli.Flag{Name: "allow-home", Type: cli.Bool, Description: what}
	}
	noDefaultExcludesFlag = func(what string) cli.Flag {
		return cli.Flag{Name: "no-default-excludes", Type: cli.Bool, Description: what}
	}
)

func pushCommand() *cli.Command {
	return &cli.Command{
		Name:    "push",
		Summary: "Copy a local directory into a sandbox (in git, the files git would commit)",
		Args:    []cli.Arg{{Name: "id"}, {Name: "dir", Optional: true}},
		Flags: []cli.Flag{
			{Name: "to", Type: cli.String, Value: "<path>", Description: "Where in the sandbox (default <dir name>, under a microVM's /home/user or an isolate's /workspace)"},
			allowHomeFlag("Push your home directory, or one holding it, leaving Kantel's config out"),
			noDefaultExcludesFlag("Send credentials, agents' sign-ins and .env files too"),
		},
		Details: "In a git repository it sends the files git tracks and the new ones .gitignore doesn't leave out, so\n" +
			"node_modules, build output and .git stay here. Elsewhere it sends everything but .git. Into a microVM it\n" +
			"goes as one gzipped tar that the microVM's tar extracts; into an isolate, file by file. Files already\n" +
			"there are replaced; files you deleted here stay there. Executable bits are kept.\n" +
			"It leaves out, at any depth, .ssh, .gnupg, .aws, .azure, .kube, .netrc, .pypirc and .docker/config.json,\n" +
			"and, unless git tracks them, .claude, .codex, .cursor, .npmrc and .env files (not .env.example),\n" +
			"naming each on stderr; --no-default-excludes sends them. Links to outside the directory stay here.\n" +
			"It refuses your home directory, or a directory holding it or Kantel's config, without --allow-home,\n" +
			"and a directory inside one it leaves out, such as ~/.ssh, without --no-default-excludes.",
		Examples: []cli.Example{
			{What: "This repository's files (what git would commit), to /home/user/<its name>", Line: "kantel push sbx_4kq9x2mt ."},
			{What: "Somewhere else in the sandbox", Line: "kantel push sbx_4kq9x2mt ./web --to /srv/web"},
		},
		Run: runPush,
	}
}

func runPush(c *cli.Context) error {
	sandboxID := c.Arg(0)
	dir, ok := c.Optional(1)
	if !ok {
		dir = "."
	}
	root := resolvePath(c.IO.Cwd, dir)
	if !isDirectory(root) {
		return cli.Usage(root + " isn't a directory: use kantel scp for a file")
	}
	git := gitFiles(root)
	defaultExcludes := !c.Bool("no-default-excludes")
	config, err := checkPushRoot(root, pushRoot{
		Home: c.IO.Home, ConfigDir: c.IO.ConfigDir, AllowHome: c.Bool("allow-home"),
		DefaultExcludes: defaultExcludes, InRepository: git != nil,
	})
	if err != nil {
		return err
	}
	o := pushOptions{DefaultExcludes: defaultExcludes}
	var files []string
	top := ""
	if git != nil {
		files, o.Tracked, top = git.Files, git.Tracked, git.Top
	} else if files, err = walk(root); err != nil {
		return err
	}
	if config != "" {
		o.Keep = []string{config}
	}
	o.Contexts = rootContexts(root, top)
	sent, left := pushPlan(root, files, o)
	noteSkipped(c, left)
	to, ok := c.Str("to")
	if !ok {
		to = baseName(root)
	}
	target := remotePath(to)
	client, err := Client(c)
	if err != nil {
		return err
	}
	done, where, err := uploadTreeTo(c, client, sandboxID, root, sent, target, logPath(c))
	if err != nil {
		return err
	}
	c.Emit(nil, struct {
		copied
		To      string    `json:"to"`
		Skipped []skipped `json:"skipped"`
	}{done, where, left}, func() string {
		return fmt.Sprintf("Pushed %s (%s) to %s.", fileCount(done.Files), cli.Bytes(float64(done.Bytes)), where)
	})
	return nil
}

func syncCommand() *cli.Command {
	return &cli.Command{
		Name:    "sync",
		Summary: "Bring a git checkout in a microVM to this working tree, sending only a patch (--git)",
		Args:    []cli.Arg{{Name: "id"}, {Name: "dir", Optional: true}},
		Flags: []cli.Flag{
			{Name: "git", Type: cli.Bool, Description: "As a git patch against the checkout's base commit (the one way sync works)"},
			{Name: "to", Type: cli.String, Value: "<path>", Description: "The checkout in the sandbox (default /home/user/<repository's directory name>)"},
			{Name: "base", Type: cli.String, Value: "<commit>", Description: "Diff against this commit, not the one the sandbox records"},
			allowHomeFlag("Sync a repository that is your home directory, or holds it, leaving Kantel's config out"),
			noDefaultExcludesFlag("Send changed credentials, agents' sign-ins and .env files too"),
		},
		Details: "For a sandbox that already has a clone of this repository, such as one made from a snapshot with its\n" +
			"dependencies installed: only the difference from the clone's base commit goes over, where kantel push\n" +
			"sends every file. The base is --base, else the checkout's .kantel-base-sha, else the git.base label on\n" +
			"the snapshot the sandbox was made from, else the checkout's HEAD; your repository must have it too.\n" +
			"Here, in a copy of your index (yours isn't touched), it stages your tracked changes and the new files\n" +
			".gitignore doesn't leave out, and diffs that tree against the base, binary files and all. There, it\n" +
			"runs git clean -fd, which keeps ignored files such as node_modules, and git reset --hard <base>, applies\n" +
			"the patch with git apply --index and checks that git write-tree names the same tree on both sides.\n" +
			"Anything else in the checkout (commits, changes, new files) is lost. A changed or new file push would\n" +
			"leave out (credentials; untracked .claude, .codex, .cursor, .npmrc and .env files) stays at the base's\n" +
			"version, named on stderr; --no-default-excludes sends it. It refuses a repository as push refuses a\n" +
			"directory (in Kantel's config, in .ssh and the like, or your home without --allow-home), and never sends\n" +
			"Kantel's config. The whole repository goes, whichever of its directories you name. Submodules' and Git\n" +
			"LFS files' contents don't.",
		Examples: []cli.Example{
			{What: "Bring the sandbox's clone to this working tree, sending only a patch", Line: "kantel sync sbx_4kq9x2mt --git"},
		},
		Run: runSync,
	}
}

func runSync(c *cli.Context) error {
	if !c.Bool("git") {
		return cli.Usage("sync works as a git patch for now: add --git (kantel push copies a directory without git)")
	}
	sandboxID := c.Arg(0)
	named, ok := c.Optional(1)
	if !ok {
		named = "."
	}
	dir := resolvePath(c.IO.Cwd, named)
	if !isDirectory(dir) {
		return cli.Usage(dir + " isn't a directory")
	}
	top, err := repositoryTop(dir)
	if err != nil {
		return err
	}
	defaultExcludes := !c.Bool("no-default-excludes")
	// The whole repository goes, so push's checks apply to its top: not in Kantel's config or .ssh, not the home
	// without --allow-home, and Kantel's config, where the repository holds it, always left out.
	config, err := checkPushRoot(top, pushRoot{
		Home: c.IO.Home, ConfigDir: c.IO.ConfigDir, AllowHome: c.Bool("allow-home"),
		DefaultExcludes: defaultExcludes, InRepository: true, Verb: "sync",
	})
	if err != nil {
		return err
	}
	o := syncOptions{Top: top, Base: c.StrOr("base", ""), DefaultExcludes: defaultExcludes, Contexts: rootContexts(top, top)}
	if to, ok := c.Str("to"); ok {
		o.To = checkoutPath(to)
	} else {
		o.To = defaultCheckout(top)
	}
	if config != "" {
		o.Keep = []string{config}
	}
	client, err := Client(c)
	if err != nil {
		return err
	}
	s, err := syncGit(c.Ctx, client, sandboxID, o)
	if err != nil {
		return err
	}
	noteSkipped(c, s.Skipped)
	c.Emit(nil, s, func() string {
		from := map[baseSource]string{baseFromFlag: "--base", baseFromFile: ".kantel-base-sha", baseFromLabel: "its snapshot's git.base", baseFromHead: "HEAD"}
		patch := "no changes"
		if s.Files > 0 {
			patch = fmt.Sprintf("%s changed: a %s patch, %s sent", fileCount(s.Files), cli.Bytes(float64(s.PatchBytes)), cli.Bytes(float64(s.SentBytes)))
		}
		return fmt.Sprintf("Synced %s in %s (%s) on %s (%s) in %.1f s. Both trees are %s.",
			s.Path, sandboxID, patch, short(s.Base), from[s.BaseSource], float64(s.Timings.TotalMs)/1000, short(s.Tree))
	})
	return nil
}
