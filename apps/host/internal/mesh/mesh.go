// Package mesh is kantel-host's side of its pool's WireGuard mesh (docs/design/disk-store.md, "2a. The mesh"): the
// host's key, the device kmesh0 with the mesh address the control plane gives it, and its peers, the other hosts of its
// pool, kept to the list the control plane last sent.
//
// The host makes its key pair on its first start with the mesh and keeps the private key under its root (mode 0600).
// It reports the public key, its WireGuard port and its endpoints in its hello (Facts.Mesh). The device comes up only
// once a welcome has a mesh (the host's pool has sync on), and goes down on a welcome without one. Endpoints are direct
// only: a peer's are tried in turn until one gets a handshake. NAT traversal and the relay are later work.
//
// The device's name must not start with kt: the firewall takes every kt+ interface for a sandbox's.
package mesh

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

const (
	// DeviceName is the mesh device's name.
	DeviceName = "kmesh0"
	// DefaultPort is WireGuard's UDP port (--mesh-port).
	DefaultPort = 51820
	// SyncPort is the peer sync server's TCP port on the mesh address: the one thing the firewall lets in over the mesh.
	SyncPort = 7480
	// handshakeFresh is how long a handshake counts: WireGuard drops a session's keys after 3 minutes without a new one.
	handshakeFresh = 3 * time.Minute
	// endpointTry is how long one of a peer's endpoints is given to get a handshake before the next is tried.
	endpointTry = 12 * time.Second
	// probeEvery is how often each peer's round-trip time is measured; probeTimeout is how long a probe waits.
	probeEvery   = 15 * time.Second
	probeTimeout = 3 * time.Second
	// tick is how often the mesh checks its peers' endpoints and probes.
	tick = 3 * time.Second
)

// Firewall is the mesh's firewall rules (network.MeshFirewall).
type Firewall interface {
	Up(dev string, prefix netip.Prefix, syncPort, listenPort int) error
	Down(dev string, listenPort int)
}

// Config is the mesh's settings; Dir and Log are needed, the rest has defaults.
type Config struct {
	// Dir holds the private key (Root/mesh).
	Dir string
	// Port is WireGuard's UDP port (default DefaultPort).
	Port int
	// Endpoints are the operator's own endpoints for the host ("host:port", or a host with Port), reported before its
	// interface addresses: a forwarded port, a name.
	Endpoints []string
	Log       *slog.Logger
	// Device is the device's name (default DeviceName).
	Device string
	// SyncPort is the TCP port peers may reach over the mesh (default SyncPort).
	SyncPort int
	// Open makes the device (default OpenUserspace).
	Open Opener
	// Firewall is the mesh's rules (default network.MeshFirewall).
	Firewall Firewall
	// Run runs a command that sets up the device's link (default: run it); nil error is success.
	Run func(args ...string) error
	// Addresses are the host's interface addresses to report as endpoints (default: its interfaces').
	Addresses func() []netip.Addr
}

// Mesh is the host's place in its pool's mesh.
type Mesh struct {
	cfg Config
	key Key
	log *slog.Logger

	mu sync.Mutex
	// dev is the device while it is up; addr and prefix are its address and the pool's prefix.
	dev    Device
	addr   netip.Addr
	prefix netip.Prefix
	peers  map[Key]*peer
	stop   context.CancelFunc
	done   chan struct{}
}

// peer is one of the pool's other hosts as the mesh has it.
type peer struct {
	hostID    string
	address   netip.Addr
	endpoints []string
	// try is the endpoint in endpoints being tried, since triedAt.
	try     int
	triedAt time.Time
	// rtt is its last probe's round-trip time, 0 when that got no answer; probedAt when it ran.
	rtt      time.Duration
	probedAt time.Time
}

// Available says why this machine can't run the mesh, or nil: it needs the TUN device, ip and ip6tables.
func Available() error {
	if _, err := os.Stat("/dev/net/tun"); err != nil {
		return fmt.Errorf("no /dev/net/tun: %w", err)
	}
	for _, tool := range []string{"ip", "ip6tables", "iptables"} {
		if _, err := exec.LookPath(tool); err != nil {
			return fmt.Errorf("no %s: %w", tool, err)
		}
	}
	return nil
}

