package guest

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// aptSources runs guest/rootfs/usr/local/sbin/kantel-apt-sources for arch under a root of its own, and answers its
// output and the sources and preferences it wrote.
func aptSources(t *testing.T, arch string, args ...string) (out, sources, prefs string, err error) {
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
	root := t.TempDir()
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
	write("etc/apt/apt.conf.d/50kantel-snapshot", "APT::Snapshot \"20261103T000000Z\";\n")
	cmd := exec.Command(bash, append([]string{script}, args...)...)
	cmd.Env = append(os.Environ(), "KANTEL_APT_ROOT="+root, "KANTEL_APT_ARCH="+arch)
	raw, err := cmd.CombinedOutput()
	s, _ := os.ReadFile(filepath.Join(root, "etc/apt/sources.list.d/ubuntu.sources"))
	p, _ := os.ReadFile(filepath.Join(root, "etc/apt/preferences.d/kantel-ubuntu-live"))
	return string(raw), string(s), string(p), err
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

// A sandbox's apt reads Ubuntu's snapshot first and the live archive under it, on amd64 and arm64 alike
// (lleverage-ai/kantel#706): every Ubuntu source is "Snapshot: disable" (the snapshot is named outright, and the live
// archive must stay live), and only the live archive's hosts are pinned down, to 100.
func TestAptSourcesPutTheSnapshotFirstAndTheLiveArchiveUnderIt(t *testing.T) {
	const snapshot = "https://snapshot.ubuntu.com/ubuntu/20261103T000000Z/"
	for arch, want := range map[string]struct {
		live  []string // each live source: its URI and suites
		hosts []string
	}{
		"amd64": {
			live: []string{
				"URIs: http://archive.ubuntu.com/ubuntu/\nSuites: resolute resolute-updates resolute-backports",
				"URIs: http://security.ubuntu.com/ubuntu/\nSuites: resolute-security",
			},
			hosts: []string{"archive.ubuntu.com", "security.ubuntu.com"},
		},
		"arm64": {
			live:  []string{"URIs: http://ports.ubuntu.com/ubuntu-ports/\nSuites: resolute resolute-updates resolute-backports resolute-security"},
			hosts: []string{"ports.ubuntu.com"},
		},
	} {
		t.Run(arch, func(t *testing.T) {
			out, sources, prefs, err := aptSources(t, arch)
			if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			got := stanzas(sources)
			if len(got) != 1+len(want.live) {
				t.Fatalf("%d sources:\n%s", len(got), sources)
			}
			if !strings.HasPrefix(got[0], "Types: deb\nURIs: "+snapshot+"\nSuites: resolute resolute-updates resolute-backports resolute-security\n") {
				t.Errorf("the first source isn't the snapshot's:\n%s", got[0])
			}
			for i, live := range want.live {
				if !strings.HasPrefix(got[i+1], "Types: deb\n"+live+"\n") {
					t.Errorf("source %d:\n%s\nwant %q", i+1, got[i+1], live)
				}
			}
			for _, s := range got {
				if !strings.Contains(s, "\nComponents: main universe restricted multiverse\n") ||
					!strings.Contains(s, "\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n") ||
					!strings.HasSuffix(s, "\nSnapshot: disable") {
					t.Errorf("source:\n%s", s)
				}
			}
			pins := stanzas(prefs)
			if len(pins) != len(want.hosts) {
				t.Fatalf("pins:\n%s", prefs)
			}
			for i, host := range want.hosts {
				if pins[i] != "Package: *\nPin: origin "+host+"\nPin-Priority: 100" {
					t.Errorf("pin %d:\n%s", i, pins[i])
				}
			}
		})
	}
}

// The snapshot is the one the image was built from unless one is named, and nothing else is taken for one.
func TestAptSourcesTakeOnlyASnapshotID(t *testing.T) {
	if _, sources, _, err := aptSources(t, "amd64", "20261201T120000Z"); err != nil || !strings.Contains(sources, "/ubuntu/20261201T120000Z/") {
		t.Errorf("a named snapshot: %v\n%s", err, sources)
	}
	for _, bad := range []string{"latest", "20261201", "../../x", "20261201T120000Z/../.."} {
		out, sources, _, err := aptSources(t, "amd64", bad)
		if err == nil || sources != "" || !strings.Contains(out, "must be an ID") {
			t.Errorf("%q: %v %q %q", bad, err, out, sources)
		}
	}
}
