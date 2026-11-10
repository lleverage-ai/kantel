package kantel

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// IDArg is a command's one argument, a sandbox's ID.
var IDArg = []cli.Arg{{Name: "id"}}

// Sizes are the API's size names, which the hosts may offer fewer of (kantel sizes).
var Sizes = []string{"small", "default", "large", "xlarge"}

var (
	sizeFlag = cli.Flag{Name: "size", Type: cli.String, Value: "<size>", Choices: Sizes,
		Description: "A microVM's named size, such as small, default or large (kantel sizes lists the hosts')"}
	noWaitFlag = cli.Flag{Name: "no-wait", Type: cli.Bool, Description: "Answer at once rather than once it runs"}
	cursorFlag = cli.Flag{Name: "cursor", Type: cli.String, Value: "<cursor>", Description: "The next page, from a list's More"}
	idleStop   = cli.Flag{Name: "idle-stop", Type: cli.String, Value: "<minutes|never>",
		Description: "Also stop once it goes this long unused: no command, SSH, desktop, browser or port traffic"}
)

// sizeOf is --size: one of the API's size names.
func sizeOf(c *cli.Context) (*api.SandboxSizeName, error) {
	value, ok := c.Str("size")
	if !ok {
		return nil, nil
	}
	for _, s := range Sizes {
		if s == value {
			name := api.SandboxSizeName(value)
			return &name, nil
		}
	}
	return nil, cli.Usage(`--size takes a named size, such as small, default or large, not "` + value +
		`": kantel sizes lists the hosts' sizes, and --vcpus with --memory makes another shape`)
}

var memoryGB = regexp.MustCompile(`^\d+(\.\d+)?$`)

// hostedPort is --host's port[:public].
func hostedPort(value string) (api.ExposePortBody, error) {
	port, public, _ := strings.Cut(value, ":")
	n, err := strconv.ParseInt(port, 10, 64)
	if err != nil || n < 1 || n > 65535 || (public != "" && public != "public") {
		return api.ExposePortBody{}, cli.Usage(`--host takes a port, or port:public, not "` + value + `"`)
	}
	body := api.ExposePortBody{Port: n}
	if public == "public" {
		body.Public = api.Ptr(true)
	}
	return body, nil
}

var lifecycleDoing = map[string]string{"start": "Starting", "stop": "Stopping", "resume": "Resuming", "recover": "Recovering"}

// lifecycle is the start, stop, resume and recover commands, alike but for the call.
func lifecycle(verb, summary string, flags []cli.Flag, examples []cli.Example,
	call func(c *cli.Context, client *api.Client, id string, raw *json.RawMessage) (*api.Sandbox, error)) *cli.Command {
	return &cli.Command{
		Name: verb, Summary: summary, Args: IDArg, Flags: flags, Examples: examples,
		Run: func(c *cli.Context) error {
			client, err := Client(c)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			var sandbox *api.Sandbox
			err = c.Spin(lifecycleDoing[verb]+" "+c.Arg(0)+"…", func() error {
				sandbox, err = call(c, client, c.Arg(0), &raw)
				return err
			})
			if err != nil {
				return err
			}
			c.Emit(raw, sandbox, func() string { return sandbox.ID + " " + c.Style.State(StateOf(*sandbox)) })
			if sandbox.State == api.SandboxStateError {
				return cli.ExitCode(cli.ExitFailed)
			}
			return nil
		},
	}
}

func resumeBody(c *cli.Context) (api.ResumeSandboxBody, error) {
	size, err := sizeOf(c)
	return api.ResumeSandboxBody{Wait: api.Ptr(!c.Bool("no-wait")), Size: size}, err
}

