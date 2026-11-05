package egress

import (
	"bufio"
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

// recordingProxy is startProxy with every record kept.
func recordingProxy(t *testing.T, rules Rules) (*Proxy, func(n int) []Record) {
	t.Helper()
	p := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	p.Destinations.Allow = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	p.Resolve = func(netip.Addr) (Rules, bool) { return rules, true }
	var mu sync.Mutex
	var records []Record
	p.OnRecord = func(r Record) {
		mu.Lock()
		defer mu.Unlock()
		records = append(records, r)
	}
	if err := p.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	// Each is recorded as its connection finishes, which can be just after the sandbox has read its answer.
	atLeast := func(n int) []Record {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			mu.Lock()
			got := append([]Record(nil), records...)
			mu.Unlock()
			if len(got) >= n || time.Now().After(deadline) {
				if len(got) < n {
					t.Fatalf("%d records, want %d", len(got), n)
				}
				return got
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	return p, atLeast
}

// closedPort is a loopback address nothing listens on.
func closedPort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return addr
}

// unavailable is a destination that answers every request 503, as snapshot.ubuntu.com's load balancer did
// (lleverage-ai/kantel#706): for a CONNECT it is the far end of the tunnel, for proxy form the server itself.
func unavailable(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				r := bufio.NewReader(conn)
				req, err := http.ReadRequest(r)
				if err != nil {
					return
				}
				io.Copy(io.Discard, req.Body)
				body := "<html><body><h1>503 Service Unavailable</h1>\nNo server is available to handle this request.\n</body></html>\n"
				fmt.Fprintf(conn, "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
			}()
		}
	}()
	return l.Addr().String()
}

