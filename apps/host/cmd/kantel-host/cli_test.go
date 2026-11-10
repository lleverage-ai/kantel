package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
)

// cli runs kantel-host with args, as main does, and returns what it wrote and its exit status.
func cli(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	var out, errOut bytes.Buffer
	stdout, stderr = &out, &errOut
	defer func() { stdout, stderr = os.Stdout, os.Stderr }()
	code := exit(dispatch(args))
	return out.String(), errOut.String(), code
}

// Go's own help: "Usage of install:" and single-dash flags with their types.
var goHelp = regexp.MustCompile(`(?m)Usage of |^\s+-[a-z][a-z-]+( string| int| value| duration)?$`)

func TestHelp(t *testing.T) {
	for _, args := range [][]string{{"help"}, {"--help"}, {"-h"}, {"help", "help"}} {
		out, errOut, code := cli(t, args...)
		if code != 0 || errOut != "" {
			t.Errorf("%v: exit %d, stderr %q", args, code, errOut)
		}
		for _, want := range []string{"Usage: kantel-host <command> [flags]", "\nSetting up:\n", "\nRunning:\n", "\nInternal:\n",
			"\n  install ", "\n  logs ", "\n  sandboxes show <id> ", "\nFlags:\n", "-V, --version", "kantel stop"} {
			if !strings.Contains(out, want) {
				t.Errorf("%v: no %q in\n%s", args, want, out)
			}
		}
		if strings.Contains(out, "kantel sandbox stop") {
			t.Errorf("%v: the old command name", args)
		}
	}
	// With no command at all: the help, but as a mistake.
	if out, errOut, code := cli(t); code != 2 || out != "" || !strings.Contains(errOut, "Usage: kantel-host <command>") {
		t.Errorf("no command: exit %d, %q", code, errOut)
	}
}

func TestCommandHelp(t *testing.T) {
	for _, c := range commands {
		if c.name == "help" {
			continue
		}
		words := strings.Fields(c.name)
		for _, args := range [][]string{append(append([]string{}, words...), "--help"), append(append([]string{}, words...), "-h"), append([]string{"help"}, words...)} {
			out, errOut, code := cli(t, args...)
			if code != 0 || errOut != "" {
				t.Errorf("%v: exit %d, stderr %q", args, code, errOut)
				continue
			}
			if !strings.HasPrefix(out, "Usage: kantel-host "+c.name) || !strings.Contains(out, "\n"+c.summary+".\n") || !strings.Contains(out, "\nFlags:\n") {
				t.Errorf("%v:\n%s", args, out)
			}
			if goHelp.MatchString(out) {
				t.Errorf("%v: Go's help format:\n%s", args, out)
			}
		}
	}
	out, _, _ := cli(t, "install", "--help")
	for _, want := range []string{
		"Usage: kantel-host install --url <kantel> --token <kth_…> [flags]",
		"  --url <URL>  ", "  --label <key=value>  ", "  --dry-run  ",
		"--root <directory>", "(default /var/lib/kantel-host)", "--config <file>", "(default /etc/kantel-host/config.json)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("install help has no %q:\n%s", want, out)
		}
	}
	// The environment isn't a default: help would print the token.
	t.Setenv("KANTEL_HOST_TOKEN", "kth_secret")
	if out, _, _ := cli(t, "install", "--help"); strings.Contains(out, "kth_secret") {
		t.Errorf("help shows the token:\n%s", out)
	}
	out, _, _ = cli(t, "logs", "--help")
	if !strings.Contains(out, "  -f, --follow  ") || !strings.Contains(out, "  -n, --lines <n>  ") {
		t.Errorf("logs help:\n%s", out)
	}
	if out, _, _ := cli(t, "update", "--help"); strings.Contains(out, "--config") {
		t.Errorf("update's hidden --config shown:\n%s", out)
	}
	if out, _, _ := cli(t, "status", "--help"); !strings.Contains(out, "3 when it isn't") {
		t.Errorf("status's help doesn't give its exit:\n%s", out)
	}
}

func TestUnknownCommand(t *testing.T) {
	for _, args := range [][]string{{"nope"}, {"help", "nope"}, {"--nope"}} {
		out, errOut, code := cli(t, args...)
		want := "kantel-host: there is no command \"" + args[len(args)-1] + "\". \"kantel-host help\" lists them.\n"
		if code != 2 || out != "" || errOut != want {
			t.Errorf("%v: exit %d, stdout %q, stderr %q", args, code, out, errOut)
		}
	}
}

