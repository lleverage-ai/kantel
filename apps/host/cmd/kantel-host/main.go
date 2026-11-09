// kantel-host runs Kantel sandboxes on a Linux machine: Firecracker microVMs and workerd isolates behind one sandbox
// interface. It dials out to the control plane, so it needs no inbound port.
//
//	kantel-host install --url https://kantel.example.com --token kth_…   install, register and start (as root)
//	kantel-host install --dry-run --url … --token …                     what install would do, changing nothing
//	kantel-host doctor                                                  what this machine can run, and what's missing
//	kantel-host status [--json]                                         the service, the connection and the sandboxes
//	kantel-host sandboxes [show <id>] [--json]                          the sandboxes the service holds (as root)
//	kantel-host logs [-f] [-n <lines>]                                  the service's journal
//	kantel-host update [--version v]                                    move to another version now
//	kantel-host run                                                     the daemon (systemd runs this)
//	kantel-host bench                                                   measure create, resume and fork on this host
//	kantel-host uninstall [--purge --yes]                               stop and remove the service
//
// `kantel-host help` lists every command, and `kantel-host help <command>` its flags.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
)

var version = "dev"

const defaultConfigPath = "/etc/kantel-host/config.json"

func main() {
	os.Exit(exit(dispatch(os.Args[1:])))
}

// dispatch runs the command args names, with the rest of args.
func dispatch(args []string) error {
	if len(args) == 0 {
		io.WriteString(stderr, mainHelp())
		return exitCode(2)
	}
	name, rest := args[0], args[1:]
	switch name {
	case "run":
		return run(rest)
	case "install", "join":
		return install(rest, false)
	case "plan":
		return install(rest, true)
	case "doctor":
		return doctor(rest)
	case "status":
		return status(rest)
	case "sandboxes":
		return sandboxesCmd(rest)
	case "logs":
		return logs(rest)
	case "update":
		return updateCmd(rest)
	case "uninstall":
		return uninstall(rest)
	case "bench":
		return bench(rest)
	case "manifest":
		return manifestCmd(rest)
	case "version", "--version", "-V", "-v":
		return versionCmd(rest)
	case "help", "--help", "-h":
		return help(rest)
	}
	return noCommand(name)
}

func noCommand(name string) error {
	fmt.Fprintf(stderr, "kantel-host: there is no command %q. \"kantel-host help\" lists them.\n", name)
	return exitCode(2)
}

// help is `kantel-host help [<command>]`: the top-level help, or the command's own --help.
func help(args []string) error {
	switch {
	case len(args) == 0 || args[0] == "help":
		io.WriteString(stdout, mainHelp())
		return nil
	case len(args) >= 2 && args[0] == "sandboxes" && args[1] == "show":
		return dispatch([]string{"sandboxes", "show", "--help"})
	}
	if _, ok := findCommand(args[0]); !ok && args[0] != "join" {
		return noCommand(args[0])
	}
	return dispatch([]string{args[0], "--help"})
}

// versionCmd is `kantel-host version [--json]`.
func versionCmd(args []string) error {
	fs := newFlags("version")
	asJSON := fs.Bool("json", false, "Print the version, Go's version, the OS and the architecture as JSON")
	if err := fs.parse(args); err != nil {
		return err
	}
	if err := fs.noArgs(); err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(stdout, struct {
			Version string `json:"version"`
			Go      string `json:"go"`
			OS      string `json:"os"`
			Arch    string `json:"arch"`
		}{version, runtime.Version(), runtime.GOOS, runtime.GOARCH})
	}
	fmt.Fprintln(stdout, version)
	return nil
}

