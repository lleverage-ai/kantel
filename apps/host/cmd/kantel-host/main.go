// kantel-host runs Kantel sandboxes on a Linux machine: Firecracker microVMs and workerd isolates behind one sandbox
// interface. It dials out to the control plane, so it needs no inbound port.
//
//	kantel-host install --url https://kantel.example.com --token kth_…   install, register and start (as root)
//	kantel-host install --dry-run --url … --token …                     what install would do, changing nothing
//	kantel-host doctor                                                  what this machine can run, and what's missing
//	kantel-host status                                                  the service, the connection and the sandboxes
//	kantel-host sandboxes [show <id>] [--json]                          the sandboxes the service holds (as root)
//	kantel-host update [--version v]                                    move to another version now
//	kantel-host run                                                     the daemon (systemd runs this)
//	kantel-host bench                                                   measure create, resume and fork on this host
//	kantel-host uninstall [--purge]                                     stop and remove the service
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
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/agent"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
)

var version = "dev"

const defaultConfigPath = "/etc/kantel-host/config.json"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	args := os.Args[2:]
	switch os.Args[1] {
	case "run":
		err = run(args)
	case "install", "join":
		err = install(args, false)
	case "plan":
		err = install(args, true)
	case "doctor":
		err = doctor(args)
	case "status":
		err = status(args)
	case "sandboxes":
		err = sandboxesCmd(args)
	case "update":
		err = updateCmd(args)
	case "uninstall":
		err = uninstall(args)
	case "bench":
		err = bench(args)
	case "manifest":
		err = manifestCmd(args)
	case "e2e":
		err = e2eCmd(args)
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "kantel-host: unknown command %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "kantel-host:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `kantel-host `+version+`: runs Kantel sandboxes on this machine.

  install --url <kantel> --token <kth_…>   install, register with Kantel and start the service (as root)
                                            (--dry-run: print what it would do, and change nothing)
  plan --url <kantel> --token <kth_…>      what install would do, with install's options: always a dry run
  doctor                                    check what this machine can run (exits 1 unless the required checks pass)
  status                                    the service, its connection and its sandboxes
  sandboxes [--json]                        the sandboxes the service holds, from its control socket (as root)
  sandboxes show <id> [--json]              one of them in full
                                            (read-only: stop or delete a sandbox through Kantel, with
                                            kantel sandbox stop or the console, which keep its record)
  update [--version <v>]                    update now (the service also updates itself when Kantel asks)
  uninstall [--purge]                       stop and remove the service (--purge: sandboxes and images too)
  bench                                     measure sandbox create, resume and fork on this machine
  run                                       the daemon itself (the service runs it)
  manifest <dir>                            write <dir>/manifest.json for the images in <dir> (for releases)
  e2e key|status|join [--chain f] <ticket>  end-to-end encryption: this host's keys, its spaces, join a space
  version
`)
}

func run(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath, "config file")
	debug := fs.Bool("debug", false, "debug logging")
	local := fs.String("local", "", "also serve the host's calls over HTTP on this loopback address (tests; no auth)")
	controlSocket := fs.String("control-socket", "", `the read-only control socket for kantel-host sandboxes and status (default: the config's; "off": none)`)
	_ = fs.Parse(args)
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
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath, "config file")
	asJSON := fs.Bool("json", false, "JSON output")
	root := fs.String("root", "", "where sandboxes will live (default: the config's, or /var/lib/kantel-host)")
	isolateRuntime := fs.String("isolate-runtime", "", `check for "native" isolates (workerd on the host itself, no KVM) rather than microVMs (default: the config's)`)
	_ = fs.Parse(args)
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
		if err := json.NewEncoder(os.Stdout).Encode(checks); err != nil {
			return err
		}
	} else {
		printChecks(os.Stdout, checks, cfg.IsolateRuntime == "native")
	}
	return checksPassed(checks)
}

// printChecks shows doctor's checks: FAIL and unknown are required ones that didn't pass, warn is advice.
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

func status(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath, "config file")
	_ = fs.Parse(args)
	cfg, err := agent.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	fmt.Printf("version       %s\n", version)
	fmt.Printf("control plane %s\n", orNone(cfg.ControlPlane))
	fmt.Printf("host          %s\n", orNone(cfg.HostID))
	out, _ := runOutput("systemctl", "is-active", "kantel-host")
	fmt.Printf("service       %s\n", orNone(strings.TrimSpace(out)))
	fmt.Printf("sandboxes     %s\n", sandboxesLine(cfg))
	return nil
}

// sandboxesLine is status's count of the service's sandboxes by state, or why there isn't one.
func sandboxesLine(cfg agent.Config) string {
	if cfg.ControlSocket == "off" {
		return "unknown: the control socket is off"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	list, err := controlClient{path: cfg.ControlSocket}.list(ctx)
	if err != nil {
		return "unknown: " + err.Error()
	}
	return stateCounts(list)
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}
