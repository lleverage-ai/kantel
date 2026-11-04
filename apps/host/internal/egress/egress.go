// Package egress is the host's egress proxy: the one way out of every sandbox (package network routes nothing else),
// whatever its egress mode; "open" is the proxy with no rules. It connects only to public addresses, or to private
// ranges an operator allows (Destinations), so a sandbox can't use it to reach the host, the LAN or another sandbox.
//
// Attribution is by where a connection comes from, not by anything the sandbox says: each microVM has its own TAP
// device and /30, so the source address names the sandbox (and the isolate tier's worker sets its sandbox on
// requests it forwards itself, on a socket only it reaches). The sandbox holds no credential for the upstream: the
// host adds the sandbox's own upstream token (Proxy-Authorization) and Kantel's attribution headers to every
// request it passes on, so an upstream such as Kantel's vault proxy or Mehen decides per sandbox and account.
//
// What a process inside the sandbox may say about itself (the user name in its proxy URL, such as a tool call ID
// that a command was run for) is passed on as Kantel-Attribution, marked as the sandbox's own claim: it is a label,
// never an authority.
//
// Protected variables (package protect) are swapped wherever the proxy can read the traffic: plain HTTP, the isolate
// tier's proxy-form https, and the hosts it intercepts. A CONNECT to a host a protected variable is bound to, or one
// a grant with methods or paths names, is answered by the proxy itself with a leaf minted by the sandbox's own CA
// (CAStore); each request is checked against the grants, has its placeholders swapped, and goes on over a fresh,
// verified TLS connection to the real host. Every other CONNECT stays a blind tunnel, and a placeholder inside one
// is never seen, so is worthless there.
package egress

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress/protect"
)

// Rules is one sandbox's egress, as the control plane set it.
type Rules struct {
	SandboxID string
	Account   string
	// Mode "open", "proxy" or "none".
	Mode string
	// Upstream is a proxy URL to chain to (http://host:port); empty goes direct.
	Upstream string
	// Token is the sandbox's credential at the upstream.
	Token string
	// UpstreamCACert is the upstream's CA (PEM) when it terminates TLS: the proxy trusts it, on top of the system's,
	// for the requests it makes itself through the upstream.
	UpstreamCACert string
	// AttributionKey signs the Kantel-Sandbox/Kantel-Account headers (HMAC-SHA256); empty sends them unsigned.
	AttributionKey string
	// Headers go to the upstream on every request (never Kantel-* ones, which are the host's).
	Headers map[string]string
	// Allow and Deny are host patterns ("example.com", "*.example.com"); Deny wins. DefaultDeny refuses hosts no
	// rule names.
	Allow       []string
	Deny        []string
	DefaultDeny bool
	// Protected says the sandbox has protected variables: the proxy swaps their placeholders through Proxy.Secrets.
	Protected bool
	// Intercept are the host patterns the protected variables are bound to, which the proxy terminates TLS for.
	Intercept []string
	// Grants apply on top of Allow and Deny (deny wins).
	Grants []Grant
}

// Record is one decision, for the host's log and the control plane's events. It never holds a value or a query.
type Record struct {
	At        time.Time `json:"at"`
	SandboxID string    `json:"sandboxId"`
	Account   string    `json:"account,omitempty"`
	Method    string    `json:"method"`
	Host      string    `json:"host"`
	Port      int       `json:"port"`
	// Path is the request's path, without its query; empty for a tunnel.
	Path    string `json:"path,omitempty"`
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
	// Rule is the grant that decided, as text.
	Rule string `json:"rule,omitempty"`
	// Code is the X-Kantel-Proxy-Error code of a refusal.
	Code string `json:"code,omitempty"`
	// Swapped are the names of the variables swapped in.
	Swapped []string `json:"swapped,omitempty"`
	// Inspected says the proxy read the request rather than passing bytes through.
	Inspected   bool   `json:"inspected"`
	Status      int    `json:"status,omitempty"`
	Via         string `json:"via"`
	Attribution string `json:"attribution,omitempty"`
	BytesUp     int64  `json:"bytesUp"`
	BytesDown   int64  `json:"bytesDown"`
	DurationMs  int64  `json:"durationMs"`
}

