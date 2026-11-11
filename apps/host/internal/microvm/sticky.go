package microvm

// Sticky disks (docs/design/disk-store.md, phase 1): an organisation's named, versioned ext4 disks, such as a CI
// cache, each sandbox writing its own copy-on-write clone of a version, mounted read-write at a path.
//
// Like bundle drives (bundles.go), the drives are fixed: Firecracker can't add a drive to a running VM, and a snapshot
// restores the devices it was made with. So every microVM has StickyDrives writable drives after its bundle drives,
// sticky0.ext4 and sticky1.ext4 in its VM directory, empty files until a disk is attached. A create clones the version
// it asks for (or the host's newest version of the disk, or makes a new empty ext4) into a free drive's file, points
// the drive at it (PATCH /drives), and has the guest agent mount it (POST /sticky).
//
// The clone is the sandbox's for its life. A stop, start, resume or recovery keeps the file where it is, and the guest
// mounts it again after a cold boot. A snapshot of the sandbox keeps a clone of each (snapshotMeta.StickyDisks), so a
// sandbox made from it (a fork, or a restore) gets the same files on the same drives. A delete removes them with the
// sandbox's directory.
//
// The host keeps the versions it holds as files, sticky/<disk>/<version>.img under the tier's root, reflinked where
// the file system can (FICLONE), so a version costs only the blocks it doesn't share. A commit (sticky.commit) has the
// guest freeze the disk's file system, clones the drive's file to a new version, and thaws it; then only the disk's two
// newest versions are kept.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// StickyDrives is how many sticky drives every microVM has: the most sticky disks a sandbox may have.
const StickyDrives = proto.StickyDisksMax

// maxStickyGiB is the biggest sticky disk a create may make.
const maxStickyGiB = maxCustomDiskGiB

// stickyKeep is how many versions of each disk the host keeps after a commit.
const stickyKeep = 2

// stickyCallWait bounds each guest call of a commit (its freeze and its thaw).
const stickyCallWait = 30 * time.Second

// stickyAttached is a disk on its drive whose guest mount isn't known yet (between its attach and mountSticky).
const stickyAttached = "attached"

// stickyDisk is one of a sandbox's sticky disks: on drive Slot (-1: none, it failed before it had one), cloned from
// Version ("" a new disk), mounted at Path, and how that went.
type stickyDisk struct {
	DiskID  string `json:"diskId"`
	Path    string `json:"path"`
	Version string `json:"version,omitempty"`
	Slot    int    `json:"slot"`
	State   string `json:"state"`
	Reason  string `json:"reason,omitempty"`
}

func stickyDriveFile(k int) string { return fmt.Sprintf("sticky%d.ext4", k) }

func stickyDriveID(k int) string { return fmt.Sprintf("sticky%d", k) }

// stickyDrives is the writable drives a VM with n sticky drives boots with, after its bundle drives.
func stickyDrives(n int) []fc.Drive {
	out := make([]fc.Drive, n)
	for k := range out {
		out[k] = fc.Drive{ID: stickyDriveID(k), Path: stickyDriveFile(k)}
	}
	return out
}

// stickyCountFile, in a template snapshot's directory, is how many sticky drives its VM was made with.
const stickyCountFile = "sticky-drives"

func writeSnapshotStickyCount(dir string, n int) error {
	return os.WriteFile(filepath.Join(dir, stickyCountFile), []byte(strconv.Itoa(n)), 0o600)
}

// snapshotStickyCount is how many sticky drives the template snapshot in dir was made with: none for one made before
// them.
func snapshotStickyCount(dir string) int {
	raw, err := os.ReadFile(filepath.Join(dir, stickyCountFile))
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	return min(max(0, n), StickyDrives)
}

// emptyStickyDrives puts an empty file at each of a new VM's n sticky drives, failing if anything is there already.
func emptyStickyDrives(vm string, n int) error {
	for k := 0; k < n; k++ {
		if err := newStickyPlaceholder(filepath.Join(vm, stickyDriveFile(k))); err != nil {
			return err
		}
	}
	return nil
}

// newStickyPlaceholder makes an empty sticky drive file at path, failing if anything is there: never truncated, as it
// may be a sandbox's clone of a disk.
func newStickyPlaceholder(path string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("a sticky drive: %w", err)
	}
	return f.Close()
}

