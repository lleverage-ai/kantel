package mesh

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

// PeerConfig is one WireGuard peer as a device carries it: its key, its one mesh address (its allowed IP) and the
// endpoint to send to (zero: leave the endpoint as it is).
type PeerConfig struct {
	PublicKey Key
	Address   netip.Addr
	Endpoint  netip.AddrPort
}

// PeerStats is a peer as the device sees it now: the endpoint it sends to (where the peer was last heard from, or was
// last set) and its last handshake (zero before the first).
type PeerStats struct {
	PublicKey     Key
	Endpoint      netip.AddrPort
	LastHandshake time.Time
}

// Device is a WireGuard device named name with the host's key, listening on its port: wireguard-go in this process
// (OpenUserspace), or a test's stand-in. The device's address and route are Mesh's to set.
type Device interface {
	// SetPeer adds a peer, or updates its address and, unless zero, its endpoint.
	SetPeer(p PeerConfig) error
	RemovePeer(k Key) error
	Stats() ([]PeerStats, error)
	Close() error
}

// Opener makes a device.
type Opener func(name string, private Key, port int, log *slog.Logger) (Device, error)

// MTU is the mesh device's: 1500 less WireGuard's overhead over IPv6 (80 bytes).
const MTU = 1420

// keepalive is each peer's persistent keepalive, in seconds: it keeps NAT and firewall state open, and starts a
// handshake when there is none, so a peer is reached before anything is sent to it.
const keepalive = 25

// userspace is wireguard-go over a TUN device.
type userspace struct {
	dev *device.Device
}

// OpenUserspace makes the TUN device name and runs WireGuard on it in this process.
func OpenUserspace(name string, private Key, port int, log *slog.Logger) (Device, error) {
	t, err := tun.CreateTUN(name, MTU)
	if err != nil {
		return nil, fmt.Errorf("mesh device %s: %w", name, err)
	}
	// wireguard-go logs every packet it can't send (a peer's endpoint that doesn't answer yet): debug only.
	logger := &device.Logger{
		Verbosef: device.DiscardLogf,
		Errorf: func(format string, args ...any) {
			log.Debug("wireguard: " + fmt.Sprintf(format, args...))
		},
	}
	d := device.NewDevice(t, conn.NewDefaultBind(), logger)
	if err := d.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\n", private.hex(), port)); err != nil {
		d.Close()
		return nil, fmt.Errorf("mesh device %s: %w", name, err)
	}
	if err := d.Up(); err != nil {
		d.Close()
		return nil, fmt.Errorf("mesh device %s: %w", name, err)
	}
	return &userspace{dev: d}, nil
}

func (u *userspace) SetPeer(p PeerConfig) error {
	var b strings.Builder
	fmt.Fprintf(&b, "public_key=%s\nreplace_allowed_ips=true\nallowed_ip=%s\npersistent_keepalive_interval=%d\n",
		p.PublicKey.hex(), netip.PrefixFrom(p.Address, p.Address.BitLen()), keepalive)
	if p.Endpoint.IsValid() {
		fmt.Fprintf(&b, "endpoint=%s\n", p.Endpoint)
	}
	return u.dev.IpcSet(b.String())
}

func (u *userspace) RemovePeer(k Key) error {
	return u.dev.IpcSet(fmt.Sprintf("public_key=%s\nremove=true\n", k.hex()))
}

func (u *userspace) Stats() ([]PeerStats, error) {
	raw, err := u.dev.IpcGet()
	if err != nil {
		return nil, err
	}
	return parseStats(raw), nil
}

func (u *userspace) Close() error {
	u.dev.Close()
	return nil
}

// parseStats reads the peers out of WireGuard's configuration protocol's answer to get=1.
func parseStats(raw string) []PeerStats {
	var out []PeerStats
	var sec, nsec int64
	flush := func() {
		if len(out) > 0 && (sec != 0 || nsec != 0) {
			out[len(out)-1].LastHandshake = time.Unix(sec, nsec)
		}
		sec, nsec = 0, 0
	}
	s := bufio.NewScanner(strings.NewReader(raw))
	for s.Scan() {
		k, v, ok := strings.Cut(s.Text(), "=")
		if !ok {
			continue
		}
		switch k {
		case "public_key":
			flush()
			var p PeerStats
			if b, err := parseHexKey(v); err == nil {
				p.PublicKey = b
			}
			out = append(out, p)
		case "endpoint":
			if len(out) > 0 {
				out[len(out)-1].Endpoint, _ = netip.ParseAddrPort(v)
			}
		case "last_handshake_time_sec":
			sec, _ = strconv.ParseInt(v, 10, 64)
		case "last_handshake_time_nsec":
			nsec, _ = strconv.ParseInt(v, 10, 64)
		}
	}
	flush()
	return out
}

func parseHexKey(s string) (Key, error) {
	var k Key
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != len(k) {
		return k, fmt.Errorf("not a hex key: %q", s)
	}
	copy(k[:], b)
	return k, nil
}
