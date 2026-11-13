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
// guest freeze the disk's file system under a lease the guest ends by itself, clones the drive's file to a new version
// within it, and thaws it; then only the disk's two last published versions are kept. Each version has its block map
// beside it, <version>.map (stickymap.go).

import (
	"context"
	"encoding/json"
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
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// StickyDrives is how many sticky drives every microVM has: the most sticky disks a sandbox may have.
const StickyDrives = proto.StickyDisksMax

// maxStickyGiB is the biggest sticky disk a create may make.
const maxStickyGiB = maxCustomDiskGiB

// stickyKeep is how many versions of each disk the host keeps after a commit.
const stickyKeep = 2

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
			// A move; on another file system (never under one root, but if it were) a full copy, which reserves its room.
			if err = os.Rename(src, dst); err != nil {
				_, err = m.cloneStickyFile(src, dst)
			}
		} else {
			_, err = m.cloneStickyFile(src, dst)
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
// stopped, or paused with no write in flight. reserved says the snapshot's own reservation counts their room already,
// with its disk (stickyUsage in roomForSnapshot and roomToSave), so a full copy here reserves nothing more; else (a live
// fork's snapshot, whose disk is the fork's and counted by its create) each drive's full copy reserves its own room
// (cloneStickyFile), and a reflink none.
func (m *Manager) keepSticky(vm, sdir string, disks []stickyDisk, reserved bool) error {
	for _, d := range attachedSticky(disks) {
		src, dst := filepath.Join(vm, stickyDriveFile(d.Slot)), filepath.Join(sdir, stickyDriveFile(d.Slot))
		var err error
		if reserved {
			_, err = cloneDisk(src, dst)
		} else {
			_, err = m.cloneStickyFile(src, dst)
		}
		if err != nil {
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

// validateEffectiveSticky checks a create's sticky disks together with those it inherits from the snapshot it is made
// from, and its mounts, before anything is made: a requested disk the snapshot has already is kept if it is at the same
// path and refused at another; no two disks, nor a disk and a mount, meet (the same path, or one inside the other); and
// there are at most StickyDrives.
func validateEffectiveSticky(inherited []stickyDisk, requested []proto.StickyDisk, mounts []proto.Mount) error {
	invalid := func(format string, args ...any) error {
		return &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf(format, args...)}
	}
	type at struct{ id, path string }
	var disks []at
	for _, d := range inherited {
		disks = append(disks, at{d.DiskID, d.Path})
	}
	for _, r := range requested {
		kept := false
		for _, d := range inherited {
			if d.DiskID != r.DiskID {
				continue
			}
			if d.Path != r.Path {
				return invalid("sticky disk %s is at %s in the snapshot the sandbox is made from, not %s", r.DiskID, d.Path, r.Path)
			}
			kept = true
		}
		if !kept {
			disks = append(disks, at{r.DiskID, r.Path})
		}
	}
	if len(disks) > StickyDrives {
		return invalid("a sandbox has at most %d sticky disks, and this one would have %d with its snapshot's", StickyDrives, len(disks))
	}
	meets := func(a, b string) bool { return a == b || strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/") }
	for i, d := range disks {
		for _, other := range disks[i+1:] {
			if meets(d.path, other.path) {
				return invalid("sticky disks %s at %s and %s at %s meet", d.id, d.path, other.id, other.path)
			}
		}
		for _, mt := range mounts {
			if meets(d.path, mt.Path) {
				return invalid("sticky disk %s at %s meets the mount at %s", d.id, d.path, mt.Path)
			}
		}
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

// stickyOrderFile, in a disk's directory, is the order its versions were published in on this host (stickyOrder).
const stickyOrderFile = ".order.json"

// stickyOrder is a disk's publication sequence: each version's place (Seq), and the next one's (Next). Written under
// stickyMu, durably, as each version is published or removed, so "newest" is the last published, whatever the
// clock or the versions' names say.
type stickyOrder struct {
	Next int64            `json:"next"`
	Seq  map[string]int64 `json:"seq"`
}

func (m *Manager) readStickyOrder(diskID string) stickyOrder {
	o := stickyOrder{Next: 1, Seq: map[string]int64{}}
	raw, err := os.ReadFile(filepath.Join(m.stickyRoot(), diskID, stickyOrderFile))
	if err == nil {
		_ = json.Unmarshal(raw, &o)
	}
	if o.Seq == nil {
		o.Seq = map[string]int64{}
	}
	for _, seq := range o.Seq {
		o.Next = max(o.Next, seq+1)
	}
	return o
}

func (m *Manager) writeStickyOrder(diskID string, o stickyOrder) error {
	raw, _ := json.Marshal(o)
	return fsutil.WriteFileDurably(filepath.Join(m.stickyRoot(), diskID, stickyOrderFile), raw, 0o600)
}

// stickyVersion is a version the host holds of a disk: its place in the disk's publication sequence (0: not in it,
// older than any that is), when its file was made, and the bytes it takes.
type stickyVersion struct {
	version   string
	seq       int64
	at        int64
	allocated int64
}

// stickyVersions are the versions of a disk the host holds, newest (last published) first. Files being written (named
// with a leading dot) aren't versions. A version it can't read is left out: for a clone or a prune, which read again.
func (m *Manager) stickyVersions(diskID string) []stickyVersion {
	held, _ := m.listStickyVersions(diskID)
	return held
}

// listStickyVersions is stickyVersions with whether it read every version: an error when the disk's directory or a
// version's file couldn't be read (one gone meanwhile, deleted, isn't held), with what it could read.
func (m *Manager) listStickyVersions(diskID string) ([]stickyVersion, error) {
	entries, err := os.ReadDir(filepath.Join(m.stickyRoot(), diskID))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	order := m.readStickyOrder(diskID)
	var out []stickyVersion
	var failed error
	for _, e := range entries {
		name := e.Name()
		version, ok := strings.CutSuffix(name, ".img")
		if !ok || !e.Type().IsRegular() || !validID(version) {
			continue
		}
		var st syscall.Stat_t
		if err := syscall.Stat(filepath.Join(m.stickyRoot(), diskID, name), &st); err != nil {
			if !errors.Is(err, fs.ErrNotExist) && failed == nil {
				failed = fmt.Errorf("stat %s: %w", name, err)
			}
			continue
		}
		out = append(out, stickyVersion{version: version, seq: order.Seq[version], at: st.Mtim.Sec*1000 + st.Mtim.Nsec/1e6, allocated: st.Blocks * 512})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].seq != out[j].seq {
			return out[i].seq > out[j].seq
		}
		if out[i].at != out[j].at {
			return out[i].at > out[j].at
		}
		return out[i].version > out[j].version
	})
	return out, failed
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
	if _, err := m.cloneStickyFile(m.stickyVersionFile(diskID, version), dst); err != nil {
		return "", err
	}
	return version, nil
}

// stickyUsage is the bytes s's attached sticky drives' files take (their allocated blocks, which a full copy writes
// again): what a snapshot of s copies beside its disk. Called with s.mu held.
func stickyUsage(s *sandbox) int64 {
	var n int64
	for _, d := range attachedSticky(s.meta.StickyDisks) {
		n += diskUsage(filepath.Join(s.vmDir(), stickyDriveFile(d.Slot)))
	}
	return n
}

// cloneStickyFile is cloneDisk for a sticky disk's file outside a snapshot (an attach, or a sandbox made from a
// snapshot): a reflink shares the source's blocks and takes no room, so it is never refused; a full copy, on a file
// system without reflinks, first reserves the room it writes (reserveStickyCopy) beside every other copy under way,
// and gives it back once it ends, however it ends.
//
// A create's admission (admit) doesn't count its sticky disks' sizes: their clones share blocks with the versions they
// come from, so counting each sandbox's whole disk would refuse sandboxes on a host with room for them. What a full
// copy really takes is reserved here instead, when it is made.
func (m *Manager) cloneStickyFile(src, dst string) (string, error) {
	if reflink(src, dst) == nil {
		return proto.DiskReflink, nil
	}
	_ = os.Remove(dst)
	release, err := m.reserveStickyCopy(src)
	if err != nil {
		return "", err
	}
	defer release()
	return cloneDisk(src, dst)
}

// reserveStickyCopy reserves the room a full copy of the sticky disk file src takes (its allocated blocks), refusing
// (ErrCapacity) a copy that would leave the host less than snapshotHeadroom free beside the copies under way.
func (m *Manager) reserveStickyCopy(src string) (release func(), err error) {
	return m.reserveRoom(diskUsage(src), func(free, size int64) error {
		return &proto.Error{Code: proto.ErrCapacity, Message: fmt.Sprintf(
			"This host has %s of disk free, and a full copy of a sticky disk (its file system has no reflinks) needs %s and must leave %s free.",
			gibText(max(free, 0)), gibText(size), gibText(snapshotHeadroom))}
	})
}

// stickyFreezeLease is how long a commit's freeze holds in the guest before the guest thaws it by itself: the drive's
// file is cloned within it, or the commit fails. stickyLeaseMargin is what of it the host leaves for the guest's
// clock, the calls and the thaw.
var (
	stickyFreezeLease = 30 * time.Second
	stickyLeaseMargin = 3 * time.Second
)

// CommitSticky (sticky.commit) makes a running sandbox's copy of a sticky disk the disk's version p.Version on this
// host: the version is reserved, the guest writes the disk back and freezes it under a lease, the drive's file is
// cloned to a temporary file of this commit's own within the lease, the guest thaws it, and the clone is published
// under the version's name only if no other commit has it (link, never a rename over it). Then the host keeps only the
// disk's stickyKeep last published versions. A thaw that fails is reported in the answer (ThawError): the guest thaws
// by itself when the lease lapses.
//
// Then, with the sandbox free again, the version's block map is made from its parent's (mapStickyWithin), and its
// digest answered as MapDigest when it is made within stickyMapWait; a map that takes longer is finished in the
// background, and capacity reports give its digest once it is.
func (m *Manager) CommitSticky(ctx context.Context, p proto.StickyCommitParams) (proto.StickyCommitResult, error) {
	res, parent, err := m.commitSticky(ctx, p)
	if err != nil {
		return res, err
	}
	digest, err := m.mapStickyWithin(ctx, p.DiskID, p.Version, parent, stickyMapWait)
	if err != nil {
		m.log.Warn("a committed sticky disk version's map", "disk", p.DiskID, "version", p.Version, "error", err)
	}
	res.MapDigest = digest
	return res, nil
}

// commitSticky is CommitSticky's commit, under the sandbox's lock: it answers the version its copy came from as parent.
func (m *Manager) commitSticky(ctx context.Context, p proto.StickyCommitParams) (res proto.StickyCommitResult, parent string, err error) {
	if !validID(p.DiskID) || !validID(p.Version) {
		return proto.StickyCommitResult{}, "", &proto.Error{Code: proto.ErrInvalid, Message: "bad sticky disk ID or version"}
	}
	s, err := m.get(p.SandboxID)
	if err != nil {
		return proto.StickyCommitResult{}, "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.State != proto.StateRunning || s.machine == nil || s.guest == nil {
		return proto.StickyCommitResult{}, "", conflict("sandbox %s is %s, not running", s.meta.ID, s.meta.State)
	}
	var disk *stickyDisk
	for i := range s.meta.StickyDisks {
		if d := &s.meta.StickyDisks[i]; d.DiskID == p.DiskID && d.Slot >= 0 {
			disk = d
		}
	}
	if disk == nil {
		return proto.StickyCommitResult{}, "", &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("sandbox %s has no sticky disk %s", s.meta.ID, p.DiskID)}
	}
	if disk.State != proto.StickyMounted {
		return proto.StickyCommitResult{}, "", conflict("sticky disk %s isn't mounted in sandbox %s: %s", p.DiskID, s.meta.ID, disk.Reason)
	}
	release, err := m.reserveStickyVersion(p.DiskID, p.Version)
	if err != nil {
		return proto.StickyCommitResult{}, "", err
	}
	defer release()
	dir := filepath.Dir(m.stickyVersionFile(p.DiskID, p.Version))
	tmpFile, err := os.CreateTemp(dir, "."+p.Version+".*.new")
	if err != nil {
		return proto.StickyCommitResult{}, "", err
	}
	tmp := tmpFile.Name()
	tmpFile.Close()
	// This commit's own file, removed whatever happens: once published, the version is a link to it.
	defer os.Remove(tmp)
	thawErr, err := m.cloneFrozen(ctx, s, *disk, tmp)
	if err != nil {
		return proto.StickyCommitResult{}, "", err
	}
	final := m.stickyVersionFile(p.DiskID, p.Version)
	if err := m.publishSticky(p.DiskID, p.Version, tmp); err != nil {
		return proto.StickyCommitResult{}, "", err
	}
	var st syscall.Stat_t
	if err := syscall.Stat(final, &st); err != nil {
		return proto.StickyCommitResult{}, "", err
	}
	res = proto.StickyCommitResult{Version: p.Version, SizeBytes: st.Size, AllocatedBytes: st.Blocks * 512}
	if thawErr != nil {
		res.ThawError = thawErr.Error()
	}
	m.log.Info("sticky disk committed", "sandbox", s.meta.ID, "disk", p.DiskID, "version", p.Version, "allocatedBytes", res.AllocatedBytes)
	return res, disk.Version, nil
}

// reserveStickyVersion keeps a version of a disk for one commit until release: a version the host has, or another
// commit is making, is a conflict.
func (m *Manager) reserveStickyVersion(diskID, version string) (release func(), err error) {
	key := diskID + "/" + version
	m.stickyMu.Lock()
	defer m.stickyMu.Unlock()
	if m.stickyCommits[key] || fileExists(m.stickyVersionFile(diskID, version)) {
		return nil, conflict("this host has version %s of sticky disk %s already, or is committing it", version, diskID)
	}
	if err := os.MkdirAll(filepath.Join(m.stickyRoot(), diskID), 0o700); err != nil {
		return nil, err
	}
	// A map an older version of the name left (its delete couldn't remove it) isn't this one's.
	m.removeStickyMap(diskID, version)
	if m.stickyCommits == nil {
		m.stickyCommits = map[string]bool{}
	}
	m.stickyCommits[key] = true
	return func() {
		m.stickyMu.Lock()
		delete(m.stickyCommits, key)
		m.stickyMu.Unlock()
	}, nil
}

// publishSticky makes tmp the disk's version, last in its publication sequence, without ever replacing a file of that
// name (link(2): EEXIST is a conflict), then prunes the disk to its stickyKeep newest versions.
func (m *Manager) publishSticky(diskID, version, tmp string) error {
	m.stickyMu.Lock()
	defer m.stickyMu.Unlock()
	final := m.stickyVersionFile(diskID, version)
	if err := os.Link(tmp, final); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return conflict("this host has version %s of sticky disk %s already", version, diskID)
		}
		return err
	}
	// Made now, whatever the clone kept, for the holdings' at.
	now := time.Now()
	_ = os.Chtimes(final, now, now)
	order := m.readStickyOrder(diskID)
	order.Seq[version] = order.Next
	order.Next++
	if err := m.writeStickyOrder(diskID, order); err != nil {
		// Unordered, it would be no one's newest: not published.
		_ = os.Remove(final)
		return err
	}
	m.pruneStickyLocked(diskID)
	return nil
}

// cloneFrozen clones the drive file of s's sticky disk d to dst while its guest has the disk's file system frozen
// under a stickyFreezeLease lease, and thaws it after, whether the freeze or the clone failed or not. The clone must
// end within the lease (less stickyLeaseMargin, counted from before the freeze was asked for): one that can't (a full
// copy, on a file system without reflinks) fails, and nothing is published. A thaw that fails is answered as thawErr,
// and logged: the clone was made while frozen all the same. Called with s.mu held.
func (m *Manager) cloneFrozen(ctx context.Context, s *sandbox, d stickyDisk, dst string) (thawErr, err error) {
	thaw := func() error {
		// On a context of its own: the call's may be what ended the freeze or the clone.
		tctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stickyLeaseMargin)
		defer cancel()
		err := s.guest.ThawSticky(tctx, d.Path)
		if err != nil {
			m.log.Warn("thawing a sticky disk after its commit (the guest thaws it when its lease lapses)", "sandbox", s.meta.ID, "disk", d.DiskID, "error", err)
		}
		return err
	}
	deadline := time.Now().Add(stickyFreezeLease - stickyLeaseMargin)
	fctx, cancel := context.WithDeadline(ctx, deadline)
	err = s.guest.FreezeSticky(fctx, d.Path, stickyFreezeLease)
	cancel()
	if err != nil {
		_ = thaw()
		if guest.IsNotFound(err) {
			return nil, conflict("sticky disk %s can't be frozen in sandbox %s: %v", d.DiskID, s.meta.ID, err)
		}
		return nil, fmt.Errorf("freezing sticky disk %s: %w", d.DiskID, err)
	}
	err = cloneWithin(ctx, filepath.Join(s.vmDir(), stickyDriveFile(d.Slot)), dst, deadline, m.reserveStickyCopy)
	thawErr = thaw()
	if err != nil {
		return nil, fmt.Errorf("sticky disk %s: %w", d.DiskID, err)
	}
	return thawErr, nil
}

