package egress

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress/protect"
)

// recordingConn keeps every byte the proxy writes towards a destination (or an upstream).
type recordingConn struct {
	net.Conn
	out *lockedBuffer
}

func (c *recordingConn) Write(b []byte) (int, error) {
	_, _ = c.out.Write(b)
	return c.Conn.Write(b)
}

// recordDials makes every connection the proxy opens record what it sends.
func (env *protectedEnv) recordDials() *lockedBuffer {
	out := &lockedBuffer{}
	dial := env.proxy.Dial
	env.proxy.Dial = func(network, address string) (net.Conn, error) {
		c, err := dial(network, address)
		if err != nil {
			return nil, err
		}
		return &recordingConn{Conn: c, out: out}, nil
	}
	return out
}

func (env *protectedEnv) setRules(change func(*Rules)) {
	env.mu.Lock()
	defer env.mu.Unlock()
	change(&env.rules)
}

// raw sends one raw request to the proxy and answers its response.
func (env *protectedEnv) raw(request string) (*http.Response, string) {
	env.t.Helper()
	conn, err := net.Dial("tcp", env.proxy.Addr().String())
	if err != nil {
		env.t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.WriteString(conn, request); err != nil {
		env.t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		env.t.Fatalf("%q: %v", request, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	env.noValues("the answer", string(body))
	for k, vs := range res.Header {
		env.noValues("the answer's "+k, strings.Join(vs, ","))
	}
	return res, string(body)
}

// A placeholder in a plain-HTTP request is never swapped, whatever port it names: port 443 isn't TLS.
func TestPlainHTTPNeverCarriesAValue(t *testing.T) {
	env := newProtectedEnv(t)
	sent := env.recordDials()
	for _, target := range []string{"http://api.example.com/echo", "http://api.example.com:443/echo", "http://api.example.com:80/echo"} {
		res, body := env.raw("GET " + target + " HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer " + ghPlaceholder + "\r\n\r\n")
		if res.StatusCode != http.StatusForbidden || res.Header.Get(ErrorHeader) != protect.CodeUnbound {
			t.Fatalf("%s: %d %s %q", target, res.StatusCode, res.Header.Get(ErrorHeader), body)
		}
		// Nor does the proxy check say it would be.
		res, _ = env.raw("GET " + target + " HTTP/1.1\r\nHost: api.example.com\r\n" + CheckHeader + ": " + ghPlaceholder + "\r\n\r\n")
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("check over %s: %d", target, res.StatusCode)
		}
	}
	env.noValues("what the proxy sent out", sent.String())

	// Proxy-form https (the isolate tier's) is verified TLS, so it still swaps, and its answer is scrubbed.
	res, body := env.raw("GET https://api.example.com/echo HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer " + ghPlaceholder + "\r\n\r\n")
	if res.StatusCode != 200 || !strings.Contains(body, "auth=Bearer "+ghPlaceholder) {
		t.Fatalf("proxy-form https: %d %q", res.StatusCode, body)
	}
	if got, _ := env.lastSeen(); got.auth != "Bearer ghs_realValue_1" {
		t.Fatalf("the destination got %+v", got)
	}
	env.noValues("what the proxy sent out in clear", sent.String())
}

// connectProxy is an upstream proxy that answers CONNECT by tunnelling to target, and keeps everything it is sent.
type connectProxy struct {
	addr string
	got  *lockedBuffer
}

func newConnectProxy(t *testing.T, target string) *connectProxy {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	cp := &connectProxy{addr: l.Addr().String(), got: &lockedBuffer{}}
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				r := bufio.NewReader(io.TeeReader(conn, cp.got))
				req, err := http.ReadRequest(r)
				if err != nil || req.Method != http.MethodConnect {
					_, _ = io.WriteString(conn, "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n")
					return
				}
				up, err := net.Dial("tcp", target)
				if err != nil {
					return
				}
				defer up.Close()
				_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n")
				go func() { _, _ = io.Copy(conn, up) }()
				_, _ = io.Copy(up, r)
			}()
		}
	}()
	return cp
}

