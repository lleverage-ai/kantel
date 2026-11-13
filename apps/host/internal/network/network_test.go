package network

import (
	"net/netip"
	"slices"
	"strings"
	"testing"
)

func has(cmds []string, want string) bool {
	for _, c := range cmds {
		if c == want {
			return true
		}
	}
	return false
}

// The rules a host puts in place, whatever a sandbox's egress mode: nothing routed in or out, the proxy alone on the
// host, and no IPv6.
func TestRulesLeaveTheProxyAsTheOnlyWayOut(t *testing.T) {
	m, err := New("10.231.0.0/16", 3129, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"iptables -w -t filter -A KANTEL-INPUT -p tcp --dport 3129 -j ACCEPT",
		"iptables -w -t filter -A KANTEL-INPUT -j DROP",
		"iptables -w -t filter -A KANTEL-FORWARD -i kt+ -j DROP",
		"iptables -w -t filter -A KANTEL-FORWARD -o kt+ -j DROP",
		"iptables -w -t filter -I INPUT 1 -i kt+ -j KANTEL-INPUT",
		"iptables -w -t filter -I INPUT 1 ! -i kt+ -p tcp --dport 3129 -j DROP",
		"iptables -w -t filter -I FORWARD 1 -j KANTEL-FORWARD",
		"iptables -w -t filter -I DOCKER-USER 1 -j KANTEL-FORWARD",
		"iptables -w -t nat -D POSTROUTING -s 10.231.0.0/16 -j KANTEL-NAT",
		"ip6tables -w -t filter -I INPUT 1 -i kt+ -j DROP",
		"ip6tables -w -t filter -I FORWARD 1 -i kt+ -j DROP",
		"ip6tables -w -t filter -I FORWARD 1 -o kt+ -j DROP",
	} {
		if !has(m.Commands, want) {
			t.Errorf("missing %q", want)
		}
	}
	for _, mode := range []string{EgressOpen, EgressProxy, EgressNone} {
		m.Commands = nil
		link, err := m.Add(mode)
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range m.Commands {
			if strings.Contains(c, "MASQUERADE") || strings.Contains(c, "ACCEPT") || strings.Contains(c, "KANTEL-FORWARD") {
				t.Errorf("%s: %q opens a way that isn't the proxy", mode, c)
			}
		}
		spoof := "iptables -w -t filter -I KANTEL-INPUT 1 -i " + link.Tap + " ! -s " + link.GuestIP.String() + "/32 -j DROP"
		if !has(m.Commands, spoof) {
			t.Errorf("%s: no source check on %s", mode, link.Tap)
		}
		dest := "iptables -w -t filter -I KANTEL-INPUT 1 -i " + link.Tap + " ! -d " + link.HostIP.String() + "/32 -j DROP"
		if !has(m.Commands, dest) {
			t.Errorf("%s: no destination check on %s", mode, link.Tap)
		}
		ipv6 := "write 1 /proc/sys/net/ipv6/conf/" + link.Tap + "/disable_ipv6"
		up := "ip link set " + link.Tap + " up"
		iv6, iup := -1, -1
		for i, c := range m.Commands {
			if c == ipv6 {
				iv6 = i
			}
			if c == up {
				iup = i
			}
		}
		if iv6 < 0 || iup < 0 || iv6 > iup {
			t.Errorf("%s: IPv6 isn't off before %s comes up: %v", mode, link.Tap, m.Commands)
		}
		none := "iptables -w -t filter -I KANTEL-INPUT 1 -i " + link.Tap + " -j DROP"
		if has(m.Commands, none) != (mode == EgressNone) {
			t.Errorf("%s: the proxy shut-out rule is %v", mode, has(m.Commands, none))
		}
		m.Commands = nil
		m.Remove(link)
		if !has(m.Commands, "iptables -w -t filter -D KANTEL-INPUT -i "+link.Tap+" ! -s "+link.GuestIP.String()+"/32 -j DROP") {
			t.Errorf("%s: Remove left the source check", mode)
		}
	}
}

func TestSetEgressOpensAndShutsTheProxyForNone(t *testing.T) {
	m, err := New("10.231.0.0/16", 3129, true)
	if err != nil {
		t.Fatal(err)
	}
	link, err := m.Add(EgressNone)
	if err != nil {
		t.Fatal(err)
	}
	m.Commands = nil
	if err := m.SetEgress(&link, EgressProxy); err != nil {
		t.Fatal(err)
	}
	if !has(m.Commands, "iptables -w -t filter -D KANTEL-INPUT -i "+link.Tap+" -j DROP") || link.Egress != EgressProxy {
		t.Errorf("none to proxy: %v", m.Commands)
	}
}

func TestSlotOfOnlyNamesGuests(t *testing.T) {
	m, err := New("10.231.0.0/16", 3129, true)
	if err != nil {
		t.Fatal(err)
	}
	link := m.LinkFor(5, EgressProxy)
	if got := m.SlotOf(link.GuestIP); got != 5 {
		t.Errorf("guest: %d", got)
	}
	if got := m.SlotOf(link.HostIP); got != -1 {
		t.Errorf("the host's side named slot %d", got)
	}
}

// The mesh device takes the sync port from the pool's prefix and replies only; nothing is forwarded through it, and
// WireGuard's port is open on every device but a sandbox's, below the mesh device's own rules.
func TestMeshFirewall(t *testing.T) {
	f := NewMeshFirewall(true)
	if err := f.Up("kmesh0", netip.MustParsePrefix("fd4b:616e:7465::/48"), 7480, 51820); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"ip6tables -w -t filter -N KANTEL-MESH",
		"ip6tables -w -t filter -A KANTEL-MESH -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
		"ip6tables -w -t filter -A KANTEL-MESH -s fd4b:616e:7465::/48 -p tcp --dport 7480 -j ACCEPT",
		"ip6tables -w -t filter -A KANTEL-MESH -j DROP",
		"iptables -w -t filter -I INPUT 1 ! -i kt+ -p udp --dport 51820 -j ACCEPT",
		"ip6tables -w -t filter -I INPUT 1 ! -i kt+ -p udp --dport 51820 -j ACCEPT",
		"ip6tables -w -t filter -I INPUT 1 -i kmesh0 -j KANTEL-MESH",
		"ip6tables -w -t filter -I FORWARD 1 -i kmesh0 -j DROP",
		"ip6tables -w -t filter -I FORWARD 1 -o kmesh0 -j DROP",
		"iptables -w -t filter -I INPUT 1 -i kmesh0 -j DROP",
		"iptables -w -t filter -I FORWARD 1 -i kmesh0 -j DROP",
		"iptables -w -t filter -I FORWARD 1 -o kmesh0 -j DROP",
	}
	got := f.Commands()
	if !slices.Equal(got, want) {
		t.Fatalf("commands:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if err := f.Up("kmesh0", netip.MustParsePrefix("10.0.0.0/8"), 7480, 51820); err == nil {
		t.Fatal("an IPv4 prefix")
	}
	f = NewMeshFirewall(true)
	f.Down("kmesh0", 51820)
	if cmds := f.Commands(); !has(cmds, "ip6tables -w -t filter -D INPUT -i kmesh0 -j KANTEL-MESH") || !has(cmds, "ip6tables -w -t filter -X KANTEL-MESH") {
		t.Fatalf("down: %v", cmds)
	}
}