// Secrets is what the proxy needs of the host's store of protected values (protect.Store).
type Secrets interface {
	protect.Provider
	// Values answers a sandbox's entries, to scrub what comes back.
	Values(ctx context.Context, sandboxID string) ([]protect.Entry, error)
}

// The headers a refusal carries, and the proxy check's.
const (
	ErrorHeader    = "X-Kantel-Proxy-Error"
	RuleHeader     = "X-Kantel-Proxy-Rule"
	VariableHeader = "X-Kantel-Proxy-Variable"
	// CheckHeader on a request carries a placeholder to check: the proxy answers it itself and never sends it on.
	CheckHeader = "X-Kantel-Proxy-Check"
)

// Refusal codes beside protect's (placeholder-unbound, secret-unavailable, body-too-large).
const (
	CodeDenied   = "denied"
	CodeUpstream = "upstream-failed"
)

// CheckHost is the name the proxy answers for itself over plain HTTP: GET http://kantel.check/placeholders.
const CheckHost = "kantel.check"

// Proxy is the host's egress proxy.
type Proxy struct {
	log *slog.Logger
	// Resolve names the sandbox a connection came from by its source address.
	Resolve func(netip.Addr) (Rules, bool)
	// OnRecord sees every decision. It must not block: the connection waits for it.
	OnRecord func(Record)
	// Dial is how connections leave (tests replace it). The default checks every address it connects to against
	// Destinations, after DNS, so a name that resolves to a private address is refused too.
	Dial func(network, address string) (net.Conn, error)
	// Destinations says which addresses the proxy may connect to for a sandbox, its upstream included.
	Destinations Destinations
	// Secrets swaps protected variables; nil refuses any request that carries a placeholder of a protected sandbox.
	Secrets Secrets
	// CAs holds each sandbox's interception CA; nil intercepts nothing.
	CAs *CAStore
	// RootCAs verifies the real destinations the proxy itself connects to over TLS; nil is the system's roots.
	RootCAs *x509.CertPool

	listener      net.Listener
	served        atomic.Int64
	transport     *http.Transport
	transportOnce sync.Once
}

func New(log *slog.Logger) *Proxy {
	p := &Proxy{log: log}
	d := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second, Control: p.control}
	p.Dial = d.Dial
	p.transport = &http.Transport{
		Dial:                func(network, addr string) (net.Conn, error) { return p.Dial(network, addr) },
		TLSHandshakeTimeout: 15 * time.Second,
		MaxIdleConns:        64,
		IdleConnTimeout:     30 * time.Second,
		ForceAttemptHTTP2:   false,
		// The response goes back as the server sent it, so it can be scrubbed (protect handles gzip and deflate).
		DisableCompression: true,
	}
	return p
}

// directTransport is the transport for proxy-form requests, trusting RootCAs once they are set.
func (p *Proxy) directTransport() *http.Transport {
	p.transportOnce.Do(func() {
		if p.RootCAs != nil {
			p.transport.TLSClientConfig = &tls.Config{RootCAs: p.RootCAs}
		}
	})
	return p.transport
}

// Resolver names the sandbox a request is for, from its connection's source and (for a trusted forwarder such as
// the isolate worker) the request.
type Resolver func(req *http.Request) (Rules, bool)

// ServeConn handles one connection whose sandbox the caller resolves (the isolate tier's vsock bridge).
func (p *Proxy) ServeConn(conn net.Conn, resolve Resolver) {
	p.handleWith(conn, resolve)
}

// Listen serves on address (such as 0.0.0.0:3129; the host's firewall lets only sandbox devices reach it).
func (p *Proxy) Listen(address string) error {
	l, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	p.listener = l
	go p.serve(l)
	return nil
}

func (p *Proxy) Close() {
	if p.listener != nil {
		p.listener.Close()
	}
}

// Addr is where it listens.
func (p *Proxy) Addr() net.Addr { return p.listener.Addr() }

