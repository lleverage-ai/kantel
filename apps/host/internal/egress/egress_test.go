package egress

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

// upstream is a stand-in for Kantel's vault proxy or Mehen: it records what each request carried.
type upstream struct {
	l    net.Listener
	mu   sync.Mutex
	seen []http.Header
	urls []string
}

func newUpstream(t *testing.T) *upstream {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	u := &upstream{l: l}
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go u.serve(conn)
		}
	}()
	t.Cleanup(func() { l.Close() })
	return u
}

func (u *upstream) serve(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	for {
		req, err := http.ReadRequest(r)
		if err != nil {
			return
		}
		u.mu.Lock()
		u.seen = append(u.seen, req.Header.Clone())
		u.urls = append(u.urls, req.Method+" "+req.RequestURI)
		u.mu.Unlock()
		if req.Method == http.MethodConnect {
			io.WriteString(conn, "HTTP/1.1 200 OK\r\n\r\n")
			io.Copy(conn, r) // echo the tunnel
			return
		}
		io.Copy(io.Discard, req.Body)
		body := "hello from " + req.URL.Host
		fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
	}
}

func (u *upstream) last() (http.Header, string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.seen) == 0 {
		return nil, ""
	}
	return u.seen[len(u.seen)-1], u.urls[len(u.urls)-1]
}

func (u *upstream) count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.seen)
}

