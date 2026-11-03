package egress

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress/protect"
)

const (
	ghPlaceholder  = "kph_0123456789abcdefghijABCDEFGHIJ0123456789"
	npmPlaceholder = "kph_ZYXWVUTSRQzyxwvutsrq9876543210ZYXWVUTSRQ"
	npmValue       = "npm_secretValue_9"
	testSandbox    = "sbx_prot"
)

// seenRequest is one request as the real destination got it.
type seenRequest struct {
	host, method, path, query, auth, body, check string
}

// lockedBuffer is a log the proxy writes from its goroutines and the test reads.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// protectedEnv is a proxy for one protected sandbox, intercepting api.example.com and other.example.com, whose real
// destination is one httptest TLS server with its own CA.
type protectedEnv struct {
	t      *testing.T
	proxy  *Proxy
	store  *protect.Store
	roots  *x509.CertPool // the sandbox's: trusts its egress CA
	client *http.Client
	log    *lockedBuffer

	mu      sync.Mutex
	rules   Rules
	ghValue string
	fetches int
	seen    []seenRequest
	wsGot   []string
	records []Record
}

func newProtectedEnv(t *testing.T, grants ...Grant) *protectedEnv {
	t.Helper()
	env := &protectedEnv{t: t, ghValue: "ghs_realValue_1", log: &lockedBuffer{}}

	upCA, err := NewCA("upstream", []string{"api.example.com", "other.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(env.serve))
	srv.TLS = &tls.Config{GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) { return upCA.Leaf(h.ServerName) }}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	upRoots := x509.NewCertPool()
	upRoots.AddCert(upCA.Certificate())

	env.store = protect.NewStore(func(context.Context, string) (protect.Table, error) {
		env.mu.Lock()
		defer env.mu.Unlock()
		env.fetches++
		return protect.Table{Version: int64(env.fetches), Entries: []protect.Entry{
			{Placeholder: ghPlaceholder, Name: "GITHUB_TOKEN", Value: env.ghValue, Bindings: []protect.Binding{{Host: "api.example.com"}}},
			{Placeholder: npmPlaceholder, Name: "NPM_TOKEN", Value: npmValue, Bindings: []protect.Binding{{Host: "other.example.com", PathPrefixes: []string{"/npm"}}}},
		}}, nil
	})

	rules := Rules{SandboxID: testSandbox, Mode: "proxy", Protected: true, Intercept: []string{"api.example.com", "other.example.com"}, Grants: grants}
	env.rules = rules
	p := New(slog.New(slog.NewTextHandler(env.log, nil)))
	p.Resolve = func(a netip.Addr) (Rules, bool) {
		env.mu.Lock()
		defer env.mu.Unlock()
		return env.rules, a == loopback
	}
	p.Secrets = env.store
	p.CAs = NewCAStore(t.TempDir())
	p.RootCAs = upRoots
	p.OnRecord = func(r Record) {
		env.mu.Lock()
		env.records = append(env.records, r)
		env.mu.Unlock()
	}
	// Every example.com name is the test server; anything else isn't reachable.
	p.Dial = func(network, address string) (net.Conn, error) {
		host, _, _ := net.SplitHostPort(address)
		if !strings.HasSuffix(host, ".example.com") {
			return nil, ErrDestination
		}
		return net.Dial(network, srv.Listener.Addr().String())
	}
	ca, fresh, err := p.CAs.Ensure(testSandbox, rules.InterceptHosts())
	if err != nil || !fresh {
		t.Fatalf("CA: %v", err)
	}
	if err := p.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	env.proxy = p

	env.roots = x509.NewCertPool()
	env.roots.AddCert(ca.Certificate())
	proxyURL, _ := url.Parse("http://" + p.Addr().String())
	env.client = &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: env.roots}, DisableKeepAlives: true},
		Timeout:   10 * time.Second,
	}
	return env
}

