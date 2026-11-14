package microvm

// Saved snapshots as disk store objects (docs/design/disk-store.md, "Phase 3 notes"): snapshots/<id>/ is kind
// snapshot, its ID the snapshot's, in two versions, one for each of its block-mapped files. SnapshotDisk is disk.ext4,
// with its record (meta.json) beside it, taken whole; SnapshotMemory is mem, with Firecracker's machine state (state)
// beside it. Each saved snapshot gets its files' maps beside them, disk.map and mem.map, once it is saved (or, for one
// saved before maps, when the host starts), and every capacity report lists those with maps, so the control plane
// knows which hosts hold each. Automatic snapshots are the host's own history, and never objects.
//
// A peer fetches a snapshot's disk (internal/disksync) into snapshot-fetches/<id>/disk.partial. Its disk is an
// overlay's upper layer, so before that the host makes sure it has the root image the disk is over
// (PrepareSnapshotFetch): the host image version, downloaded from its release, or the template's root filesystem,
// fetched from a peer. Its record, made this host's (its root filesystem the path here, without its memory), is staged
// beside the partial as meta.json, which keeps that image while the fetch goes on. Published, the directory becomes
// snapshots/<id>/, a snapshot as any other, marked to cold-boot (ColdBoot) when the snapshot it is a copy of has memory.
// Its memory comes after it, into mem.partial, only when this host restores it (WantsSnapshotMemory): the same CPU
// fingerprint and the same portable runtime. Published, the memory is in place first and the record says so last.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A saved snapshot's versions (proto.SnapshotDiskVersion, proto.SnapshotMemoryVersion), and their small files.
const (
	SnapshotDisk   = proto.SnapshotDiskVersion
	SnapshotMemory = proto.SnapshotMemoryVersion
	// SnapshotRecordFile names a snapshot's record (meta.json) among its disk's small files.
	SnapshotRecordFile = "record"
	// SnapshotStateFile names the machine's state (state) among its memory's small files.
	SnapshotStateFile = "state"
)

// snapshotFetchesDir, under the tier's root, has a directory for each snapshot being fetched: its partial files, their
// bitmaps, and its record as it is staged.
const snapshotFetchesDir = "snapshot-fetches"

// ErrNoSnapshotImage is PrepareSnapshotFetch's answer for a snapshot whose root image this host can't have.
var ErrNoSnapshotImage = errors.New("this host can't have the root image the snapshot's disk is over")

// snapshotMaps is the snapshots' maps being made, or waiting their turn (one at a time, as each reads whole files),
// and the digests of those made, by map file, as read when it had that size and time.
type snapshotMaps struct {
	mu      sync.Mutex
	making  map[string]bool
	digests map[string]stickyDigest
	turn    sync.Mutex
}

// snapshotObject says whether id and version name a saved snapshot's version as an object.
func snapshotObject(id, version string) bool {
	return validID(id) && (version == SnapshotDisk || version == SnapshotMemory)
}

// snapshotFile is the file of a snapshot's version in its directory, and its map beside it.
func snapshotFile(version string) (file, mapFile string) {
	if version == SnapshotMemory {
		return "mem", "mem.map"
	}
	return fc.DiskFile, "disk.map"
}

func (m *Manager) snapshotFetchDir(id string) string {
	return filepath.Join(m.cfg.Root, snapshotFetchesDir, id)
}

// partialFile is a fetch's partial file of a version, in the snapshot's fetch directory.
func (m *Manager) snapshotPartialPath(id, version string) string {
	if version == SnapshotMemory {
		return filepath.Join(m.snapshotFetchDir(id), "mem.partial")
	}
	return filepath.Join(m.snapshotFetchDir(id), "disk.partial")
}

// stagedSnapshotPath is the record of a snapshot being fetched, made this host's (PrepareSnapshotFetch).
func (m *Manager) stagedSnapshotPath(id string) string {
	return filepath.Join(m.snapshotFetchDir(id), "meta.json")
}

