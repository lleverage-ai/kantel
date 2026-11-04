package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
)

// A sandbox's base is the root filesystem its disk is a layer over. With versioned images (package images) Rootfs is
// a link to the current version, and each VM directory links the file it resolved to when the sandbox was made: an
// update repoints Rootfs, so new sandboxes start on the new version, while a running or stopped one stays on its own
// until a start with Rebase moves it. The kernel is the version's too (kernelFor): a sandbox boots the kernel and root
// filesystem of one version, whatever is current.
//
// The base lock (Manager.bases) keeps a prune of old versions from missing a reference in flight: every step that
// reads a reference to a version and writes another (a create linking its template's or snapshot's base, a
// template's build and swap, a snapshot's save, a rebase) holds it to read, and a
// prune holds it to write from its walk of what is in use (BasesInUse) until it has removed what wasn't (LockBases).
// Each is held only for those few file operations, never across a boot or a copy, so a waiting prune doesn't hold up
// creates for long.

// holdBases holds the base lock to read, until the returned func is called.
func (m *Manager) holdBases() func() {
	m.bases.RLock()
	return m.bases.RUnlock
}

// LockBases holds off every new reference to an image version until unlock is called: a prune holds it from its
// BasesInUse until it has removed the versions nothing uses.
func (m *Manager) LockBases() (unlock func()) {
	m.bases.Lock()
	return m.bases.Unlock
}

// kernelFor is the kernel to boot over rootfs: with PinBase, rootfs a version's file and Kernel the default path (a
// link to current/<file> beside the store's v/), the same version's kernel, so a sandbox or template boots the
// kernel and root filesystem of one version and never the current kernel over an older root filesystem. A custom
// kernel, images that aren't versioned, or a version without the file, boot Kernel as before.
func (m *Manager) kernelFor(rootfs string) string {
	if !m.cfg.PinBase || m.cfg.Kernel == "" || images.VersionOf(rootfs) == "" {
		return m.cfg.Kernel
	}
	name := filepath.Base(m.cfg.Kernel)
	// Read as a link, not followed: whether it is the default is all that is asked of it.
	if target, err := os.Readlink(m.cfg.Kernel); err != nil || target != filepath.Join("current", name) {
		return m.cfg.Kernel
	}
	store, err := filepath.EvalSymlinks(filepath.Dir(m.cfg.Kernel))
	if err != nil {
		return m.cfg.Kernel
	}
	if abs, err := filepath.Abs(store); err == nil {
		store = abs
	}
	version := filepath.Dir(filepath.Clean(rootfs))
	if filepath.Dir(filepath.Dir(version)) != store {
		return m.cfg.Kernel
	}
	pinned := filepath.Join(version, name)
	if _, err := os.Stat(pinned); err != nil {
		return m.cfg.Kernel
	}
	return pinned
}

// baseRootfs is the root filesystem new sandboxes and templates boot on: with PinBase, Rootfs resolved (the current
// version's file); else Rootfs itself, as before.
func (m *Manager) baseRootfs() string {
	if !m.cfg.PinBase {
		return m.cfg.Rootfs
	}
	p, err := filepath.EvalSymlinks(m.cfg.Rootfs)
	if err != nil {
		return m.cfg.Rootfs
	}
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	return p
}

// linkRootfs gives a VM directory its root filesystem: a link to target (Rootfs when empty).
func (m *Manager) linkRootfs(vm, target string) error {
	if target == "" {
		target = m.cfg.Rootfs
	}
	return os.Symlink(target, filepath.Join(vm, fc.RootfsFile))
}

// relinkRootfs repoints a VM directory's root filesystem in one rename.
func relinkRootfs(vm, target string) error {
	tmp := filepath.Join(vm, fc.RootfsFile+".new")
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(vm, fc.RootfsFile))
}

// vmRootfs is what a VM directory's root filesystem links to ("" when it has none).
func vmRootfs(vm string) string {
	target, err := os.Readlink(filepath.Join(vm, fc.RootfsFile))
	if err != nil {
		return ""
	}
	return target
}

