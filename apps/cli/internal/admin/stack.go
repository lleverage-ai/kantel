package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/cli/internal/cli"
)

// The control plane: installing, upgrading and restarting the stack, its health, its settings and its first key.

// installerFlags are the installer's own options, passed on as they are.
var installerFlags = []cli.Flag{
	{Name: "email", Type: cli.String, Value: "<address>", Description: "The first admin, who signs in"},
	{Name: "ref", Type: cli.String, Value: "<ref>", Description: "A branch, tag or commit instead of main"},
	{Name: "repo", Type: cli.String, Value: "<owner/name>", Description: "Another repository, such as your fork"},
	{Name: "tarball", Type: cli.String, Value: "<path|url>", Description: "A .tar.gz of the source instead of GitHub"},
	{Name: "no-open", Type: cli.Bool, Description: "Don't open the console in a browser"},
}

var applyFlag = cli.Flag{Name: "apply", Type: cli.Bool, Description: "Restart the stack with it now (kantel-admin apply)"}

func runInstaller(c *cli.Context, sys System, upgrade bool) error {
	var args []string
	for _, name := range []string{"email", "ref", "repo", "tarball"} {
		if v, ok := c.Str(name); ok {
			args = append(args, "--"+name, v)
		}
	}
	if home, ok := c.Str("home"); ok {
		args = append(args, "--home", home)
	}
	if c.Bool("no-open") {
		args = append(args, "--no-open")
	}
	if upgrade {
		args = append(args, "--upgrade")
	}
	args = append(args, c.Rest...)
	url := c.IO.Env.Get("KANTEL_INSTALLER_URL")
	if url == "" {
		url = InstallerURL
	}
	script, err := fetchScript(c, url, "the installer")
	if err != nil {
		return err
	}
	c.Note(strings.TrimRight("kantel-admin: running "+url+" "+strings.Join(args, " "), " "))
	ran, err := sys.Spawn(c.Ctx, "sh", append([]string{"-s", "--"}, args...), SpawnOptions{Input: &script})
	if err != nil {
		return err
	}
	return exit(ran.Code)
}

// fetchScript is a script to run: a path or file: URL is read, anything else downloaded.
func fetchScript(c *cli.Context, url, what string) (string, error) {
	if strings.HasPrefix(url, "/") || strings.HasPrefix(url, "file:") {
		raw, err := os.ReadFile(strings.TrimPrefix(url, "file://"))
		return string(raw), err
	}
	req, err := http.NewRequestWithContext(c.Ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", cli.Usage(fmt.Sprintf(`%s's URL "%s" isn't a URL`, what, url))
	}
	req.Header.Set("User-Agent", UserAgent())
	res, err := httpClient(c).Do(req)
	if err != nil {
		return "", cli.Fail(fmt.Sprintf("couldn't download %s from %s: %v", what, url, err))
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", cli.Fail(fmt.Sprintf("couldn't download %s from %s: HTTP %d", what, url, res.StatusCode))
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", cli.Fail(fmt.Sprintf("couldn't download %s from %s: %v", what, url, err))
	}
	return string(body), nil
}

func httpClient(c *cli.Context) *http.Client {
	if c.IO.HTTP != nil {
		return c.IO.HTTP
	}
	return http.DefaultClient
}

// stackSettings are the stack's .env: its path, its text and its settings. No .env is no settings, as long as Kantel
// is installed there.
func stackSettings(c *cli.Context) (path, text string, settings EnvSettings, err error) {
	dir := composeDir(c)
	path = filepath.Join(dir, ".env")
	raw, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return "", "", nil, err
		}
		if _, statErr := os.ReadFile(filepath.Join(dir, "compose.yaml")); statErr != nil {
			return "", "", nil, cli.Fail("there is no Kantel install in " + kantelHome(c) +
				": run kantel-admin install (or give --home)")
		}
	}
	text = string(raw)
	return path, text, ParseEnvFile(text), nil
}

