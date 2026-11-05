package guest

import (
	"os"
	"os/exec"
	"testing"
)

// The streams' pixel budget (guest/rootfs/usr/local/bin/kantel-selkies) is Python, run by the image's Selkies; its
// checks run it against a stand-in for the parts of Selkies it wraps (guest/kantel-selkies-test.py).
func TestKantelSelkiesHoldsSizeAndDPIToTheBudget(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3")
	}
	script, test := "../../guest/rootfs/usr/local/bin/kantel-selkies", "../../guest/kantel-selkies-test.py"
	// Read here so go test's cache sees the files: python3 reading them doesn't count, and a change to either
	// would otherwise rerun nothing.
	for _, f := range []string{script, test} {
		if _, err := os.ReadFile(f); err != nil {
			t.Fatal(err)
		}
	}
	out, err := exec.Command(python, test, script).CombinedOutput()
	if err != nil {
		t.Fatalf("kantel-selkies-test.py: %v\n%s", err, out)
	}
}