// makeStickyDrives gives s's new VM its sticky drives, before it boots or restores, and records them in its meta: a
// boot has StickyDrives; a restore of a sandbox snapshot's memory the drives the snapshot's VM had, and of a template
// snapshot as many as it was made with. A sandbox snapshot's sticky disks (memory or not) are cloned onto the same
// drives (taken, for a live fork's own snapshot); the other drives are empty.
func (m *Manager) makeStickyDrives(s *sandbox, origin sandboxOrigin) error {
	n := StickyDrives
	switch {
	case origin.state == "":
	case origin.snapshotDir != "":
		n = origin.stickyDrives
	default:
		n = snapshotStickyCount(filepath.Dir(origin.state))
	}
	vm := s.vmDir()
	s.meta.StickyDrives, s.meta.StickyDisks = n, nil
	used := map[int]bool{}
	for _, d := range origin.stickyDisks {
		if d.Slot < 0 || d.Slot >= n || used[d.Slot] {
			d.Slot, d.State, d.Reason = -1, proto.StickyFailed, "the snapshot it was made from has no drive for it"
			s.meta.StickyDisks = append(s.meta.StickyDisks, d)
			continue
		}
		src, dst := filepath.Join(origin.stickyDir, stickyDriveFile(d.Slot)), filepath.Join(vm, stickyDriveFile(d.Slot))
		if _, err := os.Stat(src); errors.Is(err, fs.ErrNotExist) {
			d.Slot, d.State, d.Reason = -1, proto.StickyFailed, "the snapshot it was made from has no copy of it"
			s.meta.StickyDisks = append(s.meta.StickyDisks, d)
			continue
		}
		var err error
		if origin.takeDisk {
			_, err = takeFile(src, dst)
		} else {
			_, err = cloneDisk(src, dst)
		}
		if err != nil {
			return fmt.Errorf("a sticky disk: %w", err)
		}
		used[d.Slot] = true
		s.meta.StickyDisks = append(s.meta.StickyDisks, d)
	}
	for k := 0; k < n; k++ {
		if !used[k] {
			if err := newStickyPlaceholder(filepath.Join(vm, stickyDriveFile(k))); err != nil {
				return err
			}
		}
	}
	return nil
}

// keepStickyFiles, before a cold boot of s, makes sure each of its sticky drives has a file: one that's gone is an
// empty file again, and the disk on it is lost.
func keepStickyFiles(s *sandbox) error {
	for k := 0; k < s.meta.StickyDrives; k++ {
		file := filepath.Join(s.vmDir(), stickyDriveFile(k))
		if _, err := os.Stat(file); err == nil {
			continue
		}
		if err := os.WriteFile(file, nil, 0o600); err != nil {
			return err
		}
		for i := range s.meta.StickyDisks {
			if d := &s.meta.StickyDisks[i]; d.Slot == k {
				d.Slot, d.State, d.Reason = -1, proto.StickyFailed, "its drive's file is gone"
			}
		}
	}
	return nil
}

// attachedSticky are the disks on a drive.
func attachedSticky(disks []stickyDisk) []stickyDisk {
	var out []stickyDisk
	for _, d := range disks {
		if d.Slot >= 0 {
			out = append(out, d)
		}
	}
	return out
}

// keepSticky clones a sandbox's sticky drives' files into a snapshot's directory (sdir), on the same drives: its VM is
// stopped, or paused with no write in flight.
func keepSticky(vm, sdir string, disks []stickyDisk) error {
	for _, d := range attachedSticky(disks) {
		if _, err := cloneDisk(filepath.Join(vm, stickyDriveFile(d.Slot)), filepath.Join(sdir, stickyDriveFile(d.Slot))); err != nil {
			return fmt.Errorf("its sticky disk %s: %w", d.DiskID, err)
		}
	}
	return nil
}

// linkSticky links a snapshot's sticky disks' clones into another snapshot's directory (KeepSnapshot).
func linkSticky(from, sdir string, disks []stickyDisk) error {
	for _, d := range attachedSticky(disks) {
		if err := os.Link(filepath.Join(from, stickyDriveFile(d.Slot)), filepath.Join(sdir, stickyDriveFile(d.Slot))); err != nil {
			return fmt.Errorf("its sticky disk %s: %w", d.DiskID, err)
		}
	}
	return nil
}

