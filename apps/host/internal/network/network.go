// Package network gives each microVM its own link to the host: a TAP device and a /30 from the host's sandbox range
// (10.231.0.0/16 by default), so the host tells every sandbox's traffic apart by the device and address it came from,
// which nothing inside a sandbox can forge.
//
// Rules (iptables, in chains of their own: KANTEL-INPUT, KANTEL-FORWARD, KANTEL-NAT):
//   - a sandbox reaches the host only on the egress proxy's port, and never another sandbox;
//   - "open" sandboxes are NATed to the internet; "proxy" and "none" sandboxes have no route out but the proxy
//     ("none" isn't given the proxy either).
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
}

// New prepares the host: forwarding on, Kantel's chains in place. base is a /16 or larger.
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

// ensure adds a rule unless it is already there.
func (m *Manager) ensure(table string, chain string, position string, rule ...string) error {
	check := append([]string{"iptables", "-w", "-t", table, "-C", chain}, rule...)
	if !m.DryRun {
		if exec.Command(check[0], check[1:]...).Run() == nil {
			return nil
		}
	}
	args := []string{"iptables", "-w", "-t", table}
	if position == "insert" {
		args = append(args, "-I", chain, "1")
	} else {
		args = append(args, "-A", chain)
	}
	return m.run(append(args, rule...)...)
}

func (m *Manager) chain(table, name string) error {
	if !m.DryRun && exec.Command("iptables", "-w", "-t", table, "-L", name, "-n").Run() == nil {
		return m.run("iptables", "-w", "-t", table, "-F", name)
	}
	return m.run("iptables", "-w", "-t", table, "-N", name)
}

func (m *Manager) setup() error {
	if !m.DryRun {
		if err := os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1"), 0o644); err != nil {
			return fmt.Errorf("enable IP forwarding: %w", err)
		}
	}
	base := m.base.String()
	steps := [][]string{}
	for _, c := range [][2]string{{"filter", "KANTEL-INPUT"}, {"filter", "KANTEL-FORWARD"}, {"nat", "KANTEL-NAT"}} {
		if err := m.chain(c[0], c[1]); err != nil {
			return err
		}
	}
	// Into the host from a sandbox: the proxy only.
	steps = append(steps,
		[]string{"filter", "KANTEL-INPUT", "append", "-i", "kt+", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		[]string{"filter", "KANTEL-INPUT", "append", "-i", "kt+", "-p", "tcp", "--dport", fmt.Sprint(m.proxyPort), "-j", "ACCEPT"},
		[]string{"filter", "KANTEL-INPUT", "append", "-i", "kt+", "-j", "DROP"},
		// Between sandboxes: never. Replies to sandboxes: yes. Out of a sandbox: per link (Add).
		[]string{"filter", "KANTEL-FORWARD", "append", "-i", "kt+", "-o", "kt+", "-j", "DROP"},
		[]string{"filter", "KANTEL-FORWARD", "append", "-o", "kt+", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		[]string{"nat", "KANTEL-NAT", "append", "-s", base, "!", "-d", base, "-j", "MASQUERADE"},
		[]string{"filter", "INPUT", "insert", "-i", "kt+", "-j", "KANTEL-INPUT"},
		[]string{"filter", "FORWARD", "insert", "-j", "KANTEL-FORWARD"},
		[]string{"nat", "POSTROUTING", "insert", "-s", base, "-j", "KANTEL-NAT"},
	)
	for _, s := range steps {
		if err := m.ensure(s[0], s[1], s[2], s[3:]...); err != nil {
			return err
		}
	}
	// Docker's DOCKER-USER chain runs before its own FORWARD rules, whose policy drops: sandboxes' traffic has to be
	// let through there too on a host that runs Docker.
	if !m.DryRun && exec.Command("iptables", "-w", "-L", "DOCKER-USER", "-n").Run() == nil {
		if err := m.ensure("filter", "DOCKER-USER", "insert", "-j", "KANTEL-FORWARD"); err != nil {
			return err
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

// Reserve marks a slot as taken by a link that already exists (a sandbox adopted after a restart).
func (m *Manager) Reserve(slot int) {
	m.mu.Lock()
	m.used[slot] = true
	m.mu.Unlock()
}

// LinkFor describes slot's link without creating it.
func (m *Manager) LinkFor(slot int, egress string) Link {
	host, guest := m.slotAddrs(slot)
	b := guest.As4()
	return Link{Slot: slot, Tap: fmt.Sprintf("kt%d", slot), HostIP: host, GuestIP: guest, MAC: fmt.Sprintf("06:00:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3]), Egress: egress}
}

// Add makes a new link: the TAP device, its address and its forwarding rule.
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
	steps := [][]string{
		{"ip", "tuntap", "add", "dev", link.Tap, "mode", "tap"},
		{"ip", "addr", "add", link.HostIP.String() + "/30", "dev", link.Tap},
		{"ip", "link", "set", link.Tap, "up"},
	}
	for _, s := range steps {
		if err := m.run(s...); err != nil {
			m.release(slot)
			return Link{}, err
		}
	}
	if err := m.SetEgress(&link, egress); err != nil {
		m.Remove(link)
		return Link{}, err
	}
	return link, nil
}

// SetEgress changes a link's way out.
func (m *Manager) SetEgress(link *Link, egress string) error {
	for _, target := range []string{"ACCEPT", "DROP"} {
		for !m.DryRun && exec.Command("iptables", "-w", "-C", "KANTEL-FORWARD", "-i", link.Tap, "-j", target).Run() == nil {
			_ = m.run("iptables", "-w", "-D", "KANTEL-FORWARD", "-i", link.Tap, "-j", target)
		}
	}
	target := "DROP"
	if egress == EgressOpen {
		target = "ACCEPT"
	}
	link.Egress = egress
	return m.run("iptables", "-w", "-A", "KANTEL-FORWARD", "-i", link.Tap, "-j", target)
}

func (m *Manager) release(slot int) {
	m.mu.Lock()
	delete(m.used, slot)
	m.mu.Unlock()
}

// Remove deletes a link's device and rule and frees its slot.
func (m *Manager) Remove(link Link) {
	for _, target := range []string{"ACCEPT", "DROP"} {
		for !m.DryRun && exec.Command("iptables", "-w", "-C", "KANTEL-FORWARD", "-i", link.Tap, "-j", target).Run() == nil {
			_ = m.run("iptables", "-w", "-D", "KANTEL-FORWARD", "-i", link.Tap, "-j", target)
		}
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
