package guest

import (
	"bufio"
	"net"
	"testing"
	"time"
)

func TestProxyUpstreamIsHTTPProxysHost(t *testing.T) {
	for env, want := range map[string]string{
		"http://sandbox@10.231.0.5:3129":  "10.231.0.5:3129",
		"http://sandbox:@10.231.0.5:3129": "10.231.0.5:3129",
		"http://10.231.0.9:3129":          "10.231.0.9:3129",
		"":                                "",
		"::not a url":                     "",
	} {
		if got := proxyUpstream(map[string]string{"HTTP_PROXY": env}); got != want {
			t.Errorf("proxyUpstream(%q) = %q, want %q", env, got, want)
		}
	}
}

// The forwarder follows the newest identity's proxy: a connection goes to whichever upstream is current when it
// opens, and with none it is closed.
func TestLocalProxyFollowsTheIdentity(t *testing.T) {
	echo := func(reply string) string {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { l.Close() })
		go func() {
			for {
				c, err := l.Accept()
				if err != nil {
					return
				}
				line, _ := bufio.NewReader(c).ReadString('\n')
				_, _ = c.Write([]byte(reply + ":" + line))
				c.Close()
			}
		}()
		return l.Addr().String()
	}
	first, second := echo("first"), echo("second")
	s := &Server{}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() { _ = s.ServeLocalProxy(l) }()
	ask := func() string {
		c, err := net.DialTimeout("tcp", l.Addr().String(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(2 * time.Second))
		_, _ = c.Write([]byte("hello\n"))
		got, _ := bufio.NewReader(c).ReadString('\n')
		return got
	}
	if got := ask(); got != "" {
		t.Fatalf("no proxy: got %q, want a closed connection", got)
	}
	s.upstream.Store(first)
	if got := ask(); got != "first:hello\n" {
		t.Fatalf("got %q", got)
	}
	s.upstream.Store(second)
	if got := ask(); got != "second:hello\n" {
		t.Fatalf("after a fork: got %q", got)
	}
}
