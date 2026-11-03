package guest

import (
	"io"
	"net"
	"net/url"
	"time"
)

// LocalProxyAddr is a fixed address inside every sandbox that forwards to the host's egress proxy, whichever it is.
// The host's proxy is on each sandbox's own gateway address, which a fork (and any restore onto another network
// slot) changes; a program that read the proxy once at start (Chromium, dockerd) points here instead, so it keeps
// working without a restart, and a restart doesn't drop its tabs or containers. With no proxy (egress "none"), a
// connection here is closed at once.
const LocalProxyAddr = "127.0.0.1:3128"

// proxyUpstream is the host proxy's host:port from the identity's HTTP_PROXY, or "" when it gives none.
func proxyUpstream(env map[string]string) string {
	raw := env["HTTP_PROXY"]
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Host
}

// ServeLocalProxy forwards each connection on l to the upstream the newest identity named.
func (s *Server) ServeLocalProxy(l net.Listener) error {
	for {
		conn, err := l.Accept()
		if err != nil {
			return err
		}
		go s.forward(conn)
	}
}

func (s *Server) forward(conn net.Conn) {
	defer conn.Close()
	upstream, _ := s.upstream.Load().(string)
	if upstream == "" {
		return
	}
	up, err := net.DialTimeout("tcp", upstream, 5*time.Second)
	if err != nil {
		return
	}
	defer up.Close()
	done := make(chan struct{}, 2)
	pipe := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if tcp, ok := dst.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		done <- struct{}{}
	}
	go pipe(up, conn)
	go pipe(conn, up)
	<-done
	<-done
}
