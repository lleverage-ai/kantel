package admin

import (
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// The hosts: the Linux machines that run sandboxes.

var (
	hostIDArg  = []cli.Arg{{Name: "hostId"}}
	joinToken  = regexp.MustCompile(`kth_\S+`)
	wholeValue = regexp.MustCompile(`^\d+$`)
)

// redact is text with its join token hidden: token itself, and anything that looks like one.
func redact(text, token string) string {
	if token != "" {
		text = strings.ReplaceAll(text, token, "kth_…")
	}
	return joinToken.ReplaceAllString(text, "kth_…")
}

func now(c *cli.Context) time.Time {
	if c.IO.Now != nil {
		return c.IO.Now()
	}
	return time.Now()
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func hostVersion(h api.Host) string {
	switch {
	case h.Version == nil:
		return ""
	case h.Updating != nil:
		return fmt.Sprintf("%s (updating to %s)", *h.Version, h.Updating.Version)
	case h.UpdateAvailable != nil && *h.UpdateAvailable && h.LatestVersion != nil:
		return fmt.Sprintf("%s (%s out)", *h.Version, *h.LatestVersion)
	}
	return *h.Version
}

func tiers(h api.Host, sep string) string {
	names := make([]string, len(h.Tiers))
	for i, t := range h.Tiers {
		names[i] = string(t)
	}
	return strings.Join(names, sep)
}

func hostTable(c *cli.Context, hosts []api.Host) string {
	if len(hosts) == 0 {
		return "No hosts have joined. Add one: kantel-admin host add"
	}
	var rows [][]string
	for _, h := range hosts {
		seen := ""
		if h.LastSeenAt != nil {
			seen = cli.Ago(*h.LastSeenAt, now(c))
		}
		rows = append(rows, []string{h.ID, h.Name, c.Style.State(string(h.State)), hostVersion(h), tiers(h, ","),
			strconv.FormatInt(h.Allocated.Sandboxes, 10), seen})
	}
	return cli.Table(c.Style, []string{"ID", "NAME", "STATE", "VERSION", "TYPES", "SANDBOXES", "SEEN"}, rows)
}

func describeHost(c *cli.Context, h api.Host) string {
	var machine []string
	for _, part := range []string{deref(h.OS), string(deref((*string)(h.Arch)))} {
		if part != "" {
			machine = append(machine, part)
		}
	}
	kvm := "no"
	if h.KVM {
		kvm = "yes"
	}
	keys := make([]string, 0, len(h.Labels))
	for k := range h.Labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	labels := make([]string, len(keys))
	for i, k := range keys {
		labels[i] = k + "=" + h.Labels[k]
	}
	seen := ""
	if h.LastSeenAt != nil {
		seen = cli.Ago(*h.LastSeenAt, now(c))
	}
	return cli.Fields(c.Style, []cli.Field{
		{"id", h.ID},
		{"name", h.Name},
		{"state", c.Style.State(string(h.State))},
		{"version", deref(h.Version)},
		{"machine", strings.Join(machine, " ")},
		{"runs", tiers(h, ", ")},
		{"kvm", kvm},
		{"sandboxes", strconv.FormatInt(h.Allocated.Sandboxes, 10)},
		{"pool", hostPool(h)},
		{"labels", strings.Join(labels, ", ")},
		{"joined", cli.Timestamp(h.JoinedAt)},
		{"seen", seen},
	})
}

// hostPool is the pool a host is in, and the one it's moving to while it drains.
func hostPool(h api.Host) string {
	pool := deref(h.PoolID)
	if h.MovingTo != nil {
		return pool + " (moving to " + *h.MovingTo + " once drained)"
	}
	return pool
}

// linuxOnly fails on a machine kantel-host doesn't run on.
func linuxOnly(sys System) error {
	if sys.Platform != "linux" {
		return cli.Fail("kantel-host runs on Linux (x64 or arm64), not " + sys.Platform + ": run this on the machine to add")
	}
	return nil
}

// hostCall runs a call that answers a host, and prints it as `<id> <state>` or as told.
func hostCall(c *cli.Context, call func(client *api.Client, raw *json.RawMessage) (*api.Host, error),
	human func(api.Host) string) error {
	client, err := Client(c)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	host, err := call(client, &raw)
	if err != nil {
		return err
	}
	c.Emit(raw, host, func() string { return human(*host) })
	return nil
}

func hostState(c *cli.Context) func(api.Host) string {
	return func(h api.Host) string { return h.ID + " " + c.Style.State(string(h.State)) }
}

func hosts(sys System) cli.Section {
	return cli.Section{Title: "Hosts", Commands: []*cli.Command{
		{
			Name:    "host list",
			Summary: "The machines that run sandboxes",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				list, err := client.ListHosts(c.Ctx, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, list, func() string { return hostTable(c, list.Items) })
				return nil
			},
		},
		{
			Name:    "host info",
			Summary: "One host: its state, capacity and what it runs",
			Args:    hostIDArg,
			Run: func(c *cli.Context) error {
				return hostCall(c, func(client *api.Client, raw *json.RawMessage) (*api.Host, error) {
					return client.GetHost(c.Ctx, c.Arg(0), api.Raw(raw))
				}, func(h api.Host) string { return describeHost(c, h) })
			},
		},
		{
			Name:    "host add",
			Summary: "Make a one-use join token, and print the command to run on the new machine (or run it over SSH)",
			Flags: []cli.Flag{
				{Name: "name", Type: cli.String, Value: "<name>", Description: "The host's name"},
				{Name: "label", Type: cli.String, Multiple: true, Value: "<k=v>", Description: "A label; repeat for more"},
				{Name: "pool", Type: cli.String, Value: "<pool>", Description: "The pool it joins, an ID or name; default the default pool"},
				{Name: "expires-minutes", Type: cli.String, Value: "<n>", Description: "How long the token works (default 60)"},
				{Name: "ssh", Type: cli.String, Value: "<user@machine>", Description: "Run the join command on that machine now, over ssh"},
			},
			Details: "The machine needs Linux with /dev/kvm for microVMs, curl and root. It dials out to the control plane, so it\n" +
				"needs no open port. The command it prints runs the host installer from Kantel's latest release:\n" +
				"  curl -fsSL " + HostInstallerURL + " | sudo sh -s -- --url <kantel> --token kth_…\n" +
				"which kantel-admin host join runs too.",
			Examples: []cli.Example{
				{What: "Print the command that joins a new machine", Line: "kantel-admin host add --name builder-1 --label zone=ams"},
				{What: "Join a machine over SSH", Line: "kantel-admin host add --name builder-1 --ssh root@builder-1"},
			},
			Run: func(c *cli.Context) error { return hostAdd(c, sys) },
		},
		{
			Name:    "host join",
			Summary: "Run on a new Linux machine, as root: install kantel-host and join it to Kantel",
			Flags:   []cli.Flag{{Name: "token", Type: cli.String, Value: "<kth_…>", Description: "The join token from kantel-admin host add"}},
			Rest:    "installer options", RestOptional: true,
			Details: "  sudo kantel-admin host join --url https://kantel.example.com --token kth_…\n" +
				"It runs the host installer from Kantel's latest release (KANTEL_HOST_INSTALLER_URL runs another), which\n" +
				"downloads kantel-host, checks its SHA-256 and runs kantel-host install: that checks /dev/kvm, copies the\n" +
				"binary to /usr/local/bin, fetches Firecracker and the images and starts the kantel-host service. Anything\n" +
				"after -- goes to it, such as -- --tiers isolate --isolate-runtime native on a machine without KVM.",
			Run: func(c *cli.Context) error { return hostJoin(c, sys) },
		},
		{
			Name:     "host run",
			Summary:  "Run kantel-host on this machine: doctor, status, update, uninstall",
			Rest:     "kantel-host args…",
			Examples: []cli.Example{{What: "Check this machine and its kantel-host", Line: "kantel-admin host run -- doctor"}},
			Run: func(c *cli.Context) error {
				if len(c.Rest) == 0 {
					return cli.Usage("give kantel-host's command after --, such as: host run -- doctor")
				}
				if err := linuxOnly(sys); err != nil {
					return err
				}
				ran, err := sys.Spawn(c.Ctx, "kantel-host", c.Rest, SpawnOptions{})
				if errors.Is(err, exec.ErrNotFound) {
					return cli.Fail("kantel-host isn't installed on this machine: join it first, with kantel-admin host join")
				}
				if err != nil {
					return err
				}
				return exit(ran.Code)
			},
		},
		{
			Name:    "host drain",
			Summary: "Stop placing new sandboxes on a host (--off to take them again)",
			Args:    hostIDArg,
			Flags: []cli.Flag{
				{Name: "off", Type: cli.Bool, Description: "Take new sandboxes again"},
				{Name: "undo", Type: cli.Bool, Description: "The same as --off", Hidden: true},
			},
			Run: func(c *cli.Context) error {
				off := c.Bool("off") || c.Bool("undo")
				return hostCall(c, func(client *api.Client, raw *json.RawMessage) (*api.Host, error) {
					return client.UpdateHost(c.Ctx, c.Arg(0), api.UpdateHostBody{Draining: api.Ptr(!off)}, api.Raw(raw))
				}, hostState(c))
			},
		},
		{
			Name:    "host move",
			Summary: "Move a host to another pool: it drains, and moves once it has no sandboxes",
			Args:    []cli.Arg{{Name: "hostId"}, {Name: "pool"}},
			Details: "It takes no new sandboxes from now on, and joins the pool (an ID or name) once its last sandbox is deleted;\n" +
				"then it takes new sandboxes again. Moving it to the pool it is in cancels a move, leaving it draining.",
			Run: func(c *cli.Context) error {
				pool := c.Arg(1)
				return hostCall(c, func(client *api.Client, raw *json.RawMessage) (*api.Host, error) {
					return client.UpdateHost(c.Ctx, c.Arg(0), api.UpdateHostBody{Pool: &pool}, api.Raw(raw))
				}, func(h api.Host) string {
					if h.MovingTo != nil {
						return h.ID + " draining, moving to " + *h.MovingTo
					}
					return h.ID + " in " + deref(h.PoolID) + " " + c.Style.State(string(h.State))
				})
			},
		},
		{
			Name:    "host update",
			Summary: "Update a host's kantel-host to the version it should run, over its connection",
			Args:    hostIDArg,
			Details: "The version is KANTEL_HOST_VERSION when it's set, otherwise Kantel's latest release (`host list` shows it beside a " +
				"host that's behind). The host fetches it, checks it against the release's SHA256SUMS and restarts; its sandboxes " +
				"keep running. On the machine itself, use `host run -- update`.",
			Run: func(c *cli.Context) error {
				return hostCall(c, func(client *api.Client, raw *json.RawMessage) (*api.Host, error) {
					return client.UpdateHostAgent(c.Ctx, c.Arg(0), api.Raw(raw))
				}, func(h api.Host) string {
					to := "the latest"
					if h.Updating != nil {
						to = h.Updating.Version
					} else if h.LatestVersion != nil {
						to = *h.LatestVersion
					}
					return h.ID + " updating to " + to
				})
			},
		},
		{
			Name:    "host check-for-updates",
			Summary: "Read Kantel's latest kantel-host release again now, rather than within the hour",
			Details: "Hosts behind a release just published then show as out of date in `host list` at once. At most one check every " +
				"30 seconds; within it nothing more is read.",
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				found, err := client.CheckHostUpdates(c.Ctx, api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, found, func() string {
					latest := "none read"
					if found.LatestVersion != nil {
						latest = *found.LatestVersion
					}
					if found.Checked {
						return "latest kantel-host: " + latest
					}
					return "checked in the last 30 seconds; latest kantel-host: " + latest
				})
				return nil
			},
		},
		{
			Name:    "host revoke",
			Usage:   "host revoke <hostId> --yes",
			Summary: "Revoke a host's credential and close its connection",
			Args:    hostIDArg,
			Flags:   []cli.Flag{{Name: "yes", Type: cli.Bool, Short: "y", Description: "Yes, revoke it"}},
			Details: "Its sandboxes keep their disks but can't be reached until it joins again with a new token.",
			Run: func(c *cli.Context) error {
				id := c.Arg(0)
				if !c.Bool("yes") {
					return cli.Usage("to revoke " + id + ", run: kantel-admin host revoke " + id + " --yes")
				}
				return hostCall(c, func(client *api.Client, raw *json.RawMessage) (*api.Host, error) {
					return client.RevokeHost(c.Ctx, id, api.Raw(raw))
				}, hostState(c))
			},
		},
	}}
}

