package guest

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const aptSnapshotConf = "APT::Snapshot \"20261103T000000Z\";\n" +
	"Acquire::Snapshots::URI::Host::ports.ubuntu.com \"https://snapshot.ubuntu.com/ubuntu/@SNAPSHOTID@/\";\n"

// runAptSources runs guest/rootfs/usr/local/sbin/kantel-apt-sources for arch under root, set up as a resolute image
// built from a snapshot (the Dockerfile's 50kantel-snapshot), and answers its output.
func runAptSources(t *testing.T, root, arch string) (string, error) {
	t.Helper()
	bash, lookErr := exec.LookPath("bash")
	if lookErr != nil {
		t.Skip("no bash")
	}
	script := "../../guest/rootfs/usr/local/sbin/kantel-apt-sources"
	// Read here so go test's cache sees the script: bash reading it doesn't count.
	if _, err := os.ReadFile(script); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"etc/apt/sources.list.d", "etc/apt/apt.conf.d"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path, content string) {
		if err := os.WriteFile(filepath.Join(root, path), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("etc/os-release", "NAME=\"Ubuntu\"\nVERSION_CODENAME=resolute\n")
	write("etc/apt/apt.conf.d/50kantel-snapshot", aptSnapshotConf)
	cmd := exec.Command(bash, script)
	cmd.Env = append(os.Environ(), "KANTEL_APT_ROOT="+root, "KANTEL_APT_ARCH="+arch)
	raw, err := cmd.CombinedOutput()
	return string(raw), err
}

// stanzas splits a deb822 file into its paragraphs, comments aside.
func stanzas(text string) []string {
	var out []string
	for _, p := range strings.Split(text, "\n\n") {
		var lines []string
		for _, line := range strings.Split(p, "\n") {
			if line != "" && !strings.HasPrefix(line, "#") {
				lines = append(lines, line)
			}
		}
		if len(lines) > 0 {
			out = append(out, strings.Join(lines, "\n"))
		}
	}
	return out
}

// A sandbox's apt reads Ubuntu's live archive alone, on amd64 (archive and security) and arm64 (ports) alike, every
// source checked against Ubuntu's archive key (lleverage-ai/kantel#706): snapshot.ubuntu.com fails for hours at a time,
// and a 4xx from it fails `apt-get update` outright, so the snapshot isn't a source at all, not even under a pin.
func TestAptSourcesAreTheLiveArchiveAlone(t *testing.T) {
	for arch, want := range map[string][]string{
		"amd64": {
			"Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: resolute resolute-updates resolute-backports",
			"Types: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: resolute-security",
		},
		"arm64": {
			"Types: deb\nURIs: http://ports.ubuntu.com/ubuntu-ports/\nSuites: resolute resolute-updates resolute-backports resolute-security",
		},
	} {
		t.Run(arch, func(t *testing.T) {
			root := t.TempDir()
			if out, err := runAptSources(t, root, arch); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			sources, err := os.ReadFile(filepath.Join(root, "etc/apt/sources.list.d/ubuntu.sources"))
			if err != nil {
				t.Fatal(err)
			}
			got := stanzas(string(sources))
			if len(got) != len(want) {
				t.Fatalf("%d sources:\n%s", len(got), sources)
			}
			for i, w := range want {
				if got[i] != w+"\nComponents: main universe restricted multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg" {
					t.Errorf("source %d:\n%s\nwant it to start %q", i, got[i], w)
				}
			}
			for _, s := range got {
				if strings.Contains(s, "snapshot") || strings.Contains(s, "Snapshot:") {
					t.Errorf("a source names the snapshot:\n%s", s)
				}
			}
			// No pins either: the live archive is the only Ubuntu source.
			if entries, _ := os.ReadDir(filepath.Join(root, "etc/apt/preferences.d")); len(entries) != 0 {
				t.Errorf("preferences: %v", entries)
			}
		})
	}
}

// APT::Snapshot leaves apt's settings, so no source (Debian's for Chromium included) is read at the snapshot in a
// sandbox, and is kept in /etc/kantel/apt-snapshot.conf as the record of what the image was built from. Running it
// again changes nothing.
func TestAptSourcesMoveAPTSnapshotOutOfAptsSettings(t *testing.T) {
	root := t.TempDir()
	for run := 1; run <= 2; run++ {
		if run == 2 {
			// The second run starts from what the first left: no 50kantel-snapshot to move.
			bash, _ := exec.LookPath("bash")
			cmd := exec.Command(bash, "../../guest/rootfs/usr/local/sbin/kantel-apt-sources")
			cmd.Env = append(os.Environ(), "KANTEL_APT_ROOT="+root, "KANTEL_APT_ARCH=arm64")
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("again: %v: %s", err, out)
			}
		} else if out, err := runAptSources(t, root, "arm64"); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		if _, err := os.Stat(filepath.Join(root, "etc/apt/apt.conf.d/50kantel-snapshot")); !os.IsNotExist(err) {
			t.Errorf("run %d: APT::Snapshot is still in apt's settings: %v", run, err)
		}
		kept, err := os.ReadFile(filepath.Join(root, "etc/kantel/apt-snapshot.conf"))
		if err != nil || string(kept) != aptSnapshotConf {
			t.Errorf("run %d: the record: %v %q", run, err, kept)
		}
		entries, _ := os.ReadDir(filepath.Join(root, "etc/apt/apt.conf.d"))
		for _, e := range entries {
			conf, _ := os.ReadFile(filepath.Join(root, "etc/apt/apt.conf.d", e.Name()))
			if strings.Contains(string(conf), "Snapshot") {
				t.Errorf("run %d: %s still sets a snapshot:\n%s", run, e.Name(), conf)
			}
		}
	}
}