func sandboxes() cli.Section {
	return cli.Section{Title: "Sandboxes", Commands: []*cli.Command{
		newCommand(),
		{
			Name:    "sizes",
			Summary: "The sizes and shapes a new microVM may be, from the hosts it may use",
			Flags:   []cli.Flag{{Name: "on", Type: cli.String, Value: "<host>", Description: "Only what this host offers, its name or ID"}},
			Details: "Each deployment's hosts decide which named sizes there are and what each holds, and may offer fewer than\n" +
				"small, default, large and xlarge. kantel new --size takes one of these; --vcpus and --memory any other\n" +
				"shape in the ranges shown.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				account, err := AccountPtr(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				shapes, err := client.GetSandboxShapes(c.Ctx, &api.GetSandboxShapesQuery{Account: account, Host: StrPtr(c, "on")}, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, shapes, func() string { return describeShapes(c, *shapes) })
				return nil
			},
		},
		listCommand(),
		{
			Name: "info", Summary: "Show a sandbox", Args: IDArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				sandbox, err := client.GetSandbox(c.Ctx, c.Arg(0), api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, sandbox, func() string { return DescribeSandbox(c, *sandbox) })
				return nil
			},
		},
		lifecycle("start", "Boot a stopped sandbox fresh from its newest snapshot", []cli.Flag{noWaitFlag, sizeFlag}, nil,
			func(c *cli.Context, client *api.Client, id string, raw *json.RawMessage) (*api.Sandbox, error) {
				body, err := resumeBody(c)
				if err != nil {
					return nil, err
				}
				return client.StartSandbox(c.Ctx, id, body, api.Raw(raw))
			}),
		lifecycle("stop", "Stop a sandbox, keeping its disk; it then costs nothing to run",
			[]cli.Flag{
				{Name: "pause", Type: cli.Bool, Description: "Pause instead, keeping its memory too (microVMs only)"},
				{Name: "wait", Type: cli.Bool, Description: "Answer once it has stopped"},
			},
			[]cli.Example{
				{What: "Stop it, keeping its disk", Line: "kantel stop sbx_4kq9x2mt"},
				{What: "Pause a microVM, keeping its memory too", Line: "kantel stop sbx_4kq9x2mt --pause"},
			},
			func(c *cli.Context, client *api.Client, id string, raw *json.RawMessage) (*api.Sandbox, error) {
				return client.StopSandbox(c.Ctx, id, api.StopSandboxBody{KeepMemory: TruePtr(c, "pause"), Wait: TruePtr(c, "wait")}, api.Raw(raw))
			}),
		lifecycle("resume", "Carry on a paused or stopped sandbox, with the same ID", []cli.Flag{noWaitFlag, sizeFlag}, nil,
			func(c *cli.Context, client *api.Client, id string, raw *json.RawMessage) (*api.Sandbox, error) {
				body, err := resumeBody(c)
				if err != nil {
					return nil, err
				}
				return client.ResumeSandbox(c.Ctx, id, body, api.Raw(raw))
			}),
		lifecycle("recover", "Restart the machine of a sandbox that is stuck or in error", nil, nil,
			func(c *cli.Context, client *api.Client, id string, raw *json.RawMessage) (*api.Sandbox, error) {
				return client.RecoverSandbox(c.Ctx, id, api.Raw(raw))
			}),
		{
			Name: "fork", Summary: "Copy a sandbox into new ones", Args: IDArg,
			Flags: []cli.Flag{
				{Name: "count", Type: cli.String, Value: "<n>", Description: "How many copies (default 1)"},
				{Name: "name", Type: cli.String, Value: "<name>", Description: "The copies' name"},
				{Name: "snapshot", Type: cli.String, Value: "<id>", Description: "Copy this snapshot of it; default its newest"},
				noWaitFlag,
			},
			Examples: []cli.Example{{What: "Three copies of a sandbox as it is now", Line: "kantel fork sbx_4kq9x2mt --count 3"}},
			Run: func(c *cli.Context) error {
				count, err := Whole(c, "count", 1)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				var forked *api.ForkedSandboxes
				err = c.Spin("Forking "+c.Arg(0)+"…", func() error {
					forked, err = client.ForkSandbox(c.Ctx, c.Arg(0), api.ForkSandboxBody{
						Count: count, Name: StrPtr(c, "name"), SnapshotID: StrPtr(c, "snapshot"), Wait: api.Ptr(!c.Bool("no-wait")),
					}, api.Raw(&raw))
					return err
				})
				if err != nil {
					return err
				}
				c.Emit(raw, forked, func() string { return SandboxTable(c, forked.Items) })
				return nil
			},
		},
		{
			Name: "delete", Summary: "Delete a sandbox for good (needs --yes)", Args: IDArg,
			Flags:    []cli.Flag{{Name: "yes", Type: cli.Bool, Short: "y", Description: "Yes, delete it: this can't be undone"}},
			Details:  "It erases the sandbox and its automatic snapshots; saved snapshots of it stay.",
			Examples: []cli.Example{{What: "Delete a sandbox for good", Line: "kantel delete sbx_4kq9x2mt --yes"}},
			Run: func(c *cli.Context) error {
				id := c.Arg(0)
				if !c.Bool("yes") {
					return cli.Usage(fmt.Sprintf("deleting a sandbox is permanent: it erases %s and its automatic snapshots. "+
						"To delete it, run: kantel delete %s --yes (or kantel stop %s keeps it)", id, id, id))
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				sandbox, err := client.DeleteSandbox(c.Ctx, id, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, sandbox, func() string { return sandbox.ID + " " + c.Style.State(string(sandbox.State)) })
				return nil
			},
		},
		{
			Name:    "extend",
			Summary: "Move a sandbox's auto-stop to this many minutes from now, or change its idle stop",
			Args:    []cli.Arg{{Name: "id"}, {Name: "minutes", Optional: true}},
			Flags:   []cli.Flag{idleStop},
			Details: "kantel extend <id> 120 moves its stop to two hours from now. kantel extend <id> --idle-stop 30 stops it\n" +
				"once it goes 30 minutes unused, counting from now; --idle-stop never turns that off. Both may be given.",
			Run: func(c *cli.Context) error {
				body := api.UpdateSandboxBody{}
				if m, ok := c.Optional(1); ok {
					n, err := WholeOf(m, "minutes", 1)
					if err != nil {
						return err
					}
					body.ExtendMinutes = n
				}
				idle, err := MinutesOrNever(c, "idle-stop")
				if err != nil {
					return err
				}
				body.IdleStopMinutes = idle
				if body.ExtendMinutes == nil && !idle.Set {
					return cli.Usage("give the minutes to extend it by, or --idle-stop <minutes|never>")
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				sandbox, err := client.UpdateSandbox(c.Ctx, c.Arg(0), body, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, sandbox, func() string {
					line := sandbox.ID + " " + string(sandbox.State)
					if sandbox.StopsAt != nil {
						line = sandbox.ID + " stops " + cli.Until(*sandbox.StopsAt, now(c))
					}
					if idle.Set {
						text := idleStopText(c, *sandbox)
						if text == "" {
							text = "never"
						}
						line += "\nidle stop: " + text
					}
					return line
				})
				return nil
			},
		},
		{
			Name:    "usage",
			Summary: "A sandbox's running time, CPU and cost over the last day, and its peak memory and CPU",
			Args:    IDArg,
			Details: "The peaks are its highest single readings since it was made, kept after the readings themselves are gone and\n" +
				"after it is deleted: size a sandbox from them, as a mean can be half its peak or less.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				usage, err := client.GetSandboxUsage(c.Ctx, c.Arg(0), nil, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, usage, func() string {
					t := usage.Totals
					peakMemory := ""
					if usage.PeakMemoryBytes != nil {
						peakMemory = cli.Bytes(float64(*usage.PeakMemoryBytes))
						if usage.MemLimitBytes != nil {
							peakMemory += " of " + cli.Bytes(float64(*usage.MemLimitBytes))
						}
						if usage.PeakMemoryAt != nil {
							peakMemory += ", " + cli.Ago(*usage.PeakMemoryAt, now(c))
						}
					}
					peakCPU := ""
					if usage.PeakCPU != nil {
						peakCPU = percent(*usage.PeakCPU)
					}
					return cli.Fields(c.Style, []cli.Field{
						{"running", cli.Duration(t.RunningSeconds)},
						{"cpu", fmt.Sprintf("%.1f s", t.CPUSeconds)},
						{"memory", GuestMemoryText(usage.Memory)},
						{"cost", cli.Money(t.Cost.Total, t.Cost.Currency)},
						{"peak memory", peakMemory},
						{"peak cpu", peakCPU},
					})
				})
				return nil
			},
		},
	}}
}

