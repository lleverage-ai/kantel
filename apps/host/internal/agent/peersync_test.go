package agent

import (
	"context"
	"log/slog"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// The peer sync server listens on the mesh address while a welcome has the host in a mesh, and stops on a welcome
// without one; it checks grants against the last key a welcome gave, for the host the welcome named.
func TestPeerSyncFollowsTheWelcome(t *testing.T) {
	ln, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skip("no IPv6 loopback")
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	m := &fakeMesh{addr: netip.IPv6Loopback()}
	h := &Host{tiers: map[string]Tier{}, log: slog.New(slog.DiscardHandler), mesh: m, cfg: Config{HostID: "host_cfg"}}
	h.startPeerSync()
	h.peers.Port = port
	defer h.peers.Close()
	if h.selfID() != "host_cfg" || h.peers.Key() != "" {
		t.Fatalf("before a welcome: %q %q", h.selfID(), h.peers.Key())
	}
	dial := func() error {
		c, err := net.DialTimeout("tcp", netip.AddrPortFrom(netip.IPv6Loopback(), uint16(port)).String(), time.Second)
		if err == nil {
			c.Close()
		}
		return err
	}
	h.applyWelcome(context.Background(), &proto.Welcome{HostID: "host_a", GrantKey: "key", Mesh: &proto.WelcomeMesh{Address: "::1", Prefix: "::/48"}}, nil)
	if err := dial(); err != nil {
		t.Fatalf("not listening with the mesh up: %v", err)
	}
	if h.selfID() != "host_a" || h.peers.Key() != "key" || h.peers.Self() != "host_a" {
		t.Fatalf("after a welcome: %q %q", h.selfID(), h.peers.Key())
	}
	h.applyWelcome(context.Background(), &proto.Welcome{HostID: "host_a"}, nil)
	if err := dial(); err == nil {
		t.Fatal("still listening with the mesh down")
	}
	if h.peers.Key() != "key" {
		t.Fatal("a welcome without the grant key dropped it")
	}
}
