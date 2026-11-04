package guest

import (
	"bufio"
	"fmt"
	"net/http"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

// diskDevice is the sandbox's own disk; the image is /dev/vda, read-only.
const diskDevice = "/dev/vdb"

// ext4ResizeFS is EXT4_IOC_RESIZE_FS, _IOW('f', 16, __u64): grow a mounted ext4 to a number of blocks, as resize2fs
// does online.
const ext4ResizeFS = 0x40086610

func (s *Server) growDisk(w http.ResponseWriter, _ *http.Request) {
	if err := GrowFS(diskDevice); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// GrowFS grows the ext4 file system mounted from dev to fill the device, online (resize2fs without the tool, which an
// image needn't have). Nothing to do when it already does.
func GrowFS(dev string) error {
	mount, err := mountOf(dev)
	if err != nil {
		return err
	}
	f, err := os.Open(dev)
	if err != nil {
		return err
	}
	var bytes uint64
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, f.Fd(), unix.BLKGETSIZE64, uintptr(unsafe.Pointer(&bytes)))
	f.Close()
	if errno != 0 {
		return fmt.Errorf("%s size: %w", dev, errno)
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