// changeSettings writes changes to .env, and restarts the stack with them for --apply.
func changeSettings(c *cli.Context, sys System, changes Changes) error {
	path, text, _, err := stackSettings(c)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(UpdateEnvFile(text, changes)), 0o600); err != nil {
		return err
	}
	// A secret shows as (set) in JSON too, as it does to a person: a script's log is no place for a password.
	shown := make(Changes, 0, len(changes))
	for _, ch := range changes {
		if ch.Value != nil {
			v := shownValue(ch.Key, *ch.Value)
			ch.Value = &v
		}
		shown = append(shown, ch)
	}
	value := struct {
		Path    string  `json:"path"`
		Changed Changes `json:"changed"`
	}{path, shown}
	c.Emit(nil, value, func() string {
		lines := []string{"Updated " + path + ":"}
		for _, ch := range changes {
			if ch.Value == nil {
				lines = append(lines, "  "+ch.Key+" removed")
			} else {
				lines = append(lines, "  "+ch.Key+"="+shownValue(ch.Key, *ch.Value))
			}
		}
		return strings.Join(lines, "\n")
	})
	if c.Bool("apply") {
		return applySettings(c, sys)
	}
	if !c.JSON {
		c.Note("It takes effect with: kantel-admin apply")
	}
	return nil
}

// compose runs docker compose with the stack's compose.yaml, its stdout captured or ours.
func compose(c *cli.Context, sys System, capture bool, args ...string) (Ran, error) {
	file := filepath.Join(composeDir(c), "compose.yaml")
	return sys.Spawn(c.Ctx, "docker", append([]string{"compose", "-f", file}, args...), SpawnOptions{Capture: capture})
}

// applySettings starts the stack with its settings as they are: Compose recreates the containers whose settings changed.
func applySettings(c *cli.Context, sys System) error {
	if _, _, _, err := stackSettings(c); err != nil {
		return err
	}
	c.Note("kantel-admin: restarting the stack with its settings (docker compose up -d --wait)")
	ran, err := compose(c, sys, false, "up", "-d", "--wait")
	if err != nil {
		return err
	}
	if ran.Code != 0 {
		return cli.Fail("the stack didn't start: see kantel-admin status, and docker compose logs")
	}
	return nil
}

var settingPair = regexp.MustCompile(`(?s)^([A-Z][A-Z0-9_]*)=(.*)$`)

func controlPlane(sys System) cli.Section {
	return cli.Section{Title: "The control plane", Commands: []*cli.Command{
		{
			Name:    "install",
			Summary: "Install Kantel's control plane on this machine (Docker Compose), with kantel.dev's installer",
			Flags:   installerFlags,
			Rest:    "installer options", RestOptional: true,
			Details: "It downloads https://kantel.dev/install.sh and runs it, passing these options on; anything after -- goes\n" +
				"to it too. KANTEL_INSTALLER_URL runs another copy, such as a path in a checkout.",
			Examples: []cli.Example{{What: "Install Kantel, with you as its first admin", Line: "kantel-admin install --email you@example.com"}},
			Run:      func(c *cli.Context) error { return runInstaller(c, sys, false) },
		},
		{
			Name:         "upgrade",
			Summary:      "Download Kantel again and rebuild the stack with it, keeping its settings and data",
			Flags:        installerFlags,
			Rest:         "installer options",
			RestOptional: true,
			Run:          func(c *cli.Context) error { return runInstaller(c, sys, true) },
		},
		{
			Name:    "apply",
			Summary: "Restart the stack with its current settings, without downloading Kantel again",
			Run:     func(c *cli.Context) error { return applySettings(c, sys) },
		},
		{
			Name:    "status",
			Summary: "Whether the control plane runs and answers, and its compute settings",
			Details: "It exits 1 when the console doesn't answer.",
			Run:     func(c *cli.Context) error { return status(c, sys) },
		},
		{
			Name:    "bootstrap-key",
			Summary: "The deployment's first compute key (every scope, hosts:admin too)",
			Flags:   []cli.Flag{{Name: "save", Type: cli.Bool, Description: "Sign kantel and kantel-admin in with it instead of printing it"}},
			Details: "It reads the key the control plane wrote in its gateway container. With --save it checks the key and saves it\n" +
				"with the local URL in kantel's config, as kantel login does. Keep it to yourself: make scoped keys for\n" +
				"people, scripts and agents with kantel key create.",
			Examples: []cli.Example{{What: "Sign kantel and kantel-admin in with it", Line: "kantel-admin bootstrap-key --save"}},
			Run:      func(c *cli.Context) error { return bootstrapKey(c, sys) },
		},
	}}
}

