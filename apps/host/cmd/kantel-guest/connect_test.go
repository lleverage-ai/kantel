package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeProxy is an egress proxy that answers each CONNECT with answer, then (when answer is a 200) echoes what comes
// through the tunnel after a banner, as an SSH server would greet first. It records each request it was sent.
type fakeProxy struct {
	addr string
	mu   sync.Mutex
	reqs []*http.Request
}

const sshBanner = "SSH-2.0-fake\r\n"

func startFakeProxy(t *testing.T, answer string) *fakeProxy {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	p := &fakeProxy{addr: l.Addr().String()}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				req, err := http.ReadRequest(r)
				if err != nil {
					return
				}
				p.mu.Lock()
				p.reqs = append(p.reqs, req)
				p.mu.Unlock()
				if answer == "" {
					return // as the guest's forwarder does with no proxy
				}
				if !strings.HasPrefix(answer, "HTTP/1.1 200") {
					_, _ = io.WriteString(c, answer)
					return
				}
				// The answer and the far side's banner in one write: none of the banner may be lost.
				_, _ = io.WriteString(c, answer+sshBanner)
				_, _ = io.Copy(c, r)
			}()
		}
	}()
	return p
}

func (p *fakeProxy) requests() []*http.Request {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.reqs)
}

// closedAddr is a local address nothing listens on.
func closedAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return addr
}

func withLocalProxy(t *testing.T, addr string) {
	t.Helper()
	old := localProxyAddr
	localProxyAddr = addr
	t.Cleanup(func() { localProxyAddr = old })
}

func noEnv(string) string { return "" }

// runConnect runs connect with input on its stdin and returns its exit code, stdout and stderr.
func runConnect(t *testing.T, args []string, getenv func(string) string, input string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	done := make(chan int, 1)
	go func() { done <- connect(args, getenv, strings.NewReader(input), &stdout, &stderr) }()
	select {
	case code := <-done:
		return code, stdout.String(), stderr.String()
	case <-time.After(10 * time.Second):
		t.Fatal("connect didn't end")
		return 0, "", ""
	}
}

// ssh's ProxyCommand: a CONNECT to the host and port, then bytes both ways, the far side's first bytes included,
// until ssh closes its end.
func TestConnectTunnelsThroughTheLocalProxy(t *testing.T) {
	p := startFakeProxy(t, "HTTP/1.1 200 Connection established\r\n\r\n")
	withLocalProxy(t, p.addr)
	code, out, errOut := runConnect(t, []string{"ssh.github.com", "443"}, noEnv, "SSH-2.0-OpenSSH_test\r\n")
	if code != 0 || errOut != "" {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
	if want := sshBanner + "SSH-2.0-OpenSSH_test\r\n"; out != want {
		t.Fatalf("stdout %q, want %q", out, want)
	}
	reqs := p.requests()
	if len(reqs) != 1 || reqs[0].Method != http.MethodConnect || reqs[0].Host != "ssh.github.com:443" {
		t.Fatalf("requests: %+v", reqs)
	}
	if got := reqs[0].Header.Get("Proxy-Authorization"); got != "" {
		t.Fatalf("Proxy-Authorization %q with no proxy variables", got)
	}
}

// The proxy URL's user is the sandbox's label for its requests: it goes on the CONNECT, as curl sends it.
func TestConnectSendsTheProxyURLsUser(t *testing.T) {
	p := startFakeProxy(t, "HTTP/1.1 200 Connection established\r\n\r\n")
	withLocalProxy(t, p.addr)
	env := map[string]string{"HTTPS_PROXY": "http://sandbox-call_1:@10.231.0.9:3129"}
	code, _, errOut := runConnect(t, []string{"github.com", "22"}, func(k string) string { return env[k] }, "")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("sandbox-call_1:"))
	if got := p.requests()[0].Header.Get("Proxy-Authorization"); got != want {
		t.Fatalf("Proxy-Authorization %q, want %q", got, want)
	}
}

// Where nothing listens on the forwarder's address, the environment's proxy is the way out.
func TestConnectFallsBackToTheEnvironmentsProxy(t *testing.T) {
	p := startFakeProxy(t, "HTTP/1.1 200 Connection established\r\n\r\n")
	withLocalProxy(t, closedAddr(t))
	env := map[string]string{"http_proxy": "http://sandbox:@" + p.addr}
	code, out, errOut := runConnect(t, []string{"github.com", "22"}, func(k string) string { return env[k] }, "hi\n")
	if code != 0 || out != sshBanner+"hi\n" {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, out, errOut)
	}
	if len(p.requests()) != 1 {
		t.Fatalf("the environment's proxy got %d requests", len(p.requests()))
	}
}