// Served is how many requests it has handled.
func (p *Proxy) Served() int64 { return p.served.Load() }

func (p *Proxy) serve(l net.Listener) {
	for {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		go p.handle(conn)
	}
}

func matchHost(pattern, host string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	if pattern == "*" {
		return true
	}
	if strings.HasPrefix(pattern, "*.") {
		return strings.HasSuffix(host, pattern[1:])
	}
	return host == pattern
}

// lists applies the allow and deny lists alone: listed is a host the allow list names, denied one the deny list does.
func (r Rules) lists(host string) (listed, denied bool, reason string) {
	for _, d := range r.Deny {
		if matchHost(d, host) {
			return false, true, "denied by the proxy settings (" + d + ")"
		}
	}
	for _, a := range r.Allow {
		if matchHost(a, host) {
			return true, false, ""
		}
	}
	return false, false, ""
}

// Decide applies a sandbox's allow and deny lists to a destination host (grants aside).
func Decide(r Rules, host string) (bool, string) {
	host = strings.ToLower(host)
	if r.Mode == "none" {
		return false, "this sandbox has no network"
	}
	listed, denied, reason := r.lists(host)
	if denied {
		return false, reason
	}
	if listed || !r.DefaultDeny {
		return true, ""
	}
	return false, "not on the proxy settings' allow list"
}

func (p *Proxy) record(rec Record) {
	p.served.Add(1)
	if p.OnRecord != nil {
		p.OnRecord(rec)
	}
	p.log.Info("egress", "sandbox", rec.SandboxID, "method", rec.Method, "host", rec.Host, "port", rec.Port, "path", rec.Path, "allowed", rec.Allowed, "reason", rec.Reason, "rule", rec.Rule, "code", rec.Code, "swapped", rec.Swapped, "status", rec.Status, "via", rec.Via, "attribution", rec.Attribution, "up", rec.BytesUp, "down", rec.BytesDown)
}

// refusal is an answer the proxy gives itself instead of passing a request on. Nothing in it is ever a value: the
// variable is a name, the message names variables and hosts only.
type refusal struct {
	status                        int
	code, rule, variable, message string
	// check is the answer to a proxy check, which carries its code in CheckHeader too.
	check bool
}

