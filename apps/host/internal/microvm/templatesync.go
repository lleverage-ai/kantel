package microvm

// Template snapshots as disk store objects (docs/design/disk-store.md, "Phase 3 notes"): template-snapshots/<id> is
// kind template, its ID the snapshot's, in one version (TemplateVersion), as a snapshot never changes once it is made.
// Its disk (disk.ext4) and memory (mem) are its parts, block-mapped (disksync.Parted), each with its map beside it
// (disk.map, mem.map) once it is made, in the background after its build or fetch (or, for one made before maps, when
// the host starts); its state, meta.json and drive counts go whole. Every capacity report lists those with both maps,
// with what each was made on (its CPU and portable runtime), so the control plane offers one only to hosts its memory
// restores on. Each is stamped with the pool it was made in (pool: a build's as it began, a fetch's as it began).
//
// A fetch writes into template-fetches/<id> (each part, with a bitmap of the blocks in place beside it), and is
// published only onto a host whose CPU is the snapshot's, over the root filesystem its runtime names: a template's own
// (images/templates/<key>.ext4, which the build fetched or made first), or the host image version it was built on. Its
// meta.json is made this host's there (the root filesystem's path, and the runtime by this host's files), and the
// directory moved into template-snapshots in one rename, so a restore finds it whole or not at all.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// TemplateVersion is the one version of a template snapshot.
const TemplateVersion = "1"

// The parts of a template snapshot, and the files they are in its directory.
const (
	TemplatePartDisk = "disk"
	TemplatePartMem  = "mem"
)

// TemplateParts are a template snapshot's parts, in the order its manifest has them.
var TemplateParts = []string{TemplatePartDisk, TemplatePartMem}

var templatePartFiles = map[string]string{TemplatePartDisk: fc.DiskFile, TemplatePartMem: "mem"}

// TemplateFiles are a template snapshot's small files, which a fetch takes whole, by the names peers ask for them by,
// and the files they are in its directory. Each but its drive counts is required, and its root filesystem's map
// digest (templateRootfsDigestFile) for one over a template's own root filesystem.
var TemplateFiles = []string{"state", "meta", driveCountFile, stickyCountFile, templateRootfsDigestFile}

var templateSmallFiles = map[string]string{
	"state": "state", "meta": "meta.json", driveCountFile: driveCountFile, stickyCountFile: stickyCountFile,
	templateRootfsDigestFile: templateRootfsDigestFile,
}

// templateRootfsDigestFile, in the directory of a template snapshot over a template's own root filesystem
// (images/templates/<key>.ext4), is that file's map digest, written before its parts are mapped: two hosts that each
// made the root filesystem of a key hold different bytes under it, so a snapshot is published only over a copy with
// that digest, whose bytes its memory was made over.
const templateRootfsDigestFile = "rootfs-map"

const (
	templateFetchesDir   = "template-fetches"
	templatePoolFile     = "pool"
	templateFetchingPool = "pool.fetching"
)

// ErrNoPeerTemplate is Config.FetchTemplate's answer when no host the fetch may reach holds the template snapshot on
// this host's CPU and runtime.
var ErrNoPeerTemplate = errors.New("no host in the pool holds the template snapshot on this host's CPU and runtime")

// fetchTemplateFirst has a build's template snapshot fetched from a peer whose copy restores here (Config.FetchTemplate)
// rather than booting it, once its root filesystem is on the host: one no peer holds, whose fetch fails, or that
// restorableTemplateSnapshot refuses as the build's machine, the build makes itself. It answers the snapshot fetched,
// and the build's own end (its context's error) when that came first: then nothing is built, and the fetch goes on
// for the next build. Called with the snapshot's lock held, which the fetch's publish doesn't take.
func (m *Manager) fetchTemplateFirst(ctx context.Context, p proto.TemplateBuildParams, size proto.Size) (*templateSnapshotMeta, error) {
	if m.cfg.FetchTemplate == nil {
		return nil, nil
	}
	start := time.Now()
	err := m.cfg.FetchTemplate(ctx, p.SnapshotID)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	switch {
	case errors.Is(err, ErrNoPeerTemplate):
		m.log.Info("no peer holds the template snapshot on this host's CPU and runtime; building it here", "snapshot", p.SnapshotID)
		return nil, nil
	case err != nil:
		m.log.Warn("the template snapshot couldn't be fetched from a peer; building it here", "snapshot", p.SnapshotID, "error", err)
		return nil, nil
	}
	kept, err := m.readTemplateSnapshot(p.SnapshotID)
	if err == nil && kept.KeyHash != p.KeyHash {
		err = fmt.Errorf("its key is %s, not %s", kept.KeyHash, p.KeyHash)
	}
	if err == nil {
		_, err = m.restorableTemplateSnapshot(p.SnapshotID, size)
	}
	if err != nil {
		m.log.Warn("the template snapshot fetched from a peer can't be restored here; building it here", "snapshot", p.SnapshotID, "error", err)
		_ = os.RemoveAll(m.templateSnapshotDir(p.SnapshotID))
		return nil, nil
	}
	m.log.Info("template snapshot fetched from a peer", "snapshot", p.SnapshotID, "took", time.Since(start).Round(time.Millisecond))
	return &kept, nil
}

