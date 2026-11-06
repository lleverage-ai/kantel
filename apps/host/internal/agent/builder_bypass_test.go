package agent

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// The three ways Cerbie showed a build on the host's Docker reaching the host's network (kantel#674), and a FROM that
// names a host-local registry, each tried against a real network: real listeners, a real DNS server and the host's
// real egress proxy, under the rules a build microVM gets (microvm.BuilderEgress over the agent's egressRules). In the
// build microVM, Docker's pulls, its redirects, a RUN step's fetch and an ONBUILD trigger are all connections through
// that proxy, since the microVM's link reaches nothing else (package network); the client here stands in for them.
//
// A "public" registry listens on 127.0.0.2, which the proxy's destinations allow as the stand-in for a public address,
// and a "private" endpoint on 127.0.0.1, the host's loopback, on the same port, counting what reaches it. The
// operator lets ordinary sandboxes reach 127.0.0.1 (egressAllowCIDRs, as for a LAN mirror), and the build's rules
// allow its names, so only the build's public-only address check stands between the build and it: each test requires
// it refused and the private endpoint never reached, and TestBuilderIgnoresTheOperatorsPrivateRanges shows an
// ordinary sandbox does reach it.

// builderNet is the test's network: the private endpoint, the public registry, a DNS server, and the proxy.
type builderNet struct {
	port     string
	private  atomic.Int64
	public   atomic.Int64
	dns      *testDNS
	proxy    *url.URL
	refusals atomic.Int64
	client   *http.Client
	// ordinary is a client of the same proxy under an ordinary sandbox's rules.
	ordinary *http.Client
}

func newBuilderNet(t *testing.T, registry http.Handler) *builderNet {
	t.Helper()
	n := &builderNet{}
	privateL, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, n.port, _ = net.SplitHostPort(privateL.Addr().String())
	publicL, err := net.Listen("tcp", "127.0.0.2:"+n.port)
	if err != nil {
		privateL.Close()
		t.Skipf("no 127.0.0.2 on this host: %v", err)
	}
	private := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.private.Add(1)
		_, _ = io.WriteString(w, "instance credentials")
	})}
	public := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.public.Add(1)
		registry.ServeHTTP(w, r)
	})}
	go func() { _ = private.Serve(privateL) }()
	go func() { _ = public.Serve(publicL) }()
	t.Cleanup(func() { private.Close(); public.Close() })

	n.dns = startTestDNS(t)
	p := egress.New(slog.New(slog.DiscardHandler))
	// 127.0.0.2 stands for a public address; everything else is judged as on a real host (loopback, private and
	// link-local refused, the host's own networks too). The operator opens 127.0.0.1 to ordinary sandboxes, as
	// egressAllowCIDRs does a LAN range; a build's public-only check never takes it.
	publicStandIn := netip.MustParsePrefix("127.0.0.2/32")
	p.Destinations = egress.Destinations{Allow: []netip.Prefix{publicStandIn, netip.MustParsePrefix("127.0.0.1/32")}}
	p.PublicDestinations = &egress.Destinations{Allow: []netip.Prefix{publicStandIn}}
	p.UseResolver(n.dns.resolver())
	p.OnRecord = func(rec egress.Record) {
		if !rec.Allowed || rec.Status >= 400 || rec.Code != "" {
			n.refusals.Add(1)
		}
	}
	// The build microVM's rules: the template's (here "open", the account's default), as the host makes them a build's.
	builder := &microvm.TemplateBuilderConfig{Registries: []string{"*.test", "localhost", "127.0.0.1"}}
	h := &Host{cfg: Config{Egress: "open"}}
	rules := h.egressRules("tsn_1", "acc_1", microvm.BuilderEgress(&proto.Egress{Mode: "open"}, builder, "", false))
	if rules.Mode != "proxy" || !rules.DefaultDeny || !rules.PublicOnly {
		t.Fatalf("the build microVM's rules %+v", rules)
	}
	// An ordinary sandbox's rules, allowing the same names, on the same proxy.
	ordinary := h.egressRules("sbx_1", "acc_1", &proto.Egress{Mode: "proxy", Allow: builder.Registries, DefaultDeny: true})
	serve := func(r egress.Rules) *url.URL {
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
				go p.ServeConn(conn, func(*http.Request) (egress.Rules, bool) { return r, true })
			}
		}()
		return &url.URL{Scheme: "http", Host: l.Addr().String()}
	}
	n.proxy = serve(rules)
	n.client = &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(n.proxy), DisableKeepAlives: true}}
	n.ordinary = &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(serve(ordinary)), DisableKeepAlives: true}}
	return n
}

