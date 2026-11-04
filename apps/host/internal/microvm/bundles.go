package microvm

// Bundle mounts: a bundle (an account's tar, named by its digest) mounted read-only in a sandbox, from an erofs image
// the host keeps once (package bundles) and attaches to every sandbox that mounts it as a read-only drive.
//
// Firecracker can't add a drive to a running VM, and a template snapshot restores the devices it was made with, so
// every microVM has the same BundleDrives read-only drives, bundle0.erofs, bundle1.erofs, ... in its VM directory (an
// empty file until a bundle is attached), which the guest sees as /dev/vdc, /dev/vdd, .... Attaching a bundle to a
// running sandbox, whether it was restored from the template or from a snapshot or cold-booted (a custom shape), puts a
// hard link to the bundle's image at the drive's file and points the drive at it again (PATCH /drives), which tells
// the guest the drive's size changed; then the guest agent mounts it (POST /bundles). The link is how the cache knows
// the image is in use, so it is never evicted while a sandbox, stopped or running, or a snapshot of one holds it.
//
// A snapshot keeps the sandbox's drives as they were (meta BundleSlots, and links in its directory): its memory
// holds the guest's mounts of them, so a sandbox restored from it gets the same images on the same drives first, and
// only then the bundles it mounts itself.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/bundles"
	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// DefaultBundleWait is how long a create (or start) waits for a bundle's image before it answers with the mount
// pending, and mounts it once the image is built. The control plane's call times out at 120 s.
const DefaultBundleWait = 60 * time.Second

// bundleDriveFile is bundle drive i's file in a VM's directory.
func bundleDriveFile(i int) string { return fmt.Sprintf("bundle%d.erofs", i) }

func bundleDriveID(i int) string { return fmt.Sprintf("bundle%d", i) }

// bundleDrives is the drives a VM with n bundle drives boots with.
func bundleDrives(n int) []fc.Drive {
	out := make([]fc.Drive, n)
	for i := range out {
		out[i] = fc.Drive{ID: bundleDriveID(i), Path: bundleDriveFile(i), ReadOnly: true}
	}
	return out
}

// bundleMounts are the sandbox's bundle mounts.
func bundleMounts(s *sandbox) []proto.Mount {
	var out []proto.Mount
	for _, mt := range s.meta.Mounts {
		if mt.Kind == proto.MountBundle {
			out = append(out, mt)
		}
	}
	return out
}

// driveCountFile, in a template snapshot's directory, is how many bundle drives its VM was made with.
const driveCountFile = "bundle-drives"

func writeSnapshotDriveCount(dir string, n int) error {
	if n == 0 {
		return nil
	}
	return os.WriteFile(filepath.Join(dir, driveCountFile), []byte(strconv.Itoa(n)), 0o600)
}

// snapshotDriveCount is how many bundle drives the template snapshot in dir was made with: none for one made before
// bundle mounts, or on a host without them.
func snapshotDriveCount(dir string) int {
	raw, err := os.ReadFile(filepath.Join(dir, driveCountFile))
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	return max(0, n)
}

// emptyDrives puts an empty file at each of a new VM's n bundle drives (before it boots or restores). A file there
// already is an error, never truncated: it may be a link to a cached image other sandboxes and snapshots share.
func emptyDrives(vm string, n int) error {
	for i := 0; i < n; i++ {
		if err := newEmptyFile(filepath.Join(vm, bundleDriveFile(i))); err != nil {
			return err
		}
	}
	return nil
}

// newEmptyFile makes an empty file at path, failing if anything is there.
func newEmptyFile(path string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("a bundle drive: %w", err)
	}
	return f.Close()
}