// stickyStatus is how each of a sandbox's sticky disks is doing, as SandboxInfo says it.
func stickyStatus(disks []stickyDisk) []proto.StickyDiskStatus {
	var out []proto.StickyDiskStatus
	for _, d := range disks {
		st := proto.StickyDiskStatus{DiskID: d.DiskID, Path: d.Path, Version: d.Version, State: proto.StickyMounted}
		if d.Slot < 0 || d.State != proto.StickyMounted {
			st.State, st.Reason = proto.StickyFailed, d.Reason
			if st.Reason == "" {
				st.Reason = "it isn't mounted"
			}
		}
		out = append(out, st)
	}
	return out
}

// validateStickyDisks checks a create's sticky disks before anything is made: at most StickyDrives, each disk once,
// IDs and versions that are safe file names, sizes within bounds, and paths a mount may be at (the guest's
// CheckMountPath: absolute, clean, not / or the system's own directories) that meet no other sticky disk's or mount's.
func validateStickyDisks(disks []proto.StickyDisk, mounts []proto.Mount) error {
	invalid := func(format string, args ...any) error {
		return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf(format, args...)}
	}
	if len(disks) > StickyDrives {
		return invalid("a sandbox has at most %d sticky disks", StickyDrives)
	}
	paths := make([]string, 0, len(disks)+len(mounts))
	for _, mt := range mounts {
		paths = append(paths, mt.Path)
	}
	ids := map[string]bool{}
	for _, d := range disks {
		if !validID(d.DiskID) {
			return invalid("bad sticky disk ID %q", d.DiskID)
		}
		if d.Version != "" && !validID(d.Version) {
			return invalid("bad version %q of sticky disk %s", d.Version, d.DiskID)
		}
		if ids[d.DiskID] {
			return invalid("sticky disk %s is attached twice", d.DiskID)
		}
		ids[d.DiskID] = true
		if d.SizeGiB < 1 || d.SizeGiB > maxStickyGiB {
			return invalid("sticky disk %s's size is 1 to %d GiB, not %d", d.DiskID, maxStickyGiB, d.SizeGiB)
		}
		if err := guest.CheckMountPath(d.Path); err != nil {
			return invalid("sticky disk %s: %s", d.DiskID, err)
		}
		for _, other := range paths {
			if other == d.Path || strings.HasPrefix(d.Path, other+"/") || strings.HasPrefix(other, d.Path+"/") {
				return invalid("sticky disk %s at %s meets the mount at %s", d.DiskID, d.Path, other)
			}
		}
		paths = append(paths, d.Path)
	}
	return nil
}

// attachSticky attaches the sticky disks a create asks for to free drives of its running VM (those its snapshot had
// are on theirs already, and kept). One that can't be attached is recorded failed, with why. Called with s.mu held.
func (m *Manager) attachSticky(ctx context.Context, s *sandbox, specs []proto.StickyDisk) {
	for _, spec := range specs {
		if hasStickyDisk(s.meta.StickyDisks, spec.DiskID) {
			continue
		}
		d := stickyDisk{DiskID: spec.DiskID, Path: spec.Path, Slot: -1, State: proto.StickyFailed}
		slot := freeStickySlot(s)
		switch {
		case s.meta.StickyDrives == 0:
			d.Reason = "this sandbox's machine was made before sticky disks, and has no drive for one"
		case slot < 0:
			d.Reason = fmt.Sprintf("this sandbox can have at most %d sticky disks", s.meta.StickyDrives)
		default:
			version, err := m.attachStickyDrive(ctx, s, slot, spec)
			if err != nil {
				m.log.Warn("sticky disk", "sandbox", s.meta.ID, "disk", spec.DiskID, "error", err)
				d.Reason = "attaching it: " + err.Error()
			} else {
				d.Slot, d.Version, d.State = slot, version, stickyAttached
			}
		}
		s.meta.StickyDisks = append(s.meta.StickyDisks, d)
	}
}

func hasStickyDisk(disks []stickyDisk, id string) bool {
	for _, d := range disks {
		if d.DiskID == id {
			return true
		}
	}
	return false
}