// rootfsOf is a VM directory's root filesystem and the version it is.
func rootfsOf(vm string) (rootfs, base string) {
	rootfs = vmRootfs(vm)
	return rootfs, images.VersionOf(rootfs)
}

// baseOf is the image version a VM directory's root filesystem is under ("" when the images aren't versioned).
func baseOf(vm string) string {
	_, base := rootfsOf(vm)
	return base
}

// baseAtOf is when a VM directory was put on its base, in unix milliseconds: its root filesystem link's own time
// (each link is made new, and renamed into place, so it moves on only when the base is set). 0 when it has none.
func baseAtOf(vm string) int64 {
	info, err := os.Lstat(filepath.Join(vm, fc.RootfsFile))
	if err != nil {
		return 0
	}
	return info.ModTime().UnixMilli()
}

// templateRootfs is the root filesystem a template was made on (Rootfs for one from before it was recorded).
func (m *Manager) templateRootfs(dir string) string {
	if raw, err := os.ReadFile(filepath.Join(dir, "rootfs")); err == nil {
		if p := strings.TrimSpace(string(raw)); p != "" {
			return p
		}
	}
	return m.cfg.Rootfs
}

// snapshotRootfs is the root filesystem a snapshot's disk is a layer over (Rootfs for one from before it was kept).
func (m *Manager) snapshotRootfs(snap snapshotMeta) string {
	if snap.Rootfs != "" {
		return snap.Rootfs
	}
	return m.cfg.Rootfs
}

// snapshotLower is the image a snapshot's files are looked up in below its own disk.
func (m *Manager) snapshotLower(id string) string {
	snap, err := m.readSnapshot(id)
	if err != nil {
		return m.cfg.Rootfs
	}
	return m.snapshotRootfs(snap)
}

// gone is whether a reference read failed only because it isn't there (deleted, or not yet written), rather than
// because it couldn't be read: a walk of what is in use may pass over the first, never the second.
func gone(err error) bool {
	// ENOTDIR: a stray file where a directory would be, which holds nothing.
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}

// vmRootfsChecked is vmRootfs for a walk of what is in use: "" for a VM directory with no root filesystem link (gone,
// or one that isn't a link, which names no version), an error for one that
// couldn't be read.
func vmRootfsChecked(vm string) (string, error) {
	target, err := os.Readlink(filepath.Join(vm, fc.RootfsFile))
	if err == nil {
		return target, nil
	}
	if gone(err) || errors.Is(err, syscall.EINVAL) {
		return "", nil
	}
	return "", err
}

// entriesOf is what dir holds, as paths: none when dir isn't there. Unlike a glob, which passes over a directory it
// can't read, a walk of what is in use is told: what it couldn't list may be references.
func entriesOf(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, filepath.Join(dir, e.Name()))
	}
	if err != nil && !gone(err) {
		return out, fmt.Errorf("listing %s: %w", dir, err)
	}
	return out, nil
}

// scanSnapshots is every snapshot's metadata, as snapshotsOf (unsorted), but says which couldn't be read or decoded,
// which snapshotsOf passes over: a prune or a pinning pass that went ahead without one would miss the base it is on.
// A snapshot whose directory or metadata isn't there (deleted, or not yet written, when its sandbox still names the
// base) is no reference.
func (m *Manager) scanSnapshots() ([]snapshotMeta, error) { return scanSnapshotsIn(m.cfg.Root) }

func scanSnapshotsIn(tierRoot string) ([]snapshotMeta, error) {
	root := filepath.Join(tierRoot, "snapshots")
	entries, err := os.ReadDir(root)
	if err != nil {
		if gone(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("listing snapshots: %w", err)
	}
	var out []snapshotMeta
	var errs []error
	for _, e := range entries {
		if !validID(e.Name()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(root, e.Name(), "meta.json"))
		if gone(err) {
			continue
		}
		var snap snapshotMeta
		if err == nil {
			err = json.Unmarshal(raw, &snap)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("snapshot %s: %w", e.Name(), err))
			continue
		}
		out = append(out, snap)
	}
	return out, errors.Join(errs...)
}