// New loads (or on first start makes) the host's key, and takes down any device and rules a previous run left. The
// device stays down until Apply is given a mesh.
func New(cfg Config) (*Mesh, error) {
	if cfg.Port == 0 {
		cfg.Port = DefaultPort
	}
	if cfg.Port < 1 || cfg.Port > 65535 {
		return nil, fmt.Errorf("mesh port %d: want 1 to 65535", cfg.Port)
	}
	if cfg.Device == "" {
		cfg.Device = DeviceName
	}
	if strings.HasPrefix(cfg.Device, "kt") {
		return nil, fmt.Errorf("mesh device %s: a kt name is a sandbox's to the firewall", cfg.Device)
	}
	if cfg.SyncPort == 0 {
		cfg.SyncPort = SyncPort
	}
	if cfg.Open == nil {
		cfg.Open = OpenUserspace
	}
	if cfg.Firewall == nil {
		cfg.Firewall = network.NewMeshFirewall(false)
	}
	if cfg.Run == nil {
		cfg.Run = runCommand
	}
	if cfg.Addresses == nil {
		cfg.Addresses = interfaceAddresses
	}
	key, err := LoadKey(cfg.Dir)
	if err != nil {
		return nil, fmt.Errorf("mesh key: %w", err)
	}
	m := &Mesh{cfg: cfg, key: key, log: cfg.Log, peers: map[Key]*peer{}}
	_ = cfg.Run("ip", "link", "del", cfg.Device)
	cfg.Firewall.Down(cfg.Device, cfg.Port)
	return m, nil
}

func runCommand(args ...string) error {
	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// PublicKey is the host's public key.
func (m *Mesh) PublicKey() Key { return m.key.Public() }

// Facts are what the hello says of the mesh: the public key, the port, and the endpoints peers should try.
func (m *Mesh) Facts() *proto.MeshFacts {
	return &proto.MeshFacts{PublicKey: m.PublicKey().String(), ListenPort: m.cfg.Port, Endpoints: m.endpoints()}
}

// endpoints are the operator's endpoints, then the host's interface addresses (public before private) with its port.
func (m *Mesh) endpoints() []string {
	out := []string{}
	for _, e := range m.cfg.Endpoints {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		if _, _, err := net.SplitHostPort(e); err != nil {
			e = net.JoinHostPort(strings.Trim(e, "[]"), fmt.Sprint(m.cfg.Port))
		}
		if !slices.Contains(out, e) {
			out = append(out, e)
		}
	}
	addrs := m.cfg.Addresses()
	// Public addresses first: a private one is only any use to a peer on the same network.
	slices.SortStableFunc(addrs, func(a, b netip.Addr) int {
		return boolInt(private(a)) - boolInt(private(b))
	})
	for _, a := range addrs {
		e := netip.AddrPortFrom(a, uint16(m.cfg.Port)).String()
		if !slices.Contains(out, e) {
			out = append(out, e)
		}
	}
	return out
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

func private(a netip.Addr) bool { return a.IsPrivate() || cgnat.Contains(a) }

// skipInterfaces are interfaces whose addresses are no use to a peer: sandboxes' (kt), the mesh's own, and bridges
// and veths local to the host (Docker's, libvirt's, CNI's).
var skipInterfaces = []string{"kt", "kmesh", "docker", "br-", "veth", "virbr", "cni", "flannel", "cali"}

// interfaceAddresses are the host's unicast addresses on interfaces that are up, but for skipInterfaces'.
func interfaceAddresses() []netip.Addr {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []netip.Addr
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 ||
			slices.ContainsFunc(skipInterfaces, func(p string) bool { return strings.HasPrefix(iface.Name, p) }) {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			n, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip, ok := netip.AddrFromSlice(n.IP)
			if !ok {
				continue
			}
			ip = ip.Unmap()
			if ip.IsGlobalUnicast() && !ip.IsLinkLocalUnicast() {
				out = append(out, ip)
			}
		}
	}
	return out
}

// Prefix is the pool's prefix while the device is up: what sandboxes mustn't reach through the egress proxy.
func (m *Mesh) Prefix() (netip.Prefix, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.prefix, m.dev != nil
}

// Apply makes the mesh what a welcome says: with w, the device up with w's address and the pool's prefix, and its
// peers w's; without (the host's pool has sync off, or the control plane has no mesh), the device down.
func (m *Mesh) Apply(w *proto.WelcomeMesh) error {
	if w == nil {
		m.down()
		return nil
	}
	addr, prefix, err := parseMesh(w.Address, w.Prefix)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dev != nil && (addr != m.addr || prefix != m.prefix) {
		m.log.Info("the mesh address changed: bringing the mesh device up again", "from", m.addr, "to", addr)
		m.downLocked()
	}
	if m.dev == nil {
		if err := m.upLocked(addr, prefix); err != nil {
			return err
		}
	}
	m.setPeersLocked(w.Peers)
	return nil
}

// SetPeers makes the device's peers those of a mesh.peers. Ignored while the device is down: the welcome that brings
// it up carries the peers.
func (m *Mesh) SetPeers(peers []proto.MeshPeer) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dev == nil {
		m.log.Warn("mesh peers without a mesh: ignored until a welcome brings the mesh up", "peers", len(peers))
		return
	}
	m.setPeersLocked(peers)
}