func (f refusal) write(w io.Writer) error {
	body := "kantel egress: " + sentence(f.message) + "\n"
	var b strings.Builder
	fmt.Fprintf(&b, "HTTP/1.1 %d %s\r\nContent-Type: text/plain; charset=utf-8\r\nX-Kantel-Egress: denied\r\n", f.status, http.StatusText(f.status))
	if f.code != "" {
		fmt.Fprintf(&b, "%s: %s\r\n", ErrorHeader, f.code)
		if f.check {
			fmt.Fprintf(&b, "%s: %s\r\n", CheckHeader, f.code)
		}
	}
	if f.rule != "" {
		fmt.Fprintf(&b, "%s: %s\r\n", RuleHeader, headerSafe(f.rule))
	}
	if f.variable != "" {
		fmt.Fprintf(&b, "%s: %s\r\n", VariableHeader, headerSafe(f.variable))
	}
	fmt.Fprintf(&b, "Content-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body)
	_, err := io.WriteString(w, b.String())
	return err
}

// sentence makes a reason one sentence.
func sentence(s string) string {
	s = headerSafe(strings.TrimSpace(s))
	if s == "" {
		s = "refused"
	}
	if !strings.HasSuffix(s, ".") && !strings.HasSuffix(s, "?") && !strings.HasSuffix(s, "!") {
		s += "."
	}
	return s
}

// refuse answers a refusal whose code follows from its status: 403 is the proxy's settings, 5xx the way out.
func refuse(w io.Writer, status int, reason string) {
	code := ""
	switch {
	case status == http.StatusForbidden:
		code = CodeDenied
	case status >= 500:
		code = CodeUpstream
	}
	_ = refusal{status: status, code: code, message: reason}.write(w)
}

// refuseRecord records a refused request and answers it; it answers false, as a refused connection goes no further.
func (p *Proxy) refuseRecord(w io.Writer, rec Record, f refusal) bool {
	rec.Allowed = f.code == CodeUpstream
	rec.Code, rec.Reason, rec.Status = f.code, f.message, f.status
	if f.rule != "" {
		rec.Rule = f.rule
	}
	rec.DurationMs = time.Since(rec.At).Milliseconds()
	p.record(rec)
	_ = f.write(w)
	return false
}

// rewriteRefusal is the answer to a request RewriteRequest (or its streaming body) refused.
func rewriteRefusal(err error) refusal {
	var ref *protect.Refusal
	if errors.As(err, &ref) {
		switch ref.Code {
		case protect.CodeUnbound:
			return refusal{status: http.StatusForbidden, code: ref.Code, variable: ref.Variable, message: ref.Message}
		case protect.CodeTooLarge:
			return refusal{status: http.StatusForbidden, code: ref.Code, message: ref.Message}
		case protect.CodeUnreadableResponse:
			return refusal{status: http.StatusBadGateway, code: ref.Code, message: ref.Message}
		}
		return refusal{status: http.StatusServiceUnavailable, code: protect.CodeUnavailable, message: "protected environment variables can't be fetched right now"}
	}
	return refusal{status: http.StatusBadGateway, code: CodeUpstream, message: "the request couldn't be read"}
}

func unavailableRefusal() refusal {
	return refusal{status: http.StatusServiceUnavailable, code: protect.CodeUnavailable, message: "protected environment variables can't be fetched right now, so what comes back can't be checked for them"}
}

// safeError says what went wrong with a request sent on, in words of the proxy's own, never the error's text: a
// client error carries the URL (after a swap, its query may hold a value), and a parser's quotes what the server sent
// (`bad Content-Length "<value>"`), which a server reflecting a request can make a value. It is what the guest is
// answered and what the egress record says.
func safeError(err error) string {
	var (
		ref       *protect.Refusal
		dnsErr    *net.DNSError
		netErr    net.Error
		unknownCA x509.UnknownAuthorityError
		hostname  x509.HostnameError
		invalid   x509.CertificateInvalidError
		verify    *tls.CertificateVerificationError
		record    tls.RecordHeaderError
		alert     tls.AlertError
		upstream  *upstreamProxyError
	)
	switch {
	case err == nil:
		return ""
	case errors.As(err, &ref):
		return ref.Message
	case errors.Is(err, ErrDestination):
		return "it isn't on the public internet"
	case errors.Is(err, context.Canceled):
		return "the request was cancelled"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		return "timed out"
	case errors.As(err, &dnsErr):
		return "its name doesn't resolve"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection refused"
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE):
		return "the connection was reset"
	case errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH):
		return "no route to it"
	case errors.As(err, &unknownCA), errors.As(err, &hostname), errors.As(err, &invalid), errors.As(err, &verify):
		return "its TLS certificate isn't valid for it"
	case errors.As(err, &record), errors.As(err, &alert):
		return "the TLS handshake failed"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF), errors.Is(err, net.ErrClosed):
		return "the connection closed early"
	case errors.As(err, &upstream):
		return upstream.Error()
	}
	return "the request or its answer failed"
}

// upstreamProxyError is the account's upstream proxy refusing a connection, or its URL not being one; its text holds
// nothing else (not the URL, whose user info may be a credential).
type upstreamProxyError struct{ status int }

func (e *upstreamProxyError) Error() string {
	if e.status == 0 {
		return "the upstream proxy's URL is invalid"
	}
	return fmt.Sprintf("the upstream proxy answered %d", e.status)
}

// claimed is the user name in a Proxy-Authorization the sandbox sent: its own label for the request.
func claimed(h http.Header) string {
	auth := h.Get("Proxy-Authorization")
	if !strings.HasPrefix(auth, "Basic ") {
		return ""
	}
	raw, err := base64.StdEncoding.DecodeString(auth[6:])
	if err != nil {
		return ""
	}
	user, _, _ := strings.Cut(string(raw), ":")
	user = strings.TrimPrefix(user, "sandbox-")
	if user == "sandbox" || len(user) > 128 {
		return ""
	}
	return user
}

