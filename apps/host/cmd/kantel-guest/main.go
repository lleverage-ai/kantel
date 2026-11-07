// kantel-guest is the agent inside every microVM sandbox: it serves the host's commands, files and port streams over
// vsock (see internal/guest), and applies each sandbox's identity after a boot, restore or fork.
//
//	kantel-guest serve [--bridge 127.0.0.1:7001=1025 ...] [--injected --init systemd|kantel]
//	kantel-guest doctor (also run as kantel-doctor)
//	kantel-guest init (as an initramfs's /init: boots any Linux image with this agent in it; see internal/guestinit)
//	kantel-guest ssh-access (lets $KANTEL_PUBLIC_KEY in, or a new key it prints, and prints the host key's SHA256)
//	kantel-guest connect <host> <port> (also run as kantel-connect: ssh's ProxyCommand through the egress proxy)
//
// doctor checks, from inside the sandbox, that its protected environment variables will be swapped by the host's
// proxy: one line per check, exiting 1 if any fails.
//
// A bridge listens on a TCP address inside the guest and connects each connection to a vsock port on the host: the
// isolate tier's VM reaches the host's file store and egress proxy that way, with no network device at all.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/guestinit"
	"github.com/lleverage-ai/kantel/apps/host/internal/vsock"
)

var version = "dev"

type bridges []string

func (b *bridges) String() string     { return strings.Join(*b, ",") }
func (b *bridges) Set(v string) error { *b = append(*b, v); return nil }

func main() {
	if filepath.Base(os.Args[0]) == "kantel-doctor" || (len(os.Args) >= 2 && os.Args[1] == "doctor") {
		os.Exit(doctor(os.Stdout))
	}
	// The kernel starts an initramfs's /init with no arguments.
	if os.Getpid() == 1 && (os.Args[0] == "/init" || len(os.Args) == 1 || (os.Args[1] == "init" && len(os.Args) == 2)) {
		log.Fatal(guestinit.Stage1())
	}
	if len(os.Args) >= 3 && os.Args[1] == "init" && os.Args[2] == "--stage2" {
		log.Fatal(guestinit.Stage2())
	}
	if filepath.Base(os.Args[0]) == "kantel-connect" {
		os.Exit(connect(os.Args[1:], os.Getenv, os.Stdin, os.Stdout, os.Stderr))
	}
	if len(os.Args) >= 2 && os.Args[1] == "connect" {
		os.Exit(connect(os.Args[2:], os.Getenv, os.Stdin, os.Stdout, os.Stderr))
	}
	if len(os.Args) >= 2 && os.Args[1] == "ssh-access" {
		os.Exit(sshAccess(os.Stdout, os.Stderr))
	}
	if len(os.Args) >= 2 && os.Args[1] == guest.ExecCommandVerb {
		guest.ExecCommandMain(os.Args[2:])
	}
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "usage: kantel-guest serve [--bridge addr=hostport ...] [--injected --init systemd|kantel] | kantel-guest doctor | kantel-guest init | kantel-guest ssh-access | kantel-guest connect <host> <port>")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var bs bridges
	fs.Var(&bs, "bridge", "listen on a TCP address and connect to a host vsock port: 127.0.0.1:7001=1025")
	injected := fs.Bool("injected", false, "Kantel's initramfs put this agent in (any Linux image): netlink, its own SSH, root where there's no user")
	pid1 := fs.String("init", "systemd", `PID 1: "systemd" (the image's) or "kantel" (kantel-guest init's own)`)
	_ = fs.Parse(os.Args[2:])
	for _, b := range bs {
		addr, portText, ok := strings.Cut(b, "=")
		port, err := strconv.ParseUint(portText, 10, 32)
		if !ok || err != nil {
			log.Fatalf("bad --bridge %q", b)
		}
		go bridge(addr, uint32(port))
	}
	listener, err := vsock.Listen(vsock.AgentPort)
	if err != nil {
		log.Fatal(err)
	}
	mounts := &guest.Mounts{
		Dial:      func(context.Context) (net.Conn, error) { return vsock.DialHost(guest.MountPort) },
		StateFile: guest.MountsStateFile,
	}
	server := &guest.Server{Version: version, Injected: *injected, Init: *pid1, Mounts: mounts}
	if self, err := os.Executable(); err == nil && guest.UsableTrampoline(self) {
		server.Trampoline = self
	} else {
		log.Printf("commands keep the agent's OOM score: %s isn't executable by every user (%v)", self, err)
	}
	if *injected {
		// Its SSH server's key, before the first identity (ssh-access prints its fingerprint).
		if err := guest.EnsureHostKey(); err != nil {
			log.Printf("ssh host key: %v", err)
		}
	}
	// Never the process the kernel kills for memory. systemd's unit says so too (OOMScoreAdjust); without systemd
	// (--init kantel) nothing else would, and the memory watch below makes the kernel pick a process to kill.
	if err := guest.ProtectFromOOM(); err != nil {
		log.Printf("oom_score_adj: %v", err)
	}
	// Runs the kernel's OOM killer when the machine thrashes for memory, rather than letting it, and this agent, stall.
	guest.StartMemoryWatch(context.Background(), &guest.MemoryWatch{})
	// Mounts a previous run of the agent had: their FUSE servers ended with it.
	go mounts.Restore(context.Background())
	if l, err := net.Listen("tcp", guest.LocalProxyAddr); err == nil {
		go func() { log.Print(server.ServeLocalProxy(l)) }()
	} else {
		log.Printf("local proxy %s: %v", guest.LocalProxyAddr, err)
	}
	log.Printf("kantel-guest %s listening on vsock:%d", version, vsock.AgentPort)
	log.Fatal((&http.Server{Handler: server.Handler()}).Serve(listener))
}

func bridge(addr string, port uint32) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("bridge %s: %v", addr, err)
	}
	log.Printf("bridging %s to host vsock:%d", addr, port)
	for {
		conn, err := l.Accept()
		if err != nil {
			log.Printf("bridge %s: %v", addr, err)
			continue
		}
		go func() {
			defer conn.Close()
			host, err := vsock.DialHost(port)
			if err != nil {
				log.Printf("bridge %s: %v", addr, err)
				return
			}
			defer host.Close()
			done := make(chan struct{}, 2)
			go func() { _, _ = io.Copy(host, conn); done <- struct{}{} }()
			go func() { _, _ = io.Copy(conn, host); done <- struct{}{} }()
			<-done
		}()
	}
}