// snapshotDrives gives a new VM restoring a snapshot the bundle drives the snapshot was taken with: the same images
// (linked from the snapshot's directory), empty files for the rest, and answers the drives' slots as made (a slot
// whose image the snapshot no longer has is empty). Like emptyDrives, it never writes to a file already there.
func snapshotDrives(vm, sdir string, n int, slots []string) ([]string, error) {
	made := make([]string, n)
	for i := 0; i < n; i++ {
		dst := filepath.Join(vm, bundleDriveFile(i))
		if i < len(slots) && slots[i] != "" {
			err := os.Link(filepath.Join(sdir, bundleDriveFile(i)), dst)
			if err == nil {
				made[i] = slots[i]
				continue
			}
			if !errors.Is(err, fs.ErrNotExist) {
				return nil, fmt.Errorf("a bundle drive: %w", err)
			}
		}
		if err := newEmptyFile(dst); err != nil {
			return nil, err
		}
	}
	return made, nil
}

// keepDrives links a sandbox's attached bundle images into a snapshot's directory, so they stay while it does.
func keepDrives(vm, sdir string, slots []string) error {
	for i, digest := range slots {
		if digest == "" {
			continue
		}
		if err := os.Link(filepath.Join(vm, bundleDriveFile(i)), filepath.Join(sdir, bundleDriveFile(i))); err != nil {
			return err
		}
	}
	return nil
}

// dropDrives removes a snapshot's links to bundle images.
func dropDrives(sdir string) {
	files, _ := filepath.Glob(filepath.Join(sdir, "bundle*.erofs"))
	for _, f := range files {
		_ = os.Remove(f)
	}
}

// evictBundles trims the bundle cache in the background, once a sandbox or snapshot let go of its images.
func (m *Manager) evictBundles() {
	if m.cfg.Bundles != nil {
		go m.cfg.Bundles.Evict()
	}
}

// fetchFor fetches a bundle's tar for a sandbox's mount.
func (m *Manager) fetchFor(sandboxID string) bundles.Fetch {
	return func(ctx context.Context, digest string) (io.ReadCloser, error) {
		if m.cfg.FetchBundle == nil {
			return nil, errors.New("this host can't fetch bundles")
		}
		return m.cfg.FetchBundle(ctx, sandboxID, digest)
	}
}

// prefetchBundles starts getting the images of a sandbox's bundles the cache hasn't, while its VM starts.
func (m *Manager) prefetchBundles(s *sandbox) {
	if m.cfg.Bundles == nil {
		return
	}
	for _, mt := range bundleMounts(s) {
		// Held from now until attachBundles links it or gives it up.
		m.reserveBundle(s, mt.Digest)
		if m.cfg.Bundles.Has(mt.Digest) {
			continue
		}
		digest, fetch := mt.Digest, m.fetchFor(s.meta.ID)
		go func() { _, _ = m.cfg.Bundles.Get(context.Background(), digest, fetch) }()
	}
}

// reserveBundle keeps a bundle's image in the cache for the sandbox, from before it first waits for it (a build's own
// trim, or another's, would otherwise evict an image made for it while images in use fill the cache) until
// releaseBundles: once the image is linked to its drive (the link keeps it then), or the sandbox gives it up. Called
// with s.mu held.
func (m *Manager) reserveBundle(s *sandbox, digest string) {
	if m.cfg.Bundles == nil {
		return
	}
	if s.reserved == nil {
		s.reserved = map[string]func(){}
	}
	if _, ok := s.reserved[digest]; !ok {
		s.reserved[digest] = m.cfg.Bundles.Reserve(digest)
	}
}

// releaseBundles lets go of the sandbox's reservations but those of the digests in keep. Called with s.mu held.
func (m *Manager) releaseBundles(s *sandbox, keep map[string]bool) {
	for digest, release := range s.reserved {
		if !keep[digest] {
			release()
			delete(s.reserved, digest)
		}
	}
}

// setMountStatus records the sandbox's mount statuses, and when (MountsAt): always later than the last, so the
// control plane orders what it is told of them. Called with s.mu held.
func setMountStatus(s *sandbox, status []proto.MountStatus) {
	s.meta.MountStatus = status
	at := time.Now().UnixMilli()
	if at <= s.meta.MountsAt {
		at = s.meta.MountsAt + 1
	}
	s.meta.MountsAt = at
}

