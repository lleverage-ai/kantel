package microvm

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A root filesystem the host has is served with its map and record once it has a map, and listed in its holdings
// then; one without a map yet is neither.
func TestRootfsServedOnceMapped(t *testing.T) {
	m, _ := testManager(t)
	img := templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}
	key := img.key()
	b := m.tpl.rootfs
	if got := m.RootfsHoldings(); got == nil || len(got) != 0 {
		t.Fatalf("with no directory: %v", got)
	}
	if err := os.MkdirAll(b.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	data := bytes.Repeat([]byte{7}, 3*blockmap.BlockSize+5)
	if err := os.WriteFile(b.path(key), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b.recordPath(key), []byte(`{"imageDigest":"sha256:1","builtFrom":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !m.HoldsRootfs(key, RootfsVersion) || m.HoldsRootfs(key, "2") || m.HoldsRootfs("../x", RootfsVersion) {
		t.Fatal("holds")
	}
	if _, _, err := m.OpenRootfs(key, RootfsVersion, true); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("served without a map: %v", err)
	}
	if got := m.RootfsHoldings(); len(got) != 0 {
		t.Fatalf("listed without a map: %v", got)
	}
	if err := m.mapRootfs(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	f, raw, err := m.OpenRootfs(key, RootfsVersion, true)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	digest := blockmap.Digest(raw)
	got := m.RootfsHoldings()
	if len(got) != 1 || got[0].ObjectID != key || len(got[0].Versions) != 1 || got[0].Versions[0].Version != RootfsVersion ||
		got[0].Versions[0].MapDigest != digest {
		t.Fatalf("holdings %+v", got)
	}
	if record, err := m.ReadRootfsFile(key, RootfsVersion, RootfsRecordFile); err != nil || !bytes.Contains(record, []byte("sha256:1")) {
		t.Fatalf("record %q %v", record, err)
	}
	if _, err := m.ReadRootfsFile(key, RootfsVersion, "meta.json"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("another file: %v", err)
	}
	// A custom image's entry thrown away for want of its record loses its map with it.
	if err := os.Remove(b.recordPath(key)); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := customCached(b, key); ok || fileExists(b.mapPath(key)) || fileExists(b.path(key)) {
		t.Fatal("an incomplete entry kept")
	}
}

// A fetch writes <key>.partial, and publishes it as the root filesystem with its map and then its record; one the host
// has meanwhile is kept, the partial dropped.
func TestRootfsFetchStore(t *testing.T) {
	m, _ := testManager(t)
	key := templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}.key()
	b := m.tpl.rootfs
	if _, err := m.RootfsPartial("nope", RootfsVersion); err == nil {
		t.Fatal("a partial of a bad key")
	}
	partial, err := m.RootfsPartial(key, RootfsVersion)
	if err != nil || partial != filepath.Join(b.dir, key+".partial") {
		t.Fatalf("partial %q %v", partial, err)
	}
	data := bytes.Repeat([]byte{3}, 8192)
	if err := os.WriteFile(partial, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partial+rootfsDoneSuffix, []byte("bits"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := m.RootfsPartials(); len(got) != 1 || got[0] != key {
		t.Fatalf("partials %v", got)
	}
	f, err := os.OpenFile(partial, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	bm, _, err := blockmap.Make(context.Background(), f, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := bm.MarshalBinary()
	record := []byte(`{"imageDigest":"` + otherDigest + `","builtFrom":"dockerfile sha256:3"}`)
	if err := m.PublishFetchedRootfs(key, RootfsVersion, f, raw, map[string][]byte{RootfsRecordFile: record}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(b.path(key)); !bytes.Equal(got, data) {
		t.Fatal("not published")
	}
	if got, _ := os.ReadFile(b.mapPath(key)); !bytes.Equal(got, raw) {
		t.Fatal("its map")
	}
	if path, rec, ok := customCached(b, key); !ok || path != b.path(key) || rec.ImageDigest != otherDigest {
		t.Fatalf("a build doesn't find it: %v %+v", ok, rec)
	}
	if fileExists(partial) || fileExists(partial+rootfsDoneSuffix) || len(m.RootfsPartials()) != 0 {
		t.Fatal("its partial left behind")
	}
	if got := m.RootfsHoldings(); len(got) != 1 || got[0].Versions[0].MapDigest != blockmap.Digest(raw) {
		t.Fatalf("holdings %+v", got)
	}

	// Held already: the partial goes, and the file stays.
	if err := os.WriteFile(partial, []byte("other"), 0o600); err != nil {
		t.Fatal(err)
	}
	g, err := os.Open(partial)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if err := m.PublishFetchedRootfs(key, RootfsVersion, g, []byte("map"), nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(b.path(key)); !bytes.Equal(got, data) || fileExists(partial) {
		t.Fatal("a root filesystem held was replaced")
	}

	// A partial removed under the fetch isn't published.
	other := templateImage{BaseImage: "kantel/sandbox", BaseDigest: otherDigest}.key()
	path, _ := m.RootfsPartial(other, RootfsVersion)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	h, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	m.DiscardRootfsPartial(other)
	if err := m.PublishFetchedRootfs(other, RootfsVersion, h, raw, nil); err == nil || fileExists(b.path(other)) {
		t.Fatalf("published a partial removed: %v", err)
	}
}

// A fetch reserves its room beside the host's other copies, and is refused without it.
func TestRootfsFetchReservesRoom(t *testing.T) {
	m, _ := testManager(t)
	m.statfs = func(_ string, st *syscall.Statfs_t) error {
		st.Bavail, st.Bsize = 1<<20, 4096 // 4 GiB, less than a gigabyte's fetch and snapshotHeadroom
		return nil
	}
	var pe *proto.Error
	if _, err := m.ReserveRootfsFetch(1 << 30); !errors.As(err, &pe) || pe.Code != proto.ErrCapacity {
		t.Fatalf("with no room: %v", err)
	}
}

// A map a fetch cut short left behind (its file never published) is no map of the file a build makes then.
func TestABuildDropsAMapLeftWithoutItsFile(t *testing.T) {
	b, _ := testBuilder(t)
	img := templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}
	if err := os.MkdirAll(b.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b.mapPath(img.key()), []byte("another file's map"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.rootfs(context.Background(), img); err != nil {
		t.Fatal(err)
	}
	if fileExists(b.mapPath(img.key())) {
		t.Fatal("the stale map was kept")
	}
}

// Root filesystems made before maps get theirs in the background, one after another.
func TestOldRootfsGetMapsInTurn(t *testing.T) {
	m, _ := testManager(t)
	m.bg, m.bgStop = context.WithCancel(context.Background())
	defer m.bgStop()
	b := m.tpl.rootfs
	if err := os.MkdirAll(b.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	keys := []string{
		templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}.key(),
		templateImage{BaseImage: "kantel/sandbox", BaseDigest: otherDigest}.key(),
	}
	for i, key := range keys {
		if err := os.WriteFile(b.path(key), bytes.Repeat([]byte{byte(i + 1)}, blockmap.BlockSize+1), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Held by the test, so both wait their turn behind it.
	b.maps.turn.Lock()
	m.mapOldRootfs()
	m.mapOldRootfs()
	if got := m.RootfsHoldings(); len(got) != 0 {
		t.Fatalf("mapped while it waited: %v", got)
	}
	b.maps.turn.Unlock()
	deadline := time.Now().Add(10 * time.Second)
	for len(m.RootfsHoldings()) != 2 {
		if time.Now().After(deadline) {
			t.Fatalf("holdings %+v", m.RootfsHoldings())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
