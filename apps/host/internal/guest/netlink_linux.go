package guest

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

// ConfigureInterface brings name up with exactly the address cidr (any other IPv4 address on it removed) and, when
// gateway isn't empty, a default route through it: `ip link set up`, `ip addr flush`, `ip addr add` and `ip route
// replace default`, over rtnetlink, for images without ip(8).
func ConfigureInterface(name, cidr, gateway string) error {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		return err
	}
	ip, prefix, err := net.ParseCIDR(cidr)
	if err != nil {
		return err
	}
	ip4 := ip.To4()
	if ip4 == nil {
		return fmt.Errorf("%s is not IPv4", cidr)
	}
	ones, _ := prefix.Mask.Size()
	if err := LinkUp(name); err != nil {
		return err
	}
	nl, err := newNetlink()
	if err != nil {
		return err
	}
	defer nl.close()
	// Flush: every IPv4 address on the interface but the one it is to have.
	addrs, err := ifc.Addrs()
	if err != nil {
		return err
	}
	keep := false
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.To4() == nil {
			continue
		}
		have, _ := ipn.Mask.Size()
		if ipn.IP.Equal(ip4) && have == ones {
			keep = true
			continue
		}
		if err := nl.addr(unix.RTM_DELADDR, 0, ifc.Index, ipn.IP.To4(), have); err != nil {
			return fmt.Errorf("remove %s: %w", ipn, err)
		}
	}
	if !keep {
		if err := nl.addr(unix.RTM_NEWADDR, unix.NLM_F_CREATE|unix.NLM_F_REPLACE, ifc.Index, ip4, ones); err != nil {
			return fmt.Errorf("add %s: %w", cidr, err)
		}
	}
	if gateway != "" {
		gw := net.ParseIP(gateway).To4()
		if gw == nil {
			return fmt.Errorf("gateway %q is not IPv4", gateway)
		}
		if err := nl.defaultRoute(ifc.Index, gw); err != nil {
			return fmt.Errorf("default route via %s: %w", gateway, err)
		}
	}
	return nil
}

// SetMAC gives an interface the MAC address mac, as `ip link set <name> address <mac>` does (RTM_NEWLINK).
func SetMAC(name, mac string) error {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		return err
	}
	hw, err := net.ParseMAC(mac)
	if err != nil {
		return err
	}
	if ifc.HardwareAddr.String() == hw.String() {
		return nil
	}
	nl, err := newNetlink()
	if err != nil {
		return err
	}
	defer nl.close()
	body := make([]byte, unix.SizeofIfInfomsg)
	body[0] = unix.AF_UNSPEC
	binary.NativeEndian.PutUint32(body[4:], uint32(ifc.Index))
	body = append(body, attr(unix.IFLA_ADDRESS, hw)...)
	if err := nl.request(unix.RTM_NEWLINK, 0, body); err != nil {
		return fmt.Errorf("%s address %s: %w", name, mac, err)
	}
	return nil
}

// LinkUp sets an interface up (SIOCSIFFLAGS), as `ip link set <name> up` does.
func LinkUp(name string) error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	ifr, err := unix.NewIfreq(name)
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
		return fmt.Errorf("%s flags: %w", name, err)
	}
	ifr.SetUint16(ifr.Uint16() | unix.IFF_UP)
	if err := unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr); err != nil {
		return fmt.Errorf("%s up: %w", name, err)
	}
	return nil
}

type netlink struct {
	fd  int
	seq uint32
}

func newNetlink() (*netlink, error) {
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.NETLINK_ROUTE)
	if err != nil {
		return nil, err
	}
	if err := unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return &netlink{fd: fd}, nil
}

func (n *netlink) close() { unix.Close(n.fd) }

// attr is one rtattr: its length, type and value, padded to four bytes.
func attr(kind uint16, value []byte) []byte {
	l := unix.SizeofRtAttr + len(value)
	out := make([]byte, (l+3)&^3)
	binary.NativeEndian.PutUint16(out[0:], uint16(l))
	binary.NativeEndian.PutUint16(out[2:], kind)
	copy(out[unix.SizeofRtAttr:], value)
	return out
}

func u32(v uint32) []byte {
	out := make([]byte, 4)
	binary.NativeEndian.PutUint32(out, v)
	return out
}

func (n *netlink) addr(kind uint16, flags uint16, index int, ip net.IP, prefix int) error {
	body := make([]byte, unix.SizeofIfAddrmsg)
	body[0] = unix.AF_INET
	body[1] = byte(prefix)
	body[3] = unix.RT_SCOPE_UNIVERSE
	binary.NativeEndian.PutUint32(body[4:], uint32(index))
	body = append(body, attr(unix.IFA_LOCAL, ip)...)
	body = append(body, attr(unix.IFA_ADDRESS, ip)...)
	return n.request(kind, flags, body)
}

func (n *netlink) defaultRoute(index int, gateway net.IP) error {
	body := make([]byte, unix.SizeofRtMsg)
	body[0] = unix.AF_INET // family
	body[1] = 0            // dst_len: default
	body[4] = unix.RT_TABLE_MAIN
	body[5] = unix.RTPROT_BOOT
	body[6] = unix.RT_SCOPE_UNIVERSE
	body[7] = unix.RTN_UNICAST
	body = append(body, attr(unix.RTA_GATEWAY, gateway)...)
	body = append(body, attr(unix.RTA_OIF, u32(uint32(index)))...)
	return n.request(unix.RTM_NEWROUTE, unix.NLM_F_CREATE|unix.NLM_F_REPLACE, body)
}

// request sends one message and reads its acknowledgement.
func (n *netlink) request(kind, flags uint16, body []byte) error {
	n.seq++
	msg := make([]byte, unix.SizeofNlMsghdr, unix.SizeofNlMsghdr+len(body))
	binary.NativeEndian.PutUint32(msg[0:], uint32(unix.SizeofNlMsghdr+len(body)))
	binary.NativeEndian.PutUint16(msg[4:], kind)
	binary.NativeEndian.PutUint16(msg[6:], flags|unix.NLM_F_REQUEST|unix.NLM_F_ACK)
	binary.NativeEndian.PutUint32(msg[8:], n.seq)
	msg = append(msg, body...)
	if err := unix.Sendto(n.fd, msg, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return err
	}
	buf := make([]byte, 8192)
	for {
		size, _, err := unix.Recvfrom(n.fd, buf, 0)
		if err != nil {
			return err
		}
		msgs, err := syscall.ParseNetlinkMessage(buf[:size])
		if err != nil {
			return err
		}
		for _, m := range msgs {
			if m.Header.Seq != n.seq {
				continue
			}
			if m.Header.Type == unix.NLMSG_ERROR {
				if len(m.Data) < 4 {
					return errors.New("short netlink error")
				}
				if code := int32(binary.NativeEndian.Uint32(m.Data[:4])); code != 0 {
					return syscall.Errno(-code)
				}
				return nil
			}
		}
	}
}