// BasesInUse are the image versions the tier's sandboxes, snapshots and templates are on: what a
// prune of old versions must keep. A reference it couldn't read is an error, and the caller keeps every version: a
// partial answer would let a prune remove a version something still boots on.
func (m *Manager) BasesInUse() (map[string]bool, error) { return BasesUnder(m.cfg.Root) }

// BasesUnder is BasesInUse for the tier's state under root (its Config.Root) without a Manager: what a host whose
// microVM tier didn't start this time (turned off, or KVM or an image missing) still keeps there, so a prune doesn't
// remove the versions its saved sandboxes, snapshots and templates boot on. With no Manager, nothing makes or moves a
// reference beside it.
func BasesUnder(root string) (map[string]bool, error) {
	in := map[string]bool{}
	var errs []error
	add := func(p string) {
		if v := images.VersionOf(p); v != "" {
			in[v] = true
		}
	}
	addVM := func(vm string) {
		target, err := vmRootfsChecked(vm)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", vm, err))
		}
		add(target)
	}
	sandboxes, err := entriesOf(filepath.Join(root, "sandboxes"))
	if err != nil {
		errs = append(errs, err)
	}
	for _, dir := range sandboxes {
		addVM(filepath.Join(dir, "vm"))
	}
	snaps, err := scanSnapshotsIn(root)
	if err != nil {
		errs = append(errs, err)
	}
	for _, snap := range snaps {
		add(snap.Rootfs)
	}
	templates, err := entriesOf(filepath.Join(root, "templates"))
	if err != nil {
		errs = append(errs, err)
	}
	for _, dir := range templates {
		if raw, err := os.ReadFile(filepath.Join(dir, "rootfs")); err == nil {
			add(strings.TrimSpace(string(raw)))
		} else if !gone(err) {
			errs = append(errs, fmt.Errorf("%s: %w", dir, err))
		}
		// One being built (<size>.building, <size>.next.building) links its images from its VM directory.
		addVM(filepath.Join(dir, "vm"))
	}
	return in, errors.Join(errs...)
}

// PinBases, with PinBase, points what still names Rootfs itself (made before the images were versioned) at the file
// Rootfs resolves to now, which is what it was made on, so a later update doesn't move it. Each file is replaced
// durably (the old one stays readable until its replacement is in place) and a pass that fails is said: an update or
// a prune doesn't go ahead until one has succeeded, as a legacy reference follows current wherever it moves. Safe to
// run again; the first success is remembered. It holds the base lock to write for the whole pass, so nothing that
// makes, moves or rewrites a reference (a snapshot's metadata, pruneAuto's included) runs beside it, and a snapshot
// it couldn't read fails the pass rather than being left to follow current.
func (m *Manager) PinBases() error {
	m.pinning.Lock()
	defer m.pinning.Unlock()
	if m.pinned.Load() {
		return nil
	}
	defer m.LockBases()()
	if err := m.pinBasesLocked(); err != nil {
		return fmt.Errorf("pinning what this host made before its images were versioned: %w", err)
	}
	m.pinned.Store(true)
	return nil
}

// PinBasesUnder is PinBases for the tier's state under root (its Config.Root) without a Manager, for a host whose
// microVM tier didn't start this time (turned off, or KVM or an image missing): what it saved before the images were
// versioned still names rootfs (its Config.Rootfs), and would follow an update to whatever is current when it starts
// again. A pass that fails is said, so the update or prune doesn't go ahead. Nothing remembers a success: it is run
// before each, and finds nothing left to pin after the first. With no Manager, nothing makes or moves a reference
// beside it.
func PinBasesUnder(root, rootfs string) error {
	m := &Manager{cfg: Config{Root: root, Rootfs: rootfs, PinBase: true}}
	if err := m.pinBasesLocked(); err != nil {
		return fmt.Errorf("pinning what the microVM tier (not started) made before its images were versioned: %w", err)
	}
	return nil
}

