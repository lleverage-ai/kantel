// Package network gives each microVM its own link to the host: a TAP device and a /30 from the host's sandbox range
// (10.231.0.0/16 by default), so the host tells every sandbox's traffic apart by the device and address it came from,
// which nothing inside a sandbox can forge.
//
// A sandbox's link reaches one thing: the host's egress proxy, on its own gateway address. Nothing is routed in or out.
// The host reaches a sandbox's services over vsock (the guest agent dials the guest's loopback), never over this
// network, so a sandbox needs no inbound path at all and has none. Rules (iptables, in chains of their own):
//
//   - KANTEL-INPUT (traffic from a sandbox to the host): a packet whose source isn't the link's own guest address (a
//     sandbox passing as another to the proxy) or whose destination isn't the link's own gateway address is dropped;
//     then only the proxy's port, and replies; then drop.
//     A sandbox with egress "none" doesn't get the proxy either.
//   - KANTEL-FORWARD: anything from or to a sandbox's device is dropped, whatever its egress mode: no NAT, no route to
//     the internet, the LAN, the host's other networks or another sandbox. The proxy is the only way out, and it
//     refuses private, loopback and link-local destinations itself (package egress).
//   - INPUT: the proxy's port is refused on every interface that isn't a sandbox's, so it is no open proxy for the
//     LAN or the internet.
//   - IPv6 is off on every sandbox device, and ip6tables drops anything from one, so a sandbox can't reach the host
//     over a link-local address that the IPv4 rules don't see.
//
// Egress modes ("open", "proxy", "none") differ only at the proxy: "open" is the proxy with no rules.
package network