func (m *Manager) templateFetchDir(id string) string {
	return filepath.Join(m.cfg.Root, templateFetchesDir, id)
}

// templateObject says whether id and version name a template snapshot as an object.
func templateObject(id, version string) bool { return validID(id) && version == TemplateVersion }

// templateWhole says whether a template snapshot is whole on the host: its meta.json is written last.
func (m *Manager) templateWhole(id string) bool {
	return fileExists(filepath.Join(m.templateSnapshotDir(id), "meta.json"))
}

// HoldsTemplate says whether the host has a template snapshot whole.
func (m *Manager) HoldsTemplate(id, version string) bool {
	return templateObject(id, version) && m.templateWhole(id)
}

// OpenTemplatePart opens one part of a template snapshot the host holds for a peer to fetch (disksync.Parted): its file,
// and with withMap its map's file. fs.ErrNotExist when the host doesn't have it whole, or has no map of the part yet.
// Open, the file stays readable whatever is deleted after.
func (m *Manager) OpenTemplatePart(id, version, part string, withMap bool) (*os.File, []byte, error) {
	name, ok := templatePartFiles[part]
	if !templateObject(id, version) || !ok || !m.templateWhole(id) {
		return nil, nil, fs.ErrNotExist
	}
	dir := m.templateSnapshotDir(id)
	f, err := os.Open(filepath.Join(dir, name))
	if err != nil {
		return nil, nil, err
	}
	var raw []byte
	if withMap {
		raw, err = os.ReadFile(filepath.Join(dir, part+".map"))
	} else {
		_, err = os.Stat(filepath.Join(dir, part+".map"))
	}
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	// Still the snapshot the map is of: one built again under its ID loses its maps with its directory.
	if mine, err := f.Stat(); err != nil || !sameFileAt(mine, filepath.Join(dir, name)) {
		f.Close()
		return nil, nil, fs.ErrNotExist
	}
	return f, raw, nil
}

// ReadTemplateFile reads one of a template snapshot's small files (TemplateFiles) for a peer: fs.ErrNotExist when the
// host doesn't have it whole, or it has no such file (a snapshot without bundle drives has no count of them, one over
// the host's image no root filesystem digest).
func (m *Manager) ReadTemplateFile(id, version, name string) ([]byte, error) {
	file, ok := templateSmallFiles[name]
	if !templateObject(id, version) || !ok || !m.templateWhole(id) {
		return nil, fs.ErrNotExist
	}
	return os.ReadFile(filepath.Join(m.templateSnapshotDir(id), file))
}

// TemplatePartPartial is where a fetch of a template snapshot's part writes, its directory made. The pool the fetch
// began in is stamped there as it begins, and kept as it goes on (after a restart too): the copy is that pool's.
func (m *Manager) TemplatePartPartial(id, version, part string) (string, error) {
	name, ok := templatePartFiles[part]
	if !templateObject(id, version) || !ok {
		return "", fmt.Errorf("bad template snapshot ID, version or part")
	}
	dir := m.templateFetchDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	stamp := filepath.Join(dir, templateFetchingPool)
	if !fileExists(stamp) {
		pool := m.tpl.rootfs.currentPool()
		if err := fsutil.WriteFileDurably(stamp, []byte(pool), 0o600); err != nil {
			return "", err
		}
	}
	return filepath.Join(dir, name), nil
}

// ReserveTemplateFetch holds room for the bytes a fetch of a template snapshot is to write, beside every other copy the
// host makes, until release: refused (ErrCapacity) when that would leave the host less than snapshotHeadroom free.
func (m *Manager) ReserveTemplateFetch(bytes int64) (release func(), err error) {
	return m.reserveRoom(bytes, func(free, size int64) error {
		return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf(
			"This host has %s of disk free, and fetching a template snapshot writes %s and must leave %s free.",
			gibText(max(free, 0)), gibText(size), gibText(snapshotHeadroom))}
	})
}

