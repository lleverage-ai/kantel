package microvm

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A stopped sandbox with a disk of a few blocks, on a Manager with no machines.
func stoppedSandbox(t *testing.T) (*Manager, *sandbox) {
	t.Helper()
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root}, log: slog.New(slog.NewTextHandler(io.Discard, nil)), sandboxes: map[string]*sandbox{}}
	s := &sandbox{dir: filepath.Join(root, "sandboxes", "sbx_disk")}
	s.meta.ID, s.meta.State = "sbx_disk", proto.StateStopped
	if err := os.MkdirAll(s.vmDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.vmDir(), fc.DiskFile), bytes.Repeat([]byte("d"), 1<<16), 0o600); err != nil {
		t.Fatal(err)
	}
	m.sandboxes[s.meta.ID] = s
	return m, s
}

func absent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("%s is still there: %v", path, err)
	}
}

func present(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("%s went: %v", path, err)
	}
}

// A snapshot whose record can't be written (a full disk, here a directory where its temporary file goes) leaves no
// copy of the disk behind: nothing that lists snapshots would ever find it to delete.
func TestSaveSnapshotRemovesItsCopyWhenItsRecordFails(t *testing.T) {
	m, s := stoppedSandbox(t)
	snap := proto.SnapshotInfo{ID: "snap_full", SandboxID: s.meta.ID, Kind: "saved"}
	sdir := m.snapshotDir(snap.ID)
	if err := os.MkdirAll(filepath.Join(sdir, "meta.json.tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := m.saveSnapshot(s, &snap, false); err == nil {
		t.Fatal("a snapshot whose record failed was saved")
	}
	absent(t, sdir)
	present(t, filepath.Join(s.vmDir(), fc.DiskFile))

	// With room for its record, the same save is a snapshot.
	if err := m.saveSnapshot(s, &snap, false); err != nil {
		t.Fatal(err)
	}
	if _, err := m.readSnapshot(snap.ID); err != nil {
		t.Fatal(err)
	}
}

// A stop's snapshot on a disk with less free than its copy and the headroom is refused before anything is copied, and
// says why; the sandbox keeps its own disk. With room, it is taken.
func TestStopSnapshotNeedsRoom(t *testing.T) {
	m, s := stoppedSandbox(t)
	free := uint64(snapshotHeadroom)
	m.statfs = func(_ string, st *syscall.Statfs_t) error {
		st.Bsize, st.Bavail = 1, free
		return nil
	}
	snap := proto.SnapshotInfo{ID: "snap_auto", SandboxID: s.meta.ID, Kind: "auto"}
	err := m.saveSnapshot(s, &snap, true)
	var perr *proto.Error
	if !errors.As(err, &perr) || perr.Code != proto.ErrCapacity {
		t.Fatalf("a stop's snapshot with no room: %v, want a capacity error", err)
	}
	absent(t, m.snapshotDir(snap.ID))
	present(t, filepath.Join(s.vmDir(), fc.DiskFile))
	// A saved snapshot is the user's ask, not the stop's: it isn't measured.
	saved := proto.SnapshotInfo{ID: "snap_saved", SandboxID: s.meta.ID, Kind: "saved"}
	if err := m.saveSnapshot(s, &saved, false); err != nil {
		t.Fatal(err)
	}

	free = snapshotHeadroom + 1<<30
	if err := m.saveSnapshot(s, &snap, true); err != nil {
		t.Fatal(err)
	}
	if _, err := m.readSnapshot(snap.ID); err != nil {
		t.Fatal(err)
	}
}

// When the host starts, sandbox and snapshot directories with no record are deleted; one whose record doesn't decode is kept
// (without following their links); published ones, and anything that isn't a directory with an ID's name, stay.
func TestReapUnpublished(t *testing.T) {
	m, _ := stoppedSandbox(t)
	root := m.cfg.Root
	mkdir := func(path string) string {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
		return path
	}
	write := func(path string, data []byte) {
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// What the unpublished ones link to: an image, a spooled memory file, a directory outside.
	outside := mkdir(filepath.Join(root, "outside"))
	image := filepath.Join(outside, "sandbox.ext4")
	write(image, []byte("image"))
	spooled := filepath.Join(outside, "mem")
	write(spooled, []byte("mem"))

	// A create cut short after its disk was copied: no record.
	copied := mkdir(filepath.Join(root, "sandboxes", "sbx_copied", "vm"))
	write(filepath.Join(copied, fc.DiskFile), []byte("disk"))
	if err := os.Symlink(image, filepath.Join(copied, fc.RootfsFile)); err != nil {
		t.Fatal(err)
	}
	// A record that doesn't decode: kept, as it may be an older host's torn record of a sandbox's only disk.
	torn := mkdir(filepath.Join(root, "sandboxes", "sbx_torn"))
	write(filepath.Join(torn, "meta.json"), []byte(`{"id": "sbx_to`))
	// A published sandbox (stoppedSandbox's, given its record).
	raw, _ := json.Marshal(meta{ID: "sbx_disk", State: proto.StateStopped})
	write(filepath.Join(root, "sandboxes", "sbx_disk", "meta.json"), raw)
	// A live snapshot cut short: its memory spooled (a link), its disk copied, no record.
	capture := mkdir(filepath.Join(root, "snapshots", "snap_capture"))
	write(filepath.Join(capture, fc.DiskFile), []byte("disk"))
	if err := os.Symlink(spooled, filepath.Join(capture, "mem")); err != nil {
		t.Fatal(err)
	}
	// A published snapshot.
	published := mkdir(filepath.Join(root, "snapshots", "snap_published"))
	raw, _ = json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: "snap_published", SandboxID: "sbx_disk", Kind: "saved"}})
	write(filepath.Join(published, "meta.json"), raw)
	// Not the host's to remove: a link to a directory with no record, a file, a name no ID has.
	if err := os.Symlink(outside, filepath.Join(root, "snapshots", "snap_link")); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(root, "snapshots", "snap_file"), nil)
	odd := mkdir(filepath.Join(root, "snapshots", "not.an.id"))

	m.reapUnpublished()

	absent(t, filepath.Join(root, "sandboxes", "sbx_copied"))
	present(t, filepath.Join(torn, "meta.json"))
	absent(t, capture)
	present(t, filepath.Join(root, "sandboxes", "sbx_disk", "vm", fc.DiskFile))
	present(t, filepath.Join(published, "meta.json"))
	for _, kept := range []string{image, spooled, filepath.Join(root, "snapshots", "snap_link"), filepath.Join(root, "snapshots", "snap_file"), odd} {
		present(t, kept)
	}
}

