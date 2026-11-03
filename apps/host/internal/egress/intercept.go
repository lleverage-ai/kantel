package egress

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress/protect"
)

// interceptIdle is how long an intercepted connection waits for the sandbox's next request.
const interceptIdle = 2 * time.Minute

// bufferedConn reads what a bufio.Reader already holds before the connection itself: a client's TLS hello may
// have come in with its CONNECT.
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.r.Read(b) }

// noSecrets is the provider for a sandbox with no protected variables: nothing in its traffic is a placeholder.
type noSecrets struct{}

func (noSecrets) Resolve(context.Context, string, string, protect.Destination) (protect.Resolution, error) {
	return protect.Resolution{}, protect.ErrUnknown
}

// provider is what resolves a sandbox's placeholders: nil (refuse any) for a protected sandbox on a proxy with no
// Secrets, since sending a placeholder on as it is would fail further from the reason.
func (p *Proxy) provider(rules Rules) protect.Provider {
	if !rules.Protected {
		return noSecrets{}
	}
	if p.Secrets == nil {
		return nil
	}
	return p.Secrets
}

// snapshot is one request's view of a protected sandbox's values: the provider its placeholders are swapped with
// (its body too, however late that is read) and the entries its response is scrubbed of are the same ones, so a
// rotation while it is under way can't leave a value it sent out of the scrubber's reach.
func (p *Proxy) snapshot(ctx context.Context, rules Rules) (protect.Provider, []protect.Entry, error) {
	if !rules.Protected {
		return noSecrets{}, nil, nil
	}
	if p.Secrets == nil {
		return nil, nil, protect.ErrUnavailable
	}
	entries, err := p.Secrets.Values(ctx, rules.SandboxID)
	if err != nil {
		return nil, nil, err
	}
	fixed := protect.NewFixed(entries)
	return fixed, fixed.Entries(), nil
}

