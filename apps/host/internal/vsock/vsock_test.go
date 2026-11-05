package vsock

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// pairListener hands out the server end of socketpairs as the same kind of connection Accept makes for vsock.
type pairListener struct{ conns chan net.Conn }

func (l *pairListener) Accept() (net.Conn, error) {
	c, ok := <-l.conns
	if !ok {
		return nil, net.ErrClosed
	}
	return c, nil
}
func (l *pairListener) Close() error {
	defer func() { _ = recover() }()
	close(l.conns)
	return nil
}
func (l *pairListener) Addr() net.Addr { return addr("pair") }

// A handler's request context must stay live while the client waits: Go's server watches the connection with a
// background read, which an *os.File connection must block in, not fail.
func TestRequestContextSurvivesHandler(t *testing.T) {
	l := &pairListener{conns: make(chan net.Conn, 1)}
	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	l.conns <- &fileConn{File: os.NewFile(uintptr(fds[0]), "pair-server")}
	client := &fileConn{File: os.NewFile(uintptr(fds[1]), "pair-client")}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		select {
		case <-r.Context().Done():
			http.Error(w, "context: "+r.Context().Err().Error(), 500)
		case <-time.After(200 * time.Millisecond):
			fmt.Fprint(w, "ok")
		}
	})}
	go func() { _ = srv.Serve(l) }()
	defer srv.Close()
	reader := bufio.NewReader(client)
	// Twice on one connection: the server aborts its background read after each response (a deadline in the past),
	// and must not take that for the client going away.
	for i := 0; i < 2; i++ {
		if _, err := io.WriteString(client, "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}"); err != nil {
			t.Fatal(err)
		}
		res, err := http.ReadResponse(reader, nil)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 || !strings.Contains(string(body), "ok") {
			t.Fatalf("request %d: got %d %q", i+1, res.StatusCode, body)
		}
	}
}
