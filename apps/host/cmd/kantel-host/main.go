// kantel-host runs Kantel sandboxes on a Linux machine: Firecracker microVMs and workerd isolates behind one sandbox
// interface. It dials out to the control plane, so it needs no inbound port.
//
//	kantel-host install --url https://kantel.example.com --token kth_…   install, register and start (as root)
//	kantel-host doctor                                                  what this machine can run, and what's missing
//	kantel-host status                                                  the service, the connection and the sandboxes
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
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

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
		err = install(args)
	case "doctor":
		err = doctor(args)
	case "status":
		err = status(args)
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
  doctor                                    check what this machine can run
  status                                    the service, its connection and its sandboxes
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
	host, err := agent.New(cfg, version, log)
	if err != nil {
		return err
	}
	defer host.Close()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Info("kantel-host started", "version", version, "tiers", host.Tiers(), "controlPlane", cfg.ControlPlane)
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
	_ = fs.Parse(args)
	cfg, _ := agent.LoadConfig(*configPath)
	checks := hostinfo.Checks(cfg.Root)
	if *asJSON {
		return json.NewEncoder(os.Stdout).Encode(checks)
	}
	microvm := true
	for _, c := range checks {
		mark := "ok  "
		if !c.OK {
			mark = "FAIL"
			if c.MicroVM {
				microvm = false
			}
		}
		fmt.Printf("%s  %-22s %s\n", mark, c.Name, c.Detail)
	}
	fmt.Println()
	if microvm {
		fmt.Println("This machine can run both tiers: microVMs (Firecracker) and isolates (workerd, inside a microVM).")
	} else {
		fmt.Println("This machine can't run microVMs. It can run isolates only with isolateRuntime \"native\" (workerd on the")
		fmt.Println("host itself, for code you trust). Fix the FAIL lines above for both tiers.")
	}
	return nil
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
	return nil
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}
