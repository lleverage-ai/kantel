package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/images"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A sandbox's base is the root filesystem its disk is a layer over. With versioned images (package images) Rootfs is
// a link to the current version, and each VM directory links the file it resolved to when the sandbox was made: an
// update repoints Rootfs, so new sandboxes start on the new version, while a running or stopped one stays on its own
// until a start with Rebase moves it.

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

// BasesInUse are the image versions the tier's sandboxes, warm sandboxes, snapshots and templates are on: what a
// prune of old versions must keep.
func (m *Manager) BasesInUse() map[string]bool {
	in := map[string]bool{}
	add := func(p string) {
		if v := images.VersionOf(p); v != "" {
			in[v] = true
		}
	}
	// The pool before the sandboxes: a claim moves a warm sandbox from one to the other, so it is seen in either.
	for _, pattern := range []string{filepath.Join(m.cfg.Root, "pool", "*", "vm"), filepath.Join(m.cfg.Root, "sandboxes", "*", "vm")} {
		vms, _ := filepath.Glob(pattern)
		for _, vm := range vms {
			add(vmRootfs(vm))
		}
	}
	for _, snap := range m.snapshotsOf("") {
		add(snap.Rootfs)
	}
	entries, _ := os.ReadDir(filepath.Join(m.cfg.Root, "templates"))
	for _, e := range entries {
		dir := filepath.Join(m.cfg.Root, "templates", e.Name())
		if raw, err := os.ReadFile(filepath.Join(dir, "rootfs")); err == nil {
			add(strings.TrimSpace(string(raw)))
		}
		// One being built (<size>.building, <size>.next.building) links its images from its VM directory.
		add(vmRootfs(filepath.Join(dir, "vm")))
	}
	return in
}

// pinBases, with PinBase, points what still names Rootfs itself (made before the images were versioned) at the file
// Rootfs resolves to now, which is what it was made on, so a later update doesn't move it.
func (m *Manager) pinBases() {
	base := m.baseRootfs()
	if !m.cfg.PinBase || base == m.cfg.Rootfs {
		return
	}
	vms, _ := filepath.Glob(filepath.Join(m.cfg.Root, "sandboxes", "*", "vm"))
	for _, vm := range vms {
		if vmRootfs(vm) == m.cfg.Rootfs {
			if err := relinkRootfs(vm, base); err != nil {
				m.log.Warn("couldn't pin a sandbox to its images", "vm", vm, "error", err)
			}
		}
	}
	readies, _ := filepath.Glob(filepath.Join(m.cfg.Root, "templates", "*", "ready"))
	for _, ready := range readies {
		dir := filepath.Dir(ready)
		if m.templateRootfs(dir) == m.cfg.Rootfs {
			_ = os.WriteFile(filepath.Join(dir, "rootfs"), []byte(base), 0o600)
		}
	}
	for _, snap := range m.snapshotsOf("") {
		if snap.Rootfs != "" && snap.Rootfs != m.cfg.Rootfs {
			continue
		}
		snap.Rootfs, snap.Base = base, images.VersionOf(base)
		raw, _ := json.MarshalIndent(snap, "", "  ")
		_ = os.WriteFile(filepath.Join(m.snapshotDir(snap.ID), "meta.json"), raw, 0o600)
	}
}

// rebase moves a stopped sandbox onto the current images before a cold boot. Its own disk stays; its memory
// snapshot, taken over the old images, can't be resumed after, so it is forgotten first (should the relink fail, the
// sandbox still boots, on its old images). Called with s.mu held.
func (m *Manager) rebase(s *sandbox) error {
	vm := s.vmDir()
	base := m.baseRootfs()
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

// useTemplate holds a size's template in use until the returned func is called.
func (m *Manager) useTemplate(size string) func() {
	l := m.inUse[size]
	if l == nil {
		return func() {}
	}
	l.RLock()
	return l.RUnlock
}

// ImagesChanged is called when the host's images move to another version: each size whose template was made on
// others starts rebuilding in the background, and its warm pool is replaced once the new one is ready. Without
// BackgroundTemplates the next create rebuilds it, as before.
func (m *Manager) ImagesChanged() {
	if !m.cfg.BackgroundTemplates {
		return
	}
	for _, size := range m.cfg.Sizes {
		dir := filepath.Join(m.cfg.Root, "templates", size.Name)
		if _, err := os.Stat(filepath.Join(dir, "ready")); err != nil {
			continue // none yet: the first create builds it on the new images
		}
		if made, _ := os.ReadFile(filepath.Join(dir, "images")); string(made) == m.templateFingerprint(size) {
			continue
		}
		m.rebuildTemplate(size)
	}
}

// rebuildTemplate starts a size's background rebuild, unless one is running (or failed within the minute) or the
// tier is closing.
func (m *Manager) rebuildTemplate(size proto.Size) {
	m.mu.Lock()
	if m.rebuilding == nil {
		m.rebuilding = map[string]bool{}
	}
	if m.rebuilding[size.Name] || m.closed.Load() {
		m.mu.Unlock()
		return
	}
	m.rebuilding[size.Name] = true
	m.mu.Unlock()
	m.log.Info("template is for other images; rebuilding it in the background", "size", size.Name)
	go func() {
		done := func() {
			m.mu.Lock()
			delete(m.rebuilding, size.Name)
			m.mu.Unlock()
		}
		run := m.rebuild
		if run == nil {
			run = m.swapTemplate
		}
		if err := run(context.Background(), size); err != nil {
			m.log.Error("background template rebuild failed; creates use the old template", "size", size.Name, "error", err)
			// Not again at once: every create would start one.
			time.AfterFunc(time.Minute, done)
			return
		}
		done()
		m.renewPool(size.Name)
	}()
}

// swapTemplate builds a size's template into templates/<size>.next and renames it into place. Sandboxes restored
// from the old one mapped its memory file already, which outlives its name.
func (m *Manager) swapTemplate(ctx context.Context, size proto.Size) error {
	dir := filepath.Join(m.cfg.Root, "templates", size.Name)
	next, old := dir+".next", dir+".old"
	if _, err := m.buildTemplate(ctx, size, next); err != nil {
		_ = os.RemoveAll(next)
		return err
	}
	// The use lock before the template's, the order a create takes them in.
	if use := m.inUse[size.Name]; use != nil {
		use.Lock()
		defer use.Unlock()
	}
	lock := m.templates[size.Name]
	lock.Lock()
	defer lock.Unlock()
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

// renewPool replaces a size's warm sandboxes, which were restored from the template just replaced.
func (m *Manager) renewPool(sizeName string) {
	m.mu.Lock()
	stale := m.pool[sizeName]
	delete(m.pool, sizeName)
	m.mu.Unlock()
	for _, w := range stale {
		w.machine.Kill()
		m.cfg.Network.Remove(w.link)
		_ = os.RemoveAll(w.dir)
	}
	m.fill(sizeName)
}