// Through an upstream, a protected sandbox's proxy-form https request goes in a tunnel, in TLS to the real host:
// the upstream never sees the value in clear text.
func TestProxyFormHTTPSThroughUpstreamStaysInTLS(t *testing.T) {
	env := newProtectedEnv(t)
	dial := env.proxy.Dial
	var target string
	// The test server, found through an example.com name.
	if c, err := dial("tcp", "api.example.com:443"); err == nil {
		target = c.RemoteAddr().String()
		c.Close()
	} else {
		t.Fatal(err)
	}
	up := newConnectProxy(t, target)
	env.proxy.Dial = func(network, address string) (net.Conn, error) {
		if address == up.addr {
			return net.Dial(network, address)
		}
		return dial(network, address)
	}
	env.setRules(func(r *Rules) { r.Upstream = "http://" + up.addr })
	res, body := env.raw("POST https://api.example.com/echo HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer " + ghPlaceholder + "\r\nContent-Length: 0\r\n\r\n")
	if res.StatusCode != 200 || !strings.Contains(body, "auth=Bearer "+ghPlaceholder) {
		t.Fatalf("through the upstream: %d %q", res.StatusCode, body)
	}
	if got, _ := env.lastSeen(); got.auth != "Bearer ghs_realValue_1" {
		t.Fatalf("the destination got %+v", got)
	}
	if !strings.HasPrefix(up.got.String(), "CONNECT api.example.com:443 ") {
		t.Fatalf("the upstream got %q", up.got.String()[:min(80, len(up.got.String()))])
	}
	env.noValues("what the upstream got", up.got.String())
}