// PublishFetchedTemplate makes a fetched template snapshot this host's (disksync.Parted): only when its CPU is this
// host's and its portable runtime is this host's over the root filesystem it names (localTemplateRootfs), so a restore
// takes it, its meta.json made this host's. Its parts, maps and small files are put in the fetch's directory, which
// then becomes the snapshot's in one rename. One the host has whole already is kept, and the fetch dropped; a part whose
// partial was removed meanwhile (the snapshot deleted) isn't published.
//
// It doesn't take the snapshot's lock, which a build waiting for the fetch holds (fetchTemplateFirst): a build or delete
// of the snapshot under way finds the rename fail or the partials gone.
func (m *Manager) PublishFetchedTemplate(id, version string, parts map[string]disksync.FetchedPart, files map[string][]byte) error {
	if !templateObject(id, version) {
		return fmt.Errorf("bad template snapshot ID or version")
	}
	if m.templateWhole(id) {
		m.discardTemplateFetch(id)
		return nil
	}
	var kept templateSnapshotMeta
	if err := json.Unmarshal(files["meta"], &kept); err != nil {
		return fmt.Errorf("the template snapshot's meta.json: %w", err)
	}
	if _, ok := files["state"]; !ok || kept.SnapshotID != id {
		return fmt.Errorf("the fetched template snapshot isn't %s whole", id)
	}
	if cpu := m.CPU(); !kept.CPU.Same(cpu) {
		return fmt.Errorf("the template snapshot was made on another CPU (%v, this host's %v)", kept.CPU, cpu)
	}
	if err := m.sameTemplateRootfs(kept, files[templateRootfsDigestFile]); err != nil {
		return err
	}
	dir := m.templateFetchDir(id)
	for _, part := range TemplateParts {
		got, ok := parts[part]
		if !ok {
			return fmt.Errorf("the fetch has no %s", part)
		}
		mine, err := got.File.Stat()
		if err != nil {
			return err
		}
		if !sameFileAt(mine, filepath.Join(dir, templatePartFiles[part])) {
			return fmt.Errorf("the fetch of template snapshot %s was removed before it was published", id)
		}
	}
	// Linked to its root filesystem and moved into place under the base lock, so a prune finds the reference in the
	// snapshot's directory from then on and never between the two.
	defer m.holdBases()()
	rootfs, err := m.localTemplateRootfs(kept)
	if err != nil {
		return err
	}
	if runtime := m.runtimeWith(rootfs, StickyDrives); runtime == "" || runtime != kept.PortableRuntime {
		return fmt.Errorf("the template snapshot was made on another runtime (%s, this host's %s)", kept.PortableRuntime, runtime)
	}
	for _, part := range TemplateParts {
		if err := fsutil.WriteFileDurably(filepath.Join(dir, part+".map"), parts[part].Map, 0o600); err != nil {
			return err
		}
		_ = os.Remove(filepath.Join(dir, templatePartFiles[part]+".done"))
	}
	for name, file := range templateSmallFiles {
		raw, ok := files[name]
		if !ok || name == "meta" {
			continue
		}
		if err := fsutil.WriteFileDurably(filepath.Join(dir, file), raw, 0o600); err != nil {
			return err
		}
	}
	if err := os.Rename(filepath.Join(dir, templateFetchingPool), filepath.Join(dir, templatePoolFile)); err != nil {
		_ = os.Remove(filepath.Join(dir, templatePoolFile))
	}
	kept.Rootfs, kept.Runtime = rootfs, m.runtimeFingerprint(rootfs)
	if err := keepTemplateSnapshot(dir, &kept); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(m.cfg.Root, templateSnapshotsDir), 0o700); err != nil {
		return err
	}
	// Not once it has been deleted: a fetch under way as its delete ran may have made its partials again since.
	m.templateFetches.mu.Lock()
	defer m.templateFetches.mu.Unlock()
	if m.templateFetches.deleted[id] {
		m.discardTemplateFetch(id)
		return fmt.Errorf("template snapshot %s was deleted while it was fetched", id)
	}
	if err := os.Rename(dir, m.templateSnapshotDir(id)); err != nil {
		// Built or fetched meanwhile: that one stays.
		m.discardTemplateFetch(id)
		if m.templateWhole(id) {
			return nil
		}
		return err
	}
	return syncDir(filepath.Join(m.cfg.Root, templateSnapshotsDir))
}

