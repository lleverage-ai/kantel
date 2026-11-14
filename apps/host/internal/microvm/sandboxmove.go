package microvm

// A stopped sandbox moved to another host (docs/design/disk-store.md, "Moving a sandbox to another host"): its disk and
// sticky drives are a disk store object of kind sandbox, its ID the sandbox's, one version for each export (the move's
// operation ID). Its parts are its disk (disk.ext4) and its two sticky drives' files (sticky0.ext4, sticky1.ext4, an
// empty file for a drive with no disk), each block-mapped (disksync.Parted), and its record (record.json: its host's
// record of it, with the root image its disk is over) goes whole. Parts rather than a version per file, as saved
// snapshots have: the target needs every file of the one export together, published at once, and the manifest vouches
// for all of them; nothing of it goes to one host and not another.
//
// On the sandbox's host, ExportSandbox clones the files (reflinks, else full copies that reserve their room) into
// sandbox-exports/<id>/<version>/ while the sandbox is stopped, then maps each, and the host serves them to its peers
// from there: what the sandbox does after doesn't change them. A sticky drive's map starts from the map of the version
// its disk was cloned from, where the host still has it, reading only the blocks the two don't share.
//
// A running sandbox moves with a restart (FeatureSandboxMoveRunning): a live export clones its files while it runs, a
// copy as a crash would leave its disk, as a version of its own, which the target fetches and keeps staged in its
// import directory (ImportOptions.Stage). Once the sandbox is stopped, a second export over the first (Base) maps
// each part from the first's map: on a file system with reflinks, the extents the two still share hold the same
// bytes (FIEMAP), so only the blocks the guest wrote since are read. The target fetches the second version over a
// clone of its staged first (ImportOptions.Base, CloneSandboxPartBase): only the blocks whose hashes differ. Without
// reflinks the second export reads every block, and the target still fetches only those that differ, so a first copy
// torn by the writes made as it was copied is put right.
//
// On the target, PrepareSandboxImport stages the record in sandbox-imports/<id>/<version>/, with a VM directory whose root
// filesystem is this host's file of the same image (a host image version from its release, a template's root
// filesystem from a peer: localRootfs, as for a saved snapshot's copy), so a prune keeps that image while the fetch goes
// on. Each version has its own directory, so a fetch of an older one never writes into a newer one's. The parts are
// fetched into that VM directory; published, the directory becomes sandboxes/<id>/ in one rename, a
// stopped sandbox with no memory (it boots on its disk), its bundle drives empty (its bundles are mounted again from
// this host's cache when it starts) and its egress without the other host's CA (its start sends its egress).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// SandboxParts are a moved sandbox's parts, in the order its manifest has them.
var SandboxParts = []string{proto.SandboxPartDisk, proto.SandboxPartSticky0, proto.SandboxPartSticky1}

// SandboxFiles are a moved sandbox's small files, which a fetch takes whole.
var SandboxFiles = []string{proto.SandboxRecordFile}

// sandboxPartFiles are the files each part is in a VM directory, and in an export's directory.
var sandboxPartFiles = map[string]string{
	proto.SandboxPartDisk:    fc.DiskFile,
	proto.SandboxPartSticky0: stickyDriveFile(0),
	proto.SandboxPartSticky1: stickyDriveFile(1),
}

const (
	sandboxExportsDir = "sandbox-exports"
	sandboxImportsDir = "sandbox-imports"
	// sandboxRecordName is the record in an export's directory, and staged in an import's.
	sandboxRecordName = "record.json"
	// sandboxStagedName marks an import kept staged (ImportOptions.Stage) whose parts are all fetched, each part's map
	// beside it (sandboxPartMap): written last.
	sandboxStagedName = "fetched"
)

// sandboxRecord is what a moved sandbox's record says: the sandbox's record on its host, and the root filesystem its
// disk is over there, with that file's map digest when it is a template's (two hosts may have built one under its key,
// with other bytes). Staged on the target, it also says how the import was asked for (ImportOptions).
type sandboxRecord struct {
	Meta         meta   `json:"meta"`
	Rootfs       string `json:"rootfs"`
	RootfsDigest string `json:"rootfsDigest,omitempty"`
	Stage        bool   `json:"stage,omitempty"`
	Base         string `json:"base,omitempty"`
}

