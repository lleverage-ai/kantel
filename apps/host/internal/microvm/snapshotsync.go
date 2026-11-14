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
// Its memory comes after it, into mem.partial, only when this host restores it (WantsSnapshot): the same CPU
// fingerprint and the same portable runtime. Published, the memory is in place first and the record says so last.
//
// The files on its machine's drives are versions of it too (proto.SnapshotBundleVersion, proto.SnapshotStickyVersion):
// each sticky disk's clone, sticky<k>.ext4 in its directory, and, for a snapshot with memory, each bundle image on its
// machine's drives then, its link bundle<i>.erofs, each mapped beside it (sticky<k>.map, bundle<i>.map). The guest has
// them mounted in its memory, so a copy's memory comes only once every one of them is here, the holder's bytes (never
// this host's own build of a bundle, which may differ): a copy fetches its sticky disks' clones, so a sandbox made from
// it has them however it starts, and, where it restores the memory, its bundle images, into <version>.partial; then the
// memory. Each fetch starts from this host's nearest file (CloneNearestSnapshot): the bundle's image in its cache, the
// sticky disk's version the clone was made from, so it takes only the blocks that differ.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/bundles"
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
	if version == SnapshotDisk || version == SnapshotMemory {
		return validID(id)
	}
	_, _, ok := snapshotDrive(version)
	return ok && validID(id)
}

// SnapshotVersion says whether version names one of a saved snapshot's versions: its disk, its memory, or the file on
// one of its machine's drives.
func SnapshotVersion(version string) bool {
	_, _, drive := snapshotDrive(version)
	return drive || version == SnapshotDisk || version == SnapshotMemory
}

// snapshotDrive reads a snapshot's drive version (proto.SnapshotBundleVersion, proto.SnapshotStickyVersion): whether
// it is a bundle drive's, and the drive's index.
func snapshotDrive(version string) (bundle bool, index int, ok bool) {
	rest, bundle := strings.CutPrefix(version, "bundle")
	if !bundle {
		if rest, ok = strings.CutPrefix(version, "sticky"); !ok {
			return false, 0, false
		}
	}
	n, err := strconv.Atoi(rest)
	if err != nil || n < 0 || n > 99 || strconv.Itoa(n) != rest {
		return false, 0, false
	}
	return bundle, n, true
}

// snapshotFile is the file of a snapshot's version in its directory, and its map beside it.
func snapshotFile(version string) (file, mapFile string) {
	if bundle, i, ok := snapshotDrive(version); ok {
		if bundle {
			return bundleDriveFile(i), version + ".map"
		}
		return stickyDriveFile(i), version + ".map"
	}
	if version == SnapshotMemory {
		return "mem", "mem.map"
	}
	return fc.DiskFile, "disk.map"
}