// templateFetches is what keeps a template snapshot's fetch from publishing it once it has been deleted: the snapshots
// this run of the host deleted, until one is built again, and the lock a publish's rename and a delete share. A fetch
// can't be stopped from here, and one already past its partials' checks makes them again as it goes on; its publish
// finds the snapshot deleted.
type templateFetches struct {
	mu      sync.Mutex
	deleted map[string]bool
}

// forgetTemplate marks a template snapshot deleted, then removes its fetch and its directory: a publish either renamed
// it into place before, and it is removed here, or finds it deleted.
func (m *Manager) forgetTemplate(id string) error {
	f := &m.templateFetches
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deleted == nil {
		f.deleted = map[string]bool{}
	}
	f.deleted[id] = true
	m.discardTemplateFetch(id)
	return os.RemoveAll(m.templateSnapshotDir(id))
}

// buildingTemplate lets a template snapshot deleted before be fetched and published again: a build of it was asked
// for.
func (m *Manager) buildingTemplate(id string) {
	f := &m.templateFetches
	f.mu.Lock()
	delete(f.deleted, id)
	f.mu.Unlock()
}

// sameTemplateRootfs checks that a fetched template snapshot over a template's own root filesystem (its RootfsKey) has
// that root filesystem's bytes here, as its holder's map digest of it (digest, templateRootfsDigestFile) says: this
// host's copy is mapped first when it has no map yet. One over a host image needs no such check: its portable runtime
// names the image's version and digest.
func (m *Manager) sameTemplateRootfs(k templateSnapshotMeta, digest []byte) error {
	key := k.BuiltFrom.RootfsKey
	if key == "" {
		return nil
	}
	want := strings.TrimSpace(string(digest))
	if !validKey(key) || !strings.HasPrefix(want, "sha256:") {
		return errors.New("the template snapshot doesn't say which root filesystem it was made over")
	}
	if !fileExists(m.tpl.rootfs.path(key)) {
		return fmt.Errorf("the template's root filesystem %s isn't on this host", key)
	}
	have, err := m.templateRootfsDigest(m.background(), key)
	if err != nil {
		return fmt.Errorf("the template's root filesystem %s couldn't be mapped: %w", key, err)
	}
	if have != want {
		return fmt.Errorf("the template's root filesystem %s here is %s, not the %s the snapshot was made over", key, have, want)
	}
	return nil
}

// templateRootfsDigest is a template root filesystem's map digest, mapping it first when it has no map yet.
func (m *Manager) templateRootfsDigest(ctx context.Context, key string) (string, error) {
	if digest := m.rootfsMapDigest(key); digest != "" {
		return digest, nil
	}
	if err := m.mapRootfs(ctx, key); err != nil {
		return "", err
	}
	if digest := m.rootfsMapDigest(key); digest != "" {
		return digest, nil
	}
	return "", errors.New("it has no map")
}

// localTemplateRootfs is the root filesystem on this host that a fetched template snapshot restores over: the
// template's own (images/templates/<key>.ext4), or the host image version it was built on, or the host's image when
// that isn't versioned; an error when this host hasn't it. Called with the base lock held, so a prune doesn't take a
// version away before it is linked.
func (m *Manager) localTemplateRootfs(k templateSnapshotMeta) (string, error) {
	switch {
	case k.BuiltFrom.RootfsKey != "":
		if !validKey(k.BuiltFrom.RootfsKey) {
			return "", errors.New("bad template root filesystem key")
		}
		path := m.tpl.rootfs.path(k.BuiltFrom.RootfsKey)
		if !fileExists(path) {
			return "", fmt.Errorf("the template's root filesystem %s isn't on this host", k.BuiltFrom.RootfsKey)
		}
		return path, nil
	case k.Base != "":
		current := m.baseRootfs()
		if images.VersionOf(current) == "" {
			return "", fmt.Errorf("the host image %s isn't on this host", k.Base)
		}
		path := filepath.Join(filepath.Dir(filepath.Dir(current)), k.Base, filepath.Base(current))
		if images.VersionOf(path) != k.Base || !fileExists(path) {
			return "", fmt.Errorf("the host image %s isn't on this host", k.Base)
		}
		return path, nil
	default:
		return m.baseRootfs(), nil
	}
}