func (env *protectedEnv) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/ws" {
		env.serveWebSocket(w, r)
		return
	}
	body, _ := io.ReadAll(r.Body)
	s := seenRequest{host: r.Host, method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, auth: r.Header.Get("Authorization"), body: string(body), check: r.Header.Get(CheckHeader)}
	env.mu.Lock()
	env.seen = append(env.seen, s)
	env.mu.Unlock()
	// An API that echoes what it was sent: the values must not come back into the sandbox.
	w.Header().Set("X-Echo", s.auth)
	if r.URL.Path == "/tail" {
		// A big upload's ends only, so a test of one needn't scrub all of it twice.
		fmt.Fprintf(w, "head=%s\ntail=%s\n", body[:min(len(body), 200)], body[max(0, len(body)-200):])
		return
	}
	if r.URL.Path == "/brotli" {
		// Whatever the request accepted: a coding the proxy can't search (the bytes stand in for real Brotli).
		w.Header().Set("Content-Encoding", "br")
	}
	fmt.Fprintf(w, "auth=%s\nquery=%s\nbody=%s\n", s.auth, s.query, s.body)
}

func (env *protectedEnv) serveWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, rw, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(sum[:]))
	if rw.Flush() != nil {
		return
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, payload, err := readFrame(rw.Reader)
	if err != nil {
		return
	}
	env.mu.Lock()
	env.wsGot = append(env.wsGot, string(payload))
	env.mu.Unlock()
	_ = writeFrame(conn, 1, []byte("got:"+string(payload)), false)
	// Wait for the sandbox's side to end, so what was written gets there.
	_, _, _ = readFrame(rw.Reader)
}

func (env *protectedEnv) lastSeen() (seenRequest, int) {
	env.mu.Lock()
	defer env.mu.Unlock()
	if len(env.seen) == 0 {
		return seenRequest{}, 0
	}
	return env.seen[len(env.seen)-1], len(env.seen)
}

func (env *protectedEnv) recordsCopy() []Record {
	env.mu.Lock()
	defer env.mu.Unlock()
	return append([]Record(nil), env.records...)
}

// noValues fails the test if a value got anywhere the sandbox or a log can see.
func (env *protectedEnv) noValues(where string, text string) {
	env.t.Helper()
	env.mu.Lock()
	values := []string{env.ghValue, npmValue, "ghs_realValue_1"}
	env.mu.Unlock()
	for _, v := range values {
		if strings.Contains(text, v) {
			env.t.Fatalf("%s holds a protected value: %q", where, text)
		}
	}
}

