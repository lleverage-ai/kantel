package kantel

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/lleverage-ai/kantel/apps/cli/internal/api"
	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

var (
	viewOnlyFlag = cli.Flag{Name: "view-only", Type: cli.Bool, Description: "Watch only: no keyboard or mouse"}
	viewTTLFlag  = cli.Flag{Name: "ttl", Type: cli.String, Value: "<minutes>", Description: "How long the URL can be opened for (default 10, at most 60)"}
	printURLFlag = cli.Flag{Name: "print", Type: cli.Bool, Description: "Print the URL without opening it"}
	publicFlag   = cli.Flag{Name: "public", Type: cli.Bool, Description: "Anyone with the URL may open it, with no token"}
	idPortArgs   = []cli.Arg{{Name: "id"}, {Name: "port"}}
)

// openIfPerson opens url in the browser when a person is at a terminal, and hasn't asked for the URL only.
func openIfPerson(c *cli.Context, url string) {
	if c.Bool("print") || c.JSON || !c.IO.StdoutTTY || c.IO.Env.Get("KANTEL_NO_BROWSER") != "" || c.IO.OpenURL == nil {
		return
	}
	c.IO.OpenURL(url)
}

// viewAccessBody is desktop's and browser's --view-only and --ttl.
func viewAccessBody(c *cli.Context) (api.ViewAccessBody, error) {
	ttl, err := Whole(c, "ttl", 1)
	return api.ViewAccessBody{ViewOnly: TruePtr(c, "view-only"), TTLMinutes: ttl}, err
}

// exposePort is host (and the older port expose): the port's URL.
func exposePort(c *cli.Context) error {
	port, err := WholeOf(c.Arg(1), "port", 1)
	if err != nil {
		return err
	}
	client, err := Client(c)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	exposed, err := client.ExposePort(c.Ctx, c.Arg(0), api.ExposePortBody{Port: *port, Public: TruePtr(c, "public")}, api.Raw(&raw))
	if err != nil {
		return err
	}
	c.Emit(raw, exposed, func() string { return exposed.URL })
	return nil
}

func access() cli.Section {
	return cli.Section{Title: "Ports, SSH, desktop and browser", Commands: []*cli.Command{
		{
			Name: "host", Summary: "Give a port in a sandbox an HTTPS URL, and print it", Args: idPortArgs,
			Flags: []cli.Flag{publicFlag},
			Details: "The URL carries a token unless --public: anyone holding the whole URL can open it. Asking again for the\n" +
				"same port gives the same URL. Start the server first, with kantel exec <id> --detach -- <command>.\n" +
				"kantel port list shows a sandbox's ports, and kantel port hide <id> <port> stops one working.",
			Examples: []cli.Example{
				{What: "A private HTTPS URL for port 3000 (it carries a token)", Line: "kantel host sbx_4kq9x2mt 3000"},
				{What: "One anyone may open", Line: "kantel host sbx_4kq9x2mt 8080 --public"},
			},
			Run: exposePort,
		},
		{
			Name: "port expose", Hidden: true, Summary: "Give a port in a sandbox an HTTPS URL", Args: idPortArgs,
			Flags: []cli.Flag{publicFlag}, Run: exposePort,
		},
		{
			Name: "port list", Summary: "A sandbox's exposed ports", Args: IDArg,
			Run: func(c *cli.Context) error {
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				ports, err := client.ListPorts(c.Ctx, c.Arg(0), api.Raw(&raw))
				if err != nil {
					return err
				}
				c.Emit(raw, ports, func() string {
					if len(ports.Items) == 0 {
						return "No exposed ports."
					}
					var rows [][]string
					for _, p := range ports.Items {
						public := "no"
						if p.Public {
							public = "yes"
						}
						rows = append(rows, []string{fmt.Sprint(p.Port), p.URL, public})
					}
					return cli.Table(c.Style, []string{"PORT", "URL", "PUBLIC"}, rows)
				})
				return nil
			},
		},
		{
			Name: "port hide", Summary: "Stop a port's URL working", Args: idPortArgs,
			Run: func(c *cli.Context) error {
				port, err := WholeOf(c.Arg(1), "port", 1)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				if err := client.HidePort(c.Ctx, c.Arg(0), fmt.Sprint(*port)); err != nil {
					return err
				}
				c.Emit(nil, map[string]int64{"hidden": *port}, func() string { return fmt.Sprintf("Port %d is hidden.", *port) })
				return nil
			},
		},
		sshCommand(),
		{
			Name:    "ssh-proxy",
			Summary: "ssh's ProxyCommand through Kantel's relay (kantel ssh runs it)",
			// Plumbing for the ssh command kantel ssh prints: `kantel help ssh-proxy` still shows it.
			Hidden: true,
			Flags:  []cli.Flag{{Name: "url", Type: cli.String, Value: "<wss-url>", Description: "The answer's proxyUrl (default " + SSHURLEnv + ")"}},
			Run: func(c *cli.Context) error {
				flag, given := c.Str("url")
				url, err := proxyURLOf(flag, given, c.IO.Env)
				if err != nil {
					return cli.Usage(err.Error())
				}
				return cli.ExitCode(pipeTunnel(c.Ctx, url, c.IO.Stdin, c.IO.Stdout, c.IO.Stderr))
			},
		},
		{
			Name: "desktop", Summary: "Open a microVM's desktop in your browser, and print its URL", Args: IDArg,
			Flags:   []cli.Flag{viewOnlyFlag, viewTTLFlag, printURLFlag},
			Details: "The URL carries a short-lived token: treat it as a secret.",
			Run: func(c *cli.Context) error {
				body, err := viewAccessBody(c)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				access, err := client.OpenDesktop(c.Ctx, c.Arg(0), body, api.Raw(&raw))
				if err != nil {
					return err
				}
				openIfPerson(c, access.URL)
				c.Emit(raw, access, func() string { return access.URL })
				return nil
			},
		},
		{
			Name:    "browser",
			Summary: "Start a microVM's Chromium: open its live view, and print that URL and its CDP URL",
			Args:    IDArg,
			Flags:   []cli.Flag{viewOnlyFlag, viewTTLFlag, printURLFlag},
			Details: "Drive it with Playwright: chromium.connectOverCDP(<cdp URL>). Both URLs carry short-lived tokens.",
			Run: func(c *cli.Context) error {
				body, err := viewAccessBody(c)
				if err != nil {
					return err
				}
				client, err := Client(c)
				if err != nil {
					return err
				}
				var raw json.RawMessage
				access, err := client.OpenBrowser(c.Ctx, c.Arg(0), body, api.Raw(&raw))
				if err != nil {
					return err
				}
				openIfPerson(c, access.URL)
				c.Emit(raw, access, func() string {
					return cli.Fields(c.Style, []cli.Field{{"view", access.URL}, {"cdp", access.CDPURL}})
				})
				return nil
			},
		},
	}}
}

