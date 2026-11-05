package guest

import (
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
	out, err := exec.Command(python, "../../guest/kantel-selkies-test.py",
		"../../guest/rootfs/usr/local/bin/kantel-selkies").CombinedOutput()
	if err != nil {
		t.Fatalf("kantel-selkies-test.py: %v\n%s", err, out)
	}
}
