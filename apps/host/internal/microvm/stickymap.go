package microvm

// Block maps of sticky disk versions (docs/design/disk-store.md, 2b): each version the host holds gets its map beside
// it, sticky/<disk>/<version>.map, which other hosts will compare with their own to fetch only the blocks that differ.
// A commit makes its version's map from the map of the version its sandbox's copy came from (or another the host holds),
// reading only the blocks whose extents the two files don't share, and answers its digest (mapDigest) when it is made
// within stickyMapWait; a longer one goes on in the background. Versions committed before maps get theirs in the
// background when the host starts, newest first. Every capacity report gives each version's map digest it has.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
)

// stickyMapWait is how long a commit waits for its version's map before it answers without its digest: with a commit
// queued behind another's freeze and clone, and its own, within the control plane's 120 seconds for a call.
var stickyMapWait = 45 * time.Second

func (m *Manager) stickyMapFile(diskID, version string) string {
	return filepath.Join(m.stickyRoot(), diskID, version+".map")
}

// stickyMapJob is a map being made: done closes when it is, with its digest or why not. cancel stops it (its version
// is gone, or replaced).
type stickyMapJob struct {
	done   chan struct{}
	cancel context.CancelFunc
	digest string
	err    error
}

// stickyDigest is a map file's digest, as read when the file had that size and time.
type stickyDigest struct {
	size    int64
	modTime time.Time
	digest  string
}

// background is the context the tier's own background work runs under, ended by Close.
func (m *Manager) background() context.Context {
	if m.bg == nil {
		return context.Background() // a Manager made without New (tests)
	}
	return m.bg
}

// StickyMapDigest waits up to stickyMapWait (or until ctx ends) for the map of a version a commit has just made
// (CommitSticky starts it), and answers its digest: "" when it isn't made by then, as it goes on in the background, or
// couldn't be made.
//
// It also ends the version's pin (pinStickyAnswer): once its commit is answered, the control plane records it, and the
// host may prune it as any other.
func (m *Manager) StickyMapDigest(ctx context.Context, diskID, version string) string {
	if !validID(diskID) || !validID(version) {
		return ""
	}
	defer m.unpinStickyAnswer(diskID, version)
	m.stickyMapMu.Lock()
	job := m.stickyMaps[diskID+"/"+version]
	m.stickyMapMu.Unlock()
	if job == nil {
		// Made already, or never started.
		return m.stickyMapDigest(diskID, version)
	}
	timer := time.NewTimer(stickyMapWait)
	defer timer.Stop()
	var err error
	select {
	case <-job.done:
		if job.err == nil {
			return job.digest
		}
		err = job.err
	case <-timer.C:
		err = fmt.Errorf("not made within %s; it goes on in the background", stickyMapWait)
	case <-ctx.Done():
		err = ctx.Err()
	}
	m.log.Warn("a committed sticky disk version's map", "disk", diskID, "version", version, "error", err)
	return ""
}

// startStickyMap makes a version's map in the background, under the tier's own context, unless it is being made already:
// then it answers that one.
func (m *Manager) startStickyMap(diskID, version, parent string) *stickyMapJob {
	key := diskID + "/" + version
	m.stickyMapMu.Lock()
	defer m.stickyMapMu.Unlock()
	if job := m.stickyMaps[key]; job != nil {
		return job
	}
	if m.stickyMaps == nil {
		m.stickyMaps = map[string]*stickyMapJob{}
	}
	ctx, cancel := context.WithCancel(m.background())
	job := &stickyMapJob{done: make(chan struct{}), cancel: cancel}
	m.stickyMaps[key] = job
	hold := m.holdMaps
	go func() {
		defer cancel()
		job.digest, job.err = m.mapSticky(ctx, diskID, version, parent, hold)
		m.stickyMapMu.Lock()
		// Unless a delete, or a new commit of the name, let it go already (forgetStickyMap).
		if m.stickyMaps[key] == job {
			delete(m.stickyMaps, key)
		}
		m.stickyMapMu.Unlock()
		close(job.done)
	}()
	return job
}