// TemplatePartials are the fetches of template snapshots left unfinished, by ID.
func (m *Manager) TemplatePartials() []string {
	entries, err := os.ReadDir(filepath.Join(m.cfg.Root, templateFetchesDir))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && validID(e.Name()) {
			out = append(out, e.Name())
		}
	}
	return out
}

// DiscardTemplateFetch removes a fetch's directory: its partials and their bitmaps.
func (m *Manager) DiscardTemplateFetch(id string) {
	if validID(id) {
		m.discardTemplateFetch(id)
	}
}

func (m *Manager) discardTemplateFetch(id string) {
	if err := os.RemoveAll(m.templateFetchDir(id)); err != nil {
		m.log.Warn("removing a template snapshot's fetch", "snapshot", id, "error", err)
	}
}

// templateMaps is the template snapshots' maps being made, or waiting their turn (one snapshot at a time, as each
// reads its whole disk and memory), and the manifest digests of those made, as read when their maps had that size and
// time.
type templateMaps struct {
	mu      sync.Mutex
	making  map[string]bool
	digests map[string]templateDigest
	turn    sync.Mutex
}

type templateDigest struct {
	disk, mem stickyDigest
	digest    string
}

// templateManifestDigest is a template snapshot's manifest's digest, "" when a part has no map (yet), read again only
// when a map changes.
func (m *Manager) templateManifestDigest(id string) string {
	dir := m.templateSnapshotDir(id)
	stat := func(part string) (stickyDigest, bool) {
		info, err := os.Stat(filepath.Join(dir, part+".map"))
		if err != nil {
			return stickyDigest{}, false
		}
		return stickyDigest{size: info.Size(), modTime: info.ModTime()}, true
	}
	disk, okDisk := stat(TemplatePartDisk)
	mem, okMem := stat(TemplatePartMem)
	if !okDisk || !okMem {
		return ""
	}
	maps := &m.templateMaps
	maps.mu.Lock()
	cached, ok := maps.digests[id]
	maps.mu.Unlock()
	if ok && cached.disk == disk && cached.mem == mem {
		return cached.digest
	}
	var digests []disksync.PartDigest
	for _, part := range TemplateParts {
		raw, err := os.ReadFile(filepath.Join(dir, part+".map"))
		if err != nil {
			return ""
		}
		digests = append(digests, disksync.PartDigest{Part: part, Digest: blockmap.Digest(raw)})
	}
	digest := blockmap.Digest(disksync.Manifest(digests))
	maps.mu.Lock()
	if maps.digests == nil {
		maps.digests = map[string]templateDigest{}
	}
	maps.digests[id] = templateDigest{disk: disk, mem: mem, digest: digest}
	maps.mu.Unlock()
	return digest
}

// TemplateHoldings are the template snapshots the host holds whole with both maps, by ID, with what each was made on:
// [] when none. One made before its CPU and runtime were kept is left out, as its memory restores on no other host.
// Nil, which a report leaves out, when their directory can't be read: the control plane takes one missing from a
// report as gone.
func (m *Manager) TemplateHoldings() []proto.ObjectHolding {
	out := []proto.ObjectHolding{}
	entries, err := os.ReadDir(filepath.Join(m.cfg.Root, templateSnapshotsDir))
	if errors.Is(err, fs.ErrNotExist) {
		return out
	}
	if err != nil {
		m.log.Warn("template snapshot holdings left out of the report: their directory can't be read", "error", err)
		return nil
	}
	for _, e := range entries {
		id := e.Name()
		if !e.IsDir() || !validID(id) {
			continue
		}
		kept, err := m.readTemplateSnapshot(id)
		if err != nil || kept.CPU == nil || kept.PortableRuntime == "" {
			continue
		}
		dir := m.templateSnapshotDir(id)
		if kept.BuiltFrom.RootfsKey != "" && !fileExists(filepath.Join(dir, templateRootfsDigestFile)) {
			continue
		}
		digest := m.templateManifestDigest(id)
		if digest == "" {
			continue
		}
		out = append(out, proto.ObjectHolding{ObjectID: id, Versions: []proto.ObjectVersionHolding{{
			Version: TemplateVersion, MapDigest: digest, Pool: stampedPoolIn(dir),
			AllocatedBytes: diskUsage(filepath.Join(dir, fc.DiskFile)) + diskUsage(filepath.Join(dir, "mem")),
			CPU:            kept.CPU, Runtime: kept.PortableRuntime,
		}}})
	}
	return out
}