// freeStickySlot is a sticky drive of s's no disk is on (-1: none).
func freeStickySlot(s *sandbox) int {
	used := map[int]bool{}
	for _, d := range s.meta.StickyDisks {
		used[d.Slot] = true
	}
	for k := 0; k < s.meta.StickyDrives; k++ {
		if !used[k] {
			return k
		}
	}
	return -1
}

// attachStickyDrive puts a clone of the disk's version (spec.Version, else the host's newest; or a new disk when the
// host has none) at sticky drive slot's file and points the running VM's drive at it, answering the version cloned
// ("" a new disk). A drive whose change fails is emptied again.
func (m *Manager) attachStickyDrive(ctx context.Context, s *sandbox, slot int, spec proto.StickyDisk) (string, error) {
	file := filepath.Join(s.vmDir(), stickyDriveFile(slot))
	tmp := file + ".new"
	_ = os.Remove(tmp)
	version, err := m.cloneStickyVersion(spec.DiskID, spec.Version, tmp)
	if err == nil && version == "" {
		err = newStickyDisk(tmp, spec.SizeGiB)
	}
	if err == nil {
		err = os.Rename(tmp, file)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := s.machine.UpdateDrive(ctx, stickyDriveID(slot), stickyDriveFile(slot)); err != nil {
		// The drive is in an unknown state: empty it, so the guest never sees half of a disk.
		if werr := os.WriteFile(tmp, nil, 0o600); werr == nil && os.Rename(tmp, file) == nil {
			_ = s.machine.UpdateDrive(ctx, stickyDriveID(slot), stickyDriveFile(slot))
		}
		return "", err
	}
	return version, nil
}

// newStickyDisk makes a new empty sparse ext4 of gib at path, labelled for the guest (guest.StickyLabel), its root
// owned by the sandbox's default user (1000).
func newStickyDisk(path string, gib int) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	err = f.Truncate(int64(gib) << 30)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	out, err := exec.Command("mkfs.ext4", "-q", "-F", "-L", guest.StickyLabel, "-E", "lazy_itable_init=1,discard,root_owner=1000:1000", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("mkfs.ext4: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// mountSticky has s's guest mount each of its sticky disks on a drive, and records how each went. Called with s.mu
// held, its VM running.
func (m *Manager) mountSticky(ctx context.Context, s *sandbox) {
	var list []guest.StickyMount
	for _, d := range attachedSticky(s.meta.StickyDisks) {
		var bytes int64
		if info, err := os.Stat(filepath.Join(s.vmDir(), stickyDriveFile(d.Slot))); err == nil {
			bytes = info.Size()
		}
		list = append(list, guest.StickyMount{Path: d.Path, Drive: s.meta.BundleDrives + d.Slot, Bytes: bytes})
	}
	if len(list) == 0 {
		return
	}
	results, err := s.guest.MountSticky(ctx, list)
	got := map[string]string{}
	for _, r := range results {
		got[r.Path] = r.Error
	}
	for i := range s.meta.StickyDisks {
		d := &s.meta.StickyDisks[i]
		if d.Slot < 0 {
			continue
		}
		msg, ok := got[d.Path]
		switch {
		case err != nil && guest.IsNotFound(err):
			msg = "this sandbox's image can't mount sticky disks (its guest agent predates them)"
		case err != nil:
			msg = "mounting it: " + err.Error()
		case !ok:
			msg = "the guest didn't mount it"
		}
		d.State, d.Reason = proto.StickyMounted, ""
		if msg != "" {
			d.State, d.Reason = proto.StickyFailed, msg
		}
	}
}

// stickyRoot is where the host keeps the sticky disk versions it holds.
func (m *Manager) stickyRoot() string { return filepath.Join(m.cfg.Root, "sticky") }

func (m *Manager) stickyVersionFile(diskID, version string) string {
	return filepath.Join(m.stickyRoot(), diskID, version+".img")
}

// stickyVersion is a version the host holds of a disk.
type stickyVersion struct {
	version   string
	at        int64
	allocated int64
}

// stickyVersions are the versions of a disk the host holds, newest first (by when each was made here, then by name).
// Files being written (named with a leading dot) aren't versions yet.
func (m *Manager) stickyVersions(diskID string) []stickyVersion {
	entries, err := os.ReadDir(filepath.Join(m.stickyRoot(), diskID))
	if err != nil {
		return nil
	}
	var out []stickyVersion
	for _, e := range entries {
		name := e.Name()
		version, ok := strings.CutSuffix(name, ".img")
		if !ok || !e.Type().IsRegular() || !validID(version) {
			continue
		}
		var st syscall.Stat_t
		if syscall.Stat(filepath.Join(m.stickyRoot(), diskID, name), &st) != nil {
			continue
		}
		out = append(out, stickyVersion{version: version, at: st.Mtim.Sec*1000 + st.Mtim.Nsec/1e6, allocated: st.Blocks * 512})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].at != out[j].at {
			return out[i].at > out[j].at
		}
		return out[i].version > out[j].version
	})
	return out
}

// cloneStickyVersion clones a version of the disk the host holds to dst: want, else (no version asked, or one this
// host hasn't: a cache never needs the newest) its newest. It answers the version cloned, "" when the host has none.
func (m *Manager) cloneStickyVersion(diskID, want, dst string) (string, error) {
	// Read-locked: a commit's prune or a delete doesn't remove the version while it's cloned.
	m.stickyMu.RLock()
	defer m.stickyMu.RUnlock()
	version := ""
	if want != "" && fileExists(m.stickyVersionFile(diskID, want)) {
		version = want
	} else if held := m.stickyVersions(diskID); len(held) > 0 {
		version = held[0].version
	}
	if version == "" {
		return "", nil
	}
	if _, err := cloneDisk(m.stickyVersionFile(diskID, version), dst); err != nil {
		return "", err
	}
	return version, nil
}

// CommitSticky (sticky.commit) makes a running sandbox's copy of a sticky disk the disk's version p.Version on this
// host: its guest writes the disk back and freezes it, its drive's file is cloned, and the guest thaws it, whatever
// happened. Then the host keeps only the disk's stickyKeep newest versions.
func (m *Manager) CommitSticky(ctx context.Context, p proto.StickyCommitParams) (proto.StickyCommitResult, error) {
	if !validID(p.DiskID) || !validID(p.Version) {
		return proto.StickyCommitResult{}, &proto.Error{Code: proto.ErrInvalid, Message: "bad sticky disk ID or version"}
	}
	s, err := m.get(p.SandboxID)
	if err != nil {
		return proto.StickyCommitResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.State != proto.StateRunning || s.machine == nil || s.guest == nil {
		return proto.StickyCommitResult{}, conflict("sandbox %s is %s, not running", s.meta.ID, s.meta.State)
	}
	var disk *stickyDisk
	for i := range s.meta.StickyDisks {
		if d := &s.meta.StickyDisks[i]; d.DiskID == p.DiskID && d.Slot >= 0 {
			disk = d
		}
	}
	if disk == nil {
		return proto.StickyCommitResult{}, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("sandbox %s has no sticky disk %s", s.meta.ID, p.DiskID)}
	}
	if disk.State != proto.StickyMounted {
		return proto.StickyCommitResult{}, conflict("sticky disk %s isn't mounted in sandbox %s: %s", p.DiskID, s.meta.ID, disk.Reason)
	}
	final := m.stickyVersionFile(p.DiskID, p.Version)
	if fileExists(final) {
		return proto.StickyCommitResult{}, conflict("this host has version %s of sticky disk %s already", p.Version, p.DiskID)
	}
	if err := os.MkdirAll(filepath.Dir(final), 0o700); err != nil {
		return proto.StickyCommitResult{}, err
	}
	tmp := filepath.Join(filepath.Dir(final), "."+p.Version+".img.new")
	_ = os.Remove(tmp)
	if err := m.cloneFrozen(ctx, s, *disk, tmp); err != nil {
		_ = os.Remove(tmp)
		return proto.StickyCommitResult{}, err
	}
	m.stickyMu.Lock()
	if fileExists(final) {
		m.stickyMu.Unlock()
		_ = os.Remove(tmp)
		return proto.StickyCommitResult{}, conflict("this host has version %s of sticky disk %s already", p.Version, p.DiskID)
	}
	err = os.Rename(tmp, final)
	if err == nil {
		// Made now, whatever the clone kept: the newest version is the one just committed.
		now := time.Now()
		_ = os.Chtimes(final, now, now)
		m.pruneStickyLocked(p.DiskID)
	}
	m.stickyMu.Unlock()
	if err != nil {
		_ = os.Remove(tmp)
		return proto.StickyCommitResult{}, err
	}
	var st syscall.Stat_t
	if err := syscall.Stat(final, &st); err != nil {
		return proto.StickyCommitResult{}, err
	}
	m.log.Info("sticky disk committed", "sandbox", s.meta.ID, "disk", p.DiskID, "version", p.Version, "allocatedBytes", st.Blocks*512)
	return proto.StickyCommitResult{Version: p.Version, SizeBytes: st.Size, AllocatedBytes: st.Blocks * 512}, nil
}

// cloneFrozen clones the drive file of s's sticky disk d to dst while its guest has the disk's file system frozen,
// and thaws it after, whether the freeze or the clone failed or not. Called with s.mu held.
func (m *Manager) cloneFrozen(ctx context.Context, s *sandbox, d stickyDisk, dst string) error {
	thaw := func() {
		// On a context of its own: the call's may be what ended the freeze or the clone.
		tctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stickyCallWait)
		defer cancel()
		if err := s.guest.ThawSticky(tctx, d.Path); err != nil {
			m.log.Warn("thawing a sticky disk after its commit", "sandbox", s.meta.ID, "disk", d.DiskID, "error", err)
		}
	}
	fctx, cancel := context.WithTimeout(ctx, stickyCallWait)
	err := s.guest.FreezeSticky(fctx, d.Path)
	cancel()
	if err != nil {
		thaw()
		if guest.IsNotFound(err) {
			return conflict("sticky disk %s can't be frozen in sandbox %s: %v", d.DiskID, s.meta.ID, err)
		}
		return fmt.Errorf("freezing sticky disk %s: %w", d.DiskID, err)
	}
	_, err = cloneDisk(filepath.Join(s.vmDir(), stickyDriveFile(d.Slot)), dst)
	thaw()
	if err != nil {
		return fmt.Errorf("cloning sticky disk %s: %w", d.DiskID, err)
	}
	return nil
}