// mapHold (tests) holds block maps: each says its version on opened once its files are open, then waits for release
// to close.
type mapHold struct {
	opened  chan string
	release chan struct{}
}

func newMapHold() *mapHold {
	return &mapHold{opened: make(chan string, 8), release: make(chan struct{})}
}

// mapSticky makes a version's map and writes it beside the version, answering its digest. Its base is the map of
// parent (the version its sandbox's copy came from), else of the newest other version the host holds that has one:
// only blocks whose extents the version doesn't share with the base's file are read. A version deleted meanwhile gets
// no map. hold (tests), when set, holds it once its files are open.
func (m *Manager) mapSticky(ctx context.Context, diskID, version, parent string, hold *mapHold) (string, error) {
	f, base, err := m.openStickyForMap(diskID, version, parent)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if base != nil {
		defer base.File.Close()
	}
	if hold != nil {
		hold.opened <- version
		<-hold.release
	}
	start := time.Now()
	bm, st, err := blockmap.Make(ctx, f, base)
	if err != nil {
		return "", err
	}
	m.stickyMu.Lock()
	defer m.stickyMu.Unlock()
	// Still the file it read: not deleted, nor deleted and committed again.
	now, err := os.Stat(m.stickyVersionFile(diskID, version))
	if err != nil {
		return "", err
	}
	if info, err := f.Stat(); err != nil || !os.SameFile(info, now) {
		return "", errors.New("the version was replaced while its map was made")
	}
	digest, err := blockmap.WriteFile(m.stickyMapFile(diskID, version), bm)
	if err != nil {
		return "", err
	}
	m.log.Info("sticky disk version mapped", "disk", diskID, "version", version, "blocks", st.Blocks, "reused", st.Reused,
		"empty", st.Empty, "read", st.Read, "bytesRead", st.BytesRead, "took", time.Since(start).Round(time.Millisecond))
	return digest, nil
}

// openStickyForMap opens a version's file, and the base its map is made from (nil: none), read-locked so neither is
// removed meanwhile; open, each stays readable whatever is deleted after.
func (m *Manager) openStickyForMap(diskID, version, parent string) (*os.File, *blockmap.Base, error) {
	m.stickyMu.RLock()
	defer m.stickyMu.RUnlock()
	f, err := os.Open(m.stickyVersionFile(diskID, version))
	if err != nil {
		return nil, nil, err
	}
	candidates := []string{}
	if parent != "" {
		candidates = append(candidates, parent)
	}
	for _, v := range m.stickyVersions(diskID) {
		candidates = append(candidates, v.version)
	}
	for _, c := range candidates {
		if c == version || !validID(c) {
			continue
		}
		bm, _, err := blockmap.ReadFile(m.stickyMapFile(diskID, c))
		if err != nil {
			continue
		}
		bf, err := os.Open(m.stickyVersionFile(diskID, c))
		if err != nil {
			continue
		}
		if info, err := bf.Stat(); err != nil || info.Size() != bm.Size {
			bf.Close()
			continue
		}
		return f, &blockmap.Base{File: bf, Map: bm}, nil
	}
	return f, nil, nil
}

// removeStickyMap removes a version's map, with the version or before it is committed (one an older version of that
// name left). Called with stickyMu held.
func (m *Manager) removeStickyMap(diskID, version string) {
	if err := os.Remove(m.stickyMapFile(diskID, version)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		m.log.Warn("deleting a sticky disk version's map", "disk", diskID, "version", version, "error", err)
	}
	m.forgetStickyMap(diskID, version)
}