func (m *Manager) pinBasesLocked() error {
	base := m.baseRootfs()
	if !m.cfg.PinBase || base == m.cfg.Rootfs {
		return nil
	}
	var errs []error
	sandboxes, err := entriesOf(filepath.Join(m.cfg.Root, "sandboxes"))
	if err != nil {
		errs = append(errs, err)
	}
	for _, dir := range sandboxes {
		vm := filepath.Join(dir, "vm")
		target, err := vmRootfsChecked(vm)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", vm, err))
			continue
		}
		if target == m.cfg.Rootfs {
			if err := relinkRootfs(vm, base); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", vm, err))
			}
		}
	}
	templates, err := entriesOf(filepath.Join(m.cfg.Root, "templates"))
	if err != nil {
		errs = append(errs, err)
	}
	for _, dir := range templates {
		// Only a ready one is used; one that couldn't be looked at may be.
		if _, err := os.Stat(filepath.Join(dir, "ready")); err != nil {
			if !gone(err) {
				errs = append(errs, fmt.Errorf("%s: %w", dir, err))
			}
			continue
		}
		// One whose record can't be read isn't taken for one from before it was recorded: that would move it.
		if _, err := os.ReadFile(filepath.Join(dir, "rootfs")); err != nil && !gone(err) {
			errs = append(errs, fmt.Errorf("%s: %w", dir, err))
			continue
		}
		if m.templateRootfs(dir) == m.cfg.Rootfs {
			if err := fsutil.WriteFileDurably(filepath.Join(dir, "rootfs"), []byte(base), 0o600); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", dir, err))
			}
		}
	}
	snaps, err := m.scanSnapshots()
	if err != nil {
		errs = append(errs, err)
	}
	for _, snap := range snaps {
		if snap.Rootfs != "" && snap.Rootfs != m.cfg.Rootfs {
			continue
		}
		snap.Rootfs, snap.Base = base, images.VersionOf(base)
		raw, err := json.MarshalIndent(snap, "", "  ")
		if err == nil {
			err = fsutil.WriteFileDurably(filepath.Join(m.snapshotDir(snap.ID), "meta.json"), raw, 0o600)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("snapshot %s: %w", snap.ID, err))
		}
	}
	return errors.Join(errs...)
}

// rebase moves a stopped sandbox onto the current images before a cold boot (whose kernel follows its root
// filesystem, kernelFor). Its own disk stays; its memory snapshot, taken over the old images, can't be resumed after,
// so it is forgotten first (should the relink fail, the sandbox still boots, on its old images). With to, the version
// the caller expects, a host whose current images are another is refused before anything changes. Called with s.mu
// held.
func (m *Manager) rebase(s *sandbox, to string) error {
	defer m.holdBases()()
	vm := s.vmDir()
	base := m.baseRootfs()
	if have := images.VersionOf(base); to != "" && have != to {
		return images.NotCurrent(have, to)
	}
	if vmRootfs(vm) == base {
		return nil
	}
	if s.meta.Memory {
		s.meta.Memory = false
		if err := m.writeMeta(s); err != nil {
			return err
		}
	}
	if err := relinkRootfs(vm, base); err != nil {
		return err
	}
	m.log.Info("sandbox moved onto the current images", "sandbox", s.meta.ID, "base", images.VersionOf(base))
	return nil
}

// rebaseTarget refuses a rebase the caller expects to land on to ("": any) when the host's current images are another
// version: it hasn't taken that update.
func (m *Manager) rebaseTarget(to string) error {
	if to == "" {
		return nil
	}
	if have := images.VersionOf(m.baseRootfs()); have != to {
		return images.NotCurrent(have, to)
	}
	return nil
}

// RebaseVersion is the host images version a rebase moves a sandbox onto: the version Rootfs resolves to now, which is
// the store's current one unless the config names its root filesystem by another path (then "" when that isn't a
// version's file). A restart on latest asks it before stopping the sandbox.
func (m *Manager) RebaseVersion() string {
	if !m.cfg.PinBase {
		return ""
	}
	return images.VersionOf(m.baseRootfs())
}

// useTemplate holds a template (a size's or a shared one, by name) in use until the returned func is called.
func (m *Manager) useTemplate(name string) func() {
	l := m.useLock(name)
	if l == nil {
		return func() {}
	}
	l.RLock()
	return l.RUnlock
}