func settings(sys System) cli.Section {
	return cli.Section{Title: "Settings", Commands: []*cli.Command{
		{
			Name:    "config list",
			Summary: "The stack's settings (secrets show as (set))",
			Run: func(c *cli.Context) error {
				path, _, settings, err := stackSettings(c)
				if err != nil {
					return err
				}
				shown := make(EnvSettings, len(settings))
				rows := make([]cli.Field, len(settings))
				for i, kv := range settings {
					shown[i] = Setting{kv.Key, shownValue(kv.Key, kv.Value)}
					rows[i] = cli.Field{kv.Key, shown[i].Value}
				}
				c.Emit(nil, orderedObject(shown), func() string {
					if len(rows) == 0 {
						return path + " sets nothing."
					}
					return cli.Fields(c.Style, rows)
				})
				return nil
			},
		},
		{
			Name:    "config set",
			Usage:   "config set <KEY=value>…",
			Summary: "Change the stack's settings in deploy/compose/.env",
			Args:    []cli.Arg{{Name: "KEY=value", Optional: true, Variadic: true}},
			Flags:   []cli.Flag{applyFlag},
			Examples: []cli.Example{{What: "Set the URL hosts and people reach Kantel at, and restart the stack with it",
				Line: "kantel-admin config set KANTEL_PUBLIC_URL=https://kantel.example.com --apply"}},
			Run: func(c *cli.Context) error {
				if len(c.Args) == 0 {
					return cli.Usage("give KEY=value: kantel-admin config set KANTEL_PUBLIC_URL=https://…")
				}
				var changes Changes
				for _, pair := range c.Args {
					m := settingPair.FindStringSubmatch(pair)
					if m == nil {
						return cli.Usage(`"` + pair + `" isn't KEY=value`)
					}
					if strings.ContainsAny(m[2], "\n\r") {
						return cli.Usage(m[1] + "'s value has a line break")
					}
					value := m[2]
					changes.Set(m[1], &value)
				}
				return changeSettings(c, sys, changes)
			},
		},
		{
			Name:    "config unset",
			Usage:   "config unset <KEY>…",
			Summary: "Remove settings from deploy/compose/.env",
			Args:    []cli.Arg{{Name: "KEY", Optional: true, Variadic: true}},
			Flags:   []cli.Flag{applyFlag},
			Run: func(c *cli.Context) error {
				if len(c.Args) == 0 {
					return cli.Usage("give the keys to remove")
				}
				var changes Changes
				for _, key := range c.Args {
					changes.Set(key, nil)
				}
				return changeSettings(c, sys, changes)
			},
		},
		{
			Name:    "compute enable",
			Summary: "Run sandboxes on your own hosts (the default), optionally reached at a public URL",
			Details: "The compute API is always on, and sandboxes run on the hosts you add. This undoes KANTEL_COMPUTE_BACKEND=stub\n" +
				"and drops the old KANTEL_COMPUTE switch. Hosts on other machines need --public-url: without it, only a host\n" +
				"on this machine can join, at the local address.",
			Flags: []cli.Flag{
				{Name: "public-url", Type: cli.String, Value: "<url>",
					Description: "Where hosts and people reach the control plane, such as https://kantel.example.com"},
				{Name: "hosts", Type: cli.Bool, Description: "Accepted for older scripts: hosts are the default"},
				applyFlag,
			},
			Examples: []cli.Example{{What: "Let hosts on other machines join, at a public URL",
				Line: "kantel-admin compute enable --public-url https://kantel.example.com --apply"}},
			Run: func(c *cli.Context) error {
				_, _, settings, err := stackSettings(c)
				if err != nil {
					return err
				}
				var changes Changes
				for _, key := range []string{"KANTEL_COMPUTE", "KANTEL_COMPUTE_BACKEND"} {
					if _, ok := settings.Get(key); ok {
						changes.Set(key, nil)
					}
				}
				if public, ok := c.Str("public-url"); ok {
					u, err := cli.NormaliseURL(public)
					if err != nil {
						return err
					}
					origin := cli.Origin(u)
					changes.Set("KANTEL_PUBLIC_URL", &origin)
				}
				return changeSettings(c, sys, changes)
			},
		},
	}}
}

