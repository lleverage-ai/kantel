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

// A paused VM's disk nothing writes is copied once, and is the disk.
func TestCopyQuietDisk(t *testing.T) {
	dir := t.TempDir()
	disk, dst := filepath.Join(dir, "disk.ext4"), filepath.Join(dir, "snap.ext4")
	if err := os.WriteFile(disk, bytes.Repeat([]byte{7}, 1<<16), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyQuietDisk(disk, dst, 2); err != nil {
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
	err = copyQuietDisk(disk, dst, 3)
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