// useLock is a template's use lock: a named size's (made in New), or a shared template's (made on first use).
func (m *Manager) useLock(name string) *sync.RWMutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	l := m.inUse[name]
	if l == nil && strings.HasPrefix(name, sharedPrefix) {
		if m.inUse == nil {
			m.inUse = map[string]*sync.RWMutex{}
		}
		l = &sync.RWMutex{}
		m.inUse[name] = l
	}
	return l
}

// keptShapes are the shapes the tier keeps templates of: its named sizes, and each shared template on disk.
func (m *Manager) keptShapes() []shape {
	var shapes []shape
	for _, size := range m.cfg.Sizes {
		shapes = append(shapes, shape{Size: size})
	}
	if m.shared == nil {
		return shapes
	}
	entries, _ := os.ReadDir(filepath.Join(m.cfg.Root, "templates"))
	for _, e := range entries {
		var n int
		if _, err := fmt.Sscanf(e.Name(), sharedPrefix+"%dvcpu", &n); err == nil && e.Name() == m.shared.shape(n).Name {
			shapes = append(shapes, m.shared.shape(n))
		}
	}
	return shapes
}

// ImagesChanged is called when the host's images move to another version: each template (a size's or a shared one)
// made on others starts rebuilding in the background. Without BackgroundTemplates the next create rebuilds it, as
// before.
func (m *Manager) ImagesChanged() {
	if !m.cfg.BackgroundTemplates {
		return
	}
	for _, sh := range m.keptShapes() {
		dir := filepath.Join(m.cfg.Root, "templates", sh.Name)
		if _, err := os.Stat(filepath.Join(dir, "ready")); err != nil {
			continue // none yet: the first create builds it on the new images
		}
		if made, _ := os.ReadFile(filepath.Join(dir, "images")); string(made) == m.templateFingerprint(sh) {
			continue
		}
		m.rebuildTemplate(sh)
	}
}

// rebuildTemplate starts a template's background rebuild, unless one is running (or failed within the minute) or the
// tier is closing.
func (m *Manager) rebuildTemplate(sh shape) {
	size := sh.Size
	m.mu.Lock()
	if m.rebuilding == nil {
		m.rebuilding = map[string]bool{}
	}
	if m.rebuilding[size.Name] {
		m.mu.Unlock()
		return
	}
	ctx, ok := m.startBuilder()
	if !ok {
		m.mu.Unlock()
		return
	}
	m.rebuilding[size.Name] = true
	m.mu.Unlock()
	m.log.Info("template is for other images; rebuilding it in the background", "size", size.Name)
	go func() {
		defer m.builders.Done()
		done := func() {
			m.mu.Lock()
			delete(m.rebuilding, size.Name)
			m.mu.Unlock()
		}
		run := m.rebuild
		if run == nil {
			run = m.swapTemplate
		}
		if err := run(ctx, sh); err != nil {
			m.log.Error("background template rebuild failed; creates use the old template", "size", size.Name, "error", err)
			// Not again at once: every create would start one.
			time.AfterFunc(time.Minute, done)
			return
		}
		done()
	}()
}

// swapTemplate builds a template into templates/<name>.next and renames it into place. Sandboxes restored from the
// old one mapped its memory file already, which outlives its name.
func (m *Manager) swapTemplate(ctx context.Context, sh shape) error {
	size := sh.Size
	dir := filepath.Join(m.cfg.Root, "templates", size.Name)
	next, old := dir+".next", dir+".old"
	if _, err := m.buildTemplate(ctx, sh, next); err != nil {
		_ = os.RemoveAll(next)
		return err
	}
	// The use lock before the template's, the order a create takes them in.
	if use := m.useLock(size.Name); use != nil {
		use.Lock()
		defer use.Unlock()
	}
	lock := m.templateLock(size.Name)
	lock.Lock()
	defer lock.Unlock()
	// The template's base moves from next to dir: not while a prune walks the templates.
	defer m.holdBases()()
	_ = os.RemoveAll(old)
	if err := os.Rename(dir, old); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(next, dir); err != nil {
		_ = os.Rename(old, dir)
		return err
	}
	_ = os.RemoveAll(old)
	m.log.Info("template rebuilt on the current images", "size", size.Name)
	return nil
}
