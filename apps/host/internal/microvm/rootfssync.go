package microvm

// Templates' root filesystems as disk store objects (docs/design/disk-store.md, "Phase 3 notes"): images/templates/
// <key>.ext4 is kind rootfs, its ID the key, in one version (RootfsVersion), as the file never changes once it is made.
// Each gets its block map beside it, <key>.map, once it is made (or, for one made before maps, when the host starts),
// and every capacity report lists those with a map, so the control plane knows which hosts hold each. A peer fetches
// one (internal/disksync) into <key>.partial, with a bitmap of the blocks in place beside it (<key>.partial.done), and
// takes its record (<key>.json, which names the image it was made from) whole; published, the partial becomes
// <key>.ext4 and the record is written after it, as a build writes them. Each is stamped with the pool it was made in
// (<key>.pool: a build's pool as it began, a fetch's as it began), which reports carry, so it is offered only there.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// RootfsVersion is the one version of a root filesystem.
const RootfsVersion = "1"

// RootfsRecordFile names a root filesystem's record (<key>.json) among its version's small files.
const RootfsRecordFile = "record"

const (
	rootfsPartialSuffix = ".partial"
	rootfsDoneSuffix    = ".done"
)

// ErrNoPeerRootfs is Config.FetchRootfs's answer when no host the fetch may reach holds the root filesystem.
var ErrNoPeerRootfs = errors.New("no host in the pool holds the root filesystem")

// fetchRootfsFirst has a build's root filesystem fetched from a peer that holds it (Config.FetchRootfs) when the host
// hasn't it, so the build boots that rather than pulling or building the image again; one no peer holds, or whose fetch
// fails, the build makes itself. It answers whether the root filesystem came from a peer, and the build's own end (its
// context's error) when that came first: then nothing is built, and the fetch goes on for the next build.
func (m *Manager) fetchRootfsFirst(ctx context.Context, key string) (bool, error) {
	if m.cfg.FetchRootfs == nil || !validKey(key) || fileExists(m.tpl.rootfs.path(key)) {
		return false, nil
	}
	start := time.Now()
	err := m.cfg.FetchRootfs(ctx, key)
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	switch {
	case err == nil && fileExists(m.tpl.rootfs.path(key)):
		m.log.Info("template root filesystem fetched from a peer", "key", key, "took", time.Since(start).Round(time.Millisecond))
		return true, nil
	case err == nil:
		m.log.Warn("a template root filesystem's fetch ended without it; building it here", "key", key)
	case errors.Is(err, ErrNoPeerRootfs):
		m.log.Info("no peer holds the template's root filesystem; building it here", "key", key)
	default:
		m.log.Warn("the template's root filesystem couldn't be fetched from a peer; building it here", "key", key, "error", err)
	}
	return false, nil
}

// rootfsMaps is the root filesystems' maps being made, or waiting their turn (one is made at a time, as each reads a
// whole file), and the digests of those made, as read when their file had that size and time.
type rootfsMaps struct {
	mu      sync.Mutex
	making  map[string]chan struct{}
	digests map[string]stickyDigest
	turn    sync.Mutex
}

func (b *rootfsBuilder) mapPath(key string) string    { return filepath.Join(b.dir, key+".map") }
func (b *rootfsBuilder) poolPath(key string) string   { return filepath.Join(b.dir, key+".pool") }
func (b *rootfsBuilder) recordPath(key string) string { return filepath.Join(b.dir, key+".json") }
func (b *rootfsBuilder) partialPath(key string) string {
	return filepath.Join(b.dir, key+rootfsPartialSuffix)
}

// currentPool is the pool the host is in now: "" while no welcome has said.
func (b *rootfsBuilder) currentPool() string {
	if b.pool == nil {
		return ""
	}
	return b.pool()
}

// stampPool records the pool a root filesystem was made in (<key>.pool), written before its map is made, so before any
// report lists it; with no pool, any stamp an older file of the key left goes.
func (b *rootfsBuilder) stampPool(key, pool string) {
	if pool == "" {
		_ = os.Remove(b.poolPath(key))
		return
	}
	_ = fsutil.WriteFileDurably(b.poolPath(key), []byte(pool), 0o600)
}

