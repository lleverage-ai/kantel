package guest

import (
	"bufio"
	"context"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"
)

// guestPeer answers Firecracker's vsock handshake on a Unix socket, then answers a port's upgrade only if upgrade.
func guestPeer(t *testing.T, upgrade bool) string { return guestPeerSays(t, upgrade, false) }

// guestPeerSays is guestPeer; refuse answers the upgrade with a 502's headers and withholds its body.
func guestPeerSays(t *testing.T, upgrade, refuse bool) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "v.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				if _, err := r.ReadString('\n'); err != nil {
					return
				}
				_, _ = io.WriteString(c, "OK 1\n")
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					if line == "\r\n" {
						break
					}
				}
				if refuse {
					_, _ = io.WriteString(c, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 100\r\n\r\nno")
				}
				if !upgrade {
					_, _ = io.Copy(io.Discard, r)
					return
				}
				_, _ = io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: "+PortUpgrade+"\r\n\r\n")
				_, _ = io.Copy(c, r)
			}()
		}
	}()
	return path
}

// A guest that never answers a port's upgrade doesn't hold the dial once its context is cancelled.
func TestDialPortEndsWhenCancelledBeforeTheUpgrade(t *testing.T) {
	for _, refuse := range []bool{false, true} {
		dialEndsWhenCancelled(t, NewClient(guestPeerSays(t, false, refuse)))
	}
}

func dialEndsWhenCancelled(t *testing.T, c *Client) {
	ctx, cancel := context.WithCancel(context.Background())
	errs := make(chan error, 1)
	go func() {
		conn, err := c.DialPort(ctx, 9222)
		if conn != nil {
			conn.Close()
		}
		errs <- err
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("the dial succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the dial stayed blocked after its context was cancelled")
	}
}

// An upgraded stream stays usable after the dial's context ends.
func TestDialPortStreamOutlivesItsDialContext(t *testing.T) {
	c := NewClient(guestPeer(t, true))
	ctx, cancel := context.WithCancel(context.Background())
	conn, err := c.DialPort(ctx, 9222)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	cancel()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("read %q, %v", buf, err)
	}
}