// rootsFor is the pool the proxy verifies a real destination with: RootCAs, or the system's with the upstream's CA
// when the upstream terminates TLS.
func (p *Proxy) rootsFor(rules Rules) *x509.CertPool {
	if p.RootCAs != nil || rules.Upstream == "" || rules.UpstreamCACert == "" {
		return p.RootCAs
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	pool.AppendCertsFromPEM([]byte(rules.UpstreamCACert))
	return pool
}

// interceptTransport makes the requests of one intercepted connection: over the upstream when the sandbox has one
// (its identity on the CONNECT), verified against rootsFor, HTTP/1.1 only, and never decompressing, so what comes
// back can be scrubbed as it is.
func (p *Proxy) interceptTransport(rules Rules, attribution string) *http.Transport {
	tr := &http.Transport{
		DialContext:         func(_ context.Context, network, addr string) (net.Conn, error) { return p.Dial(network, addr) },
		TLSClientConfig:     &tls.Config{RootCAs: p.rootsFor(rules), NextProtos: []string{"http/1.1"}},
		TLSHandshakeTimeout: 15 * time.Second,
		DisableCompression:  true,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     30 * time.Second,
		ForceAttemptHTTP2:   false,
	}
	if rules.Upstream != "" {
		u, err := url.Parse(rules.Upstream)
		if err != nil || u.Host == "" {
			// Never straight out instead: the upstream is how the account wants its traffic to leave.
			tr.Proxy = func(*http.Request) (*url.URL, error) { return nil, errors.New("the upstream proxy's URL is invalid") }
		} else {
			tr.Proxy = http.ProxyURL(u)
			tr.GetProxyConnectHeader = func(context.Context, *url.URL, string) (http.Header, error) {
				return Headers(rules, attribution, time.Now()), nil
			}
		}
	}
	return tr
}

// intercept answers a CONNECT to an intercepted host itself: TLS with a leaf from the sandbox's CA, then each request
// in turn is checked, swapped, sent on and scrubbed. current answers the sandbox's rules as they are now, for the
// connection's authenticated source: each request is judged by them, not by those of when it connected.
func (p *Proxy) intercept(conn net.Conn, reader *bufio.Reader, rules Rules, current func() (Rules, bool), attribution, host string, port int, rec Record) {
	var leaf *tls.Certificate
	ca, err := p.CAs.Get(rules.SandboxID)
	if err == nil {
		leaf, err = ca.Leaf(host)
	}
	if err != nil {
		p.refuseRecord(conn, rec, refusal{status: http.StatusServiceUnavailable, code: protect.CodeUnavailable, message: "this sandbox's egress certificate for " + host + " isn't ready, so its requests there can't be inspected"})
		return
	}
	if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
		return
	}
	client := tls.Server(&bufferedConn{Conn: conn, r: reader}, &tls.Config{
		Certificates: []tls.Certificate{*leaf},
		NextProtos:   []string{"http/1.1"},
		MinVersion:   tls.VersionTLS12,
	})
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(30 * time.Second))
	if err := client.Handshake(); err != nil {
		// Most often the sandbox doesn't trust its CA (not installed yet, or replaced): worth a record of its own.
		rec.Inspected = true
		rec.Reason = "the sandbox's TLS handshake with the proxy failed: " + err.Error()
		rec.DurationMs = time.Since(rec.At).Milliseconds()
		p.record(rec)
		return
	}
	_ = client.SetDeadline(time.Time{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tr := p.interceptTransport(rules, attribution)
	defer tr.CloseIdleConnections()
	br := bufio.NewReader(client)
	for {
		_ = client.SetReadDeadline(time.Now().Add(interceptIdle))
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		_ = client.SetReadDeadline(time.Time{})
		now, ok := current()
		if !ok {
			r := rec
			r.At, r.Method, r.Path, r.Inspected = time.Now(), req.Method, req.URL.EscapedPath(), true
			_ = p.refuseRecord(client, r, refusal{status: http.StatusForbidden, code: CodeDenied, message: "this sandbox's egress rules have gone"})
			return
		}
		if now.Upstream != rules.Upstream || now.UpstreamCACert != rules.UpstreamCACert || now.Token != rules.Token {
			// The way out changed: later requests take the new one.
			tr.CloseIdleConnections()
			tr = p.interceptTransport(now, attribution)
		}
		rules = now
		if !p.interceptOne(ctx, client, br, req.WithContext(ctx), tr, rules, attribution, host, port, rec) {
			return
		}
	}
}

// interceptOne handles one request on an intercepted connection; it answers whether the connection may carry another.
func (p *Proxy) interceptOne(ctx context.Context, client *tls.Conn, br *bufio.Reader, req *http.Request, tr *http.Transport, rules Rules, attribution, host string, port int, base Record) bool {
	rec := base
	rec.At = time.Now()
	rec.Method = req.Method
	rec.Path = req.URL.EscapedPath()
	rec.Inspected = true
	rec.Allowed = true
	rec.Rule = ""
	v := rules.decide(host, req.Method, rec.Path, scopeRequest)
	if !v.allowed {
		return p.refuseRecord(client, rec, refusal{status: http.StatusForbidden, code: CodeDenied, rule: v.rule, message: v.reason})
	}
	rec.Rule = v.rule
	if ph := req.Header.Get(CheckHeader); ph != "" {
		p.answerCheck(ctx, client, rules, attribution, host, port, req, ph, true, rec)
		return false
	}
	// The request goes where the sandbox's CONNECT said, whatever its Host header says: that is the destination its
	// placeholders are judged for and the name the real host's certificate is checked against.
	req.URL.Scheme = "https"
	req.URL.Host = host
	if port != 443 {
		req.URL.Host = net.JoinHostPort(host, strconv.Itoa(port))
	}
	// Its Host header too: a virtual host other than the one its TLS, grants and bindings were judged for could
	// otherwise be given the value.
	req.Host = req.URL.Host
	req.RequestURI = ""
	for _, name := range []string{"Proxy-Authorization", "Proxy-Connection", "Kantel-Sandbox", "Kantel-Account", "Kantel-Attribution", "Kantel-Signature"} {
		req.Header.Del(name)
	}
	if _, ok := req.Header["User-Agent"]; !ok {
		// Go's client would add its own; an empty one is left out, so the request goes as the sandbox sent it.
		req.Header["User-Agent"] = []string{""}
	}
	webSocket := isWebSocket(req.Header)
	if !webSocket && req.Header.Get("Upgrade") != "" {
		// Only WebSocket can be read past its handshake; any other protocol would be a tunnel round the checks.
		req.Header.Del("Upgrade")
	}
	if strings.EqualFold(strings.TrimSpace(req.Header.Get("Expect")), "100-continue") {
		req.Header.Del("Expect")
		if _, err := io.WriteString(client, "HTTP/1.1 100 Continue\r\n\r\n"); err != nil {
			return false
		}
	}
	dest := protect.Destination{Host: host, Port: port, Method: req.Method, Path: rec.Path}
	var entries []protect.Entry
	if rules.Protected {
		var provider protect.Provider
		var err error
		if provider, entries, err = p.snapshot(ctx, rules); err != nil {
			return p.refuseRecord(client, rec, unavailableRefusal())
		}
		protect.LimitAcceptEncoding(req.Header)
		swapped, err := protect.RewriteRequest(ctx, req, rules.SandboxID, dest, provider)
		if err != nil {
			return p.refuseRecord(client, rec, rewriteRefusal(err))
		}
		rec.Swapped = swapped
	}
	var up atomic.Int64
	if req.Body != nil && req.Body != http.NoBody {
		req.Body = &countReader{r: req.Body, n: &up}
	}
	if webSocket {
		return p.webSocket(ctx, client, br, req, tr, rules, dest, entries, rec, &up)
	}
	resp, err := tr.RoundTrip(req)
	if err != nil {
		rec.BytesUp = up.Load()
		return p.refuseRecord(client, rec, upstreamRefusal(host, err))
	}
	defer resp.Body.Close()
	if entries != nil {
		// A body protect can't read could carry a value back: refused, never passed on.
		if err := protect.ScrubResponse(resp, entries); err != nil {
			rec.BytesUp = up.Load()
			return p.refuseRecord(client, rec, rewriteRefusal(err))
		}
	}
	rec.Status = resp.StatusCode
	closing := req.Close || resp.Close
	resp.Close = closing
	down := &countWriter{w: client}
	err = resp.Write(down)
	rec.BytesUp, rec.BytesDown = up.Load(), down.n
	rec.DurationMs = time.Since(rec.At).Milliseconds()
	if err != nil {
		rec.Reason = safeError(err)
		var ref *protect.Refusal
		if errors.As(err, &ref) {
			rec.Code, rec.Reason = ref.Code, ref.Message
		}
	}
	p.record(rec)
	return err == nil && !closing
}

// webSocket sends a WebSocket handshake on and, once the server switches protocols, relays its messages through
// protect.Relay: placeholders swapped on the way up, values scrubbed on the way down.
func (p *Proxy) webSocket(ctx context.Context, client *tls.Conn, br *bufio.Reader, req *http.Request, tr *http.Transport, rules Rules, dest protect.Destination, entries []protect.Entry, rec Record, up *atomic.Int64) bool {
	resp, err := tr.RoundTrip(req)
	if err != nil {
		return p.refuseRecord(client, rec, upstreamRefusal(dest.Host, err))
	}
	rec.Status = resp.StatusCode
	server, ok := resp.Body.(io.ReadWriteCloser)
	if resp.StatusCode != http.StatusSwitchingProtocols || !ok {
		// Not upgraded: an ordinary answer, scrubbed like any other, and the end of the connection.
		defer resp.Body.Close()
		if entries != nil {
			if err := protect.ScrubResponse(resp, entries); err != nil {
				_ = p.refuseRecord(client, rec, rewriteRefusal(err))
				return false
			}
		}
		resp.Close = true
		down := &countWriter{w: client}
		err = resp.Write(down)
		rec.BytesUp, rec.BytesDown = up.Load(), down.n
		if err != nil {
			rec.Reason = safeError(err)
		}
		rec.DurationMs = time.Since(rec.At).Milliseconds()
		p.record(rec)
		return false
	}
	defer server.Close()
	if entries != nil {
		// The headers only: the body is the connection itself, which Relay scrubs.
		_ = protect.ScrubResponse(&http.Response{Header: resp.Header, Body: http.NoBody}, entries)
	}
	var head strings.Builder
	head.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	_ = resp.Header.Write(&head)
	head.WriteString("\r\n")
	if _, err := io.WriteString(client, head.String()); err != nil {
		return false
	}
	var down atomic.Int64
	side := &wsSide{r: br, w: client, c: client, up: up, down: &down}
	err = protect.Relay(ctx, side, server, protect.ParseExtensions(resp.Header), rules.SandboxID, dest, p.provider(rules), entries)
	rec.BytesUp, rec.BytesDown = up.Load(), down.Load()
	rec.DurationMs = time.Since(rec.At).Milliseconds()
	var ref *protect.Refusal
	switch {
	case errors.As(err, &ref):
		rec.Allowed = false
		rec.Code, rec.Reason = ref.Code, ref.Message
	case err != nil:
		rec.Reason = safeError(err)
	}
	p.record(rec)
	return false
}

// upstreamRefusal is the answer to a request that couldn't be sent on.
func upstreamRefusal(host string, err error) refusal {
	var ref *protect.Refusal
	switch {
	case errors.As(err, &ref):
		return rewriteRefusal(ref)
	case errors.Is(err, ErrDestination):
		return refusal{status: http.StatusForbidden, code: CodeDenied, message: host + " isn't on the public internet"}
	}
	return refusal{status: http.StatusBadGateway, code: CodeUpstream, message: "can't reach " + host + ": " + safeError(err)}
}

// answerCheck answers a request carrying CheckHeader without sending it anywhere: once a verified TLS handshake with
// the real host has worked (verify), it says whether the placeholder would be swapped for this destination. The
// value is never sent, nor answered.
func (p *Proxy) answerCheck(ctx context.Context, w io.Writer, rules Rules, attribution, host string, port int, req *http.Request, placeholder string, verify bool, rec Record) {
	rec.Method, rec.Path, rec.Inspected = req.Method, req.URL.EscapedPath(), true
	rec.Reason = "proxy check"
	if verify {
		if err := p.verifyTLS(ctx, rules, attribution, host, port); err != nil {
			p.refuseRecord(w, rec, refusal{status: http.StatusBadGateway, code: CodeUpstream, check: true, message: "the TLS handshake with " + host + " failed: " + safeError(err)})
			return
		}
	}
	dest := protect.Destination{Host: host, Port: port, Method: req.Method, Path: rec.Path}
	if !verify {
		// Plain HTTP: never swapped, whatever port it names.
		dest.Port = 0
	}
	err := protect.ErrUnknown
	if rules.Protected {
		if prov := p.provider(rules); prov == nil {
			err = protect.ErrUnavailable
		} else {
			_, err = prov.Resolve(ctx, strings.TrimSpace(placeholder), rules.SandboxID, dest)
		}
	}
	var unbound *protect.UnboundError
	switch {
	case err == nil:
	case errors.As(err, &unbound):
		p.refuseRecord(w, rec, refusal{status: http.StatusForbidden, code: protect.CodeUnbound, variable: unbound.Name, check: true, message: unbound.Name + " may not be sent to " + host + ", which isn't one of its destinations"})
		return
	case errors.Is(err, protect.ErrUnknown):
		p.refuseRecord(w, rec, refusal{status: http.StatusForbidden, code: protect.CodeUnbound, check: true, message: "that isn't one of this sandbox's placeholders, so it is never swapped"})
		return
	default:
		p.refuseRecord(w, rec, refusal{status: http.StatusServiceUnavailable, code: protect.CodeUnavailable, check: true, message: "protected environment variables can't be fetched right now"})
		return
	}
	rec.Status = http.StatusNoContent
	rec.DurationMs = time.Since(rec.At).Milliseconds()
	p.record(rec)
	_, _ = io.WriteString(w, "HTTP/1.1 204 No Content\r\n"+CheckHeader+": ok\r\nConnection: close\r\n\r\n")
}

// verifyTLS makes a TLS handshake with the real host, verified as a request to it would be, and ends it.
func (p *Proxy) verifyTLS(ctx context.Context, rules Rules, attribution, host string, port int) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	raw, err := p.dialTunnel(ctx, rules, attribution, net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	defer raw.Close()
	c := tls.Client(raw, &tls.Config{ServerName: host, RootCAs: p.rootsFor(rules), NextProtos: []string{"http/1.1"}})
	return c.HandshakeContext(ctx)
}

// dialTunnel connects to target as the sandbox's traffic leaves: through its upstream (a CONNECT carrying its
// identity) when it has one, else straight there.
func (p *Proxy) dialTunnel(ctx context.Context, rules Rules, attribution, target string) (net.Conn, error) {
	if rules.Upstream == "" {
		return p.Dial("tcp", target)
	}
	u, err := url.Parse(rules.Upstream)
	if err != nil || u.Host == "" {
		return nil, errors.New("the upstream proxy's URL is invalid")
	}
	c, err := p.Dial("tcp", u.Host)
	if err != nil {
		return nil, err
	}
	if d, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(d)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", target, target)
	for k, vs := range Headers(rules, attribution, time.Now()) {
		for _, v := range vs {
			fmt.Fprintf(&b, "%s: %s\r\n", k, v)
		}
	}
	b.WriteString("\r\n")
	if _, err := io.WriteString(c, b.String()); err != nil {
		c.Close()
		return nil, err
	}
	br := bufio.NewReader(c)
	res, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		c.Close()
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		c.Close()
		return nil, fmt.Errorf("the upstream proxy answered %d", res.StatusCode)
	}
	_ = c.SetDeadline(time.Time{})
	return &bufferedConn{Conn: c, r: br}, nil
}

