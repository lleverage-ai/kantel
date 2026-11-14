package admin

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// Moving every sandbox off a draining host, so it can be updated, resized or retired.

// evacuationPoll is how often host evacuate --wait reads the evacuation again.
const evacuationPoll = 3 * time.Second

// evacuationLine is an evacuation's progress in a line: "running: 3 moved, 4 to go, 1 skipped".
func evacuationLine(e api.HostEvacuation) string {
	line := string(e.State) + ": " + strconv.FormatInt(e.Moved, 10) + " moved"
	if e.Remaining > 0 {
		line += ", " + strconv.FormatInt(e.Remaining, 10) + " to go"
	}
	if e.Skipped > 0 {
		line += ", " + strconv.FormatInt(e.Skipped, 10) + " skipped"
	}
	if e.Failed > 0 {
		line += ", " + strconv.FormatInt(e.Failed, 10) + " failed"
	}
	if e.Reason != nil {
		line += " (" + *e.Reason + ")"
	}
	return line
}

// evacuationTable is an evacuation's line, then a row for each of its sandboxes.
func evacuationTable(c *cli.Context, e api.HostEvacuation) string {
	if len(e.Sandboxes) == 0 {
		return evacuationLine(e) + "\nNo sandboxes were on the host."
	}
	rows := make([][]string, 0, len(e.Sandboxes))
	for _, s := range e.Sandboxes {
		state := string(s.State)
		if s.Phase != nil {
			state += " (" + string(*s.Phase) + ")"
		}
		to := deref(s.HostID)
		if s.KeptMemory != nil && *s.KeptMemory {
			to += ", memory kept"
		}
		rows = append(rows, []string{s.SandboxID, deref(s.Name), c.Style.State(state), to, deref(s.Reason)})
	}
	return evacuationLine(e) + "\n" + cli.Table(c.Style, []string{"SANDBOX", "NAME", "STATE", "TO", "REASON"}, rows)
}

func evacuationCommands() []*cli.Command {
	return []*cli.Command{
		{
			Name:    "host evacuate",
			Summary: "Drain a host and move its sandboxes off, to other hosts in its pool",
			Args:    hostIDArg,
			Flags:   []cli.Flag{{Name: "wait", Type: cli.Bool, Description: "Follow it until it ends"}},
			Details: "Moves each running, stopped and paused sandbox, two at a time, as kantel move does by default: keeping its\n" +
				"memory where the hosts match, restarting it otherwise. Those that can't move are skipped, with the reason.\n" +
				"It carries on in Kantel without this command; host evacuation <hostId> shows how far it has got, and\n" +
				"host drain <hostId> --off stops it.",
			Examples: []cli.Example{
				{What: "Empty a host before retiring it", Line: "kantel-admin host evacuate host_6t5r4e --wait"},
			},
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				e, err := client.StartHostEvacuation(c.Ctx, c.Arg(0), api.Raw(&raw))
				if err != nil {
					return err
				}
				if c.Bool("wait") {
					return followEvacuation(c, client, *e)
				}
				c.Emit(raw, e, func() string { return evacuationTable(c, *e) })
				return nil
			},
		},
		{
			Name:    "host evacuation",
			Summary: "How far moving a host's sandboxes off has got",
			Args:    hostIDArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				e, err := client.GetHostEvacuation(c.Ctx, c.Arg(0), api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, e, func() string { return evacuationTable(c, *e) })
				return nil
			},
		},
	}
}

// followEvacuation reads the evacuation until it ends, noting each change of its progress, then prints it; it exits 1
// when it failed.
func followEvacuation(c *cli.Context, client *api.Client, e api.HostEvacuation) error {
	last := ""
	for {
		if line := evacuationLine(e); line != last && e.State == api.HostEvacuationStateRunning {
			c.Note("kantel-admin: " + line)
			last = line
		}
		if e.State != api.HostEvacuationStateRunning {
			break
		}
		if err := sleep(c, evacuationPoll); err != nil {
			return err
		}
		var raw json.RawMessage
		next, err := client.GetHostEvacuation(c.Ctx, e.HostID, api.Raw(&raw))
		if err != nil {
			return err
		}
		e = *next
	}
	c.Emit(nil, e, func() string { return evacuationTable(c, e) })
	if e.State == api.HostEvacuationStateFailed {
		return exit(1)
	}
	return nil
}

func sleep(c *cli.Context, d time.Duration) error {
	if c.IO.Sleep != nil {
		return c.IO.Sleep(c.Ctx, d)
	}
	select {
	case <-c.Ctx.Done():
		return c.Ctx.Err()
	case <-time.After(d):
		return nil
	}
}