func startProxy(t *testing.T, rules map[netip.Addr]Rules) *Proxy {
	p := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	// The stand-in upstream listens on loopback, which the proxy refuses unless an operator allows it.
	p.Destinations.Allow = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	p.Resolve = func(a netip.Addr) (Rules, bool) {
		r, ok := rules[a]
		return r, ok
	}
	if err := p.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

func dial(t *testing.T, p *Proxy) (net.Conn, *bufio.Reader) {
	conn, err := net.Dial("tcp", p.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	return conn, bufio.NewReader(conn)
}

var loopback = netip.MustParseAddr("127.0.0.1")

func TestAttributionComesFromTheHostNotTheSandbox(t *testing.T) {
	up := newUpstream(t)
	p := startProxy(t, map[netip.Addr]Rules{loopback: {
		SandboxID: "sbx_1", Account: "acct_1", Mode: "proxy", Upstream: "http://" + up.l.Addr().String(), Token: "tok-secret", AttributionKey: "k1",
	}})
	conn, r := dial(t, p)
	// The sandbox tries to pass as another sandbox and sends its own label in its proxy URL's user name.
	fmt.Fprintf(conn, "GET http://api.example.com/v1 HTTP/1.1\r\nHost: api.example.com\r\nKantel-Sandbox: sbx_other\r\nKantel-Account: acct_other\r\nProxy-Authorization: Basic %s\r\n\r\n",
		base64.StdEncoding.EncodeToString([]byte("sandbox-call_42:x")))
	res, err := http.ReadResponse(r, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || string(body) != "hello from api.example.com" {
		t.Fatalf("got %d %q", res.StatusCode, body)
	}
	h, _ := up.last()
	if got := h.Get("Kantel-Sandbox"); got != "sbx_1" {
		t.Fatalf("Kantel-Sandbox %q: the sandbox's own header got through", got)
	}
	if got := h.Get("Kantel-Account"); got != "acct_1" {
		t.Fatalf("Kantel-Account %q", got)
	}
	if got := h.Get("Proxy-Authorization"); got != "Basic "+base64.StdEncoding.EncodeToString([]byte("sbx:tok-secret")) {
		t.Fatalf("Proxy-Authorization %q: want the host's token for the sandbox", got)
	}
	if got := h.Get("Kantel-Attribution"); got != "claimed; call_42" {
		t.Fatalf("Kantel-Attribution %q", got)
	}
	if !Verify("k1", h, time.Minute, time.Now()) {
		t.Fatal("signature doesn't verify")
	}
	if Verify("other-key", h, time.Minute, time.Now()) {
		t.Fatal("signature verifies with the wrong key")
	}
}

func TestConnectThroughUpstreamCarriesIdentity(t *testing.T) {
	up := newUpstream(t)
	p := startProxy(t, map[netip.Addr]Rules{loopback: {SandboxID: "sbx_2", Mode: "proxy", Upstream: "http://" + up.l.Addr().String(), Token: "t2"}})
	conn, r := dial(t, p)
	io.WriteString(conn, "CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n")
	res, err := http.ReadResponse(r, &http.Request{Method: http.MethodConnect})
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("CONNECT: %v %v", res, err)
	}
	io.WriteString(conn, "ping")
	buf := make([]byte, 4)
	if _, err := io.ReadFull(r, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("tunnel: %q %v", buf, err)
	}
	h, line := up.last()
	if line != "CONNECT github.com:443" || h.Get("Kantel-Sandbox") != "sbx_2" || !strings.HasPrefix(h.Get("Proxy-Authorization"), "Basic ") {
		t.Fatalf("upstream saw %q %v", line, h)
	}
}

func TestRulesAndUnknownSources(t *testing.T) {
	up := newUpstream(t)
	rules := Rules{SandboxID: "sbx_3", Mode: "proxy", Upstream: "http://" + up.l.Addr().String(), Allow: []string{"*.example.com"}, Deny: []string{"bad.example.com"}, DefaultDeny: true}
	for _, c := range []struct {
		host   string
		status int
	}{{"ok.example.com", 200}, {"bad.example.com", 403}, {"elsewhere.org", 403}} {
		p := startProxy(t, map[netip.Addr]Rules{loopback: rules})
		conn, r := dial(t, p)
		fmt.Fprintf(conn, "GET http://%s/ HTTP/1.1\r\nHost: %s\r\n\r\n", c.host, c.host)
		res, err := http.ReadResponse(r, nil)
		if err != nil || res.StatusCode != c.status {
			t.Fatalf("%s: got %v %v, want %d", c.host, res, err, c.status)
		}
	}
	// A source the host doesn't know (not a sandbox's device) gets nothing.
	p := startProxy(t, map[netip.Addr]Rules{})
	conn, r := dial(t, p)
	io.WriteString(conn, "GET http://ok.example.com/ HTTP/1.1\r\nHost: ok.example.com\r\n\r\n")
	if res, err := http.ReadResponse(r, nil); err != nil || res.StatusCode != 403 {
		t.Fatalf("unknown source: %v %v", res, err)
	}
}

func TestKeepAliveCantSlipPastTheRules(t *testing.T) {
	up := newUpstream(t)
	p := startProxy(t, map[netip.Addr]Rules{loopback: {SandboxID: "sbx_4", Mode: "proxy", Upstream: "http://" + up.l.Addr().String(), Allow: []string{"ok.example.com"}, DefaultDeny: true}})
	conn, r := dial(t, p)
	// Two requests in one write: the second is to a host the rules refuse.
	io.WriteString(conn, "GET http://ok.example.com/ HTTP/1.1\r\nHost: ok.example.com\r\n\r\nGET http://evil.org/ HTTP/1.1\r\nHost: evil.org\r\n\r\n")
	res, err := http.ReadResponse(r, nil)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("first: %v %v", res, err)
	}
	io.ReadAll(res.Body)
	if _, err := http.ReadResponse(r, nil); err == nil {
		t.Fatal("a second request on the connection was answered")
	}
	time.Sleep(50 * time.Millisecond)
	if n := up.count(); n != 1 {
		t.Fatalf("upstream saw %d requests, want 1", n)
	}
}

// An account's upstream headers go on, but never over the host's own Kantel-* identity.
func TestUpstreamHeadersCantSpoofIdentity(t *testing.T) {
	h := Headers(Rules{SandboxID: "sbx_1", Account: "acct_1", Headers: map[string]string{"X-Mehen-Key": "k", "kantel-sandbox": "sbx_evil"}}, "", time.Unix(0, 0))
	if h.Get("X-Mehen-Key") != "k" {
		t.Errorf("X-Mehen-Key = %q", h.Get("X-Mehen-Key"))
	}
	if h.Get("Kantel-Sandbox") != "sbx_1" || len(h.Values("Kantel-Sandbox")) != 1 {
		t.Errorf("Kantel-Sandbox = %v", h.Values("Kantel-Sandbox"))
	}
}