// Placeholders is the answer to GET http://kantel.check/placeholders.
type Placeholders struct {
	Variables []PlaceholderInfo `json:"variables"`
}

// PlaceholderInfo is one protected variable as the sandbox may see it: never its value, nor even its whole placeholder
// (the sandbox's own environment has that; the prefix is enough to match one to the other).
type PlaceholderInfo struct {
	Name   string   `json:"name"`
	Prefix string   `json:"prefix"`
	Hosts  []string `json:"hosts"`
}

// PlaceholderPrefixLen is how much of a placeholder the endpoint gives: "kph_" and four characters.
const PlaceholderPrefixLen = 8

// servePlaceholders answers GET http://kantel.check/placeholders for the sandbox that asks: its protected
// variables' names and bound hosts, so `kantel doctor` knows where to check each. Never a value.
func (p *Proxy) servePlaceholders(w io.Writer, req *http.Request, rules Rules) {
	if (req.Method != http.MethodGet && req.Method != http.MethodHead) || req.URL.Path != "/placeholders" {
		_ = refusal{status: http.StatusNotFound, message: "the proxy answers only GET http://" + CheckHost + "/placeholders"}.write(w)
		return
	}
	out := Placeholders{Variables: []PlaceholderInfo{}}
	if rules.Protected {
		_, entries, err := p.snapshot(context.Background(), rules)
		if err != nil {
			_ = refusal{status: http.StatusServiceUnavailable, code: protect.CodeUnavailable, message: "protected environment variables can't be fetched right now"}.write(w)
			return
		}
		for _, e := range entries {
			v := PlaceholderInfo{Name: e.Name, Prefix: e.Placeholder[:min(PlaceholderPrefixLen, len(e.Placeholder))], Hosts: []string{}}
			for _, b := range e.Bindings {
				if h := normaliseHost(b.Host); h != "" && !slices.Contains(v.Hosts, h) {
					v.Hosts = append(v.Hosts, h)
				}
			}
			out.Variables = append(out.Variables, v)
		}
	}
	body, _ := json.Marshal(out)
	head := fmt.Sprintf("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", len(body))
	if req.Method == http.MethodHead {
		body = nil
	}
	_, _ = io.WriteString(w, head+string(body))
}

// isWebSocket is a WebSocket handshake.
func isWebSocket(h http.Header) bool {
	if !strings.EqualFold(strings.TrimSpace(h.Get("Upgrade")), "websocket") {
		return false
	}
	for _, v := range h.Values("Connection") {
		for _, token := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return true
			}
		}
	}
	return false
}

// countReader counts a request body as it goes up; the transport reads it from another goroutine.
type countReader struct {
	r io.ReadCloser
	n *atomic.Int64
}

func (c *countReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	c.n.Add(int64(n))
	return n, err
}

func (c *countReader) Close() error { return c.r.Close() }

// wsSide is the sandbox's side of a relayed WebSocket: what the TLS reader already holds first, counted both ways.
type wsSide struct {
	r        io.Reader
	w        io.Writer
	c        io.Closer
	up, down *atomic.Int64
}

func (s *wsSide) Read(b []byte) (int, error) {
	n, err := s.r.Read(b)
	s.up.Add(int64(n))
	return n, err
}

func (s *wsSide) Write(b []byte) (int, error) {
	n, err := s.w.Write(b)
	s.down.Add(int64(n))
	return n, err
}

func (s *wsSide) Close() error { return s.c.Close() }
