package microvm

import (
	"os"
	"path/filepath"
	"testing"
	"time"
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

// A live snapshot copies the disk beside the memory, then copies it again if anything wrote to it meanwhile.
func TestUnchangedSeesAWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "disk.ext4")
	if err := os.WriteFile(path, make([]byte, 4096), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// Read, as the copy does: still unchanged.
	if _, err := os.ReadFile(path); err != nil {
		t.Fatal(err)
	}
	if !unchanged(path, before) {
		t.Fatal("a read counted as a write")
	}
	// A write in place, of the same size and within the same timestamp tick or not.
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	if _, err := f.WriteAt([]byte("x"), 100); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	if unchanged(path, before) {
		t.Fatal("a write went unseen")
	}
	if unchanged(filepath.Join(t.TempDir(), "gone"), before) {
		t.Fatal("a missing file counted as unchanged")
	}
}

// A rename that can't be done (here: no such source) falls back to a copy, which says what failed.
func TestTakeFileFallsBackToCopy(t *testing.T) {
	dir := t.TempDir()
	if err := takeFile(filepath.Join(dir, "missing"), filepath.Join(dir, "dst")); err == nil {
		t.Fatal("taking a missing file worked")
	}
}
