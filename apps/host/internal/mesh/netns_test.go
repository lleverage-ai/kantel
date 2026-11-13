package mesh

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// The two-host test runs each host in a network namespace of its own, joined by a veth pair, inside a user and network
// namespace of the test's own (unshare), so it needs no root and touches nothing of the machine's. The test binary is
// run again for each part, which roleEnv names: "outer" is the stub control plane, "a" and "b" the hosts. The outer
// part is also the sandbox: a veth whose host side is named as a sandbox's device (kt9) on host a.
const roleEnv = "KANTEL_MESH_TEST_ROLE"

const (
	meshPrefix = "fd4b:616e:7465::/48"
	addrA      = "fd4b:616e:7465::a"
	addrB      = "fd4b:616e:7465::b"
)

// Two hosts against a stub control plane: each reaches the other's mesh address on the sync port and nothing else; a
// mesh.peers without the other removes it; a sandbox reaches neither; a restart keeps the key.
func TestMeshBetweenTwoHosts(t *testing.T) {
	switch os.Getenv(roleEnv) {
	case "a", "b":
		hostRole(t)
		return
	case "outer":
		outerRole(t)
		return
	}
	if err := Available(); err != nil {
		t.Skip(err)
	}
	// What the test does in its namespace, tried first: a machine (or CI runner) that can't is skipped, not failed.
	const probe = "ip tuntap add dev kprobe0 mode tun && ip link add kprobe1 type veth peer name kprobe2 && " +
		"ip6tables -w -N KPROBE && iptables -w -L -n >/dev/null && unshare -n true"
	// As root, a network namespace alone: a user namespace's root can't read files only the real one may.
	tries := [][]string{{"-rn"}, {"-n"}}
	if os.Geteuid() == 0 {
		tries = [][]string{{"-n"}}
	}
	var args []string
	for _, try := range tries {
		if exec.Command("unshare", append(try, "sh", "-c", probe)...).Run() == nil {
			args = try
			break
		}
	}
	if args == nil {
		t.Skip("needs unshare with a network namespace (and a user namespace, without root) in which TUN, veth and ip6tables work")
	}
	cmd := exec.Command("unshare", append(args, os.Args[0], "-test.run", "^TestMeshBetweenTwoHosts$", "-test.v")...)
	cmd.Env = append(os.Environ(), roleEnv+"=outer")
	out, err := cmd.CombinedOutput()
	t.Log(string(out))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "--- PASS: TestMeshBetweenTwoHosts") {
		t.Fatal("the test didn't run in its namespace")
	}
}

// child is a host part, spoken to in JSON lines.
type child struct {
	cmd *exec.Cmd
	in  io.Writer
	out *bufio.Scanner
}

type request struct {
	Op      string             `json:"op"`
	Mesh    *proto.WelcomeMesh `json:"mesh,omitempty"`
	Peers   []proto.MeshPeer   `json:"peers,omitempty"`
	Address string             `json:"address,omitempty"`
	Port    int                `json:"port,omitempty"`
	// Wait is how long a dial keeps trying, in seconds.
	Wait int `json:"wait,omitempty"`
}

type reply struct {
	Error  string            `json:"error,omitempty"`
	Facts  *proto.MeshFacts  `json:"facts,omitempty"`
	Health *proto.MeshHealth `json:"health,omitempty"`
	Said   string            `json:"said,omitempty"`
}

func (c *child) do(t *testing.T, r request) reply {
	t.Helper()
	raw, _ := json.Marshal(r)
	if _, err := c.in.Write(append(raw, '\n')); err != nil {
		t.Fatal(err)
	}
	if !c.out.Scan() {
		t.Fatalf("%s: the host part ended", r.Op)
	}
	var rep reply
	if err := json.Unmarshal(c.out.Bytes(), &rep); err != nil {
		t.Fatalf("%s: %s", r.Op, c.out.Text())
	}
	return rep
}

func startChild(t *testing.T, role string) *child {
	t.Helper()
	cmd := exec.Command("unshare", "-n", os.Args[0], "-test.run", "^TestMeshBetweenTwoHosts$")
	cmd.Env = append(os.Environ(), roleEnv+"="+role)
	cmd.Stderr = os.Stderr
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		in.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	c := &child{cmd: cmd, in: in, out: bufio.NewScanner(out)}
	// Its first line says it is in its namespace.
	if !c.out.Scan() || c.out.Text() != "ready" {
		t.Fatalf("host %s didn't start: %q", role, c.out.Text())
	}
	return c
}

func sh(t *testing.T, args ...string) {
	t.Helper()
	if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
		t.Fatalf("%s: %v: %s", strings.Join(args, " "), err, out)
	}
}

// dial connects to address:port and reads what is said, or fails within timeout.
func dial(address string, port int, timeout time.Duration) (string, error) {
	c, err := net.DialTimeout("tcp", net.JoinHostPort(address, fmt.Sprint(port)), timeout)
	if err != nil {
		return "", err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(timeout))
	b, err := io.ReadAll(c)
	return string(b), err
}

