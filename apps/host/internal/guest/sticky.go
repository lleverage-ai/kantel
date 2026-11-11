package guest

// Sticky disks: an organisation's named ext4 disks (caches a job warms and the next reuses), each sandbox with its own
// copy-on-write clone of one on a writable drive after its bundle drives (docs/design/disk-store.md). The host points
// the drive at the clone; the agent mounts it read-write (POST /sticky), and for a commit writes it back and freezes
// it (POST /sticky/freeze) while the host clones the drive's file, then thaws it (POST /sticky/thaw).

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// FIFREEZE and FITHAW are linux/fs.h's _IOWR('X', 119, int) and _IOWR('X', 120, int), the same on every architecture
// Kantel runs on; golang.org/x/sys doesn't name them.
const (
	fiFreeze = 0xc0045877
	fiThaw   = 0xc0045878
)

// stickyMu is one sticky disk call at a time.
var stickyMu sync.Mutex

func (s *Server) mountSticky(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Mounts []StickyMount `json:"mounts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	stickyMu.Lock()
	defer stickyMu.Unlock()
	results := make([]StickyResult, 0, len(req.Mounts))
	for _, m := range req.Mounts {
		res := StickyResult{Path: m.Path}
		if err := mountStickyDisk(m); err != nil {
			res.Error = err.Error()
		}
		results = append(results, res)
	}
	writeJSON(w, 200, map[string]any{"mounts": results})
}

// mountStickyDisk mounts the sticky disk on drive m.Drive read-write at m.Path, making the directory if it's missing.
// One already mounted there from that drive (a resume, or a sandbox restored from a snapshot's memory) is kept.
func mountStickyDisk(m StickyMount) error {
	if err := CheckMountPath(m.Path); err != nil {
		return err
	}
	if m.Drive < 0 || m.Drive > maxBundleDrive {
		return fmt.Errorf("no drive %d", m.Drive)
	}
	dev := BundleDevice(m.Drive)
	if mountPoints()[m.Path] == dev {
		return nil
	}
	if err := waitDeviceSize(dev, m.Bytes, 10*time.Second); err != nil {
		return err
	}
	// Drop anything read from the drive before it was this disk (the empty file a VM is made with).
	f, err := os.OpenFile(dev, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	_ = unix.IoctlSetInt(int(f.Fd()), unix.BLKFLSBUF, 0)
	label, err := ext4Label(f)
	f.Close()
	if err != nil {
		return fmt.Errorf("%s: %w", dev, err)
	}
	if label != StickyLabel {
		return fmt.Errorf("%s isn't a sticky disk (its label is %q)", dev, label)
	}
	if info, err := os.Lstat(m.Path); err == nil && !info.IsDir() {
		return fmt.Errorf("%s is already there and isn't a directory", m.Path)
	}
	if err := os.MkdirAll(m.Path, 0o755); err != nil {
		return err
	}
	if err := unix.Mount(dev, m.Path, "ext4", 0, ""); err != nil {
		return fmt.Errorf("mount %s at %s: %w", dev, m.Path, err)
	}
	return nil
}

// ext4Label is the volume label of the ext4 file system r holds: its superblock is at 1024, with the magic 0xEF53 at
// 0x38 and the label's 16 bytes at 0x78.
func ext4Label(r io.ReaderAt) (string, error) {
	sb := make([]byte, 0x78+16)
	if _, err := r.ReadAt(sb, 1024); err != nil {
		return "", fmt.Errorf("reading its superblock: %w", err)
	}
	if binary.LittleEndian.Uint16(sb[0x38:]) != 0xEF53 {
		return "", errors.New("it has no ext4 file system")
	}
	return strings.TrimRight(string(sb[0x78:]), "\x00"), nil
}

type stickyPath struct {
	Path string `json:"path"`
}

func (s *Server) freezeSticky(w http.ResponseWriter, r *http.Request) {
	s.stickyIoctl(w, r, true)
}

func (s *Server) thawSticky(w http.ResponseWriter, r *http.Request) {
	s.stickyIoctl(w, r, false)
}

// stickyIoctl freezes (after a sync) or thaws the file system mounted at the request's path, which must be a drive's
// (never the root's or the system's own). Thawing one that isn't frozen is fine.
func (s *Server) stickyIoctl(w http.ResponseWriter, r *http.Request, freeze bool) {
	var req stickyPath
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	if err := CheckMountPath(req.Path); err != nil {
		fail(w, 400, err)
		return
	}
	stickyMu.Lock()
	defer stickyMu.Unlock()
	if source := mountPoints()[req.Path]; !strings.HasPrefix(source, "/dev/vd") {
		fail(w, 404, fmt.Errorf("no sticky disk is mounted at %s", req.Path))
		return
	}
	fd, err := unix.Open(req.Path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer unix.Close(fd)
	if freeze {
		if err := unix.Syncfs(fd); err != nil {
			fail(w, 500, fmt.Errorf("sync %s: %w", req.Path, err))
			return
		}
		if err := unix.IoctlSetInt(fd, fiFreeze, 0); err != nil {
			fail(w, 500, fmt.Errorf("freeze %s: %w", req.Path, err))
			return
		}
	} else if err := unix.IoctlSetInt(fd, fiThaw, 0); err != nil && !errors.Is(err, unix.EINVAL) {
		fail(w, 500, fmt.Errorf("thaw %s: %w", req.Path, err))
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