// stampedPoolIn is the pool a template snapshot in dir was made in, "" when it has no stamp.
func stampedPoolIn(dir string) string {
	raw, err := os.ReadFile(filepath.Join(dir, templatePoolFile))
	if err != nil || len(raw) > 200 {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

// stampTemplatePool records the pool a template snapshot was built in, as its build began, in its directory before its
// meta.json is written; none with no pool.
func stampTemplatePool(dir, pool string) {
	if pool == "" {
		return
	}
	_ = fsutil.WriteFileDurably(filepath.Join(dir, templatePoolFile), []byte(pool), 0o600)
}

// mapTemplateLater makes a template snapshot's maps in the background, under the tier's own context, after any being
// made, unless it has them or they are being made: a build asks for them, so does the host as it starts. Not on a
// Manager made without New (tests), which has no background of its own to end. One made before its CPU and runtime
// were kept isn't mapped: no other host takes its memory.
func (m *Manager) mapTemplateLater(id string) {
	if m.bg == nil || !validID(id) {
		return
	}
	maps := &m.templateMaps
	maps.mu.Lock()
	if maps.making[id] {
		maps.mu.Unlock()
		return
	}
	if maps.making == nil {
		maps.making = map[string]bool{}
	}
	maps.making[id] = true
	maps.mu.Unlock()
	go func() {
		defer func() {
			maps.mu.Lock()
			delete(maps.making, id)
			maps.mu.Unlock()
		}()
		maps.turn.Lock()
		defer maps.turn.Unlock()
		if err := m.mapTemplate(m.background(), id); err != nil && !errors.Is(err, fs.ErrNotExist) {
			m.log.Warn("a template snapshot's block maps couldn't be made", "snapshot", id, "error", err)
		}
	}()
}

// mapTemplate makes each of a template snapshot's parts' maps it hasn't, and writes it beside the part, unless the
// snapshot was deleted or built again meanwhile.
func (m *Manager) mapTemplate(ctx context.Context, id string) error {
	kept, err := m.readTemplateSnapshot(id)
	if err != nil {
		return fs.ErrNotExist
	}
	if kept.CPU == nil || kept.PortableRuntime == "" {
		return nil
	}
	dir := m.templateSnapshotDir(id)
	// The digest of the root filesystem it was made over first, which its peers check theirs against: it is listed in
	// the host's holdings only once its parts are mapped too.
	if key := kept.BuiltFrom.RootfsKey; key != "" && !fileExists(filepath.Join(dir, templateRootfsDigestFile)) {
		digest, err := m.templateRootfsDigest(ctx, key)
		if err != nil {
			return fmt.Errorf("its root filesystem %s: %w", key, err)
		}
		lock := m.tpl.snapshots.of(id)
		lock.RLock()
		if !m.templateWhole(id) {
			lock.RUnlock()
			return fs.ErrNotExist
		}
		err = fsutil.WriteFileDurably(filepath.Join(dir, templateRootfsDigestFile), []byte(digest), 0o600)
		lock.RUnlock()
		if err != nil {
			return err
		}
	}
	for _, part := range TemplateParts {
		mapPath := filepath.Join(dir, part+".map")
		if fileExists(mapPath) {
			continue
		}
		path := filepath.Join(dir, templatePartFiles[part])
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		start := time.Now()
		bm, st, err := blockmap.Make(ctx, f, nil)
		if err != nil {
			f.Close()
			return err
		}
		// Sharing the snapshot's lock, so a delete or a build of it doesn't replace the file between the check and the
		// write.
		lock := m.tpl.snapshots.of(id)
		lock.RLock()
		info, err := f.Stat()
		f.Close()
		if err != nil || !sameFileAt(info, path) || !m.templateWhole(id) {
			lock.RUnlock()
			return fs.ErrNotExist
		}
		_, err = blockmap.WriteFile(mapPath, bm)
		lock.RUnlock()
		if err != nil {
			return err
		}
		m.log.Info("template snapshot part mapped", "snapshot", id, "part", part, "blocks", st.Blocks, "empty", st.Empty,
			"read", st.Read, "took", time.Since(start).Round(time.Millisecond))
	}
	return nil
}

// mapOldTemplates starts the maps of the template snapshots made before maps, or whose maps a stop cut short.
func (m *Manager) mapOldTemplates() {
	entries, _ := os.ReadDir(filepath.Join(m.cfg.Root, templateSnapshotsDir))
	for _, e := range entries {
		if e.IsDir() && validID(e.Name()) {
			m.mapTemplateLater(e.Name())
		}
	}
}
