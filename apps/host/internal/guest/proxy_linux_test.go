package guest

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"strings"
	"testing"
)

// The image's Docker client settings give containers and builds HTTPS_PROXY at the containers' forwarder, and no
// HTTP_PROXY: a container calls another on its network by name over plain HTTP (http://api:8080), which NO_PROXY can't
// list and the egress proxy can't reach.
func TestImageDockerClientProxies(t *testing.T) {
	raw, err := os.ReadFile("../../guest/rootfs/home/user/.docker/config.json")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Proxies map[string]map[string]string `json:"proxies"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	def := config.Proxies["default"]
	if want := "http://" + BridgeProxyAddr; def["httpsProxy"] != want {
		t.Errorf("httpsProxy %q, want %q", def["httpsProxy"], want)
	}
	if v, ok := def["httpProxy"]; ok {
		t.Errorf("httpProxy %q: containers' plain HTTP to each other would go to the egress proxy", v)
	}
	if !strings.Contains(def["noProxy"], "localhost") {
		t.Errorf("noProxy %q leaves out localhost", def["noProxy"])
	}
}

// The containers' forwarder is bound before docker0 has its address: 192.0.2.1 (TEST-NET-1) is on no interface here,
// so a plain listen fails where ListenFreebind doesn't.
func TestListenFreebindBeforeTheAddressExists(t *testing.T) {
	if l, err := net.Listen("tcp4", "192.0.2.1:0"); err == nil {
		l.Close()
		t.Skip("192.0.2.1 is an address of this machine")
	}
	l, err := ListenFreebind("192.0.2.1:0")
	if err != nil {
		t.Fatal(err)
	}
	l.Close()
}

// A connection to the containers' forwarder goes to the sandbox's proxy, as one to LocalProxyAddr does.
func TestBridgeForwarderReachesTheProxy(t *testing.T) {
	upstream, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		c, err := upstream.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = c.Write([]byte("proxy"))
	}()
	s := &Server{}
	s.upstream.Store(upstream.Addr().String())
	l, err := ListenFreebind("127.0.0.2:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() { _ = s.ServeLocalProxy(l) }()
	c, err := net.Dial("tcp4", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	got, _ := io.ReadAll(c)
	if string(got) != "proxy" {
		t.Fatalf("got %q from the forwarder", got)
	}
}