// savedSnapshot is a snapshot the host serves and syncs: a saved one, not a live fork's own.
func (m *Manager) savedSnapshot(id string) (snapshotMeta, bool) {
	if !validID(id) {
		return snapshotMeta{}, false
	}
	snap, err := m.readSnapshot(id)
	if err != nil || snap.Kind != "saved" || snap.Transient || snap.ID != id {
		return snapshotMeta{}, false
	}
	return snap, true
}

// HoldsSnapshot says whether the host has a saved snapshot's version: its disk, or its memory.
func (m *Manager) HoldsSnapshot(id, version string) bool {
	if !snapshotObject(id, version) {
		return false
	}
	snap, ok := m.savedSnapshot(id)
	if !ok || (version == SnapshotMemory && !snap.Memory) {
		return false
	}
	file, _ := snapshotFile(version)
	return fileExists(filepath.Join(m.snapshotDir(id), file))
}

// OpenSnapshot opens a saved snapshot's version for a peer to fetch (disksync.Source): its file, and with withMap its
// map's file. fs.ErrNotExist when the host doesn't have it, or has no map of it yet. Open, the file stays readable
// whatever is deleted after.
func (m *Manager) OpenSnapshot(id, version string, withMap bool) (*os.File, []byte, error) {
	if !m.HoldsSnapshot(id, version) {
		return nil, nil, fs.ErrNotExist
	}
	file, mapFile := snapshotFile(version)
	dir := m.snapshotDir(id)
	f, err := os.Open(filepath.Join(dir, file))
	if err != nil {
		return nil, nil, err
	}
	var raw []byte
	if withMap {
		raw, err = os.ReadFile(filepath.Join(dir, mapFile))
	} else {
		_, err = os.Stat(filepath.Join(dir, mapFile))
	}
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, raw, nil
}

// ReadSnapshotFile reads one of a saved snapshot's small files for a peer: its disk's record (SnapshotRecordFile), or
// its memory's machine state (SnapshotStateFile). A record over a template's root filesystem says which build of it
// this host has (RootfsDigest, its map's digest): two hosts may each have built one under the key, with other bytes.
func (m *Manager) ReadSnapshotFile(id, version, name string) ([]byte, error) {
	if !m.HoldsSnapshot(id, version) {
		return nil, fs.ErrNotExist
	}
	switch {
	case version == SnapshotDisk && name == SnapshotRecordFile:
		raw, err := os.ReadFile(filepath.Join(m.snapshotDir(id), "meta.json"))
		if err != nil {
			return nil, err
		}
		var snap snapshotMeta
		if json.Unmarshal(raw, &snap) != nil {
			return raw, nil
		}
		if key, ok := templateRootfsKey(snap.Rootfs); ok && snap.RootfsDigest == "" {
			if snap.RootfsDigest = m.rootfsMapDigest(key); snap.RootfsDigest != "" {
				raw, _ = json.MarshalIndent(snap, "", "  ")
			}
		}
		return raw, nil
	case version == SnapshotMemory && name == SnapshotStateFile:
		return os.ReadFile(filepath.Join(m.snapshotDir(id), "state"))
	}
	return nil, fs.ErrNotExist
}

// PrepareSnapshotFetch readies the host for a fetch of a snapshot's disk, from its record as its holder has it: the
// root image its disk is over in place (localRootfs), and its record staged as this host's (its root filesystem this
// host's path, its memory not here yet). ErrNoSnapshotImage, or why the image couldn't be had, when the host can't
// have it: its disk is no use here.
func (m *Manager) PrepareSnapshotFetch(ctx context.Context, id string, record []byte) error {
	if !validID(id) {
		return &proto.Error{Code: proto.ErrInvalid, Message: "bad snapshot ID"}
	}
	if m.HoldsSnapshot(id, SnapshotDisk) {
		return nil
	}
	var snap snapshotMeta
	if err := json.Unmarshal(record, &snap); err != nil {
		return fmt.Errorf("the snapshot's record: %w", err)
	}
	if snap.ID != id || snap.Kind != "saved" || snap.Transient {
		return fmt.Errorf("the record of snapshot %s isn't a saved snapshot's", id)
	}
	rootfs, err := m.localRootfs(ctx, snap)
	if err != nil {
		return err
	}
	staged := snap
	staged.Rootfs, staged.Base = rootfs, images.VersionOf(rootfs)
	// Its memory isn't here: a sandbox made from it boots on its disk until it is (WantsSnapshotMemory).
	staged.ColdBoot = snap.Memory || snap.ColdBoot
	staged.Memory = false
	raw, _ := json.MarshalIndent(staged, "", "  ")
	// Under the base lock, as a snapshot's save names its base: a prune sees the image in use from here (BasesUnder),
	// and one that took it meanwhile is found here.
	defer m.holdBases()()
	if !fileExists(rootfs) {
		return fmt.Errorf("%w: %s went while the fetch was made ready", ErrNoSnapshotImage, rootfs)
	}
	if err := os.MkdirAll(m.snapshotFetchDir(id), 0o700); err != nil {
		return err
	}
	return fsutil.WriteFileDurably(m.stagedSnapshotPath(id), raw, 0o600)
}

