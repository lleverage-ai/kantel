package blockmap

// Block maps on the file systems a host keeps sticky disks on, XFS (with reflinks) and ext4 (without), each a loop
// device. Making one needs root, so these skip otherwise; run them with
//
//	go test -c -o /tmp/blockmap.test ./internal/blockmap && sudo /tmp/blockmap.test -test.run Loop -test.v
//
// KANTEL_BLOCKMAP_DISK_GIB sets the disk's size (1 GiB by default; 20 for the design's example), and
// KANTEL_BLOCKMAP_LOOP_DIR where the loop devices' files go (the temporary directory by default, often memory).
// KANTEL_BLOCKMAP_XFS_DIR and KANTEL_BLOCKMAP_EXT4_DIR name a directory on such a file system, mounted already, to
// use instead of a loop device (in a VM, say, where the file systems are its drives).

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLoopXFS(t *testing.T)  { testCommitOnLoop(t, "xfs") }
func TestLoopExt4(t *testing.T) { testCommitOnLoop(t, "ext4") }

// testCommitOnLoop makes a disk full of data, a version of it changed in a twentieth of its blocks (as a commit does:
// a reflink where the file system has them, else a full copy), with one block punched out and one changed by a single
// page, and maps the version from the disk's map. The map is what a full rehash makes. With reflinks only the changed
// blocks are read: about a twentieth of the disk. Without, every block with data is.
func testCommitOnLoop(t *testing.T, kind string) {
	gib := int64(1)
	if v := os.Getenv("KANTEL_BLOCKMAP_DISK_GIB"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			t.Fatalf("KANTEL_BLOCKMAP_DISK_GIB=%q", v)
		}
		gib = n
	}
	dir := loopFS(t, kind, gib)
	size := gib << 30
	parent, child := filepath.Join(dir, "v1.img"), filepath.Join(dir, "v2.img")

	f, err := os.OpenFile(parent, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, BlockSize)
	for i := range size / BlockSize {
		pattern(buf, 1, uint64(i))
		if _, err := f.WriteAt(buf, i*BlockSize); err != nil {
			t.Fatal(err)
		}
	}
	if err := errors.Join(f.Sync(), f.Close()); err != nil {
		t.Fatal(err)
	}
	pm, pst := makeMap(t, parent, nil)
	if pst.Read != pm.Blocks() || pst.BytesRead != size {
		t.Fatalf("the disk's own map: %+v", pst)
	}

	reflinked := cloneOrCopy(t, parent, child)
	if kind == "xfs" && !reflinked {
		t.Fatal("XFS made with reflinks gave none")
	}
	c, err := os.OpenFile(child, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	blocks := size / BlockSize
	changed := int64(0)
	for i := int64(3); i < blocks; i += 20 {
		pattern(buf, 2, uint64(i))
		if _, err := c.WriteAt(buf, i*BlockSize); err != nil {
			t.Fatal(err)
		}
		changed++
	}
	// One page of one more block, and a block punched out (zeros, with no data on the disk).
	if _, err := c.WriteAt([]byte("one page changed"), 5*BlockSize+8192); err != nil {
		t.Fatal(err)
	}
	if err := unix.Fallocate(int(c.Fd()), unix.FALLOC_FL_PUNCH_HOLE|unix.FALLOC_FL_KEEP_SIZE, 7*BlockSize, BlockSize); err != nil {
		t.Fatal(err)
	}
	if err := errors.Join(c.Sync(), c.Close()); err != nil {
		t.Fatal(err)
	}

	pf, err := os.Open(parent)
	if err != nil {
		t.Fatal(err)
	}
	defer pf.Close()
	m, st := makeMap(t, child, &Base{File: pf, Map: pm})
	t.Logf("%s, a %d GiB disk, %d of its %d blocks changed (%d MiB), one by a page, one punched out: %+v (read %d MiB)",
		kind, gib, changed, blocks, changed*BlockSize>>20, st, st.BytesRead>>20)
	if !bytes.Equal(encode(m), encode(fullMap(t, child))) {
		t.Fatal("the map differs from a full rehash")
	}
	if m.Hash(7) != [HashSize]byte{} || m.Hash(0) != pm.Hash(0) || m.Hash(3) == pm.Hash(3) || m.Hash(5) == pm.Hash(5) {
		t.Fatal("wrong hashes")
	}
	if reflinked {
		want := (changed + 1) * BlockSize // the changed blocks and the one with a page changed
		if st.BytesRead != want || st.Read != int(changed+1) || st.Empty != 1 || st.Reused != int(blocks-changed-2) {
			t.Fatalf("read %d bytes (%+v), want %d", st.BytesRead, st, want)
		}
	} else if st.Reused != 0 || st.BytesRead != size-BlockSize {
		t.Fatalf("without reflinks every block with data is read: %+v", st)
	}
}

// cloneOrCopy makes dst a copy of src: a reflink where the file system can, which it answers true, else a full copy.
func cloneOrCopy(t *testing.T, src, dst string) bool {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	if unix.IoctlFileClone(int(out.Fd()), int(in.Fd())) == nil {
		return true
	}
	if _, err := out.ReadFrom(in); err != nil {
		t.Fatal(err)
	}
	return false
}

// loopFS mounts a new file system of kind (xfs, with reflinks, or ext4) on a loop device with room for two disks of
// gib, and answers where; it is gone when the test ends. It skips without root or the tools.
func loopFS(t *testing.T, kind string, gib int64) string {
	t.Helper()
	if given := os.Getenv("KANTEL_BLOCKMAP_" + strings.ToUpper(kind) + "_DIR"); given != "" {
		var st unix.Statfs_t
		if err := unix.Statfs(given, &st); err != nil {
			t.Fatal(err)
		}
		if want := map[string]int64{"xfs": unix.XFS_SUPER_MAGIC, "ext4": unix.EXT4_SUPER_MAGIC}[kind]; st.Type != want {
			t.Fatalf("%s is on a file system of type %#x, not %s", given, st.Type, kind)
		}
		dir, err := os.MkdirTemp(given, "blockmap")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
		return dir
	}
	if os.Geteuid() != 0 {
		t.Skip("loop devices need root: go test -c, then sudo ./blockmap.test -test.run Loop")
	}
	mkfs := map[string][]string{"xfs": {"mkfs.xfs", "-q", "-f", "-m", "reflink=1"}, "ext4": {"mkfs.ext4", "-q", "-F"}}[kind]
	for _, tool := range []string{"losetup", "mount", "umount", mkfs[0]} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("no " + tool)
		}
	}
	base := os.Getenv("KANTEL_BLOCKMAP_LOOP_DIR")
	if base == "" {
		base = os.TempDir()
	}
	work, err := os.MkdirTemp(base, "blockmap-"+kind)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(work) })
	backing := filepath.Join(work, "fs.img")
	if err := os.WriteFile(backing, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(backing, (2*gib+1)<<30); err != nil {
		t.Fatal(err)
	}
	run := func(name string, args ...string) string {
		t.Helper()
		out, err := exec.Command(name, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s %s: %v: %s", name, strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	dev := run("losetup", "--find", "--show", backing)
	t.Cleanup(func() { _ = exec.Command("losetup", "-d", dev).Run() })
	run(mkfs[0], append(mkfs[1:], dev)...)
	mnt := filepath.Join(work, "mnt")
	if err := os.Mkdir(mnt, 0o700); err != nil {
		t.Fatal(err)
	}
	run("mount", dev, mnt)
	t.Cleanup(func() { _ = exec.Command("umount", mnt).Run() })
	return mnt
}