// A copy where the file system has no reflinks (here a cp that refuses them, after leaving a part-written file it can't
// write over) falls back to a sparse copy of the whole disk.
func TestCopySparseFallsBackFromAReflink(t *testing.T) {
	realCp, err := exec.LookPath("cp")
	if err != nil {
		t.Skip("no cp")
	}
	bin := t.TempDir()
	log := filepath.Join(bin, "log")
	script := "#!/bin/sh\necho \"$1\" >> " + log + "\nif [ \"$1\" = --reflink=always ]; then\n  for last; do :; done\n  echo partial > \"$last\"\n  chmod 400 \"$last\"\n  exit 1\nfi\nexec " + realCp + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "cp"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	dir := t.TempDir()
	src, dst := filepath.Join(dir, "src.ext4"), filepath.Join(dir, "dst.ext4")
	data := bytes.Repeat([]byte("disk"), 1<<12)
	if err := os.WriteFile(src, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copySparse(src, dst); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dst)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("the copy differs from its disk (%v)", err)
	}
	tried, _ := os.ReadFile(log)
	if string(tried) != "--reflink=always\n--sparse=always\n" {
		t.Fatalf("cp ran as %q, want a reflink then a sparse copy", tried)
	}
	if err := copySparse(filepath.Join(dir, "missing"), filepath.Join(dir, "none")); err == nil {
		t.Fatal("copying a missing disk worked")
	}
}

// Whichever copy the file system takes (a reflink or a sparse copy), a disk's holes stay holes.
func TestCopySparseKeepsHoles(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "src.ext4"), filepath.Join(dir, "dst.ext4")
	f, err := os.Create(src)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte("start"), 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte("end"), 64<<20); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	if diskUsage(src) >= 64<<20 {
		t.Skip("this file system doesn't keep holes")
	}
	if err := copySparse(src, dst); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(src)
	b, _ := os.ReadFile(dst)
	if !bytes.Equal(a, b) {
		t.Fatal("the copy differs from its disk")
	}
	if diskUsage(dst) >= 64<<20 {
		t.Fatalf("the copy takes %d bytes: its holes were filled", diskUsage(dst))
	}
}

// Stops' snapshots copying at once share the free space: one let through reserves its copy until it is done, so a
// second can't be let through against space the first is about to take, and a failed copy gives its reservation back.
func TestStopSnapshotsReserveTheirRoom(t *testing.T) {
	m, s := stoppedSandbox(t)
	disk := filepath.Join(s.vmDir(), fc.DiskFile)
	if err := os.WriteFile(disk, make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	size := diskUsage(disk)
	if size <= 0 {
		t.Skip("no allocated blocks to measure on this file system")
	}
	// Room for one copy and its headroom, not two.
	m.statfs = func(_ string, st *syscall.Statfs_t) error {
		st.Bsize, st.Bavail = 1, uint64(snapshotHeadroom+size+size/2)
		return nil
	}
	first, err := m.roomForSnapshot(s, disk)
	if err != nil {
		t.Fatalf("the first: %v", err)
	}
	var perr *proto.Error
	if _, err := m.roomForSnapshot(s, disk); !errors.As(err, &perr) || perr.Code != proto.ErrCapacity {
		t.Fatalf("a second while the first copies: %v, want a capacity error", err)
	}
	first()
	first() // once only
	second, err := m.roomForSnapshot(s, disk)
	if err != nil {
		t.Fatalf("once the first is done: %v", err)
	}
	second()
	if m.snapshotReserved != 0 {
		t.Fatalf("%d bytes still reserved", m.snapshotReserved)
	}

	// A copy that fails (its source gone) gives its room back.
	broken := proto.SnapshotInfo{ID: "snap_broken", SandboxID: s.meta.ID, Kind: "auto"}
	if err := os.Remove(disk); err != nil {
		t.Fatal(err)
	}
	if err := m.saveSnapshot(s, &broken, true); err == nil {
		t.Fatal("a copy of a missing disk succeeded")
	}
	absent(t, m.snapshotDir(broken.ID))
	if m.snapshotReserved != 0 {
		t.Fatalf("a failed copy left %d bytes reserved", m.snapshotReserved)
	}
}
