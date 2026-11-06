package guestinit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The injected agent's unit lasts one boot: it goes in systemd's runtime units, never the image's /etc on the
// sandbox's disk, where a boot without the initramfs would find a unit for a binary it doesn't have.
func TestWriteUnitIsRuntimeOnly(t *testing.T) {
	t.Run("own unit", func(t *testing.T) {
		root := t.TempDir()
		if err := WriteUnit(root); err != nil {
			t.Fatal(err)
		}
		unitFile := filepath.Join(root, "run/systemd/system", unitName)
		raw, err := os.ReadFile(unitFile)
		if err != nil || !strings.Contains(string(raw), agentPath) {
			t.Fatalf("unit %q: %v", raw, err)
		}
		// A command killed for memory mustn't stop the agent's unit, and with it every other command.
		if !strings.Contains(string(raw), "\nOOMPolicy=continue\n") {
			t.Errorf("unit without OOMPolicy=continue: %q", raw)
		}
		link, err := os.Readlink(filepath.Join(root, "run/systemd/system/sysinit.target.wants", unitName))
		if err != nil || link != "/run/systemd/system/"+unitName {
			t.Errorf("wants link %q: %v", link, err)
		}
		if _, err := os.Stat(filepath.Join(root, "etc/systemd")); !os.IsNotExist(err) {
			t.Errorf("wrote to the image's /etc: %v", err)
		}
	})
	t.Run("drop-in over the image's unit", func(t *testing.T) {
		root := t.TempDir()
		own := filepath.Join(root, "lib/systemd/system", unitName)
		if err := os.MkdirAll(filepath.Dir(own), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(own, []byte("[Service]\nExecStart=/usr/local/bin/kantel-guest serve\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := WriteUnit(root); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(filepath.Join(root, "run/systemd/system", unitName+".d", "50-kantel-injected.conf"))
		if err != nil || !strings.Contains(string(raw), "ExecStart=\nExecStart="+agentPath) {
			t.Fatalf("drop-in %q: %v", raw, err)
		}
		if !strings.Contains(string(raw), "\nOOMPolicy=continue\n") {
			t.Errorf("drop-in without OOMPolicy=continue: %q", raw)
		}
		if _, err := os.Stat(filepath.Join(root, "run/systemd/system", unitName)); !os.IsNotExist(err) {
			t.Errorf("a second unit beside the image's: %v", err)
		}
		if _, err := os.Stat(filepath.Join(root, "etc/systemd")); !os.IsNotExist(err) {
			t.Errorf("wrote to the image's /etc: %v", err)
		}
	})
}
