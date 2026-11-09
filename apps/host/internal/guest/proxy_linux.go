package guest

import (
	"context"
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

// BridgeProxyAddr is the same forwarder as LocalProxyAddr on Docker's default bridge gateway (docker0's 172.17.0.1),
// for containers (lleverage-ai/kantel#760): 127.0.0.1 inside a container is its own, and the host's proxy is on an
// address a fork or resume changes, which a container keeps in its environment from its start. A container on any
// bridge network reaches it, as the gateway is an address of the guest's: a user-defined network's (compose's) routes
// through its own gateway to it. The image's Docker client settings (~/.docker/config.json, "proxies") give every
// container and build HTTPS_PROXY here.
const BridgeProxyAddr = "172.17.0.1:3128"

// ListenFreebind listens on addr before the address is on any interface (IP_FREEBIND): the guest agent starts before
// dockerd makes docker0, and a connection arrives once it has.
func ListenFreebind(addr string) (net.Listener, error) {
	lc := net.ListenConfig{Control: func(_, _ string, c syscall.RawConn) error {
		var serr error
		if err := c.Control(func(fd uintptr) {
			serr = unix.SetsockoptInt(int(fd), unix.SOL_IP, unix.IP_FREEBIND, 1)
		}); err != nil {
			return err
		}
		return serr
	}}
	return lc.Listen(context.Background(), "tcp4", addr)
}
