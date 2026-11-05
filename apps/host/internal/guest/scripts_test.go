package guest

import (
	"os"
	"os/exec"
	"path/filepath"
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
