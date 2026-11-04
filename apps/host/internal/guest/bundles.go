package guest

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// bundleState records the bundles the agent has mounted, by path, so a repeated POST /bundles (every resume and
// start sends one) keeps a mount that's already right. It is in /run, so it goes with a cold boot, as the mounts do,
// and comes back with a restored memory snapshot, as they do.
const bundleState = "/run/kantel/bundles.json"

type mountedBundle struct {
	Drive  int    `json:"drive"`
	Digest string `json:"digest"`
}

// bundlesMu is one POST /bundles at a time.
var bundlesMu sync.Mutex

func (s *Server) mountBundles(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Mounts []BundleMount `json:"mounts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	bundlesMu.Lock()
	defer bundlesMu.Unlock()
	state := readBundleState()
	want := map[string]bool{}
	for _, b := range req.Mounts {
		want[b.Path] = true
	}
	// A bundle mounted before that the sandbox no longer has (a sandbox made from another's snapshot).
	for path := range state {
		if !want[path] {
			_ = unix.Unmount(path, unix.MNT_DETACH)
			delete(state, path)
		}
	}
	results := make([]BundleResult, 0, len(req.Mounts))
	for _, b := range req.Mounts {
		res := BundleResult{Path: b.Path}
		if err := mountBundle(b, state); err != nil {
			res.Error = err.Error()
		}
		results = append(results, res)
	}
	if err := writeBundleState(state); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"mounts": results})
}

func mountBundle(b BundleMount, state map[string]mountedBundle) error {
	// The same paths as a bucket mount's (mounts.go).
	if err := CheckMountPath(b.Path); err != nil {
		return err
	}
	if b.Drive < 0 || b.Drive > 20 {
		return fmt.Errorf("no bundle drive %d", b.Drive)
	}
	dev := BundleDevice(b.Drive)
	mounts := mountPoints()
	if had, ok := state[b.Path]; ok {
		if had.Drive == b.Drive && had.Digest == b.Digest && mounts[b.Path] == dev {
			return nil
		}
		_ = unix.Unmount(b.Path, unix.MNT_DETACH)
		delete(state, b.Path)
	}
	if err := waitDeviceSize(dev, b.Bytes, 10*time.Second); err != nil {
		return err
	}
	// Drop anything read from the drive before it was this image (the empty file a VM is made with, or another
	// bundle's image on a sandbox made from a snapshot).
	if fd, err := unix.Open(dev, unix.O_RDONLY|unix.O_CLOEXEC, 0); err == nil {
		_ = unix.IoctlSetInt(fd, unix.BLKFLSBUF, 0)
		_ = unix.Close(fd)
	}
	if info, err := os.Lstat(b.Path); err == nil && !info.IsDir() {
		return fmt.Errorf("%s is already there and isn't a directory", b.Path)
	}
	if err := os.MkdirAll(b.Path, 0o755); err != nil {
		return err
	}
	// Read-only, so a write under it fails with EROFS, root's too; no device files or set-user-ID; programs run.
	if err := unix.Mount(dev, b.Path, "erofs", unix.MS_RDONLY|unix.MS_NODEV|unix.MS_NOSUID, ""); err != nil {
		if errors.Is(err, unix.ENODEV) {
			return errors.New("this sandbox's kernel has no erofs: its host's images predate bundle mounts")
		}
		return fmt.Errorf("mount %s at %s: %w", dev, b.Path, err)
	}
	state[b.Path] = mountedBundle{Drive: b.Drive, Digest: b.Digest}
	return nil
}

// waitDeviceSize waits for dev to be size bytes: the host has just pointed its drive at the bundle's image, and the
// kernel learns the new size from the device's config change a moment later.
func waitDeviceSize(dev string, size int64, timeout time.Duration) error {
	sysfs := "/sys/block/" + filepath.Base(dev) + "/size"
	deadline := time.Now().Add(timeout)
	var have int64 = -1
	for {
		if raw, err := os.ReadFile(sysfs); err == nil {
			sectors, _ := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
			have = sectors * 512
			if have == size || (size <= 0 && have > 0) {
				return nil
			}
		}
		if time.Now().After(deadline) {
			if have < 0 {
				return fmt.Errorf("this sandbox has no %s", dev)
			}
			return fmt.Errorf("%s is %d bytes, not the bundle image's %d", dev, have, size)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// mountPoints is what is mounted where, by mount point: the source of the topmost mount at each.
func mountPoints() map[string]string {
	raw, err := os.ReadFile("/proc/self/mountinfo")
	out := map[string]string{}
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(raw), "\n") {
		// id parent major:minor root mountpoint options [optional...] - fstype source superoptions
		fields := strings.Fields(line)
		if len(fields) < 10 {
			continue
		}
		sep := -1
		for i := 6; i < len(fields); i++ {
			if fields[i] == "-" {
				sep = i
				break
			}
		}
		if sep < 0 || sep+2 >= len(fields) {
			continue
		}
		out[unescapeMountinfo(fields[4])] = unescapeMountinfo(fields[sep+2])
	}
	return out
}

// unescapeMountinfo undoes mountinfo's octal escapes (\040 for a space).
func unescapeMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func readBundleState() map[string]mountedBundle {
	state := map[string]mountedBundle{}
	raw, err := os.ReadFile(bundleState)
	if err == nil {
		_ = json.Unmarshal(raw, &state)
	}
	return state
}

func writeBundleState(state map[string]mountedBundle) error {
	if len(state) == 0 {
		if err := os.Remove(bundleState); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(bundleState), 0o755); err != nil {
		return err
	}
	raw, _ := json.Marshal(state)
	tmp := bundleState + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, bundleState)
}
