package egress

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"testing"
)

func TestDestinationsRefuseAllButThePublicInternet(t *testing.T) {
	d := Destinations{
		Deny:  []netip.Prefix{netip.MustParsePrefix("10.231.0.0/16")},
		Local: func() []netip.Prefix { return []netip.Prefix{netip.MustParsePrefix("51.15.20.0/24")} },
	}
	refused := []string{
		"127.0.0.1", "127.8.9.10", "::1", // the host's loopback
		"10.231.0.6", "10.231.0.1", // another sandbox, the host's side of a sandbox link
		"10.0.0.1", "172.17.0.1", "192.168.1.1", "fd00::1", // the LAN, Docker's bridge
		"169.254.169.254", "fe80::1", // cloud metadata, link-local
		"100.100.100.100", "0.0.0.0", "255.255.255.255", "224.0.0.1", "ff02::1", "240.0.0.1",
		"::ffff:192.168.1.1", "64:ff9b::c0a8:101", // private IPv4 in IPv6 clothing
		"51.15.20.7", // the host's own (public) network
	}
	for _, raw := range refused {
		if err := d.Check(netip.MustParseAddr(raw)); !errors.Is(err, ErrDestination) {
			t.Errorf("%s: allowed, want refused", raw)
		}
	}
	for _, raw := range []string{"1.1.1.1", "140.82.112.3", "2606:4700:4700::1111", "64:ff9b::808:808"} {
		if err := d.Check(netip.MustParseAddr(raw)); err != nil {
			t.Errorf("%s: %v, want allowed", raw, err)
		}
	}
	// An operator can let a LAN range in, but never the sandboxes' own.
	d.Allow = []netip.Prefix{netip.MustParsePrefix("192.168.10.0/24"), netip.MustParsePrefix("10.0.0.0/8")}
	if err := d.Check(netip.MustParseAddr("192.168.10.5")); err != nil {
		t.Errorf("allowed LAN range: %v", err)
	}
	if err := d.Check(netip.MustParseAddr("10.231.0.6")); !errors.Is(err, ErrDestination) {
		t.Error("the sandbox subnet got through an Allow that covers it")
	}
}

// A sandbox asks the proxy for the host's own services, another sandbox and cloud metadata, by address and by a name
// that resolves to loopback: every one is refused before a connection is made.
func TestProxyWontConnectToPrivateAddresses(t *testing.T) {
	// Something listening on the host's loopback that a sandbox must not reach.
	secret, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer secret.Close()
	reached := make(chan struct{}, 8)
	go func() {
		for {
			c, err := secret.Accept()
			if err != nil {
				return
			}
			reached <- struct{}{}
			c.Close()
		}
	}()
	_, port, _ := net.SplitHostPort(secret.Addr().String())

	p := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	p.Destinations.Deny = []netip.Prefix{netip.MustParsePrefix("10.231.0.0/16")}
	var records []Record
	p.OnRecord = func(r Record) { records = append(records, r) }
	p.Resolve = func(a netip.Addr) (Rules, bool) { return Rules{SandboxID: "sbx_1", Mode: "open"}, true }
	if err := p.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	for _, target := range []string{"127.0.0.1:" + port, "localhost:" + port, "10.231.0.6:22", "169.254.169.254:80", "[::1]:" + port} {
		for _, method := range []string{"CONNECT", "GET"} {
			conn, r := dial(t, p)
			if method == "CONNECT" {
				fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
			} else {
				fmt.Fprintf(conn, "GET http://%s/ HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
			}
			res, err := http.ReadResponse(r, &http.Request{Method: method})
			if err != nil {
				t.Fatalf("%s %s: %v", method, target, err)
			}
			if res.StatusCode != http.StatusForbidden {
				t.Errorf("%s %s: %d, want 403", method, target, res.StatusCode)
			}
		}
	}
	select {
	case <-reached:
		t.Fatal("the proxy connected to the host's loopback for a sandbox")
	default:
	}
	for _, r := range records {
		if r.Allowed {
			t.Errorf("recorded %s %s:%d as allowed", r.Method, r.Host, r.Port)
		}
	}
}

// An account's upstream is checked as well: account admins set it, so it mustn't be a way onto the host's LAN.
func TestUpstreamOnAPrivateAddressNeedsTheOperator(t *testing.T) {
	up := newUpstream(t)
	p := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	p.Resolve = func(a netip.Addr) (Rules, bool) {
		return Rules{SandboxID: "sbx_1", Mode: "proxy", Upstream: "http://" + up.l.Addr().String()}, true
	}
	if err := p.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	conn, r := dial(t, p)
	fmt.Fprint(conn, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
	res, err := http.ReadResponse(r, &http.Request{Method: http.MethodConnect})
	if err != nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("upstream on loopback: %v %v, want 403", res, err)
	}
	if up.count() != 0 {
		t.Fatal("the upstream on loopback was reached")
	}
}