func newCommand() *cli.Command {
	return &cli.Command{
		Name:    "new",
		Summary: "Create a sandbox and wait until it runs",
		Flags: []cli.Flag{
			{Name: "type", Type: cli.String, Value: "<isolate|microvm>", Choices: []string{"isolate", "microvm"},
				Description: "isolate (default): starts in milliseconds; microvm: a full Linux with Docker and SSH"},
			sizeFlag,
			{Name: "disk", Type: cli.String, Value: "<GB>", Description: "A microVM's disk in GB, whatever its size (default: its size's); within the hosts' limits"},
			{Name: "vcpus", Type: cli.String, Value: "<n>", Description: "A microVM's vCPUs, in place of --size; with --memory"},
			{Name: "memory", Type: cli.String, Value: "<GB>", Description: "A microVM's memory in GB, in place of --size; with --vcpus"},
			{Name: "name", Type: cli.String, Value: "<name>", Description: "Default: a generated name"},
			{Name: "from", Type: cli.String, Value: "<snapshot>", Description: "Start from a snapshot's ID or a saved one's name"},
			{Name: "image", Type: cli.String, Value: "<image>", Description: "A microVM's base image"},
			{Name: "auto-stop", Type: cli.String, Value: "<minutes|never>", Description: "Stop by itself this long after it starts (default 60)"},
			{Name: "idle-stop", Type: cli.String, Value: idleStop.Value, Description: idleStop.Description + " (default never)"},
			{Name: "label", Type: cli.String, Multiple: true, Value: "<k=v>", Description: "A label; repeat for more"},
			{Name: "env", Type: cli.String, Short: "e", Multiple: true, Value: "<K=V|env>",
				Description: "K=V: a variable every command sees (not a secret), repeatable; or an environment to start from"},
			{Name: "host", Type: cli.String, Multiple: true, Value: "<port[:public]>", Description: "Give this port an HTTPS URL once it runs; repeat it"},
			{Name: "on", Type: cli.String, Value: "<host>", Description: "Run it on this host, its name or ID (kantel hosts list shows them)"},
			{Name: "host-label", Type: cli.String, Multiple: true, Value: "<k=v>", Description: "Run it only on a host with this label; repeat for more"},
			noWaitFlag,
		},
		Details: "--env takes a variable (K=V) or an environment (its name or env_… ID; kantel env list shows them). An\n" +
			"environment gives the sandbox its variables, secret files, repos and grants: a protected variable arrives\n" +
			"as a kph_… placeholder that the egress proxy swaps for the value only where it is bound.\n\n" +
			"--disk sizes a microVM's disk apart from its vCPUs and memory (kantel new --type microvm --size large\n" +
			"--disk 60). A sandbox made from a snapshot keeps the snapshot's disk.\n\n" +
			"--size takes one of the named sizes the hosts offer; kantel sizes lists them, and the most --vcpus and\n" +
			"--memory may ask for. --vcpus and --memory size a microVM beyond the named sizes (kantel new --type\n" +
			"microvm --vcpus 8 --memory 16), within what a host offers. A large monorepo's type-check needs about\n" +
			"16 GB, and its tests about 32.\n\n" +
			"--from with --size, or --vcpus and --memory, starts a snapshot of the disk alone (the default for\n" +
			"kantel snapshot save) on that machine: kantel new --from monorepo-ci --vcpus 8 --memory 16. A\n" +
			"snapshot that holds its sandbox's memory (saved with --memory) has that sandbox's machine, and Kantel\n" +
			"refuses another. Without them, a sandbox from a snapshot is the machine the snapshot was taken of.\n\n" +
			"--idle-stop stops it once nobody has used it for that long, beside --auto-stop's lifetime: with\n" +
			"--auto-stop never --idle-stop 30 it runs while people use it, and stops 30 minutes after they stop.\n" +
			"Its disk is kept; kantel resume starts it again. A request to a hosted port of a stopped sandbox gets a\n" +
			"page saying it is stopped and why: it doesn't wake it.\n\n" +
			"--on puts it on one host: one of the account's own hosts, or for a super-admin any host. It stays there,\n" +
			"as every sandbox stays on the host it was placed on. Without it, Kantel picks the host.",
		Examples: []cli.Example{
			{What: "A microVM: a full Linux with root, Docker and SSH", Line: "kantel new --type microvm"},
			{What: "A bigger one, with a name, that stops after 30 minutes unused", Line: "kantel new --type microvm --vcpus 8 --memory 16 --name ci --idle-stop 30"},
			{What: "One from a saved snapshot, keeping only its ID for a script", Line: "id=$(kantel new --from monorepo-ci --json | jq -r .id)"},
		},
		Run: runNew,
	}
}