// localRootfs is this host's file of the root image a snapshot's disk is over, put in place when it hasn't it: a
// template's root filesystem (images/templates/<key>.ext4) fetched from a peer (Config.FetchRootfs), or a host image
// version downloaded (Config.HostImage). A host image that isn't versioned is this host's own image only when the
// two are the same image, as their portable runtimes say (runtimeImage: the digest recorded when it was downloaded).
func (m *Manager) localRootfs(ctx context.Context, snap snapshotMeta) (string, error) {
	rootfs := snap.Rootfs
	if key, ok := templateRootfsKey(rootfs); ok {
		// The same build: two hosts that each built one under the key before they synced hold other bytes.
		if snap.RootfsDigest == "" {
			return "", fmt.Errorf("%w: its holder has no map of template root filesystem %s yet, so which build it is can't be told", ErrNoSnapshotImage, key)
		}
		path := m.tpl.rootfs.path(key)
		if !fileExists(path) {
			if m.cfg.FetchRootfs == nil {
				return "", fmt.Errorf("%w: it is template root filesystem %s, which this host doesn't fetch", ErrNoSnapshotImage, key)
			}
			if err := m.cfg.FetchRootfs(ctx, key); err != nil {
				return "", fmt.Errorf("%w: template root filesystem %s: %w", ErrNoSnapshotImage, key, err)
			}
		}
		if have := m.rootfsMapDigest(key); have != snap.RootfsDigest {
			return "", fmt.Errorf("%w: this host's template root filesystem %s is another build (map %q, not %s), or isn't mapped yet",
				ErrNoSnapshotImage, key, have, snap.RootfsDigest)
		}
		return path, nil
	}
	if version := images.VersionOf(rootfs); version != "" {
		if m.cfg.HostImage == nil {
			return "", fmt.Errorf("%w: it is host image %s, and this host doesn't keep its images by version", ErrNoSnapshotImage, version)
		}
		path, err := m.cfg.HostImage(ctx, version)
		if err != nil {
			return "", fmt.Errorf("%w: host image %s: %w", ErrNoSnapshotImage, version, err)
		}
		return path, nil
	}
	want := runtimePart(snap.Runtime, "image")
	if have, ok := m.runtimeImage(m.cfg.Rootfs); ok && want != "" && have == want {
		return m.cfg.Rootfs, nil
	}
	return "", fmt.Errorf("%w: its host's image (%q) can't be told to be this host's", ErrNoSnapshotImage, want)
}

// templateRootfsKey is the key of a template's root filesystem at path on any host (.../images/templates/<key>.ext4).
func templateRootfsKey(path string) (string, bool) {
	dir := filepath.Dir(filepath.Clean(path))
	key, ok := strings.CutSuffix(filepath.Base(path), ".ext4")
	if !ok || filepath.Base(dir) != "templates" || filepath.Base(filepath.Dir(dir)) != "images" || !validKey(key) {
		return "", false
	}
	return key, true
}

// runtimePart is one field of a portable runtime (portableRuntime), such as its image: "" when it has none.
func runtimePart(runtime, name string) string {
	for _, part := range strings.Split(runtime, ";") {
		if value, ok := strings.CutPrefix(part, name+"="); ok {
			return value
		}
	}
	return ""
}