// attachBundles attaches a running sandbox's bundles to its drives and has its guest mount them, waiting up to wait
// for an image that is still being built; one that takes longer stays pending and is attached when it is ready
// (finishBundles). It records each bundle mount's status in the sandbox's meta (written by the caller) and answers
// whether any is pending. Called with s.mu held.
func (m *Manager) attachBundles(ctx context.Context, s *sandbox, wait time.Duration) (pending bool) {
	mounts := bundleMounts(s)
	if len(mounts) == 0 && !anyAttached(s.meta.BundleSlots) {
		m.releaseBundles(s, nil)
		setMountStatus(s, nil)
		return false
	}
	// Each image is reserved from before its wait; those still pending at the end stay reserved, for finishBundles.
	for _, mt := range mounts {
		m.reserveBundle(s, mt.Digest)
	}
	status := map[string]proto.MountStatus{}
	set := func(mt proto.Mount, state, msg string) {
		status[mt.Path] = proto.MountStatus{Path: mt.Path, Kind: proto.MountBundle, State: state, Error: msg}
	}
	// Each bundle's image: on one of the sandbox's drives already, built now, still being built, or failed.
	type outcome struct{ state, msg string }
	byDigest := map[string]outcome{}
	attached := map[string]bool{}
	for _, d := range s.meta.BundleSlots {
		if d != "" {
			attached[d] = true
		}
	}
	waitCtx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	for _, mt := range mounts {
		if _, done := byDigest[mt.Digest]; done {
			continue
		}
		if attached[mt.Digest] {
			byDigest[mt.Digest] = outcome{}
			continue
		}
		if m.cfg.Bundles == nil {
			byDigest[mt.Digest] = outcome{proto.MountFailed, "this host can't mount bundles"}
			continue
		}
		_, err := m.cfg.Bundles.Get(waitCtx, mt.Digest, m.fetchFor(s.meta.ID))
		switch {
		case err == nil:
			byDigest[mt.Digest] = outcome{}
		case waitCtx.Err() != nil && ctx.Err() == nil:
			// Still being built: mounted once it is.
			byDigest[mt.Digest] = outcome{proto.MountPending, ""}
		default:
			byDigest[mt.Digest] = outcome{proto.MountFailed, err.Error()}
		}
	}
	ready := map[string]bool{}
	for _, mt := range mounts {
		o := byDigest[mt.Digest]
		if o.state == "" {
			ready[mt.Digest] = true
		} else {
			set(mt, o.state, o.msg)
		}
	}

	// Which drive each ready bundle goes on: the one it's on already, else a free one.
	slots := make([]string, s.meta.BundleDrives)
	copy(slots, s.meta.BundleSlots)
	want := map[string]bool{}
	for _, mt := range mounts {
		if ready[mt.Digest] {
			want[mt.Digest] = true
		}
	}
	next := append([]string(nil), slots...)
	for i, digest := range next {
		if digest != "" && !want[digest] {
			next[i] = ""
		}
	}
	slotOf := map[string]int{}
	for i, digest := range next {
		if digest != "" {
			slotOf[digest] = i
		}
	}
	for _, mt := range mounts {
		if !ready[mt.Digest] {
			continue
		}
		if _, ok := slotOf[mt.Digest]; ok {
			continue
		}
		free := -1
		for i, digest := range next {
			if digest == "" {
				free = i
				break
			}
		}
		if free < 0 {
			continue
		}
		next[free] = mt.Digest
		slotOf[mt.Digest] = free
	}
	for _, mt := range mounts {
		if _, ok := slotOf[mt.Digest]; !ok && ready[mt.Digest] {
			set(mt, proto.MountFailed, fmt.Sprintf("this sandbox can mount at most %d different bundles", s.meta.BundleDrives))
		}
	}

	// The guest's mounts of a bundle whose drive changes go first, before the drive does.
	changed := false
	stale := false
	for i := range next {
		if next[i] != slots[i] {
			changed = true
			if slots[i] != "" {
				stale = true
			}
		}
	}
	kept := func() []guest.BundleMount {
		var out []guest.BundleMount
		for _, mt := range mounts {
			i, ok := slotOf[mt.Digest]
			if ok && slots[i] == mt.Digest {
				out = append(out, guest.BundleMount{Path: mt.Path, Drive: i, Digest: mt.Digest, Bytes: imageBytes(s.vmDir(), i)})
			}
		}
		return out
	}
	if stale {
		// A drive whose old bundle is still mounted (something in the sandbox uses it) keeps its image: changing it
		// under a live file system would show that file system the new image's bytes. The bundles that were to go on it
		// fail, and the next start or resume tries again.
		held, why := m.releaseDrives(ctx, s, kept())
		for i := range next {
			if slots[i] == "" || next[i] == slots[i] || !held(i) {
				continue
			}
			if next[i] != "" {
				for _, mt := range mounts {
					if mt.Digest == next[i] {
						set(mt, proto.MountFailed, "the bundle before it on its drive can't be unmounted ("+why+")")
					}
				}
				delete(slotOf, next[i])
			}
			next[i] = slots[i]
		}
		changed = false
		for i := range next {
			if next[i] != slots[i] {
				changed = true
			}
		}
	}
	if changed {
		for i := range next {
			if next[i] == slots[i] {
				continue
			}
			if err := m.setDrive(ctx, s, i, next[i]); err != nil {
				m.log.Warn("bundle drive", "sandbox", s.meta.ID, "drive", i, "error", err)
				for _, mt := range mounts {
					if mt.Digest == next[i] {
						set(mt, proto.MountFailed, "attaching the bundle's image: "+err.Error())
					}
				}
				delete(slotOf, next[i])
				next[i] = ""
				if slots[i] != "" {
					// The drive is in an unknown state: empty it, so nothing reads half of one image.
					_ = m.setDrive(ctx, s, i, "")
				}
			}
		}
	}
	s.meta.BundleSlots = next

	var list []guest.BundleMount
	for _, mt := range mounts {
		if st, ok := status[mt.Path]; ok && st.State != "" {
			continue
		}
		i := slotOf[mt.Digest]
		list = append(list, guest.BundleMount{Path: mt.Path, Drive: i, Digest: mt.Digest, Bytes: imageBytes(s.vmDir(), i)})
	}
	answer, err := s.guest.MountBundles(ctx, list)
	results := answer.Mounts
	if err != nil {
		msg := err.Error()
		if guest.IsNotFound(err) {
			msg = "this sandbox's image can't mount bundles (its guest agent predates them)"
		}
		for _, b := range list {
			set(proto.Mount{Path: b.Path}, proto.MountFailed, msg)
		}
	} else {
		got := map[string]string{}
		for _, r := range results {
			got[r.Path] = r.Error
		}
		for _, b := range list {
			msg, ok := got[b.Path]
			switch {
			case !ok:
				set(proto.Mount{Path: b.Path}, proto.MountFailed, "the guest didn't mount it")
			case msg != "":
				set(proto.Mount{Path: b.Path}, proto.MountFailed, msg)
			default:
				set(proto.Mount{Path: b.Path}, proto.MountReady, "")
			}
		}
	}
	var statuses []proto.MountStatus
	waiting := map[string]bool{}
	for _, mt := range mounts {
		st := status[mt.Path]
		if st.State == proto.MountPending {
			pending = true
			waiting[mt.Digest] = true
		}
		statuses = append(statuses, st)
	}
	setMountStatus(s, statuses)
	m.releaseBundles(s, waiting)
	return pending
}

