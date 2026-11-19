package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// stagedRootfs is the root filesystem and base the record a fetch staged names.
func stagedRootfs(t *testing.T, m *Manager, id string) (rootfs, base string) {
	t.Helper()
	raw, err := os.ReadFile(m.stagedSnapshotPath(id))
	if err != nil {
		t.Fatal(err)
	}
	var staged snapshotMeta
	if err := json.Unmarshal(raw, &staged); err != nil {
		t.Fatal(err)
	}
	return staged.Rootfs, staged.Base
}

// withInstalledVersions has m say its installed versions are old and new, as images.Store.SandboxImages does.
func withInstalledVersions(m *Manager) {
	m.cfg.HostImages = func() []string { return []string{versionFile(m, "old"), versionFile(m, "new")} }
}

func setDigest(t *testing.T, path, sum string) {
	t.Helper()
	if err := os.WriteFile(path+".sha256-source", []byte(sum), 0o644); err != nil {
		t.Fatal(err)
	}
}

func recordOf(s snapshotMeta) []byte {
	raw, _ := json.Marshal(s)
	return raw
}

// A snapshot taken on a host whose image isn't versioned (Rootfs a plain file, its runtime `image=sha256:...`) is
// taken by a host on versioned images that has the same bytes under a version, whatever the version is called: as on
// aaw-hel1 on 19 Nov 2026, which refused it because only its own Rootfs, by its whole runtime image, was compared. A
// host that has the bytes nowhere refuses it at once, without asking for a version to download.
func TestSnapshotOverAnUnversionedImageFindsItByDigest(t *testing.T) {
	ctx := context.Background()
	b, asked := snapshotSyncHost(t)
	withInstalledVersions(b)
	sum := strings.Repeat("78", 32)
	plain := snapshotMeta{
		Size: "default", Rootfs: "/var/lib/kantel-host/images/sandbox.ext4",
	}
	plain.ID, plain.SandboxID, plain.Kind, plain.Tier = "snap1", "sb1", "saved", Tier
	plain.Runtime = "firecracker=v1.17.0;kernel=6.1.102+0;image=sha256:" + sum[:16] + ";sticky=4"

	err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(plain))
	if !errors.Is(err, ErrNoSnapshotImage) || !strings.Contains(err.Error(), "isn't versioned") {
		t.Fatalf("an image this host has nowhere: %v", err)
	}
	if len(*asked) != 0 {
		t.Fatalf("asked for versions %v of an image that has none", *asked)
	}

	// The same bytes as an older version here, not the current one.
	setDigest(t, versionFile(b, "old"), sum)
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(plain)); err != nil {
		t.Fatalf("the same image under a version: %v", err)
	}
	if rootfs, base := stagedRootfs(t, b, "snap1"); rootfs != versionFile(b, "old") || base != "old" {
		t.Fatalf("staged over %s (base %q), want the old version's file", rootfs, base)
	}
	if len(*asked) != 0 {
		t.Fatalf("asked for versions %v though the image was here", *asked)
	}
	b.DiscardSnapshotPartial("snap1", SnapshotDisk)

	// The current version's: found through Rootfs, resolved, so a later update doesn't move it, even with no versions
	// listed.
	setDigest(t, versionFile(b, "old"), strings.Repeat("0a", 32))
	setDigest(t, versionFile(b, "new"), sum)
	b.cfg.HostImages = nil
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(plain)); err != nil {
		t.Fatalf("the same image as the current version: %v", err)
	}
	if rootfs, base := stagedRootfs(t, b, "snap1"); rootfs != versionFile(b, "new") || base != "new" {
		t.Fatalf("staged over %s (base %q), want the current version's file", rootfs, base)
	}
	b.DiscardSnapshotPartial("snap1", SnapshotDisk)
	// Without pinned versions too: the file checked is the file staged, never the link an activation repoints.
	b.cfg.PinBase = false
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(plain)); err != nil {
		t.Fatal(err)
	}
	if rootfs, _ := stagedRootfs(t, b, "snap1"); rootfs != versionFile(b, "new") {
		t.Fatalf("staged over %s, want the current version's file, not the link to it", rootfs)
	}
	b.DiscardSnapshotPartial("snap1", SnapshotDisk)

	// A record that names a version by its path and this image by its runtime, without saying which its files are over
	// (RootfsImage, which an older host doesn't write): the two disagree, so it is refused at once, as a host that tells
	// the image by its path refuses it.
	c, asked := snapshotSyncHost(t)
	older := plain
	older.Rootfs = versionFile(b, "new")
	if err := c.PrepareSnapshotFetch(ctx, "snap1", recordOf(older)); !errors.Is(err, ErrNoSnapshotImage) || len(*asked) != 0 {
		t.Fatalf("an older host's record naming another image by its path: %v, asked %v", err, *asked)
	}
}