func hostAdd(c *cli.Context, sys System) error {
	labels := map[string]string{}
	for _, item := range c.List("label") {
		k, v, ok := strings.Cut(item, "=")
		if !ok || k == "" {
			return cli.Usage(`--label takes key=value, not "` + item + `"`)
		}
		labels[k] = v
	}
	body := api.CreateHostJoinTokenBody{}
	if name, ok := c.Str("name"); ok {
		body.Name = &name
	}
	if pool, ok := c.Str("pool"); ok {
		body.Pool = &pool
	}
	if len(labels) > 0 {
		body.Labels = labels
	}
	if minutes, ok := c.Str("expires-minutes"); ok {
		n, err := strconv.ParseInt(minutes, 10, 64)
		if !wholeValue.MatchString(minutes) || err != nil {
			return cli.Usage("--expires-minutes is a whole number")
		}
		body.ExpiresInMinutes = &n
	}
	client, err := Client(c)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	token, err := client.CreateHostJoinToken(c.Ctx, body, api.Raw(&raw))
	if err != nil {
		return err
	}
	if target, ok := c.Str("ssh"); ok {
		c.Note("kantel-admin: joining " + target + " (ssh " + target + " " + redact(token.Command, token.Token) + ")")
		ran, err := sys.Spawn(c.Ctx, "ssh", []string{"-t", target, token.Command}, SpawnOptions{})
		if err != nil {
			return err
		}
		if ran.Code == 0 {
			c.Note("kantel-admin: it has joined: kantel-admin host list")
		}
		return exit(ran.Code)
	}
	c.Emit(raw, token, func() string {
		return strings.Join([]string{
			"Run this on the machine as root, before " + cli.Timestamp(token.ExpiresAt) + ":", "", "  " + token.Command,
		}, "\n")
	})
	return nil
}

func hostJoin(c *cli.Context, sys System) error {
	url, hasURL := c.Str("url")
	token, hasToken := c.Str("token")
	if !hasURL || !hasToken {
		return cli.Usage("give both: kantel-admin host join --url <kantel> --token <kth_…>")
	}
	if !sys.IsRoot {
		return cli.Fail("joining installs a system service, so it needs root: sudo kantel-admin host join …")
	}
	if err := linuxOnly(sys); err != nil {
		return err
	}
	installer := c.IO.Env.Get("KANTEL_HOST_INSTALLER_URL")
	if installer == "" {
		installer = HostInstallerURL
	}
	script, err := fetchScript(c, installer, "the host installer")
	if err != nil {
		return err
	}
	base, err := cli.NormaliseURL(url)
	if err != nil {
		return err
	}
	args := append([]string{"--url", cli.Origin(base), "--token", token}, c.Rest...)
	c.Note("kantel-admin: running " + installer + " " + redact(strings.Join(args, " "), token))
	ran, err := sys.Spawn(c.Ctx, "sh", append([]string{"-s", "--"}, args...), SpawnOptions{Input: &script})
	if err != nil {
		return err
	}
	return exit(ran.Code)
}