// ImportOptions are how a version of a moved sandbox is imported (FeatureSandboxMoveRunning): Stage keeps it staged
// once fetched, a running sandbox's first copy, rather than making the sandbox; Base names such a version staged here,
// which each part's fetch starts from, and which goes once this version is made the sandbox.
type ImportOptions struct {
	Stage bool
	Base  string
}

// sandboxMoves is the lock an import's preparation, its publish, and a delete or cancel of it share, with the
// versions of each sandbox whose import was cancelled here (CancelSandboxImport), which are never made after; and the
// turn exports are made in, one at a time.
type sandboxMoves struct {
	mu        sync.Mutex
	cancelled map[string]map[string]bool
	// deletes counts each sandbox's deletes here (dropSandboxImport): an import whose preparation began before one is
	// never made ready after it (ImportGeneration).
	deletes map[string]uint64
	turn    sync.Mutex
}

func (m *Manager) sandboxExportDir(id, version string) string {
	return filepath.Join(m.cfg.Root, sandboxExportsDir, id, version)
}

func (m *Manager) sandboxImportDir(id, version string) string {
	return filepath.Join(m.cfg.Root, sandboxImportsDir, id, version)
}

// sandboxObject says whether id and version name a moved sandbox's version as an object.
func sandboxObject(id, version string) bool { return validID(id) && validID(version) }

// sandboxPartMap is a part's map in an export's directory.
func sandboxPartMap(part string) string { return part + ".map" }

// exportWhole says whether an export is whole: its record and every part's map are there (its maps are written last).
func (m *Manager) exportWhole(id, version string) bool {
	dir := m.sandboxExportDir(id, version)
	if !fileExists(filepath.Join(dir, sandboxRecordName)) {
		return false
	}
	for _, part := range SandboxParts {
		if !fileExists(filepath.Join(dir, sandboxPartMap(part))) {
			return false
		}
	}
	return true
}

// ExportSandbox makes version of a stopped sandbox's object (sandbox.export): its disk and sticky drives cloned into
// the export's directory while it is stopped, its record beside them, then each mapped. Asked again, it answers the
// version it made. A conflict unless the sandbox is stopped, or with Live running. With Base, an export of the sandbox
// here, each part's map is made from that version's.
func (m *Manager) ExportSandbox(ctx context.Context, p proto.SandboxExportParams) (proto.SandboxExportResult, error) {
	if !sandboxObject(p.SandboxID, p.Version) || (p.Base != "" && (!validID(p.Base) || p.Base == p.Version)) {
		return proto.SandboxExportResult{}, &proto.Error{Code: proto.ErrInvalid, Message: "bad sandbox ID or version"}
	}
	s, err := m.get(p.SandboxID)
	if err != nil {
		return proto.SandboxExportResult{}, err
	}
	dir := m.sandboxExportDir(p.SandboxID, p.Version)
	// One at a time: each reads whole files.
	m.moves.turn.Lock()
	defer m.moves.turn.Unlock()
	if !m.exportWhole(p.SandboxID, p.Version) {
		if err := m.cloneForExport(s, dir, p); err != nil {
			_ = os.RemoveAll(dir)
			return proto.SandboxExportResult{}, err
		}
		if err := m.mapExport(ctx, s, dir, m.exportBase(p.SandboxID, p.Base)); err != nil {
			_ = os.RemoveAll(dir)
			return proto.SandboxExportResult{}, err
		}
	}
	digest, err := exportDigest(dir)
	if err != nil {
		return proto.SandboxExportResult{}, err
	}
	var bytes int64
	for _, part := range SandboxParts {
		bytes += diskUsage(filepath.Join(dir, sandboxPartFiles[part]))
	}
	return proto.SandboxExportResult{MapDigest: digest, AllocatedBytes: bytes}, nil
}

