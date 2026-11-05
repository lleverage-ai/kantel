package hostinfo

import (
	"path/filepath"
	"testing"
)

// Before the first install the root isn't there: its disk is the filesystem it will be made on, not 0 GiB.
func TestFreeDiskAtAMissingRoot(t *testing.T) {
	dir := t.TempDir()
	_, at, err := FreeDiskAt(filepath.Join(dir, "var", "lib", "kantel-host"))
	if err != nil || at != dir {
		t.Errorf("FreeDiskAt: %q %v", at, err)
	}
}

// Every check says whether it's required: the microVM tier's, or for native isolates only root and the OS.
func TestRequiredChecks(t *testing.T) {
	for _, native := range []bool{false, true} {
		for _, c := range Checks(t.TempDir(), native) {
			want := c.MicroVM && (!native || c.Name == "root" || c.Name == "os")
			if c.Required != want || (c.State == StateOK) != c.OK || c.State == "" {
				t.Errorf("native %v: %+v", native, c)
			}
		}
	}
	if Passed([]Check{{Name: "kvm", Required: true, State: StateUnknown}}) {
		t.Error("an unknown required check passed")
	}
}
