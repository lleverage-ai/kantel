package fsutil

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// otherFilesystem is a new directory on another filesystem than dir's, removed after the test; the test is skipped
// when there is none to use.
func otherFilesystem(t *testing.T, dir string) string {
	t.Helper()
	var at syscall.Stat_t
	if err := syscall.Stat(dir, &at); err != nil {
		t.Fatal(err)
	}
	for _, parent := range []string{"/dev/shm", "."} {
		other, err := os.MkdirTemp(parent, "allocated-")
		if err != nil {
			continue
		}
		t.Cleanup(func() { _ = os.RemoveAll(other) })
		var st syscall.Stat_t
		if syscall.Stat(other, &st) == nil && st.Dev != at.Dev {
			return other
		}
	}
	t.Skip("no other filesystem to put files on")
	return ""
}

func writeZeros(t *testing.T, path string, n int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, n), 0o600); err != nil {
		t.Fatal(err)
	}
}

// Files count once, by hard link, and only on the filesystem the count is of: a directory on another (a bundle cache
// on a disk of its own) counts nothing.
func TestAllocatedCountsEachFileOnceOnOneFilesystem(t *testing.T) {
	root := t.TempDir()
	writeZeros(t, filepath.Join(root, "a", "file"), 1<<20)
	if err := os.Link(filepath.Join(root, "a", "file"), filepath.Join(root, "b")); err != nil {
		t.Fatal(err)
	}
	other := otherFilesystem(t, root)
	writeZeros(t, filepath.Join(other, "cache", "bundle.erofs"), 2<<20)

	if Allocated(other, nil) == 0 {
		t.Fatal("the other filesystem's file counted nothing on its own")
	}
	seen := OnFilesystemOf(root)
	if first := Allocated(filepath.Join(root, "a"), seen); first == 0 {
		t.Fatal("the file counted nothing")
	}
	if again := Allocated(root, seen); again != 0 {
		t.Fatalf("a hard link counted again: %d", again)
	}
	if elsewhere := Allocated(other, seen); elsewhere != 0 {
		t.Fatalf("files on another filesystem counted %d", elsewhere)
	}
}