// snapshotDriveVersions are a saved snapshot's drive versions, as its record has them: its sticky disks' clones, then the
// bundle images on its machine's drives when its memory was taken (which a copy's record keeps, its memory elsewhere).
func snapshotDriveVersions(snap snapshotMeta) []string {
	var out []string
	for _, d := range attachedSticky(snap.StickyDisks) {
		if v := proto.SnapshotStickyVersion(d.Slot); !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	for i, digest := range snap.BundleSlots {
		if digest != "" && i < snap.BundleDrives {
			out = append(out, proto.SnapshotBundleVersion(i))
		}
	}
	return out
}

// snapshotVersions are the versions of a saved snapshot the host has the files of: its disk, its memory when its
// record says it has it, and each of its drives whose file is in its directory.
func (m *Manager) snapshotVersions(snap snapshotMeta) []string {
	var out []string
	for _, version := range append([]string{SnapshotDisk, SnapshotMemory}, snapshotDriveVersions(snap)...) {
		if version == SnapshotMemory && !snap.Memory {
			continue
		}
		file, _ := snapshotFile(version)
		if fileExists(filepath.Join(m.snapshotDir(snap.ID), file)) {
			out = append(out, version)
		}
	}
	return out
}

// snapshotDrivesHere says whether every one of a saved snapshot's drives has its file in its directory.
func (m *Manager) snapshotDrivesHere(snap snapshotMeta) bool {
	for _, version := range snapshotDriveVersions(snap) {
		file, _ := snapshotFile(version)
		if !fileExists(filepath.Join(m.snapshotDir(snap.ID), file)) {
			return false
		}
	}
	return true
}

func (m *Manager) snapshotFetchDir(id string) string {
	return filepath.Join(m.cfg.Root, snapshotFetchesDir, id)
}

// snapshotPartialPath is a fetch's partial file of a version, in the snapshot's fetch directory: disk.partial,
// mem.partial, or the drive version's (sticky0.partial, bundle0.partial, ...).
func (m *Manager) snapshotPartialPath(id, version string) string {
	switch version {
	case SnapshotMemory:
		return filepath.Join(m.snapshotFetchDir(id), "mem.partial")
	case SnapshotDisk:
		return filepath.Join(m.snapshotFetchDir(id), "disk.partial")
	}
	return filepath.Join(m.snapshotFetchDir(id), version+".partial")
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

// HoldsSnapshot says whether the host has a saved snapshot's version: its disk, its memory, or a drive's file.
func (m *Manager) HoldsSnapshot(id, version string) bool {
	if !snapshotObject(id, version) {
		return false
	}
	snap, ok := m.savedSnapshot(id)
	return ok && slices.Contains(m.snapshotVersions(snap), version)
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
	staged.Memory, staged.Fetched = false, true
	raw, _ := json.MarshalIndent(staged, "", "  ")
	// Under the base lock, as a snapshot's save names its base: a prune sees the image in use from here (BasesUnder),
	// and one that took it meanwhile is found here. Not for a snapshot deleted here meanwhile (autoMu).
	defer m.holdBases()()
	m.autoMu.Lock()
	defer m.autoMu.Unlock()
	if m.snapshotRetired[id] {
		return fmt.Errorf("snapshot %s was deleted on this host", id)
	}
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
	// A host image, by its portable identity: a version's name and the digest it was downloaded with. A version's name
	// alone isn't one: an image from before versions is named on its own host alone (images.Store's migration).
	want := runtimePart(snap.Runtime, "image")
	if version := images.VersionOf(rootfs); version != "" {
		if want == "" {
			return "", fmt.Errorf("%w: its host image %s has no recorded digest, so it can't be told to be this host's", ErrNoSnapshotImage, version)
		}
		if m.cfg.HostImage == nil {
			return "", fmt.Errorf("%w: it is host image %s, and this host doesn't keep its images by version", ErrNoSnapshotImage, version)
		}
		path, err := m.cfg.HostImage(ctx, version)
		if err != nil {
			return "", fmt.Errorf("%w: host image %s: %w", ErrNoSnapshotImage, version, err)
		}
		if have, ok := m.runtimeImage(path); !ok || have != want {
			return "", fmt.Errorf("%w: this host's %s is another image (%q, not %q)", ErrNoSnapshotImage, version, have, want)
		}
		return path, nil
	}
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

// WantsSnapshot says whether the host is to fetch a version of a snapshot whose disk it holds as a copy (Fetched): a
// sticky disk's clone it hasn't, so a sandbox made from it has the disk however it starts; and where it restores the
// snapshot's memory (restoresMemoryOf) and hasn't it, a bundle image it hasn't, then the memory once every drive is
// here, as the guest has them mounted.
func (m *Manager) WantsSnapshot(id, version string) bool {
	snap, ok := m.savedSnapshot(id)
	return ok && m.wantsSnapshot(snap, version)
}

func (m *Manager) wantsSnapshot(snap snapshotMeta, version string) bool {
	if !snap.Fetched || version == SnapshotDisk {
		return false
	}
	memory := snap.ColdBoot && !snap.Memory && m.restoresMemoryOf(snap) == nil
	if version == SnapshotMemory {
		return memory && m.snapshotDrivesHere(snap)
	}
	bundle, _, ok := snapshotDrive(version)
	if !ok || !slices.Contains(snapshotDriveVersions(snap), version) || slices.Contains(m.snapshotVersions(snap), version) {
		return false
	}
	return !bundle || memory
}

// SnapshotWants are the versions of a snapshot the host is to fetch now (WantsSnapshot), in the order it fetches them:
// its drives, then its memory once they are here.
func (m *Manager) SnapshotWants(id string) []string {
	snap, ok := m.savedSnapshot(id)
	if !ok {
		return nil
	}
	return m.snapshotWants(snap)
}

func (m *Manager) snapshotWants(snap snapshotMeta) []string {
	var out []string
	for _, version := range append(snapshotDriveVersions(snap), SnapshotMemory) {
		if m.wantsSnapshot(snap, version) {
			out = append(out, version)
		}
	}
	return out
}

// restoresMemoryOf says why the host can't restore a snapshot's memory, or nil when it can: the same CPU (Kantel sets
// no Firecracker CPU template), and the snapshot's portable runtime the one this host has for its root image. A copy
// whose machine had bundle images or sticky disks on its drives restores it only once their files are here too
// (WantsSnapshot), which isn't this check's to say.
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
	return nil
}

// SnapshotPartial is where a fetch of a snapshot's version writes, its directory made: its disk once its fetch is made
// ready (PrepareSnapshotFetch), its memory or a drive's file once the host holds its disk and wants it (WantsSnapshot).
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
		if !m.WantsSnapshot(id, version) {
			return "", fmt.Errorf("this host doesn't restore snapshot %s's memory, doesn't hold its disk, or hasn't every file its drives had yet", id)
		}
	default:
		if !m.WantsSnapshot(id, version) {
			return "", fmt.Errorf("this host doesn't want snapshot %s's %s: it doesn't hold its disk, has it, or doesn't restore its memory", id, version)
		}
	}
	if version != SnapshotDisk {
		if err := os.MkdirAll(m.snapshotFetchDir(id), 0o700); err != nil {
			return "", err
		}
	}
	return m.snapshotPartialPath(id, version), nil
}

