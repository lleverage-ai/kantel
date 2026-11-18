package microvm

// A sandbox moved with its memory (proto.FeatureSandboxMoveMemory; docs/design/disk-store.md, "Moving a sandbox to
// another host", keeping memory): stopped keeping its memory, its export (ExportSandbox with Memory) makes, beside its
// disk's version, the same version of a second object, kind proto.DiskKindSandboxMemory, its ID the sandbox's. Its
// parts are its memory file (mem) and the files on its bundle drives (bundle0 to bundle7, an empty file for a drive
// with nothing on it), each block-mapped, so a memory that is mostly zero costs little to fetch; its small file is the
// machine's state. They are cloned into the export's directory with its disk's, under the same lock, so the memory is
// of the disk exported with it. The guest has its bundle drives mounted in that memory, so it gets the holder's bytes
// of them, never this host's own build of a bundle, which may differ.
//
// On the target, an import asked with its memory (ImportOptions.Memory) fetches the memory's version first, into the
// import's memory directory (sandbox-imports/<id>/<version>/memory/), each bundle drive's fetch starting from the
// image of the same bundle in this host's cache, so only the blocks that differ come; then the disk's version, as any.
// Publishing that moves the memory, the state and the bundle drives' files into the VM directory, and the sandbox is
// stopped with its memory: its start restores it, its processes carrying on.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/bundles"
	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// SandboxMemoryParts are a moved sandbox's memory's parts, in the order its manifest has them.
var SandboxMemoryParts = proto.SandboxMemoryParts

// SandboxMemoryFiles are a moved sandbox's memory's small files, which a fetch takes whole: the machine's state.
var SandboxMemoryFiles = []string{proto.SandboxStateFile}

const (
	// sandboxMemoryDir, in an import's directory, is where its memory is fetched.
	sandboxMemoryDir = "memory"
	// sandboxMemoryFetched marks an import's memory fetched whole: written last.
	sandboxMemoryFetched = "fetched"
	// sandboxStateName is the machine's state in an export's directory, in an import's memory directory, and in a VM's.
	sandboxStateName = "state"
)

// memoryPartFile is the file a memory part is in an export's directory, an import's memory directory and a VM's: mem,
// or bundle<i>.erofs. "" for a name that isn't one of its parts.
func memoryPartFile(part string) string {
	if part == proto.SandboxPartMemory {
		return "mem"
	}
	if i, ok := memoryBundle(part); ok {
		return bundleDriveFile(i)
	}
	return ""
}

// memoryBundle is the bundle drive a memory part is, bundle0 to bundle7.
func memoryBundle(part string) (int, bool) {
	rest, ok := strings.CutPrefix(part, "bundle")
	if !ok {
		return 0, false
	}
	for i := range proto.SandboxMemoryBundles {
		if rest == fmt.Sprint(i) {
			return i, true
		}
	}
	return 0, false
}

// memoryPartMap is a memory part's map in an export's directory, an import's memory directory too.
func memoryPartMap(part string) string { return "memory-" + part + ".map" }

