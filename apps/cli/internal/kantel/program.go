// Package kantel is the kantel command line: a table of commands, from which its help, its JSON description, its
// completion and the docs' command reference are made. Each section of the help is a file of its own here.
package kantel

import (
	"fmt"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// GlobalFlags are the flags every command takes.
var GlobalFlags = []cli.Flag{
	{Name: "url", Type: cli.String, Value: "<url>", Description: "Kantel's URL (KANTEL_URL; default " + cli.DefaultURL + ")"},
	{Name: "key", Type: cli.String, Value: "<key>", Description: "A personal access token or API key (KANTEL_API_KEY); also --api-key"},
	{Name: "api-key", Type: cli.String, Value: "<key>", Description: "The same as --key", Hidden: true},
	{Name: "account", Type: cli.String, Value: "<id|name>", Description: "The account to act in, by ID or name (KANTEL_ACCOUNT); default the one kantel org use saved"},
	{Name: "json", Type: cli.Bool, Description: "Print Kantel's JSON answer as it is"},
	{Name: "help", Type: cli.Bool, Short: "h", Description: "Show a command's help"},
}

// Program is the kantel command line.
func Program() *cli.Program {
	p := &cli.Program{
		Name:        "kantel",
		Version:     Version,
		Tagline:     "Kantel's sandboxes from a terminal or a coding agent.",
		GlobalFlags: GlobalFlags,
		Groups: []cli.Group{
			{Name: "sandbox", Summary: "Create, inspect, stop and delete sandboxes (the same as kantel new, list, info, stop…)"},
			{Name: "files", Summary: "Read, write and list a sandbox's files"},
			{Name: "port", Summary: "Give a sandbox's ports HTTPS URLs"},
			{Name: "snapshot", Summary: "Take, save, browse and delete snapshots"},
			{Name: "env", Summary: "Environments: the variables, protected secrets, files, repos and grants new sandboxes start with"},
			{Name: "key", Summary: "Make, rotate and revoke scoped API keys"},
			{Name: "token", Summary: "Your personal access tokens, which act as you in every account"},
			{Name: "org", Summary: "Your accounts and organisations: which one commands act in, and their settings"},
			{Name: "member", Summary: "An organisation's members and their roles"},
			{Name: "invite", Summary: "Invite people to an organisation"},
			{Name: "webhook", Summary: "Send the account's events to a URL"},
			{Name: "telemetry", Summary: "Send the account's metrics and events to OpenTelemetry"},
			{Name: "hosts", Summary: "Run your sandboxes on machines of your own (experimental)"},
			{Name: "agent", Summary: "Set up coding agents to use Kantel"},
		},
		SandboxGroup: "sandbox",
		GroupAliases: map[string]string{"sb": "sandbox"},
		Aliases: map[string]string{
			"ls": "list", "rm": "delete", "create": "new", "get": "info",
			"sandbox create": "new", "sandbox new": "new", "sandbox list": "list", "sandbox ls": "list",
			"sandbox get": "info", "sandbox info": "info", "sandbox stop": "stop", "sandbox resume": "resume",
			"sandbox fork": "fork", "sandbox delete": "delete", "sandbox rm": "delete", "sandbox extend": "extend",
			"sandbox usage": "usage", "put": "files put",
		},
		Deprecated: map[string]string{
			"put": "kantel files put <id> <local> <remote> (a file of up to 1 MiB), or kantel scp <local> <id>:<remote> for bigger files and directories",
		},
		Moved: map[string]string{
			"host list":       "kantel-admin host list (your own hosts: kantel hosts list)",
			"host join-token": "kantel-admin host add (a host of your own: kantel hosts add)",
		},
		SubcommandAliases: map[string]string{"ls": "list", "list": "ls", "rm": "delete", "delete": "rm"},
		ExitCodes: map[int]string{
			cli.ExitOK:     "it worked",
			cli.ExitFailed: "it failed: the error's code says why",
			cli.ExitUsage:  "it was used wrongly, and did nothing",
			cli.ExitSignIn: "it needs a credential that works: kantel login, or KANTEL_API_KEY",
		},
		Hint:     Hint,
		Complete: complete,
	}
	p.Sections = []cli.Section{
		signingIn(),
		sandboxes(),
		commandsAndFiles(),
		access(),
		snapshots(),
		environments(),
		keys(),
		accounts(),
		events(),
		ownHosts(),
		codingAgents(),
		{Title: "Help", Commands: []*cli.Command{
			cli.HelpCommand(p),
			cli.VersionCommand(p),
			cli.CompletionCommand(p, "kantel's commands, flags and sandbox IDs"),
			updateCommand(),
		}},
	}
	p.Footer = []string{
		`Aliases: ls for list, rm for delete. "kantel help <command>" shows a command's flags and examples.`,
		"kantel help --json describes every command for a script or an agent; kantel completion sets up your shell.",
		"Exit codes: 0 it worked, 1 it failed, 2 it was used wrongly, 4 it needs kantel login.",
		"Operators of a self-hosted Kantel (install, upgrade, hosts): kantel-admin help.",
	}
	return p
}

// complete offers the sandboxes for an argument that is one: the account's, newest first, within two seconds and with
// no retries, from the same settings the command would use, so a credential never goes to a URL it wasn't given for.
func complete(c *cli.Context, arg cli.Arg) []cli.Candidate {
	switch arg.Name {
	case "id", "sandbox", "sandboxId":
	default:
		return nil
	}
	s, err := Settings(c)
	if err != nil || s.APIKey == "" {
		return nil
	}
	client := ClientFor(c, s)
	client.RetryDelays = []time.Duration{}
	ctx, cancel := withTimeout(c, 2*time.Second)
	defer cancel()
	c.Ctx = ctx
	account, err := Account(c)
	if err != nil {
		return nil
	}
	query := &api.ListSandboxesQuery{All: api.Ptr(true)}
	if account != "" {
		query.Account = &account
	}
	page, err := client.ListSandboxes(ctx, query)
	if err != nil {
		return nil
	}
	var out []cli.Candidate
	for _, sb := range page.Items {
		out = append(out, cli.Candidate{Value: sb.ID, Description: fmt.Sprintf("%s (%s)", sb.Name, sb.State)})
	}
	return out
}