// CloneNearestSnapshot makes dst a clone of this host's nearest file to a snapshot's drive version and answers its map,
// so a fetch of it takes only the blocks that differ: for a bundle image, the image of the same bundle in the host's
// cache (its build here may differ from the holder's in a few blocks, such as its superblock, so it is never taken as
// it is); for a sticky disk's clone, the disk's version it was cloned from, or else the host's newest. Nil, without
// making dst, when the host has none, and for the snapshot's disk and memory.
func (m *Manager) CloneNearestSnapshot(id, version, dst string) (*blockmap.Map, error) {
	bundle, i, ok := snapshotDrive(version)
	if !ok {
		return nil, nil
	}
	snap, held := m.savedSnapshot(id)
	if !held {
		return nil, nil
	}
	if bundle {
		if i >= len(snap.BundleSlots) || !bundles.ValidDigest(snap.BundleSlots[i]) || m.cfg.Bundles == nil {
			return nil, nil
		}
		return m.cloneBundleImage(snap.BundleSlots[i], dst)
	}
	for _, d := range attachedSticky(snap.StickyDisks) {
		if d.Slot == i && validID(d.DiskID) {
			return m.cloneStickyNearest(d.DiskID, d.Version, dst)
		}
	}
	return nil, nil
}

// cloneBundleImage makes dst a clone of a bundle's image in the host's cache, kept from eviction meanwhile, and maps
// it: nil, without making dst, when the cache hasn't it.
func (m *Manager) cloneBundleImage(digest, dst string) (*blockmap.Map, error) {
	c := m.cfg.Bundles
	release := c.Reserve(digest)
	defer release()
	src, err := os.Open(c.Image(digest))
	if err != nil {
		return nil, nil
	}
	defer src.Close()
	if err := m.cloneFrom(src, c.Image(digest), dst); err != nil {
		return nil, err
	}
	f, err := os.Open(dst)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	bm, _, err := blockmap.Make(m.background(), f, nil)
	if err != nil {
		_ = os.Remove(dst)
		return nil, err
	}
	m.log.Info("a snapshot's bundle image's fetch starts from the host's own image of it", "digest", digest)
	return bm, nil
}

// cloneStickyNearest makes dst a clone of a sticky disk's version the host holds with a map, version if it holds it,
// else its newest, and answers that map: nil, without making dst, when it holds none.
func (m *Manager) cloneStickyNearest(diskID, version, dst string) (*blockmap.Map, error) {
	if validID(version) {
		if src, bm := m.openStickyWithMap(diskID, version); src != nil {
			defer src.Close()
			if err := m.cloneFrom(src, m.stickyVersionFile(diskID, version), dst); err != nil {
				return nil, err
			}
			m.log.Info("a snapshot's sticky disk clone's fetch starts from the version it was cloned from", "disk", diskID, "version", version)
			return bm, nil
		}
	}
	return m.CloneNearestSticky(diskID, "", dst)
}