func sshCommand() *cli.Command {
	return &cli.Command{
		Name:         "ssh",
		Summary:      "SSH into a microVM, or run one command there over SSH",
		Args:         IDArg,
		Rest:         "command…",
		RestOptional: true,
		Flags: []cli.Flag{
			{Name: "print", Type: cli.Bool, Description: "Print the ssh command that connects, rather than running it"},
			// Connecting was --exec when printing was the default; it still parses.
			{Name: "exec", Type: cli.Bool, Description: "Run ssh now (the default)", Hidden: true},
			{Name: "public-key", Type: cli.String, Value: "<file>", Description: "Let in this OpenSSH public key (default: a key pair Kantel makes, kept here)"},
			{Name: "ttl", Type: cli.String, Value: "<minutes>", Description: "How long a connection can be started (default 10, at most 60)"},
		},
		Details: "Connects in this terminal, through the control plane's relay when the sandbox is on its own hosts. After --,\n" +
			"a command runs there instead of a shell, and kantel exits with its exit code: kantel ssh <id> -- uname -a.\n" +
			"--print (or --json) prints the ssh command with its key and options, for scp, rsync or an ssh config entry.",
		Examples: []cli.Example{
			{What: "A shell", Line: "kantel ssh sbx_4kq9x2mt"},
			{What: "One command", Line: "kantel ssh sbx_4kq9x2mt -- docker ps"},
			{What: "The ssh command, for an editor's remote setup", Line: "kantel ssh sbx_4kq9x2mt --print"},
		},
		Run: runSSHCommand,
	}
}

var unsafeFileChars = regexp.MustCompile(`[^\w.-]`)

// sshShown is what ssh --print shows through the relay; the private key stays in its file, out of the output.
type sshShown struct {
	User               string  `json:"user"`
	Command            string  `json:"command"`
	IdentityFile       string  `json:"identityFile,omitempty"`
	HostKeyFingerprint *string `json:"hostKeyFingerprint,omitempty"`
	ExpiresAt          int64   `json:"expiresAt"`
}

// sshShownDirect is what ssh --print shows through an SSH gateway.
type sshShownDirect struct {
	Host               string  `json:"host"`
	Port               int64   `json:"port"`
	User               string  `json:"user"`
	Command            string  `json:"command"`
	IdentityFile       string  `json:"identityFile,omitempty"`
	HostKeyFingerprint *string `json:"hostKeyFingerprint,omitempty"`
	ExpiresAt          int64   `json:"expiresAt"`
}

