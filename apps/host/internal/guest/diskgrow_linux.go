package guest

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// diskDevice is the sandbox's own disk; the image is /dev/vda, read-only.
const diskDevice = "/dev/vdb"

// ext4ResizeFS is EXT4_IOC_RESIZE_FS, _IOW('f', 16, __u64): grow a mounted ext4 to a number of blocks, as resize2fs
// does online.
const ext4ResizeFS = 0x40086610

// growDisk grows the disk's file system once the device is ?bytes= long (the size the host made it; the kernel learns
// of it a moment after the host's rescan), or at once to whatever the device is without it.
func (s *Server) growDisk(w http.ResponseWriter, r *http.Request) {
	var want uint64
	if v := r.URL.Query().Get("bytes"); v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			fail(w, 400, fmt.Errorf("bytes: %w", err))
			return
		}
		want = n
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := GrowFS(ctx, diskDevice, want); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// GrowFS grows the ext4 file system mounted from dev to fill the device, online (resize2fs without the tool, which an
// image needn't have), once the device is at least want bytes (waiting for the kernel to see it until ctx ends).
// Nothing to do when it already fills it.
func GrowFS(ctx context.Context, dev string, want uint64) error {
	mount, err := mountOf(dev)
	if err != nil {
		return err
	}
	var bytes uint64
	for {
		if bytes, err = deviceBytes(dev); err != nil {
			return err
		}
		if bytes >= want {
			break
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%s is %d bytes, not the %d asked for", dev, bytes, want)
		case <-time.After(10 * time.Millisecond):
		}
	}
	var st unix.Statfs_t
	if err := unix.Statfs(mount, &st); err != nil {
		return err
	}
	if st.Bsize <= 0 {
		return fmt.Errorf("%s: block size %d", mount, st.Bsize)
	}
	blocks := bytes / uint64(st.Bsize)
	if blocks <= st.Blocks {
		return nil
	}
	dir, err := os.Open(mount)
	if err != nil {
		return err
	}
	defer dir.Close()
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, dir.Fd(), ext4ResizeFS, uintptr(unsafe.Pointer(&blocks))); errno != 0 {
		return fmt.Errorf("grow %s to %d blocks: %w", mount, blocks, errno)
	}
	return nil
}

// fiTrim is FITRIM, _IOWR('X', 121, struct fstrim_range): discard a mounted file system's free blocks, as fstrim
// does. x/sys/unix has no constant for it.
const fiTrim = 0xc0185879

// fstrimRange is struct fstrim_range: which bytes to trim, and the smallest free extent worth it. The kernel writes
// back into len how many bytes it trimmed.
type fstrimRange struct {
	start, len, minLen uint64
}

// trimDisk discards the disk's free blocks (fstrim), so that with discard on the drive (Firecracker's, from v1.17) the
// host punches holes where deleted files were, and a snapshot copies none of them. The host asks before it saves a
// snapshot. A device without discard answers 501 (EOPNOTSUPP); an older agent 404: either way nothing to do.
func (s *Server) trimDisk(w http.ResponseWriter, r *http.Request) {
	trimmed, err := TrimFS(diskDevice)
	if errors.Is(err, unix.EOPNOTSUPP) {
		fail(w, 501, err)
		return
	}
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]uint64{"trimmed": trimmed})
}

// TrimFS discards every free block of the file system mounted from dev and says how many bytes it trimmed (what the
// kernel counted: ext4 skips groups it trimmed before since the mount, and reports what it discarded).
func TrimFS(dev string) (uint64, error) {
	mount, err := mountOf(dev)
	if err != nil {
		return 0, err
	}
	dir, err := os.Open(mount)
	if err != nil {
		return 0, err
	}
	defer dir.Close()
	rng := fstrimRange{len: ^uint64(0)}
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, dir.Fd(), fiTrim, uintptr(unsafe.Pointer(&rng))); errno != 0 {
		return 0, fmt.Errorf("trim %s: %w", mount, errno)
	}
	return rng.len, nil
}

// deviceBytes is a block device's capacity as the kernel sees it.
func deviceBytes(dev string) (uint64, error) {
	f, err := os.Open(dev)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	var bytes uint64
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, f.Fd(), unix.BLKGETSIZE64, uintptr(unsafe.Pointer(&bytes))); errno != 0 {
		return 0, fmt.Errorf("%s size: %w", dev, errno)
	}
	return bytes, nil
}

// mountOf is where dev is mounted, from /proc/self/mounts.
func mountOf(dev string) (string, error) {
	f, err := os.Open("/proc/self/mounts")
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) >= 3 && fields[0] == dev && fields[2] == "ext4" {
			// Octal escapes (\040 for a space) don't occur in Kantel's mount points.
			return fields[1], nil
		}
	}
	return "", fmt.Errorf("%s is not mounted as ext4", dev)
}