// parseMesh reads a welcome's address (with or without /128) and prefix: IPv6, the address inside the prefix.
func parseMesh(address, prefix string) (netip.Addr, netip.Prefix, error) {
	addr, err := netip.ParseAddr(strings.TrimSuffix(address, "/128"))
	if err != nil || !addr.Is6() || addr.Is4In6() {
		return netip.Addr{}, netip.Prefix{}, fmt.Errorf("mesh address %q: want an IPv6 address", address)
	}
	p, err := netip.ParsePrefix(prefix)
	if err != nil || !p.Addr().Is6() || p.Bits() < 8 || p.Bits() > 120 {
		return netip.Addr{}, netip.Prefix{}, fmt.Errorf("mesh prefix %q: want an IPv6 prefix", prefix)
	}
	p = p.Masked()
	if !p.Contains(addr) {
		return netip.Addr{}, netip.Prefix{}, fmt.Errorf("mesh address %s is outside the pool's prefix %s", addr, p)
	}
	return addr, p, nil
}

// upLocked brings the device up: the firewall first, so nothing reaches it before its rules, then WireGuard, then the
// link's address and route to the pool's prefix.
func (m *Mesh) upLocked(addr netip.Addr, prefix netip.Prefix) error {
	name := m.cfg.Device
	if err := m.cfg.Firewall.Up(name, prefix, m.cfg.SyncPort, m.cfg.Port); err != nil {
		m.cfg.Firewall.Down(name, m.cfg.Port)
		return fmt.Errorf("mesh firewall: %w", err)
	}
	dev, err := m.cfg.Open(name, m.key, m.cfg.Port, m.log)
	if err != nil {
		m.cfg.Firewall.Down(name, m.cfg.Port)
		return err
	}
	// IPv6 on for the device alone (a host or container may have it off by default); nothing forwarded.
	_ = os.WriteFile("/proc/sys/net/ipv6/conf/"+name+"/disable_ipv6", []byte("0"), 0o644)
	for _, args := range [][]string{
		{"ip", "-6", "addr", "add", netip.PrefixFrom(addr, 128).String(), "dev", name, "nodad"},
		{"ip", "link", "set", name, "up"},
		{"ip", "-6", "route", "replace", prefix.String(), "dev", name},
	} {
		if err := m.cfg.Run(args...); err != nil {
			dev.Close()
			_ = m.cfg.Run("ip", "link", "del", name)
			m.cfg.Firewall.Down(name, m.cfg.Port)
			return fmt.Errorf("mesh device: %w", err)
		}
	}
	m.dev, m.addr, m.prefix = dev, addr, prefix
	m.peers = map[Key]*peer{}
	ctx, cancel := context.WithCancel(context.Background())
	m.stop, m.done = cancel, make(chan struct{})
	go m.watch(ctx, m.done)
	m.log.Info("mesh up", "device", name, "address", addr, "prefix", prefix, "port", m.cfg.Port, "publicKey", m.PublicKey())
	return nil
}