func outerRole(t *testing.T) {
	sh(t, "ip", "link", "set", "lo", "up")
	a, b := startChild(t, "a"), startChild(t, "b")
	sh(t, "ip", "link", "add", "va", "type", "veth", "peer", "name", "vb")
	sh(t, "ip", "link", "set", "va", "netns", fmt.Sprint(a.cmd.Process.Pid))
	sh(t, "ip", "link", "set", "vb", "netns", fmt.Sprint(b.cmd.Process.Pid))
	// The sandbox's link: kt9 on host a, sb0 here.
	sh(t, "ip", "link", "add", "sb0", "type", "veth", "peer", "name", "kt9")
	sh(t, "ip", "link", "set", "kt9", "netns", fmt.Sprint(a.cmd.Process.Pid))

	factsA := a.do(t, request{Op: "start", Address: "192.0.2.1/24"})
	factsB := b.do(t, request{Op: "start", Address: "192.0.2.2/24"})
	if factsA.Error != "" || factsB.Error != "" {
		t.Fatal(factsA.Error, factsB.Error)
	}
	// The endpoints are the hosts' own interface addresses, found as a host finds them.
	if !strings.Contains(strings.Join(factsB.Facts.Endpoints, " "), "192.0.2.2:51820") {
		t.Fatalf("host b's endpoints: %v", factsB.Facts.Endpoints)
	}
	peerA := proto.MeshPeer{HostID: "host_a", PublicKey: factsA.Facts.PublicKey, Address: addrA, Endpoints: factsA.Facts.Endpoints}
	// An endpoint that goes nowhere first: b is reached on its next.
	peerB := proto.MeshPeer{HostID: "host_b", PublicKey: factsB.Facts.PublicKey, Address: addrB, Endpoints: append([]string{"192.0.2.99:51820"}, factsB.Facts.Endpoints...)}
	for c, w := range map[*child]*proto.WelcomeMesh{
		a: {Address: addrA, Prefix: meshPrefix, Peers: []proto.MeshPeer{peerB}},
		b: {Address: addrB, Prefix: meshPrefix, Peers: []proto.MeshPeer{peerA}},
	} {
		if r := c.do(t, request{Op: "welcome", Mesh: w}); r.Error != "" {
			t.Fatal(r.Error)
		}
	}

	if r := a.do(t, request{Op: "dial", Address: addrB, Port: SyncPort, Wait: 30}); r.Error != "" || r.Said != "host b" {
		t.Fatalf("a to b: %+v", r)
	}
	if r := b.do(t, request{Op: "dial", Address: addrA, Port: SyncPort, Wait: 30}); r.Error != "" || r.Said != "host a" {
		t.Fatalf("b to a: %+v", r)
	}
	// Only the sync port: b listens on another port of its mesh address too, which the firewall keeps a from.
	if r := a.do(t, request{Op: "dial", Address: addrB, Port: SyncPort + 1}); r.Error == "" {
		t.Fatal("a reached a port of b's other than the sync port")
	}
	h := a.do(t, request{Op: "health"}).Health
	if h == nil || len(h.Peers) != 1 || h.Peers[0].HostID != "host_b" || h.Peers[0].Path != proto.MeshPathDirect ||
		h.Peers[0].Endpoint != "192.0.2.2:51820" || h.Peers[0].LastHandshake == 0 {
		t.Fatalf("a's health: %+v", h)
	}
	// The round trip, from a's probes of b's sync port, within a probe or two.
	for deadline := time.Now().Add(2 * probeEvery); ; time.Sleep(time.Second) {
		h := a.do(t, request{Op: "health"}).Health
		if len(h.Peers) == 1 && h.Peers[0].RTTMs > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no round trip to b: %+v", h)
		}
	}

	// The sandbox on a: IPv6 on its link (as if the host's switch had failed), and a route to the mesh through a. The
	// firewall's rules for sandboxes (network.Manager) and the mesh's keep it from both hosts' mesh addresses.
	if r := a.do(t, request{Op: "sandbox"}); r.Error != "" {
		t.Fatal(r.Error)
	}
	sh(t, "ip", "link", "set", "sb0", "up")
	sh(t, "ip", "-6", "addr", "add", "fd99::2/64", "dev", "sb0", "nodad")
	sh(t, "ip", "-6", "route", "add", meshPrefix, "via", "fd99::1")
	for _, addr := range []string{addrA, addrB} {
		if said, err := dial(addr, SyncPort, 2*time.Second); err == nil {
			t.Fatalf("the sandbox reached %s: %q", addr, said)
		}
	}

	// mesh.peers without b: a drops it, and neither reaches the other.
	if r := a.do(t, request{Op: "peers", Peers: []proto.MeshPeer{}}); r.Error != "" {
		t.Fatal(r.Error)
	}
	if r := a.do(t, request{Op: "dial", Address: addrB, Port: SyncPort}); r.Error == "" {
		t.Fatal("a reached b after b left its peers")
	}
	if r := b.do(t, request{Op: "dial", Address: addrA, Port: SyncPort}); r.Error == "" {
		t.Fatal("b reached a after a dropped it")
	}
	if h := a.do(t, request{Op: "health"}).Health; h == nil || len(h.Peers) != 0 {
		t.Fatalf("a's health after b left: %+v", h)
	}

	// A restart: the same key, and with the same welcome b is reached again.
	if r := a.do(t, request{Op: "restart"}); r.Error != "" || r.Facts.PublicKey != factsA.Facts.PublicKey {
		t.Fatalf("restart: %+v", r)
	}
	if r := a.do(t, request{Op: "welcome", Mesh: &proto.WelcomeMesh{Address: addrA, Prefix: meshPrefix, Peers: []proto.MeshPeer{peerB}}}); r.Error != "" {
		t.Fatal(r.Error)
	}
	if r := a.do(t, request{Op: "dial", Address: addrB, Port: SyncPort, Wait: 30}); r.Error != "" || r.Said != "host b" {
		t.Fatalf("a to b after a restart: %+v", r)
	}
	// A welcome without a mesh takes a's device down.
	if r := a.do(t, request{Op: "welcome"}); r.Error != "" {
		t.Fatal(r.Error)
	}
	if r := b.do(t, request{Op: "dial", Address: addrA, Port: SyncPort}); r.Error == "" {
		t.Fatal("b reached a after a's mesh went down")
	}
}