func run(args []string) error {
	fs := newFlags("run")
	configPath := fs.String("config", defaultConfigPath, "The settings `file`")
	debug := fs.Bool("debug", false, "Debug logging")
	local := fs.String("local", "", "Also serve the host's calls over HTTP on this loopback `address` (tests; no auth)")
	controlSocket := fs.String("control-socket", "", "The read-only control socket for kantel-host sandboxes and status, a `path` (default: the config's; \"off\": none)")
	if err := fs.parse(args); err != nil {
		return err
	}
	if err := fs.noArgs(); err != nil {
		return err
	}
	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	cfg, err := agent.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	// Before the tiers start: with image patching, cosign, the image links and the pinned Firecracker.
	prepareCtx, cancelPrepare := context.WithTimeout(context.Background(), 10*time.Minute)
	agent.PrepareImages(prepareCtx, cfg, FirecrackerVersion, log)
	cancelPrepare()
	host, err := agent.New(cfg, version, log)
	if err != nil {
		return err
	}
	defer host.Close()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Info("kantel-host started", "version", version, "tiers", host.Tiers(), "controlPlane", cfg.ControlPlane)
	if *controlSocket != "" {
		cfg.ControlSocket = *controlSocket
	}
	if cfg.ControlSocket != "off" {
		// Without it the host still runs: only the operator's view of it is missing.
		if stopControl, err := agent.ServeControl(cfg.ControlSocket, host, log); err != nil {
			log.Error("control socket: kantel-host sandboxes won't answer", "path", cfg.ControlSocket, "error", err)
		} else {
			defer stopControl()
			log.Info("control socket", "path", cfg.ControlSocket)
		}
	}
	if *local != "" {
		if ip, _, err := net.SplitHostPort(*local); err != nil || !net.ParseIP(ip).IsLoopback() {
			return errors.New("--local must be a loopback address, such as 127.0.0.1:7070")
		}
		srv := &http.Server{Addr: *local, Handler: host.LocalHandler()}
		go func() {
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("local API", "error", err)
			}
		}()
		defer srv.Close()
		log.Info("local API", "addr", *local)
		if cfg.ControlPlane == "" {
			// No control plane to push to: sampled anyway, for GET /usage.
			go host.RunUsage(ctx)
			<-ctx.Done()
			return nil
		}
	}
	err = host.Run(ctx, selfUpdater(log))
	if errors.Is(err, agent.ErrRevoked) {
		log.Error("stopping: " + err.Error())
		// Exit 0 so systemd doesn't restart into the same refusal.
		return nil
	}
	if ctx.Err() != nil {
		return nil
	}
	return err
}

func doctor(args []string) error {
	fs := newFlags("doctor")
	configPath := fs.String("config", defaultConfigPath, "The settings `file`")
	asJSON := fs.Bool("json", false, "Print the checks as JSON")
	root := fs.String("root", "", "Where sandboxes will live (default: the config's, or /var/lib/kantel-host)")
	isolateRuntime := fs.String("isolate-runtime", "", `Check for "native" isolates (workerd on the host itself, no KVM) rather than microVMs (default: the config's)`)
	if err := fs.parse(args); err != nil {
		return err
	}
	if err := fs.noArgs(); err != nil {
		return err
	}
	cfg, _ := agent.LoadConfig(*configPath)
	cfg.Defaults() // a config it can't read (not root) still checks the default root
	if *root != "" {
		cfg.Root = *root
	}
	if *isolateRuntime != "" {
		cfg.IsolateRuntime = *isolateRuntime
	}
	checks := hostinfo.Checks(cfg.Root, cfg.IsolateRuntime == "native")
	if *asJSON {
		if err := json.NewEncoder(stdout).Encode(checks); err != nil {
			return err
		}
	} else {
		printChecks(stdout, checks, cfg.IsolateRuntime == "native")
	}
	return checksPassed(checks)
}

// printChecks shows doctor's checks: FAIL and unknown are required ones that didn't pass, warn is advice. A check
// that didn't pass and has an obvious fix has it on the next line.
func printChecks(w io.Writer, checks []hostinfo.Check, native bool) {
	microvm := true
	for _, c := range checks {
		mark := "ok"
		switch {
		case c.State == hostinfo.StateOK:
		case !c.Required:
			mark = "warn"
		case c.State == hostinfo.StateUnknown:
			mark = "unknown"
		default:
			mark = "FAIL"
		}
		if c.MicroVM && c.State != hostinfo.StateOK {
			microvm = false
		}
		fmt.Fprintf(w, "%-7s %-22s %s\n", mark, c.Name, c.Detail)
		if c.State != hostinfo.StateOK && c.Fix != "" {
			fmt.Fprintf(w, "%-7s %-22s to fix: %s\n", "", "", c.Fix)
		}
	}
	fmt.Fprintln(w)
	switch {
	case microvm:
		fmt.Fprintln(w, "This machine can run both tiers: microVMs (Firecracker) and isolates (workerd, inside a microVM).")
	case native && hostinfo.Passed(checks):
		fmt.Fprintln(w, "This machine can run isolates natively (workerd on the host itself, for code you trust), but not microVMs.")
	default:
		fmt.Fprintln(w, "This machine can't run microVMs. It can run isolates only with isolateRuntime \"native\" (workerd on the")
		fmt.Fprintln(w, "host itself, for code you trust): check that with --isolate-runtime native. Fix the FAIL lines above for both tiers.")
	}
}

// checksPassed is doctor's exit: an error, so a non-zero exit, unless every required check is ok.
func checksPassed(checks []hostinfo.Check) error {
	if hostinfo.Passed(checks) {
		return nil
	}
	var names []string
	for _, c := range checks {
		if c.Required && c.State != hostinfo.StateOK {
			names = append(names, c.Name+" ("+c.State+")")
		}
	}
	return fmt.Errorf("required checks didn't pass: %s", strings.Join(names, ", "))
}

