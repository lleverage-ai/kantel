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
	"path/filepath"
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

// A freeze is a lease the agent holds, not a state the host must end: it thaws the file system by itself once the
// lease lapses, so a host that dies (or a call abandoned) between a freeze and its thaw never leaves the sandbox's disk
// frozen. A freeze of a path already frozen under a lease renews it. The frozen paths are kept in stickyFrozenFile too,
// so an agent that restarts while one is frozen thaws it (thawLeftoverFreezes).
const (
	// DefaultStickyLease is a freeze's lease when the host names none; MaxStickyLease the longest it may ask.
	DefaultStickyLease = 30 * time.Second
	MaxStickyLease     = 2 * time.Minute
	stickyFrozenFile   = "/run/kantel/sticky-frozen.json"
)

// stickyFreezeRequest is POST /sticky/freeze's and /sticky/thaw's body.
type stickyFreezeRequest struct {
	Path string `json:"path"`
	// LeaseMs is how long the freeze holds before the agent thaws it by itself (freeze only; 0: DefaultStickyLease).
	LeaseMs int64 `json:"leaseMs,omitempty"`
}

// frozen are the paths frozen under a lease, each with the timer that thaws it. Guarded by stickyMu.
var frozen = map[string]*time.Timer{}

func (s *Server) freezeSticky(w http.ResponseWriter, r *http.Request) {
	s.stickyIoctl(w, r, true)
}

func (s *Server) thawSticky(w http.ResponseWriter, r *http.Request) {
	s.stickyIoctl(w, r, false)
}

// stickyIoctl freezes (after a sync, under a lease) or thaws the file system mounted at the request's path, which must
// be a drive's (never the root's or the system's own). Thawing one that isn't frozen is fine.
func (s *Server) stickyIoctl(w http.ResponseWriter, r *http.Request, freeze bool) {
	var req stickyFreezeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	if err := CheckMountPath(req.Path); err != nil {
		fail(w, 400, err)
		return
	}
	lease := time.Duration(req.LeaseMs) * time.Millisecond
	if lease <= 0 {
		lease = DefaultStickyLease
	}
	if lease > MaxStickyLease {
		fail(w, 400, fmt.Errorf("a freeze's lease is at most %s", MaxStickyLease))
		return
	}
	stickyMu.Lock()
	defer stickyMu.Unlock()
	if source := mountPoints()[req.Path]; !strings.HasPrefix(source, "/dev/vd") {
		fail(w, 404, fmt.Errorf("no sticky disk is mounted at %s", req.Path))
		return
	}
	if !freeze {
		if err := thawLocked(req.Path); err != nil {
			fail(w, 500, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if timer, ok := frozen[req.Path]; ok {
		// Frozen already under a lease: renewed.
		timer.Reset(lease)
		writeJSON(w, 200, map[string]any{"ok": true, "leaseMs": lease.Milliseconds()})
		return
	}
	if err := ioctlPath(req.Path, true); err != nil {
		fail(w, 500, err)
		return
	}
	path := req.Path
	frozen[path] = time.AfterFunc(lease, func() {
		stickyMu.Lock()
		defer stickyMu.Unlock()
		if _, ok := frozen[path]; ok {
			_ = thawLocked(path)
		}
	})
	writeFrozen()
	writeJSON(w, 200, map[string]any{"ok": true, "leaseMs": lease.Milliseconds()})
}

// thawLocked thaws path and ends its lease. Called with stickyMu held.
func thawLocked(path string) error {
	if timer, ok := frozen[path]; ok {
		timer.Stop()
		delete(frozen, path)
		writeFrozen()
	}
	return ioctlPath(path, false)
}

// ioctlPath syncs and freezes, or thaws, the file system at path. Thawing one that isn't frozen (EINVAL) is fine.
func ioctlPath(path string, freeze bool) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if !freeze {
		if err := unix.IoctlSetInt(fd, fiThaw, 0); err != nil && !errors.Is(err, unix.EINVAL) {
			return fmt.Errorf("thaw %s: %w", path, err)
		}
		return nil
	}
	if err := unix.Syncfs(fd); err != nil {
		return fmt.Errorf("sync %s: %w", path, err)
	}
	if err := unix.IoctlSetInt(fd, fiFreeze, 0); err != nil {
		return fmt.Errorf("freeze %s: %w", path, err)
	}
	return nil
}

// writeFrozen records the paths frozen now (stickyFrozenFile). Called with stickyMu held.
func writeFrozen() {
	if len(frozen) == 0 {
		_ = os.Remove(stickyFrozenFile)
		return
	}
	paths := make([]string, 0, len(frozen))
	for p := range frozen {
		paths = append(paths, p)
	}
	raw, _ := json.Marshal(paths)
	_ = os.MkdirAll(filepath.Dir(stickyFrozenFile), 0o755)
	_ = os.WriteFile(stickyFrozenFile, raw, 0o600)
}

// thawLeftoverFreezes thaws what an earlier run of the agent froze and didn't thaw: its leases ended with it.
func thawLeftoverFreezes() {
	raw, err := os.ReadFile(stickyFrozenFile)
	if err != nil {
		return
	}
	var paths []string
	_ = json.Unmarshal(raw, &paths)
	for _, p := range paths {
		if CheckMountPath(p) == nil {
			_ = ioctlPath(p, false)
		}
	}
	_ = os.Remove(stickyFrozenFile)
}