// SandboxMemory is sandbox.memory: what a move of the sandbox with its memory would carry (proto.SandboxMemoryInfo).
func (m *Manager) SandboxMemory(id string) (proto.SandboxMemoryInfo, error) {
	s, err := m.get(id)
	if err != nil {
		return proto.SandboxMemoryInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info := proto.SandboxMemoryInfo{Runtime: s.meta.Runtime}
	if s.meta.BundleDrives > proto.SandboxMemoryBundles {
		info.Refused = fmt.Sprintf("its machine has %d bundle drives, and a move keeps the memory of one with at most %d", s.meta.BundleDrives, proto.SandboxMemoryBundles)
	}
	switch {
	case s.meta.State == proto.StateRunning && s.machine != nil:
		info.Memory = true
		if rss, err := usage.ReadRSS(s.machine.Pid()); err == nil {
			info.Bytes = rss
		}
	case s.meta.State == proto.StateStopped && s.meta.Memory && fileExists(filepath.Join(s.vmDir(), "mem")):
		info.Memory = true
		info.Bytes = diskUsage(filepath.Join(s.vmDir(), "mem"))
	default:
		info.Runtime = ""
	}
	return info, nil
}

// cloneMemoryForExport clones a sandbox's memory, its machine's state and its bundle drives' files into an export's
// directory, with s.mu held while it is stopped with its memory: one state of it, with the disk cloned beside it.
func (m *Manager) cloneMemoryForExport(s *sandbox, dir string) error {
	vm := s.vmDir()
	if s.meta.State != proto.StateStopped || !s.meta.Memory || !fileExists(filepath.Join(vm, "mem")) || !fileExists(filepath.Join(vm, "state")) {
		return conflict("sandbox %s has no memory to move: it was stopped without it", s.meta.ID)
	}
	if s.meta.BundleDrives > proto.SandboxMemoryBundles {
		return conflict("sandbox %s's machine has %d bundle drives, and a move keeps the memory of one with at most %d", s.meta.ID, s.meta.BundleDrives, proto.SandboxMemoryBundles)
	}
	raw, err := os.ReadFile(filepath.Join(vm, "state"))
	if err != nil {
		return err
	}
	if err := fsutil.WriteFileDurably(filepath.Join(dir, sandboxStateName), raw, 0o600); err != nil {
		return err
	}
	for _, part := range SandboxMemoryParts {
		name := memoryPartFile(part)
		dst := filepath.Join(dir, name)
		if i, ok := memoryBundle(part); ok && (i >= s.meta.BundleDrives || i >= len(s.meta.BundleSlots) || s.meta.BundleSlots[i] == "") {
			// A drive with nothing on it, or one the machine hasn't: an empty file.
			if err := newEmptyFile(dst); err != nil {
				return err
			}
			continue
		}
		if err := m.cloneExportFile(filepath.Join(vm, name), dst); err != nil {
			return fmt.Errorf("its %s: %w", part, err)
		}
	}
	return nil
}

// mapMemoryExport makes each memory part's map in an export's directory.
func (m *Manager) mapMemoryExport(ctx context.Context, id, dir string) error {
	for _, part := range SandboxMemoryParts {
		f, err := os.Open(filepath.Join(dir, memoryPartFile(part)))
		if err != nil {
			return err
		}
		start := time.Now()
		bm, st, err := blockmap.Make(ctx, f, nil)
		f.Close()
		if err != nil {
			return fmt.Errorf("mapping its %s: %w", part, err)
		}
		if _, err := blockmap.WriteFile(filepath.Join(dir, memoryPartMap(part)), bm); err != nil {
			return err
		}
		if part == proto.SandboxPartMemory {
			m.log.Info("moved sandbox's memory mapped", "sandbox", id, "blocks", st.Blocks, "empty", st.Empty,
				"read", st.Read, "took", time.Since(start).Round(time.Millisecond))
		}
	}
	return syncDir(dir)
}

// memoryExportWhole says whether an export has its memory whole: the machine's state and every memory part's map (its
// maps are written last).
func (m *Manager) memoryExportWhole(id, version string) bool {
	dir := m.sandboxExportDir(id, version)
	if !fileExists(filepath.Join(dir, sandboxStateName)) {
		return false
	}
	for _, part := range SandboxMemoryParts {
		if !fileExists(filepath.Join(dir, memoryPartMap(part))) {
			return false
		}
	}
	return true
}

// memoryExportDigest is the digest of an export's memory's manifest, made from its parts' maps.
func memoryExportDigest(dir string) (string, error) {
	digests := make([]disksync.PartDigest, 0, len(SandboxMemoryParts))
	for _, part := range SandboxMemoryParts {
		raw, err := os.ReadFile(filepath.Join(dir, memoryPartMap(part)))
		if err != nil {
			return "", err
		}
		digests = append(digests, disksync.PartDigest{Part: part, Digest: blockmap.Digest(raw)})
	}
	return blockmap.Digest(disksync.Manifest(digests)), nil
}

// HoldsSandboxMemory says whether the host has a moved sandbox's memory's version: its export whole, the import's
// memory fetched whole, or the sandbox that version made here with it.
func (m *Manager) HoldsSandboxMemory(id, version string) bool {
	if !sandboxObject(id, version) {
		return false
	}
	if m.memoryExportWhole(id, version) || m.memoryFetched(id, version) {
		return true
	}
	s, err := m.get(id)
	return err == nil && madeBy(s, version)
}

// OpenSandboxMemoryPart opens one memory part of an export for a peer to fetch: its file, and with withMap its map's
// file. fs.ErrNotExist when the export hasn't its memory whole.
func (m *Manager) OpenSandboxMemoryPart(id, version, part string, withMap bool) (*os.File, []byte, error) {
	name := memoryPartFile(part)
	if !sandboxObject(id, version) || name == "" || !m.memoryExportWhole(id, version) {
		return nil, nil, fs.ErrNotExist
	}
	dir := m.sandboxExportDir(id, version)
	f, err := os.Open(filepath.Join(dir, name))
	if err != nil {
		return nil, nil, err
	}
	var raw []byte
	if withMap {
		raw, err = os.ReadFile(filepath.Join(dir, memoryPartMap(part)))
	} else {
		_, err = os.Stat(filepath.Join(dir, memoryPartMap(part)))
	}
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, raw, nil
}

// ReadSandboxMemoryFile reads an export's memory's small file for a peer: the machine's state.
func (m *Manager) ReadSandboxMemoryFile(id, version, name string) ([]byte, error) {
	if !sandboxObject(id, version) || name != proto.SandboxStateFile || !m.memoryExportWhole(id, version) {
		return nil, fs.ErrNotExist
	}
	return os.ReadFile(filepath.Join(m.sandboxExportDir(id, version), sandboxStateName))
}

// importMemoryDir is where an import's memory is fetched.
func (m *Manager) importMemoryDir(id, version string) string {
	return filepath.Join(m.sandboxImportDir(id, version), sandboxMemoryDir)
}

// memoryFetched says whether an import's memory is fetched whole here.
func (m *Manager) memoryFetched(id, version string) bool {
	return fileExists(filepath.Join(m.importMemoryDir(id, version), sandboxMemoryFetched))
}

// SandboxMemoryPartPartial is where a fetch of a moved sandbox's memory part writes: its file in the import's memory
// directory, once the import is made ready asking for its memory (PrepareSandboxImport).
func (m *Manager) SandboxMemoryPartPartial(id, version, part string) (string, error) {
	name := memoryPartFile(part)
	if !sandboxObject(id, version) || name == "" {
		return "", fmt.Errorf("bad sandbox ID, version or part")
	}
	m.moves.mu.Lock()
	defer m.moves.mu.Unlock()
	rec, err := m.stagedRecord(id, version)
	if err != nil || !rec.Memory {
		return "", fmt.Errorf("sandbox %s's import of %s wasn't made ready with its memory", id, version)
	}
	dir := m.importMemoryDir(id, version)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(dir, name), nil
}

// CloneSandboxMemoryPartNearest makes dst a clone of this host's nearest file for a memory part: for a bundle drive,
// the image of the bundle on it in this host's cache, so only the blocks its holder's build has otherwise are fetched.
// Nil, with no clone, for the memory file and for a drive with nothing on it.
func (m *Manager) CloneSandboxMemoryPartNearest(id, version, part, dst string) (*blockmap.Map, error) {
	i, ok := memoryBundle(part)
	if !ok || !sandboxObject(id, version) || m.cfg.Bundles == nil {
		return nil, nil
	}
	m.moves.mu.Lock()
	rec, err := m.stagedRecord(id, version)
	m.moves.mu.Unlock()
	if err != nil || i >= len(rec.Meta.BundleSlots) || !bundles.ValidDigest(rec.Meta.BundleSlots[i]) {
		return nil, nil
	}
	return m.cloneBundleImage(rec.Meta.BundleSlots[i], dst)
}

// PublishFetchedSandboxMemory keeps a fetched memory in the import's memory directory, under the moves lock: the
// machine's state written beside it, then the mark that it is whole. The disk's publish (PublishFetchedSandbox) moves
// it into the sandbox's VM directory.
func (m *Manager) PublishFetchedSandboxMemory(id, version string, parts map[string]disksync.FetchedPart, files map[string][]byte) error {
	if !sandboxObject(id, version) {
		return fmt.Errorf("bad sandbox ID or version")
	}
	m.moves.mu.Lock()
	defer m.moves.mu.Unlock()
	if m.moves.cancelled[id][version] || !m.importing(id, version) {
		return fmt.Errorf("sandbox %s's import was deleted on this host while its memory was fetched", id)
	}
	dir := m.importMemoryDir(id, version)
	for _, part := range SandboxMemoryParts {
		got, ok := parts[part]
		if !ok {
			return fmt.Errorf("the fetch has no %s", part)
		}
		mine, err := got.File.Stat()
		if err != nil {
			return err
		}
		if !sameFileAt(mine, filepath.Join(dir, memoryPartFile(part))) {
			return fmt.Errorf("the fetch of sandbox %s's memory was removed before it was published", id)
		}
		if err := fsutil.WriteFileDurably(filepath.Join(dir, memoryPartMap(part)), got.Map, 0o600); err != nil {
			return err
		}
	}
	state := files[proto.SandboxStateFile]
	if len(state) == 0 {
		return errors.New("the fetch has no machine state")
	}
	if err := fsutil.WriteFileDurably(filepath.Join(dir, sandboxStateName), state, 0o600); err != nil {
		return err
	}
	if err := fsutil.WriteFileDurably(filepath.Join(dir, sandboxMemoryFetched), nil, 0o600); err != nil {
		return err
	}
	m.log.Info("moved sandbox's memory fetched", "sandbox", id, "version", version)
	return nil
}

// DiscardSandboxMemoryImport drops what a fetch of an import's memory wrote, unless it is fetched whole.
func (m *Manager) DiscardSandboxMemoryImport(id, version string) {
	if !sandboxObject(id, version) {
		return
	}
	m.moves.mu.Lock()
	defer m.moves.mu.Unlock()
	if m.memoryFetched(id, version) {
		return
	}
	_ = os.RemoveAll(m.importMemoryDir(id, version))
}

// placeImportedMemory moves an import's fetched memory into its VM directory vm, under the moves lock: the memory, the
// machine's state, and each bundle drive's file where its machine has the drive with something on it (an empty file
// for the rest, as emptyDrives makes).
func (m *Manager) placeImportedMemory(id, version, vm string, mt meta) error {
	dir := m.importMemoryDir(id, version)
	if !m.memoryFetched(id, version) {
		return fmt.Errorf("sandbox %s's memory wasn't fetched with its disk", id)
	}
	if err := os.Rename(filepath.Join(dir, "mem"), filepath.Join(vm, "mem")); err != nil {
		return err
	}
	if err := os.Rename(filepath.Join(dir, sandboxStateName), filepath.Join(vm, "state")); err != nil {
		return err
	}
	for i := range mt.BundleDrives {
		dst := filepath.Join(vm, bundleDriveFile(i))
		_ = os.Remove(dst)
		if i < len(mt.BundleSlots) && mt.BundleSlots[i] != "" {
			if err := os.Rename(filepath.Join(dir, bundleDriveFile(i)), dst); err != nil {
				return err
			}
			continue
		}
		if err := newEmptyFile(dst); err != nil {
			return err
		}
	}
	return os.RemoveAll(dir)
}