// WantsSnapshotMemory says whether the host is to fetch a snapshot's memory: it holds the snapshot's disk as a copy
// whose memory is elsewhere (ColdBoot), and restores it (restoresMemoryOf).
func (m *Manager) WantsSnapshotMemory(id string) bool {
	snap, ok := m.savedSnapshot(id)
	return ok && snap.ColdBoot && !snap.Memory && m.restoresMemoryOf(snap) == nil
}

// restoresMemoryOf says why the host can't restore a snapshot's memory, or nil when it can: the same CPU (Kantel sets
// no Firecracker CPU template), and the snapshot's portable runtime the one this host has for its root image. A
// snapshot whose machine had bundle images or sticky disks on its drives isn't restored on another host either: their
// files stay on the host it was made on, and its guest has them mounted.
func (m *Manager) restoresMemoryOf(snap snapshotMeta) error {
	if !snap.CPU.Same(m.CPU()) {
		return errors.New("its CPU fingerprint isn't this host's")
	}
	if snap.Runtime == "" || snap.Runtime != m.portableRuntime(m.snapshotRootfs(snap)) {
		return errors.New("its runtime isn't this host's")
	}
	// A template's root filesystem is no part of the runtime: its build is told by its map (PrepareSnapshotFetch).
	if key, ok := templateRootfsKey(snap.Rootfs); ok && (snap.RootfsDigest == "" || m.rootfsMapDigest(key) != snap.RootfsDigest) {
		return errors.New("its template root filesystem isn't the build this host has")
	}
	if slices.ContainsFunc(snap.BundleSlots, func(d string) bool { return d != "" }) {
		return errors.New("its machine had bundle images on its drives")
	}
	if len(attachedSticky(snap.StickyDisks)) > 0 {
		return errors.New("its machine had sticky disks")
	}
	return nil
}

// SnapshotPartial is where a fetch of a snapshot's version writes, its directory made: its disk once its fetch is made
// ready (PrepareSnapshotFetch), its memory once the host holds its disk and wants it (WantsSnapshotMemory).
func (m *Manager) SnapshotPartial(id, version string) (string, error) {
	if !snapshotObject(id, version) {
		return "", fmt.Errorf("bad snapshot ID or version")
	}
	switch version {
	case SnapshotDisk:
		if !fileExists(m.stagedSnapshotPath(id)) {
			return "", fmt.Errorf("snapshot %s's fetch wasn't made ready: its root image may not be here", id)
		}
	case SnapshotMemory:
		if !m.WantsSnapshotMemory(id) {
			return "", fmt.Errorf("this host doesn't restore snapshot %s's memory, or doesn't hold its disk", id)
		}
		if err := os.MkdirAll(m.snapshotFetchDir(id), 0o700); err != nil {
			return "", err
		}
	}
	return m.snapshotPartialPath(id, version), nil
}

// ReserveSnapshotFetch holds room for the bytes a fetch of a snapshot's version is to write, beside every other copy
// the host makes, until release: refused (ErrCapacity) when that would leave the host less than snapshotHeadroom free.
func (m *Manager) ReserveSnapshotFetch(bytes int64) (release func(), err error) {
	return m.reserveRoom(bytes, func(free, size int64) error {
		return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf(
			"This host has %s of disk free, and fetching a snapshot writes %s and must leave %s free.",
			gibText(max(free, 0)), gibText(size), gibText(snapshotHeadroom))}
	})
}