// A snapshot over a version is taken over whichever file here has its digest: its own version's first, then any
// other, before its version is downloaded; one whose name here is another image and whose bytes are nowhere is still
// refused once its download says so.
func TestSnapshotOverAVersionFindsItByDigest(t *testing.T) {
	ctx := context.Background()
	a, _ := snapshotSyncHost(t)
	b, asked := snapshotSyncHost(t)
	withInstalledVersions(b)
	snap := saveTestSnapshot(t, a, "snap1", "old", false)

	// Here as itself: no download.
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(snap)); err != nil {
		t.Fatal(err)
	}
	if rootfs, _ := stagedRootfs(t, b, "snap1"); rootfs != versionFile(b, "old") || len(*asked) != 0 {
		t.Fatalf("staged over %s, asked %v", rootfs, *asked)
	}
	b.DiscardSnapshotPartial("snap1", SnapshotDisk)

	// Its bytes here under another version's name, and its own name here another image: the bytes win.
	setDigest(t, versionFile(b, "old"), strings.Repeat("cd", 32))
	setDigest(t, versionFile(b, "new"), strings.Repeat("0a", 32))
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(snap)); err != nil {
		t.Fatal(err)
	}
	if rootfs, base := stagedRootfs(t, b, "snap1"); rootfs != versionFile(b, "new") || base != "new" || len(*asked) != 0 {
		t.Fatalf("staged over %s (base %q), asked %v", rootfs, base, *asked)
	}
	b.DiscardSnapshotPartial("snap1", SnapshotDisk)

	// Its bytes nowhere: its version is asked for, and refused as another image.
	setDigest(t, versionFile(b, "new"), strings.Repeat("0b", 32))
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(snap)); !errors.Is(err, ErrNoSnapshotImage) || !slices.Equal(*asked, []string{"old"}) {
		t.Fatalf("another image under its name: %v, asked %v", err, *asked)
	}

	// Two versions with its bytes: its own is taken, so it boots its own version's kernel.
	setDigest(t, versionFile(b, "old"), strings.Repeat("0a", 32))
	setDigest(t, versionFile(b, "new"), strings.Repeat("0a", 32))
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(snap)); err != nil {
		t.Fatal(err)
	}
	if rootfs, _ := stagedRootfs(t, b, "snap1"); rootfs != versionFile(b, "old") {
		t.Fatalf("staged over %s, want its own version's file", rootfs)
	}
}