func (m *Mesh) down() {
	m.mu.Lock()
	stop, done := m.stop, m.done
	m.stop, m.done = nil, nil
	m.mu.Unlock()
	// The watcher takes the lock, so it is stopped without it.
	if stop != nil {
		stop()
		<-done
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.downLocked()
}

// downLocked takes the device and its rules down. The watcher must be stopped already, or stop itself on its next tick
// (it checks the device it was started for).
func (m *Mesh) downLocked() {
	if m.stop != nil {
		m.stop()
		m.stop, m.done = nil, nil
	}
	if m.dev == nil {
		return
	}
	m.dev.Close()
	_ = m.cfg.Run("ip", "link", "del", m.cfg.Device)
	m.cfg.Firewall.Down(m.cfg.Device, m.cfg.Port)
	m.dev, m.addr, m.prefix = nil, netip.Addr{}, netip.Prefix{}
	m.peers = map[Key]*peer{}
	m.log.Info("mesh down", "device", m.cfg.Device)
}

// Close takes the device down.
func (m *Mesh) Close() { m.down() }

// setPeersLocked makes the device's peers the list's: a peer not in it is removed, a new one added with its first
// endpoint, and one whose address or endpoints changed updated. A peer with a bad key or an address outside the pool's
// prefix is left out, as is the host itself.
func (m *Mesh) setPeersLocked(list []proto.MeshPeer) {
	want := map[Key]proto.MeshPeer{}
	self := m.PublicKey()
	for _, p := range list {
		k, err := ParseKey(p.PublicKey)
		if err != nil || k == self {
			if err != nil {
				m.log.Warn("mesh peer left out: bad key", "host", p.HostID, "error", err)
			}
			continue
		}
		addr, err := netip.ParseAddr(strings.TrimSuffix(p.Address, "/128"))
		if err != nil || !m.prefix.Contains(addr) || addr == m.addr {
			m.log.Warn("mesh peer left out: its address isn't another in the pool's prefix", "host", p.HostID, "address", p.Address, "prefix", m.prefix)
			continue
		}
		want[k] = p
	}
	for k, p := range m.peers {
		if _, ok := want[k]; !ok {
			if err := m.dev.RemovePeer(k); err != nil {
				m.log.Warn("couldn't remove a mesh peer", "host", p.hostID, "error", err)
				continue
			}
			delete(m.peers, k)
			m.log.Info("mesh peer removed", "host", p.hostID)
		}
	}
	for k, w := range want {
		addr, _ := netip.ParseAddr(strings.TrimSuffix(w.Address, "/128"))
		p, ok := m.peers[k]
		if ok && p.address == addr && slices.Equal(p.endpoints, w.Endpoints) {
			p.hostID = w.HostID
			continue
		}
		fresh := &peer{hostID: w.HostID, address: addr, endpoints: slices.Clone(w.Endpoints), triedAt: time.Now()}
		if ok {
			fresh.rtt, fresh.probedAt = p.rtt, p.probedAt
		}
		cfg := PeerConfig{PublicKey: k, Address: addr}
		// A peer already reached keeps the endpoint it is reached on; one not yet starts on its first.
		if !ok || !m.handshakeFreshLocked(k) {
			cfg.Endpoint = m.resolve(fresh, 0)
		}
		if err := m.dev.SetPeer(cfg); err != nil {
			m.log.Warn("couldn't set a mesh peer", "host", w.HostID, "error", err)
			continue
		}
		m.peers[k] = fresh
		if !ok {
			m.log.Info("mesh peer added", "host", w.HostID, "address", addr, "endpoints", w.Endpoints)
		}
	}
}

// resolve is the peer's endpoint i as an address (a name is looked up), or zero when it has none that resolves.
func (m *Mesh) resolve(p *peer, i int) netip.AddrPort {
	if len(p.endpoints) == 0 {
		return netip.AddrPort{}
	}
	e := p.endpoints[i%len(p.endpoints)]
	if ap, err := netip.ParseAddrPort(e); err == nil {
		return netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
	}
	host, port, err := net.SplitHostPort(e)
	if err != nil {
		return netip.AddrPort{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addrs) == 0 {
		return netip.AddrPort{}
	}
	ap, err := netip.ParseAddrPort(net.JoinHostPort(addrs[0].Unmap().String(), port))
	if err != nil {
		return netip.AddrPort{}
	}
	return ap
}

func (m *Mesh) statsLocked() map[Key]PeerStats {
	out := map[Key]PeerStats{}
	if m.dev == nil {
		return out
	}
	stats, err := m.dev.Stats()
	if err != nil {
		return out
	}
	for _, s := range stats {
		out[s.PublicKey] = s
	}
	return out
}

func fresh(s PeerStats, now time.Time) bool {
	return !s.LastHandshake.IsZero() && now.Sub(s.LastHandshake) < handshakeFresh
}

func (m *Mesh) handshakeFreshLocked(k Key) bool {
	return fresh(m.statsLocked()[k], time.Now())
}

// watch moves each peer not reached on to its next endpoint after endpointTry, and measures each peer's round-trip
// time every probeEvery, until ctx ends.
func (m *Mesh) watch(ctx context.Context, done chan struct{}) {
	defer close(done)
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		m.rotate()
		m.probe(ctx)
	}
}

// rotate tries the next endpoint of each peer with no fresh handshake whose endpoint has had its endpointTry.
func (m *Mesh) rotate() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dev == nil {
		return
	}
	now := time.Now()
	stats := m.statsLocked()
	for k, p := range m.peers {
		if fresh(stats[k], now) || len(p.endpoints) < 2 || now.Sub(p.triedAt) < endpointTry {
			continue
		}
		p.try = (p.try + 1) % len(p.endpoints)
		p.triedAt = now
		if ep := m.resolve(p, p.try); ep.IsValid() {
			m.log.Debug("mesh peer not reached: trying its next endpoint", "host", p.hostID, "endpoint", ep)
			if err := m.dev.SetPeer(PeerConfig{PublicKey: k, Address: p.address, Endpoint: ep}); err != nil {
				m.log.Warn("couldn't set a mesh peer's endpoint", "host", p.hostID, "error", err)
			}
		}
	}
}