func runNew(c *cli.Context) error {
	var hosts []api.ExposePortBody
	for _, h := range c.List("host") {
		body, err := hostedPort(h)
		if err != nil {
			return err
		}
		hosts = append(hosts, body)
	}
	body := api.CreateSandboxBody{Name: StrPtr(c, "name"), Image: StrPtr(c, "image"), From: StrPtr(c, "from"), Host: StrPtr(c, "on")}
	typ, hasType := c.Str("type")
	if hasType {
		if _, err := Choice(typ, "--type", "isolate", "microvm"); err != nil {
			return err
		}
		t := api.SandboxType(typ)
		body.Type = &t
	}
	_, from := c.Str("from")
	disk, err := Whole(c, "disk", 1)
	if err != nil {
		return err
	}
	if disk != nil && typ != "microvm" {
		return cli.Usage("--disk is a microVM's: add --type microvm (an isolate has no disk of its own)")
	}
	if disk != nil && from {
		return cli.Usage("a sandbox made from a snapshot keeps the snapshot's disk: leave out --disk")
	}
	vcpus, err := Whole(c, "vcpus", 1)
	if err != nil {
		return err
	}
	var memoryMb *int64
	if memory, ok := c.Str("memory"); ok {
		gb, err := strconv.ParseFloat(memory, 64)
		if !memoryGB.MatchString(memory) || err != nil || gb <= 0 {
			return cli.Usage(`--memory is in GB, such as 16 or 0.5, not "` + memory + `"`)
		}
		mb := int64(gb*1024 + 0.5)
		memoryMb = &mb
	}
	if (vcpus == nil) != (memoryMb == nil) {
		return cli.Usage("give --vcpus and --memory together")
	}
	if vcpus != nil {
		// From a snapshot, its type is the snapshot's: a microVM's, or Kantel refuses an isolate's shape.
		if typ != "microvm" && (hasType || !from) {
			return cli.Usage("--vcpus and --memory are a microVM's: add --type microvm")
		}
		if _, ok := c.Str("size"); ok {
			return cli.Usage("give --size or --vcpus and --memory, not both")
		}
	}
	if body.Size, err = sizeOf(c); err != nil {
		return err
	}
	if disk != nil || vcpus != nil {
		body.Resources = &api.SandboxShapeInput{VCPUs: vcpus, MemoryMb: memoryMb, DiskGb: disk}
	}
	if len(hosts) > 0 && c.Bool("no-wait") {
		return cli.Usage("--host needs the sandbox running")
	}
	// A variable has an =; an environment's name or ID never does.
	var vars, environments []string
	for _, e := range c.List("env") {
		if strings.Contains(e, "=") {
			vars = append(vars, e)
		} else {
			environments = append(environments, e)
		}
	}
	if len(environments) > 1 {
		return cli.Usage("a sandbox starts from one environment: give --env <env> once")
	}
	if len(environments) == 1 {
		body.Environment = &environments[0]
	}
	if body.AutoStopMinutes, err = MinutesOrNever(c, "auto-stop"); err != nil {
		return err
	}
	if body.IdleStopMinutes, err = MinutesOrNever(c, "idle-stop"); err != nil {
		return err
	}
	if body.Labels, err = Pairs(c.List("label"), "--label"); err != nil {
		return err
	}
	if body.Env, err = Pairs(vars, "--env"); err != nil {
		return err
	}
	if body.HostLabels, err = Pairs(c.List("host-label"), "--host-label"); err != nil {
		return err
	}
	body.Wait = api.Ptr(!c.Bool("no-wait"))
	if body.Account, err = AccountPtr(c); err != nil {
		return err
	}
	client, err := Client(c)
	if err != nil {
		return err
	}
	what := "a sandbox"
	switch typ {
	case "microvm":
		what = "a microVM"
	case "isolate":
		what = "an isolate"
	}
	doing := "Creating " + what + "…"
	if *body.Wait {
		doing = "Starting " + what
		if from {
			doing += " from " + *body.From
		}
		doing += "…"
	}
	var raw json.RawMessage
	var sandbox *api.Sandbox
	if err := c.Spin(doing, func() error {
		sandbox, err = client.CreateSandbox(c.Ctx, body, api.Raw(&raw))
		return err
	}); err != nil {
		return err
	}
	var ports []api.ExposedPort
	if sandbox.State == api.SandboxStateRunning {
		for _, h := range hosts {
			port, err := client.ExposePort(c.Ctx, sandbox.ID, h)
			if err != nil {
				return err
			}
			ports = append(ports, *port)
		}
	}
	var value any = sandbox
	if len(ports) > 0 {
		// The sandbox with its ports' URLs beside it.
		var merged map[string]any
		_ = json.Unmarshal(raw, &merged)
		merged["hostedPorts"] = ports
		value, raw = merged, nil
	}
	s := c.Style
	c.Emit(raw, value, func() string {
		tick := ""
		if s.On {
			tick = s.Paint(cli.Green, "✓") + " "
		}
		lines := []string{fmt.Sprintf("%sCreated %s (%s): %s%s, %s.", tick, s.Paint(cli.Bold, sandbox.ID), sandbox.Name,
			KindOf(*sandbox), diskOf(*sandbox), s.State(StateOf(*sandbox)))}
		if text := startupText(*sandbox); text != "" {
			lines = append(lines, "  "+s.Paint(cli.Dim, "Started in:")+"     "+text)
		}
		for _, p := range ports {
			label := fmt.Sprintf("Port %d:", p.Port)
			lines = append(lines, "  "+s.Paint(cli.Dim, label)+strings.Repeat(" ", max(1, 16-len(label)))+p.URL)
		}
		lines = append(lines,
			"  "+s.Paint(cli.Dim, "Run a command:")+"  kantel exec "+sandbox.ID+" -- echo hello",
			"  "+s.Paint(cli.Dim, "Stop it:")+"        kantel stop "+sandbox.ID)
		return strings.Join(lines, "\n")
	})
	if sandbox.State == api.SandboxStateError {
		return cli.ExitCode(cli.ExitFailed)
	}
	return nil
}

