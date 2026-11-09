package microvm

import (
	"net/netip"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
)

// systemd services and PAM sessions get the same proxy and CA variables as a command does (lleverage-ai/kantel#730),
// from the image: /etc/systemd/system.conf.d/kantel-proxy.conf and /etc/environment. Each names every variable the
// host gives a sandbox, with its proxy at the guest agent's forwarder (which follows the sandbox's own through forks
// and restores, so the image's copy never goes stale) and every other value as the host sets it.
func TestImageSystemEnvironmentMatchesTheProxyEnvironment(t *testing.T) {
	m := &Manager{cfg: Config{ProxyPort: 3129}}
	s := &sandbox{meta: meta{ID: "sbx_1"}, link: &network.Link{HostIP: netip.MustParseAddr("10.231.0.9"), GuestIP: netip.MustParseAddr("10.231.0.10")}}
	want := map[string]string{}
	for k, v := range m.identity(s, false).ProxyEnv {
		if k == "HTTP_PROXY" || k == "HTTPS_PROXY" || k == "http_proxy" || k == "https_proxy" {
			v = "http://" + guest.LocalProxyAddr
		}
		want[k] = v
	}
	if len(want) == 0 {
		t.Fatal("no proxy environment")
	}

	raw, err := os.ReadFile("../../guest/rootfs/etc/systemd/system.conf.d/kantel-proxy.conf")
	if err != nil {
		t.Fatal(err)
	}
	systemd := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		rest, ok := strings.CutPrefix(line, "DefaultEnvironment=")
		if !ok {
			continue
		}
		for _, quoted := range regexp.MustCompile(`"[^"]*"`).FindAllString(rest, -1) {
			k, v, _ := strings.Cut(strings.Trim(quoted, `"`), "=")
			systemd[k] = v
		}
	}
	compareEnv(t, "systemd's DefaultEnvironment", systemd, want)

	raw, err = os.ReadFile("../../guest/rootfs/etc/environment")
	if err != nil {
		t.Fatal(err)
	}
	pam := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, _ := strings.Cut(line, "=")
		pam[k] = v
	}
	// Ubuntu's own line, which the image's file replaces.
	if !strings.HasPrefix(pam["PATH"], `"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`) {
		t.Errorf("/etc/environment lost Ubuntu's PATH: %q", pam["PATH"])
	}
	delete(pam, "PATH")
	compareEnv(t, "/etc/environment", pam, want)
}

func compareEnv(t *testing.T, where string, got, want map[string]string) {
	t.Helper()
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %s=%q, want %q", where, k, got[k], v)
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			t.Errorf("%s: %s isn't in the host's proxy environment", where, k)
		}
	}
}
