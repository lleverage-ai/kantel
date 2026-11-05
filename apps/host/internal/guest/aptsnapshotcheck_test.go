package guest

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// snapshotCheck runs guest/rootfs/usr/local/sbin/kantel-apt-snapshot-check under root with a stand-in for apt-helper
// that records its arguments and exits with exit (and, on success, writes the file it was asked for). It answers the
// check's output, its error, and the arguments apt-helper got ("" when it wasn't run).
func snapshotCheck(t *testing.T, root string, exit int, say string) (out string, err error, helperArgs string) {
	t.Helper()
	bash, lookErr := exec.LookPath("bash")
	if lookErr != nil {
		t.Skip("no bash")
	}
	script := "../../guest/rootfs/usr/local/sbin/kantel-apt-snapshot-check"
	if _, err := os.ReadFile(script); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	args := filepath.Join(bin, "args")
	helper := filepath.Join(bin, "apt-helper")
	fake := "#!/bin/bash\nprintf '%s\\n' \"$@\" > " + args + "\n"
	if say != "" {
		fake += "cat <<'EOF'\n" + say + "\nEOF\n"
	}
	if exit == 0 {
		fake += "for last; do :; done; echo signed > \"$last\"\n"
	}
	fake += "exit " + strconv.Itoa(exit) + "\n"
	if err := os.WriteFile(helper, []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bash, script)
	cmd.Env = append(os.Environ(), "KANTEL_APT_ROOT="+root, "KANTEL_APT_HELPER="+helper)
	raw, err := cmd.CombinedOutput()
	got, _ := os.ReadFile(args)
	return string(raw), err, string(got)
}

const snapshotDownPin = "etc/apt/preferences.d/kantel-snapshot-down"

// While the snapshot doesn't answer, the check pins it down under the live archive (priority 1, below the live
// archive's 100), so apt stops choosing the snapshot's versions from indexes an earlier update left behind
// (lleverage-ai/kantel#706); once it answers again, the pin goes. The same on amd64 and arm64, whose sources name the
// same snapshot URL. It asks for the snapshot's InRelease once, with apt's own settings (and so the egress proxy).
func TestAptSnapshotCheckPinsTheSnapshotDownWhileItDoesntAnswer(t *testing.T) {
	for _, arch := range []string{"amd64", "arm64"} {
		t.Run(arch, func(t *testing.T) {
			root := t.TempDir()
			if out, err := runAptSources(t, root, arch); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			pin := filepath.Join(root, snapshotDownPin)

			// What apt-helper says to a 503 through the egress proxy.
			out, err, args := snapshotCheck(t, root, 100,
				"Err:1 https://snapshot.ubuntu.com/ubuntu/20261103T000000Z/dists/resolute/InRelease\n"+
					"  503  Service Unavailable [IP: 10.231.0.9 3129]\n"+
					"E: Failed to fetch https://snapshot.ubuntu.com/ubuntu/20261103T000000Z/dists/resolute/InRelease  503  Service Unavailable [IP: 10.231.0.9 3129]\n"+
					"E: Download Failed")
			if err != nil {
				t.Fatalf("down: %v: %s", err, out)
			}
			lines := strings.Split(strings.TrimSpace(args), "\n")
			if len(lines) < 3 || lines[len(lines)-3] != "download-file" ||
				lines[len(lines)-2] != "https://snapshot.ubuntu.com/ubuntu/20261103T000000Z/dists/resolute/InRelease" {
				t.Errorf("apt-helper got:\n%s", args)
			}
			for _, opt := range []string{"Acquire::Retries=0", "Acquire::https::Timeout=15"} {
				if !strings.Contains(args, "-o\n"+opt+"\n") {
					t.Errorf("apt-helper wasn't given %s:\n%s", opt, args)
				}
			}
			written, readErr := os.ReadFile(pin)
			if readErr != nil {
				t.Fatalf("no pin while the snapshot is down: %v\n%s", readErr, out)
			}
			if got := stanzas(string(written)); len(got) != 1 || got[0] != "Package: *\nPin: origin snapshot.ubuntu.com\nPin-Priority: 1" {
				t.Errorf("pin:\n%s", written)
			}
			if !strings.Contains(out, "isn't answering (503  Service Unavailable [IP: 10.231.0.9 3129]), so apt takes") ||
				!strings.Contains(out, "from the live archive") {
				t.Errorf("down, it says:\n%s", out)
			}

			// Still down: the pin stays.
			if out, err, _ := snapshotCheck(t, root, 100, ""); err != nil || !strings.Contains(out, "isn't answering") {
				t.Errorf("still down: %v: %s", err, out)
			}
			if _, err := os.Stat(pin); err != nil {
				t.Errorf("still down, no pin: %v", err)
			}

			// Back: the pin goes, and it says so once.
			out, err, _ = snapshotCheck(t, root, 0, "")
			if err != nil || !strings.Contains(out, "answers again") {
				t.Errorf("back: %v: %s", err, out)
			}
			if _, err := os.Stat(pin); !os.IsNotExist(err) {
				t.Errorf("back, the pin is still there: %v", err)
			}
			if out, err, _ := snapshotCheck(t, root, 0, ""); err != nil || out != "" {
				t.Errorf("up: %v: %q", err, out)
			}
		})
	}
}

// The check never stops an update: with no snapshot source (an image whose sources someone replaced) it does nothing,
// and when it can't write the pin it still exits 0.
func TestAptSnapshotCheckNeverFailsTheUpdate(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc/apt/sources.list.d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/os-release"), []byte("VERSION_CODENAME=resolute\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/apt/sources.list.d/ubuntu.sources"),
		[]byte("Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: resolute\nComponents: main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err, args := snapshotCheck(t, root, 100, "")
	if err != nil || out != "" || args != "" {
		t.Errorf("no snapshot source: %v %q, apt-helper got %q", err, out, args)
	}
	if _, err := os.Stat(filepath.Join(root, snapshotDownPin)); !os.IsNotExist(err) {
		t.Errorf("a pin with no snapshot source: %v", err)
	}

	root = t.TempDir()
	if out, err := runAptSources(t, root, "amd64"); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	// preferences.d as a file: the pin can't be written.
	prefs := filepath.Join(root, "etc/apt/preferences.d")
	if err := os.RemoveAll(prefs); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(prefs, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err, _ := snapshotCheck(t, root, 100, ""); err != nil {
		t.Errorf("can't write the pin: %v: %s", err, out)
	}
}