import (
	"fmt"
	"net/netip"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// Egress modes.
const (
	EgressOpen  = "open"
	EgressProxy = "proxy"
	EgressNone  = "none"
)

// Link is one sandbox's network.
type Link struct {
	Slot   int
	Tap    string
	HostIP netip.Addr
	// GuestCIDR is the guest's address with its /30 prefix.
	GuestIP netip.Addr
	MAC     string
	Egress  string
}

func (l Link) GuestCIDR() string { return l.GuestIP.String() + "/30" }

// Manager hands out links.
type Manager struct {
	base      netip.Prefix
	proxyPort int
	mu        sync.Mutex
	used      map[int]bool
	// DryRun records commands instead of running them (tests).
	DryRun   bool
	Commands []string
	// ipv6 is whether the host has ip6tables to back the per-device IPv6 switch.
	ipv6 bool
}

// New prepares the host: Kantel's chains in place. base is a /22 or larger.
func New(base string, proxyPort int, dryRun bool) (*Manager, error) {
	prefix, err := netip.ParsePrefix(base)
	if err != nil {
		return nil, fmt.Errorf("sandbox subnet: %w", err)
	}
	if !prefix.Addr().Is4() || prefix.Bits() > 22 {
		return nil, fmt.Errorf("sandbox subnet %s: need an IPv4 /22 or larger", base)
	}
	m := &Manager{base: prefix.Masked(), proxyPort: proxyPort, used: map[int]bool{}, DryRun: dryRun}
	if err := m.setup(); err != nil {
		return nil, err
	}
	return m, nil
}

// Subnet is the range sandboxes' addresses come from.
func (m *Manager) Subnet() netip.Prefix { return m.base }

func (m *Manager) run(args ...string) error {
	if m.DryRun {
		m.Commands = append(m.Commands, strings.Join(args, " "))
		return nil
	}
	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ensure adds a rule unless it is already there. tool is iptables or ip6tables.
func (m *Manager) ensure(tool, table, chain, position string, rule ...string) error {
	check := append([]string{tool, "-w", "-t", table, "-C", chain}, rule...)
	if !m.DryRun {
		if exec.Command(check[0], check[1:]...).Run() == nil {
			return nil
		}
	}
	args := []string{tool, "-w", "-t", table}
	if position == "insert" {
		args = append(args, "-I", chain, "1")
	} else {
		args = append(args, "-A", chain)
	}
	return m.run(append(args, rule...)...)
}

// drop deletes every copy of a rule (a no-op when there is none).
func (m *Manager) drop(tool, table, chain string, rule ...string) {
	if m.DryRun {
		m.Commands = append(m.Commands, strings.Join(append([]string{tool, "-w", "-t", table, "-D", chain}, rule...), " "))
		return
	}
	for i := 0; i < 16; i++ {
		args := append([]string{"-w", "-t", table, "-D", chain}, rule...)
		if exec.Command(tool, args...).Run() != nil {
			return
		}
	}
}

func (m *Manager) chain(tool, table, name string) error {
	if !m.DryRun && exec.Command(tool, "-w", "-t", table, "-L", name, "-n").Run() == nil {
		return m.run(tool, "-w", "-t", table, "-F", name)
	}
	return m.run(tool, "-w", "-t", table, "-N", name)
}

func (m *Manager) setup() error {
	for _, c := range [][2]string{{"filter", "KANTEL-INPUT"}, {"filter", "KANTEL-FORWARD"}} {
		if err := m.chain("iptables", c[0], c[1]); err != nil {
			return err
		}
	}
	proxy := fmt.Sprint(m.proxyPort)
	steps := [][]string{
		// Into the host from a sandbox: the proxy only. Each link inserts its own source check above these (Add).
		{"filter", "KANTEL-INPUT", "append", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		{"filter", "KANTEL-INPUT", "append", "-p", "tcp", "--dport", proxy, "-j", "ACCEPT"},
		{"filter", "KANTEL-INPUT", "append", "-j", "DROP"},
		// Through the host, either way: never.
		{"filter", "KANTEL-FORWARD", "append", "-i", "kt+", "-j", "DROP"},
		{"filter", "KANTEL-FORWARD", "append", "-o", "kt+", "-j", "DROP"},
		{"filter", "INPUT", "insert", "-i", "kt+", "-j", "KANTEL-INPUT"},
		// The proxy's port from anywhere but a sandbox's device: refused, so it is nobody else's proxy.
		{"filter", "INPUT", "insert", "!", "-i", "kt+", "-p", "tcp", "--dport", proxy, "-j", "DROP"},
		{"filter", "FORWARD", "insert", "-j", "KANTEL-FORWARD"},
	}
	for _, s := range steps {
		if err := m.ensure("iptables", s[0], s[1], s[2], s[3:]...); err != nil {
			return err
		}
	}
	// Docker's DOCKER-USER chain runs before its own FORWARD rules: Kantel's drops go there too on a host that runs
	// Docker, so nothing Docker accepts gets a sandbox's traffic through.
	if m.DryRun || exec.Command("iptables", "-w", "-L", "DOCKER-USER", "-n").Run() == nil {
		if err := m.ensure("iptables", "filter", "DOCKER-USER", "insert", "-j", "KANTEL-FORWARD"); err != nil {
			return err
		}
	}
	// Earlier versions NATed "open" sandboxes to the internet: take that out on an upgraded host.
	m.drop("iptables", "nat", "POSTROUTING", "-s", m.base.String(), "-j", "KANTEL-NAT")
	if !m.DryRun && exec.Command("iptables", "-w", "-t", "nat", "-L", "KANTEL-NAT", "-n").Run() == nil {
		_ = m.run("iptables", "-w", "-t", "nat", "-F", "KANTEL-NAT")
		_ = m.run("iptables", "-w", "-t", "nat", "-X", "KANTEL-NAT")
	}
	// IPv6: each device has it switched off (Add); this backs that up where the host has ip6tables.
	if m.DryRun || exec.Command("ip6tables", "-w", "-L", "INPUT", "-n").Run() == nil {
		m.ipv6 = true
		for _, s := range [][]string{
			{"filter", "INPUT", "insert", "-i", "kt+", "-j", "DROP"},
			{"filter", "FORWARD", "insert", "-i", "kt+", "-j", "DROP"},
			{"filter", "FORWARD", "insert", "-o", "kt+", "-j", "DROP"},
		} {
			if err := m.ensure("ip6tables", s[0], s[1], s[2], s[3:]...); err != nil {
				return err
			}
		}
	}
	return nil
}

// slotAddrs is slot n's /30: the host's address and the guest's.
func (m *Manager) slotAddrs(slot int) (netip.Addr, netip.Addr) {
	start := m.base.Addr().As4()
	n := uint32(start[0])<<24 | uint32(start[1])<<16 | uint32(start[2])<<8 | uint32(start[3])
	n += uint32(slot) * 4
	host := netip.AddrFrom4([4]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n + 1)})
	guest := netip.AddrFrom4([4]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n + 2)})
	return host, guest
}

func (m *Manager) slots() int { return 1 << (32 - m.base.Bits() - 2) }

// Adopt takes over a link that already exists (a sandbox adopted after a restart): its slot, and its rules, which the
// restart's setup flushed.
func (m *Manager) Adopt(link Link) error {
	m.mu.Lock()
	m.used[link.Slot] = true
	m.mu.Unlock()
	m.disableIPv6(link.Tap)
	for _, rule := range linkRules(link) {
		if err := m.ensure("iptables", "filter", "KANTEL-INPUT", "insert", rule...); err != nil {
			return err
		}
	}
	return m.applyEgress(link, link.Egress)
}

