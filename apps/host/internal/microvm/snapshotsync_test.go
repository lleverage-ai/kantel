package microvm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// snapshotSyncHost is fingerprintHost with what a snapshot's sync needs: a log, and HostImage answering its own file of
// each version, counting the calls.
func snapshotSyncHost(t *testing.T) (*Manager, *[]string) {
	t.Helper()
	m := fingerprintHost(t)
	m.log = slog.New(slog.DiscardHandler)
	asked := &[]string{}
	m.cfg.HostImage = func(_ context.Context, version string) (string, error) {
		*asked = append(*asked, version)
		path := versionFile(m, version)
		if !fileExists(path) {
			return "", errors.New("no such version")
		}
		return path, nil
	}
	return m, asked
}

// saveTestSnapshot makes a saved snapshot in m's root, over version's image, with memory or not, as a save leaves it.
func saveTestSnapshot(t *testing.T, m *Manager, id, version string, memory bool) snapshotMeta {
	t.Helper()
	dir := m.snapshotDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	rootfs := versionFile(m, version)
	snap := snapshotMeta{
		SnapshotInfo: proto.SnapshotInfo{ID: id, SandboxID: "sb1", Kind: "saved", Name: "kept", Memory: memory, Tier: Tier,
			Base: version, CPU: m.CPU(), Runtime: m.portableRuntime(rootfs)},
		Size: "default", Rootfs: rootfs,
	}
	if err := os.WriteFile(filepath.Join(dir, fc.DiskFile), bytes.Repeat([]byte{1}, 2*blockmap.BlockSize+3), 0o600); err != nil {
		t.Fatal(err)
	}
	if memory {
		mem := append(make([]byte, blockmap.BlockSize), bytes.Repeat([]byte{2}, 100)...)
		if err := os.WriteFile(filepath.Join(dir, "mem"), mem, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "state"), []byte("machine state"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := json.Marshal(snap)
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return snap
}

// fetchTestVersion copies a version from one host to another as a peer fetch does: its partial written with the
// holder's bytes, then published with its map and small files.
func fetchTestVersion(t *testing.T, from, to *Manager, id, version string) error {
	t.Helper()
	path, err := to.SnapshotPartial(id, version)
	if err != nil {
		return err
	}
	src, raw, err := from.OpenSnapshot(id, version, true)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	data, _ := os.ReadFile(src.Name())
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	partial, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer partial.Close()
	files := map[string][]byte{}
	name := SnapshotRecordFile
	if version == SnapshotMemory {
		name = SnapshotStateFile
	}
	if b, err := from.ReadSnapshotFile(id, version, name); err == nil {
		files[name] = b
	}
	return to.PublishFetchedSnapshot(id, version, partial, raw, files)
}

func digestOf(held []proto.ObjectHolding, id, version string) string {
	for _, o := range held {
		for _, v := range o.Versions {
			if o.ObjectID == id && v.Version == version {
				return v.MapDigest
			}
		}
	}
	return ""
}

// A saved snapshot is served and listed once its files are mapped; an automatic one never is. Another host with the
// same CPU and runtime fetches its disk, over its own file of the image version, marked to cold-boot until its memory
// comes; then its memory and machine state, and a sandbox made from it there restores the memory.
func TestSnapshotSyncWithMatchingFingerprints(t *testing.T) {
	a, _ := snapshotSyncHost(t)
	b, asked := snapshotSyncHost(t)
	ctx := context.Background()
	saveTestSnapshot(t, a, "snap1", "old", true)
	auto := saveTestSnapshot(t, a, "auto1", "old", false)
	auto.Kind = "auto"
	raw, _ := json.Marshal(auto)
	_ = os.WriteFile(filepath.Join(a.snapshotDir("auto1"), "meta.json"), raw, 0o600)

	if _, _, err := a.OpenSnapshot("snap1", SnapshotDisk, true); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("served without a map: %v", err)
	}
	if got := a.SnapshotHoldings(); got == nil || len(got) != 0 {
		t.Fatalf("listed without maps: %+v", got)
	}
	for _, id := range []string{"snap1", "auto1"} {
		if err := a.mapSnapshot(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	held := a.SnapshotHoldings()
	if len(held) != 1 || held[0].ObjectID != "snap1" || len(held[0].Versions) != 2 || digestOf(held, "snap1", SnapshotDisk) == "" ||
		digestOf(held, "snap1", SnapshotMemory) == "" {
		t.Fatalf("holdings %+v", held)
	}
	if a.HoldsSnapshot("auto1", SnapshotDisk) || fileExists(filepath.Join(a.snapshotDir("auto1"), "disk.map")) {
		t.Fatal("an automatic snapshot is an object")
	}
	if _, err := a.ReadSnapshotFile("snap1", SnapshotDisk, "meta.json"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a file by its own name: %v", err)
	}

	// B: nothing to fetch into until the fetch is made ready.
	if _, err := b.SnapshotPartial("snap1", SnapshotDisk); err == nil {
		t.Fatal("a partial before the fetch was made ready")
	}
	record, err := a.ReadSnapshotFile("snap1", SnapshotDisk, SnapshotRecordFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.PrepareSnapshotFetch(ctx, "other", record); err == nil {
		t.Fatal("a record under another ID")
	}
	if err := b.PrepareSnapshotFetch(ctx, "snap1", record); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(*asked, []string{"old"}) {
		t.Fatalf("host images asked %v", *asked)
	}
	// The staged record keeps the version in use while the fetch goes on.
	if in, err := BasesUnder(b.cfg.Root); err != nil || !in["old"] {
		t.Fatalf("bases in use %v %v", in, err)
	}
	if got := b.SnapshotPartials(); !slices.Equal(got, [][2]string{{"snap1", SnapshotDisk}}) {
		t.Fatalf("partials %v", got)
	}
	if _, err := b.SnapshotPartial("snap1", SnapshotMemory); err == nil {
		t.Fatal("the memory's partial before the disk")
	}
	if err := fetchTestVersion(t, a, b, "snap1", SnapshotDisk); err != nil {
		t.Fatal(err)
	}
	copied, err := b.readSnapshot("snap1")
	if err != nil {
		t.Fatal(err)
	}
	if copied.Memory || !copied.ColdBoot || copied.Rootfs != versionFile(b, "old") || copied.Base != "old" {
		t.Fatalf("the copy's record %+v", copied)
	}
	if fileExists(b.snapshotFetchDir("snap1")) {
		t.Fatal("the fetch's directory left")
	}
	// Its memory is wanted: a fetch of it to go on with, should its first try fail.
	if got := b.SnapshotPartials(); !slices.Equal(got, [][2]string{{"snap1", SnapshotMemory}}) {
		t.Fatalf("partials once the disk is here %v", got)
	}
	if !b.HoldsSnapshot("snap1", SnapshotDisk) || b.HoldsSnapshot("snap1", SnapshotMemory) || !b.WantsSnapshotMemory("snap1") {
		t.Fatal("the copy's versions")
	}
	// Listed at once, with the holder's map: its disk alone.
	if got := b.SnapshotHoldings(); len(got) != 1 || len(got[0].Versions) != 1 || digestOf(got, "snap1", SnapshotDisk) != digestOf(held, "snap1", SnapshotDisk) {
		t.Fatalf("the copy's holdings %+v", got)
	}
	disk, _ := os.ReadFile(filepath.Join(b.snapshotDir("snap1"), fc.DiskFile))
	want, _ := os.ReadFile(filepath.Join(a.snapshotDir("snap1"), fc.DiskFile))
	if !bytes.Equal(disk, want) {
		t.Fatal("the copy's disk differs")
	}
	if err := fetchTestVersion(t, a, b, "snap1", SnapshotMemory); err != nil {
		t.Fatal(err)
	}
	copied, _ = b.readSnapshot("snap1")
	if !copied.Memory || copied.ColdBoot || b.WantsSnapshotMemory("snap1") || len(b.SnapshotPartials()) != 0 {
		t.Fatalf("with its memory: %+v", copied)
	}
	if state, _ := os.ReadFile(filepath.Join(b.snapshotDir("snap1"), "state")); string(state) != "machine state" {
		t.Fatalf("state %q", state)
	}
	bHeld := b.SnapshotHoldings()
	// B's is a copy, so Kantel deletes it at once should it no longer know the snapshot; A's is its own.
	if !bHeld[0].Versions[0].Copy || held[0].Versions[0].Copy {
		t.Fatalf("copies: B %+v, A %+v", bHeld, held)
	}
	for _, version := range []string{SnapshotDisk, SnapshotMemory} {
		if got := digestOf(bHeld, "snap1", version); got == "" || got != digestOf(held, "snap1", version) {
			t.Fatalf("%s's digest %q on B, %q on A", version, got, digestOf(held, "snap1", version))
		}
	}
	origin, err := b.startOf(ctx, proto.CreateParams{From: "snap1"}, DefaultSizes[1])
	if err != nil {
		t.Fatal(err)
	}
	origin.unhold()
	if origin.state != filepath.Join(b.snapshotDir("snap1"), "state") || origin.rootfs != versionFile(b, "old") {
		t.Fatalf("a create from the copy restores %+v", origin)
	}
	// Published again (a fetch's retry): kept as it is.
	if err := fetchTestVersion(t, a, b, "snap1", SnapshotMemory); err == nil {
		t.Fatal("a partial of memory the host has")
	}
	// Deleted, its fetch's directory goes too.
	if err := os.MkdirAll(b.snapshotFetchDir("snap1"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := b.DeleteSnapshot("snap1"); err != nil {
		t.Fatal(err)
	}
	if fileExists(b.snapshotDir("snap1")) || fileExists(b.snapshotFetchDir("snap1")) {
		t.Fatal("left after a delete")
	}
}

// A host whose CPU differs, or whose runtime does, fetches only the disk: its copy stays marked to cold-boot, its memory
// isn't asked for, and a sandbox made from it boots on its disk. So does a snapshot whose machine had bundle images or
// sticky disks on its drives.
func TestSnapshotMemoryOnlyWithMatchingFingerprints(t *testing.T) {
	ctx := context.Background()
	for name, change := range map[string]func(a, b *Manager){
		"another CPU": func(_, b *Manager) {
			cpu := testCPU
			cpu.FeaturesHash = "sha256:fedcba9876543210"
			b.cfg.CPU = &cpu
		},
		"another runtime": func(_, b *Manager) { b.cfg.FreePageReporting = true },
		"bundle images": func(a, _ *Manager) {
			snap, _ := a.readSnapshot("snap1")
			snap.BundleDrives, snap.BundleSlots = 1, []string{"sha256:1"}
			raw, _ := json.Marshal(snap)
			_ = os.WriteFile(filepath.Join(a.snapshotDir("snap1"), "meta.json"), raw, 0o600)
		},
	} {
		t.Run(name, func(t *testing.T) {
			a, _ := snapshotSyncHost(t)
			b, _ := snapshotSyncHost(t)
			saveTestSnapshot(t, a, "snap1", "old", true)
			change(a, b)
			if err := a.mapSnapshot(ctx, "snap1"); err != nil {
				t.Fatal(err)
			}
			record, _ := a.ReadSnapshotFile("snap1", SnapshotDisk, SnapshotRecordFile)
			if err := b.PrepareSnapshotFetch(ctx, "snap1", record); err != nil {
				t.Fatal(err)
			}
			if err := fetchTestVersion(t, a, b, "snap1", SnapshotDisk); err != nil {
				t.Fatal(err)
			}
			if b.WantsSnapshotMemory("snap1") {
				t.Fatal("its memory wanted")
			}
			if _, err := b.SnapshotPartial("snap1", SnapshotMemory); err == nil {
				t.Fatal("a partial of its memory")
			}
			copied, _ := b.readSnapshot("snap1")
			if copied.Memory || !copied.ColdBoot {
				t.Fatalf("the copy %+v", copied)
			}
			origin, err := b.startOf(ctx, proto.CreateParams{From: "snap1"}, DefaultSizes[1])
			if err != nil {
				t.Fatal(err)
			}
			origin.unhold()
			if origin.state != "" || origin.disk != filepath.Join(b.snapshotDir("snap1"), fc.DiskFile) {
				t.Fatalf("a create from the copy %+v", origin)
			}
		})
	}
}

// The root image a snapshot's disk is over is had first: a host image version this host doesn't have is refused when
// it can't be downloaded; a template's root filesystem is fetched from a peer; an unversioned host image is this
// host's only when their recorded digests say they are the same.
func TestSnapshotFetchNeedsItsRootImage(t *testing.T) {
	ctx := context.Background()
	a, _ := snapshotSyncHost(t)
	b, _ := snapshotSyncHost(t)
	snap := saveTestSnapshot(t, a, "snap1", "old", false)
	record := func(s snapshotMeta) []byte {
		raw, _ := json.Marshal(s)
		return raw
	}
	missing := snap
	missing.Rootfs = filepath.Join(filepath.Dir(filepath.Dir(snap.Rootfs)), "gone", "sandbox.ext4")
	if err := b.PrepareSnapshotFetch(ctx, "snap1", record(missing)); !errors.Is(err, ErrNoSnapshotImage) {
		t.Fatalf("a version that can't be had: %v", err)
	}
	// A version is the same image only by the digest it was downloaded with: one under its name here that differs, and
	// one whose digest its host never recorded (an image from before versions, named on that host alone), are refused.
	sidecar := filepath.Join(filepath.Dir(versionFile(b, "old")), "sandbox.ext4.sha256-source")
	good, _ := os.ReadFile(sidecar)
	_ = os.WriteFile(sidecar, []byte(strings.Repeat("cd", 32)), 0o644)
	if err := b.PrepareSnapshotFetch(ctx, "snap1", record(snap)); !errors.Is(err, ErrNoSnapshotImage) {
		t.Fatalf("another image under the version's name: %v", err)
	}
	_ = os.WriteFile(sidecar, good, 0o644)
	unrecorded := snap
	unrecorded.Runtime = ""
	if err := b.PrepareSnapshotFetch(ctx, "snap1", record(unrecorded)); !errors.Is(err, ErrNoSnapshotImage) {
		t.Fatalf("a version without a recorded digest: %v", err)
	}
	b.cfg.HostImage = nil
	if err := b.PrepareSnapshotFetch(ctx, "snap1", record(snap)); !errors.Is(err, ErrNoSnapshotImage) {
		t.Fatalf("without versioned images: %v", err)
	}
	if fileExists(b.stagedSnapshotPath("snap1")) {
		t.Fatal("staged though refused")
	}

	// A host image that isn't versioned: the same image only by its recorded digest.
	plain := snap
	plain.Rootfs = "/elsewhere/sandbox.ext4"
	plain.Runtime = "firecracker=v1.17.0;kernel=6.1.102+0;image=sha256:abababababababab;sticky=4"
	if err := b.PrepareSnapshotFetch(ctx, "snap1", record(plain)); !errors.Is(err, ErrNoSnapshotImage) {
		t.Fatalf("an image that can't be told: %v", err)
	}
	own := filepath.Join(t.TempDir(), "sandbox.ext4")
	_ = os.WriteFile(own, []byte("plain"), 0o644)
	_ = os.WriteFile(own+".sha256-source", []byte(strings.Repeat("ab", 32)), 0o644)
	b.cfg.Rootfs, b.cfg.PinBase = own, false
	if err := b.PrepareSnapshotFetch(ctx, "snap1", record(plain)); err != nil {
		t.Fatalf("the same image: %v", err)
	}
	raw, _ := os.ReadFile(b.stagedSnapshotPath("snap1"))
	var staged snapshotMeta
	_ = json.Unmarshal(raw, &staged)
	if staged.Rootfs != own || staged.Memory {
		t.Fatalf("staged %+v", staged)
	}
	b.DiscardSnapshotPartial("snap1", SnapshotDisk)
	if fileExists(b.snapshotFetchDir("snap1")) {
		t.Fatal("a discarded fetch's directory left")
	}

	// A template's root filesystem: fetched from a peer when the host hasn't it, and only the build the holder has,
	// which its record names by its map's digest.
	m, _ := testManager(t)
	key := templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}.key()
	build := func(data string) string {
		bm, _, err := blockmap.Make(ctx, writeTemp(t, data), nil)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := bm.MarshalBinary()
		return blockmap.Digest(raw)
	}
	tpl := snap
	tpl.Rootfs = filepath.Join("/var/lib/kantel-host/microvm/images/templates", key+".ext4")
	tpl.RootfsDigest = build("the holder's build")
	if err := m.PrepareSnapshotFetch(ctx, "snap1", record(tpl)); !errors.Is(err, ErrNoSnapshotImage) {
		t.Fatalf("a template's root filesystem, not fetched: %v", err)
	}
	var fetched []string
	fetchedData := "the holder's build"
	m.cfg.FetchRootfs = func(_ context.Context, k string) error {
		fetched = append(fetched, k)
		if err := os.MkdirAll(m.tpl.rootfs.dir, 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(m.tpl.rootfs.path(k), []byte(fetchedData), 0o600); err != nil {
			return err
		}
		return m.mapRootfs(ctx, k)
	}
	unnamed := tpl
	unnamed.RootfsDigest = ""
	if err := m.PrepareSnapshotFetch(ctx, "snap1", record(unnamed)); !errors.Is(err, ErrNoSnapshotImage) || len(fetched) != 0 {
		t.Fatalf("a record that doesn't say which build: %v, fetched %v", err, fetched)
	}
	if err := m.PrepareSnapshotFetch(ctx, "snap1", record(tpl)); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(m.stagedSnapshotPath("snap1"))
	_ = json.Unmarshal(raw, &staged)
	if !slices.Equal(fetched, []string{key}) || staged.Rootfs != m.tpl.rootfs.path(key) || staged.RootfsDigest != tpl.RootfsDigest {
		t.Fatalf("fetched %v, staged %+v", fetched, staged)
	}
	// Another build under the key, here already or fetched: refused.
	other := tpl
	other.ID, other.RootfsDigest = "snap2", build("another build")
	if err := m.PrepareSnapshotFetch(ctx, "snap2", record(other)); !errors.Is(err, ErrNoSnapshotImage) {
		t.Fatalf("another build: %v", err)
	}
}

func writeTemp(t *testing.T, data string) *os.File {
	t.Helper()
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// A snapshot's record says which build of a template's root filesystem its host has, by its map's digest, once it is
// mapped.
func TestSnapshotRecordNamesItsRootfsBuild(t *testing.T) {
	m, _ := testManager(t)
	key := templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}.key()
	if err := os.MkdirAll(m.tpl.rootfs.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.tpl.rootfs.path(key), []byte("built"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := m.snapshotDir("snap1")
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(filepath.Join(dir, fc.DiskFile), []byte("disk"), 0o600)
	raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: "snap1", Kind: "saved"}, Rootfs: m.tpl.rootfs.path(key)})
	_ = os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600)
	read := func() snapshotMeta {
		raw, err := m.ReadSnapshotFile("snap1", SnapshotDisk, SnapshotRecordFile)
		if err != nil {
			t.Fatal(err)
		}
		var snap snapshotMeta
		_ = json.Unmarshal(raw, &snap)
		return snap
	}
	if got := read(); got.RootfsDigest != "" {
		t.Fatalf("a digest before the map: %q", got.RootfsDigest)
	}
	if err := m.mapRootfs(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	if got := read(); got.RootfsDigest == "" || got.RootfsDigest != m.rootfsMapDigest(key) {
		t.Fatalf("the record's digest %q", got.RootfsDigest)
	}
	// Held, the snapshot is listed; with a record that can't be read beside it, nothing is, as not all can be told.
	if err := m.mapSnapshot(context.Background(), "snap1"); err != nil {
		t.Fatal(err)
	}
	if got := m.SnapshotHoldings(); len(got) != 1 {
		t.Fatalf("holdings %+v", got)
	}
	_ = os.MkdirAll(m.snapshotDir("snap2"), 0o700)
	_ = os.WriteFile(filepath.Join(m.snapshotDir("snap2"), "meta.json"), []byte("{"), 0o600)
	if got := m.SnapshotHoldings(); got != nil {
		t.Fatalf("holdings with a record unread %+v", got)
	}
}

// A keep of a saved snapshot links its maps with its files, so a kept copy is listed as soon as it is made.
func TestKeptSnapshotLinksItsMaps(t *testing.T) {
	m, _ := snapshotSyncHost(t)
	saveTestSnapshot(t, m, "snap1", "old", true)
	if err := m.mapSnapshot(context.Background(), "snap1"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.KeepSnapshot(context.Background(), proto.SnapshotParams{SnapshotID: "snap2", From: "snap1", Name: "again"}); err != nil {
		t.Fatal(err)
	}
	held := m.SnapshotHoldings()
	for _, version := range []string{SnapshotDisk, SnapshotMemory} {
		if got := digestOf(held, "snap2", version); got == "" || got != digestOf(held, "snap1", version) {
			t.Fatalf("snap2's %s: %q", version, got)
		}
	}
}

// A delete of a snapshot being fetched, before it is published, ends its fetch: its directory goes, and neither the fetch
// nor a new one publishes it.
func TestDeletingASnapshotBeingFetched(t *testing.T) {
	ctx := context.Background()
	a, _ := snapshotSyncHost(t)
	b, _ := snapshotSyncHost(t)
	saveTestSnapshot(t, a, "snap1", "old", false)
	if err := a.mapSnapshot(ctx, "snap1"); err != nil {
		t.Fatal(err)
	}
	record, _ := a.ReadSnapshotFile("snap1", SnapshotDisk, SnapshotRecordFile)
	if err := b.PrepareSnapshotFetch(ctx, "snap1", record); err != nil {
		t.Fatal(err)
	}
	path, err := b.SnapshotPartial("snap1", SnapshotDisk)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("half"), 0o600); err != nil {
		t.Fatal(err)
	}
	partial, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer partial.Close()
	if err := b.DeleteSnapshot("snap1"); err != nil {
		t.Fatalf("a delete of a fetch under way: %v", err)
	}
	if fileExists(b.snapshotFetchDir("snap1")) {
		t.Fatal("its fetch's directory left")
	}
	if err := b.PublishFetchedSnapshot("snap1", SnapshotDisk, partial, nil, nil); err == nil || fileExists(b.snapshotDir("snap1")) {
		t.Fatalf("published after its delete: %v", err)
	}
	if err := b.PrepareSnapshotFetch(ctx, "snap1", record); err == nil {
		t.Fatal("made ready again after its delete")
	}
	var pe *proto.Error
	if err := b.DeleteSnapshot("snap2"); !errors.As(err, &pe) || pe.Code != proto.ErrNotFound {
		t.Fatalf("a snapshot the host never had: %v", err)
	}
}