// stampedPool is the pool a root filesystem was made in, "" when it has no stamp.
func (b *rootfsBuilder) stampedPool(key string) string {
	raw, err := os.ReadFile(b.poolPath(key))
	if err != nil || len(raw) > 200 {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

// rootfsObject says whether key and version name a root filesystem as an object.
func rootfsObject(key, version string) bool { return validKey(key) && version == RootfsVersion }

// HoldsRootfs says whether the host has a root filesystem.
func (m *Manager) HoldsRootfs(key, version string) bool {
	return rootfsObject(key, version) && fileExists(m.tpl.rootfs.path(key))
}

// OpenRootfs opens a root filesystem the host holds for a peer to fetch (disksync.Source): its file, and with withMap
// its map's file. fs.ErrNotExist when the host doesn't have it, or has no map of it yet: one is served only once it
// has one. Open, the file stays readable whatever is deleted after.
func (m *Manager) OpenRootfs(key, version string, withMap bool) (*os.File, []byte, error) {
	if !rootfsObject(key, version) {
		return nil, nil, fs.ErrNotExist
	}
	b := m.tpl.rootfs
	f, err := os.Open(b.path(key))
	if err != nil {
		return nil, nil, err
	}
	var raw []byte
	if withMap {
		raw, err = os.ReadFile(b.mapPath(key))
	} else {
		_, err = os.Stat(b.mapPath(key))
	}
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	// Still the file the map is of: an entry thrown away (customCached) loses its map first.
	if mine, err := f.Stat(); err != nil || !sameFileAt(mine, b.path(key)) {
		f.Close()
		return nil, nil, fs.ErrNotExist
	}
	return f, raw, nil
}

func sameFileAt(info os.FileInfo, path string) bool {
	now, err := os.Stat(path)
	return err == nil && os.SameFile(info, now)
}

// ReadRootfsFile reads one of a root filesystem's small files for a peer: its record (RootfsRecordFile).
func (m *Manager) ReadRootfsFile(key, version, name string) ([]byte, error) {
	if !rootfsObject(key, version) || name != RootfsRecordFile || !m.HoldsRootfs(key, version) {
		return nil, fs.ErrNotExist
	}
	return os.ReadFile(m.tpl.rootfs.recordPath(key))
}

// RootfsPartial is where a fetch of a root filesystem writes, its directory made.
func (m *Manager) RootfsPartial(key, version string) (string, error) {
	if !rootfsObject(key, version) {
		return "", fmt.Errorf("bad root filesystem key or version")
	}
	b := m.tpl.rootfs
	if err := os.MkdirAll(b.dir, 0o700); err != nil {
		return "", err
	}
	// The pool the fetch began in, kept as it goes on (after a restart too): the copy is that pool's.
	stamp := b.partialPath(key) + ".pool"
	if !fileExists(b.partialPath(key)) {
		if pool := b.currentPool(); pool != "" {
			_ = fsutil.WriteFileDurably(stamp, []byte(pool), 0o600)
		} else {
			_ = os.Remove(stamp)
		}
	}
	return b.partialPath(key), nil
}

// ReserveRootfsFetch holds room for the bytes a fetch of a root filesystem is to write, beside every other copy the
// host makes, until release: refused (ErrCapacity) when that would leave the host less than snapshotHeadroom free.
func (m *Manager) ReserveRootfsFetch(bytes int64) (release func(), err error) {
	return m.reserveRoom(bytes, func(free, size int64) error {
		return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf(
			"This host has %s of disk free, and fetching a template's root filesystem writes %s and must leave %s free.",
			gibText(max(free, 0)), gibText(size), gibText(snapshotHeadroom))}
	})
}

// PublishFetchedRootfs makes a fetched partial file, written through partial, the root filesystem, under the key's
// lock (a build of it waits, then finds it made): the file, then its map, then its record when the holder had one (as
// a build writes the file and then its record). One the host has already is kept, and the partial dropped. A partial
// removed meanwhile isn't published.
func (m *Manager) PublishFetchedRootfs(key, version string, partial *os.File, mapFile []byte, files map[string][]byte) error {
	if !rootfsObject(key, version) {
		return fmt.Errorf("bad root filesystem key or version")
	}
	b := m.tpl.rootfs
	defer b.locks.lock(key)()
	if fileExists(b.path(key)) {
		m.discardRootfsPartial(key)
		return nil
	}
	path := b.partialPath(key)
	mine, err := partial.Stat()
	if err != nil {
		return err
	}
	if !sameFileAt(mine, path) {
		return fmt.Errorf("the fetch of root filesystem %s was removed before it was published", key)
	}
	// The file first, then its map: a map is never left without the file it describes (a stop between the two leaves
	// a file without one, which the host maps itself when it starts).
	_ = os.Remove(b.mapPath(key))
	// The pool the fetch began in goes with it (none, without a stamp).
	if err := os.Rename(path+".pool", b.poolPath(key)); err != nil {
		_ = os.Remove(b.poolPath(key))
	}
	if err := os.Rename(path, b.path(key)); err != nil {
		return err
	}
	if err := syncDir(b.dir); err != nil {
		return err
	}
	if err := fsutil.WriteFileDurably(b.mapPath(key), mapFile, 0o600); err != nil {
		m.log.Warn("a fetched root filesystem's map couldn't be written; it is made again", "key", key, "error", err)
		m.mapRootfsLater(key)
	}
	if record, ok := files[RootfsRecordFile]; ok {
		if err := fsutil.WriteFileDurably(b.recordPath(key), record, 0o600); err != nil {
			// A custom image's entry without its record is thrown away when it is next looked for (customCached), and
			// built again.
			m.log.Warn("a fetched root filesystem's record couldn't be written", "key", key, "error", err)
		}
	}
	m.discardRootfsPartial(key)
	return nil
}

// RootfsPartials are the fetches of root filesystems left unfinished, by key.
func (m *Manager) RootfsPartials() []string {
	entries, err := os.ReadDir(m.tpl.rootfs.dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		key, ok := strings.CutSuffix(e.Name(), rootfsPartialSuffix)
		if ok && e.Type().IsRegular() && validKey(key) {
			out = append(out, key)
		}
	}
	return out
}

// DiscardRootfsPartial removes a fetch's partial file and its bitmap.
func (m *Manager) DiscardRootfsPartial(key string) {
	if validKey(key) {
		m.discardRootfsPartial(key)
	}
}

func (m *Manager) discardRootfsPartial(key string) {
	partial := m.tpl.rootfs.partialPath(key)
	for _, path := range []string{partial, partial + rootfsDoneSuffix, partial + ".pool"} {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			m.log.Warn("removing a root filesystem's partial fetch", "path", path, "error", err)
		}
	}
}

