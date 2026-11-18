package kantel

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// kantel ssh through Kantel's relay: ssh's arguments, kantel ssh-proxy's piping, and its refusals.

const tunnelURL = "wss://kantel.test/v1/hosts/tunnel/eyJ4Ijox.c2ln"

var (
	testTunnel  = tunnelAccess{User: "user", ProxyURL: tunnelURL}
	testOptions = tunnelOptions{Self: []string{"/usr/local/bin/kantel"}, SandboxID: "sbx_4kq9x2mt", KnownHosts: "/k/known_hosts"}
)

func TestTunnelSSHArgs(t *testing.T) {
	o := testOptions
	o.IdentityFile = "/k/sbx_4kq9x2mt"
	args := tunnelSSHArgs(testTunnel, o)
	want := []string{
		"-i", "/k/sbx_4kq9x2mt", "-o", "IdentitiesOnly=yes",
		"-o", "ProxyCommand=/usr/local/bin/kantel ssh-proxy",
		"-o", "HostKeyAlias=sbx_4kq9x2mt",
		"-o", "UserKnownHostsFile=/k/known_hosts",
		"-o", "StrictHostKeyChecking=accept-new",
		"user@sbx_4kq9x2mt",
	}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args:\n got %q\nwant %q", args, want)
	}
	if strings.Contains(strings.Join(args, " "), tunnelURL) {
		t.Error("the URL is in ssh's arguments")
	}

	// Quoted for the shell ssh runs the ProxyCommand with, and ssh's % tokens escaped.
	o = testOptions
	o.Self = []string{"/Users/me/my apps/kantel", "/x/100%/main"}
	contains(t, "quoted", strings.Join(tunnelSSHArgs(testTunnel, o), "\n"), "ProxyCommand='/Users/me/my apps/kantel' /x/100%%/main ssh-proxy\n")

	// The printed command carries the URL to ssh-proxy itself.
	o = testOptions
	o.Self = []string{"kantel"}
	eq(t, "command", tunnelSSHCommand(testTunnel, o),
		"ssh -o 'ProxyCommand=kantel ssh-proxy --url "+tunnelURL+"' -o HostKeyAlias=sbx_4kq9x2mt -o UserKnownHostsFile=/k/known_hosts -o StrictHostKeyChecking=accept-new user@sbx_4kq9x2mt")
}

func TestProxyURLOf(t *testing.T) {
	got, err := proxyURLOf(tunnelURL, true, nil)
	eq(t, "flag", got, tunnelURL)
	eq(t, "flag err", err, nil)
	got, _ = proxyURLOf("", false, map[string]string{SSHURLEnv: tunnelURL})
	eq(t, "env", got, tunnelURL)
	if _, err := proxyURLOf("", false, nil); err == nil || !strings.Contains(err.Error(), "needs --url") {
		t.Errorf("no URL: %v", err)
	}
	if _, err := proxyURLOf("https://kantel.test/x", true, nil); err == nil || !strings.Contains(err.Error(), "ws:// or wss://") {
		t.Errorf("not a WebSocket URL: %v", err)
	}
}

// relay is a fake relay: serve runs with each connection it accepts.
func relay(t *testing.T, serve func(ctx context.Context, conn *websocket.Conn)) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		serve(r.Context(), conn)
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http")
}

type safeBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *safeBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *safeBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func tunnelContext(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestPipeTunnelBothWaysUntilTheSandboxCloses(t *testing.T) {
	got := make(chan string, 1)
	url := relay(t, func(ctx context.Context, conn *websocket.Conn) {
		typ, data, err := conn.Read(ctx)
		if err != nil || typ != websocket.MessageBinary {
			got <- "not binary"
			return
		}
		got <- string(data)
		_ = conn.Write(ctx, websocket.MessageBinary, []byte("SSH-2.0-OpenSSH_9.6 sandbox\r\n"))
		_ = conn.Close(websocket.StatusNormalClosure, "")
	})
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	go func() { _, _ = stdinW.Write([]byte("SSH-2.0-OpenSSH_9.9\r\n")) }()
	var stdout, stderr safeBuffer
	code := pipeTunnel(tunnelContext(t), url, stdinR, &stdout, &stderr)
	eq(t, "exit", code, 0)
	eq(t, "sent", <-got, "SSH-2.0-OpenSSH_9.9\r\n")
	eq(t, "received", stdout.String(), "SSH-2.0-OpenSSH_9.6 sandbox\r\n")
	eq(t, "stderr", stderr.String(), "")
}

func TestPipeTunnelClosesWhenSSHClosesItsSide(t *testing.T) {
	closed := make(chan websocket.CloseError, 1)
	url := relay(t, func(ctx context.Context, conn *websocket.Conn) {
		_, _, err := conn.Read(ctx)
		var ce websocket.CloseError
		if errors.As(err, &ce) {
			closed <- ce
		}
		close(closed)
	})
	var stdout, stderr safeBuffer
	code := pipeTunnel(tunnelContext(t), url, strings.NewReader(""), &stdout, &stderr)
	eq(t, "exit", code, 0)
	ce := <-closed
	eq(t, "code", ce.Code, websocket.StatusNormalClosure)
	eq(t, "reason", ce.Reason, "ssh closed its side")
}

func TestPipeTunnelFailsAsSSHDoesWhenRefusedOrDropped(t *testing.T) {
	// The gateway refuses an expired or forged URL by closing with its reason.
	refused := relay(t, func(ctx context.Context, conn *websocket.Conn) {
		_ = conn.Close(4003, "The tunnel URL is wrong or has expired")
	})
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	var stdout, stderr safeBuffer
	eq(t, "refused exit", pipeTunnel(tunnelContext(t), refused, stdinR, &stdout, &stderr), 255)
	contains(t, "refused", stderr.String(), "The tunnel URL is wrong or has expired")

	// Nothing there to open.
	server := httptest.NewServer(http.NotFoundHandler())
	stderr = safeBuffer{}
	eq(t, "unopened exit", pipeTunnel(tunnelContext(t), "ws"+strings.TrimPrefix(server.URL, "http"), stdinR, &stdout, &stderr), 255)
	contains(t, "unopened", stderr.String(), "kantel ssh-proxy: couldn't open the tunnel")
	server.Close()

	// The host goes away mid-session.
	dropped := relay(t, func(ctx context.Context, conn *websocket.Conn) {
		_ = conn.Close(websocket.StatusInternalError, "The sandbox's host went away")
	})
	stderr = safeBuffer{}
	eq(t, "dropped exit", pipeTunnel(tunnelContext(t), dropped, stdinR, &stdout, &stderr), 255)
	contains(t, "dropped", stderr.String(), "the tunnel closed: The sandbox's host went away. A command that must outlive")
}

// The commands.

var sshAnswer = map[string]any{
	"host": "kantel.test", "port": 443, "user": "user",
	"command":            "ssh -o ProxyCommand='websocat --binary " + tunnelURL + "' user@sbx_4kq9x2mt",
	"proxyUrl":           tunnelURL,
	"privateKey":         "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
	"hostKeyFingerprint": "SHA256:hostkey",
	"expiresAt":          time.Now().Add(10 * time.Minute).UnixMilli(),
}

var sshRoutes = routes{"POST /v1/sandboxes/sbx_4kq9x2mt/ssh": func(call) any { return sshAnswer }}

// withFakeSSH runs kantel with an ssh on PATH that writes its arguments, one a line, and its relay URL, and exits 7.
func withFakeSSH(t *testing.T, argv ...string) (result, []string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "ssh.log")
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '" + log + "'\necho \"url=$" + SSHURLEnv + "\" >> '" + log + "'\nexit 7\n"
	if err := os.WriteFile(filepath.Join(dir, "ssh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	config := t.TempDir()
	r := run(t, argv, opts{routes: sshRoutes, configDir: config})
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatalf("ssh didn't run: %v (%s)", err, r.Stderr)
	}
	return r, strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
}

func TestSSHConnectsThroughTheRelayAndExitsWithSSHsCode(t *testing.T) {
	r, args := withFakeSSH(t, "ssh", "sbx_4kq9x2mt")
	eq(t, "exit", r.Code, 7)
	contains(t, "args", strings.Join(args, "\n"), "\nHostKeyAlias=sbx_4kq9x2mt\n")
	eq(t, "destination", args[len(args)-2], "user@sbx_4kq9x2mt")
	// The URL goes to ssh-proxy in the environment, not in ssh's arguments.
	eq(t, "env", args[len(args)-1], "url="+tunnelURL)
	if strings.Contains(strings.Join(args[:len(args)-1], " "), tunnelURL) {
		t.Error("the URL is in ssh's arguments")
	}
	// The key pair Kantel made is kept for ssh, readable by its owner only.
	key := args[1]
	info, err := os.Stat(key)
	if err != nil {
		t.Fatal(err)
	}
	eq(t, "key mode", info.Mode().Perm(), os.FileMode(0o600))
	eq(t, "key name", filepath.Base(key), "sbx_4kq9x2mt")
	eq(t, "key dir", filepath.Base(filepath.Dir(key)), "ssh")
}

func TestSSHRunsACommandQuotedAsExecQuotesIt(t *testing.T) {
	r, args := withFakeSSH(t, "ssh", "sbx_4kq9x2mt", "--", "ls", "-la", "my dir")
	eq(t, "exit", r.Code, 7)
	if got := args[len(args)-4 : len(args)-1]; !reflect.DeepEqual(got, []string{"user@sbx_4kq9x2mt", "--", "ls -la 'my dir'"}) {
		t.Errorf("args: %q", got)
	}
	_, args = withFakeSSH(t, "ssh", "sbx_4kq9x2mt", "--", "make && make test")
	eq(t, "one line", args[len(args)-2], "make && make test")
}

func TestSSHWantsItsCommandAfterDashesAndPrintTakesNone(t *testing.T) {
	r := run(t, []string{"ssh", "sbx_4kq9x2mt", "uname"}, opts{routes: sshRoutes})
	eq(t, "extra exit", r.Code, 2)
	contains(t, "extra", r.Stderr, "after --")
	r = run(t, []string{"ssh", "sbx_4kq9x2mt", "--print", "--", "uname"}, opts{routes: sshRoutes})
	eq(t, "both exit", r.Code, 2)
	contains(t, "both", r.Stderr, "--print")
	eq(t, "calls", len(r.Calls), 0)
}

func TestSSHPrintThroughTheRelay(t *testing.T) {
	config := t.TempDir()
	r := run(t, []string{"ssh", "sbx_4kq9x2mt", "--print"}, opts{routes: sshRoutes, configDir: config})
	eq(t, "exit", r.Code, 0)
	contains(t, "proxy", r.Stdout, "ProxyCommand=kantel ssh-proxy --url "+tunnelURL)
	contains(t, "key", r.Stdout, "-i "+filepath.Join(config, "ssh", "sbx_4kq9x2mt"))
	contains(t, "known hosts", r.Stdout, "UserKnownHostsFile="+filepath.Join(config, "ssh", "known_hosts"))
	contains(t, "user", r.Stdout, "user@sbx_4kq9x2mt")
	contains(t, "until", r.Stdout, "once connected it stays open)")
	if strings.Contains(r.Stdout, "PRIVATE KEY") {
		t.Error("the private key is in the output")
	}
	// --json prints it too, the key's file but not the key.
	r = run(t, []string{"ssh", "sbx_4kq9x2mt", "--json"}, opts{routes: sshRoutes, configDir: config})
	contains(t, "json", r.Stdout, `"identityFile": "`+filepath.Join(config, "ssh", "sbx_4kq9x2mt")+`"`)
	if strings.Contains(r.Stdout, "PRIVATE KEY") {
		t.Error("the private key is in the JSON")
	}
}

func TestSSHPrintThroughAGatewayWithAKeyOfYourOwn(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "id.pub"), []byte("ssh-ed25519 AAAA me\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := run(t, []string{"ssh", "sbx_4kq9x2mt", "--print", "--public-key", "id.pub", "--ttl", "30"}, opts{configDir: dir, routes: routes{
		"POST /v1/sandboxes/sbx_4kq9x2mt/ssh": func(call) any {
			return map[string]any{"host": "ssh.kantel.test", "port": 2222, "user": "sbx_4kq9x2mt",
				"command": "ssh -p 2222 sbx_4kq9x2mt@ssh.kantel.test", "expiresAt": 1}
		},
	}})
	eq(t, "exit", r.Code, 0)
	eq(t, "body", string(r.Calls[0].Raw), `{"publicKey":"ssh-ed25519 AAAA me","ttlMinutes":30}`)
	contains(t, "out", r.Stdout, "ssh -p 2222 sbx_4kq9x2mt@ssh.kantel.test\n(it works until 1970-01-01 00:00 UTC)")
}

func TestSSHProxyWithoutAURLIsAUsageError(t *testing.T) {
	r := run(t, []string{"ssh-proxy"}, opts{})
	eq(t, "exit", r.Code, 2)
	contains(t, "stderr", r.Stderr, "needs --url")
}
