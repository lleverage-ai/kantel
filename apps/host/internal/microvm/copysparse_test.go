package microvm

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// copySparse asks cp for a reflink and a sparse copy together: on a file system that can't share blocks (tmpfs here,
// ext4 on most hosts) the clone fails and cp falls back to a copy that keeps the image's holes, with the same bytes.
func TestCopySparseFallsBackWithoutReflinks(t *testing.T) {
	dir := t.TempDir()
	if info, err := os.Stat("/dev/shm"); err == nil && info.IsDir() {
		// tmpfs has no FICLONE, so this is the fallback for certain.
		if d, err := os.MkdirTemp("/dev/shm", "kantel-copysparse"); err == nil {
			dir = d
			t.Cleanup(func() { os.RemoveAll(d) })
		}
	}
	src, dst := filepath.Join(dir, "disk.ext4"), filepath.Join(dir, "copy.ext4")
	f, err := os.Create(src)
	if err != nil {
		t.Fatal(err)
	}
	// 64 MiB, of which 1 MiB of data in the middle: the rest is a hole.
	if err := f.Truncate(64 << 20); err != nil {
		t.Fatal(err)
	}
	data := bytes.Repeat([]byte("kantel!\n"), (1<<20)/8)
	if _, err := f.WriteAt(data, 32<<20); err != nil {
		t.Fatal(err)
	}
	f.Close()

	if cloned := tryClone(t, src, filepath.Join(dir, "probe")); cloned {
		t.Logf("%s can reflink: checking the copy, not the fallback", dir)
	}
	if err := copySparse(src, dst); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(src)
	b, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("the copy's bytes differ")
	}
	// The hole stays a hole: at most the data and a little slack, not 64 MiB.
	if used := diskUsage(dst); used > 4<<20 {
		t.Fatalf("the copy uses %d bytes, its holes filled", used)
	}
}

// noBarrier stands for a VMM thread with no write under way.
func noBarrier() error { return nil }

// A write still under way as a copy ends raises its IN_MODIFY only as it finishes, after the copy: the barrier (a round
// trip through the VMM thread that makes it) is where it finishes. That copy, which lacks the write, is never kept;
// the next, with nothing under way, is, and holds the write.
func TestCopyQuietDiskWaitsOutAWriteInFlight(t *testing.T) {
	dir := t.TempDir()
	disk, dst := filepath.Join(dir, "disk.ext4"), filepath.Join(dir, "snap.ext4")
	if err := os.WriteFile(disk, make([]byte, 1<<16), 0o600); err != nil {
		t.Fatal(err)
	}
	inFlight := []byte("written as the first copy ended")
	barriers := 0
	barrier := func() error {
		barriers++
		if barriers == 1 {
			// The write that was under way: it finishes before the barrier returns, as the VMM thread's would.
			f, err := os.OpenFile(disk, os.O_WRONLY, 0)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = f.WriteAt(inFlight, 4096)
			return err
		}
		return nil
	}
	if err := copyQuietDisk(disk, dst, diskCopies, barrier); err != nil {
		t.Fatal(err)
	}
	if barriers != 2 {
		t.Fatalf("copied %d times, want the first refused and a second kept", barriers)
	}
	got, _ := os.ReadFile(dst)
	if !bytes.Equal(got[4096:4096+len(inFlight)], inFlight) {
		t.Fatal("the kept copy lacks the write that was in flight")
	}
	want, _ := os.ReadFile(disk)
	if !bytes.Equal(got, want) {
		t.Fatal("the kept copy isn't the disk")
	}

	// A barrier that fails says nothing about writes under way: no copy is kept on it.
	_ = os.Remove(dst)
	if err := copyQuietDisk(disk, dst, 2, func() error { return os.ErrDeadlineExceeded }); err == nil {
		t.Fatal("a copy was kept with no barrier")
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatalf("a refused copy left a file: %v", err)
	}
}

// A paused VM's disk nothing writes is copied once, and is the disk.
func TestCopyQuietDisk(t *testing.T) {
	dir := t.TempDir()
	disk, dst := filepath.Join(dir, "disk.ext4"), filepath.Join(dir, "snap.ext4")
	if err := os.WriteFile(disk, bytes.Repeat([]byte{7}, 1<<16), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyQuietDisk(disk, dst, 2, noBarrier); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(disk)
	b, _ := os.ReadFile(dst)
	if !bytes.Equal(a, b) {
		t.Fatal("the copy's bytes differ")
	}
}

// A disk written all through every copy is never taken as a snapshot: a torn copy isn't crash-consistent.
func TestCopyQuietDiskRefusesADiskBeingWritten(t *testing.T) {
	dir := t.TempDir()
	disk, dst := filepath.Join(dir, "disk.ext4"), filepath.Join(dir, "snap.ext4")
	if err := os.WriteFile(disk, make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(disk, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			_, _ = f.WriteAt([]byte{byte(i)}, int64(i%(1<<20)))
		}
	}()
	err = copyQuietDisk(disk, dst, 3, noBarrier)
	close(stop)
	<-done
	if err == nil {
		t.Fatal("a disk written during every copy was kept")
	}
}

// tryClone says whether the file system under dst can reflink, removing what it made.
func tryClone(t *testing.T, src, dst string) bool {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(dst)
	defer out.Close()
	return unix.IoctlFileClone(int(out.Fd()), int(in.Fd())) == nil
}