// Headers are what the host adds to a request it passes on.
func Headers(r Rules, attribution string, now time.Time) http.Header {
	h := http.Header{}
	for name, value := range r.Headers {
		if !strings.HasPrefix(strings.ToLower(name), "kantel-") {
			h.Set(name, value)
		}
	}
	if r.Token != "" {
		h.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("sbx:"+r.Token)))
	}
	h.Set("Kantel-Sandbox", r.SandboxID)
	if r.Account != "" {
		h.Set("Kantel-Account", r.Account)
	}
	if attribution != "" {
		h.Set("Kantel-Attribution", "claimed; "+attribution)
	}
	if r.AttributionKey != "" {
		ts := strconv.FormatInt(now.Unix(), 10)
		mac := hmac.New(sha256.New, []byte(r.AttributionKey))
		fmt.Fprintf(mac, "%s\n%s\n%s", ts, r.SandboxID, r.Account)
		h.Set("Kantel-Signature", "t="+ts+",v1="+hex.EncodeToString(mac.Sum(nil)))
	}
	return h
}

// Verify checks a Kantel-Signature (for an upstream written in Go, and the tests).
func Verify(key string, h http.Header, maxAge time.Duration, now time.Time) bool {
	var ts, sig string
	for _, part := range strings.Split(h.Get("Kantel-Signature"), ",") {
		k, v, _ := strings.Cut(part, "=")
		switch k {
		case "t":
			ts = v
		case "v1":
			sig = v
		}
	}
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || now.Sub(time.Unix(sec, 0)).Abs() > maxAge {
		return false
	}
	mac := hmac.New(sha256.New, []byte(key))
	fmt.Fprintf(mac, "%s\n%s\n%s", ts, h.Get("Kantel-Sandbox"), h.Get("Kantel-Account"))
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(sig))
}

func (p *Proxy) handle(conn net.Conn) {
	src, err := netip.ParseAddrPort(conn.RemoteAddr().String())
	if err != nil {
		conn.Close()
		return
	}
	addr := src.Addr().Unmap()
	// Asked again for each request an intercepted connection carries, so a change to the sandbox's rules applies to
	// a connection it already has open.
	p.handleWith(conn, func(*http.Request) (Rules, bool) { return p.Resolve(addr) })
}

func (p *Proxy) handleWith(conn net.Conn, resolve Resolver) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	reader := bufio.NewReader(conn)
	req, err := http.ReadRequest(reader)
	if err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	// The request the sandbox was named by, kept as it came (the isolate worker's header included) to name it again.
	ident := req.Clone(context.Background())
	rules, ok := resolve(req)
	req.Header.Del("Kantel-Isolate-Sandbox")
	if !ok {
		refuse(conn, http.StatusForbidden, "unknown sandbox")
		return
	}
	current := func() (Rules, bool) {
		now, ok := resolve(ident)
		if !ok || now.SandboxID != rules.SandboxID {
			// Another sandbox's now (its address reused), or none's: nothing more goes on this connection.
			return Rules{}, false
		}
		return now, true
	}
	started := time.Now()
	attribution := claimed(req.Header)
	host, port := "", 0
	if req.Method == http.MethodConnect {
		h, ps, err := net.SplitHostPort(req.Host)
		if err != nil {
			_ = refusal{status: http.StatusBadRequest, message: "bad CONNECT authority"}.write(conn)
			return
		}
		host = h
		port, _ = strconv.Atoi(ps)
	} else {
		// Proxy form: http:// from a process's HTTP_PROXY, or https:// too from the isolate worker (workerd's proxy
		// style), which leaves the TLS to the proxy.
		if req.URL == nil || !req.URL.IsAbs() || (req.URL.Scheme != "http" && req.URL.Scheme != "https") {
			_ = refusal{status: http.StatusBadRequest, message: "only proxy-form http(s):// requests and CONNECT"}.write(conn)
			return
		}
		host = req.URL.Hostname()
		port = 80
		if req.URL.Scheme == "https" {
			port = 443
		}
		if req.URL.Port() != "" {
			port, _ = strconv.Atoi(req.URL.Port())
		}
	}
	rec := Record{At: started, SandboxID: rules.SandboxID, Account: rules.Account, Method: req.Method, Host: host, Port: port, Attribution: attribution, Via: "direct"}
	if rules.Upstream != "" {
		rec.Via = "upstream"
	}
	if req.Method == http.MethodConnect {
		p.connect(conn, reader, req, rules, current, attribution, host, port, rec)
		return
	}
	if req.URL.Scheme == "http" && normaliseHost(host) == CheckHost {
		p.servePlaceholders(conn, req, rules)
		return
	}
	p.proxyForm(conn, req, rules, attribution, host, port, rec)
}