// Every usage error is the message and the usage line on stderr, and exit 2, before the command does anything.
func TestUsageErrors(t *testing.T) {
	for _, tc := range []struct {
		args []string
		msg  string
		cmd  string
	}{
		{[]string{"install", "--bogus"}, "unknown flag --bogus", "install --url <kantel> --token <kth_…>"},
		{[]string{"plan", "--url"}, "--url needs a value", "plan --url <kantel> --token <kth_…>"},
		{[]string{"install", "builder-1"}, "install takes options only", "install --url <kantel> --token <kth_…>"},
		{[]string{"doctor", "--nope"}, "unknown flag --nope", "doctor"},
		{[]string{"doctor", "extra"}, `doctor takes no arguments, and got "extra"`, "doctor"},
		{[]string{"status", "extra"}, `status takes no arguments, and got "extra"`, "status"},
		{[]string{"update", "0.3.0"}, `update takes no arguments, and got "0.3.0"`, "update"},
		{[]string{"uninstall", "now"}, `uninstall takes no arguments, and got "now"`, "uninstall"},
		{[]string{"uninstall", "--bogus"}, "unknown flag --bogus", "uninstall"},
		{[]string{"sandboxes", "sb_1"}, `unexpected "sb_1"`, "sandboxes"},
		{[]string{"sandboxes", "show"}, "sandboxes show needs <id>", "sandboxes show <id>"},
		{[]string{"sandboxes", "show", "a", "b"}, "sandboxes show takes one <id>, and got 2", "sandboxes show <id>"},
		{[]string{"logs", "-n", "x"}, `invalid value "x" for -n`, "logs"},
		{[]string{"logs", "-x"}, "unknown flag -x", "logs"},
		{[]string{"logs", "--lines=-1"}, "--lines must be 0 or more", "logs"},
		{[]string{"bench", "--runs", "many"}, `invalid value "many" for --runs`, "bench"},
		{[]string{"bench", "extra"}, `bench takes no arguments`, "bench"},
		{[]string{"run", "extra"}, `run takes no arguments`, "run"},
		{[]string{"manifest"}, "manifest needs <dir>", "manifest <dir>"},
		{[]string{"manifest", "a", "b"}, "manifest takes one <dir>, and got 2", "manifest <dir>"},
		{[]string{"version", "--bogus"}, "unknown flag --bogus", "version"},
	} {
		out, errOut, code := cli(t, tc.args...)
		usage := "\nUsage: kantel-host " + tc.cmd + " [flags]\n"
		if code != 2 || out != "" || !strings.HasPrefix(errOut, "kantel-host: "+tc.msg) || !strings.HasSuffix(errOut, usage) {
			t.Errorf("%v: exit %d, stdout %q, stderr %q", tc.args, code, out, errOut)
		}
	}
}

func TestVersion(t *testing.T) {
	for _, arg := range []string{"version", "--version", "-V", "-v"} {
		if out, errOut, code := cli(t, arg); code != 0 || out != version+"\n" || errOut != "" {
			t.Errorf("%s: exit %d, %q %q", arg, code, out, errOut)
		}
	}
	out, _, code := cli(t, "version", "--json")
	var v map[string]string
	if err := json.Unmarshal([]byte(out), &v); err != nil || code != 0 {
		t.Fatalf("version --json: %v, exit %d: %s", err, code, out)
	}
	if v["version"] != version || v["go"] != runtime.Version() || v["os"] != runtime.GOOS || v["arch"] != runtime.GOARCH || len(v) != 4 {
		t.Errorf("version --json: %v", v)
	}
}