// RootfsHoldings are the root filesystems the host holds with a map, by key: [] when none. Nil, which a report leaves
// out, when their directory can't be read: the control plane takes one missing from a report as gone.
func (m *Manager) RootfsHoldings() []proto.ObjectHolding {
	out := []proto.ObjectHolding{}
	b := m.tpl.rootfs
	entries, err := os.ReadDir(b.dir)
	if errors.Is(err, fs.ErrNotExist) {
		return out
	}
	if err != nil {
		m.log.Warn("root filesystem holdings left out of the report: their directory can't be read", "error", err)
		return nil
	}
	for _, e := range entries {
		key, ok := strings.CutSuffix(e.Name(), ".ext4")
		if !ok || !validKey(key) || !e.Type().IsRegular() {
			continue
		}
		digest := m.rootfsMapDigest(key)
		if digest == "" {
			continue
		}
		out = append(out, proto.ObjectHolding{ObjectID: key, Versions: []proto.ObjectVersionHolding{{
			Version: RootfsVersion, MapDigest: digest, AllocatedBytes: diskUsage(b.path(key)), Pool: b.stampedPool(key),
		}}})
	}
	return out
}

// rootfsMapDigest is a root filesystem's map's digest, "" when it has none (yet), read again only when the file
// changes.
func (m *Manager) rootfsMapDigest(key string) string {
	b := m.tpl.rootfs
	path := b.mapPath(key)
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	b.maps.mu.Lock()
	cached, ok := b.maps.digests[key]
	b.maps.mu.Unlock()
	if ok && cached.size == info.Size() && cached.modTime.Equal(info.ModTime()) {
		return cached.digest
	}
	_, digest, err := blockmap.ReadFile(path)
	if err != nil {
		return ""
	}
	b.maps.mu.Lock()
	if b.maps.digests == nil {
		b.maps.digests = map[string]stickyDigest{}
	}
	b.maps.digests[key] = stickyDigest{size: info.Size(), modTime: info.ModTime(), digest: digest}
	b.maps.mu.Unlock()
	return digest
}

