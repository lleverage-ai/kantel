package microvm

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A snapshot taken or saved by hand that would leave the host less than snapshotHeadroom free is refused, saying how
// much is free, before anything is written; with room, it is taken, and its reservation given back once it is.
func TestSaveSnapshotNeedsRoom(t *testing.T) {
	m, s := stoppedSandbox(t)
	size := diskUsage(filepath.Join(s.vmDir(), fc.DiskFile))
	free := int64(snapshotHeadroom) + size - 1
	m.statfs = func(_ string, st *syscall.Statfs_t) error {
		st.Bsize, st.Bavail = 1, uint64(free)
		return nil
	}
	_, err := m.SaveSnapshot(context.Background(), proto.SnapshotParams{SandboxID: s.meta.ID, SnapshotID: "snap_1", Name: "kept"})
	var refused *proto.Error
	if !errors.As(err, &refused) || refused.Code != proto.ErrCapacity {
		t.Fatalf("a snapshot without room: %v", err)
	}
	if !strings.Contains(refused.Message, "of disk free") || !strings.Contains(refused.Message, "must leave 10.0 GiB free") {
		t.Fatalf("the refusal doesn't say how much is free: %q", refused.Message)
	}
	absent(t, m.snapshotDir("snap_1"))

	free = int64(snapshotHeadroom) + size + 1<<20
	snap, err := m.SaveSnapshot(context.Background(), proto.SnapshotParams{SandboxID: s.meta.ID, SnapshotID: "snap_1", Name: "kept"})
	if err != nil {
		t.Fatal(err)
	}
	present(t, filepath.Join(m.snapshotDir(snap.ID), fc.DiskFile))
	if m.snapshotReserved != 0 {
		t.Fatalf("%d bytes still reserved after the save", m.snapshotReserved)
	}
}

// Memory still in the RAM spool is on its way to the disk: a snapshot's room is judged with it counted as taken.
func TestSnapshotRoomCountsSpooledMemory(t *testing.T) {
	m, s := stoppedSandbox(t)
	size := diskUsage(filepath.Join(s.vmDir(), fc.DiskFile))
	m.statfs = func(_ string, st *syscall.Statfs_t) error {
		st.Bsize, st.Bavail = 1, uint64(int64(snapshotHeadroom)+size+(1<<20))
		return nil
	}
	m.spool = testSpool(t)
	release, err := m.roomToSave(s, false)
	if err != nil {
		t.Fatalf("with room: %v", err)
	}
	release()
	// A live fork's memory, mapped and cancelled, never written to the disk: it takes no room there.
	if m.spool.reserve(2<<20) == "" {
		t.Fatal("the spool took nothing")
	}
	release, err = m.roomToSave(s, false)
	if err != nil {
		t.Fatalf("with a live fork's memory in RAM: %v", err)
	}
	release()
	// A stop's memory, placed for the disk: it does.
	placeSpooled(t, m.spool, 2<<20)
	var refused *proto.Error
	if _, err := m.roomToSave(s, false); !errors.As(err, &refused) || refused.Code != proto.ErrCapacity {
		t.Fatalf("with 2 MiB of memory still in RAM: %v, want a capacity error", err)
	}
}

// A flush that finishes between the spool's read and the file system's is counted in both, never in neither: the
// spool is read first, so admission errs towards refusing.
func TestSnapshotRoomReadsTheSpoolFirst(t *testing.T) {
	m, s := stoppedSandbox(t)
	size := diskUsage(filepath.Join(s.vmDir(), fc.DiskFile))
	m.spool = testSpool(t)
	spooled := placeSpooled(t, m.spool, 2<<20)
	// The file system as measured before the flush, room for the copy alone; the flush finishes as it is measured.
	m.statfs = func(_ string, st *syscall.Statfs_t) error {
		st.Bsize, st.Bavail = 1, uint64(int64(snapshotHeadroom)+size+(1<<20))
		m.spool.mu.Lock()
		delete(m.spool.targets, spooled)
		m.spool.release(spooled)
		m.spool.mu.Unlock()
		return nil
	}
	var refused *proto.Error
	if _, err := m.roomToSave(s, false); !errors.As(err, &refused) || refused.Code != proto.ErrCapacity {
		t.Fatalf("a flush finishing as the disk is measured let it through: %v", err)
	}
}

