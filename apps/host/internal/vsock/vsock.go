// Package vsock is the host↔guest transport for microVM sandboxes.
//
// Inside the guest, Listen opens an AF_VSOCK listener. On the host, Firecracker exposes the guest's vsock ports
// through one Unix socket per VM (its `uds_path`): a host connection writes "CONNECT <port>\n", reads "OK <n>\n", and
// is then a byte stream to that guest port. Dial does that handshake.
package vsock

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// AgentPort is the guest agent's vsock port.
const AgentPort = 1024

// Listen listens on a vsock port inside a guest, for any CID.
func Listen(port uint32) (net.Listener, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("vsock socket: %w", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("vsock bind %d: %w", port, err)
	}
	if err := unix.Listen(fd, 128); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("vsock listen: %w", err)
	}
	return &listener{fd: fd, port: port}, nil
}

type listener struct {
	fd   int
	port uint32
}

func (l *listener) Accept() (net.Conn, error) {
	for {
		// Non-blocking, so os.NewFile puts it on Go's poller and deadlines work.
		nfd, _, err := unix.Accept4(l.fd, unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return nil, err
		}
		// net.FileConn doesn't know AF_VSOCK, so the connection is a pollable file.
		return &fileConn{File: os.NewFile(uintptr(nfd), "vsock-conn")}, nil
	}
}

func (l *listener) Close() error   { return unix.Close(l.fd) }
func (l *listener) Addr() net.Addr { return addr(fmt.Sprintf("vsock:%d", l.port)) }

type addr string

func (a addr) Network() string { return "vsock" }
func (a addr) String() string  { return string(a) }

type fileConn struct{ *os.File }

// Read and Write return a deadline's error as os.ErrDeadlineExceeded itself, a net.Error, not wrapped in an
// *os.PathError (which isn't one). Go's HTTP server aborts its background read with a deadline in the past after
// each response and ignores only a net.Error timeout: any other error cancels the connection's context, and with
// it every later request's on that connection.
func (c *fileConn) Read(p []byte) (int, error) {
	n, err := c.File.Read(p)
	return n, netError(err)
}

func (c *fileConn) Write(p []byte) (int, error) {
	n, err := c.File.Write(p)
	return n, netError(err)
}

func netError(err error) error {
	if err != nil && errors.Is(err, os.ErrDeadlineExceeded) {
		return os.ErrDeadlineExceeded
	}
	return err
}

// CloseWrite shuts the connection's sending side (a port stream's half-close).
func (c *fileConn) CloseWrite() error {
	raw, err := c.File.SyscallConn()
	if err != nil {
		return err
	}
	var serr error
	if err := raw.Control(func(fd uintptr) { serr = unix.Shutdown(int(fd), unix.SHUT_WR) }); err != nil {
		return err
	}
	return serr
}

func (c *fileConn) LocalAddr() net.Addr  { return addr("vsock") }
func (c *fileConn) RemoteAddr() net.Addr { return addr("vsock-host") }

// DialHost connects from inside a guest to a port on the host (CID 2). Firecracker hands the connection to the
// Unix socket `<uds_path>_<port>` on the host, if something listens there.
func DialHost(port uint32) (net.Conn, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("vsock socket: %w", err)
	}
	if err := unix.Connect(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_HOST, Port: port}); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("vsock connect host:%d: %w", port, err)
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return &fileConn{File: os.NewFile(uintptr(fd), "vsock-host")}, nil
}

// Dial connects from the host to a guest's vsock port through Firecracker's Unix socket.
func Dial(ctx context.Context, udsPath string, port uint32) (net.Conn, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", udsPath)
	if err != nil {
		return nil, err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(5 * time.Second)
	}
	_ = conn.SetDeadline(deadline)
	if _, err := fmt.Fprintf(conn, "CONNECT %d\n", port); err != nil {
		conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	line, err := reader.ReadString('\n')
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("vsock handshake: %w", err)
	}
	if !strings.HasPrefix(line, "OK ") {
		conn.Close()
		return nil, fmt.Errorf("vsock handshake: %q", strings.TrimSpace(line))
	}
	_ = conn.SetDeadline(time.Time{})
	if reader.Buffered() > 0 {
		return &bufferedConn{Conn: conn, reader: reader}, nil
	}
	return conn, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }
