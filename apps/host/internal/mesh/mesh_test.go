package mesh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// fakeDevice records what the mesh asks of its device.
type fakeDevice struct {
	mu     sync.Mutex
	peers  map[Key]PeerConfig
	stats  map[Key]PeerStats
	closed bool
	sets   []PeerConfig
}

func (d *fakeDevice) SetPeer(p PeerConfig) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.sets = append(d.sets, p)
	if old, ok := d.peers[p.PublicKey]; ok && !p.Endpoint.IsValid() {
		p.Endpoint = old.Endpoint
	}
	d.peers[p.PublicKey] = p
	return nil
}

func (d *fakeDevice) RemovePeer(k Key) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.peers, k)
	return nil
}

func (d *fakeDevice) Stats() ([]PeerStats, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []PeerStats
	for k, p := range d.peers {
		s := d.stats[k]
		s.PublicKey, s.Endpoint = k, p.Endpoint
		out = append(out, s)
	}
	return out, nil
}

func (d *fakeDevice) Close() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.closed = true
	return nil
}

type fakeFirewall struct {
	up     []netip.Prefix
	downs  int
	failUp bool
}

func (f *fakeFirewall) Up(dev string, prefix netip.Prefix, syncPort, listenPort int) error {
	if f.failUp {
		return os.ErrPermission
	}
	f.up = append(f.up, prefix)
	return nil
}

func (f *fakeFirewall) Down(dev string, listenPort int) { f.downs++ }

type harness struct {
	m        *Mesh
	devices  []*fakeDevice
	firewall *fakeFirewall
	commands []string
}

// owners makes each test's mesh ownership its own, apart from a kantel-host on the machine.
var owners atomic.Int64

func testOwner() string { return fmt.Sprintf("kantel-mesh-test-%d-%d", os.Getpid(), owners.Add(1)) }

func newHarness(t *testing.T, dir string) *harness {
	t.Helper()
	return newOwnedHarness(t, dir, testOwner())
}