// connect handles a CONNECT: intercepted when its host is one the proxy terminates TLS for, a blind tunnel
// otherwise.
func (p *Proxy) connect(conn net.Conn, reader *bufio.Reader, req *http.Request, rules Rules, current func() (Rules, bool), attribution, host string, port int, rec Record) {
	intercept := p.CAs != nil && rules.intercepts(host, port)
	scope := scopeTunnel
	if intercept {
		scope = scopeConnect
	}
	v := rules.decide(host, "", "", scope)
	rec.Rule = v.rule
	if !v.allowed {
		p.refuseRecord(conn, rec, refusal{status: http.StatusForbidden, code: CodeDenied, rule: v.rule, message: v.reason})
		return
	}
	rec.Allowed = true
	if intercept {
		p.intercept(conn, reader, rules, current, attribution, host, port, rec)
		return
	}
	up, down, err := p.forward(conn, reader, req, rules, attribution, host, port, nil, nil)
	p.finish(rec, up, down, err)
}

// proxyForm handles a proxy-form request (http://, or the isolate tier's https://), which the proxy reads whole: the
// grants see its method and path, and a protected sandbox's placeholders are swapped where they are bound.
func (p *Proxy) proxyForm(conn net.Conn, req *http.Request, rules Rules, attribution, host string, port int, rec Record) {
	rec.Path, rec.Inspected = req.URL.EscapedPath(), true
	v := rules.decide(host, req.Method, rec.Path, scopeRequest)
	rec.Rule = v.rule
	if !v.allowed {
		p.refuseRecord(conn, rec, refusal{status: http.StatusForbidden, code: CodeDenied, rule: v.rule, message: v.reason})
		return
	}
	rec.Allowed = true
	ctx := context.Background()
	if ph := req.Header.Get(CheckHeader); ph != "" {
		p.answerCheck(ctx, conn, rules, attribution, host, port, req, ph, req.URL.Scheme == "https", rec)
		return
	}
	var entries []protect.Entry
	if rules.Protected {
		provider, snap, err := p.snapshot(ctx, rules)
		if err != nil {
			p.refuseRecord(conn, rec, unavailableRefusal())
			return
		}
		entries = snap
		protect.LimitAcceptEncoding(req.Header)
		swapped, err := protect.RewriteRequest(ctx, req, rules.SandboxID, secureDestination(req, host, port, rec.Path), provider)
		if err != nil {
			p.refuseRecord(conn, rec, rewriteRefusal(err))
			return
		}
		rec.Swapped = swapped
	}
	status := 0
	up, down, err := p.forward(conn, nil, req, rules, attribution, host, port, entries, &status)
	rec.Status = status
	p.finish(rec, up, down, err)
}

// secureDestination is a proxy-form request's destination as its bindings judge it. Only an https:// one goes over
// TLS the proxy verifies; a plain http:// one gets no port a binding can match, whatever port it names, so a known
// placeholder in it is refused rather than its value sent in clear text.
func secureDestination(req *http.Request, host string, port int, path string) protect.Destination {
	if req.URL.Scheme != "https" {
		port = 0
	}
	return protect.Destination{Host: host, Port: port, Method: req.Method, Path: path}
}