// LinkFor describes slot's link without creating it.
func (m *Manager) LinkFor(slot int, egress string) Link {
	host, guest := m.slotAddrs(slot)
	b := guest.As4()
	return Link{Slot: slot, Tap: fmt.Sprintf("kt%d", slot), HostIP: host, GuestIP: guest, MAC: fmt.Sprintf("06:00:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3]), Egress: egress}
}

// linkRules hold a link's device to its own two addresses: what comes in from any address but its guest's (a sandbox
// passing as another) or for any address but its own gateway's (the host's other addresses, another sandbox's
// gateway) is dropped.
func linkRules(link Link) [][]string {
	return [][]string{
		{"-i", link.Tap, "!", "-s", link.GuestIP.String() + "/32", "-j", "DROP"},
		{"-i", link.Tap, "!", "-d", link.HostIP.String() + "/32", "-j", "DROP"},
	}
}

// noneRule shuts a link with egress "none" out of the proxy too.
func noneRule(link Link) []string {
	return []string{"-i", link.Tap, "-j", "DROP"}
}

func (m *Manager) disableIPv6(tap string) {
	path := "/proc/sys/net/ipv6/conf/" + tap + "/disable_ipv6"
	if m.DryRun {
		m.Commands = append(m.Commands, "write 1 "+path)
		return
	}
	// Absent when the kernel has no IPv6, which is as good.
	_ = os.WriteFile(path, []byte("1"), 0o644)
}

// Add makes a new link: the TAP device, its address and its rules.
func (m *Manager) Add(egress string) (Link, error) {
	m.mu.Lock()
	slot := -1
	for i := 1; i < m.slots(); i++ {
		if !m.used[i] {
			slot = i
			m.used[i] = true
			break
		}
	}
	m.mu.Unlock()
	if slot < 0 {
		return Link{}, fmt.Errorf("no free sandbox addresses in %s", m.base)
	}
	link := m.LinkFor(slot, egress)
	_ = m.run("ip", "link", "del", link.Tap)
	if err := m.run("ip", "tuntap", "add", "dev", link.Tap, "mode", "tap"); err != nil {
		m.release(slot)
		return Link{}, err
	}
	// Before the device is up, so it never gets an IPv6 link-local address.
	m.disableIPv6(link.Tap)
	steps := [][]string{
		{"ip", "addr", "add", link.HostIP.String() + "/30", "dev", link.Tap},
		{"ip", "link", "set", link.Tap, "up"},
	}
	for _, s := range steps {
		if err := m.run(s...); err != nil {
			_ = m.run("ip", "link", "del", link.Tap)
			m.release(slot)
			return Link{}, err
		}
	}
	for _, rule := range linkRules(link) {
		if err := m.ensure("iptables", "filter", "KANTEL-INPUT", "insert", rule...); err != nil {
			m.Remove(link)
			return Link{}, err
		}
	}
	if err := m.SetEgress(&link, egress); err != nil {
		m.Remove(link)
		return Link{}, err
	}
	return link, nil
}

// SetEgress changes a link's mode. Only "none" changes the network (no proxy either); "open" and "proxy" differ at
// the proxy alone.
func (m *Manager) SetEgress(link *Link, egress string) error {
	link.Egress = egress
	return m.applyEgress(*link, egress)
}

func (m *Manager) applyEgress(link Link, egress string) error {
	if egress == EgressNone {
		return m.ensure("iptables", "filter", "KANTEL-INPUT", "insert", noneRule(link)...)
	}
	m.drop("iptables", "filter", "KANTEL-INPUT", noneRule(link)...)
	return nil
}

func (m *Manager) release(slot int) {
	m.mu.Lock()
	delete(m.used, slot)
	m.mu.Unlock()
}

// Remove deletes a link's device and rules and frees its slot.
func (m *Manager) Remove(link Link) {
	m.drop("iptables", "filter", "KANTEL-INPUT", noneRule(link)...)
	for _, rule := range linkRules(link) {
		m.drop("iptables", "filter", "KANTEL-INPUT", rule...)
	}
	_ = m.run("ip", "link", "del", link.Tap)
	m.release(link.Slot)
}

// SlotOf finds the link whose guest address is ip (the egress proxy's attribution), or -1.
func (m *Manager) SlotOf(ip netip.Addr) int {
	if !m.base.Contains(ip) {
		return -1
	}
	start := m.base.Addr().As4()
	b := ip.As4()
	base := uint32(start[0])<<24 | uint32(start[1])<<16 | uint32(start[2])<<8 | uint32(start[3])
	n := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	offset := n - base
	if offset%4 != 2 {
		return -1
	}
	return int(offset / 4)
}
