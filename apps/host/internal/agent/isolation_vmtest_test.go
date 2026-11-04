//go:build vmtest

// Real-VM isolation tests: two Firecracker sandboxes on this machine, and an "outside" network namespace standing
// in for the LAN and the internet, with a route to the sandbox subnet through the host. They show that no way in or
// out exists but the egress proxy (out) and the host's vsock relay (in), whatever the egress mode.
//
// They need root, /dev/kvm, Firecracker and the guest images, so they run only with the vmtest tag:
//
//	KANTEL_VMTEST_IMAGES=/images KANTEL_VMTEST_FIRECRACKER=/opt/kantel/firecracker \
//	  go test -tags vmtest -run Isolation -v ./internal/agent/
//
// KANTEL_VMTEST_IMAGES holds vmlinux-x86_64 and sandbox-amd64.ext4. Run them in a privileged container of their own
// (apps/host/test/isolation.sh does), not on a machine's own network namespace: they add iptables rules, a network
// namespace and a veth pair.
package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

const (
	lanNS     = "kt-vmtest-lan"
	lanHost   = "192.168.77.1"
	lanPeer   = "192.168.77.2"
	appPort   = 8080
	hostPort  = 18080
	proxyPort = 3129
)

func sh(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s: %v: %s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

// lan makes the outside network: a namespace on a veth pair with the host, routing the sandbox subnet via the host,
// with a web server of its own.
func lan(t *testing.T) {
	_ = exec.Command("ip", "netns", "del", lanNS).Run()
	_ = exec.Command("ip", "link", "del", "vmtest-lan0").Run()
	sh(t, "ip", "netns", "add", lanNS)
	sh(t, "ip", "link", "add", "vmtest-lan0", "type", "veth", "peer", "name", "vmtest-lan1")
	sh(t, "ip", "link", "set", "vmtest-lan1", "netns", lanNS)
	sh(t, "ip", "addr", "add", lanHost+"/24", "dev", "vmtest-lan0")
	sh(t, "ip", "link", "set", "vmtest-lan0", "up")
	in := func(args ...string) { sh(t, append([]string{"ip", "netns", "exec", lanNS}, args...)...) }
	in("ip", "addr", "add", lanPeer+"/24", "dev", "vmtest-lan1")
	in("ip", "link", "set", "vmtest-lan1", "up")
	in("ip", "link", "set", "lo", "up")
	in("ip", "route", "add", "10.231.0.0/16", "via", lanHost)
	server := exec.Command("ip", "netns", "exec", lanNS, "python3", "-m", "http.server", fmt.Sprint(appPort), "--bind", lanPeer)
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = server.Process.Kill()
		_ = exec.Command("ip", "netns", "del", lanNS).Run()
		_ = exec.Command("ip", "link", "del", "vmtest-lan0").Run()
	})
	// Routing on, so what stops the outside reaching a sandbox is the firewall, not a switched-off forward.
	if err := os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// vmCall is a call that must succeed, answering its result (lifecycle_test.go's call answers only the error).
