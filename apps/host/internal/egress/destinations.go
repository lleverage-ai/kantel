package egress

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"syscall"
)

// ErrDestination is a connection the proxy won't make for a sandbox: to an address that isn't on the public
// internet.
var ErrDestination = errors.New("not a public address")

// Destinations is where the proxy may connect on a sandbox's behalf. The proxy is a sandbox's only way out (package
// network), so this is what keeps a sandbox off the host's own services, the LAN, cloud metadata and other
// sandboxes: anything but a public unicast address is refused, after DNS, unless an operator allows its range.
type Destinations struct {
	// Allow lets the proxy reach these ranges anyway (an operator's LAN mirror, its Mehen or vault proxy).
	Allow []netip.Prefix
	// Deny is refused even when Allow names it (the host's sandbox subnet).
	Deny []netip.Prefix
	// Local lists the host's own addresses and the networks they are on; default the host's interfaces, read at each
	// check.
	Local func() []netip.Prefix
}

// Special-purpose ranges netip has no predicate for (RFC 6890 and its updates), all refused.
var reserved = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // shared address space (carrier-grade NAT, Tailscale)
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
}

var nat64 = netip.MustParsePrefix("64:ff9b::/96")

// interfaceNetworks are the host's own addresses, as the prefixes of the networks they are on.
func interfaceNetworks() []netip.Prefix {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	out := make([]netip.Prefix, 0, len(addrs))
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			ip, ok := netip.AddrFromSlice(n.IP)
			if !ok {
				continue
			}
			bits, _ := n.Mask.Size()
			out = append(out, netip.PrefixFrom(ip.Unmap(), bits).Masked())
		}
	}
	return out
}

// Check says whether the proxy may connect to ip.
func (d Destinations) Check(ip netip.Addr) error {
	ip = ip.Unmap()
	// An IPv4 address inside NAT64's prefix is judged as itself.
	if nat64.Contains(ip) {
		b := ip.As16()
		ip = netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]})
	}
	for _, p := range d.Deny {
		if p.Contains(ip) {
			return fmt.Errorf("%s is a sandbox's address: %w", ip, ErrDestination)
		}
	}
	for _, p := range d.Allow {
		if p.Contains(ip) {
			return nil
		}
	}
	switch {
	case !ip.IsValid(), ip.IsUnspecified(), ip.IsLoopback(), ip.IsPrivate(), ip.IsLinkLocalUnicast(),
		ip.IsLinkLocalMulticast(), ip.IsInterfaceLocalMulticast(), ip.IsMulticast():
		return fmt.Errorf("%s: %w", ip, ErrDestination)
	}
	if ip.Is4() && ip == netip.AddrFrom4([4]byte{255, 255, 255, 255}) {
		return fmt.Errorf("%s: %w", ip, ErrDestination)
	}
	for _, p := range reserved {
		if p.Contains(ip) {
			return fmt.Errorf("%s: %w", ip, ErrDestination)
		}
	}
	local := d.Local
	if local == nil {
		local = interfaceNetworks
	}
	for _, p := range local() {
		if p.Contains(ip) {
			return fmt.Errorf("%s is on one of the host's own networks: %w", ip, ErrDestination)
		}
	}
	return nil
}

// control runs for every connection the proxy's dialer makes, once DNS has answered, so a name can't be used to
// reach an address Check refuses.
func (p *Proxy) control(network, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("%s: %w", address, ErrDestination)
	}
	return p.Destinations.Check(ap.Addr())
}

// publicControl is control for PublicOnly rules: Destinations without its Allow, so only a public address passes,
// whatever private ranges the operator lets ordinary sandboxes reach.
func (p *Proxy) publicControl(network, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("%s: %w", address, ErrDestination)
	}
	if p.PublicDestinations != nil {
		return p.PublicDestinations.Check(ap.Addr())
	}
	return p.Destinations.PublicOnly().Check(ap.Addr())
}

// PublicOnly is d without its Allow: public addresses only.
func (d Destinations) PublicOnly() Destinations {
	d.Allow = nil
	return d
}