func (p *Proxy) finish(rec Record, up, down int64, err error) {
	rec.BytesUp, rec.BytesDown = up, down
	rec.DurationMs = time.Since(rec.At).Milliseconds()
	if err != nil {
		rec.Reason = safeError(err)
		var ref *protect.Refusal
		if errors.As(err, &ref) {
			// Recorded as refuseRecord records a refusal found before forwarding: refused, with the status of the
			// refusal sent (unless the destination's answer had begun, whose status it keeps).
			f := rewriteRefusal(ref)
			rec.Allowed = f.code == CodeUpstream
			rec.Code, rec.Reason = f.code, f.message
			if rec.Status == 0 {
				rec.Status = f.status
			}
		}
	}
	if errors.Is(err, ErrDestination) {
		rec.Allowed = false
		rec.Code = CodeDenied
	}
	p.record(rec)
}

// forward passes a request on: a CONNECT as a tunnel, a proxy-form request through the upstream or directly. A
// response is scrubbed of entries' values; status, when given, gets its status.
func (p *Proxy) forward(conn net.Conn, reader *bufio.Reader, req *http.Request, rules Rules, attribution, host string, port int, entries []protect.Entry, status *int) (int64, int64, error) {
	extra := Headers(rules, attribution, time.Now())
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Proxy-Connection")
	for _, name := range []string{"Kantel-Sandbox", "Kantel-Account", "Kantel-Attribution", "Kantel-Signature"} {
		req.Header.Del(name)
	}
	target := net.JoinHostPort(host, strconv.Itoa(port))
	var upstream net.Conn
	var err error
	if rules.Upstream != "" && rules.Protected && req.Method != http.MethodConnect && req.URL.Scheme == "https" {
		// A protected sandbox's https:// request may carry a value: it goes through the upstream in a CONNECT
		// tunnel, in TLS the proxy verifies with the real host, never in clear text to the upstream.
		tr := p.interceptTransport(rules, attribution)
		defer tr.CloseIdleConnections()
		return p.roundTrip(conn, req, tr, entries, status)
	}
	if rules.Upstream != "" {
		u, perr := url.Parse(rules.Upstream)
		if perr != nil || u.Host == "" {
			refuse(conn, http.StatusBadGateway, "the upstream proxy's URL is invalid")
			return 0, 0, &upstreamProxyError{}
		}
		upstream, err = p.Dial("tcp", u.Host)
		if errors.Is(err, ErrDestination) {
			refuse(conn, http.StatusForbidden, "the upstream proxy's address isn't one this host may reach (its egressAllowCIDRs)")
			return 0, 0, err
		}
		if err != nil {
			refuse(conn, http.StatusBadGateway, "the upstream proxy can't be reached")
			return 0, 0, err
		}
		defer upstream.Close()
		if req.Method == http.MethodConnect {
			// CONNECT through the upstream, carrying the sandbox's identity on the CONNECT itself; then the bytes
			// (TLS from the sandbox, terminated by the upstream if it inspects) pass through.
			var b strings.Builder
			fmt.Fprintf(&b, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", target, target)
			for k, vs := range extra {
				for _, v := range vs {
					fmt.Fprintf(&b, "%s: %s\r\n", k, v)
				}
			}
			b.WriteString("\r\n")
			if _, err := io.WriteString(upstream, b.String()); err != nil {
				refuse(conn, http.StatusBadGateway, "the upstream proxy dropped the connection")
				return 0, 0, err
			}
			upReader := bufio.NewReader(upstream)
			res, err := http.ReadResponse(upReader, &http.Request{Method: http.MethodConnect})
			if err != nil {
				refuse(conn, http.StatusBadGateway, "the upstream proxy dropped the connection")
				return 0, 0, err
			}
			if res.StatusCode != http.StatusOK {
				// Pass the upstream's refusal on as it is: its reason is the useful part.
				res.Close = true
				_ = res.Write(conn)
				return 0, 0, &upstreamProxyError{status: res.StatusCode}
			}
			io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n")
			return pipe(conn, reader, upstream, upReader)
		}
		for k, vs := range extra {
			req.Header[k] = vs
		}
		// One request per connection: piping the rest of a keep-alive connection would let a later request (to
		// another host) past the rules.
		req.RequestURI = ""
		req.Close = true
		counted := &countWriter{w: upstream}
		if err := req.WriteProxy(counted); err != nil {
			var ref *protect.Refusal
			if errors.As(err, &ref) {
				_ = rewriteRefusal(ref).write(conn)
			}
			return counted.n, 0, err
		}
		res, err := http.ReadResponse(bufio.NewReader(upstream), req)
		if err != nil {
			refuse(conn, http.StatusBadGateway, "the upstream proxy dropped the connection")
			return counted.n, 0, err
		}
		defer res.Body.Close()
		if entries != nil {
			// A body protect can't read could carry a value back: refused, never passed on.
			if err := protect.ScrubResponse(res, entries); err != nil {
				_ = rewriteRefusal(err).write(conn)
				return counted.n, 0, err
			}
		}
		if status != nil {
			*status = res.StatusCode
		}
		res.Close = true
		down := &countWriter{w: conn}
		err = res.Write(down)
		return counted.n, down.n, err
	}
	if req.Method != http.MethodConnect {
		return p.direct(conn, req, entries, status)
	}
	upstream, err = p.Dial("tcp", target)
	if errors.Is(err, ErrDestination) {
		refuse(conn, http.StatusForbidden, target+" isn't on the public internet")
		return 0, 0, err
	}
	if err != nil {
		refuse(conn, http.StatusBadGateway, "can't connect to "+target)
		return 0, 0, err
	}
	defer upstream.Close()
	io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n")
	return pipe(conn, reader, upstream, bufio.NewReader(upstream))
}

// direct makes one proxy-form request itself (http or https) and writes the answer back, without Kantel's headers
// (they're for an upstream).
func (p *Proxy) direct(conn net.Conn, req *http.Request, entries []protect.Entry, status *int) (int64, int64, error) {
	return p.roundTrip(conn, req, p.directTransport(), entries, status)
}

// roundTrip makes one proxy-form request with tr and writes the scrubbed answer back.
func (p *Proxy) roundTrip(conn net.Conn, req *http.Request, tr http.RoundTripper, entries []protect.Entry, status *int) (int64, int64, error) {
	req.RequestURI = ""
	req.Close = true
	var up int64
	if req.ContentLength > 0 {
		up = req.ContentLength
	}
	res, err := tr.RoundTrip(req)
	if err != nil {
		var ref *protect.Refusal
		switch {
		case errors.As(err, &ref):
			_ = rewriteRefusal(ref).write(conn)
		case errors.Is(err, ErrDestination):
			refuse(conn, http.StatusForbidden, req.URL.Host+" isn't on the public internet")
		default:
			refuse(conn, http.StatusBadGateway, "can't reach "+req.URL.Host+": "+safeError(err))
		}
		return up, 0, err
	}
	defer res.Body.Close()
	if entries != nil {
		if err := protect.ScrubResponse(res, entries); err != nil {
			_ = rewriteRefusal(err).write(conn)
			return up, 0, err
		}
	}
	if status != nil {
		*status = res.StatusCode
	}
	res.Close = true
	counter := &countWriter{w: conn}
	err = res.Write(counter)
	return up, counter.n, err
}

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(b []byte) (int, error) {
	n, err := c.w.Write(b)
	c.n += int64(n)
	return n, err
}

// pipe copies both ways until either side ends; it answers how many bytes went up and down.
func pipe(client net.Conn, clientReader *bufio.Reader, server net.Conn, serverReader *bufio.Reader) (int64, int64, error) {
	var up, down int64
	done := make(chan struct{}, 2)
	go func() {
		up, _ = io.Copy(server, clientReader)
		if c, ok := server.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		down, _ = io.Copy(client, serverReader)
		if c, ok := client.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
		done <- struct{}{}
	}()
	<-done
	<-done
	return up, down, nil
}