func (env *protectedEnv) do(req *http.Request) (*http.Response, string) {
	env.t.Helper()
	res, err := env.client.Do(req)
	if err != nil {
		env.t.Fatalf("%s %s: %v", req.Method, req.URL, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	env.noValues("the answer's body", string(body))
	for k, vs := range res.Header {
		env.noValues("the answer's "+k, strings.Join(vs, ","))
	}
	return res, string(body)
}

func newRequest(t *testing.T, method, rawURL, body string) *http.Request {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, rawURL, r)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestInterceptSwapsAndScrubs(t *testing.T) {
	env := newProtectedEnv(t)
	req := newRequest(t, http.MethodPost, "https://api.example.com/echo?token="+ghPlaceholder, "token="+ghPlaceholder)
	req.Header.Set("Authorization", "Bearer "+ghPlaceholder)
	req.Header.Set("Accept-Encoding", "br, gzip")
	res, body := env.do(req)
	if res.StatusCode != 200 {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}
	got, _ := env.lastSeen()
	want := "ghs_realValue_1"
	if got.auth != "Bearer "+want || got.query != "token="+want || got.body != "token="+want {
		t.Fatalf("the destination got %+v", got)
	}
	if got.host != "api.example.com" || got.path != "/echo" {
		t.Fatalf("the destination got %+v", got)
	}
	if res.Header.Get("X-Echo") != "Bearer "+ghPlaceholder {
		t.Errorf("X-Echo %q, want the placeholder back", res.Header.Get("X-Echo"))
	}
	if !strings.Contains(body, "auth=Bearer "+ghPlaceholder) || !strings.Contains(body, "body=token="+ghPlaceholder) {
		t.Errorf("body %q, want the placeholders back", body)
	}
	var rec *Record
	for _, r := range env.recordsCopy() {
		if r.Path == "/echo" {
			rec = &r
		}
	}
	if rec == nil || !rec.Allowed || !rec.Inspected || rec.Status != 200 || rec.Method != http.MethodPost || len(rec.Swapped) != 1 || rec.Swapped[0] != "GITHUB_TOKEN" {
		t.Fatalf("record %+v", rec)
	}
	env.noValues("the records", fmt.Sprintf("%+v", env.recordsCopy()))
	env.noValues("the log", env.log.String())
	if strings.Contains(env.log.String(), "token=") {
		t.Errorf("the log holds a query: %s", env.log.String())
	}
}

// A response the proxy can't search could carry a value back, so it is refused rather than passed on.
func TestInterceptRefusesAnUnreadableResponse(t *testing.T) {
	env := newProtectedEnv(t)
	req := newRequest(t, http.MethodGet, "https://api.example.com/brotli", "")
	req.Header.Set("Authorization", "Bearer "+ghPlaceholder)
	req.Header.Set("Accept-Encoding", "br")
	res, body := env.do(req)
	if res.StatusCode != http.StatusBadGateway || res.Header.Get(ErrorHeader) != protect.CodeUnreadableResponse {
		t.Fatalf("status %d, %s %q: %s", res.StatusCode, ErrorHeader, res.Header.Get(ErrorHeader), body)
	}
	env.noValues("the refusal", body)
	if got, _ := env.lastSeen(); got.auth != "Bearer ghs_realValue_1" {
		t.Fatalf("the destination got %+v", got)
	}
	recs := env.recordsCopy()
	if len(recs) == 0 || recs[len(recs)-1].Allowed || recs[len(recs)-1].Code != protect.CodeUnreadableResponse {
		t.Fatalf("records %+v", recs)
	}
}

func TestInterceptRefusesAnUnboundPlaceholder(t *testing.T) {
	env := newProtectedEnv(t)
	req := newRequest(t, http.MethodPost, "https://other.example.com/npm/publish", "")
	req.Header.Set("Authorization", "Bearer "+ghPlaceholder)
	res, body := env.do(req)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}
	if res.Header.Get(ErrorHeader) != protect.CodeUnbound || res.Header.Get(VariableHeader) != "GITHUB_TOKEN" {
		t.Errorf("headers %v", res.Header)
	}
	if !strings.HasPrefix(res.Header.Get("Content-Type"), "text/plain") || !strings.HasPrefix(body, "kantel egress: GITHUB_TOKEN may not be sent to other.example.com") {
		t.Errorf("body %q (%s)", body, res.Header.Get("Content-Type"))
	}
	if _, n := env.lastSeen(); n != 0 {
		t.Fatal("the refused request reached the destination")
	}
	recs := env.recordsCopy()
	if len(recs) == 0 || recs[len(recs)-1].Allowed || recs[len(recs)-1].Code != protect.CodeUnbound {
		t.Fatalf("records %+v", recs)
	}
	// Bound by path too: NPM_TOKEN goes only under /npm.
	req = newRequest(t, http.MethodGet, "https://other.example.com/elsewhere", "")
	req.Header.Set("Authorization", "Bearer "+npmPlaceholder)
	if res, body := env.do(req); res.StatusCode != http.StatusForbidden || res.Header.Get(VariableHeader) != "NPM_TOKEN" {
		t.Fatalf("NPM_TOKEN outside its path: %d %s", res.StatusCode, body)
	}
	req = newRequest(t, http.MethodGet, "https://other.example.com/npm/x", "")
	req.Header.Set("Authorization", "Bearer "+npmPlaceholder)
	if res, body := env.do(req); res.StatusCode != 200 {
		t.Fatalf("NPM_TOKEN under its path: %d %s", res.StatusCode, body)
	}
	if got, _ := env.lastSeen(); got.auth != "Bearer "+npmValue {
		t.Fatalf("the destination got %+v", got)
	}
}

func TestInterceptAppliesGrants(t *testing.T) {
	rule := "deny DELETE api.example.com /repos/**"
	env := newProtectedEnv(t, Grant{Action: "deny", Host: "api.example.com", Methods: []string{"DELETE"}, Paths: []string{"/repos/**"}, Rule: rule})
	res, body := env.do(newRequest(t, http.MethodDelete, "https://api.example.com/repos/acme/app", ""))
	if res.StatusCode != http.StatusForbidden || res.Header.Get(ErrorHeader) != CodeDenied || res.Header.Get(RuleHeader) != rule {
		t.Fatalf("DELETE: %d %v %q", res.StatusCode, res.Header, body)
	}
	if !strings.Contains(body, rule) {
		t.Errorf("body %q doesn't name the rule", body)
	}
	// An encoded slash can't walk round a deny grant.
	if res, _ := env.do(newRequest(t, http.MethodDelete, "https://api.example.com/repos%2Facme", "")); res.StatusCode != http.StatusForbidden {
		t.Errorf("DELETE with an encoded slash: %d", res.StatusCode)
	}
	if _, n := env.lastSeen(); n != 0 {
		t.Fatal("a denied request reached the destination")
	}
	if res, body := env.do(newRequest(t, http.MethodGet, "https://api.example.com/repos/acme/app", "")); res.StatusCode != 200 {
		t.Fatalf("GET: %d %s", res.StatusCode, body)
	}
	recs := env.recordsCopy()
	if len(recs) < 1 || recs[0].Rule != rule || recs[0].Code != CodeDenied || recs[0].Path != "/repos/acme/app" {
		t.Fatalf("records %+v", recs)
	}
}

func TestInterceptRotation(t *testing.T) {
	env := newProtectedEnv(t)
	send := func() string {
		req := newRequest(t, http.MethodGet, "https://api.example.com/echo", "")
		req.Header.Set("Authorization", "Bearer "+ghPlaceholder)
		if res, body := env.do(req); res.StatusCode != 200 {
			t.Fatalf("status %d: %s", res.StatusCode, body)
		}
		got, _ := env.lastSeen()
		return got.auth
	}
	if got := send(); got != "Bearer ghs_realValue_1" {
		t.Fatalf("first: %q", got)
	}
	env.mu.Lock()
	env.ghValue = "ghs_rotated_2"
	env.mu.Unlock()
	if got := send(); got != "Bearer ghs_realValue_1" {
		t.Fatalf("before Invalidate the cached value should go: %q", got)
	}
	env.store.Invalidate(testSandbox)
	if got := send(); got != "Bearer ghs_rotated_2" {
		t.Fatalf("after Invalidate: %q", got)
	}
}

func TestInterceptCheck(t *testing.T) {
	env := newProtectedEnv(t)
	check := func(rawURL, placeholder string) *http.Response {
		req := newRequest(t, http.MethodHead, rawURL, "")
		req.Header.Set(CheckHeader, placeholder)
		res, _ := env.do(req)
		return res
	}
	if res := check("https://api.example.com/", ghPlaceholder); res.StatusCode != http.StatusNoContent || res.Header.Get(CheckHeader) != "ok" {
		t.Fatalf("bound: %d %v", res.StatusCode, res.Header)
	}
	if res := check("https://other.example.com/", ghPlaceholder); res.StatusCode != http.StatusForbidden || res.Header.Get(CheckHeader) != protect.CodeUnbound || res.Header.Get(VariableHeader) != "GITHUB_TOKEN" {
		t.Fatalf("unbound: %d %v", res.StatusCode, res.Header)
	}
	if res := check("https://api.example.com/", "kph_"+strings.Repeat("x", 40)); res.StatusCode != http.StatusForbidden || res.Header.Get(CheckHeader) != protect.CodeUnbound {
		t.Fatalf("unknown: %d %v", res.StatusCode, res.Header)
	}
	if _, n := env.lastSeen(); n != 0 {
		t.Fatal("a check reached the destination")
	}
}

func TestPlaceholdersEndpoint(t *testing.T) {
	env := newProtectedEnv(t)
	res, body := env.do(newRequest(t, http.MethodGet, "http://"+CheckHost+"/placeholders", ""))
	if res.StatusCode != 200 {
		t.Fatalf("status %d: %s", res.StatusCode, body)
	}
	if strings.Contains(body, ghPlaceholder) || strings.Contains(body, npmPlaceholder) {
		t.Fatalf("the endpoint gave a whole placeholder: %s", body)
	}
	var got Placeholders
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Variables) != 2 {
		t.Fatalf("variables %+v", got.Variables)
	}
	gh := got.Variables[0]
	if gh.Name != "GITHUB_TOKEN" || gh.Prefix != ghPlaceholder[:PlaceholderPrefixLen] || len(gh.Hosts) != 1 || gh.Hosts[0] != "api.example.com" {
		t.Fatalf("GITHUB_TOKEN %+v", gh)
	}
	if res, _ := env.do(newRequest(t, http.MethodGet, "http://"+CheckHost+"/other", "")); res.StatusCode != http.StatusNotFound {
		t.Fatalf("another path: %d", res.StatusCode)
	}
}

