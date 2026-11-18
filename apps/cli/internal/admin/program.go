// Package admin is kantel-admin, the command for whoever runs a self-hosted Kantel. It installs and upgrades the
// control plane (by running kantel.dev's install.sh, never a copy of it), changes the stack's settings in
// ~/.kantel/src/deploy/compose/.env, reads the first compute key, and adds, lists, drains and revokes the Linux hosts
// that run sandboxes. `host join`, run as root on a new machine, runs the release's host installer (install.sh), which
// downloads kantel-host, checks its SHA-256 and runs its `install`.
//
// The API commands use the same settings as kantel: --url and --key, KANTEL_URL and KANTEL_API_KEY, or the file
// kantel login writes, but default to the local gateway rather than the hosted one. They need a key with hosts:admin,
// which a deployment's first compute key has.
package admin

import (
	"path/filepath"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// Version is kantel-admin's version, stamped at release (-ldflags -X …/internal/admin.Version=0.4.0).
var Version = "0.0.0"

// UserAgent is sent on every call.
func UserAgent() string { return "kantel-admin/" + Version }

const (
	// InstallerURL is where the installer comes from; KANTEL_INSTALLER_URL changes it.
	InstallerURL = "https://kantel.dev/install.sh"
	// HostInstallerURL is the host installer host join runs, from Kantel's latest GitHub Release;
	// KANTEL_HOST_INSTALLER_URL changes it.
	HostInstallerURL = "https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh"
	// defaultPort is the control plane's port on 127.0.0.1 unless KANTEL_GATEWAY_PORT says otherwise.
	defaultPort = "58090"
)

// GlobalFlags are the flags every command takes.
var GlobalFlags = []cli.Flag{
	{Name: "url", Type: cli.String, Value: "<url>", Description: "Kantel's URL (KANTEL_URL), for the API commands"},
	{Name: "key", Type: cli.String, Value: "<key>", Description: "An API key with hosts:admin (KANTEL_API_KEY)"},
	{Name: "home", Type: cli.String, Value: "<dir>", Description: "Where Kantel is installed (KANTEL_HOME, default ~/.kantel)"},
	{Name: "json", Type: cli.Bool, Description: "Print JSON"},
	{Name: "help", Type: cli.Bool, Short: "h", Description: "Show a command's help"},
}

// Program is the kantel-admin command line, running child processes and checking the machine with sys.
func Program(sys System) *cli.Program {
	p := &cli.Program{
		Name:        "kantel-admin",
		Version:     Version,
		Tagline:     "run a self-hosted Kantel and its hosts.",
		GlobalFlags: GlobalFlags,
		Groups: []cli.Group{
			{Name: "config", Summary: "The stack's settings"},
			{Name: "compute", Summary: "Run sandboxes on your own hosts"},
			{Name: "host", Summary: "The machines that run sandboxes"},
			{Name: "pool", Summary: "Sets of the shared hosts, each host in one"},
			{Name: "grant-key", Summary: "The key hosts' fetch grants are signed with"},
		},
		ExitCodes: map[int]string{
			cli.ExitOK:     "it worked (install, upgrade, host join, host run and host add --ssh exit with the code of what they ran)",
			cli.ExitFailed: "it failed: the error's code says why",
			cli.ExitUsage:  "it was used wrongly, and did nothing",
			cli.ExitSignIn: "it needs a key with hosts:admin: kantel-admin bootstrap-key --save, or KANTEL_API_KEY",
		},
		Hint: Hint,
	}
	version := cli.VersionCommand(p)
	version.Summary = "kantel-admin's version (also --version)"
	p.Sections = []cli.Section{
		controlPlane(sys),
		settings(sys),
		hosts(sys),
		pools(),
		grantKey(),
		{Title: "Help", Commands: []*cli.Command{
			cli.HelpCommand(p),
			version,
			cli.CompletionCommand(p, "kantel-admin's commands and flags"),
		}},
	}
	p.Footer = []string{
		`"kantel-admin help <command>" shows a command's flags; kantel-admin help --json describes every command.`,
		"Exit codes: 0 it worked, 1 it failed, 2 it was used wrongly, 4 it needs a key with hosts:admin.",
		"Sandboxes themselves are the kantel command's: kantel help.",
	}
	return p
}

// Hint says what to do about one of Kantel's errors, where there is something to do.
func Hint(e *api.Error) string {
	switch e.Code {
	case "forbidden":
		return "Host commands need a key with hosts:admin."
	case "unauthenticated":
		return "Sign in with: kantel-admin bootstrap-key --save, or set KANTEL_API_KEY"
	}
	return ""
}

// kantelHome is where Kantel is installed: --home, else KANTEL_HOME, else ~/.kantel.
func kantelHome(c *cli.Context) string {
	if home, ok := c.Str("home"); ok {
		return home
	}
	if home := c.IO.Env.Get("KANTEL_HOME"); home != "" {
		return home
	}
	return filepath.Join(c.IO.Home, ".kantel")
}

// composeDir is <home>/src/deploy/compose, where the installer keeps the stack.
func composeDir(c *cli.Context) string {
	return filepath.Join(kantelHome(c), "src", "deploy", "compose")
}

// gatewayPort is the local gateway's port: KANTEL_GATEWAY_PORT, else the stack's setting, else the default.
func gatewayPort(c *cli.Context, settings EnvSettings) string {
	if port := c.IO.Env.Get("KANTEL_GATEWAY_PORT"); port != "" {
		return port
	}
	if port, _ := settings.Get("KANTEL_GATEWAY_PORT"); port != "" {
		return port
	}
	return defaultPort
}

// localURL is the console on this machine. Compose takes a setting from the environment before .env, so this does too.
func localURL(c *cli.Context, settings EnvSettings) string {
	return "http://127.0.0.1:" + gatewayPort(c, settings)
}

// Client is the command's client: --url and --key, else KANTEL_URL and KANTEL_API_KEY, else kantel's config, and the
// local gateway rather than kantel's hosted default: a key for a self-hosted gateway shouldn't go anywhere else.
func Client(c *cli.Context) (*api.Client, error) {
	stored, err := cli.ReadStored(c.IO.ConfigDir)
	if err != nil {
		return nil, err
	}
	url, _ := c.Str("url")
	key, _ := c.Str("key")
	s, err := cli.Resolve(cli.Settings{URL: url, APIKey: key}, c.IO.Env, stored, localURL(c, nil))
	if err != nil {
		return nil, err
	}
	if s.APIKey == "" {
		return nil, &cli.Error{
			Message: "this needs a key with hosts:admin: kantel-admin bootstrap-key --save, or KANTEL_URL and KANTEL_API_KEY",
			Code:    "unauthenticated", Exit: cli.ExitSignIn,
		}
	}
	return clientFor(c, s.URL, s.APIKey), nil
}

func clientFor(c *cli.Context, url, key string) *api.Client {
	return &api.Client{BaseURL: url, Token: key, UserAgent: UserAgent(), HTTP: c.IO.HTTP, Sleep: c.IO.Sleep}
}

// exit is a child's exit code as the command's own.
func exit(code int) error {
	if code == 0 {
		return nil
	}
	return cli.ExitCode(code)
}