// A copy held over another version with the same bytes keeps that file, but serves the record its holder had: a peer
// that tells the image by its path (without FeatureSnapshotImageDigest) reads the snapshot's own version, and one
// without the bytes downloads that version, not the copy's host's name for it.
func TestACopyServesItsSnapshotsOwnRootfs(t *testing.T) {
	ctx := context.Background()
	a, _ := snapshotSyncHost(t)
	b, _ := snapshotSyncHost(t)
	c, asked := snapshotSyncHost(t)
	snap := saveTestSnapshot(t, a, "snap1", "old", false)
	if snap.RootfsImage = a.pathImage(snap.Rootfs); snap.RootfsImage != "old@sha256:0a0a0a0a0a0a0a0a" {
		t.Fatalf("a save over old records %q", snap.RootfsImage)
	}
	if err := a.mapSnapshot(ctx, "snap1"); err != nil {
		t.Fatal(err)
	}
	b.cfg.HostImages = func() []string { return []string{versionFile(b, "new")} }
	setDigest(t, versionFile(b, "old"), strings.Repeat("cd", 32))
	setDigest(t, versionFile(b, "new"), strings.Repeat("0a", 32))
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(snap)); err != nil {
		t.Fatal(err)
	}
	if err := fetchTestVersion(t, a, b, "snap1", SnapshotDisk); err != nil {
		t.Fatal(err)
	}
	held, ok := b.savedSnapshot("snap1")
	if !ok || held.Rootfs != versionFile(b, "new") || held.Base != "new" {
		t.Fatalf("the copy is held over %s (base %q), want new's file, which a prune then keeps", held.Rootfs, held.Base)
	}
	raw, err := b.ReadSnapshotFile("snap1", SnapshotDisk, SnapshotRecordFile)
	if err != nil {
		t.Fatal(err)
	}
	var served snapshotMeta
	if err := json.Unmarshal(raw, &served); err != nil {
		t.Fatal(err)
	}
	if served.Rootfs != snap.Rootfs || served.Base != "old" || served.SourceRootfs != "" ||
		served.RootfsImage != snap.RootfsImage || served.Runtime != snap.Runtime {
		t.Fatalf("served %s (base %q, source %q, image %q, runtime %q)", served.Rootfs, served.Base, served.SourceRootfs, served.RootfsImage, served.Runtime)
	}
	if err := c.PrepareSnapshotFetch(ctx, "snap1", raw); err != nil {
		t.Fatal(err)
	}
	if rootfs, _ := stagedRootfs(t, c, "snap1"); rootfs != versionFile(c, "old") || !slices.Equal(*asked, []string{"old"}) {
		t.Fatalf("staged over %s, asked %v", rootfs, *asked)
	}
}

// A rebase relinks a sandbox onto new before it boots, and a boot that fails leaves its runtime naming old: a snapshot
// of it then is over new, as its files say (RootfsImage), and a fetch takes it over new, never old. An older host's
// record of it, which doesn't say, is refused rather than taken over the image its runtime names.
func TestASnapshotAfterAFailedRebaseIsOverItsNewImage(t *testing.T) {
	ctx := context.Background()
	a, _ := snapshotSyncHost(t)
	b, asked := snapshotSyncHost(t)
	withInstalledVersions(b)
	dir := filepath.Join(a.cfg.Root, "sandboxes", "sbx_1")
	linkVM(t, filepath.Join(dir, "vm"), versionFile(a, "new"))
	s := &sandbox{dir: dir, meta: meta{ID: "sbx_1", State: proto.StateError, Runtime: a.portableRuntime(versionFile(a, "old"))}}
	if err := os.MkdirAll(a.snapshotDir("snap1"), 0o700); err != nil {
		t.Fatal(err)
	}
	info := proto.SnapshotInfo{ID: "snap1", SandboxID: "sbx_1", Kind: "saved", Tier: Tier}
	if err := a.writeSnapshotMeta(s, &info); err != nil {
		t.Fatal(err)
	}
	snap, err := a.readSnapshot("snap1")
	if err != nil {
		t.Fatal(err)
	}
	if snap.RootfsImage != "new@sha256:0b0b0b0b0b0b0b0b" || !strings.Contains(snap.Runtime, ";image=old@") {
		t.Fatalf("recorded image %q, runtime %q", snap.RootfsImage, snap.Runtime)
	}
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(snap)); err != nil {
		t.Fatal(err)
	}
	if rootfs, _ := stagedRootfs(t, b, "snap1"); rootfs != versionFile(b, "new") || len(*asked) != 0 {
		t.Fatalf("staged over %s, asked %v", rootfs, *asked)
	}
	b.DiscardSnapshotPartial("snap1", SnapshotDisk)

	older := snap
	older.RootfsImage = ""
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(older)); !errors.Is(err, ErrNoSnapshotImage) || len(*asked) != 0 {
		t.Fatalf("an older host's record of it: %v, asked %v", err, *asked)
	}
}