// statusReport is `status --json`.
type statusReport struct {
	Version      string `json:"version"`
	ControlPlane string `json:"controlPlane"`
	HostID       string `json:"hostId"`
	// Service is systemd's state for the unit: active, inactive, failed, activating…, or "" without systemd.
	Service string `json:"service"`
	// Sandboxes counts the service's sandboxes by state; null, with SandboxesError, when it couldn't be asked.
	Sandboxes      map[string]int `json:"sandboxes"`
	SandboxesError string         `json:"sandboxesError,omitempty"`
}

// serviceState is `systemctl is-active kantel-host`, swapped in tests.
var serviceState = func() string {
	out, _ := runOutput("systemctl", "is-active", "kantel-host")
	return strings.TrimSpace(out)
}

// statusInactive is status's exit when the service isn't active, as `gitlab-runner status` and LSB init scripts
// have it.
const statusInactive = exitCode(3)

func status(args []string) error {
	fs := newFlags("status")
	configPath := fs.String("config", defaultConfigPath, "The settings `file`")
	asJSON := fs.Bool("json", false, "Print the status as JSON")
	if err := fs.parse(args); err != nil {
		return err
	}
	if err := fs.noArgs(); err != nil {
		return err
	}
	cfg, err := agent.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	r := statusReport{Version: version, ControlPlane: cfg.ControlPlane, HostID: cfg.HostID, Service: serviceState()}
	counts, err := sandboxCounts(cfg)
	if err != nil {
		r.SandboxesError = err.Error()
	} else {
		r.Sandboxes = counts
	}
	if *asJSON {
		if err := writeJSON(stdout, r); err != nil {
			return err
		}
	} else {
		fmt.Fprintf(stdout, "version       %s\n", r.Version)
		fmt.Fprintf(stdout, "control plane %s\n", orNone(r.ControlPlane))
		fmt.Fprintf(stdout, "host          %s\n", orNone(r.HostID))
		fmt.Fprintf(stdout, "service       %s\n", orNone(r.Service))
		fmt.Fprintf(stdout, "sandboxes     %s\n", sandboxesText(counts, err))
	}
	if r.Service != "active" {
		return statusInactive
	}
	return nil
}

// sandboxCounts is the service's sandboxes by state, from its control socket.
func sandboxCounts(cfg agent.Config) (map[string]int, error) {
	if cfg.ControlSocket == "off" {
		return nil, errors.New("the control socket is off")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	list, err := controlClient{path: cfg.ControlSocket}.list(ctx)
	if err != nil {
		return nil, err
	}
	return countStates(list), nil
}

// sandboxesLine is status's count of the service's sandboxes by state, or why there isn't one.
func sandboxesLine(cfg agent.Config) string {
	return sandboxesText(sandboxCounts(cfg))
}

func sandboxesText(counts map[string]int, err error) string {
	if err != nil {
		return "unknown: " + err.Error()
	}
	return countsText(counts)
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

// journalctl is the command logs runs, swapped in tests.
var journalctl = "journalctl"

// logs is `kantel-host logs`: the service's journal, through journalctl, with its stdin, stdout and stderr.
func logs(args []string) error {
	fs := newFlags("logs")
	follow := fs.Bool("follow", false, "Keep printing new lines as the service logs them")
	fs.alias("f", "follow")
	lines := fs.Int("lines", -1, "Show only the last `n` lines; 0 with --follow shows only new ones (default: all of them)")
	fs.alias("n", "lines")
	if err := fs.parse(args); err != nil {
		return err
	}
	if err := fs.noArgs(); err != nil {
		return err
	}
	// -1, the default, is all of them; a value given must be 0 or more.
	given := false
	fs.Visit(func(f *flag.Flag) { given = given || f.Name == "lines" || f.Name == "n" })
	if given && *lines < 0 {
		return usageErrorf("logs", "--lines must be 0 or more, not %d", *lines)
	}
	cmd := exec.Command(journalctl, journalArgs(*follow, *lines)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, stdout, stderr
	err := cmd.Run()
	var exited *exec.ExitError
	switch {
	case errors.As(err, &exited):
		// journalctl has said what's wrong.
		return exitCode(max(exited.ExitCode(), 1))
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist):
		return errors.New("there is no journalctl on this machine: logs reads the service's systemd journal")
	}
	return err
}

func journalArgs(follow bool, lines int) []string {
	args := []string{"-u", "kantel-host"}
	if follow {
		args = append(args, "-f")
	}
	if lines >= 0 {
		args = append(args, "-n", strconv.Itoa(lines))
	}
	return args
}