// status: its JSON, and exit 3 while the service isn't active, so a script can check it.
func TestStatus(t *testing.T) {
	dir := t.TempDir()
	socket := filepath.Join(dir, "agent.sock")
	stop, err := agent.ServeControl(socket, fakeSandboxes{{ID: "sb_1", State: "running"}, {ID: "sb_2", State: "running"}, {ID: "sb_3", State: "stopped"}}, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	config := filepath.Join(dir, "config.json")
	if err := (agent.Config{ControlPlane: "https://kantel.example.com", HostID: "host_1", ControlSocket: socket}).Save(config); err != nil {
		t.Fatal(err)
	}
	state := "active"
	was := serviceState
	serviceState = func() string { return state }
	defer func() { serviceState = was }()

	out, errOut, code := cli(t, "status", "--json", "--config", config)
	var got statusReport
	if err := json.Unmarshal([]byte(out), &got); err != nil || code != 0 || errOut != "" {
		t.Fatalf("status --json: %v, exit %d, %q: %s", err, code, errOut, out)
	}
	want := statusReport{Version: version, ControlPlane: "https://kantel.example.com", HostID: "host_1", Service: "active",
		Sandboxes: map[string]int{"running": 2, "stopped": 1}}
	if !reflectEqualJSON(t, got, want) {
		t.Errorf("status --json: %+v, want %+v", got, want)
	}
	out, _, code = cli(t, "status", "--config", config)
	if code != 0 || !strings.Contains(out, "service       active\n") || !strings.Contains(out, "sandboxes     3 (2 running, 1 stopped)\n") {
		t.Errorf("status: exit %d\n%s", code, out)
	}

	// The service stopped: no socket.
	state = "inactive"
	if err := (agent.Config{ControlPlane: "https://kantel.example.com", HostID: "host_1", ControlSocket: socket + ".gone"}).Save(config); err != nil {
		t.Fatal(err)
	}
	out, errOut, code = cli(t, "status", "--config", config, "--json")
	if code != 3 || errOut != "" {
		t.Errorf("status of a stopped service: exit %d, %q", code, errOut)
	}
	got = statusReport{}
	if err := json.Unmarshal([]byte(out), &got); err != nil || got.Service != "inactive" || got.Sandboxes != nil || !strings.Contains(got.SandboxesError, "no control socket") {
		t.Errorf("status --json of a stopped service: %v %+v", err, got)
	}
	if !strings.Contains(out, `"sandboxes": null`) {
		t.Errorf("sandboxes isn't null:\n%s", out)
	}
	if out, _, code := cli(t, "status", "--config", config); code != 3 || !strings.Contains(out, "service       inactive\n") {
		t.Errorf("status of a stopped service: exit %d\n%s", code, out)
	}
	// Without systemd, the service is no state at all: not active either.
	state = ""
	if _, _, code := cli(t, "status", "--config", config); code != 3 {
		t.Errorf("status without systemd: exit %d", code)
	}
}

func reflectEqualJSON(t *testing.T, a, b any) bool {
	t.Helper()
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

// uninstall --purge deletes what can't be got back: it needs --yes, and says what it would delete and how.
func TestPurgeNeedsYes(t *testing.T) {
	config := filepath.Join(t.TempDir(), "config.json")
	if err := (agent.Config{Root: "/srv/kh"}).Save(config); err != nil {
		t.Fatal(err)
	}
	out, errOut, code := cli(t, "uninstall", "--purge")
	if code != 2 || out != "" || !strings.Contains(errOut, "To do it, run: sudo kantel-host uninstall --purge --yes\n") ||
		!strings.Contains(errOut, "/etc/kantel-host/config.json") || !strings.Contains(errOut, binPath) ||
		!strings.HasSuffix(errOut, "\nUsage: kantel-host uninstall [flags]\n") {
		t.Errorf("--purge alone: exit %d\n%s", code, errOut)
	}
	_, errOut, code = cli(t, "uninstall", "--config", config, "--purge")
	if code != 2 || !strings.Contains(errOut, "(/srv/kh)") || !strings.Contains(errOut, "run: sudo kantel-host uninstall --config "+config+" --purge --yes\n") {
		t.Errorf("--purge with --config: exit %d\n%s", code, errOut)
	}
	if os.Geteuid() != 0 {
		// Past the guard, and refused for not being root: nothing is uninstalled here.
		if _, errOut, code := cli(t, "uninstall", "--config", config, "--purge", "--yes"); code != 1 || errOut != "kantel-host: uninstall needs root\n" {
			t.Errorf("--purge --yes: exit %d, %q", code, errOut)
		}
	}
}

func TestDoctorFix(t *testing.T) {
	root := hostinfo.Check{Name: "root", State: hostinfo.StateFail, Required: true, MicroVM: true, Detail: "kantel-host runs as root", Fix: "run it as root, with sudo: sudo kantel-host doctor"}
	ok := hostinfo.Check{Name: "cp", OK: true, State: hostinfo.StateOK, Required: true, MicroVM: true, Detail: "cp"}
	var out bytes.Buffer
	printChecks(&out, []hostinfo.Check{root, ok}, false)
	lines := strings.Split(out.String(), "\n")
	if !strings.HasPrefix(lines[0], "FAIL    root") || strings.TrimSpace(lines[1]) != "to fix: run it as root, with sudo: sudo kantel-host doctor" ||
		!strings.HasPrefix(lines[2], "ok      cp") || strings.Index(lines[1], "to fix") != strings.Index(lines[0], "kantel-host runs") {
		t.Errorf("doctor:\n%s", out.String())
	}
	// The JSON as it was, with fix only where there is one.
	raw, _ := json.Marshal([]hostinfo.Check{root, ok})
	if !strings.Contains(string(raw), `"fix":"run it as root`) || strings.Count(string(raw), `"fix"`) != 1 {
		t.Errorf("doctor --json: %s", raw)
	}
}

func TestLogs(t *testing.T) {
	if got := strings.Join(journalArgs(false, -1), " "); got != "-u kantel-host" {
		t.Errorf("logs: %q", got)
	}
	if got := strings.Join(journalArgs(true, 50), " "); got != "-u kantel-host -f -n 50" {
		t.Errorf("logs -f -n 50: %q", got)
	}
	// -n 0 with --follow: only what comes next.
	if got := strings.Join(journalArgs(true, 0), " "); got != "-u kantel-host -f -n 0" {
		t.Errorf("logs -f -n 0: %q", got)
	}
	echo, err := exec.LookPath("echo")
	if err != nil {
		t.Skip("needs echo")
	}
	was := journalctl
	defer func() { journalctl = was }()
	journalctl = echo
	if out, _, code := cli(t, "logs", "-f", "--lines", "20"); code != 0 || out != "-u kantel-host -f -n 20\n" {
		t.Errorf("logs ran: exit %d, %q", code, out)
	}
	if f, err := exec.LookPath("false"); err == nil {
		journalctl = f
		if _, errOut, code := cli(t, "logs"); code != 1 || errOut != "" {
			t.Errorf("journalctl failing: exit %d, %q", code, errOut)
		}
	}
	journalctl = filepath.Join(t.TempDir(), "journalctl")
	if _, errOut, code := cli(t, "logs"); code != 1 || !strings.Contains(errOut, "no journalctl") {
		t.Errorf("no journalctl: exit %d, %q", code, errOut)
	}
}

// An explicit --token= keeps the registration, whatever KANTEL_HOST_TOKEN says; an absent one takes it.
func TestInstallTokenFromEnvironmentOnlyWhenAbsent(t *testing.T) {
	t.Setenv("KANTEL_HOST_TOKEN", "kth_env")
	t.Setenv("KANTEL_URL", "https://env.example.com")
	o, err := parseInstall([]string{"--token="})
	if err != nil || o.token != "" || o.controlPlane != "https://env.example.com" {
		t.Fatalf("--token=: token %q url %q err %v", o.token, o.controlPlane, err)
	}
	o, err = parseInstall(nil)
	if err != nil || o.token != "kth_env" {
		t.Fatalf("no --token: token %q err %v", o.token, err)
	}
	o, err = parseInstall([]string{"--token", "kth_flag", "--url", "https://flag.example.com"})
	if err != nil || o.token != "kth_flag" || o.controlPlane != "https://flag.example.com" {
		t.Fatalf("--token kth_flag: token %q url %q err %v", o.token, o.controlPlane, err)
	}
}

// A missing --url or --token is a usage error of the command run, exit 2 with its usage line.
func TestInstallMissingOptionsAreUsageErrors(t *testing.T) {
	m := newFakeMachine(t)
	for _, tc := range []struct {
		planOnly bool
		cmd      string
	}{{false, "install"}, {true, "plan"}} {
		o := m.options("")
		o.controlPlane = ""
		_, err := m.in.planInstall(o)
		var usage *usageError
		if !errors.As(err, &usage) {
			t.Fatalf("%s without --url: %v is not a usage error", tc.cmd, err)
		}
		t.Setenv("KANTEL_URL", "")
		t.Setenv("KANTEL_HOST_TOKEN", "")
		err = runInstall(m.in, []string{"--config", o.configPath, "--root", o.root}, tc.planOnly)
		if !errors.As(err, &usage) || usage.cmd != tc.cmd || !strings.Contains(usage.msg, "--url is required") {
			t.Errorf("%s without --url: %v", tc.cmd, err)
		}
	}
}

// Settings that can't be read never become a guessed directory to purge: --purge refuses before doing anything, and
// its confirmation doesn't name the default root as if the settings had.
func TestPurgeRefusesSettingsItCantRead(t *testing.T) {
	dir := t.TempDir()
	malformed := filepath.Join(dir, "malformed.json")
	if err := os.WriteFile(malformed, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	unreadable := filepath.Join(dir, "unreadable.json")
	if err := (agent.Config{Root: "/srv/kh"}).Save(unreadable); err != nil {
		t.Fatal(err)
	}
	configs := []string{malformed}
	if os.Geteuid() != 0 {
		if err := os.Chmod(unreadable, 0); err != nil {
			t.Fatal(err)
		}
		configs = append(configs, unreadable)
	}
	for _, config := range configs {
		_, errOut, code := cli(t, "uninstall", "--config", config, "--purge")
		if code != 2 || strings.Contains(errOut, agent.DefaultRoot) || !strings.Contains(errOut, "can't be read now") {
			t.Errorf("%s, --purge: exit %d\n%s", config, code, errOut)
		}
		_, errOut, code = cli(t, "uninstall", "--config", config, "--purge", "--yes")
		if code != 1 || !strings.Contains(errOut, "did nothing") || strings.Contains(errOut, "needs root") {
			t.Errorf("%s, --purge --yes: exit %d\n%s", config, code, errOut)
		}
	}
}
