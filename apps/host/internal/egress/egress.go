// Package egress is the host's egress proxy: the one way out of a sandbox whose egress is "proxy", and an optional
// one for "open" sandboxes with an upstream to report to.
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
package egress

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
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
	// AttributionKey signs the Kantel-Sandbox/Kantel-Account headers (HMAC-SHA256); empty sends them unsigned.
	AttributionKey string
	// Allow and Deny are host patterns ("example.com", "*.example.com"); Deny wins. DefaultDeny refuses hosts no
	// rule names.
	Allow       []string
	Deny        []string
	DefaultDeny bool
}

// Record is one decision, for the host's log and the control plane's events.
type Record struct {
	At          time.Time `json:"at"`
	SandboxID   string    `json:"sandboxId"`
	Account     string    `json:"account,omitempty"`
	Method      string    `json:"method"`
	Host        string    `json:"host"`
	Port        int       `json:"port"`
	Allowed     bool      `json:"allowed"`
	Reason      string    `json:"reason,omitempty"`
	Via         string    `json:"via"`
	Attribution string    `json:"attribution,omitempty"`
	BytesUp     int64     `json:"bytesUp"`
	BytesDown   int64     `json:"bytesDown"`
	DurationMs  int64     `json:"durationMs"`
}

// Proxy is the host's egress proxy.
type Proxy struct {
	log *slog.Logger
	// Resolve names the sandbox a connection came from by its source address.
	Resolve func(netip.Addr) (Rules, bool)
	// OnRecord sees every decision.
	OnRecord func(Record)
	// Dial is how connections leave (tests replace it).
	Dial func(network, address string) (net.Conn, error)

	listener  net.Listener
	served    atomic.Int64
	transport *http.Transport
}

func New(log *slog.Logger) *Proxy {
	d := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	p := &Proxy{log: log, Dial: d.Dial}
	p.transport = &http.Transport{
		Dial:                func(network, addr string) (net.Conn, error) { return p.Dial(network, addr) },
		TLSHandshakeTimeout: 15 * time.Second,
		MaxIdleConns:        64,
		IdleConnTimeout:     30 * time.Second,
		ForceAttemptHTTP2:   false,
	}
	return p
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

// Decide applies a sandbox's rules to a destination host.
func Decide(r Rules, host string) (bool, string) {
	host = strings.ToLower(host)
	if r.Mode == "none" {
		return false, "this sandbox has no network"
	}
	for _, d := range r.Deny {
		if matchHost(d, host) {
			return false, "denied by the proxy settings (" + d + ")"
		}
	}
	for _, a := range r.Allow {
		if matchHost(a, host) {
			return true, ""
		}
	}
	if r.DefaultDeny {
		return false, "not on the proxy settings' allow list"
	}
	return true, ""
}

func (p *Proxy) record(rec Record) {
	p.served.Add(1)
	if p.OnRecord != nil {
		p.OnRecord(rec)
	}
	p.log.Info("egress", "sandbox", rec.SandboxID, "method", rec.Method, "host", rec.Host, "port", rec.Port, "allowed", rec.Allowed, "reason", rec.Reason, "via", rec.Via, "attribution", rec.Attribution, "up", rec.BytesUp, "down", rec.BytesDown)
}

func refuse(conn net.Conn, status int, reason string) {
	body := "kantel egress: " + reason + "\n"
	fmt.Fprintf(conn, "HTTP/1.1 %d %s\r\nContent-Type: text/plain\r\nX-Kantel-Egress: denied\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", status, http.StatusText(status), len(body), body)
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
	rules, ok := p.Resolve(src.Addr().Unmap())
	p.handleWith(conn, func(*http.Request) (Rules, bool) { return rules, ok })
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
	rules, ok := resolve(req)
	req.Header.Del("Kantel-Isolate-Sandbox")
	if !ok {
		refuse(conn, http.StatusForbidden, "unknown sandbox")
		return
	}
	started := time.Now()
	attribution := claimed(req.Header)
	host, port := "", 0
	if req.Method == http.MethodConnect {
		h, ps, err := net.SplitHostPort(req.Host)
		if err != nil {
			refuse(conn, http.StatusBadRequest, "bad CONNECT authority")
			return
		}
		host = h
		port, _ = strconv.Atoi(ps)
	} else {
		// Proxy form: http:// from a process's HTTP_PROXY, or https:// too from the isolate worker (workerd's proxy
		// style), which leaves the TLS to the proxy.
		if req.URL == nil || !req.URL.IsAbs() || (req.URL.Scheme != "http" && req.URL.Scheme != "https") {
			refuse(conn, http.StatusBadRequest, "only proxy-form http(s):// requests and CONNECT")
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
	allowed, reason := Decide(rules, host)
	if !allowed {
		rec.Reason = reason
		p.record(rec)
		refuse(conn, http.StatusForbidden, reason)
		return
	}
	rec.Allowed = true
	up, down, err := p.forward(conn, reader, req, rules, attribution, host, port)
	rec.BytesUp, rec.BytesDown = up, down
	rec.DurationMs = time.Since(started).Milliseconds()
	if err != nil {
		rec.Reason = err.Error()
	}
	p.record(rec)
}

func (p *Proxy) forward(conn net.Conn, reader *bufio.Reader, req *http.Request, rules Rules, attribution, host string, port int) (int64, int64, error) {
	extra := Headers(rules, attribution, time.Now())
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Proxy-Connection")
	for _, name := range []string{"Kantel-Sandbox", "Kantel-Account", "Kantel-Attribution", "Kantel-Signature"} {
		req.Header.Del(name)
	}
	target := net.JoinHostPort(host, strconv.Itoa(port))
	var upstream net.Conn
	var err error
	if rules.Upstream != "" {
		u, perr := url.Parse(rules.Upstream)
		if perr != nil || u.Host == "" {
			refuse(conn, http.StatusBadGateway, "the upstream proxy's URL is invalid")
			return 0, 0, fmt.Errorf("bad upstream %q", rules.Upstream)
		}
		upstream, err = p.Dial("tcp", u.Host)
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
				return 0, 0, fmt.Errorf("upstream answered %d", res.StatusCode)
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
			return counted.n, 0, err
		}
		res, err := http.ReadResponse(bufio.NewReader(upstream), req)
		if err != nil {
			refuse(conn, http.StatusBadGateway, "the upstream proxy dropped the connection")
			return counted.n, 0, err
		}
		defer res.Body.Close()
		res.Close = true
		down := &countWriter{w: conn}
		err = res.Write(down)
		return counted.n, down.n, err
	}
	if req.Method != http.MethodConnect {
		return p.direct(conn, req)
	}
	upstream, err = p.Dial("tcp", target)
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
func (p *Proxy) direct(conn net.Conn, req *http.Request) (int64, int64, error) {
	req.RequestURI = ""
	req.Close = true
	var up int64
	if req.ContentLength > 0 {
		up = req.ContentLength
	}
	res, err := p.transport.RoundTrip(req)
	if err != nil {
		refuse(conn, http.StatusBadGateway, "can't reach "+req.URL.Host+": "+err.Error())
		return up, 0, err
	}
	defer res.Body.Close()
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
