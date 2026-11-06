package microvm

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func newWatchedDisk(t *testing.T) (string, *writeWatch) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "disk.ext4")
	if err := os.WriteFile(path, make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	w, err := watchWrites(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.close)
	return path, w
}

// Copying the disk, as a live snapshot does beside the memory, only reads it: no write.
func TestWriteWatchIgnoresTheCopy(t *testing.T) {
	path, w := newWatchedDisk(t)
	if _, err := os.ReadFile(path); err != nil {
		t.Fatal(err)
	}
	if err := copySparse(path, filepath.Join(t.TempDir(), "copy.ext4")); err != nil {
		t.Fatal(err)
	}
	if w.written() {
		t.Fatal("reading and copying the disk counted as a write")
	}
}

// A same-sized write straight after the disk's stamp is taken, as a request the guest queued before its pause would
// be served while the copy runs: the watch sees every one, though the stamp, in the same clock tick, may not.
func TestWriteWatchSeesASameTickWrite(t *testing.T) {
	path, _ := newWatchedDisk(t)
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	missedByStamp := 0
	const rounds = 500
	for i := range rounds {
		w, err := watchWrites(path)
		if err != nil {
			t.Fatal(err)
		}
		before, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if w.written() {
			t.Fatalf("round %d: a write before nothing was written", i)
		}
		if _, err := f.WriteAt([]byte{byte(i)}, int64(i*4096)); err != nil {
			t.Fatal(err)
		}
		if !w.written() {
			t.Fatalf("round %d: a write went unseen", i)
		}
		if unchanged(path, before) {
			missedByStamp++
		}
		w.close()
	}
	t.Logf("the stamp alone missed %d of %d same-tick writes", missedByStamp, rounds)
}

// A truncate and a hole punched (the guest's discard) are writes too, and so is the disk being moved or deleted.
func TestWriteWatchSeesTruncateAndHoles(t *testing.T) {
	path, w := newWatchedDisk(t)
	if err := os.Truncate(path, 1<<20); err != nil {
		t.Fatal(err)
	}
	if !w.written() {
		t.Fatal("a truncate went unseen")
	}

	path, w = newWatchedDisk(t)
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := unix.Fallocate(int(f.Fd()), unix.FALLOC_FL_PUNCH_HOLE|unix.FALLOC_FL_KEEP_SIZE, 0, 4096); err != nil {
		t.Skipf("this file system can't punch holes: %v", err)
	}
	if !w.written() {
		t.Fatal("a hole punched went unseen")
	}

	path, w = newWatchedDisk(t)
	if err := os.Rename(path, path+".moved"); err != nil {
		t.Fatal(err)
	}
	if !w.written() {
		t.Fatal("the disk moving went unseen")
	}
}

// A watch on a disk that isn't there can't be started, and the snapshot copies the disk after the memory instead.
func TestWatchWritesNeedsTheDisk(t *testing.T) {
	if _, err := watchWrites(filepath.Join(t.TempDir(), "gone")); err == nil {
		t.Fatal("watched a missing disk")
	}
}