// cloneForExport clones a stopped sandbox's files into dir, made afresh, and writes its record there last: under its
// lock, so nothing starts or stops it meanwhile, and what is cloned is one state of it. A running one (Live) is
// cloned as it runs: each file as a crash would leave it, its guest's caches not flushed (a reflink takes the file's
// blocks at once, after the host's own writes of it are flushed).
func (m *Manager) cloneForExport(s *sandbox, dir string, p proto.SandboxExportParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.State != proto.StateStopped && (!p.Live || s.meta.State != proto.StateRunning) {
		if p.Live {
			return conflict("sandbox %s is %s: only a running or stopped sandbox is moved", s.meta.ID, s.meta.State)
		}
		return conflict("sandbox %s is %s: only a stopped sandbox is moved", s.meta.ID, s.meta.State)
	}
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	vm := s.vmDir()
	for _, part := range SandboxParts {
		name := sandboxPartFiles[part]
		src, dst := filepath.Join(vm, name), filepath.Join(dir, name)
		if _, err := os.Stat(src); errors.Is(err, fs.ErrNotExist) && part != proto.SandboxPartDisk {
			// A drive the VM hasn't (one made before sticky drives): an empty file, as a drive with no disk is.
			if err := newStickyPlaceholder(dst); err != nil {
				return err
			}
			continue
		}
		if err := m.cloneExportFile(src, dst); err != nil {
			return fmt.Errorf("its %s: %w", part, err)
		}
	}
	rootfs := vmRootfs(vm)
	if rootfs == "" {
		return fmt.Errorf("sandbox %s has no root filesystem", s.meta.ID)
	}
	rec := sandboxRecord{Meta: s.meta, Rootfs: rootfs}
	// What its image has, as this host knows it: its template's report, or its image version's, which the target may
	// not have (it hasn't booted that version), so it keeps it as the sandbox's own. Nil where none is known.
	rec.Meta.Guest = m.sandboxGuest(s)
	if key, ok := templateRootfsKey(rootfs); ok {
		if rec.RootfsDigest = m.rootfsMapDigest(key); rec.RootfsDigest == "" {
			return fmt.Errorf("its template root filesystem %s isn't mapped yet, so another host can't tell it has the same build", key)
		}
	}
	raw, _ := json.MarshalIndent(rec, "", "  ")
	if err := fsutil.WriteFileDurably(filepath.Join(dir, sandboxRecordName), raw, 0o600); err != nil {
		return err
	}
	// The copy this version exported, which its source cleanup deletes (DeleteExported).
	s.meta.Exported = p.Version
	return m.writeMeta(s)
}