// probe measures the round-trip time to each peer due one: a TCP connection to its sync port over the mesh, answered
// by the peer's kernel whether or not anything listens there (a refusal is an answer).
func (m *Mesh) probe(ctx context.Context) {
	type due struct {
		key  Key
		addr netip.Addr
	}
	m.mu.Lock()
	var list []due
	now := time.Now()
	for k, p := range m.peers {
		if now.Sub(p.probedAt) >= probeEvery {
			p.probedAt = now
			list = append(list, due{k, p.address})
		}
	}
	m.mu.Unlock()
	for _, d := range list {
		rtt := probeRTT(ctx, d.addr, m.cfg.SyncPort)
		m.mu.Lock()
		if p, ok := m.peers[d.key]; ok {
			p.rtt = rtt
		}
		m.mu.Unlock()
	}
}

// probeRTT is the time a TCP connection to addr's port takes to be answered, accepted or refused; 0 for none.
func probeRTT(ctx context.Context, addr netip.Addr, port int) time.Duration {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	start := time.Now()
	var d net.Dialer
	c, err := d.DialContext(ctx, "tcp", netip.AddrPortFrom(addr, uint16(port)).String())
	elapsed := time.Since(start)
	if err == nil {
		c.Close()
		return max(elapsed, time.Microsecond)
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return max(elapsed, time.Microsecond)
	}
	return 0
}

// Health is how the host reaches each peer, for its capacity reports: nil while the device is down.
func (m *Mesh) Health() *proto.MeshHealth {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.dev == nil {
		return nil
	}
	now := time.Now()
	stats := m.statsLocked()
	h := &proto.MeshHealth{Address: m.addr.String(), Peers: []proto.MeshPeerHealth{}}
	for k, p := range m.peers {
		s := stats[k]
		ph := proto.MeshPeerHealth{HostID: p.hostID, Path: proto.MeshPathNone}
		if fresh(s, now) {
			ph.Path = proto.MeshPathDirect
		}
		if s.Endpoint.IsValid() {
			ph.Endpoint = s.Endpoint.String()
		}
		if !s.LastHandshake.IsZero() {
			ph.LastHandshake = s.LastHandshake.UnixMilli()
		}
		if p.rtt > 0 {
			ph.RTTMs = float64(p.rtt.Microseconds()) / 1000
		}
		h.Peers = append(h.Peers, ph)
	}
	slices.SortFunc(h.Peers, func(a, b proto.MeshPeerHealth) int { return strings.Compare(a.HostID, b.HostID) })
	return h
}