// testSpool is a spool with no worker: what is placed stays queued, still in RAM.
func testSpool(t *testing.T) *spool {
	t.Helper()
	return &spool{dir: t.TempDir(), max: 1 << 30, targets: map[string][]string{}, charged: map[string]int64{}, queue: make(chan string, 16)}
}

// placeSpooled reserves n bytes of the spool and places them for the disk, as a stop's memory is.
func placeSpooled(t *testing.T, sp *spool, n int64) string {
	t.Helper()
	path := sp.reserve(n)
	if path == "" {
		t.Fatal("the spool took nothing")
	}
	if err := sp.place(path, filepath.Join(t.TempDir(), "mem")); err != nil {
		t.Fatal(err)
	}
	return path
}

// The room a live save reserves is measured once the machine is paused: a disk grown by the guest's last flush before
// the pause is measured as it is, one that no longer fits is refused, the machine is resumed, and nothing stays
// reserved.
func TestSnapshotRoomIsReservedOncePaused(t *testing.T) {
	m, s := stoppedSandbox(t)
	disk := filepath.Join(s.vmDir(), fc.DiskFile)
	size := diskUsage(disk)
	m.statfs = func(_ string, st *syscall.Statfs_t) error {
		st.Bsize, st.Bavail = 1, uint64(int64(snapshotHeadroom)+size+(1<<20))
		return nil
	}
	// The early check passes on the disk as it was.
	early, err := m.roomToSave(s, false)
	if err != nil {
		t.Fatalf("the early check: %v", err)
	}
	early()
	// The sync before the pause grows it past the room.
	if err := os.WriteFile(disk, make([]byte, 4<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	paused, resumed := false, false
	pause := func() (func() error, error) {
		paused = true
		return func() error { resumed = true; return nil }, nil
	}
	settled := false
	barrier := func() error {
		if !paused {
			t.Fatal("the barrier came before the pause")
		}
		settled = true
		return nil
	}
	_, _, err = pausedForCopy(pause, barrier, func() (func(), error) {
		if !settled {
			t.Fatal("the room was measured before the barrier")
		}
		return m.roomToSave(s, false)
	})
	var refused *proto.Error
	if !errors.As(err, &refused) || refused.Code != proto.ErrCapacity {
		t.Fatalf("a disk grown past the room before the pause: %v, want a capacity error", err)
	}
	if !resumed {
		t.Fatal("the machine was left paused")
	}
	if m.snapshotReserved != 0 {
		t.Fatalf("%d bytes still reserved", m.snapshotReserved)
	}
	// With room, it is reserved until released.
	if err := os.WriteFile(disk, make([]byte, 64<<10), 0o600); err != nil {
		t.Fatal(err)
	}
	resume, release, err := pausedForCopy(pause, barrier, func() (func(), error) { return m.roomToSave(s, false) })
	if err != nil || m.snapshotReserved == 0 {
		t.Fatalf("with room: %v, %d reserved", err, m.snapshotReserved)
	}
	release()
	_ = resume()
	if m.snapshotReserved != 0 {
		t.Fatalf("%d bytes still reserved once released", m.snapshotReserved)
	}
}

// A barrier that fails is a failed save: the machine is resumed, and nothing is reserved.
func TestSnapshotRoomFailsWithItsBarrier(t *testing.T) {
	m, s := stoppedSandbox(t)
	resumed := false
	pause := func() (func() error, error) { return func() error { resumed = true; return nil }, nil }
	_, _, err := pausedForCopy(pause, func() error { return errors.New("no answer") }, func() (func(), error) {
		t.Fatal("measured after a failed barrier")
		return nil, nil
	})
	if err == nil || !resumed || m.snapshotReserved != 0 {
		t.Fatalf("a failed barrier: %v, resumed %v, %d reserved", err, resumed, m.snapshotReserved)
	}
	_ = s
}

// A snapshot copies a sandbox's sticky drives with its disk: its reservation counts them all together, and is given
// back once the snapshot is taken.
func TestSnapshotRoomCountsStickyDrives(t *testing.T) {
	m, s := stoppedSandbox(t)
	s.meta.StickyDrives = 2
	s.meta.StickyDisks = []stickyDisk{{DiskID: "ci", Path: "/ci", Slot: 0, State: proto.StickyMounted}, {DiskID: "docker", Path: "/docker", Slot: 1, State: proto.StickyMounted}}
	for k, n := range []int{1 << 17, 1 << 18} {
		if err := os.WriteFile(filepath.Join(s.vmDir(), stickyDriveFile(k)), bytes.Repeat([]byte("s"), n), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	size := diskUsage(filepath.Join(s.vmDir(), fc.DiskFile)) + stickyUsage(s)
	if size <= diskUsage(filepath.Join(s.vmDir(), fc.DiskFile))+(1<<18) {
		t.Fatalf("the sticky drives aren't counted: %d", size)
	}
	free := int64(snapshotHeadroom) + size - 1
	m.statfs = func(_ string, st *syscall.Statfs_t) error {
		st.Bsize, st.Bavail = 1, uint64(free)
		return nil
	}
	var refused *proto.Error
	if _, err := m.SaveSnapshot(context.Background(), proto.SnapshotParams{SandboxID: s.meta.ID, SnapshotID: "snap_1", Name: "kept"}); !errors.As(err, &refused) || refused.Code != proto.ErrCapacity {
		t.Fatalf("room for the disk but not its sticky drives: %v", err)
	}
	if _, err := m.roomForSnapshot(s, filepath.Join(s.vmDir(), fc.DiskFile)); !errors.As(err, &refused) || refused.Code != proto.ErrCapacity {
		t.Fatalf("a stop's snapshot, room for the disk but not its sticky drives: %v", err)
	}
	free = int64(snapshotHeadroom) + size
	snap, err := m.SaveSnapshot(context.Background(), proto.SnapshotParams{SandboxID: s.meta.ID, SnapshotID: "snap_1", Name: "kept"})
	if err != nil {
		t.Fatal(err)
	}
	present(t, filepath.Join(m.snapshotDir(snap.ID), stickyDriveFile(1)))
	if m.snapshotReserved != 0 {
		t.Fatalf("%d bytes still reserved after the save", m.snapshotReserved)
	}
}

// A sticky disk's full copy (no reflinks) reserves its room beside the other copies under way, so two never count the
// same free space, and refuses one that would eat the headroom; it gives the room back whether it worked or not, in
// an attach's or a create's copy (cloneStickyFile) and a commit's (cloneWithin).
func TestStickyFullCopiesReserveRoom(t *testing.T) {
	m, _ := stoppedSandbox(t)
	dir := t.TempDir()
	if canReflink(dir) {
		t.Skip("this file system has reflinks: no full copy to reserve for")
	}
	src := filepath.Join(dir, "v1.img")
	if err := os.WriteFile(src, bytes.Repeat([]byte("v"), 1<<18), 0o600); err != nil {
		t.Fatal(err)
	}
	size := diskUsage(src)
	free := int64(snapshotHeadroom) + size - 1
	m.statfs = func(_ string, st *syscall.Statfs_t) error {
		st.Bsize, st.Bavail = 1, uint64(free)
		return nil
	}
	capacity := func(err error) bool {
		var pe *proto.Error
		return errors.As(err, &pe) && pe.Code == proto.ErrCapacity
	}
	dst := filepath.Join(dir, "clone")
	if _, err := m.cloneStickyFile(src, dst); !capacity(err) || fileExists(dst) {
		t.Fatalf("a copy without room: %v", err)
	}
	deadline := time.Now().Add(time.Minute)
	if err := cloneWithin(context.Background(), src, dst, deadline, m.reserveStickyCopy); !capacity(err) || fileExists(dst) {
		t.Fatalf("a commit's copy without room: %v", err)
	}

	// Room for one copy, not two: the second can't have the first's.
	free = int64(snapshotHeadroom) + size + size/2
	held, err := m.reserveStickyCopy(src)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.cloneStickyFile(src, dst); !capacity(err) {
		t.Fatalf("a second copy in the first's room: %v", err)
	}
	held()
	if _, err := m.cloneStickyFile(src, dst); err != nil {
		t.Fatal(err)
	}
	if err := cloneWithin(context.Background(), src, dst+"2", deadline, m.reserveStickyCopy); err != nil {
		t.Fatal(err)
	}
	// A copy that fails (nowhere to write it) gives its room back too.
	if _, err := m.cloneStickyFile(src, filepath.Join(dir, "gone", "clone")); err == nil {
		t.Fatal("a copy into a missing directory")
	}
	if m.snapshotReserved != 0 {
		t.Fatalf("%d bytes still reserved", m.snapshotReserved)
	}
}