// cloneExportFile is cloneDisk for an export: a reflink takes no room; a full copy, on a file system without them,
// first reserves the room it writes beside every other copy under way.
func (m *Manager) cloneExportFile(src, dst string) error {
	if fsutil.Reflink(src, dst) == nil {
		return nil
	}
	_ = os.Remove(dst)
	release, err := m.reserveRoom(diskUsage(src), func(free, size int64) error {
		return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf(
			"This host has %s of disk free, and copying the sandbox's files to move it writes %s and must leave %s free.",
			gibText(max(free, 0)), gibText(size), gibText(snapshotHeadroom))}
	})
	if err != nil {
		return err
	}
	defer release()
	out, err := exec.Command("cp", "--sparse=always", src, dst).CombinedOutput()
	if err != nil {
		return fmt.Errorf("copy %s: %v: %s", filepath.Base(src), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// mapExport makes each part's map in an export's directory. Each starts from the same part of an earlier export of
// the sandbox (baseDir, where there is one), else a sticky drive's from the map of the version its disk was cloned
// from, where the host still holds it, so only the blocks they don't share are read.
func (m *Manager) mapExport(ctx context.Context, s *sandbox, dir, baseDir string) error {
	s.mu.Lock()
	disks := attachedSticky(s.meta.StickyDisks)
	s.mu.Unlock()
	for _, part := range SandboxParts {
		f, err := os.Open(filepath.Join(dir, sandboxPartFiles[part]))
		if err != nil {
			return err
		}
		var base *blockmap.Base
		if baseDir != "" {
			base = partBase(filepath.Join(baseDir, sandboxPartFiles[part]), filepath.Join(baseDir, sandboxPartMap(part)))
		}
		for _, d := range disks {
			if base == nil && stickyDriveID(d.Slot) == part && d.Version != "" {
				base = m.stickyBase(d.DiskID, d.Version)
			}
		}
		start := time.Now()
		bm, st, err := blockmap.Make(ctx, f, base)
		f.Close()
		if base != nil {
			base.File.Close()
		}
		if err != nil {
			return fmt.Errorf("mapping its %s: %w", part, err)
		}
		if _, err := blockmap.WriteFile(filepath.Join(dir, sandboxPartMap(part)), bm); err != nil {
			return err
		}
		m.log.Info("moved sandbox's part mapped", "sandbox", s.meta.ID, "part", part, "blocks", st.Blocks,
			"reused", st.Reused, "empty", st.Empty, "read", st.Read, "took", time.Since(start).Round(time.Millisecond))
	}
	return syncDir(dir)
}

// stickyBase is a sticky disk version the host holds, open, with its map, for a map of a clone of it to start from:
// nil when it hasn't both.
func (m *Manager) stickyBase(diskID, version string) *blockmap.Base {
	return partBase(m.stickyVersionFile(diskID, version), m.stickyMapFile(diskID, version))
}

// partBase is a file, open, with its map, for a map of a clone of it to start from: nil when it hasn't both.
func partBase(file, mapFile string) *blockmap.Base {
	bm, _, err := blockmap.ReadFile(mapFile)
	if err != nil {
		return nil
	}
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	return &blockmap.Base{File: f, Map: bm}
}

// exportBase is the directory of export base of a sandbox, for the maps of a later export to start from: "" with no
// base, or one that isn't whole here (deleted meanwhile), whose later export then reads every block.
func (m *Manager) exportBase(id, base string) string {
	if base == "" {
		return ""
	}
	if !m.exportWhole(id, base) {
		m.log.Warn("a moved sandbox's export has no base here to map from; every block is read", "sandbox", id, "base", base)
		return ""
	}
	return m.sandboxExportDir(id, base)
}

// exportDigest is the digest of an export's manifest, made from its parts' maps.
func exportDigest(dir string) (string, error) {
	digests := make([]disksync.PartDigest, 0, len(SandboxParts))
	for _, part := range SandboxParts {
		raw, err := os.ReadFile(filepath.Join(dir, sandboxPartMap(part)))
		if err != nil {
			return "", err
		}
		digests = append(digests, disksync.PartDigest{Part: part, Digest: blockmap.Digest(raw)})
	}
	return blockmap.Digest(disksync.Manifest(digests)), nil
}

// DeleteSandboxExport deletes version of a sandbox's exports, or every one with no version (sandbox.export.delete). A
// fetch reading one already has its files open, and ends with what it read; an export being made fails, its
// directory gone. It doesn't wait for exports being made (moves.turn): a delete never waits on another's map.
func (m *Manager) DeleteSandboxExport(id, version string) error {
	if !validID(id) || (version != "" && !validID(version)) {
		return &proto.Error{Code: proto.ErrInvalid, Message: "bad sandbox ID or version"}
	}
	if version == "" {
		return os.RemoveAll(filepath.Join(m.cfg.Root, sandboxExportsDir, id))
	}
	if err := os.RemoveAll(m.sandboxExportDir(id, version)); err != nil {
		return err
	}
	// The sandbox's directory, once it has none left.
	_ = os.Remove(filepath.Join(m.cfg.Root, sandboxExportsDir, id))
	return nil
}

// HoldsSandbox says whether the host has a moved sandbox's version: an export of it whole, the import of it kept
// staged and fetched (ImportOptions.Stage), or the sandbox that version made here.
func (m *Manager) HoldsSandbox(id, version string) bool {
	if !sandboxObject(id, version) {
		return false
	}
	if m.exportWhole(id, version) || m.staged(id, version) {
		return true
	}
	s, err := m.get(id)
	return err == nil && madeBy(s, version)
}

// OpenSandboxPart opens one part of an export for a peer to fetch (disksync.Parted): its file, and with withMap its
// map's file. fs.ErrNotExist when the export isn't whole here. Open, the file stays readable whatever is deleted after.
func (m *Manager) OpenSandboxPart(id, version, part string, withMap bool) (*os.File, []byte, error) {
	name, ok := sandboxPartFiles[part]
	if !sandboxObject(id, version) || !ok || !m.exportWhole(id, version) {
		return nil, nil, fs.ErrNotExist
	}
	dir := m.sandboxExportDir(id, version)
	f, err := os.Open(filepath.Join(dir, name))
	if err != nil {
		return nil, nil, err
	}
	var raw []byte
	if withMap {
		raw, err = os.ReadFile(filepath.Join(dir, sandboxPartMap(part)))
	} else {
		_, err = os.Stat(filepath.Join(dir, sandboxPartMap(part)))
	}
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, raw, nil
}

// ReadSandboxFile reads one of an export's small files for a peer: its record (proto.SandboxRecordFile).
func (m *Manager) ReadSandboxFile(id, version, name string) ([]byte, error) {
	if !sandboxObject(id, version) || name != proto.SandboxRecordFile || !m.exportWhole(id, version) {
		return nil, fs.ErrNotExist
	}
	return os.ReadFile(filepath.Join(m.sandboxExportDir(id, version), sandboxRecordName))
}

// PrepareSandboxImport readies the host for a fetch of a moved sandbox's version, from its record as its holder has it:
// its size one this host makes, the root image its disk is over in place (localRootfs), and a VM directory staged in
// the version's own import directory (sandbox-imports/<id>/<version>/), linked to that image, with the record beside
// it, written last, with how it was asked for (opts). A version staged already is left as it is, so a fetch goes on
// where it stopped; any other version's import of the sandbox is dropped, but the one opts.Base names. ErrNoSnapshotImage,
// or why the image couldn't be had, when the host can't have it; a conflict when a sandbox of that ID is here, but the
// one this version made, or when the version's import was cancelled (CancelSandboxImport).
func (m *Manager) PrepareSandboxImport(ctx context.Context, id, version string, since uint64, raw []byte, opts ImportOptions) error {
	if !sandboxObject(id, version) || (opts.Base != "" && (!validID(opts.Base) || opts.Base == version)) {
		return &proto.Error{Code: proto.ErrInvalid, Message: "bad sandbox ID or version"}
	}
	if m.HoldsSandbox(id, version) {
		return nil
	}
	if _, err := m.get(id); err == nil {
		return conflict("sandbox %s already exists on this host", id)
	}
	if m.importCancelled(id, version) {
		return conflict("the move %s of sandbox %s here was cancelled", version, id)
	}
	var rec sandboxRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return fmt.Errorf("the sandbox's record: %w", err)
	}
	if rec.Meta.ID != id {
		return fmt.Errorf("the record isn't sandbox %s's", id)
	}
	if _, err := m.size(rec.Meta.Size); err != nil {
		return err
	}
	if rec.Meta.StickyDrives != 0 && rec.Meta.StickyDrives != StickyDrives {
		return fmt.Errorf("the sandbox has %d sticky drives, and a microVM here has %d", rec.Meta.StickyDrives, StickyDrives)
	}
	over := snapshotMeta{Rootfs: rec.Rootfs, RootfsDigest: rec.RootfsDigest}
	over.Runtime = rec.Meta.Runtime
	rootfs, err := m.localRootfs(ctx, over)
	if err != nil {
		return err
	}
	// Its root filesystem linked under the base lock, so a prune finds the reference in the import's VM directory from
	// then on (BasesUnder); and under the moves lock, so a cancel while the image was had is seen.
	defer m.holdBases()()
	m.moves.mu.Lock()
	defer m.moves.mu.Unlock()
	if m.moves.cancelled[id][version] {
		return conflict("the move %s of sandbox %s here was cancelled", version, id)
	}
	if m.moves.deletes[id] != since {
		return conflict("sandbox %s was deleted on this host while its import was made ready", id)
	}
	if m.importing(id, version) {
		return nil
	}
	if err := m.dropOtherImports(id, version, opts.Base); err != nil {
		return err
	}
	if !fileExists(rootfs) {
		return fmt.Errorf("%w: %s went while the import was made ready", ErrNoSnapshotImage, rootfs)
	}
	dir := m.sandboxImportDir(id, version)
	vm := filepath.Join(dir, "vm")
	if err := os.MkdirAll(vm, 0o700); err != nil {
		return err
	}
	fail := func(err error) error {
		_ = os.RemoveAll(dir)
		return err
	}
	if err := m.linkRootfs(vm, rootfs); err != nil {
		return fail(err)
	}
	rec.Rootfs = rootfs
	rec.Stage, rec.Base = opts.Stage, ""
	if opts.Base != "" && m.staged(id, opts.Base) {
		// Only a base fetched whole here: without one each part is fetched from an empty file.
		rec.Base = opts.Base
	}
	staged, _ := json.MarshalIndent(rec, "", "  ")
	// The record last: with it the import is made ready.
	if err := fsutil.WriteFileDurably(filepath.Join(dir, sandboxRecordName), staged, 0o600); err != nil {
		return fail(err)
	}
	return nil
}

// importing says whether the host has version of a sandbox's import made ready: its record staged.
func (m *Manager) importing(id, version string) bool {
	return fileExists(filepath.Join(m.sandboxImportDir(id, version), sandboxRecordName))
}

// staged says whether the host has version of a sandbox's import kept staged and fetched whole (ImportOptions.Stage).
func (m *Manager) staged(id, version string) bool {
	return m.importing(id, version) && fileExists(filepath.Join(m.sandboxImportDir(id, version), sandboxStagedName))
}

// dropOtherImports removes every import of a sandbox here but version's and keep's (under the moves lock).
func (m *Manager) dropOtherImports(id, version, keep string) error {
	entries, err := os.ReadDir(filepath.Join(m.cfg.Root, sandboxImportsDir, id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() == version || (keep != "" && e.Name() == keep) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(m.cfg.Root, sandboxImportsDir, id, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// stagedRecord reads the record staged for version's import of a sandbox.
func (m *Manager) stagedRecord(id, version string) (sandboxRecord, error) {
	var rec sandboxRecord
	raw, err := os.ReadFile(filepath.Join(m.sandboxImportDir(id, version), sandboxRecordName))
	if err != nil {
		return rec, fmt.Errorf("sandbox %s's staged record: %w", id, err)
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		return rec, fmt.Errorf("sandbox %s's staged record: %w", id, err)
	}
	return rec, nil
}

// CloneSandboxPartBase makes dst a clone of one part of the version version's import starts from (its staged record's
// Base, fetched whole here), and answers that part's map; nil, with no clone, when the import has no base. A full copy,
// where there are no reflinks, reserves its room as it is made.
func (m *Manager) CloneSandboxPartBase(id, version, part, dst string) (*blockmap.Map, error) {
	name, ok := sandboxPartFiles[part]
	if !sandboxObject(id, version) || !ok {
		return nil, fmt.Errorf("bad sandbox ID, version or part")
	}
	// Read under the moves lock; cloned outside it, so a full copy never holds up a cancel or a delete. A base removed
	// meanwhile fails the clone, and the part is fetched from an empty file.
	m.moves.mu.Lock()
	rec, err := m.stagedRecord(id, version)
	ok = err == nil && rec.Base != "" && m.staged(id, rec.Base)
	m.moves.mu.Unlock()
	if !ok {
		return nil, nil
	}
	dir := m.sandboxImportDir(id, rec.Base)
	bm, _, err := blockmap.ReadFile(filepath.Join(dir, sandboxPartMap(part)))
	if err != nil {
		return nil, err
	}
	if err := m.cloneExportFile(filepath.Join(dir, "vm", name), dst); err != nil {
		_ = os.Remove(dst)
		return nil, err
	}
	return bm, nil
}

// ImportGeneration is how many deletes of a sandbox this host has had: an import read before its preparation, which a
// delete since then refuses (PrepareSandboxImport's since).
func (m *Manager) ImportGeneration(id string) uint64 {
	m.moves.mu.Lock()
	defer m.moves.mu.Unlock()
	return m.moves.deletes[id]
}

// importCancelled says whether version's import of a sandbox was cancelled here (CancelSandboxImport).
func (m *Manager) importCancelled(id, version string) bool {
	m.moves.mu.Lock()
	defer m.moves.mu.Unlock()
	return m.moves.cancelled[id][version]
}

// SandboxPartPartial is where a fetch of a moved sandbox's part writes: its file in the version's import's VM
// directory, once that is made ready (PrepareSandboxImport). Each version has its own, which is never made again
// once it goes: a fetch of a version no longer made ready finds nowhere to write.
func (m *Manager) SandboxPartPartial(id, version, part string) (string, error) {
	name, ok := sandboxPartFiles[part]
	if !sandboxObject(id, version) || !ok {
		return "", fmt.Errorf("bad sandbox ID, version or part")
	}
	if !m.importing(id, version) {
		return "", fmt.Errorf("sandbox %s's import of %s wasn't made ready: its root image may not be here", id, version)
	}
	return filepath.Join(m.sandboxImportDir(id, version), "vm", name), nil
}

// ReserveSandboxFetch holds room for the bytes a fetch of a moved sandbox is to write, beside every other copy the
// host makes, until release: refused (ErrCapacity) when that would leave the host less than snapshotHeadroom free.
func (m *Manager) ReserveSandboxFetch(bytes int64) (release func(), err error) {
	return m.reserveRoom(bytes, func(free, size int64) error {
		return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf(
			"This host has %s of disk free, and fetching the sandbox writes %s and must leave %s free.",
			gibText(max(free, 0)), gibText(size), gibText(snapshotHeadroom))}
	})
}

// PublishFetchedSandbox makes a fetched sandbox this host's (disksync.Parted): its record, staged, made this host's
// (stopped, no memory, its bundle drives empty, its egress without the other host's CA, marked as made by this
// version), its version's import directory renamed to the sandbox's, and the sandbox registered, stopped. All of it
// under the base lock, so a prune sees the image it is over in the import or in the sandbox, never in neither, and the
// moves lock, so an import deleted or cancelled meanwhile, or whose partials were removed, isn't published.
func (m *Manager) PublishFetchedSandbox(id, version string, parts map[string]disksync.FetchedPart) error {
	if !sandboxObject(id, version) {
		return fmt.Errorf("bad sandbox ID or version")
	}
	if m.HoldsSandbox(id, version) {
		return nil
	}
	defer m.holdBases()()
	m.moves.mu.Lock()
	defer m.moves.mu.Unlock()
	if m.moves.cancelled[id][version] || !m.importing(id, version) {
		return fmt.Errorf("sandbox %s's import was deleted on this host while it was fetched", id)
	}
	dir := m.sandboxImportDir(id, version)
	vm := filepath.Join(dir, "vm")
	for _, part := range SandboxParts {
		got, ok := parts[part]
		if !ok {
			return fmt.Errorf("the fetch has no %s", part)
		}
		mine, err := got.File.Stat()
		if err != nil {
			return err
		}
		if !sameFileAt(mine, filepath.Join(vm, sandboxPartFiles[part])) {
			return fmt.Errorf("the fetch of sandbox %s was removed before it was published", id)
		}
	}
	rec, err := m.stagedRecord(id, version)
	if err != nil {
		return err
	}
	if rec.Stage {
		return m.keepStaged(id, version, parts)
	}
	if !fileExists(rec.Rootfs) {
		return fmt.Errorf("%w: %s is gone", ErrNoSnapshotImage, rec.Rootfs)
	}
	s := &sandbox{dir: filepath.Join(m.cfg.Root, "sandboxes", id)}
	s.meta = importedMeta(rec.Meta, version, m.pulledRootfs(rec.Rootfs), rec.Rootfs)
	s.healthAt = s.meta.HealthAt
	for _, part := range SandboxParts {
		_ = os.Remove(filepath.Join(vm, sandboxPartFiles[part]+".done"))
	}
	if s.meta.StickyDrives == 0 {
		// A VM from before sticky drives has none: the empty files fetched for them go.
		for k := range StickyDrives {
			_ = os.Remove(filepath.Join(vm, stickyDriveFile(k)))
		}
	}
	for i := range s.meta.BundleDrives {
		_ = os.Remove(filepath.Join(vm, bundleDriveFile(i)))
	}
	if err := emptyDrives(vm, s.meta.BundleDrives); err != nil {
		return err
	}
	metaRaw, _ := json.MarshalIndent(s.meta, "", "  ")
	if err := fsutil.WriteFileDurably(filepath.Join(dir, "meta.json"), metaRaw, 0o600); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(m.cfg.Root, "sandboxes"), 0o700); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sandboxes[id]; ok {
		return conflict("sandbox %s already exists on this host", id)
	}
	// The record goes before the rename: in sandboxes/ the directory is the sandbox's alone.
	if err := os.Remove(filepath.Join(dir, sandboxRecordName)); err != nil {
		return err
	}
	if err := os.Rename(dir, s.dir); err != nil {
		return err
	}
	// What is left of its imports (the staged version it started from) goes with the publish.
	_ = os.RemoveAll(filepath.Join(m.cfg.Root, sandboxImportsDir, id))
	if err := syncDir(filepath.Join(m.cfg.Root, "sandboxes")); err != nil {
		m.log.Warn("syncing the sandboxes directory after a moved sandbox was published", "sandbox", id, "error", err)
	}
	m.sandboxes[id] = s
	m.log.Info("moved sandbox published", "sandbox", id, "version", version)
	return nil
}

// keepStaged keeps a fetched version staged (ImportOptions.Stage), under the moves lock: each part's map written beside
// it, its fetch's bitmaps gone, and the mark that it is whole written last.
func (m *Manager) keepStaged(id, version string, parts map[string]disksync.FetchedPart) error {
	dir := m.sandboxImportDir(id, version)
	for _, part := range SandboxParts {
		if err := fsutil.WriteFileDurably(filepath.Join(dir, sandboxPartMap(part)), parts[part].Map, 0o600); err != nil {
			return err
		}
		_ = os.Remove(filepath.Join(dir, "vm", sandboxPartFiles[part]+".done"))
	}
	if err := fsutil.WriteFileDurably(filepath.Join(dir, sandboxStagedName), nil, 0o600); err != nil {
		return err
	}
	m.log.Info("moved sandbox's first copy staged", "sandbox", id, "version", version)
	return nil
}

// importedMeta is a moved sandbox's record made this host's: stopped, with no machine, memory or error, its bundle
// drives empty (its bundles are mounted again from this host's cache as it starts), its egress without the other
// host's CA (its start sends its egress, and this host's CA with it), its root filesystem this host's file where it
// is a template's, and marked as made by version.
func importedMeta(src meta, version string, pulled bool, rootfs string) meta {
	out := src
	out.State, out.Pid, out.Slot, out.CID, out.Memory, out.Error = proto.StateStopped, 0, 0, 0, false, ""
	out.BundleSlots = make([]string, out.BundleDrives)
	if out.Egress != nil {
		e := *out.Egress
		e.CACert = ""
		out.Egress = &e
	}
	out.Rootfs = ""
	if pulled {
		out.Rootfs = rootfs
	}
	out.Imported, out.Exported = version, ""
	return out
}

// ImportedSandbox is the sandbox version made here, as sandbox.import answers it.
func (m *Manager) ImportedSandbox(id, version string) (proto.SandboxInfo, error) {
	s, err := m.get(id)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.Imported != version {
		return proto.SandboxInfo{}, conflict("sandbox %s on this host wasn't made by this move", id)
	}
	return m.info(s), nil
}

// SandboxImportPartials are none: an import is fetched only while its sandbox.import asks for it, which the control
// plane sends again to go on with one cut short; never resumed by the host on its own.
func (m *Manager) SandboxImportPartials() [][2]string { return nil }

// DiscardSandboxImport drops version's import of a sandbox, if it is made ready, and everything it fetched.
func (m *Manager) DiscardSandboxImport(id, version string) {
	if !sandboxObject(id, version) {
		return
	}
	m.moves.mu.Lock()
	defer m.moves.mu.Unlock()
	_ = os.RemoveAll(m.sandboxImportDir(id, version))
	_ = os.Remove(filepath.Join(m.cfg.Root, sandboxImportsDir, id))
}

// CancelSandboxImport ends version's import of a sandbox here for good (sandbox.import.cancel, a move rolled back):
// whatever it staged or fetched goes, a sandbox it made here is deleted, and it is never made ready or published after,
// even by a sandbox.import still under way. Says whether it deleted a sandbox.
func (m *Manager) CancelSandboxImport(id, version string) (bool, error) {
	if !sandboxObject(id, version) {
		return false, &proto.Error{Code: proto.ErrInvalid, Message: "bad sandbox ID or version"}
	}
	m.moves.mu.Lock()
	if m.moves.cancelled == nil {
		m.moves.cancelled = map[string]map[string]bool{}
	}
	if m.moves.cancelled[id] == nil {
		m.moves.cancelled[id] = map[string]bool{}
	}
	m.moves.cancelled[id][version] = true
	err := os.RemoveAll(m.sandboxImportDir(id, version))
	_ = os.Remove(filepath.Join(m.cfg.Root, sandboxImportsDir, id))
	m.moves.mu.Unlock()
	if err != nil {
		return false, err
	}
	if s, err := m.get(id); err != nil || !madeBy(s, version) {
		return false, nil
	}
	if err := m.deleteSandbox(id, false); err != nil {
		return false, err
	}
	return true, nil
}

// DeleteExported removes a sandbox moved to another host (sandbox.delete with Exported), its automatic snapshots kept,
// only while it is the copy move version exported: ErrNotFound for one a later move made here since.
func (m *Manager) DeleteExported(id, version string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	exported := s.meta.Exported
	s.mu.Unlock()
	if exported != version {
		return &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("sandbox %s here isn't the copy move %s exported", id, version)}
	}
	return m.deleteSandbox(id, true)
}

// madeBy says whether a sandbox here was made by version's import.
func madeBy(s *sandbox, version string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.meta.Imported == version
}

// dropSandboxImport ends any import of a sandbox here, as its delete does: every version's import directory goes, a
// fetch of one finds nowhere to write or publish, and an import whose preparation began before it is never made ready
// (deletes). Whether there was one.
func (m *Manager) dropSandboxImport(id string) bool {
	m.moves.mu.Lock()
	defer m.moves.mu.Unlock()
	if m.moves.deletes == nil {
		m.moves.deletes = map[string]uint64{}
	}
	m.moves.deletes[id]++
	dir := filepath.Join(m.cfg.Root, sandboxImportsDir, id)
	if _, err := os.Lstat(dir); err != nil {
		return false
	}
	_ = os.RemoveAll(dir)
	return true
}