func anyPending(status []proto.MountStatus) bool {
	for _, st := range status {
		if st.State == proto.MountPending {
			return true
		}
	}
	return false
}

func anyAttached(slots []string) bool {
	for _, d := range slots {
		if d != "" {
			return true
		}
	}
	return false
}

// releaseDrives has the guest keep only the bundle mounts in keep, unmounting the rest, and answers which bundle
// drives a file system is still mounted from (held), with why. When that isn't known (the call failed, or the guest
// agent predates the answer and unmounted lazily), every drive is held: an image is never changed on a guess. A guest
// with no bundle mounts at all (404) holds none.
func (m *Manager) releaseDrives(ctx context.Context, s *sandbox, keep []guest.BundleMount) (held func(int) bool, why string) {
	answer, err := s.guest.MountBundles(ctx, keep)
	switch {
	case err != nil && guest.IsNotFound(err):
		return func(int) bool { return false }, ""
	case err != nil:
		m.log.Warn("unmounting bundles before their drives change", "sandbox", s.meta.ID, "error", err)
		return func(int) bool { return true }, "unmounting it failed: " + err.Error()
	case answer.Held == nil:
		return func(int) bool { return true }, "its guest agent can't say it was unmounted"
	}
	set := map[int]bool{}
	for _, i := range *answer.Held {
		set[i] = true
	}
	var reasons []string
	for path, reason := range answer.Unmounts {
		reasons = append(reasons, path+": "+reason)
	}
	sort.Strings(reasons)
	why = strings.Join(reasons, "; ")
	if why == "" {
		why = "something in the sandbox still has it mounted"
	}
	return func(i int) bool { return set[i] }, why
}

