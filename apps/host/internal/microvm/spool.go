package microvm

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

// spool makes memory snapshots fast: Firecracker writes a VM's memory to a file in RAM (tmpfs), which takes about a
// second for 2 GiB where a busy disk can take fifteen, and the stop or fork returns. A worker then copies the file
// to disk (sparsely: zero pages take no space) and swaps it in where the symlinks were. A VM restored from a spooled
// file maps it privately, so it keeps working when the file moves; the RAM is freed when the last VM using it stops.
//
// After a reboot the spool is empty and its symlinks dangle: a sandbox whose memory hadn't reached the disk yet
// boots from its disk instead (its processes restart; its files are kept).
type spool struct {
	dir string
	max int64
	log *slog.Logger

	// mu also orders the symlinks' replacements: place, link and flush's check-and-rename hold it, so a flush never
	// renames an older memory file over a newer stop's symlink (the next restore would pair the new VM state with
	// the old memory, and the guest would hang).
	mu      sync.Mutex
	used    int64
	targets map[string][]string // spool file -> the symlinks that point at it
	// charged is what each spool file counts for in used, given back when it goes: its reservation, not its length
	// (a shared template's sandbox's memory file spans its whole hotplug region, mostly holes).
	charged map[string]int64
	queue   chan string

	beforeRename func(target string) // tests: called after the copy, before the lock is taken to rename
}

func newSpool(dir string, maxBytes int64, log *slog.Logger) *spool {
	if dir == "" || maxBytes <= 0 {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Warn("no memory spool", "dir", dir, "error", err)
		return nil
	}
	sp := &spool{dir: dir, max: maxBytes, log: log, targets: map[string][]string{}, charged: map[string]int64{}, queue: make(chan string, 1024)}
	go sp.worker()
	return sp
}

// reserve returns a path in the spool for a memory file of n bytes, or "" when the spool is full (write to disk
// directly instead).
func (sp *spool) reserve(n int64) string {
	if sp == nil {
		return ""
	}
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if sp.used+n > sp.max {
		return ""
	}
	sp.used += n
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	path := filepath.Join(sp.dir, hex.EncodeToString(b)+".mem")
	sp.targets[path] = nil
	sp.charged[path] = n
	return path
}

// cancel gives back a reservation whose file was never written.
func (sp *spool) cancel(path string) {
	if sp == nil || path == "" {
		return
	}
	sp.mu.Lock()
	delete(sp.targets, path)
	sp.release(path)
	sp.mu.Unlock()
	_ = os.Remove(path)
}

// release gives back what path was charged, once. Called with mu held.
func (sp *spool) release(path string) {
	sp.used -= sp.charged[path]
	delete(sp.charged, path)
}

// place points target at the spooled file and queues the file for the disk. Call it once per spooled file, after
// Firecracker has written it.
func (sp *spool) place(path, target string) error {
	sp.mu.Lock()
	_ = os.Remove(target)
	if err := os.Symlink(path, target); err != nil {
		sp.mu.Unlock()
		return err
	}
	sp.targets[path] = append(sp.targets[path], target)
	sp.mu.Unlock()
	sp.queue <- path
	return nil
}

// link makes dst the same memory file as src: a hard link once on disk, another symlink while it's spooled.
func (sp *spool) link(src, dst string) error {
	if sp != nil {
		if path, err := os.Readlink(src); err == nil && strings.HasPrefix(path, sp.dir+"/") {
			sp.mu.Lock()
			if _, pending := sp.targets[path]; pending {
				_ = os.Remove(dst)
				if err := os.Symlink(path, dst); err != nil {
					sp.mu.Unlock()
					return err
				}
				sp.targets[path] = append(sp.targets[path], dst)
				sp.mu.Unlock()
				return nil
			}
			sp.mu.Unlock()
		}
	}
	return os.Link(src, dst)
}

func (sp *spool) worker() {
	for path := range sp.queue {
		sp.flush(path)
	}
}

