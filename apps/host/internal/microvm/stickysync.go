package microvm

// Sticky disk versions fetched from the host's peers (docs/design/disk-store.md, "2c. Peer sync"; internal/disksync
// fetches them): a fetch writes sticky/<disk>/<version>.partial, made from the host's nearest version of the disk, with
// a bitmap of the blocks in place beside it (<version>.partial.done), and publishes it as the version with its map.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
)

// stickyPartialSuffix ends a fetch's file; its bitmap's adds stickyDoneSuffix.
const (
	stickyPartialSuffix = ".partial"
	stickyDoneSuffix    = ".done"
)

func (m *Manager) stickyPartialFile(diskID, version string) string {
	return filepath.Join(m.stickyRoot(), diskID, version+stickyPartialSuffix)
}

// HoldsSticky says whether the host holds a version of a disk.
func (m *Manager) HoldsSticky(diskID, version string) bool {
	return validID(diskID) && validID(version) && fileExists(m.stickyVersionFile(diskID, version))
}

// StickyPartial is where a fetch of a version writes, the disk's directory made.
func (m *Manager) StickyPartial(diskID, version string) (string, error) {
	if !validID(diskID) || !validID(version) {
		return "", fmt.Errorf("bad sticky disk ID or version")
	}
	m.stickyMu.Lock()
	defer m.stickyMu.Unlock()
	if err := os.MkdirAll(filepath.Join(m.stickyRoot(), diskID), 0o700); err != nil {
		return "", err
	}
	return m.stickyPartialFile(diskID, version), nil
}

// CloneNearestSticky makes dst a clone of the newest version of the disk the host holds with a map (a version other
// than the one fetched), and answers that map; nil, without making dst, when it holds none. The version is opened
// read-locked, so it isn't pruned before it is open, and cloned after: a long copy holds up no create or commit. A
// reflink takes no room; a full copy reserves its room first.
func (m *Manager) CloneNearestSticky(diskID, version, dst string) (*blockmap.Map, error) {
	src, bm, from := m.openNearestSticky(diskID, version)
	if src == nil {
		return nil, nil
	}
	defer src.Close()
	if fsutil.ReflinkFrom(src, dst) != nil {
		// A full copy, by name: a version is never replaced under its name, so cp copies the file opened, or fails
		// if it was deleted meanwhile.
		_ = os.Remove(dst)
		path := m.stickyVersionFile(diskID, from)
		release, err := m.reserveStickyCopy(path)
		if err != nil {
			return nil, err
		}
		defer release()
		if _, err := cloneDisk(path, dst); err != nil {
			_ = os.Remove(dst)
			return nil, err
		}
	}
	m.log.Info("a sticky disk version's fetch starts from the host's nearest version", "disk", diskID, "version", version, "from", from)
	return bm, nil
}

// openNearestSticky opens the newest version of the disk with a map other than version, read-locked, and reads its
// map: nil when there is none.
func (m *Manager) openNearestSticky(diskID, version string) (*os.File, *blockmap.Map, string) {
	m.stickyMu.RLock()
	defer m.stickyMu.RUnlock()
	for _, v := range m.stickyVersions(diskID) {
		if v.version == version {
			continue
		}
		bm, _, err := blockmap.ReadFile(m.stickyMapFile(diskID, v.version))
		if err != nil {
			continue
		}
		f, err := os.Open(m.stickyVersionFile(diskID, v.version))
		if err != nil {
			continue
		}
		if info, err := f.Stat(); err != nil || info.Size() != bm.Size {
			f.Close()
			continue
		}
		return f, bm, v.version
	}
	return nil, nil, ""
}

// PublishFetchedSticky makes a fetched partial file, written through partial, the disk's version, newest in its
// publication sequence, with its map's file beside it (the map first, so a version never goes without one), then
// prunes the disk to its stickyKeep newest versions. A version the host holds already is kept, and the partial dropped.
// A partial removed meanwhile (its version, or its disk, deleted) isn't published.
func (m *Manager) PublishFetchedSticky(diskID, version string, partial *os.File, mapFile []byte) error {
	m.stickyMu.Lock()
	defer m.stickyMu.Unlock()
	final := m.stickyVersionFile(diskID, version)
	if fileExists(final) {
		m.discardPartialLocked(diskID, version)
		return nil
	}
	path := m.stickyPartialFile(diskID, version)
	mine, err := partial.Stat()
	if err != nil {
		return err
	}
	if now, err := os.Stat(path); err != nil || !os.SameFile(mine, now) {
		return fmt.Errorf("the fetch of version %s of sticky disk %s was removed (deleted) before it was published", version, diskID)
	}
	m.forgetStickyMap(diskID, version)
	if err := fsutil.WriteFileDurably(m.stickyMapFile(diskID, version), mapFile, 0o600); err != nil {
		return err
	}
	if err := os.Link(path, final); err != nil {
		m.removeStickyMap(diskID, version)
		return err
	}
	if err := syncDir(filepath.Dir(final)); err != nil {
		_ = os.Remove(final)
		m.removeStickyMap(diskID, version)
		return err
	}
	now := time.Now()
	_ = os.Chtimes(final, now, now)
	order := m.readStickyOrder(diskID)
	order.Seq[version] = order.Next
	order.Next++
	if err := m.writeStickyOrder(diskID, order); err != nil {
		_ = os.Remove(final)
		m.removeStickyMap(diskID, version)
		return err
	}
	m.discardPartialLocked(diskID, version)
	m.pruneStickyLocked(diskID)
	return nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// StickyPartials are the fetches of sticky disk versions left unfinished, as [disk, version].
func (m *Manager) StickyPartials() [][2]string {
	var out [][2]string
	disks, err := os.ReadDir(m.stickyRoot())
	if err != nil {
		return nil
	}
	for _, d := range disks {
		if !d.IsDir() || !validID(d.Name()) {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(m.stickyRoot(), d.Name()))
		if err != nil {
			continue
		}
		for _, e := range entries {
			version, ok := strings.CutSuffix(e.Name(), stickyPartialSuffix)
			if ok && e.Type().IsRegular() && validID(version) {
				out = append(out, [2]string{d.Name(), version})
			}
		}
	}
	return out
}

// DiscardStickyPartial removes a fetch's partial file and its bitmap.
func (m *Manager) DiscardStickyPartial(diskID, version string) {
	if !validID(diskID) || !validID(version) {
		return
	}
	m.stickyMu.Lock()
	defer m.stickyMu.Unlock()
	m.discardPartialLocked(diskID, version)
}

func (m *Manager) discardPartialLocked(diskID, version string) {
	partial := m.stickyPartialFile(diskID, version)
	for _, path := range []string{partial, partial + stickyDoneSuffix} {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			m.log.Warn("removing a sticky disk version's partial fetch", "path", path, "error", err)
		}
	}
}

// fetchingStickyLocked says whether a fetch of a version of the disk has a partial file. Called with stickyMu held.
func (m *Manager) fetchingStickyLocked(diskID string) bool {
	entries, _ := os.ReadDir(filepath.Join(m.stickyRoot(), diskID))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), stickyPartialSuffix) {
			return true
		}
	}
	return false
}
