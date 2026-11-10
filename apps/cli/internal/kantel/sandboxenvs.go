package kantel

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// A sandbox's environments, in the "Environments and egress" section: kantel env list --sandbox, and attaching or
// detaching one on a sandbox that exists.

const sandboxEnvironmentsDetails = "A sandbox's environments are in order: where two set the same variable, secret file or repo path,\n" +
	"the later one wins, and the sandbox's own variables (kantel new -e K=V) win over them all. Their grants\n" +
	"add up. In the table of them, SHADOWED is what of an environment a later one sets instead, PENDING says\n" +
	"its secret files and repos are set up when the sandbox next runs, and POSITION is what kantel env attach\n" +
	"--position takes."

// sandboxEnvironmentTable is kantel env list --sandbox, and what attach and detach answer: the sandbox's environments
// in order.
func sandboxEnvironmentTable(c *cli.Context, list api.SandboxEnvironments) string {
	if len(list.Environments) == 0 {
		return list.SandboxID + " has no environments. Attach one: kantel env attach " + list.SandboxID + " <env>"
	}
	var rows [][]string
	shadowed, pending := false, false
	for i, e := range list.Environments {
		lost := shadowedText(e.Shadowed)
		waiting := ""
		if e.Pending {
			waiting = "yes"
			pending = true
		}
		shadowed = shadowed || lost != ""
		rows = append(rows, []string{fmt.Sprint(i), e.ID, e.Name, lost, waiting})
	}
	out := cli.Table(c.Style, []string{"POSITION", "ID", "NAME", "SHADOWED", "PENDING"}, rows)
	var notes []string
	if shadowed {
		notes = append(notes, "Shadowed: set instead by a later environment, or by the sandbox's own variables.")
	}
	if pending {
		notes = append(notes, "Pending: its secret files and repos are set up when the sandbox next runs.")
	}
	if len(notes) > 0 {
		out += "\n\n" + strings.Join(notes, "\n")
	}
	return out
}

// shadowedText is what of an environment the sandbox takes from elsewhere: `variables A, B; files /a; repos app`.
func shadowedText(s api.SandboxEnvironmentShadowed) string {
	var parts []string
	for _, p := range []struct {
		what  string
		items []string
	}{{"variables", s.Variables}, {"files", s.Files}, {"repos", s.Repos}} {
		if len(p.items) > 0 {
			parts = append(parts, p.what+" "+strings.Join(p.items, ", "))
		}
	}
	return strings.Join(parts, "; ")
}

// sandboxEnvironmentNames is a sandbox's environments' names by ID, for kantel info: nil when it has none or Kantel
// doesn't answer them, and info then shows their IDs alone.
func sandboxEnvironmentNames(c *cli.Context, client *api.Client, s api.Sandbox) map[string]string {
	if len(environmentIDsOf(s)) == 0 {
		return nil
	}
	list, err := client.ListSandboxEnvironments(c.Ctx, s.ID)
	if err != nil {
		return nil
	}
	names := map[string]string{}
	for _, e := range list.Environments {
		names[e.ID] = e.Name
	}
	return names
}

// sandboxEnvironmentNamed is the environment ref (an ID or name) among the sandbox's, as `npm (env_2)`; ref itself
// when it isn't one of them.
func sandboxEnvironmentNamed(list api.SandboxEnvironments, ref string) string {
	for _, e := range list.Environments {
		if e.ID == ref || e.Name == ref {
			return e.Name + " (" + e.ID + ")"
		}
	}
	return ref
}

func envAttachCommand() *cli.Command {
	return &cli.Command{
		Name: "env attach", Summary: "Add an environment to a sandbox that exists, last unless --position says otherwise",
		Args: []cli.Arg{{Name: "sandbox"}, {Name: "env"}},
		Flags: []cli.Flag{{Name: "position", Type: cli.String, Value: "<n>",
			Description: "Where it goes: 0 is first, so every other one wins over it (default last, so it wins)"}},
		Details: "Its variables, protected variables and grants apply at once: new commands see them, and on a host that\n" +
			"supports it so do new shells, while running processes keep what they started with. A running sandbox\n" +
			"gets its secret files and repos now, a stopped one when it next runs. Attaching one the sandbox has\n" +
			"already moves it to --position. A sandbox has at most 10. An API key needs the exec scope.\n\n" +
			sandboxEnvironmentsDetails,
		Examples: []cli.Example{
			{What: "Add npm last, so it wins over the others", Line: "kantel env attach sbx_4kq9x2mt npm"},
			{What: "Add backend first, so the others win over it", Line: "kantel env attach sbx_4kq9x2mt backend --position 0"},
		},
		Run: func(c *cli.Context) error {
			position, err := Whole(c, "position", 0)
			if err != nil {
				return err
			}
			client, err := Client(c)
			if err != nil {
				return err
			}
			sandbox, ref := c.Arg(0), c.Arg(1)
			var raw json.RawMessage
			var list *api.SandboxEnvironments
			err = c.Spin("Attaching "+ref+" to "+sandbox+"…", func() error {
				list, err = client.AttachSandboxEnvironment(c.Ctx, sandbox,
					api.AttachSandboxEnvironmentBody{Environment: ref, Position: position}, api.Raw(&raw))
				return err
			})
			if err != nil {
				return err
			}
			c.Emit(raw, list, func() string {
				return "Attached " + sandboxEnvironmentNamed(*list, ref) + " to " + list.SandboxID + ".\n\n" +
					sandboxEnvironmentTable(c, *list)
			})
			return nil
		},
	}
}

func envDetachCommand() *cli.Command {
	return &cli.Command{
		Name: "env detach", Summary: "Take an environment off a sandbox",
		Args: []cli.Arg{{Name: "sandbox"}, {Name: "env"}},
		Details: "Its variables are worked out again without it, its protected variables stop resolving at once and its\n" +
			"grants go. The secret files it wrote and the repos it cloned stay in the sandbox. An API key needs the\n" +
			"exec scope.",
		Examples: []cli.Example{{What: "Take npm off a sandbox", Line: "kantel env detach sbx_4kq9x2mt npm"}},
		Run: func(c *cli.Context) error {
			client, err := Client(c)
			if err != nil {
				return err
			}
			sandbox, ref := c.Arg(0), c.Arg(1)
			id, named := ref, ref
			// Kantel detaches by ID. A name is looked for among the sandbox's own environments, which needn't be in the
			// account this command acts in.
			if !strings.HasPrefix(ref, "env_") {
				had, err := client.ListSandboxEnvironments(c.Ctx, sandbox)
				if err != nil {
					return err
				}
				id = ""
				for _, e := range had.Environments {
					if e.Name == ref {
						id, named = e.ID, e.Name+" ("+e.ID+")"
					}
				}
				if id == "" {
					return cli.Fail(fmt.Sprintf(`%s has no environment called "%s": kantel env ls --sandbox %s shows its environments`,
						sandbox, ref, sandbox))
				}
			}
			var raw json.RawMessage
			list, err := client.DetachSandboxEnvironment(c.Ctx, sandbox, id, api.Raw(&raw))
			if err != nil {
				return err
			}
			c.Emit(raw, list, func() string {
				return "Detached " + named + " from " + list.SandboxID + ".\n\n" + sandboxEnvironmentTable(c, *list)
			})
			return nil
		},
	}
}