// A host whose root filesystem is a plain file with an unversioned snapshot's bytes, and a version installed with the
// same bytes, takes the snapshot over the file its runtime is the snapshot's: the version's runtime names the version,
// so its memory would never restore over it.
func TestAnAliasDoesNotDisplaceTheImageMemoryRestoresOver(t *testing.T) {
	ctx := context.Background()
	b, _ := snapshotSyncHost(t)
	withInstalledVersions(b)
	plain := filepath.Join(t.TempDir(), "sandbox.ext4")
	if err := os.WriteFile(plain, []byte("plain image"), 0o644); err != nil {
		t.Fatal(err)
	}
	b.cfg.Rootfs = plain
	setDigest(t, plain, strings.Repeat("0a", 32))
	snap := snapshotMeta{Size: "default", Rootfs: "/var/lib/kantel-host/images/sandbox.ext4"}
	snap.ID, snap.SandboxID, snap.Kind, snap.Tier, snap.Memory = "snap1", "sb1", "saved", Tier, true
	snap.CPU, snap.Runtime = b.CPU(), b.portableRuntime(plain)
	if !strings.Contains(snap.Runtime, ";image=sha256:0a0a0a0a0a0a0a0a;") {
		t.Fatalf("runtime %q", snap.Runtime)
	}
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(snap)); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(b.stagedSnapshotPath("snap1"))
	if err != nil {
		t.Fatal(err)
	}
	var staged snapshotMeta
	if err := json.Unmarshal(raw, &staged); err != nil {
		t.Fatal(err)
	}
	if staged.Rootfs != plain {
		t.Fatalf("staged over %s, want the plain file", staged.Rootfs)
	}
	if err := b.restoresMemoryOf(staged); err != nil {
		t.Fatalf("its memory: %v", err)
	}
}

// A sandbox made before its host pinned versions links the default path, so its snapshot's root filesystem names no
// version; its runtime does (the default path resolved), and that version is downloaded when no file here has it.
func TestSnapshotOverTheDefaultPathDownloadsItsRuntimesVersion(t *testing.T) {
	ctx := context.Background()
	a, _ := snapshotSyncHost(t)
	b, asked := snapshotSyncHost(t)
	snap := saveTestSnapshot(t, a, "snap1", "old", false)
	snap.Rootfs = a.cfg.Rootfs
	if !strings.Contains(snap.Runtime, ";image=old@sha256:0a0a0a0a0a0a0a0a;") {
		t.Fatalf("runtime %q", snap.Runtime)
	}
	// b has old installed, but doesn't list it, so only a download finds it.
	if err := b.PrepareSnapshotFetch(ctx, "snap1", recordOf(snap)); err != nil {
		t.Fatal(err)
	}
	if rootfs, base := stagedRootfs(t, b, "snap1"); rootfs != versionFile(b, "old") || base != "old" || !slices.Equal(*asked, []string{"old"}) {
		t.Fatalf("staged over %s (base %q), asked %v", rootfs, base, *asked)
	}
}

func TestImageDigestAndVersion(t *testing.T) {
	for _, c := range []struct{ image, version, digest string }{
		{"host-images-20261114@sha256:0123456789abcdef", "host-images-20261114", "sha256:0123456789abcdef"},
		{"sha256:78ca3a4ec2d4301c", "", "sha256:78ca3a4ec2d4301c"},
		{"", "", ""},
		{"sha256:", "", ""},
		{"../x@sha256:0123456789abcdef", "", "sha256:0123456789abcdef"},
		{"initial@", "initial", ""},
	} {
		if v, d := imageVersion(c.image), imageDigest(c.image); v != c.version || d != c.digest {
			t.Errorf("%q: version %q, digest %q; want %q, %q", c.image, v, d, c.version, c.digest)
		}
	}
}
