package guest

import "testing"

// TestCheckMountPath: a bundle's and a bucket's mount paths are checked the same.
func TestCheckMountPath(t *testing.T) {
	for _, p := range []string{"/workspace/skills", "/mnt/bundle", "/home/user/files", "/opt/x", "/usr2"} {
		if err := CheckMountPath(p); err != nil {
			t.Errorf("%s: %v", p, err)
		}
	}
	for _, p := range []string{"", "/", "relative", "/a/../b", "/a/", "/a//b", "/etc", "/etc/x", "/usr/local/x", "/proc", "/run/kantel", "/var/lib/docker/x", "/a\nb"} {
		if err := CheckMountPath(p); err == nil {
			t.Errorf("%q is refused", p)
		}
	}
}

func TestBundleDevice(t *testing.T) {
	if BundleDevice(0) != "/dev/vdc" || BundleDevice(7) != "/dev/vdj" {
		t.Fatalf("drive 0 is vdc, after vda and vdb: %s %s", BundleDevice(0), BundleDevice(7))
	}
}

func TestUnescapeMountinfo(t *testing.T) {
	if got := unescapeMountinfo(`/a\040b\011c`); got != "/a b\tc" {
		t.Fatalf("got %q", got)
	}
	if got := unescapeMountinfo(`/plain`); got != "/plain" {
		t.Fatalf("got %q", got)
	}
	if got := unescapeMountinfo(`/trailing\04`); got != `/trailing\04` {
		t.Fatalf("got %q", got)
	}
}