// hostRole is one host: a mesh on a real device and firewall in its own namespace, driven by the outer part.
func hostRole(t *testing.T) {
	role := os.Getenv(roleEnv)
	fmt.Println("ready")
	in := bufio.NewScanner(os.Stdin)
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})).With("host", role)
	dir := t.TempDir()
	var m *Mesh
	var listeners []net.Listener
	start := func() error {
		var err error
		m, err = New(Config{Dir: dir, Log: log})
		return err
	}
	answer := func(r reply) {
		raw, _ := json.Marshal(r)
		fmt.Println(string(raw))
	}
	for in.Scan() {
		var req request
		if err := json.Unmarshal(in.Bytes(), &req); err != nil {
			answer(reply{Error: err.Error()})
			continue
		}
		var err error
		var rep reply
		switch req.Op {
		case "start":
			dev := "v" + role
			for _, args := range [][]string{{"ip", "link", "set", "lo", "up"}, {"ip", "addr", "add", req.Address, "dev", dev}, {"ip", "link", "set", dev, "up"}} {
				if err == nil {
					err = runCommand(args...)
				}
			}
			if err == nil {
				err = start()
			}
			if err == nil {
				rep.Facts = m.Facts()
			}
		case "restart":
			m.Close()
			for _, l := range listeners {
				l.Close()
			}
			listeners = nil
			if err = start(); err == nil {
				rep.Facts = m.Facts()
			}
		case "welcome":
			if err = m.Apply(req.Mesh); err == nil && req.Mesh != nil {
				// What a peer may reach (the sync port) and what it mayn't (the next one).
				for _, port := range []int{SyncPort, SyncPort + 1} {
					if err == nil {
						listeners, err = serve(listeners, req.Mesh.Address, port, "host "+role)
					}
				}
			}
		case "peers":
			m.SetPeers(req.Peers)
		case "health":
			rep.Health = m.Health()
		case "dial":
			// A peer just added may take a handshake or two (and an endpoint that goes nowhere) to reach.
			deadline := time.Now().Add(time.Duration(req.Wait) * time.Second)
			for {
				rep.Said, err = dial(req.Address, req.Port, 2*time.Second)
				if err == nil || time.Now().After(deadline) {
					break
				}
				time.Sleep(500 * time.Millisecond)
			}
		case "sandbox":
			// Sandboxes' rules as kantel-host makes them, then the link on its side as a sandbox's would be with IPv6
			// on, and forwarding on (as Docker leaves it).
			if _, err = network.New("10.231.0.0/16", 3129, false); err == nil {
				for _, args := range [][]string{
					{"sysctl", "-qw", "net.ipv6.conf.all.forwarding=1"},
					{"ip", "link", "set", "kt9", "up"},
					{"ip", "-6", "addr", "add", "fd99::1/64", "dev", "kt9", "nodad"},
				} {
					if err == nil {
						err = runCommand(args...)
					}
				}
			}
			if err == nil {
				listeners, err = serve(listeners, "fd99::1", SyncPort, "host "+role)
			}
		default:
			err = errors.New("unknown op " + req.Op)
		}
		if err != nil {
			rep.Error = err.Error()
		}
		answer(rep)
	}
	if m != nil {
		m.Close()
	}
}

// serve answers every connection to address:port with what, then closes it; its listener is added to listeners.
func serve(listeners []net.Listener, address string, port int, what string) ([]net.Listener, error) {
	addr, err := netip.ParseAddr(address)
	if err != nil {
		return listeners, err
	}
	var l net.Listener
	// The address takes a moment to be usable after it is added.
	for range 50 {
		var lc net.ListenConfig
		if l, err = lc.Listen(context.Background(), "tcp", netip.AddrPortFrom(addr, uint16(port)).String()); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		return listeners, err
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte(what))
			c.Close()
		}
	}()
	return append(listeners, l), nil
}
