package microvm

import (
	"slices"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
)

// Every boot tells the guest this host forwards its browser-surface report, through the initramfs or not, so Kantel's
// image runs Chromium on a display of its own only on a host that would pass the surface on.
func TestBootTellsTheGuestItsBrowserSurfaceIsForwarded(t *testing.T) {
	sh := shape{HotplugMiB: 1024}
	for _, m := range []*Manager{{}, {cfg: Config{Initrd: "/var/lib/kantel-host/initramfs.cpio"}}} {
		for _, s := range []shape{{}, sh} {
			args := m.bootConfig(s, "vmlinux", "", "", 3).BootArgs
			if !slices.Contains(strings.Fields(args), guest.BrowserSurfaceBootArg) {
				t.Errorf("initrd %q, hotplug %d: %q", m.cfg.Initrd, s.HotplugMiB, args)
			}
		}
	}
	// A template from before it was booted without it, so it is made again.
	if fp := (&Manager{}).templateFingerprint(shape{}); !strings.Contains(fp, " boot="+guest.BrowserSurfaceBootArg) {
		t.Errorf("fingerprint %q", fp)
	}
}

// Every boot turns on the guest kernel's pressure figures (off by default in Firecracker's guest config), which its
// agent reads for the sandbox's IO pressure; a template booted without them is made again.
func TestBootTurnsOnTheGuestsPressureFigures(t *testing.T) {
	for _, m := range []*Manager{{}, {cfg: Config{Initrd: "/var/lib/kantel-host/initramfs.cpio"}}} {
		for _, s := range []shape{{}, {HotplugMiB: 1024}} {
			if args := m.bootConfig(s, "vmlinux", "", "", 3).BootArgs; !slices.Contains(strings.Fields(args), "psi=1") {
				t.Errorf("initrd %q, hotplug %d: %q", m.cfg.Initrd, s.HotplugMiB, args)
			}
		}
	}
	if fp := (&Manager{}).templateFingerprint(shape{}); !strings.Contains(fp, "psi=1") {
		t.Errorf("fingerprint %q", fp)
	}
}
