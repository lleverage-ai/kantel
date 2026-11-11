package guest

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The guest mounts a sticky drive only when its file system is ext4 with the host's label.
func TestExt4Label(t *testing.T) {
	if _, err := exec.LookPath("mkfs.ext4"); err != nil {
		t.Skip("no mkfs.ext4")
	}
	disk := filepath.Join(t.TempDir(), "sticky.ext4")
	if err := os.WriteFile(disk, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(disk, 64<<20); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("mkfs.ext4", "-q", "-F", "-L", StickyLabel, disk).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	f, err := os.Open(disk)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if label, err := ext4Label(f); err != nil || label != StickyLabel {
		t.Fatalf("label %q, %v", label, err)
	}
	empty, _ := os.Open(os.DevNull)
	defer empty.Close()
	if _, err := ext4Label(empty); err == nil {
		t.Fatal("an empty drive has no label")
	}
	other := filepath.Join(t.TempDir(), "zeros")
	_ = os.WriteFile(other, make([]byte, 4096), 0o600)
	g, _ := os.Open(other)
	defer g.Close()
	if _, err := ext4Label(g); err == nil || !strings.Contains(err.Error(), "no ext4") {
		t.Fatalf("zeros: %v", err)
	}
}

// A freeze is only ever of a sticky disk's mount (never the root, the system's own directories, or a path no drive is
// mounted at), under a lease of at most MaxStickyLease.
func TestFreezeOnlyAStickyMount(t *testing.T) {
	s := &Server{}
	for body, want := range map[string]int{
		`{"path":"/"}`: 400, `{"path":"/proc"}`: 400, `{"path":"relative"}`: 400, `{"path":"/no/sticky/disk/here"}`: 404,
		`{"path":"/cache","leaseMs":600000}`: 400,
	} {
		rec := httptest.NewRecorder()
		s.freezeSticky(rec, httptest.NewRequest(http.MethodPost, "/sticky/freeze", strings.NewReader(body)))
		if rec.Code != want {
			t.Errorf("%s: %d %s, want %d", body, rec.Code, rec.Body, want)
		}
	}
}
