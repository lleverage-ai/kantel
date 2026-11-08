package microvm

import (
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/network"
)

// sudo keeps every variable the host gives a sandbox for its egress proxy (lleverage-ai/kantel#731): the image's
// sudoers drop-in names each one, so `sudo npm i -g pnpm` reaches the network as `npm i` does. A variable added to
// ProxyEnv without it would be dropped under sudo again.
func TestSudoKeepsTheProxyEnvironment(t *testing.T) {
	path := "../../guest/rootfs/etc/sudoers.d/kantel-proxy"
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// sudo skips a file in sudoers.d whose name has a "." or ends in "~".
	if name := filepath.Base(path); strings.ContainsAny(name, ".") || strings.HasSuffix(name, "~") {
		t.Fatalf("sudo ignores %s", name)
	}
	kept := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		rest, ok := strings.CutPrefix(line, "Defaults env_keep += ")
		if !ok {
			continue
		}
		for _, name := range strings.Fields(strings.Trim(rest, `"`)) {
			kept[name] = true
		}
	}
	m := &Manager{cfg: Config{ProxyPort: 3129}}
	s := &sandbox{meta: meta{ID: "sbx_1"}, link: &network.Link{HostIP: netip.MustParseAddr("10.231.0.9"), GuestIP: netip.MustParseAddr("10.231.0.10")}}
	env := m.identity(s, false).ProxyEnv
	if len(env) == 0 {
		t.Fatal("no proxy environment")
	}
	for name := range env {
		if !kept[name] {
			t.Errorf("sudo drops %s: add it to %s", name, path)
		}
	}
}