// PublishFetchedSnapshot makes a fetched partial file, written through partial, a snapshot's version, with its map
// and its small files. Its disk: a directory of the file, its map and the staged record becomes snapshots/<id>/ in one
// rename. Its memory: the machine's state, the file and its map go into the snapshot's directory, then its record says
// it has memory. A version the host has already is kept, and the partial dropped; a partial removed meanwhile isn't
// published.
func (m *Manager) PublishFetchedSnapshot(id, version string, partial *os.File, mapFile []byte, files map[string][]byte) error {
	if !snapshotObject(id, version) {
		return fmt.Errorf("bad snapshot ID or version")
	}
	// The record names a base, as a save's does; and not while a keep or a delete is under way (autoMu).
	defer m.holdBases()()
	m.autoMu.Lock()
	defer m.autoMu.Unlock()
	path := m.snapshotPartialPath(id, version)
	mine, err := partial.Stat()
	if err != nil {
		return err
	}
	if version == SnapshotDisk {
		if _, err := os.Lstat(m.snapshotDir(id)); err == nil {
			m.discardSnapshotPartial(id, version)
			return nil
		}
	} else if m.HoldsSnapshot(id, SnapshotMemory) {
		m.discardSnapshotPartial(id, version)
		return nil
	}
	if !sameFileAt(mine, path) {
		return fmt.Errorf("the fetch of snapshot %s's %s was removed before it was published", id, version)
	}
	if version == SnapshotDisk {
		err = m.publishSnapshotDisk(id, path, mapFile)
	} else {
		err = m.publishSnapshotMemory(id, path, mapFile, files[SnapshotStateFile])
	}
	if err != nil {
		return err
	}
	m.discardSnapshotPartial(id, version)
	return nil
}

func (m *Manager) publishSnapshotDisk(id, path string, mapFile []byte) error {
	raw, err := os.ReadFile(m.stagedSnapshotPath(id))
	if err != nil {
		return fmt.Errorf("snapshot %s's staged record: %w", id, err)
	}
	var snap snapshotMeta
	if err := json.Unmarshal(raw, &snap); err != nil {
		return fmt.Errorf("snapshot %s's staged record: %w", id, err)
	}
	if !fileExists(m.snapshotRootfs(snap)) {
		return fmt.Errorf("%w: %s is gone", ErrNoSnapshotImage, m.snapshotRootfs(snap))
	}
	staging := filepath.Join(m.snapshotFetchDir(id), "new")
	_ = os.RemoveAll(staging)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return err
	}
	fail := func(err error) error {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := os.Rename(path, filepath.Join(staging, fc.DiskFile)); err != nil {
		return fail(err)
	}
	if err := fsutil.WriteFileDurably(filepath.Join(staging, "disk.map"), mapFile, 0o600); err != nil {
		return fail(err)
	}
	snap.SizeBytes, snap.UniqueBytes, snap.Shared = snapshotBytes(staging), 0, nil
	raw, _ = json.MarshalIndent(snap, "", "  ")
	if err := fsutil.WriteFileDurably(filepath.Join(staging, "meta.json"), raw, 0o600); err != nil {
		return fail(err)
	}
	if err := os.MkdirAll(filepath.Join(m.cfg.Root, "snapshots"), 0o700); err != nil {
		return fail(err)
	}
	// Whole, in one rename: a snapshot's directory is never seen half made.
	if err := os.Rename(staging, m.snapshotDir(id)); err != nil {
		return fail(err)
	}
	return syncDir(filepath.Join(m.cfg.Root, "snapshots"))
}

func (m *Manager) publishSnapshotMemory(id, path string, mapFile, state []byte) error {
	snap, ok := m.savedSnapshot(id)
	if !ok {
		return fmt.Errorf("the host no longer holds snapshot %s's disk", id)
	}
	if len(state) == 0 {
		return fmt.Errorf("snapshot %s's holder gave no machine state with its memory", id)
	}
	dir := m.snapshotDir(id)
	// The machine's state, the memory and its map first; the record says it has memory last, so a stop in between
	// leaves a snapshot that boots on its disk, with files its next fetch replaces.
	if err := fsutil.WriteFileDurably(filepath.Join(dir, "state"), state, 0o600); err != nil {
		return err
	}
	if err := os.Rename(path, filepath.Join(dir, "mem")); err != nil {
		return err
	}
	if err := fsutil.WriteFileDurably(filepath.Join(dir, "mem.map"), mapFile, 0o600); err != nil {
		return err
	}
	if err := syncDir(dir); err != nil {
		return err
	}
	snap.Memory, snap.ColdBoot = true, false
	snap.SizeBytes = snapshotBytes(dir)
	raw, _ := json.MarshalIndent(snap, "", "  ")
	return fsutil.WriteFileDurably(filepath.Join(dir, "meta.json"), raw, 0o600)
}