// The operator's private ranges (egressAllowCIDRs) are for ordinary sandboxes: one reaches the private endpoint
// through them, by address, by a name and by a redirect, while the build, with the same names allowed, never does,
// even after the ordinary sandbox's connections have been made (a build's requests never share its pool).
func TestBuilderIgnoresTheOperatorsPrivateRanges(t *testing.T) {
	var port string
	n := newBuilderNet(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://internal.test:"+port+"/blob", http.StatusTemporaryRedirect)
	}))
	port = n.port
	n.dns.answer("registry.test", "127.0.0.2")
	n.dns.answer("internal.test", "127.0.0.1")
	for _, u := range []string{
		"http://127.0.0.1:" + n.port + "/",
		"http://internal.test:" + n.port + "/",
		"http://registry.test:" + n.port + "/v2/app/blobs/x",
	} {
		res, err := n.ordinary.Get(u)
		if err != nil {
			t.Fatalf("an ordinary sandbox's %s: %v", u, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("an ordinary sandbox's %s answered %d", u, res.StatusCode)
		}
	}
	reached := n.private.Load()
	if reached != 3 {
		t.Fatalf("the ordinary sandbox reached the private endpoint %d times", reached)
	}
	for _, u := range []string{
		"http://127.0.0.1:" + n.port + "/",
		"http://internal.test:" + n.port + "/",
		"http://registry.test:" + n.port + "/v2/app/blobs/x",
	} {
		if got := n.get(t, u); got == http.StatusOK || got == http.StatusTemporaryRedirect {
			t.Errorf("the build's %s answered %d", u, got)
		}
	}
	if got := n.connect(t, "internal.test:"+n.port); got == http.StatusOK {
		t.Errorf("the build's tunnel to internal.test opened")
	}
	if got := n.private.Load(); got != reached {
		t.Fatalf("the build reached the private endpoint %d times", got-reached)
	}
}