// An answer the proxy gives itself says so in its status line (all apt shows of it), in X-Kantel-Egress and its
// code, and in its body; and the egress log records it as the sandbox saw it, with its status, code and reason.
func TestTheProxysOwnFailuresSayTheyAreTheProxys(t *testing.T) {
	target := closedPort(t)
	for _, method := range []string{http.MethodConnect, http.MethodGet} {
		t.Run(method, func(t *testing.T) {
			p, records := recordingProxy(t, Rules{SandboxID: "sbx_own", Mode: "open"})
			conn, r := dial(t, p)
			want := "can't connect to " + target + ": connection refused"
			if method == http.MethodConnect {
				fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
			} else {
				fmt.Fprintf(conn, "GET http://%s/dists/resolute/InRelease HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
				want = "can't reach " + target + ": connection refused"
			}
			res, err := http.ReadResponse(r, &http.Request{Method: method})
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(res.Body)
			if res.StatusCode != http.StatusBadGateway || res.Status != "502 Bad Gateway (kantel egress: "+want+")" {
				t.Errorf("status line %q", res.Status)
			}
			if res.Header.Get(EgressHeader) != "error" || res.Header.Get(ErrorHeader) != CodeUpstream {
				t.Errorf("headers %v", res.Header)
			}
			if string(body) != "kantel egress: "+want+".\n" {
				t.Errorf("body %q", body)
			}
			rec := records(1)[0]
			if !rec.Allowed || rec.Code != CodeUpstream || rec.Status != http.StatusBadGateway || rec.Reason != want {
				t.Errorf("recorded %+v", rec)
			}
		})
	}
}

// A destination's own error passes through as it came: no Kantel header and its own status line. A tunnel's is
// inside TLS the proxy never reads, so its record has no status; a proxy-form request's records the destination's.
func TestADestinationsErrorIsPassedOnAsItCame(t *testing.T) {
	target := unavailable(t)
	for _, method := range []string{http.MethodConnect, http.MethodGet} {
		t.Run(method, func(t *testing.T) {
			p, records := recordingProxy(t, Rules{SandboxID: "sbx_up", Mode: "open"})
			conn, r := dial(t, p)
			if method == http.MethodConnect {
				fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
				res, err := http.ReadResponse(r, &http.Request{Method: method})
				if err != nil || res.StatusCode != 200 || res.Header.Get(EgressHeader) != "" {
					t.Fatalf("CONNECT: %v %v", res, err)
				}
			}
			fmt.Fprintf(conn, "GET http://%s/ubuntu/dists/resolute/InRelease HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
			res, err := http.ReadResponse(r, nil)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(res.Body)
			if res.Status != "503 Service Unavailable" || res.Header.Get(EgressHeader) != "" || res.Header.Get(ErrorHeader) != "" {
				t.Errorf("%q %v", res.Status, res.Header)
			}
			if !strings.Contains(string(body), "No server is available") {
				t.Errorf("body %q", body)
			}
			conn.Close()
			rec := records(1)[0]
			wantStatus := http.StatusServiceUnavailable
			if method == http.MethodConnect {
				wantStatus = 0
			}
			if !rec.Allowed || rec.Code != "" || rec.Status != wantStatus {
				t.Errorf("recorded %+v", rec)
			}
		})
	}
}

// A refusal of the proxy's settings is marked "denied" and says why in its status line too.
func TestARefusalSaysWhyInItsStatusLine(t *testing.T) {
	p, records := recordingProxy(t, Rules{SandboxID: "sbx_deny", Mode: "proxy", Deny: []string{"snapshot.ubuntu.com"}})
	conn, r := dial(t, p)
	io.WriteString(conn, "CONNECT snapshot.ubuntu.com:443 HTTP/1.1\r\nHost: snapshot.ubuntu.com:443\r\n\r\n")
	res, err := http.ReadResponse(r, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "403 Forbidden (kantel egress: denied by the proxy settings (snapshot.ubuntu.com))" ||
		res.Header.Get(EgressHeader) != "denied" || res.Header.Get(ErrorHeader) != CodeDenied {
		t.Errorf("%q %v", res.Status, res.Header)
	}
	if rec := records(1)[0]; rec.Allowed || rec.Code != CodeDenied || rec.Status != http.StatusForbidden {
		t.Errorf("recorded %+v", rec)
	}
}

// The account's upstream proxy refusing a tunnel goes back as it sent it, marked as the upstream proxy's, and is
// recorded with its status.
func TestAnUpstreamProxysRefusalIsMarkedAsIts(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				if _, err := http.ReadRequest(bufio.NewReader(conn)); err != nil {
					return
				}
				io.WriteString(conn, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 9\r\n\r\ngateway!\n")
			}()
		}
	}()
	p, records := recordingProxy(t, Rules{SandboxID: "sbx_upp", Mode: "proxy", Upstream: "http://" + l.Addr().String()})
	conn, r := dial(t, p)
	io.WriteString(conn, "CONNECT snapshot.ubuntu.com:443 HTTP/1.1\r\nHost: snapshot.ubuntu.com:443\r\n\r\n")
	res, err := http.ReadResponse(r, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusServiceUnavailable || res.Header.Get(EgressHeader) != "upstream-proxy" {
		t.Errorf("%q %v", res.Status, res.Header)
	}
	if rec := records(1)[0]; rec.Code != CodeUpstream || rec.Status != http.StatusServiceUnavailable || rec.Reason != "the upstream proxy answered 503" {
		t.Errorf("recorded %+v", rec)
	}
}

// The status line holds the proxy's words safely: one line, bounded.
func TestReasonPhraseIsOneBoundedLine(t *testing.T) {
	f := refusal{status: http.StatusBadGateway, message: "can't connect to x\r\nX-Evil: 1 " + strings.Repeat("é", 200)}
	got := f.reasonPhrase()
	if strings.ContainsAny(got, "\r\n") || len(got) > len("Bad Gateway (kantel egress: )…")+maxReasonPhrase+4 || !strings.HasSuffix(got, "…)") {
		t.Errorf("%q", got)
	}
}