func listCommand() *cli.Command {
	return &cli.Command{
		Name:    "list",
		Summary: "List running sandboxes, or all of them",
		Flags: []cli.Flag{
			{Name: "all", Type: cli.Bool, Description: "Include stopped, paused and errored ones"},
			{Name: "label", Type: cli.String, Multiple: true, Value: "<k=v>", Description: "Only those with this label"},
			{Name: "on", Type: cli.String, Value: "<host>", Description: "Only those on this host, its name or ID"},
			{Name: "mine", Type: cli.Bool, Description: "Only your own, not the ones others share in an organisation"},
			{Name: "every-account", Type: cli.Bool, Description: "In each of your accounts, with an ACCOUNT column (a personal token's)"},
			cursorFlag,
		},
		Examples: []cli.Example{
			{What: "The running ones", Line: "kantel list"},
			{What: "Every one of yours, stopped ones too, in all your accounts", Line: "kantel list --all --mine --every-account"},
			{What: "Those with a label, as JSON", Line: "kantel list --label team=web --json"},
		},
		Run: func(c *cli.Context) error {
			all, mine := c.Bool("all"), c.Bool("mine")
			labels, err := Pairs(c.List("label"), "--label")
			if err != nil {
				return err
			}
			client, err := Client(c)
			if err != nil {
				return err
			}
			query := &api.ListSandboxesQuery{Label: labels, Host: StrPtr(c, "on"), Cursor: StrPtr(c, "cursor")}
			if all {
				query.All = api.Ptr(true)
			}
			if mine {
				query.Mine = api.Ptr(true)
			}
			if c.Bool("every-account") {
				return listEveryAccount(c, client, query)
			}
			if query.Account, err = AccountPtr(c); err != nil {
				return err
			}
			var raw json.RawMessage
			page, err := client.ListSandboxes(c.Ctx, query, api.Raw(&raw))
			if err != nil {
				return err
			}
			c.Emit(raw, page, func() string {
				if len(page.Items) == 0 {
					if all {
						return "No sandboxes."
					}
					return "No running sandboxes; --all shows stopped ones."
				}
				// The next page's command keeps this one's filters: the cursor is an offset into the same filtered list.
				command := []string{"kantel list"}
				if all {
					command = append(command, "--all")
				}
				if mine {
					command = append(command, "--mine")
				}
				for _, l := range c.List("label") {
					command = append(command, "--label", ShellQuote(l))
				}
				if on, ok := c.Str("on"); ok {
					command = append(command, "--on", ShellQuote(on))
				}
				return SandboxTable(c, page.Items) + More(page.NextCursor, strings.Join(command, " "))
			})
			return nil
		},
	}
}