// get fetches u through the proxy, following redirects as Docker does, and answers the final status.
func (n *builderNet) get(t *testing.T, u string) int {
	t.Helper()
	res, err := n.client.Get(u)
	if err != nil {
		return 0
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	return res.StatusCode
}

// connect asks the proxy for a tunnel to authority, as an HTTPS pull does, and answers the proxy's status.
func (n *builderNet) connect(t *testing.T, authority string) int {
	t.Helper()
	conn, err := net.DialTimeout("tcp", n.proxy.Host, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", authority, authority)
	res, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
	if err != nil {
		return 0
	}
	return res.StatusCode
}

// waitRefusals waits up to 5 seconds for the proxy to have recorded at least want refusals, which it can do just after
// the refused client has its answer.
func (n *builderNet) waitRefusals(t *testing.T, want int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for n.refusals.Load() < want && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
}

// noPrivateRequest fails the test if anything reached the private endpoint.
func (n *builderNet) noPrivateRequest(t *testing.T) {
	t.Helper()
	if got := n.private.Load(); got != 0 {
		t.Fatalf("the private endpoint saw %d requests", got)
	}
}

// DNS rebinding: the registry's name resolves to a public address, then to the host's loopback. The proxy resolves it
// itself as it connects and checks the address it got, so the second connection, plain or a tunnel, is refused.
func TestBuilderDNSRebindingReachesNoPrivateAddress(t *testing.T) {
	n := newBuilderNet(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	n.dns.answer("registry.test", "127.0.0.2", "127.0.0.1")
	u := "http://registry.test:" + n.port + "/v2/"
	if got := n.get(t, u); got != http.StatusOK {
		t.Fatalf("the public registry answered %d", got)
	}
	if got := n.get(t, u); got == http.StatusOK || got == 0 {
		t.Fatalf("after the name rebound to the loopback, the proxy answered %d", got)
	}
	n.dns.answer("registry.test", "127.0.0.2", "127.0.0.1")
	if got := n.connect(t, "registry.test:"+n.port); got != http.StatusOK {
		t.Fatalf("the public tunnel answered %d", got)
	}
	if got := n.connect(t, "registry.test:"+n.port); got == http.StatusOK {
		t.Fatalf("after the name rebound to the loopback, the proxy opened a tunnel (%d)", got)
	}
	// A refusal found while forwarding is recorded after its answer is written (egress.Proxy's finish), so the second
	// refusal can land a moment after the client has its answer: wait for it rather than read the count at once.
	n.waitRefusals(t, 2)
	if n.public.Load() != 1 || n.refusals.Load() < 2 {
		t.Fatalf("public requests %d, refusals %d", n.public.Load(), n.refusals.Load())
	}
	n.noPrivateRequest(t)
}

// A registry redirect: a public registry answers a blob with a redirect to the host's loopback, a name that resolves
// to it, cloud metadata or a private address. Each hop is a connection of its own through the proxy, so it is
// refused there.
func TestBuilderRegistryRedirectToAPrivateAddressIsRefused(t *testing.T) {
	var port string
	targets := map[string]string{
		"loopback": "http://127.0.0.1:%s/blob",
		"name":     "http://internal.test:%s/blob",
		"local":    "http://localhost:%s/blob",
		"metadata": "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
		"private":  "http://10.0.0.1:%s/blob",
	}
	n := newBuilderNet(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target, ok := targets[strings.TrimPrefix(r.URL.Path, "/v2/app/blobs/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if strings.Contains(target, "%s") {
			target = fmt.Sprintf(target, port)
		}
		http.Redirect(w, r, target, http.StatusTemporaryRedirect)
	}))
	port = n.port
	n.dns.answer("registry.test", "127.0.0.2")
	n.dns.answer("internal.test", "127.0.0.1")
	for name := range targets {
		if got := n.get(t, "http://registry.test:"+n.port+"/v2/app/blobs/"+name); got == http.StatusOK || got == http.StatusTemporaryRedirect {
			t.Errorf("the redirect to %s answered %d", name, got)
		}
	}
	if n.public.Load() != int64(len(targets)) {
		t.Fatalf("the registry saw %d requests", n.public.Load())
	}
	n.noPrivateRequest(t)
}

// ONBUILD ADD in a pulled image: a public image's config carries ONBUILD triggers that ADD the host's loopback, a name
// resolving to it and cloud metadata. Docker in the microVM runs them as fetches of its own, through the proxy; each is
// refused there.
func TestBuilderOnbuildAddInAPulledImageReachesNoPrivateAddress(t *testing.T) {
	var port string
	n := newBuilderNet(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/app/manifests/latest":
			w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
			_, _ = io.WriteString(w, `{"schemaVersion":2,"config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:c0nf"}}`)
		case "/v2/app/blobs/sha256:c0nf":
			onbuild := []string{
				"ADD http://127.0.0.1:" + port + "/secret /secret",
				"ADD http://internal.test:" + port + "/secret /secret",
				"ADD http://169.254.169.254/latest/meta-data/ /meta",
				"ADD http://[::1]:" + port + "/secret /secret",
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"config": map[string]any{"OnBuild": onbuild}})
		default:
			http.NotFound(w, r)
		}
	}))
	port = n.port
	n.dns.answer("registry.test", "127.0.0.2")
	n.dns.answer("internal.test", "127.0.0.1")
	// The pull: its manifest, then its config, which has the triggers.
	base := "http://registry.test:" + n.port + "/v2/app/"
	if got := n.get(t, base+"manifests/latest"); got != http.StatusOK {
		t.Fatalf("manifest %d", got)
	}
	res, err := n.client.Get(base + "blobs/sha256:c0nf")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Config struct{ OnBuild []string } `json:"config"`
	}
	err = json.NewDecoder(res.Body).Decode(&config)
	res.Body.Close()
	if err != nil || len(config.Config.OnBuild) != 4 {
		t.Fatalf("config %+v %v", config, err)
	}
	for _, trigger := range config.Config.OnBuild {
		fields := strings.Fields(trigger)
		if got := n.get(t, fields[1]); got == http.StatusOK {
			t.Errorf("ONBUILD %q fetched (%d)", trigger, got)
		}
	}
	n.noPrivateRequest(t)
}