func vmCall[T any](t *testing.T, h *Host, method string, params any) T {
	t.Helper()
	raw, _ := json.Marshal(params)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	out, err := h.Call(ctx, method, raw, nil)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	b, _ := json.Marshal(out)
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func run(t *testing.T, h *Host, sandbox, command string) proto.ExecResult {
	t.Helper()
	return vmCall[proto.ExecResult](t, h, proto.MethodExec, proto.ExecParams{SandboxID: sandbox, Command: command, User: "root", TimeoutMs: 30_000})
}

// probe is one attempt that must fail (or, for a control, succeed), with what it printed.
type probe struct {
	name, from, command string
	want                bool
}

func TestIsolation(t *testing.T) {
	images := os.Getenv("KANTEL_VMTEST_IMAGES")
	firecracker := os.Getenv("KANTEL_VMTEST_FIRECRACKER")
	if images == "" || firecracker == "" || os.Geteuid() != 0 {
		t.Skip("needs root, KANTEL_VMTEST_IMAGES and KANTEL_VMTEST_FIRECRACKER")
	}
	lan(t)
	// A service of the host's own, on every address, that no sandbox may reach.
	hostService, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", hostPort))
	if err != nil {
		t.Fatal(err)
	}
	defer hostService.Close()
	go http.Serve(hostService, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "host secret") }))

	root := t.TempDir()
	cfg := Config{
		Root: root, Kernel: filepath.Join(images, "vmlinux-x86_64"), SandboxImage: filepath.Join(images, "sandbox-amd64.ext4"),
		Firecracker: firecracker, Tiers: []string{"microvm"}, Egress: "open",
	}
	cfg.Defaults()
	h, err := New(cfg, "vmtest", slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	if err != nil {
		t.Fatal(err)
	}
	// Registered first, so it runs after the sandboxes' deletes.
	t.Cleanup(h.Close)

	// A and B are "open" (the proxy with no rules); C is "none".
	sandboxes := map[string]proto.SandboxInfo{}
	for id, mode := range map[string]string{"sbx_vm_a": "open", "sbx_vm_b": "open", "sbx_vm_c": "none"} {
		info := vmCall[proto.SandboxInfo](t, h, proto.MethodCreate, proto.CreateParams{SandboxID: id, Tier: "microvm", Egress: &proto.Egress{Mode: mode}})
		sandboxes[id] = info
		t.Cleanup(func() {
			_, _ = h.Call(context.Background(), proto.MethodDelete, json.RawMessage(fmt.Sprintf(`{"sandboxId":%q}`, id)), nil)
		})
	}
	for id, info := range sandboxes {
		if _, err := netip.ParseAddr(info.Address); err != nil {
			t.Fatalf("%s has no address: %+v", id, info)
		}
	}
	addr := func(id string) netip.Addr { return netip.MustParseAddr(sandboxes[id].Address) }
	a, b := addr("sbx_vm_a"), addr("sbx_vm_b")
	gwA := a.Prev()
	gwB := b.Prev()
	t.Logf("A %s (gateway %s), B %s, C %s", a, gwA, b, addr("sbx_vm_c"))

	// A server in B on every address, so only the network stands between it and the others.
	run(t, h, "sbx_vm_b", fmt.Sprintf("nohup python3 -m http.server %d --bind 0.0.0.0 >/tmp/http.log 2>&1 &", appPort))
	time.Sleep(2 * time.Second)

	hostAddrs := []string{gwA.String()}
	for _, ip := range strings.Fields(sh(t, "hostname", "-I")) {
		if ap, err := netip.ParseAddr(ip); err == nil && ap.Is4() && !strings.HasPrefix(ip, "10.231.") {
			hostAddrs = append(hostAddrs, ip)
		}
	}
	direct := func(target string) string {
		return fmt.Sprintf("curl -sS --noproxy '*' -m 4 -o /dev/null -w '%%{http_code}' %s", target)
	}
	// Through the proxy: prints proxy:<status>, and succeeds only on a 200. A refusal must be the proxy's 403, not a
	// failure of some other kind. --noproxy '': the sandbox's NO_PROXY would send 127.0.0.1 to its own loopback.
	viaProxy := func(gw netip.Addr, target string) string {
		return fmt.Sprintf("code=$(curl -sS -m 8 -o /dev/null -w '%%{http_code}' --noproxy '' -x http://%s:%d %s); echo \"proxy:$code\"; [ \"$code\" = 200 ]", gw, proxyPort, target)
	}
	probes := []probe{
		// Controls: the proxy works, and B's server answers on B itself.
		{"control: A reaches the internet through the proxy", "sbx_vm_a", viaProxy(gwA, "https://example.com/"), true},
		{"control: B's server answers inside B", "sbx_vm_b", direct(fmt.Sprintf("http://127.0.0.1:%d/", appPort)), true},

		{"sandbox to sandbox: A to B directly", "sbx_vm_a", direct(fmt.Sprintf("http://%s:%d/", b, appPort)), false},
		{"sandbox to sandbox: A to B through the proxy", "sbx_vm_a", viaProxy(gwA, fmt.Sprintf("http://%s:%d/", b, appPort)), false},
		{"sandbox to sandbox: A to B's gateway (another sandbox's link)", "sbx_vm_a", fmt.Sprintf("curl -sS -m 4 -x http://%s:%d http://example.com/ -o /dev/null", gwB, proxyPort), false},
		{"sandbox to sandbox: ping B", "sbx_vm_a", fmt.Sprintf("ping -c 2 -W 2 %s", b), false},
		{"sandbox to LAN: A to the LAN's server directly", "sbx_vm_a", direct(fmt.Sprintf("http://%s:%d/", lanPeer, appPort)), false},
		{"sandbox to LAN: A to the LAN's server through the proxy", "sbx_vm_a", viaProxy(gwA, fmt.Sprintf("http://%s:%d/", lanPeer, appPort)), false},
		{"sandbox to LAN: cloud metadata through the proxy", "sbx_vm_a", viaProxy(gwA, "http://169.254.169.254/"), false},
		{"sandbox to internet: A to 1.1.1.1 directly (TCP)", "sbx_vm_a", direct("https://1.1.1.1/"), false},
		{"sandbox to internet: A to 1.1.1.1 directly (ICMP)", "sbx_vm_a", "ping -c 2 -W 2 1.1.1.1", false},
		{"sandbox to internet: A asks 1.1.1.1 for DNS directly (UDP)", "sbx_vm_a", `python3 -c "
import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
s.sendto(bytes.fromhex('abcd01000001000000000000076578616d706c6503636f6d0000010001'), ('1.1.1.1', 53)); s.recv(512)"`, false},
		{"sandbox spoofing: A passes as B to the proxy", "sbx_vm_a", fmt.Sprintf("ip addr add %s/32 dev eth0 && curl -sS -m 4 --interface %s -x http://%s:%d http://example.com/ -o /dev/null; r=$?; ip addr del %s/32 dev eth0; exit $r", b, b, gwA, proxyPort, b), false},
		{"none: C can't reach the proxy", "sbx_vm_c", fmt.Sprintf("curl -sS -m 4 -x http://%s:%d http://example.com/ -o /dev/null", addr("sbx_vm_c").Prev(), proxyPort), false},
	}
	for _, ip := range hostAddrs {
		probes = append(probes,
			probe{"sandbox to host: A to the host's service on " + ip + " directly", "sbx_vm_a", direct(fmt.Sprintf("http://%s:%d/", ip, hostPort)), false},
			probe{"sandbox to host: A to the host's service on " + ip + " through the proxy", "sbx_vm_a", viaProxy(gwA, fmt.Sprintf("http://%s:%d/", ip, hostPort)), false},
			probe{"sandbox to host: A to the host's SSH port on " + ip, "sbx_vm_a", fmt.Sprintf("timeout 4 bash -c '</dev/tcp/%s/22'", ip), false},
		)
	}
	probes = append(probes, probe{"sandbox to host: the host's loopback through the proxy", "sbx_vm_a", viaProxy(gwA, fmt.Sprintf("http://127.0.0.1:%d/", hostPort)), false})

	for _, p := range probes {
		res := run(t, h, p.from, p.command)
		ok := res.ExitCode == 0
		status := "refused"
		if ok {
			status = "reached"
		}
		t.Logf("%-70s %s (exit %d) %s", p.name, status, res.ExitCode, strings.TrimSpace(res.Stdout+" "+res.Stderr))
		if ok != p.want {
			t.Errorf("%s: exit %d, want success=%v: %s %s", p.name, res.ExitCode, p.want, res.Stdout, res.Stderr)
		}
		if res.ExitCode == 126 || res.ExitCode == 127 {
			t.Errorf("%s: the probe itself didn't run: %s", p.name, res.Stderr)
		}
		if out := strings.TrimSpace(res.Stdout); !p.want && strings.HasPrefix(out, "proxy:") && out != "proxy:403" {
			t.Errorf("%s: %s, want the proxy's 403", p.name, out)
		}
	}

	// The outside: the LAN (and so the internet) has a route to the sandbox subnet through the host, and still can't
	// reach a sandbox's port or use the host's proxy.
	outside := []probe{
		{"internet to sandbox: B's server from outside", "", fmt.Sprintf("curl -sS -m 4 -o /dev/null http://%s:%d/", b, appPort), false},
		{"internet to sandbox: B's SSH from outside", "", fmt.Sprintf("timeout 4 bash -c '</dev/tcp/%s/22'", b), false},
		{"internet to sandbox: ping B from outside", "", fmt.Sprintf("ping -c 2 -W 2 %s", b), false},
		{"internet to host: the egress proxy from outside", "", fmt.Sprintf("curl -fsS -m 4 -o /dev/null -x http://%s:%d http://example.com/", lanHost, proxyPort), false},
		{"control: the host's own service from outside", "", fmt.Sprintf("curl -sS -m 4 -o /dev/null http://%s:%d/", lanHost, hostPort), true},
	}
	for _, p := range outside {
		cmd := exec.Command("ip", "netns", "exec", lanNS, "bash", "-c", p.command)
		out, err := cmd.CombinedOutput()
		ok := err == nil
		status := "refused"
		if ok {
			status = "reached"
		}
		t.Logf("%-70s %s %s", p.name, status, strings.TrimSpace(string(out)))
		if code := cmd.ProcessState.ExitCode(); code == 126 || code == 127 {
			t.Errorf("%s: the probe itself didn't run: %s", p.name, out)
		}
		if ok != p.want {
			t.Errorf("%s: success=%v, want %v: %s", p.name, ok, p.want, out)
		}
	}

	// The one way in: the host's relay over vsock, which Kantel's tunnels use.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := h.DialPort(ctx, "sbx_vm_b", appPort)
	if err != nil {
		t.Fatalf("relay: %v", err)
	}
	defer conn.Close()
	fmt.Fprint(conn, "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("relay: %v %v", res, err)
	}
	t.Logf("%-70s reached (HTTP %d)", "control: the host's vsock relay to B's server", res.StatusCode)

	// No IPv6 on a sandbox's device.
	for id := range sandboxes {
		slot := h.net.SlotOf(addr(id))
		tap := fmt.Sprintf("kt%d", slot)
		raw, err := os.ReadFile("/proc/sys/net/ipv6/conf/" + tap + "/disable_ipv6")
		if err == nil && strings.TrimSpace(string(raw)) != "1" {
			t.Errorf("%s: IPv6 is on", tap)
		}
		if out := sh(t, "ip", "-6", "addr", "show", "dev", tap); strings.Contains(out, "inet6") {
			t.Errorf("%s has an IPv6 address: %s", tap, out)
		}
	}
}