func status(c *cli.Context, sys System) error {
	path, _, settings, err := stackSettings(c)
	if err != nil {
		return err
	}
	url := localURL(c, settings)
	healthy := false
	ctx, cancel := context.WithTimeout(c.Ctx, 10*time.Second)
	defer cancel()
	if req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/healthz", nil); err == nil {
		if res, err := httpClient(c).Do(req); err == nil {
			_, _ = io.Copy(io.Discard, res.Body)
			res.Body.Close()
			healthy = res.StatusCode >= 200 && res.StatusCode <= 299
		}
	}
	ps, err := compose(c, sys, true, "ps", "--format", "{{.Service}} {{.State}}")
	if err != nil {
		return err
	}
	total, running := 0, 0
	for _, line := range strings.Split(ps.Stdout, "\n") {
		if line == "" {
			continue
		}
		total++
		if parts := strings.Split(line, " "); len(parts) > 1 && parts[1] == "running" {
			running++
		}
	}
	backend := "hosts"
	if b, _ := settings.Get("KANTEL_COMPUTE_BACKEND"); b == "stub" {
		backend = "stub"
	}
	type services struct {
		Running int `json:"running"`
		Total   int `json:"total"`
	}
	value := struct {
		Home     string   `json:"home"`
		Settings string   `json:"settings"`
		URL      string   `json:"url"`
		Healthy  bool     `json:"healthy"`
		Services services `json:"services"`
		// Always on since the console became the compute console; the field stays for scripts that read it.
		Compute        string  `json:"compute"`
		ComputeBackend string  `json:"computeBackend"`
		PublicURL      *string `json:"publicUrl,omitempty"`
	}{Home: kantelHome(c), Settings: path, URL: url, Healthy: healthy, Services: services{running, total},
		Compute: "on", ComputeBackend: backend}
	if public, ok := settings.Get("KANTEL_PUBLIC_URL"); ok {
		value.PublicURL = &public
	}
	c.Emit(nil, value, func() string {
		answering := "not answering"
		if healthy {
			answering = "answering"
		}
		described := "your hosts"
		if backend != "hosts" {
			described = "the built-in stand-in (no hosts)"
		}
		public := "none: hosts on this machine join at " + url
		if value.PublicURL != nil {
			public = *value.PublicURL
		}
		return cli.Fields(c.Style, []cli.Field{
			{"home", value.Home},
			{"console", url + " (" + answering + ")"},
			{"services", fmt.Sprintf("%d of %d running", running, total)},
			{"backend", described},
			{"public URL", public},
		})
	})
	if !healthy {
		return cli.ExitCode(cli.ExitFailed)
	}
	return nil
}

func bootstrapKey(c *cli.Context, sys System) error {
	_, _, settings, err := stackSettings(c)
	if err != nil {
		return err
	}
	ran, err := compose(c, sys, true, "exec", "-T", "gateway", "sh", "-c", "cat /var/lib/*/bootstrap.json")
	if err != nil {
		return err
	}
	if ran.Code != 0 {
		return cli.Fail("couldn't read the gateway's bootstrap.json: is the stack running? (kantel-admin status)")
	}
	var file map[string]any
	if err := json.Unmarshal([]byte(ran.Stdout), &file); err != nil {
		return cli.Fail("the gateway's bootstrap.json isn't JSON")
	}
	key, ok := file["computeKey"].(string)
	if !ok {
		return cli.Fail("there is no compute key yet: kantel-admin upgrade, then try again")
	}
	if !c.Bool("save") {
		c.Emit(nil, map[string]string{"key": key}, func() string { return key })
		return nil
	}
	// The local URL: this runs on the control plane's machine, which may not reach its own public URL.
	url, err := cli.NormaliseURL(localURL(c, settings))
	if err != nil {
		return err
	}
	caller, err := clientFor(c, url, key).GetCaller(c.Ctx)
	if err != nil {
		return err
	}
	stored, err := cli.ReadStored(c.IO.ConfigDir)
	if err != nil {
		return err
	}
	stored.URL, stored.APIKey, stored.Account = url, key, ""
	path, err := cli.WriteStored(c.IO.ConfigDir, stored)
	if err != nil {
		return err
	}
	value := struct {
		URL       string `json:"url"`
		AccountID string `json:"accountId"`
		Path      string `json:"path"`
	}{url, caller.AccountID, path}
	c.Emit(nil, value, func() string { return "Saved the bootstrap key for " + cli.Origin(url) + " to " + path + "." })
	return nil
}