// imageBytes is the size of the file at bundle drive i.
func imageBytes(vm string, i int) int64 {
	info, err := os.Stat(filepath.Join(vm, bundleDriveFile(i)))
	if err != nil {
		return 0
	}
	return info.Size()
}

// setDrive points bundle drive i of a running sandbox at a bundle's image (digest), or at an empty file ("").
func (m *Manager) setDrive(ctx context.Context, s *sandbox, i int, digest string) error {
	file := filepath.Join(s.vmDir(), bundleDriveFile(i))
	if digest == "" {
		tmp := file + ".new"
		if err := os.WriteFile(tmp, nil, 0o600); err != nil {
			return err
		}
		if err := os.Rename(tmp, file); err != nil {
			return err
		}
	} else if _, _, err := m.cfg.Bundles.Link(ctx, digest, file, m.fetchFor(s.meta.ID)); err != nil {
		return err
	}
	return s.machine.UpdateDrive(ctx, bundleDriveID(i), bundleDriveFile(i))
}

// finishBundles attaches a sandbox's pending bundles once their images are built, and tells the control plane.
// It runs in the background: callers may hold s.mu.
func (m *Manager) finishBundles(s *sandbox) {
	if m.cfg.Bundles == nil {
		return
	}
	go func() {
		s.mu.Lock()
		var digests []string
		for _, st := range s.meta.MountStatus {
			if st.State != proto.MountPending {
				continue
			}
			for _, mt := range bundleMounts(s) {
				if mt.Path == st.Path {
					digests = append(digests, mt.Digest)
				}
			}
		}
		// Reserved before the wait, whoever started this (a create's or resume's pending mount, reserved already, or
		// one adopt() found after a restart, not yet): kept until attachBundles links them or the sandbox gives them up.
		for _, digest := range digests {
			m.reserveBundle(s, digest)
		}
		id := s.meta.ID
		s.mu.Unlock()
		if len(digests) == 0 {
			return
		}
		for _, digest := range digests {
			// The build carries on whoever waits; an error is the mount's, found again by attachBundles.
			_, _ = m.cfg.Bundles.Get(context.Background(), digest, m.fetchFor(id))
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.meta.State != proto.StateRunning || s.machine == nil || s.guest == nil {
			// Stopped or gone meanwhile: its next start or resume reserves them again.
			m.releaseBundles(s, nil)
			return
		}
		if !anyPending(s.meta.MountStatus) {
			// Another finish (from a later boot, or this one's before it) attached them already.
			m.releaseBundles(s, nil)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		pending := m.attachBundles(ctx, s, time.Second)
		_ = m.writeMeta(s)
		if m.cfg.MountEvents != nil {
			m.cfg.MountEvents(m.info(s))
		}
		if pending {
			m.finishBundles(s)
		}
	}()
}

// bundleWait is how long a call waits for bundle images.
func (m *Manager) bundleWait() time.Duration {
	if m.cfg.BundleWait > 0 {
		return m.cfg.BundleWait
	}
	return DefaultBundleWait
}