// stickyMapDigest is a version's map's digest, "" when it has none (yet), read again only when the file changes.
func (m *Manager) stickyMapDigest(diskID, version string) string {
	path := m.stickyMapFile(diskID, version)
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	key := diskID + "/" + version
	m.stickyMapMu.Lock()
	cached, ok := m.stickyDigests[key]
	m.stickyMapMu.Unlock()
	if ok && cached.size == info.Size() && cached.modTime.Equal(info.ModTime()) {
		return cached.digest
	}
	_, digest, err := blockmap.ReadFile(path)
	if err != nil {
		return ""
	}
	m.stickyMapMu.Lock()
	if m.stickyDigests == nil {
		m.stickyDigests = map[string]stickyDigest{}
	}
	m.stickyDigests[key] = stickyDigest{size: info.Size(), modTime: info.ModTime(), digest: digest}
	m.stickyMapMu.Unlock()
	return digest
}

// forgetStickyMap lets go of a version's map being made and its cached digest, or with no version every one of the
// disk's: the version is gone, or a new one of the name is being committed, whose map is made afresh. A map still being
// made of the old file finds it gone and writes nothing.
func (m *Manager) forgetStickyMap(diskID, version string) {
	m.stickyMapMu.Lock()
	defer m.stickyMapMu.Unlock()
	mine := func(key string) bool {
		d, v, _ := strings.Cut(key, "/")
		return d == diskID && (version == "" || v == version)
	}
	for key := range m.stickyDigests {
		if mine(key) {
			delete(m.stickyDigests, key)
		}
	}
	for key, job := range m.stickyMaps {
		if mine(key) {
			job.cancel()
			delete(m.stickyMaps, key)
		}
	}
}

// pinStickyAnswer keeps a version just published from being pruned until its commit is answered (StickyMapDigest
// unpins it), or, should that never come, past the longest the answer waits: a commit answered after a later commit
// had pruned it would make the control plane's head a version no host has. Called with stickyMu held.
func (m *Manager) pinStickyAnswer(diskID, version string) {
	if m.stickyAnswering == nil {
		m.stickyAnswering = map[string]time.Time{}
	}
	m.stickyAnswering[diskID+"/"+version] = time.Now().Add(stickyMapWait + time.Minute)
}

func (m *Manager) unpinStickyAnswer(diskID, version string) {
	m.stickyMu.Lock()
	defer m.stickyMu.Unlock()
	delete(m.stickyAnswering, diskID+"/"+version)
}

// stickyPinned says whether a version's commit is still to be answered (pinStickyAnswer). Called with stickyMu held.
func (m *Manager) stickyPinned(diskID, version string) bool {
	until, ok := m.stickyAnswering[diskID+"/"+version]
	if ok && time.Now().After(until) {
		delete(m.stickyAnswering, diskID+"/"+version)
		return false
	}
	return ok
}

// mapOldSticky makes the maps of the versions the host holds without one (committed before maps, or whose map was
// still being made when the host stopped), one at a time, newest first, until ctx ends. The answer is closed when it
// is done (tests wait on it).
func (m *Manager) mapOldSticky(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		entries, err := os.ReadDir(m.stickyRoot())
		if err != nil {
			return
		}
		type unmapped struct {
			diskID string
			v      stickyVersion
		}
		var todo []unmapped
		for _, e := range entries {
			if !e.IsDir() || !validID(e.Name()) {
				continue
			}
			for _, v := range m.stickyVersions(e.Name()) {
				if !fileExists(m.stickyMapFile(e.Name(), v.version)) {
					todo = append(todo, unmapped{e.Name(), v})
				}
			}
		}
		sort.SliceStable(todo, func(i, j int) bool { return todo[i].v.at > todo[j].v.at })
		for _, u := range todo {
			if ctx.Err() != nil {
				return
			}
			job := m.startStickyMap(u.diskID, u.v.version, "")
			select {
			case <-job.done:
			case <-ctx.Done():
				return
			}
			if job.err != nil && !errors.Is(job.err, fs.ErrNotExist) {
				m.log.Warn("making an older sticky disk version's map", "disk", u.diskID, "version", u.v.version, "error", job.err)
			}
		}
	}()
	return done
}