func TestPlaceholdersEndpointUnprotected(t *testing.T) {
	p := startProxy(t, map[netip.Addr]Rules{loopback: {SandboxID: "sbx_plain", Mode: "proxy"}})
	conn, r := dial(t, p)
	io.WriteString(conn, "GET http://kantel.check/placeholders HTTP/1.1\r\nHost: kantel.check\r\n\r\n")
	res, err := http.ReadResponse(r, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || strings.TrimSpace(string(body)) != `{"variables":[]}` {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
}

func TestInterceptWebSocket(t *testing.T) {
	env := newProtectedEnv(t)
	conn, err := net.Dial("tcp", env.proxy.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	io.WriteString(conn, "CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n")
	br := bufio.NewReader(conn)
	if res, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect}); err != nil || res.StatusCode != 200 {
		t.Fatalf("CONNECT: %v %v", res, err)
	}
	tc := tls.Client(conn, &tls.Config{ServerName: "api.example.com", RootCAs: env.roots, NextProtos: []string{"http/1.1"}})
	if err := tc.Handshake(); err != nil {
		t.Fatalf("handshake with the proxy: %v", err)
	}
	io.WriteString(tc, "GET /ws HTTP/1.1\r\nHost: api.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	tr := bufio.NewReader(tc)
	res, err := http.ReadResponse(tr, nil)
	if err != nil || res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade: %v %v", res, err)
	}
	if err := writeFrame(tc, 1, []byte("token="+ghPlaceholder), true); err != nil {
		t.Fatal(err)
	}
	_, payload, err := readFrame(tr)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != "got:token="+ghPlaceholder {
		t.Fatalf("the sandbox got %q", payload)
	}
	env.mu.Lock()
	got := append([]string(nil), env.wsGot...)
	env.mu.Unlock()
	if len(got) != 1 || got[0] != "token=ghs_realValue_1" {
		t.Fatalf("the destination got %q", got)
	}
}

// readFrame reads one WebSocket frame, unmasking it.
func readFrame(r *bufio.Reader) (byte, []byte, error) {
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, nil, err
	}
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return 0, nil, err
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return 0, nil, err
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	var mask [4]byte
	masked := h[1]&0x80 != 0
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	if n > 1<<20 {
		return 0, nil, fmt.Errorf("frame of %d bytes", n)
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return h[0] & 0x0f, payload, nil
}

// writeFrame writes one final frame, masked as a client's must be.
func writeFrame(w io.Writer, op byte, payload []byte, mask bool) error {
	b := []byte{0x80 | op}
	var bit byte
	if mask {
		bit = 0x80
	}
	switch n := len(payload); {
	case n < 126:
		b = append(b, bit|byte(n))
	case n < 1<<16:
		b = append(b, bit|126, byte(n>>8), byte(n))
	default:
		b = append(b, bit|127)
		b = binary.BigEndian.AppendUint64(b, uint64(n))
	}
	body := append([]byte(nil), payload...)
	if mask {
		key := [4]byte{0x12, 0x34, 0x56, 0x78}
		b = append(b, key[:]...)
		for i := range body {
			body[i] ^= key[i%4]
		}
	}
	_, err := w.Write(append(b, body...))
	return err
}