// flush copies one spooled file to disk once (beside the first of its targets still pointing at it), hard-links
// that copy over each such target, and frees the RAM.
func (sp *spool) flush(path string) {
	var copied string // the disk copy, a hidden file the targets are hard-linked to
	defer func() {
		if copied != "" {
			_ = os.Remove(copied)
		}
	}()
	for {
		sp.mu.Lock()
		targets := sp.targets[path]
		sp.mu.Unlock()
		for _, target := range targets {
			if dest, err := os.Readlink(target); err != nil || dest != path {
				continue // deleted or replaced meanwhile
			}
			tmp := target + ".spool"
			if copied == "" {
				dst := filepath.Join(filepath.Dir(target), "."+filepath.Base(path)+".copy")
				if err := copySparse(path, dst); err != nil {
					sp.log.Warn("memory spool: couldn't copy to disk", "file", path, "error", err)
					_ = os.Remove(dst)
					continue
				}
				copied = dst
			}
			_ = os.Remove(tmp)
			if err := os.Link(copied, tmp); err != nil {
				if copySparse(path, tmp) != nil {
					_ = os.Remove(tmp)
					continue
				}
			}
			if sp.beforeRename != nil {
				sp.beforeRename(target)
			}
			// The copy took seconds: the target may have moved on to a newer stop's memory meanwhile.
			sp.mu.Lock()
			if dest, err := os.Readlink(target); err != nil || dest != path {
				sp.mu.Unlock()
				_ = os.Remove(tmp)
				continue
			}
			if err := os.Rename(tmp, target); err != nil {
				_ = os.Remove(tmp)
			}
			sp.mu.Unlock()
		}
		// A link made while copying is another symlink to place: go round again for it.
		sp.mu.Lock()
		if len(sp.targets[path]) == len(targets) {
			delete(sp.targets, path)
			sp.release(path)
			sp.mu.Unlock()
			break
		}
		sp.mu.Unlock()
	}
	_ = os.Remove(path)
}

// adopt re-queues the spooled files the symlinks under root point at, after the daemon restarts (not the
// machine: tmpfs would be empty).
func (sp *spool) adopt(paths []string) {
	if sp == nil {
		return
	}
	for _, target := range paths {
		dest, err := os.Readlink(target)
		if err != nil || !strings.HasPrefix(dest, sp.dir+"/") {
			continue
		}
		info, err := os.Stat(dest)
		if err != nil {
			continue
		}
		sp.mu.Lock()
		_, known := sp.targets[dest]
		if !known {
			// What it takes in RAM: a sparse file's holes take none.
			n := info.Size()
			if st, ok := info.Sys().(*syscall.Stat_t); ok {
				n = st.Blocks * 512
			}
			sp.charged[dest] = n
			sp.used += n
		}
		sp.targets[dest] = append(sp.targets[dest], target)
		sp.mu.Unlock()
		if !known {
			sp.queue <- dest
		}
	}
}

// adoptMapped counts again, after the daemon restarts, a spooled file a running fork still maps (Manager.keepMapped):
// what it takes in RAM, until it is cancelled when the fork's machine exits. It is never queued for the disk. False when
// path isn't a file of this spool.
func (sp *spool) adoptMapped(path string) bool {
	if sp == nil || !strings.HasPrefix(path, sp.dir+"/") {
		return false
	}
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	n := info.Size()
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		n = st.Blocks * 512
	}
	sp.mu.Lock()
	defer sp.mu.Unlock()
	if _, known := sp.charged[path]; !known {
		sp.charged[path] = n
		sp.used += n
	}
	return true
}

// tmpfs reports whether dir is on a RAM file system.
func tmpfs(dir string) bool {
	var st syscall.Statfs_t
	if syscall.Statfs(dir, &st) != nil {
		return false
	}
	return st.Type == 0x01021994 // TMPFS_MAGIC
}