// pruneStickyLocked deletes all but the disk's stickyKeep newest versions. Called with stickyMu held.
func (m *Manager) pruneStickyLocked(diskID string) {
	held := m.stickyVersions(diskID)
	for _, v := range held[min(stickyKeep, len(held)):] {
		if err := os.Remove(m.stickyVersionFile(diskID, v.version)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			m.log.Warn("deleting an old sticky disk version", "disk", diskID, "version", v.version, "error", err)
		}
	}
}

// DeleteSticky (sticky.delete) deletes a version of a sticky disk the host holds, or with no version every version of
// it. A version the host hasn't is deleted already.
func (m *Manager) DeleteSticky(p proto.StickyDeleteParams) error {
	if !validID(p.DiskID) || (p.Version != "" && !validID(p.Version)) {
		return &proto.Error{Code: proto.ErrInvalid, Message: "bad sticky disk ID or version"}
	}
	m.stickyMu.Lock()
	defer m.stickyMu.Unlock()
	dir := filepath.Join(m.stickyRoot(), p.DiskID)
	if p.Version == "" {
		return os.RemoveAll(dir)
	}
	if err := os.Remove(m.stickyVersionFile(p.DiskID, p.Version)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	// The disk's directory goes with its last version (a file being committed keeps it).
	_ = os.Remove(dir)
	return nil
}

// StickyHoldings are the sticky disk versions the host holds, by disk ID, each disk's newest first: [] when none.
// Unlocked, so a long clone never holds up a capacity report: a version committed or deleted meanwhile is in the
// next.
func (m *Manager) StickyHoldings() []proto.StickyDiskHolding {
	out := []proto.StickyDiskHolding{}
	entries, err := os.ReadDir(m.stickyRoot())
	if err != nil {
		return out
	}
	for _, e := range entries {
		if !e.IsDir() || !validID(e.Name()) {
			continue
		}
		held := m.stickyVersions(e.Name())
		if len(held) == 0 {
			continue
		}
		h := proto.StickyDiskHolding{DiskID: e.Name()}
		for _, v := range held {
			h.Versions = append(h.Versions, proto.StickyVersionHolding{Version: v.version, AllocatedBytes: v.allocated, At: v.at})
		}
		out = append(out, h)
	}
	return out
}