// SnapshotPartials are the fetches of snapshots' versions left unfinished, by ID and version: a disk's from when its
// fetch was made ready (its record staged), whether or not it had begun writing; a memory's from when the host holds
// the disk and wants the memory (WantsSnapshotMemory), so one whose first try came before its holder had it goes on.
func (m *Manager) SnapshotPartials() [][2]string {
	out := m.snapshotFetchPartials()
	snaps, _ := scanSnapshotsIn(m.cfg.Root)
	for _, snap := range snaps {
		if !snap.ColdBoot || snap.Memory || snap.Kind != "saved" || !validID(snap.ID) || m.restoresMemoryOf(snap) != nil {
			continue
		}
		if p := [2]string{snap.ID, SnapshotMemory}; !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	return out
}

func (m *Manager) snapshotFetchPartials() [][2]string {
	entries, err := os.ReadDir(filepath.Join(m.cfg.Root, snapshotFetchesDir))
	if err != nil {
		return nil
	}
	var out [][2]string
	for _, e := range entries {
		if !e.IsDir() || !validID(e.Name()) {
			continue
		}
		for _, version := range []string{SnapshotDisk, SnapshotMemory} {
			info, err := os.Lstat(m.snapshotPartialPath(e.Name(), version))
			if (err == nil && info.Mode().IsRegular()) || (version == SnapshotDisk && fileExists(m.stagedSnapshotPath(e.Name()))) {
				out = append(out, [2]string{e.Name(), version})
			}
		}
	}
	return out
}

// DiscardSnapshotPartial removes a fetch's partial file and its bitmap, and for its disk the staged record; with no
// other partial left, the snapshot's whole fetch directory.
func (m *Manager) DiscardSnapshotPartial(id, version string) {
	if !snapshotObject(id, version) {
		return
	}
	defer m.holdBases()()
	m.autoMu.Lock()
	defer m.autoMu.Unlock()
	m.discardSnapshotPartial(id, version)
}

// discardSnapshotPartial is DiscardSnapshotPartial, with autoMu held.
func (m *Manager) discardSnapshotPartial(id, version string) {
	partial := m.snapshotPartialPath(id, version)
	paths := []string{partial, partial + ".done"}
	if version == SnapshotDisk {
		paths = append(paths, m.stagedSnapshotPath(id))
	}
	for _, path := range paths {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			m.log.Warn("removing a snapshot's partial fetch", "path", path, "error", err)
		}
	}
	other := SnapshotMemory
	if version == SnapshotMemory {
		other = SnapshotDisk
	}
	if !fileExists(m.snapshotPartialPath(id, other)) {
		_ = os.RemoveAll(m.snapshotFetchDir(id))
	}
}

// SnapshotHoldings are the saved snapshots' versions the host holds with a map, by snapshot ID: [] when none. Nil,
// which a report leaves out, when they can't all be read: the control plane takes one missing from a report as gone.
func (m *Manager) SnapshotHoldings() []proto.ObjectHolding {
	out := []proto.ObjectHolding{}
	snaps, err := scanSnapshotsIn(m.cfg.Root)
	if err != nil {
		// Not in full: a snapshot it couldn't read would be taken as gone.
		m.log.Warn("snapshot holdings left out of the report: they can't all be read", "error", err)
		return nil
	}
	for _, snap := range snaps {
		if snap.Kind != "saved" || snap.Transient || !validID(snap.ID) {
			continue
		}
		var versions []proto.ObjectVersionHolding
		for _, version := range []string{SnapshotDisk, SnapshotMemory} {
			if version == SnapshotMemory && !snap.Memory {
				continue
			}
			file, mapFile := snapshotFile(version)
			digest := m.snapshotMapDigest(filepath.Join(m.snapshotDir(snap.ID), mapFile))
			if digest == "" {
				continue
			}
			versions = append(versions, proto.ObjectVersionHolding{
				Version: version, MapDigest: digest, AllocatedBytes: diskUsage(filepath.Join(m.snapshotDir(snap.ID), file)),
			})
		}
		if len(versions) > 0 {
			out = append(out, proto.ObjectHolding{ObjectID: snap.ID, Versions: versions})
		}
	}
	return out
}

