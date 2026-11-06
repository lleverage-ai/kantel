package guest

import (
	"os"
	"os/exec"
	"path/filepath"
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