// mapRootfsLater makes a root filesystem's map in the background, under the tier's own context, after any being made,
// unless it has one or it is being made: a build or a cache hit asks for it, so one made before maps gets one too. Not on a Manager made
// without New (tests), which has no background of its own to end.
func (m *Manager) mapRootfsLater(key string) {
	b := m.tpl.rootfs
	if m.bg == nil || !validKey(key) || fileExists(b.mapPath(key)) {
		return
	}
	b.maps.mu.Lock()
	if b.maps.making[key] != nil {
		b.maps.mu.Unlock()
		return
	}
	if b.maps.making == nil {
		b.maps.making = map[string]chan struct{}{}
	}
	done := make(chan struct{})
	b.maps.making[key] = done
	b.maps.mu.Unlock()
	go func() {
		defer func() {
			b.maps.mu.Lock()
			delete(b.maps.making, key)
			b.maps.mu.Unlock()
			close(done)
		}()
		b.maps.turn.Lock()
		defer b.maps.turn.Unlock()
		if fileExists(b.mapPath(key)) {
			return
		}
		// A file replaced while it was mapped (a build made it again) is mapped again: its build's own request found this
		// one under way.
		for tries := 0; ; tries++ {
			err := m.mapRootfs(m.background(), key)
			if errors.Is(err, errRootfsReplaced) && tries < 3 {
				continue
			}
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				m.log.Warn("a template's root filesystem's block map couldn't be made", "key", key, "error", err)
			}
			return
		}
	}()
}

// errRootfsReplaced is a map made of a file that was replaced or removed meanwhile, so not written.
var errRootfsReplaced = errors.New("the file was replaced while its map was made")

// mapRootfs makes a root filesystem's map and writes it beside the file, unless the file was replaced or removed
// meanwhile.
func (m *Manager) mapRootfs(ctx context.Context, key string) error {
	b := m.tpl.rootfs
	f, err := os.Open(b.path(key))
	if err != nil {
		return err
	}
	defer f.Close()
	start := time.Now()
	bm, st, err := blockmap.Make(ctx, f, nil)
	if err != nil {
		return err
	}
	// Under the key's lock, so a build or a fetch of the key doesn't replace the file between the check and the write.
	defer b.locks.lock(key)()
	if info, err := f.Stat(); err != nil || !sameFileAt(info, b.path(key)) {
		return errRootfsReplaced
	}
	if _, err := blockmap.WriteFile(b.mapPath(key), bm); err != nil {
		return err
	}
	m.log.Info("template root filesystem mapped", "key", key, "blocks", st.Blocks, "empty", st.Empty, "read", st.Read,
		"took", time.Since(start).Round(time.Millisecond))
	return nil
}

// mapOldRootfs starts the maps of the root filesystems made before maps.
func (m *Manager) mapOldRootfs() {
	entries, _ := os.ReadDir(m.tpl.rootfs.dir)
	for _, e := range entries {
		if key, ok := strings.CutSuffix(e.Name(), ".ext4"); ok && validKey(key) && e.Type().IsRegular() {
			m.mapRootfsLater(key)
		}
	}
}