// cloneWithin clones src to dst (cloneDisk) and fails unless the clone ended by deadline: a reflink is instant and takes
// no room; a full sparse copy first reserves its room (reserve, given src; nil reserves nothing), and gives it back
// however it ends, and is stopped at the deadline.
func cloneWithin(ctx context.Context, src, dst string, deadline time.Time, reserve func(src string) (func(), error)) error {
	late := func() error {
		_ = os.Remove(dst)
		return fmt.Errorf("its copy couldn't be made within the %s its file system is frozen for: this host's file system has no reflinks, so a commit copies the whole disk, and an unfinished copy isn't published", stickyFreezeLease)
	}
	if time.Now().After(deadline) {
		return late()
	}
	if reflink(src, dst) == nil {
		if time.Now().After(deadline) {
			return late()
		}
		return nil
	}
	_ = os.Remove(dst)
	if reserve != nil {
		release, err := reserve(src)
		if err != nil {
			return err
		}
		defer release()
	}
	cctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	out, err := exec.CommandContext(cctx, "cp", "--sparse=always", src, dst).CombinedOutput()
	if cctx.Err() != nil || time.Now().After(deadline) {
		return late()
	}
	if err != nil {
		_ = os.Remove(dst)
		return fmt.Errorf("copy %s: %v: %s", filepath.Base(src), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// thawStickyAfterRestart thaws every sticky disk of a sandbox adopted running when the host starts: a commit the
// previous run had under way may have left one frozen. Thawing one that isn't frozen is fine.
//
// In the background, so adopting isn't held up, but under s.mu for the whole of its guest calls, as a commit's
// freeze, clone and thaw are (CommitSticky): a thaw sent while a new commit has the disk frozen would let the guest
// write it during the clone. It thaws only while the sandbox still runs on the guest it was adopted with: one stopped,
// paused or booted again meanwhile is left to its guest, which thaws a freeze by itself once its lease lapses. The
// answer is closed once it is done (tests wait on it).
func (m *Manager) thawStickyAfterRestart(s *sandbox) <-chan struct{} {
	done := make(chan struct{})
	paths := []string{}
	for _, d := range attachedSticky(s.meta.StickyDisks) {
		paths = append(paths, d.Path)
	}
	client := s.guest
	if len(paths) == 0 || client == nil {
		close(done)
		return done
	}
	go func() {
		defer close(done)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.guest != client || s.meta.State != proto.StateRunning {
			return
		}
		for _, path := range paths {
			ctx, cancel := context.WithTimeout(context.Background(), stickyFreezeLease)
			if err := client.ThawSticky(ctx, path); err != nil && !guest.IsNotFound(err) {
				m.log.Warn("thawing an adopted sandbox's sticky disk", "sandbox", s.meta.ID, "path", path, "error", err)
			}
			cancel()
		}
	}()
	return done
}

// pruneStickyLocked deletes all but the disk's stickyKeep newest versions. Called with stickyMu held.
func (m *Manager) pruneStickyLocked(diskID string) {
	held := m.stickyVersions(diskID)
	if len(held) <= stickyKeep {
		return
	}
	order := m.readStickyOrder(diskID)
	for _, v := range held[stickyKeep:] {
		if err := os.Remove(m.stickyVersionFile(diskID, v.version)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			m.log.Warn("deleting an old sticky disk version", "disk", diskID, "version", v.version, "error", err)
			continue
		}
		m.removeStickyMap(diskID, v.version)
		delete(order.Seq, v.version)
	}
	_ = m.writeStickyOrder(diskID, order)
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
		// A commit under way keeps its own file and fails to publish into the gone directory.
		m.forgetStickyDigest(p.DiskID, "")
		return os.RemoveAll(dir)
	}
	if err := os.Remove(m.stickyVersionFile(p.DiskID, p.Version)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	m.removeStickyMap(p.DiskID, p.Version)
	order := m.readStickyOrder(p.DiskID)
	if _, ok := order.Seq[p.Version]; ok {
		delete(order.Seq, p.Version)
		_ = m.writeStickyOrder(p.DiskID, order)
	}
	if len(m.stickyVersions(p.DiskID)) == 0 && len(m.stickyCommitsOf(p.DiskID)) == 0 {
		_ = os.RemoveAll(dir)
	}
	return nil
}

// stickyCommitsOf are the versions of a disk being committed now. Called with stickyMu held.
func (m *Manager) stickyCommitsOf(diskID string) []string {
	var out []string
	for key := range m.stickyCommits {
		if d, v, _ := strings.Cut(key, "/"); d == diskID {
			out = append(out, v)
		}
	}
	return out
}

// StickyHoldings are the sticky disk versions the host holds, by disk ID, each disk's newest first: [] when none (no
// sticky root yet included). Nil, which a report leaves out, when any of it couldn't be read: the control plane takes
// a version missing from a report as deleted, so a report lists every version or says nothing. Unlocked, so a long
// clone never holds up a capacity report: a version committed or deleted meanwhile is in the next.
func (m *Manager) StickyHoldings() []proto.StickyDiskHolding {
	out := []proto.StickyDiskHolding{}
	entries, err := os.ReadDir(m.stickyRoot())
	if errors.Is(err, fs.ErrNotExist) {
		return out
	}
	if err != nil {
		m.log.Warn("sticky disk holdings left out of the report: their directory can't be read", "error", err)
		return nil
	}
	for _, e := range entries {
		if !e.IsDir() || !validID(e.Name()) {
			continue
		}
		held, err := m.listStickyVersions(e.Name())
		if err != nil {
			m.log.Warn("sticky disk holdings left out of the report: a disk's versions can't be read", "disk", e.Name(), "error", err)
			return nil
		}
		if len(held) == 0 {
			continue
		}
		h := proto.StickyDiskHolding{DiskID: e.Name()}
		for _, v := range held {
			h.Versions = append(h.Versions, proto.StickyVersionHolding{Version: v.version, AllocatedBytes: v.allocated, At: v.at, MapDigest: m.stickyMapDigest(e.Name(), v.version)})
		}
		out = append(out, h)
	}
	return out
}