// listEveryAccount lists the sandboxes in each account the caller may act in, every page of each. An account it
// can't list in is named on stderr and left out, and the exit code is 1.
func listEveryAccount(c *cli.Context, client *api.Client, query *api.ListSandboxesQuery) error {
	if query.Cursor != nil {
		return cli.Usage("--every-account lists every page: leave out --cursor")
	}
	accounts, err := client.ListAccounts(c.Ctx)
	if err != nil {
		return err
	}
	found := []api.Sandbox{}
	failed := false
	names := map[string]string{}
	for _, a := range accounts.Items {
		names[a.ID] = a.Name
		if a.Kind == api.AccountKindPersonal {
			names[a.ID] = "personal"
		}
		q := *query
		q.Account = &a.ID
		for {
			page, err := client.ListSandboxes(c.Ctx, &q)
			if err != nil {
				failed = true
				c.Note(fmt.Sprintf("kantel: couldn't list %s: %v", accountLabel(a), err))
				break
			}
			found = append(found, page.Items...)
			if page.NextCursor == nil {
				break
			}
			q.Cursor = page.NextCursor
		}
	}
	c.Emit(nil, map[string]any{"items": found}, func() string {
		if len(found) == 0 {
			if query.All != nil {
				return "No sandboxes."
			}
			return "No running sandboxes; --all shows stopped ones."
		}
		var rows [][]string
		for _, s := range found {
			name := names[s.AccountID]
			if name == "" {
				name = s.AccountID
			}
			by := s.CreatedBy.ID
			if s.CreatedBy.Name != nil {
				by = *s.CreatedBy.Name
			}
			rows = append(rows, []string{name, s.ID, s.Name, KindOf(s), c.Style.State(StateOf(s)), by})
		}
		return cli.Table(c.Style, []string{"ACCOUNT", "ID", "NAME", "TYPE", "STATE", "BY"}, rows)
	})
	if failed {
		return cli.ExitCode(cli.ExitFailed)
	}
	return nil
}

// accountLabel is an account as a person reads it: `Acme (acc_7f3k2m9q)`, or `your personal account (…)`.
func accountLabel(a api.Account) string {
	if a.Kind == api.AccountKindPersonal {
		return "your personal account (" + a.ID + ")"
	}
	return a.Name + " (" + a.ID + ")"
}