func runSSHCommand(c *cli.Context) error {
	sandboxID := c.Arg(0)
	remote := c.Rest
	print := c.Bool("print") || c.JSON
	if print && len(remote) > 0 {
		return cli.Usage("--print prints the ssh command; give it no command")
	}
	// ssh joins its command's words with spaces for the remote shell, so each is quoted to arrive as it is.
	var remoteArgs []string
	if len(remote) > 0 {
		remoteArgs = []string{"--", CommandLine(remote)}
	}
	body := api.SSHAccessBody{}
	if keyPath, ok := c.Str("public-key"); ok {
		if !filepath.IsAbs(keyPath) {
			keyPath = filepath.Join(c.IO.Cwd, keyPath)
		}
		key, err := os.ReadFile(keyPath)
		if err != nil {
			return err
		}
		trimmed := strings.TrimSpace(string(key))
		body.PublicKey = &trimmed
	}
	ttl, err := Whole(c, "ttl", 1)
	if err != nil {
		return err
	}
	body.TTLMinutes = ttl
	client, err := Client(c)
	if err != nil {
		return err
	}
	access, err := client.OpenSSH(c.Ctx, sandboxID, body)
	if err != nil {
		return err
	}
	dir := filepath.Join(c.IO.ConfigDir, "ssh")
	// A key pair Kantel made is shown once: keep its private half where ssh can use it.
	identityFile := ""
	if access.PrivateKey != nil {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		identityFile = filepath.Join(dir, unsafeFileChars.ReplaceAllString(sandboxID, "_"))
		privateKey := *access.PrivateKey
		if !strings.HasSuffix(privateKey, "\n") {
			privateKey += "\n"
		}
		if err := os.WriteFile(identityFile, []byte(privateKey), 0o600); err != nil {
			return err
		}
		if err := os.Chmod(identityFile, 0o600); err != nil {
			return err
		}
	}
	if access.ProxyURL != nil {
		// No SSH gateway: through the relay, with this CLI as ssh's ProxyCommand (sshproxy.go).
		tunnel := tunnelAccess{User: access.User, ProxyURL: *access.ProxyURL}
		self := c.IO.Self
		if self == "" {
			self = "kantel"
		}
		options := tunnelOptions{
			Self: []string{self}, SandboxID: sandboxID,
			KnownHosts: filepath.Join(dir, "known_hosts"), IdentityFile: identityFile,
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		if !print {
			return runSSH(c, append(tunnelSSHArgs(tunnel, options), remoteArgs...), map[string]string{SSHURLEnv: *access.ProxyURL})
		}
		options.Self = []string{"kantel"}
		command := tunnelSSHCommand(tunnel, options)
		shown := sshShown{User: access.User, Command: command, IdentityFile: identityFile,
			HostKeyFingerprint: access.HostKeyFingerprint, ExpiresAt: access.ExpiresAt}
		c.Emit(nil, shown, func() string {
			return command + "\n(start it by " + cli.Timestamp(access.ExpiresAt) + "; once connected it stays open)"
		})
		return nil
	}
	var args []string
	if identityFile != "" {
		args = append(args, "-i", identityFile, "-o", "IdentitiesOnly=yes")
	}
	args = append(args, "-p", fmt.Sprint(access.Port), access.User+"@"+access.Host)
	command := access.Command
	if identityFile != "" {
		quoted := []string{"ssh"}
		for _, a := range args {
			quoted = append(quoted, ShellQuote(a))
		}
		command = strings.Join(quoted, " ")
	}
	if !print {
		return runSSH(c, append(args, remoteArgs...), nil)
	}
	shown := sshShownDirect{Host: access.Host, Port: access.Port, User: access.User, Command: command,
		IdentityFile: identityFile, HostKeyFingerprint: access.HostKeyFingerprint, ExpiresAt: access.ExpiresAt}
	c.Emit(nil, shown, func() string { return command + "\n(it works until " + cli.Timestamp(access.ExpiresAt) + ")" })
	return nil
}

// runSSH runs the system's ssh with args in this terminal, and exits with its exit code: 127 when there is no ssh, 1
// when a signal ended it. env is added to this process's environment for it.
func runSSH(c *cli.Context, args []string, env map[string]string) error {
	cmd := exec.Command("ssh", args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = c.IO.Stdin, c.IO.Stdout, c.IO.Stderr
	if env != nil {
		cmd.Env = os.Environ()
		for k, v := range env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	// ssh has the terminal: a Ctrl-C is its to act on, and kantel waits for its exit code. (Caught, not ignored, so
	// ssh doesn't inherit ignoring it.)
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &exit):
		if code := exit.ExitCode(); code >= 0 {
			return cli.ExitCode(code)
		}
		return cli.ExitCode(cli.ExitFailed)
	}
	c.Note("kantel: couldn't run ssh: " + err.Error())
	return cli.ExitCode(127)
}