// snapshotMapDigest is a snapshot's map file's digest, "" when there is none (yet), read again only when it changes.
func (m *Manager) snapshotMapDigest(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	s := &m.snapshotMaps
	s.mu.Lock()
	cached, ok := s.digests[path]
	s.mu.Unlock()
	if ok && cached.size == info.Size() && cached.modTime.Equal(info.ModTime()) {
		return cached.digest
	}
	_, digest, err := blockmap.ReadFile(path)
	if err != nil {
		return ""
	}
	s.mu.Lock()
	if s.digests == nil {
		s.digests = map[string]stickyDigest{}
	}
	s.digests[path] = stickyDigest{size: info.Size(), modTime: info.ModTime(), digest: digest}
	s.mu.Unlock()
	return digest
}

// mapSnapshotLater makes a saved snapshot's maps in the background, under the tier's own context, after any being
// made, unless they are being made: a save and a keep ask for them, and the host when it starts for those saved before
// maps. Not on a Manager made without New (tests), which has no background of its own to end.
func (m *Manager) mapSnapshotLater(id string) {
	s := &m.snapshotMaps
	if m.bg == nil || !validID(id) {
		return
	}
	s.mu.Lock()
	if s.making[id] {
		s.mu.Unlock()
		return
	}
	if s.making == nil {
		s.making = map[string]bool{}
	}
	s.making[id] = true
	s.mu.Unlock()
	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.making, id)
			s.mu.Unlock()
		}()
		s.turn.Lock()
		defer s.turn.Unlock()
		if err := m.mapSnapshot(m.background(), id); err != nil && !errors.Is(err, fs.ErrNotExist) && m.background().Err() == nil {
			m.log.Warn("a saved snapshot's block maps couldn't be made", "snapshot", id, "error", err)
		}
	}()
}

// mapSnapshot makes the maps a saved snapshot hasn't: its disk's, and its memory's when it has memory. A snapshot's
// files never change once it is made, so a map is good for as long as the snapshot is there; one deleted meanwhile
// gets none.
func (m *Manager) mapSnapshot(ctx context.Context, id string) error {
	snap, ok := m.savedSnapshot(id)
	if !ok {
		return nil
	}
	dir := m.snapshotDir(id)
	for _, version := range []string{SnapshotDisk, SnapshotMemory} {
		if version == SnapshotMemory && !snap.Memory {
			continue
		}
		file, mapFile := snapshotFile(version)
		if fileExists(filepath.Join(dir, mapFile)) {
			continue
		}
		if err := m.mapSnapshotFile(ctx, id, filepath.Join(dir, file), filepath.Join(dir, mapFile)); err != nil {
			return fmt.Errorf("its %s: %w", version, err)
		}
	}
	return nil
}

func (m *Manager) mapSnapshotFile(ctx context.Context, id, path, mapPath string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	start := time.Now()
	bm, st, err := blockmap.Make(ctx, f, nil)
	if err != nil {
		return err
	}
	// Not into a snapshot deleted meanwhile (autoMu: a delete holds it).
	m.autoMu.Lock()
	defer m.autoMu.Unlock()
	if _, ok := m.savedSnapshot(id); !ok {
		return nil
	}
	if _, err := blockmap.WriteFile(mapPath, bm); err != nil {
		return err
	}
	m.log.Info("saved snapshot mapped", "snapshot", id, "file", filepath.Base(path), "blocks", st.Blocks, "empty", st.Empty,
		"read", st.Read, "took", time.Since(start).Round(time.Millisecond))
	return nil
}

// mapOldSnapshots starts the maps of the saved snapshots made before maps, and of those whose maps a stop cut short.
func (m *Manager) mapOldSnapshots() {
	snaps, _ := scanSnapshotsIn(m.cfg.Root)
	for _, snap := range snaps {
		if snap.Kind != "saved" || snap.Transient {
			continue
		}
		dir := m.snapshotDir(snap.ID)
		if !fileExists(filepath.Join(dir, "disk.map")) || (snap.Memory && !fileExists(filepath.Join(dir, "mem.map"))) {
			m.mapSnapshotLater(snap.ID)
		}
	}
}
