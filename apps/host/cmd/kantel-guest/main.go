// kantel-guest is the agent inside every microVM sandbox: it serves the host's commands, files and port streams over
// vsock (see internal/guest), and applies each sandbox's identity after a boot, restore or fork.
//
//	kantel-guest serve [--bridge 127.0.0.1:7001=1025 ...]
//
// A bridge listens on a TCP address inside the guest and connects each connection to a vsock port on the host: the
// isolate tier's VM reaches the host's file store and egress proxy that way, with no network device at all.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/vsock"
)

var version = "dev"

type bridges []string

func (b *bridges) String() string     { return strings.Join(*b, ",") }
func (b *bridges) Set(v string) error { *b = append(*b, v); return nil }

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "usage: kantel-guest serve [--bridge addr=hostport ...]")
		os.Exit(2)
	}
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var bs bridges
	fs.Var(&bs, "bridge", "listen on a TCP address and connect to a host vsock port: 127.0.0.1:7001=1025")
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
	server := &guest.Server{Version: version}
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
