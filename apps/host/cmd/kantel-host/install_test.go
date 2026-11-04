package main

import "testing"

// Rerunning install keeps an operator's own sandbox image and guest agent (a custom image), and puts back only the
// installer's own paths.
func TestInstallKeepsACustomImage(t *testing.T) {
	for _, c := range []struct{ root, configured, name, want string }{
		{"/var/lib/kantel-host", "/srv/images/debian.sqfs", "sandbox.ext4", "/srv/images/debian.sqfs"},
		{"/var/lib/kantel-host", "/var/lib/kantel-host/images/sandbox.ext4", "sandbox.ext4", ""},
		{"", "/var/lib/kantel-host/images/kantel-guest", "kantel-guest", ""},
		{"/opt/kh", "/opt/kh/images//sandbox.ext4", "sandbox.ext4", ""},
		{"/opt/kh", "/var/lib/kantel-host/images/sandbox.ext4", "sandbox.ext4", "/var/lib/kantel-host/images/sandbox.ext4"},
		{"/opt/kh", "/srv/kantel-guest", "kantel-guest", "/srv/kantel-guest"},
		{"/opt/kh", "", "kantel-guest", ""},
	} {
		if got := custom(c.root, c.configured, c.name); got != c.want {
			t.Errorf("custom(%q, %q, %q) = %q, want %q", c.root, c.configured, c.name, got, c.want)
		}
	}
}