// cloneFrom makes dst a clone of src, open, at path: a reflink of the open file, else a full copy by name (path is
// never replaced under its name while it is open here, so the copy is of the same file, or fails if it went), which
// reserves its room first.
func (m *Manager) cloneFrom(src *os.File, path, dst string) error {
	if fsutil.ReflinkFrom(src, dst) == nil {
		return nil
	}
	_ = os.Remove(dst)
	release, err := m.reserveRoom(diskUsage(path), func(free, size int64) error {
		return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf(
			"This host has %s of disk free, and a full copy of the file a snapshot's fetch starts from (its file system has no reflinks) needs %s and must leave %s free.",
			gibText(max(free, 0)), gibText(size), gibText(snapshotHeadroom))}
	})
	if err != nil {
		return err
	}
	defer release()
	if _, err := cloneDisk(path, dst); err != nil {
		_ = os.Remove(dst)
		return err
	}
	return nil
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
// it has memory. A drive's file: its map, then the file, into the snapshot's directory. A version the host has already
// is kept, and the partial dropped; a partial removed meanwhile isn't published.
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
	if m.snapshotRetired[id] {
		return fmt.Errorf("snapshot %s was deleted on this host while it was fetched", id)
	}
	if version == SnapshotDisk {
		if _, err := os.Lstat(m.snapshotDir(id)); err == nil {
			m.discardSnapshotPartial(id, version)
			return nil
		}
	} else if m.HoldsSnapshot(id, version) {
		m.discardSnapshotPartial(id, version)
		return nil
	}
	if !sameFileAt(mine, path) {
		return fmt.Errorf("the fetch of snapshot %s's %s was removed before it was published", id, version)
	}
	switch version {
	case SnapshotDisk:
		err = m.publishSnapshotDisk(id, path, mapFile)
	case SnapshotMemory:
		err = m.publishSnapshotMemory(id, path, mapFile, files[SnapshotStateFile])
	default:
		err = m.publishSnapshotDrive(id, version, path, mapFile)
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
	// Its guest has the files on its drives mounted: never its memory over drives without them.
	if !m.snapshotDrivesHere(snap) {
		return fmt.Errorf("snapshot %s's memory came before every file its drives had", id)
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

// publishSnapshotDrive puts a fetched drive's file into a copy's directory: its map first, then the file, so a drive's
// file there is whole and mapped, then the record's size.
func (m *Manager) publishSnapshotDrive(id, version, path string, mapFile []byte) error {
	snap, ok := m.savedSnapshot(id)
	if !ok {
		return fmt.Errorf("the host no longer holds snapshot %s's disk", id)
	}
	if !slices.Contains(snapshotDriveVersions(snap), version) {
		return fmt.Errorf("snapshot %s has no %s", id, version)
	}
	dir := m.snapshotDir(id)
	file, mapName := snapshotFile(version)
	if err := fsutil.WriteFileDurably(filepath.Join(dir, mapName), mapFile, 0o600); err != nil {
		return err
	}
	if err := os.Rename(path, filepath.Join(dir, file)); err != nil {
		return err
	}
	if err := syncDir(dir); err != nil {
		return err
	}
	snap.SizeBytes = snapshotBytes(dir)
	raw, _ := json.MarshalIndent(snap, "", "  ")
	return fsutil.WriteFileDurably(filepath.Join(dir, "meta.json"), raw, 0o600)
}

// dropSnapshotFetch ends a fetch of a snapshot this host hasn't published yet, as a delete of it does: its fetch's
// directory goes, and it is never published (snapshotRetired). False when there is none. Called with autoMu held.
func (m *Manager) dropSnapshotFetch(id string) bool {
	m.retireSnapshot(id)
	if !fileExists(m.snapshotFetchDir(id)) {
		return false
	}
	_ = os.RemoveAll(m.snapshotFetchDir(id))
	return true
}

// retireSnapshot marks a snapshot deleted on this host, so no fetch of it publishes it again. Called with autoMu held.
func (m *Manager) retireSnapshot(id string) {
	if m.snapshotRetired == nil {
		m.snapshotRetired = map[string]bool{}
	}
	m.snapshotRetired[id] = true
}

// SnapshotPartials are the fetches of snapshots' versions left unfinished, by ID and version: a disk's from when its
// fetch was made ready (its record staged), whether or not it had begun writing; a drive's or a memory's from when the
// host holds the disk and wants it (SnapshotWants), so one whose first try came before its holder had it goes on.
func (m *Manager) SnapshotPartials() [][2]string {
	out := m.snapshotFetchPartials()
	snaps, _ := scanSnapshotsIn(m.cfg.Root)
	for _, snap := range snaps {
		if snap.Kind != "saved" || snap.Transient || !validID(snap.ID) {
			continue
		}
		for _, version := range m.snapshotWants(snap) {
			if p := [2]string{snap.ID, version}; !slices.Contains(out, p) {
				out = append(out, p)
			}
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
		if fileExists(m.stagedSnapshotPath(e.Name())) {
			out = append(out, [2]string{e.Name(), SnapshotDisk})
		}
		for _, version := range m.partialVersions(e.Name()) {
			if p := [2]string{e.Name(), version}; !slices.Contains(out, p) {
				out = append(out, p)
			}
		}
	}
	return out
}

// partialVersions are the versions of a snapshot with a partial file in its fetch directory.
func (m *Manager) partialVersions(id string) []string {
	entries, _ := os.ReadDir(m.snapshotFetchDir(id))
	var out []string
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".partial")
		if !ok || !e.Type().IsRegular() {
			continue
		}
		switch name {
		case "disk":
			out = append(out, SnapshotDisk)
		case "mem":
			out = append(out, SnapshotMemory)
		default:
			if _, _, ok := snapshotDrive(name); ok {
				out = append(out, name)
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
	// The directory, once no other version's fetch is in it.
	if len(m.partialVersions(id)) == 0 && !fileExists(m.stagedSnapshotPath(id)) {
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
		for _, version := range m.snapshotVersions(snap) {
			file, mapFile := snapshotFile(version)
			digest := m.snapshotMapDigest(filepath.Join(m.snapshotDir(snap.ID), mapFile))
			if digest == "" {
				continue
			}
			versions = append(versions, proto.ObjectVersionHolding{
				Version: version, MapDigest: digest, AllocatedBytes: diskUsage(filepath.Join(m.snapshotDir(snap.ID), file)),
				Copy: snap.Fetched,
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

// mapSnapshot makes the maps a saved snapshot hasn't: its disk's, its memory's when it has memory, and its drives'
// files' (a sticky disk's clone's from the map of the version it was cloned from, where the host still holds it, so
// only the blocks they don't share are read). A snapshot's files never change once it is made, so a map is good for as
// long as the snapshot is there; one deleted meanwhile gets none.
func (m *Manager) mapSnapshot(ctx context.Context, id string) error {
	snap, ok := m.savedSnapshot(id)
	if !ok {
		return nil
	}
	dir := m.snapshotDir(id)
	for _, version := range m.snapshotVersions(snap) {
		file, mapFile := snapshotFile(version)
		if fileExists(filepath.Join(dir, mapFile)) {
			continue
		}
		if err := m.mapSnapshotFile(ctx, id, filepath.Join(dir, file), filepath.Join(dir, mapFile), m.snapshotDriveBase(snap, version)); err != nil {
			return fmt.Errorf("its %s: %w", version, err)
		}
	}
	return nil
}

// snapshotDriveBase is, for a snapshot's sticky disk's clone, the disk's version it was cloned from, open with its map,
// when the host holds both (stickyBase): nil for any other version.
func (m *Manager) snapshotDriveBase(snap snapshotMeta, version string) *blockmap.Base {
	bundle, k, ok := snapshotDrive(version)
	if !ok || bundle {
		return nil
	}
	for _, d := range attachedSticky(snap.StickyDisks) {
		if d.Slot == k && validID(d.DiskID) && validID(d.Version) {
			return m.stickyBase(d.DiskID, d.Version)
		}
	}
	return nil
}

func (m *Manager) mapSnapshotFile(ctx context.Context, id, path, mapPath string, base *blockmap.Base) error {
	if base != nil {
		defer base.File.Close()
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	start := time.Now()
	bm, st, err := blockmap.Make(ctx, f, base)
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
		for _, version := range m.snapshotVersions(snap) {
			if _, mapFile := snapshotFile(version); !fileExists(filepath.Join(dir, mapFile)) {
				m.mapSnapshotLater(snap.ID)
				break
			}
		}
	}
}
