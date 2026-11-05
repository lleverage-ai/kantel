package microvm

import (
	"os"
	"path/filepath"
	"testing"
)

// A live fork takes its snapshot's disk: moved, not copied, and gone from the snapshot.
func TestTakeFileMoves(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "snap-disk.ext4"), filepath.Join(dir, "vm-disk.ext4")
	if err := os.WriteFile(src, []byte("disk"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(src)
	if err := takeFile(src, dst); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("the snapshot still has its disk: %v", err)
	}
	after, err := os.Stat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("the disk was copied, not moved")
	}
}

// A rename that can't be done (here: no such source) falls back to a copy, which says what failed.
func TestTakeFileFallsBackToCopy(t *testing.T) {
	dir := t.TempDir()
	if err := takeFile(filepath.Join(dir, "missing"), filepath.Join(dir, "dst")); err == nil {
		t.Fatal("taking a missing file worked")
	}
}