// connectStatus sends a CONNECT and answers the proxy's status.
func (env *protectedEnv) connectStatus(authority string) (int, string) {
	env.t.Helper()
	conn, err := net.Dial("tcp", env.proxy.Addr().String())
	if err != nil {
		env.t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", authority, authority)
	res, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
	if err != nil {
		env.t.Fatalf("CONNECT %s: %v", authority, err)
	}
	return res.StatusCode, res.Header.Get(RuleHeader)
}

// A blind tunnel can't carry what a method or path grant denies: it is refused, while a tunnel no such grant names
// still opens and an intercepted host's requests are still judged one by one.
func TestBlindTunnelsCantBypassDetailedDenies(t *testing.T) {
	rule := "deny DELETE api.example.com"
	env := newProtectedEnv(t, Grant{Action: "deny", Host: "api.example.com", Methods: []string{"DELETE"}, Rule: rule})
	if status, got := env.connectStatus("api.example.com:8443"); status != http.StatusForbidden || got != rule {
		t.Fatalf("CONNECT to a denied host's other port: %d %q", status, got)
	}
	if status, _ := env.connectStatus("plain.example.com:443"); status != 200 {
		t.Fatalf("an unrelated blind tunnel: %d", status)
	}
	if status, _ := env.connectStatus("api.example.com:443"); status != 200 {
		t.Fatalf("the intercepted host: %d", status)
	}
	if res, body := env.do(newRequest(t, http.MethodGet, "https://api.example.com/echo", "")); res.StatusCode != 200 {
		t.Fatalf("a permitted request: %d %s", res.StatusCode, body)
	}
	if res, _ := env.do(newRequest(t, http.MethodDelete, "https://api.example.com/echo", "")); res.StatusCode != http.StatusForbidden {
		t.Fatalf("a denied request: %d", res.StatusCode)
	}

	// "*" can't be intercepted, so a detailed deny on it refuses every tunnel it would cover.
	env.setRules(func(r *Rules) {
		r.Grants = []Grant{{Action: "deny", Host: "*", Methods: []string{"DELETE"}, Rule: "deny DELETE *"}}
	})
	if status, got := env.connectStatus("plain.example.com:443"); status != http.StatusForbidden || got != "deny DELETE *" {
		t.Fatalf("a tunnel under a wildcard detailed deny: %d %q", status, got)
	}
}

// interceptedConn is one TLS connection through the proxy to host, for sending several requests on.
type interceptedConn struct {
	t *testing.T
	c *tls.Conn
	r *bufio.Reader
}

func (env *protectedEnv) openIntercepted(host string) *interceptedConn {
	env.t.Helper()
	conn, err := net.Dial("tcp", env.proxy.Addr().String())
	if err != nil {
		env.t.Fatal(err)
	}
	env.t.Cleanup(func() { conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	fmt.Fprintf(conn, "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n", host, host)
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil || res.StatusCode != 200 {
		env.t.Fatalf("CONNECT: %v %v", res, err)
	}
	c := tls.Client(&bufferedConn{Conn: conn, r: br}, &tls.Config{ServerName: host, RootCAs: env.roots})
	return &interceptedConn{t: env.t, c: c, r: bufio.NewReader(c)}
}

func (ic *interceptedConn) send(raw string) (*http.Response, string) {
	ic.t.Helper()
	if _, err := io.WriteString(ic.c, raw); err != nil {
		ic.t.Fatal(err)
	}
	res, err := http.ReadResponse(ic.r, nil)
	if err != nil {
		ic.t.Fatalf("%q: %v", raw, err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	return res, string(body)
}

// A connection kept open across a grant change is judged by the new grants, request by request.
func TestInterceptedConnectionsFollowGrantChanges(t *testing.T) {
	env := newProtectedEnv(t)
	ic := env.openIntercepted("api.example.com")
	if res, body := ic.send("DELETE /repos/x HTTP/1.1\r\nHost: api.example.com\r\n\r\n"); res.StatusCode != 200 {
		t.Fatalf("DELETE before the grant: %d %s", res.StatusCode, body)
	}
	env.setRules(func(r *Rules) {
		r.Grants = []Grant{{Action: "deny", Host: "api.example.com", Methods: []string{"DELETE"}, Rule: "deny DELETE api.example.com"}}
	})
	_, before := env.lastSeen()
	if res, body := ic.send("GET /repos/x HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer " + ghPlaceholder + "\r\n\r\n"); res.StatusCode != 200 || !strings.Contains(body, ghPlaceholder) {
		t.Fatalf("GET after the grant, on the same connection: %d %s", res.StatusCode, body)
	}
	if got, _ := env.lastSeen(); got.auth != "Bearer ghs_realValue_1" {
		t.Fatalf("the destination got %+v", got)
	}
	res, _ := ic.send("DELETE /repos/x HTTP/1.1\r\nHost: api.example.com\r\n\r\n")
	if res.StatusCode != http.StatusForbidden || res.Header.Get(RuleHeader) != "deny DELETE api.example.com" {
		t.Fatalf("DELETE after the grant, on the same connection: %d %v", res.StatusCode, res.Header)
	}
	if _, n := env.lastSeen(); n != before+1 {
		t.Fatalf("the denied DELETE reached the destination (%d requests, want %d)", n, before+1)
	}

	// A sandbox whose rules have gone gets nothing more on a connection it still holds.
	ic = env.openIntercepted("api.example.com")
	env.proxy.Resolve = func(a netip.Addr) (Rules, bool) { return Rules{}, false }
	if res, _ := ic.send("GET /echo HTTP/1.1\r\nHost: api.example.com\r\n\r\n"); res.StatusCode != http.StatusForbidden {
		t.Fatalf("after the sandbox's rules went: %d", res.StatusCode)
	}
}

// The request goes to the virtual host the CONNECT named, whatever its Host header or absolute-form target says.
func TestInterceptedHostHeaderIsTheConnectHost(t *testing.T) {
	env := newProtectedEnv(t)
	ic := env.openIntercepted("api.example.com")
	for _, raw := range []string{
		"GET /echo HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer " + ghPlaceholder + "\r\n\r\n",
		"GET /echo HTTP/1.1\r\nHost: evil.example.com\r\nAuthorization: Bearer " + ghPlaceholder + "\r\n\r\n",
		"GET https://evil.example.com/echo HTTP/1.1\r\nHost: evil.example.com\r\nAuthorization: Bearer " + ghPlaceholder + "\r\n\r\n",
	} {
		res, body := ic.send(raw)
		if res.StatusCode != 200 {
			t.Fatalf("%q: %d %s", raw, res.StatusCode, body)
		}
		env.noValues("the answer", body)
		if got, _ := env.lastSeen(); got.host != "api.example.com" || got.auth != "Bearer ghs_realValue_1" {
			t.Fatalf("%q: the destination got %+v", raw, got)
		}
	}
}

// rotatingSecrets is the host's real Store, with the value rotated (and the Store invalidated, as sandbox.secrets
// does) straight after every read of it: the worst moment for a request's rewrite and its scrubbing to disagree.
type rotatingSecrets struct {
	env   *protectedEnv
	store *protect.Store
	mu    sync.Mutex
	n     int
}

func (r *rotatingSecrets) rotate() {
	r.mu.Lock()
	r.n++
	n := r.n
	r.mu.Unlock()
	r.env.mu.Lock()
	r.env.ghValue = fmt.Sprintf("ghs_rotated_%d", n)
	r.env.mu.Unlock()
	r.store.Invalidate(testSandbox)
}

func (r *rotatingSecrets) Resolve(ctx context.Context, placeholder, sandboxID string, dest protect.Destination) (protect.Resolution, error) {
	defer r.rotate()
	return r.store.Resolve(ctx, placeholder, sandboxID, dest)
}

func (r *rotatingSecrets) Values(ctx context.Context, sandboxID string) ([]protect.Entry, error) {
	defer r.rotate()
	return r.store.Values(ctx, sandboxID)
}

// noValueEver fails if any value the sandbox has had, or has now, is in text.
func noValueEver(t *testing.T, r *rotatingSecrets, where, text string) {
	t.Helper()
	r.mu.Lock()
	n := r.n
	r.mu.Unlock()
	for i := 1; i <= n; i++ {
		if strings.Contains(text, fmt.Sprintf("ghs_rotated_%d", i)) {
			t.Fatalf("%s holds rotated value %d", where, i)
		}
	}
	if strings.Contains(text, "ghs_realValue_1") {
		t.Fatalf("%s holds the first value", where)
	}
}

// A request is swapped and its response scrubbed with one set of values, so a rotation in between (or during a
// streamed upload) can't let a value it sent come back to the sandbox.
func TestRotationDuringARequestCantLeakAValue(t *testing.T) {
	env := newProtectedEnv(t)
	rot := &rotatingSecrets{env: env, store: env.store}
	env.proxy.Secrets = rot

	// Intercepted, and proxy-form https.
	req := newRequest(t, http.MethodPost, "https://api.example.com/echo?q="+ghPlaceholder, "token="+ghPlaceholder)
	req.Header.Set("Authorization", "Bearer "+ghPlaceholder)
	res, err := env.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("intercepted: %d %s", res.StatusCode, body)
	}
	noValueEver(t, rot, "the intercepted answer", string(body)+fmt.Sprint(res.Header))
	got, _ := env.lastSeen()
	if got.auth == "" || got.auth != "Bearer "+strings.TrimPrefix(got.body, "token=") || got.query != "q="+strings.TrimPrefix(got.body, "token=") {
		t.Fatalf("one request was given different values: %+v", got)
	}

	pres, pbody := env.raw("GET https://api.example.com/echo HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer " + ghPlaceholder + "\r\n\r\n")
	if pres.StatusCode != 200 {
		t.Fatalf("proxy-form: %d %s", pres.StatusCode, pbody)
	}
	noValueEver(t, rot, "the proxy-form answer", pbody+fmt.Sprint(pres.Header))

	// A streamed upload, past what is held in memory: its last placeholder is only met once most of it has gone.
	var big bytes.Buffer
	big.WriteString(ghPlaceholder + "|")
	big.Write(bytes.Repeat([]byte("x"), protect.MaxBufferedBody+1024))
	big.WriteString("|" + ghPlaceholder)
	sreq := newRequest(t, http.MethodPut, "https://api.example.com/tail", big.String())
	sres, err := env.client.Do(sreq)
	if err != nil {
		t.Fatal(err)
	}
	sbody, _ := io.ReadAll(sres.Body)
	sres.Body.Close()
	if sres.StatusCode != 200 || !strings.Contains(string(sbody), ghPlaceholder) {
		t.Fatalf("streamed upload: %d %.300s", sres.StatusCode, sbody)
	}
	noValueEver(t, rot, "the streamed upload's answer", string(sbody))
	seen, _ := env.lastSeen()
	head, tail := seen.body[:strings.Index(seen.body, "|")], seen.body[strings.LastIndex(seen.body, "|")+1:]
	if !strings.HasPrefix(head, "ghs_rotated_") || head != tail {
		t.Fatalf("the upload's ends were given different values: %q, %q", head, tail)
	}
}

// A connection kept open across a change to what the upstream is told (its extra headers, the signing key) sends its
// next request through a tunnel opened with the new ones, never one opened with the old.
func TestInterceptedConnectionsFollowUpstreamCredentialChanges(t *testing.T) {
	env := newProtectedEnv(t)
	dial := env.proxy.Dial
	c, err := dial("tcp", "api.example.com:443")
	if err != nil {
		t.Fatal(err)
	}
	target := c.RemoteAddr().String()
	c.Close()
	up := newConnectProxy(t, target)
	env.proxy.Dial = func(network, address string) (net.Conn, error) {
		if address == up.addr {
			return net.Dial(network, address)
		}
		return dial(network, address)
	}
	env.setRules(func(r *Rules) {
		r.Upstream = "http://" + up.addr
		r.Headers = map[string]string{"X-Upstream-Key": "old-key"}
	})
	ic := env.openIntercepted("api.example.com")
	get := "GET /echo HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer " + ghPlaceholder + "\r\n\r\n"
	connects := func() []string {
		var out []string
		for _, line := range strings.Split(up.got.String(), "\r\n\r\n") {
			if i := strings.Index(line, "CONNECT "); i >= 0 {
				out = append(out, line[i:])
			}
		}
		return out
	}
	if res, body := ic.send(get); res.StatusCode != 200 {
		t.Fatalf("first request: %d %s", res.StatusCode, body)
	}
	if res, _ := ic.send(get); res.StatusCode != 200 {
		t.Fatalf("second request, nothing changed: %d", res.StatusCode)
	}
	if got := connects(); len(got) != 1 || !strings.Contains(got[0], "X-Upstream-Key: old-key") {
		t.Fatalf("before the change, one tunnel with the old key: %q", got)
	}

	env.setRules(func(r *Rules) { r.Headers = map[string]string{"X-Upstream-Key": "new-key"} })
	if res, body := ic.send(get); res.StatusCode != 200 {
		t.Fatalf("after the header change: %d %s", res.StatusCode, body)
	}
	got := connects()
	if len(got) != 2 || !strings.Contains(got[1], "X-Upstream-Key: new-key") || strings.Contains(got[1], "old-key") {
		t.Fatalf("after the header change, a new tunnel with the new key: %q", got)
	}

	env.setRules(func(r *Rules) { r.AttributionKey = "signing-key-2" })
	if res, body := ic.send(get); res.StatusCode != 200 {
		t.Fatalf("after the signing key change: %d %s", res.StatusCode, body)
	}
	got = connects()
	if len(got) != 3 || !strings.Contains(got[2], "Kantel-Signature: ") {
		t.Fatalf("after the signing key change, a new signed tunnel: %q", got)
	}
	env.noValues("what the upstream got", up.got.String())
}