func newOwnedHarness(t *testing.T, dir, owner string) *harness {
	t.Helper()
	h := &harness{firewall: &fakeFirewall{}}
	m, err := New(Config{
		Dir: dir, Log: slog.New(slog.DiscardHandler), Firewall: h.firewall, Owner: owner,
		Endpoints: []string{"mesh.example.com:6000", "203.0.113.9"},
		Addresses: func() []netip.Addr {
			return []netip.Addr{netip.MustParseAddr("10.0.0.5"), netip.MustParseAddr("198.51.100.7"), netip.MustParseAddr("fd00::5"), netip.MustParseAddr("2001:db8::5")}
		},
		Run: func(args ...string) error {
			h.commands = append(h.commands, strings.Join(args, " "))
			return nil
		},
		Open: func(name string, private Key, port int, log *slog.Logger) (Device, error) {
			d := &fakeDevice{peers: map[Key]PeerConfig{}, stats: map[Key]PeerStats{}}
			h.devices = append(h.devices, d)
			return d, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	h.m = m
	return h
}

func (h *harness) device() *fakeDevice { return h.devices[len(h.devices)-1] }

func testKey(t *testing.T) Key {
	t.Helper()
	k, err := newPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	return k.Public()
}

// The key pair is made on the first start, kept under the host's root (0600), and the same on every start after; only
// the public key is ever reported.
func TestKeyKeptAcrossStarts(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "mesh")
	name := testOwner()
	first := newOwnedHarness(t, dir, name).m
	st, err := os.Stat(filepath.Join(dir, keyFile))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", st, err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, keyFile))
	facts, _ := json.Marshal(first.Facts())
	if strings.Contains(string(facts), strings.TrimSpace(string(raw))) {
		t.Fatal("the facts carry the private key")
	}
	first.Close()
	second := newOwnedHarness(t, dir, name).m
	if first.PublicKey() != second.PublicKey() || first.Facts().PublicKey != second.Facts().PublicKey {
		t.Fatal("a restart made a new key")
	}
	if _, err := ParseKey(first.Facts().PublicKey); err != nil {
		t.Fatal(err)
	}
}

// A key that doesn't parse is refused without saying what it was: it may be the private key.
func TestKeyErrorsDontCarryTheKey(t *testing.T) {
	dir := t.TempDir()
	k, err := newPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	bad := k.String() + "!"
	if err := os.WriteFile(filepath.Join(dir, keyFile), []byte(bad), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = LoadKey(dir)
	if err == nil || strings.Contains(err.Error(), k.String()[:8]) {
		t.Fatalf("error %v", err)
	}
}

// One process owns the mesh in a network namespace at a time: another (a second run, the installer's or bench's host
// while the daemon runs), whatever its root, gets ErrOwned and touches nothing of it, and takes it over once the owner
// has closed.
func TestOneOwner(t *testing.T) {
	name := testOwner()
	owner := newOwnedHarness(t, t.TempDir(), name)
	if err := owner.m.Apply(welcome()); err != nil {
		t.Fatal(err)
	}
	var cleaned []string
	_, err := New(Config{Dir: t.TempDir(), Log: slog.New(slog.DiscardHandler), Firewall: owner.firewall, Owner: name,
		Run: func(args ...string) error { cleaned = append(cleaned, strings.Join(args, " ")); return nil }})
	if !errors.Is(err, ErrOwned) || len(cleaned) != 0 || owner.firewall.downs != 1 || owner.device().closed {
		t.Fatalf("second: %v; cleaned %v, firewall downs %d", err, cleaned, owner.firewall.downs)
	}
	owner.m.Close()
	next := newOwnedHarness(t, t.TempDir(), name)
	if !slices.Contains(next.commands, "ip link del kmesh0") || next.firewall.downs != 1 {
		t.Fatalf("the next owner didn't clean up: %v", next.commands)
	}
}

// The hello's endpoints: the operator's first (a bare host gets the port), then the host's public IPv6 addresses, its
// public IPv4 ones, then its private ones.
func TestFactsEndpoints(t *testing.T) {
	f := newHarness(t, t.TempDir()).m.Facts()
	want := []string{"mesh.example.com:6000", "203.0.113.9:51820", "[2001:db8::5]:51820", "198.51.100.7:51820", "10.0.0.5:51820", "[fd00::5]:51820"}
	if f.ListenPort != DefaultPort || !slices.Equal(f.Endpoints, want) {
		t.Fatalf("facts %+v, want endpoints %v", f, want)
	}
}

func welcome(peers ...proto.MeshPeer) *proto.WelcomeMesh {
	return &proto.WelcomeMesh{Address: "fd12:3456:789a::1", Prefix: "fd12:3456:789a::/48", Peers: peers}
}

// A welcome's mesh brings the device up with its address, the firewall first; mesh.peers is applied as the whole list;
// a welcome without a mesh takes it all down.
func TestApplyAsDesiredState(t *testing.T) {
	h := newHarness(t, t.TempDir())
	if h.m.Health() != nil || len(h.devices) != 0 {
		t.Fatal("the device is up before any welcome")
	}
	if err := h.m.Apply(nil); err != nil || len(h.devices) != 0 {
		t.Fatal("a welcome without a mesh brought the device up")
	}
	b, c := testKey(t), testKey(t)
	pb := proto.MeshPeer{HostID: "host_b", PublicKey: b.String(), Address: "fd12:3456:789a::2", Endpoints: []string{"192.0.2.2:51820"}}
	pc := proto.MeshPeer{HostID: "host_c", PublicKey: c.String(), Address: "fd12:3456:789a::3/128", Endpoints: []string{"192.0.2.3:51820"}}
	if err := h.m.Apply(welcome(pb)); err != nil {
		t.Fatal(err)
	}
	if len(h.firewall.up) != 1 || h.firewall.up[0].String() != "fd12:3456:789a::/48" {
		t.Fatalf("firewall: %v", h.firewall.up)
	}
	if !slices.Contains(h.commands, "ip -6 addr add fd12:3456:789a::1/128 dev kmesh0 nodad") ||
		!slices.Contains(h.commands, "ip -6 route replace fd12:3456:789a::/48 dev kmesh0") {
		t.Fatalf("link: %v", h.commands)
	}
	d := h.device()
	if p, ok := d.peers[b]; !ok || p.Endpoint.String() != "192.0.2.2:51820" || p.Address.String() != "fd12:3456:789a::2" {
		t.Fatalf("peers: %+v", d.peers)
	}
	if p, ok := h.m.Prefix(); !ok || p.String() != "fd12:3456:789a::/48" {
		t.Fatal("no prefix while up")
	}

	h.m.SetPeers([]proto.MeshPeer{pc})
	if _, ok := d.peers[b]; ok || len(d.peers) != 1 {
		t.Fatalf("a peer missing from mesh.peers wasn't removed: %+v", d.peers)
	}
	h.m.SetPeers(nil)
	if len(d.peers) != 0 {
		t.Fatal("an empty mesh.peers left peers")
	}
	if hl := h.m.Health(); hl == nil || len(hl.Peers) != 0 || hl.Address != "fd12:3456:789a::1" {
		t.Fatalf("health with no peers: %+v", hl)
	}

	// The same welcome again (a reconnect) keeps the device.
	h.m.SetPeers([]proto.MeshPeer{pb})
	if err := h.m.Apply(welcome(pb)); err != nil || len(h.devices) != 1 {
		t.Fatal("a second welcome brought a new device up")
	}

	if err := h.m.Apply(nil); err != nil || !d.closed || h.m.Health() != nil {
		t.Fatal("a welcome without a mesh didn't take the device down")
	}
	if _, ok := h.m.Prefix(); ok {
		t.Fatal("a prefix while down")
	}
	// mesh.peers while down is ignored.
	h.m.SetPeers([]proto.MeshPeer{pb})
	if len(h.devices) != 1 {
		t.Fatal("mesh.peers brought the device up")
	}
}

// Peers the host can't trust to be its pool's are left out: a bad key, an address outside the prefix, itself.
func TestPeersLeftOut(t *testing.T) {
	h := newHarness(t, t.TempDir())
	good := testKey(t)
	peers := []proto.MeshPeer{
		{HostID: "bad_key", PublicKey: "nope", Address: "fd12:3456:789a::4"},
		{HostID: "outside", PublicKey: testKey(t).String(), Address: "fd99::4"},
		{HostID: "v4", PublicKey: testKey(t).String(), Address: "10.0.0.4"},
		{HostID: "self", PublicKey: h.m.PublicKey().String(), Address: "fd12:3456:789a::5"},
		{HostID: "my_address", PublicKey: testKey(t).String(), Address: "fd12:3456:789a::1"},
		{HostID: "good", PublicKey: good.String(), Address: "fd12:3456:789a::6"},
	}
	if err := h.m.Apply(welcome(peers...)); err != nil {
		t.Fatal(err)
	}
	if d := h.device(); len(d.peers) != 1 || d.peers[good].Address.String() != "fd12:3456:789a::6" {
		t.Fatalf("peers: %+v", d.peers)
	}
}

// A welcome whose address isn't in its prefix, or isn't IPv6, brings nothing up; nor does one whose firewall fails.
func TestBadMeshBringsNothingUp(t *testing.T) {
	h := newHarness(t, t.TempDir())
	for _, w := range []*proto.WelcomeMesh{
		{Address: "fd00::1", Prefix: "fd12:3456:789a::/48"},
		{Address: "10.0.0.1", Prefix: "10.0.0.0/8"},
		{Address: "fd12:3456:789a::1", Prefix: "nonsense"},
	} {
		if err := h.m.Apply(w); err == nil {
			t.Errorf("%+v: no error", w)
		}
	}
	h.firewall.failUp = true
	if err := h.m.Apply(welcome()); err == nil {
		t.Fatal("a failed firewall brought the device up")
	}
	if len(h.devices) != 0 {
		t.Fatal("a device was made")
	}
}

// A peer not reached moves on to its next endpoint once one has had its time; a peer reached stays on its own, and
// shows as direct with its handshake.
func TestEndpointsTriedInTurn(t *testing.T) {
	h := newHarness(t, t.TempDir())
	b := testKey(t)
	pb := proto.MeshPeer{HostID: "host_b", PublicKey: b.String(), Address: "fd12:3456:789a::2", Endpoints: []string{"192.0.2.2:51820", "[2001:db8::2]:51820"}}
	if err := h.m.Apply(welcome(pb)); err != nil {
		t.Fatal(err)
	}
	d := h.device()
	h.m.rotate(context.Background())
	if d.peers[b].Endpoint.String() != "192.0.2.2:51820" {
		t.Fatal("moved on before the endpoint had its time")
	}
	age := func() {
		h.m.mu.Lock()
		h.m.peers[b].triedAt = time.Now().Add(-endpointTry)
		h.m.mu.Unlock()
	}
	age()
	h.m.rotate(context.Background())
	if d.peers[b].Endpoint.String() != "[2001:db8::2]:51820" {
		t.Fatalf("endpoint %s, want the second", d.peers[b].Endpoint)
	}
	if hl := h.m.Health(); hl.Peers[0].Path != proto.MeshPathNone || hl.Peers[0].LastHandshake != 0 {
		t.Fatalf("health of a peer not reached: %+v", hl.Peers[0])
	}

	d.mu.Lock()
	d.stats[b] = PeerStats{LastHandshake: time.Now()}
	d.mu.Unlock()
	age()
	h.m.rotate(context.Background())
	if d.peers[b].Endpoint.String() != "[2001:db8::2]:51820" {
		t.Fatal("a peer reached was moved off its endpoint")
	}
	if hl := h.m.Health(); hl.Peers[0].Path != proto.MeshPathDirect || hl.Peers[0].Endpoint != "[2001:db8::2]:51820" || hl.Peers[0].LastHandshake == 0 {
		t.Fatalf("health of a peer reached: %+v", hl.Peers[0])
	}
	// New endpoints for a peer reached don't move it off the one it is reached on...
	pb.Endpoints = []string{"192.0.2.9:51820"}
	h.m.SetPeers([]proto.MeshPeer{pb})
	if d.peers[b].Endpoint.String() != "[2001:db8::2]:51820" {
		t.Fatal("new endpoints moved a peer reached")
	}
	// ...until it stops being reached: then its one endpoint is tried, though it has no other to move on to.
	d.mu.Lock()
	d.stats[b] = PeerStats{LastHandshake: time.Now().Add(-handshakeFresh)}
	d.mu.Unlock()
	age()
	h.m.rotate(context.Background())
	if d.peers[b].Endpoint.String() != "192.0.2.9:51820" {
		t.Fatalf("endpoint %s, want the peer's new one", d.peers[b].Endpoint)
	}
}

// A handshake that comes while a rotation looks its next endpoint up keeps the endpoint it came over.
func TestRotationDroppedOnceReached(t *testing.T) {
	h := newHarness(t, t.TempDir())
	b := testKey(t)
	pb := proto.MeshPeer{HostID: "host_b", PublicKey: b.String(), Address: "fd12:3456:789a::2", Endpoints: []string{"192.0.2.2:51820", "b.example.com:51820"}}
	if err := h.m.Apply(welcome(pb)); err != nil {
		t.Fatal(err)
	}
	d := h.device()
	was := lookup
	t.Cleanup(func() { lookup = was })
	lookup = func(ctx context.Context, endpoint string) netip.AddrPort {
		d.mu.Lock()
		d.stats[b] = PeerStats{LastHandshake: time.Now()}
		d.mu.Unlock()
		return netip.MustParseAddrPort("198.51.100.2:51820")
	}
	h.m.mu.Lock()
	h.m.peers[b].triedAt = time.Now().Add(-endpointTry)
	h.m.mu.Unlock()
	h.m.rotate(context.Background())
	if got := d.peers[b].Endpoint.String(); got != "192.0.2.2:51820" {
		t.Fatalf("endpoint %s: a peer reached during the lookup was moved", got)
	}
}

// A round trip is measured whether the peer's sync port answers or refuses; nothing answering is none.
func TestProbeRTT(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	loopback := netip.MustParseAddr("127.0.0.1")
	if probeRTT(context.Background(), loopback, port) <= 0 {
		t.Fatal("no round trip to a port that answers")
	}
	l.Close()
	if probeRTT(context.Background(), loopback, port) <= 0 {
		t.Fatal("no round trip to a port that refuses")
	}
	// TEST-NET-1 answers nothing.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if rtt := probeRTT(ctx, netip.MustParseAddr("192.0.2.1"), port); rtt != 0 {
		t.Fatalf("a round trip of %s to an address that answers nothing", rtt)
	}
}

func TestParseStats(t *testing.T) {
	a, b := testKey(t), testKey(t)
	raw := "private_key=00\nlisten_port=51820\npublic_key=" + a.hex() + "\nendpoint=192.0.2.2:51820\nlast_handshake_time_sec=1700000000\nlast_handshake_time_nsec=5\n" +
		"public_key=" + b.hex() + "\nlast_handshake_time_sec=0\nlast_handshake_time_nsec=0\nerrno=0\n"
	got := parseStats(raw)
	if len(got) != 2 || got[0].PublicKey != a || got[0].Endpoint.String() != "192.0.2.2:51820" || got[0].LastHandshake.Unix() != 1700000000 ||
		got[1].PublicKey != b || !got[1].LastHandshake.IsZero() || got[1].Endpoint.IsValid() {
		t.Fatalf("%+v", got)
	}
}

// The host's address and its peers' are known while the device is up, for the peer sync server: a connection from a
// peer's mesh address is that peer's, and from any other address no peer's.
func TestAddressAndPeerAt(t *testing.T) {
	h := newHarness(t, t.TempDir())
	if _, up := h.m.Address(); up {
		t.Fatal("an address before the mesh is up")
	}
	b := testKey(t)
	pb := proto.MeshPeer{HostID: "host_b", PublicKey: b.String(), Address: "fd12:3456:789a::2", Endpoints: []string{"192.0.2.2:51820"}}
	if err := h.m.Apply(welcome(pb)); err != nil {
		t.Fatal(err)
	}
	if addr, up := h.m.Address(); !up || addr != netip.MustParseAddr("fd12:3456:789a::1") {
		t.Fatalf("address %v %v", addr, up)
	}
	if id, ok := h.m.PeerAt(netip.MustParseAddr("fd12:3456:789a::2")); !ok || id != "host_b" {
		t.Fatalf("peer at ::2: %q %v", id, ok)
	}
	for _, a := range []string{"fd12:3456:789a::1", "fd12:3456:789a::3", "192.0.2.2"} {
		if id, ok := h.m.PeerAt(netip.MustParseAddr(a)); ok {
			t.Fatalf("peer at %s: %q", a, id)
		}
	}
	h.m.SetPeers(nil)
	if _, ok := h.m.PeerAt(netip.MustParseAddr("fd12:3456:789a::2")); ok {
		t.Fatal("a removed peer is still known")
	}
	if err := h.m.Apply(nil); err != nil {
		t.Fatal(err)
	}
	if _, up := h.m.Address(); up {
		t.Fatal("an address once the mesh is down")
	}
}