// FROM naming a host-local registry (localhost:5000/app, 127.0.0.1:5000/app): in the microVM localhost is the microVM
// itself, and through the proxy it is the host's loopback, which is refused, plain or as a tunnel, even with the name
// on the build's allow list.
func TestBuilderFromAHostLocalRegistryIsRefused(t *testing.T) {
	n := newBuilderNet(t, http.NotFoundHandler())
	for _, host := range []string{"localhost", "127.0.0.1", "[::1]"} {
		if got := n.get(t, "http://"+host+":"+n.port+"/v2/app/manifests/latest"); got == http.StatusOK || got == http.StatusNotFound {
			t.Errorf("FROM %s:%s answered %d", host, n.port, got)
		}
		if got := n.connect(t, host+":"+n.port); got == http.StatusOK {
			t.Errorf("a tunnel to %s:%s opened", host, n.port)
		}
	}
	n.noPrivateRequest(t)
}

// testDNS is a DNS server answering A queries for names from a script: each query takes the next address, the last
// repeating (a rebinding server). Anything else is answered with no records.
type testDNS struct {
	conn    net.PacketConn
	mu      sync.Mutex
	answers map[string][]string
}

func startTestDNS(t *testing.T) *testDNS {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	d := &testDNS{conn: conn, answers: map[string][]string{}}
	t.Cleanup(func() { conn.Close() })
	go d.serve()
	return d
}

func (d *testDNS) answer(name string, addrs ...string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.answers[strings.ToLower(name)] = addrs
}

func (d *testDNS) resolver() *net.Resolver {
	return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, "udp", d.conn.LocalAddr().String())
	}}
}

// next is the address name's next A query gets, or "".
func (d *testDNS) next(name string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	addrs := d.answers[strings.ToLower(strings.TrimSuffix(name, "."))]
	if len(addrs) == 0 {
		return ""
	}
	addr := addrs[0]
	if len(addrs) > 1 {
		d.answers[strings.ToLower(strings.TrimSuffix(name, "."))] = addrs[1:]
	}
	return addr
}

func (d *testDNS) serve() {
	buf := make([]byte, 1500)
	for {
		n, from, err := d.conn.ReadFrom(buf)
		if err != nil {
			return
		}
		if reply := d.reply(buf[:n]); reply != nil {
			_, _ = d.conn.WriteTo(reply, from)
		}
	}
}

// reply answers one query: its header and question echoed, with one A record when it asks for one this server has.
func (d *testDNS) reply(q []byte) []byte {
	if len(q) < 12 {
		return nil
	}
	var labels []string
	i := 12
	for i < len(q) && q[i] != 0 {
		l := int(q[i])
		if i+1+l > len(q) {
			return nil
		}
		labels = append(labels, string(q[i+1:i+1+l]))
		i += 1 + l
	}
	if i+5 > len(q) {
		return nil
	}
	question := q[12 : i+5]
	qtype := binary.BigEndian.Uint16(q[i+1:])
	var ip netip.Addr
	if qtype == 1 {
		if addr := d.next(strings.Join(labels, ".")); addr != "" {
			ip = netip.MustParseAddr(addr)
		}
	}
	out := make([]byte, 12, 64)
	copy(out, q[:2])
	binary.BigEndian.PutUint16(out[2:], 0x8180)
	binary.BigEndian.PutUint16(out[4:], 1)
	if ip.IsValid() {
		binary.BigEndian.PutUint16(out[6:], 1)
	}
	out = append(out, question...)
	if ip.IsValid() {
		a := ip.As4()
		out = append(out, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4)
		out = append(out, a[:]...)
	}
	return out
}