// A refusal says why, in the proxy's own words.
func TestConnectReportsTheProxysRefusal(t *testing.T) {
	body := "kantel egress: denied by the proxy settings (ssh.github.com).\n"
	p := startFakeProxy(t, "HTTP/1.1 403 Forbidden (kantel egress: denied by the proxy settings (ssh.github.com))\r\n"+
		"Content-Type: text/plain\r\nX-Kantel-Egress: denied\r\nContent-Length: "+strconv.Itoa(len(body))+"\r\n\r\n"+body)
	withLocalProxy(t, p.addr)
	code, out, errOut := runConnect(t, []string{"ssh.github.com", "443"}, noEnv, "")
	if code != 1 || out != "" {
		t.Fatalf("exit %d, stdout %q", code, out)
	}
	if want := "kantel-connect: ssh.github.com:443: kantel egress: denied by the proxy settings (ssh.github.com).\n"; errOut != want {
		t.Fatalf("stderr %q, want %q", errOut, want)
	}
	// With no body, the status line.
	p = startFakeProxy(t, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
	withLocalProxy(t, p.addr)
	if code, _, errOut := runConnect(t, []string{"example.com", "22"}, noEnv, ""); code != 1 || !strings.Contains(errOut, "answered 502 Bad Gateway") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
}

// The forwarder closes a connection at once when the sandbox has no proxy (egress "none").
func TestConnectWithNoProxy(t *testing.T) {
	p := startFakeProxy(t, "")
	withLocalProxy(t, p.addr)
	code, _, errOut := runConnect(t, []string{"github.com", "22"}, noEnv, "")
	if code != 1 || !strings.Contains(errOut, "closed the connection without answering") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
	withLocalProxy(t, closedAddr(t))
	code, _, errOut = runConnect(t, []string{"github.com", "22"}, noEnv, "")
	if code != 1 || !strings.Contains(errOut, "can't reach the sandbox's egress proxy") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
}

// Only a host name or an IP address goes on the request line, never anything that ends it or adds a header.
func TestConnectTarget(t *testing.T) {
	for _, c := range []struct{ host, port, want string }{
		{"github.com", "22", "github.com:22"},
		{"ssh.github.com", "443", "ssh.github.com:443"},
		{"140.82.112.36", "22", "140.82.112.36:22"},
		{"2001:db8::1", "22", "[2001:db8::1]:22"},
		{"[2001:db8::1]", "22", "[2001:db8::1]:22"},
		{"my_host.internal", "2222", "my_host.internal:2222"},
	} {
		if got, err := connectTarget(c.host, c.port); err != nil || got != c.want {
			t.Errorf("connectTarget(%q, %q) = %q, %v; want %q", c.host, c.port, got, err, c.want)
		}
	}
	for _, c := range [][2]string{
		{"", "22"},
		{"github.com\r\nX-Evil: 1", "22"},
		{"github.com HTTP/1.1", "22"},
		{"a:b", "22"},
		{"github.com", "0"},
		{"github.com", "65536"},
		{"github.com", "ssh"},
	} {
		if got, err := connectTarget(c[0], c[1]); err == nil {
			t.Errorf("connectTarget(%q, %q) = %q, want an error", c[0], c[1], got)
		}
	}
	if code, _, _ := runConnect(t, []string{"github.com"}, noEnv, ""); code != 2 {
		t.Fatalf("one argument: exit %d, want 2", code)
	}
}

// The image's SSH settings send GitHub through kantel-connect to ssh.github.com:443, checked against GitHub's keys
// under github.com, and leave every other host alone.
func TestImageSSHConfig(t *testing.T) {
	ssh, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("no ssh client")
	}
	conf := filepath.Join("..", "..", "guest", "rootfs", "etc", "ssh", "ssh_config.d", "kantel.conf")
	effective := func(host string) map[string]string {
		out, err := exec.Command(ssh, "-G", "-F", conf, host).Output()
		if err != nil {
			t.Fatalf("ssh -G %s: %v", host, err)
		}
		got := map[string]string{}
		for _, line := range strings.Split(string(out), "\n") {
			k, v, _ := strings.Cut(line, " ")
			got[k] = v
		}
		return got
	}
	gh := effective("git@github.com")
	for k, want := range map[string]string{
		"hostname":     "ssh.github.com",
		"port":         "443",
		"hostkeyalias": "github.com",
		"proxycommand": "/usr/local/bin/kantel-connect %h %p",
		"user":         "git",
	} {
		if gh[k] != want {
			t.Errorf("github.com: %s = %q, want %q", k, gh[k], want)
		}
	}
	other := effective("example.com")
	if p, ok := other["proxycommand"]; ok && p != "none" {
		t.Errorf("example.com: proxycommand %q, want none", p)
	}
	// Every key in the known hosts file is GitHub's, under the names the settings check it by.
	known, err := os.ReadFile(filepath.Join("..", "..", "guest", "rootfs", "etc", "ssh", "ssh_known_hosts"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(known)), "\n")
	if len(lines) != 3 {
		t.Fatalf("%d known host keys, want GitHub's 3", len(lines))
	}
	for _, line := range lines {
		if names, _, _ := strings.Cut(line, " "); !slices.Contains(strings.Split(names, ","), "github.com") {
			t.Errorf("a known host key isn't under github.com: %q", names)
		}
	}
}
