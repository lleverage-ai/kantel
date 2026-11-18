package guest

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The image's build and release scripts (guest/*.sh, guest/kernel/build.sh) run only when a release is made, so a
// syntax error in one shows up then, such as an apostrophe in a comment ending boot-check-arm64.sh's quoted guest
// script. sh -n parses each without running it.
func TestGuestScriptsParse(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	scripts, _ := filepath.Glob("../../guest/*.sh")
	kernel, _ := filepath.Glob("../../guest/kernel/*.sh")
	scripts = append(scripts, kernel...)
	if len(scripts) == 0 {
		t.Fatal("no scripts under ../../guest")
	}
	for _, s := range scripts {
		// Read here so go test's cache sees the files.
		if _, err := os.ReadFile(s); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command(sh, "-n", s).CombinedOutput(); err != nil {
			t.Errorf("%s doesn't parse: %v\n%s", s, err, out)
		}
	}
}

// A sandbox image built with KANTEL_BROWSER=cft bundles Google Chrome for Testing, which may not be redistributed
// (LLE-18651), so it is never published: release.sh --publish refuses it before building anything, and no workflow
// sets KANTEL_BROWSER, so the daily build (sandbox-image.yml's host-images job) only ever makes Debian's Chromium.
func TestChromeForTestingIsNeverPublished(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	release := "../../guest/release.sh"
	// Read here so go test's cache sees the file.
	if _, err := os.ReadFile(release); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		browser, publish, want string
		code                   int
	}{
		{"cft", "--publish", "Chrome for Testing may not be redistributed", 1},
		{"chrome", "", "KANTEL_BROWSER is debian or cft", 2},
	} {
		out := t.TempDir()
		args := []string{release, out, "host-images-20261117"}
		if tc.publish != "" {
			args = append(args, tc.publish)
		}
		cmd := exec.Command(sh, args...)
		// No Docker, Go or gh on PATH: had it gone on to build or publish, it would fail some other way.
		cmd.Env = []string{"PATH=/nonexistent", "KANTEL_BROWSER=" + tc.browser}
		got, err := cmd.CombinedOutput()
		if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != tc.code || !strings.Contains(string(got), tc.want) {
			t.Errorf("KANTEL_BROWSER=%s release.sh %s: %v\n%s", tc.browser, tc.publish, err, got)
		}
		if entries, _ := os.ReadDir(out); len(entries) != 0 {
			t.Errorf("KANTEL_BROWSER=%s release.sh %s wrote %d files to its out dir", tc.browser, tc.publish, len(entries))
		}
	}

	// KANTEL_BROWSER itself, not the KANTEL_BROWSER_* settings of Kantel's own browsers.
	setsBrowser := regexp.MustCompile(`\bKANTEL_BROWSER\b`)
	workflows, _ := filepath.Glob("../../../../.github/workflows/*.yml")
	if len(workflows) == 0 {
		t.Fatal("no workflows under ../../../../.github/workflows")
	}
	for _, w := range workflows {
		data, err := os.ReadFile(w)
		if err != nil {
			t.Fatal(err)
		}
		if setsBrowser.Match(data) {
			t.Errorf("%s sets KANTEL_BROWSER: Kantel's own builds publish Debian's Chromium only", w)
		}
	}
}

// rootfs.sh turns away a browser it doesn't know before it builds anything.
func TestRootfsChecksBrowser(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	// Read here so go test's cache sees the file.
	if _, err := os.ReadFile("../../guest/rootfs.sh"); err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	cmd := exec.Command(sh, "../../guest/rootfs.sh", out, "sandbox", "amd64")
	cmd.Env = []string{"PATH=/nonexistent", "KANTEL_BROWSER=chrome"}
	got, err := cmd.CombinedOutput()
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 2 || !strings.Contains(string(got), "KANTEL_BROWSER is debian or cft") {
		t.Errorf("KANTEL_BROWSER=chrome rootfs.sh: %v\n%s", err, got)
	}
}

// The image's bwrap (guest/rootfs/usr/local/bin/bwrap) turns away glycin's calls with the message glycin 2.1 reads as
// "no namespaces here", so GTK's image loaders run without glycin's memory limit and Geany and PCManFM start on a
// small sandbox. glycin matches the exact text, and knows its calls by the home it gives the loader at /tmp-home.
func TestBwrapTurnsAwayGlycin(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	shim := "../../guest/rootfs/usr/local/bin/bwrap"
	if fi, err := os.Stat(shim); err != nil {
		t.Fatal(err)
	} else if fi.Mode()&0o111 == 0 {
		t.Fatalf("%s isn't executable", shim)
	}
	// glycin 2.1.5's loader command, shortened (glycin/src/sandbox.rs, bwrap_command).
	cmd := exec.Command(sh, shim, "--unshare-all", "--die-with-parent", "--chdir", "/", "--ro-bind", "/usr", "/usr",
		"--tmpfs", "/tmp-home", "--tmpfs", "/tmp-run", "--clearenv", "--setenv", "HOME", "/tmp-home",
		"--seccomp", "3", "/usr/bin/true")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	err = cmd.Run()
	if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 1 {
		t.Fatalf("glycin's call: want exit 1, got %v", err)
	}
	if !strings.Contains(stderr.String(), "No permissions to create a new namespace") {
		t.Fatalf("glycin's call: stderr %q lacks the text glycin matches", stderr.String())
	}
}
