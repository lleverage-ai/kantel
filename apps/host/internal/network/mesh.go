package network

import (
	"fmt"
	"net/netip"
	"os/exec"
)

// MeshFirewall is the firewall's part in the pool's WireGuard mesh (package mesh), while its device is up:
//
//   - KANTEL-MESH (ip6tables, from INPUT for the mesh device): replies to the host's own connections, and the peer
//     sync port over TCP from the pool's prefix; everything else is dropped.
//   - Nothing is forwarded to or from the mesh device, over IPv4 or IPv6, and nothing comes in on it over IPv4.
//   - WireGuard's UDP port is accepted on every interface but a sandbox's (kt+), for hosts whose INPUT drops by
//     default. WireGuard answers nothing that isn't from a peer's key.
//
// Sandboxes can't reach the mesh: IPv6 is off on their devices and ip6tables drops anything from one (Manager), their
// IPv4 reaches the egress proxy only, and the proxy refuses the mesh's prefix (Destinations.Denied).
type MeshFirewall struct {
	m *Manager
}

// NewMeshFirewall is the mesh's rules, which with dryRun are only recorded (Commands).
func NewMeshFirewall(dryRun bool) *MeshFirewall {
	return &MeshFirewall{m: &Manager{DryRun: dryRun}}
}

// Commands are the commands a dry run recorded.
func (f *MeshFirewall) Commands() []string { return f.m.Commands }

const meshChain = "KANTEL-MESH"

// meshRules are the rules Up puts in INPUT and FORWARD: tool, chain, rule. Each is inserted first in its chain, so
// the last here comes first: the mesh device's own rules come before WireGuard's port, which they would otherwise
// accept over the mesh too.
func meshRules(dev string, listenPort int) [][]string {
	port := fmt.Sprint(listenPort)
	return [][]string{
		{"iptables", "INPUT", "!", "-i", "kt+", "-p", "udp", "--dport", port, "-j", "ACCEPT"},
		{"ip6tables", "INPUT", "!", "-i", "kt+", "-p", "udp", "--dport", port, "-j", "ACCEPT"},
		{"ip6tables", "INPUT", "-i", dev, "-j", meshChain},
		{"ip6tables", "FORWARD", "-i", dev, "-j", "DROP"},
		{"ip6tables", "FORWARD", "-o", dev, "-j", "DROP"},
		{"iptables", "INPUT", "-i", dev, "-j", "DROP"},
		{"iptables", "FORWARD", "-i", dev, "-j", "DROP"},
		{"iptables", "FORWARD", "-o", dev, "-j", "DROP"},
	}
}

// Up puts the rules in place for the mesh device dev, the pool's prefix, the peer sync port and WireGuard's port.
func (f *MeshFirewall) Up(dev string, prefix netip.Prefix, syncPort, listenPort int) error {
	if !prefix.Addr().Is6() {
		return fmt.Errorf("mesh prefix %s: want IPv6", prefix)
	}
	if err := f.m.chain("ip6tables", "filter", meshChain); err != nil {
		return err
	}
	for _, rule := range [][]string{
		{"-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		{"-s", prefix.Masked().String(), "-p", "tcp", "--dport", fmt.Sprint(syncPort), "-j", "ACCEPT"},
		{"-j", "DROP"},
	} {
		if err := f.m.ensure("ip6tables", "filter", meshChain, "append", rule...); err != nil {
			return err
		}
	}
	for _, r := range meshRules(dev, listenPort) {
		if err := f.m.ensure(r[0], "filter", r[1], "insert", r[2:]...); err != nil {
			return err
		}
	}
	return nil
}

// Down takes the rules Up put in place out again, for a device that is gone (or, at start, one a previous run left).
func (f *MeshFirewall) Down(dev string, listenPort int) {
	for _, r := range meshRules(dev, listenPort) {
		f.m.drop(r[0], "filter", r[1], r[2:]...)
	}
	if f.m.DryRun || exec.Command("ip6tables", "-w", "-L", meshChain, "-n").Run() == nil {
		_ = f.m.run("ip6tables", "-w", "-t", "filter", "-F", meshChain)
		_ = f.m.run("ip6tables", "-w", "-t", "filter", "-X", meshChain)
	}
}
