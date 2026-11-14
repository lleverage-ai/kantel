package microvm

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
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
	// Made before stamps: no pool; stamped, its pool.
	if got[0].Versions[0].Pool != "" {
		t.Fatalf("an unstamped copy's pool %q", got[0].Versions[0].Pool)
	}
	b.stampPool(key, "pool_a")
	if got := m.RootfsHoldings(); got[0].Versions[0].Pool != "pool_a" {
		t.Fatalf("a stamped copy's pool %q", got[0].Versions[0].Pool)
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
	pool := "pool_a"
	b.pool = func() string { return pool }
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
	// Gone on after the host moved: the copy is still the pool the fetch began in.
	pool = "pool_b"
	if _, err := m.RootfsPartial(key, RootfsVersion); err != nil {
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
	if got := m.RootfsHoldings(); len(got) != 1 || got[0].Versions[0].MapDigest != blockmap.Digest(raw) || got[0].Versions[0].Pool != "pool_a" {
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

// A map a fetch cut short left behind (its file never published) is no map of the file a build makes then, which is
// stamped with the pool it was built in.
func TestABuildDropsAMapLeftWithoutItsFile(t *testing.T) {
	b, _ := testBuilder(t)
	b.pool = func() string { return "pool_a" }
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
	// Stamped with the pool it was built in.
	if got := b.stampedPool(img.key()); got != "pool_a" {
		t.Fatalf("stamped %q", got)
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

// A build of a pulled base's template fetches the root filesystem from a peer first, and then pulls nothing; one no
// peer holds, or whose fetch fails, is pulled and made as before.
func TestATemplateBuildFetchesItsRootfsFromAPeerFirst(t *testing.T) {
	img := templateImage{BaseImage: "kantel/sandbox", BaseDigest: testDigest}
	p := proto.TemplateBuildParams{SnapshotID: "tsn_1", KeyHash: "k1", BaseImage: img.BaseImage, BaseDigest: img.BaseDigest, VCPUs: 2, MemoryMiB: 2048, DiskGiB: 20}
	for name, c := range map[string]struct {
		fetch  func(m *Manager) error
		pulled bool
	}{
		"held by a peer": {fetch: func(m *Manager) error {
			return os.WriteFile(m.tpl.rootfs.path(img.key()), []byte("ext4"), 0o600)
		}, pulled: false},
		"held by none":    {fetch: func(*Manager) error { return ErrNoPeerRootfs }, pulled: true},
		"a fetch failing": {fetch: func(*Manager) error { return errors.New("the peer went away") }, pulled: true},
	} {
		t.Run(name, func(t *testing.T) {
			m, docker, _ := builderManager(t)
			if err := os.MkdirAll(m.tpl.rootfs.dir, 0o700); err != nil {
				t.Fatal(err)
			}
			var asked []string
			m.cfg.FetchRootfs = func(_ context.Context, key string) error {
				asked = append(asked, key)
				return c.fetch(m)
			}
			// The snapshot's boot needs Firecracker, which the tests haven't: the build fails there, after its root
			// filesystem is in place.
			_, _ = m.BuildTemplate(context.Background(), p)
			if len(asked) != 1 || asked[0] != img.key() {
				t.Fatalf("asked for %v", asked)
			}
			pulled := slices.ContainsFunc(docker.calls, func(call []string) bool { return len(call) > 1 && call[1] == "pull" })
			if pulled != c.pulled {
				t.Fatalf("pulled %v: %v", pulled, docker.calls)
			}
			if !fileExists(m.tpl.rootfs.path(img.key())) {
				t.Fatal("no root filesystem")
			}
			// Held now: the next build asks no peer.
			_, _ = m.BuildTemplate(context.Background(), p)
			if len(asked) != 1 {
				t.Fatalf("asked again: %v", asked)
			}
		})
	}
	// A build that ends while it waits for the fetch builds nothing, and gives its room back.
	m, docker, _ := builderManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	m.cfg.FetchRootfs = func(ctx context.Context, _ string) error {
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}
	if _, err := m.BuildTemplate(ctx, p); !errors.Is(err, context.Canceled) {
		t.Fatalf("a build cancelled during its fetch: %v", err)
	}
	if len(docker.calls) != 0 || fileExists(m.tpl.rootfs.path(img.key())) {
		t.Fatalf("built after its cancellation: %v", docker.calls)
	}
	if ids, _, _ := m.TemplateBuilds(); len(ids) != 0 {
		t.Fatalf("builds held after it ended: %v", ids)
	}
	// The host's own image is no object to fetch.
	m, _, _ = builderManager(t)
	m.cfg.FetchRootfs = func(context.Context, string) error { t.Fatal("asked for the host's own image"); return nil }
	_, _ = m.BuildTemplate(context.Background(), proto.TemplateBuildParams{SnapshotID: "tsn_2", KeyHash: "k2", BaseImage: "kantel/sandbox", VCPUs: 2, MemoryMiB: 2048, DiskGiB: 20})
}

// A custom image's build fetches its root filesystem, with its record, from a peer first, and builds nothing then.
func TestACustomImageBuildFetchesItsRootfsFromAPeerFirst(t *testing.T) {
	m, docker, b := builderManager(t)
	p := proto.TemplateBuildParams{SnapshotID: "tsn_1", KeyHash: "k1", BaseImage: "kantel/sandbox", Image: testDockerfile, VCPUs: 2, MemoryMiB: 4096, DiskGiB: 20, Owner: "acc_1"}
	key := customImageKey("acc_1", testDockerfile, templateImage{BaseImage: "kantel/sandbox"})
	m.cfg.FetchRootfs = func(_ context.Context, asked string) error {
		if asked != key {
			t.Fatalf("asked for %s", asked)
		}
		if err := os.MkdirAll(m.tpl.rootfs.dir, 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(m.tpl.rootfs.path(key), []byte("ext4"), 0o600); err != nil {
			return err
		}
		return os.WriteFile(m.tpl.rootfs.recordPath(key), []byte(`{"imageDigest":"`+otherDigest+`","builtFrom":"dockerfile x"}`), 0o600)
	}
	_, _ = m.BuildTemplate(context.Background(), p)
	if len(b.jobs) != 0 || len(docker.calls) != 0 {
		t.Fatalf("built %d images, ran %v", len(b.jobs), docker.calls)
	}
	if _, rec, ok := customCached(m.tpl.rootfs, key); !ok || rec.ImageDigest != otherDigest {
		t.Fatalf("the fetched image %+v %v", rec, ok)
	}
}

// A copy of a custom image's entry (TemplateBuildParams.Copy) is over only that entry's image: its root filesystem
// fetched from a peer, or held here already, with the digest the copy names. With no peer holding it, or one holding
// another image under the key, the copy fails and nothing is built or pulled; a copy that names another key than the
// template's image, or of a template with no custom image, is refused.
func TestACopyOfACustomImageIsOnlyOverItsEntrysImage(t *testing.T) {
	key := customImageKey("acc_1", testDockerfile, templateImage{BaseImage: "kantel/sandbox"})
	digest := "sha256:" + strings.Repeat("ef", 32)
	copyOf := func(id string, c proto.TemplateCopy) proto.TemplateBuildParams {
		return proto.TemplateBuildParams{SnapshotID: id, KeyHash: "k1", BaseImage: "kantel/sandbox", Image: testDockerfile, VCPUs: 2, MemoryMiB: 4096, DiskGiB: 20, Owner: "acc_1", Copy: &c}
	}
	fetchAs := func(m *Manager, recorded string, asked *int) func(context.Context, string) error {
		return func(_ context.Context, got string) error {
			*asked++
			if got != key {
				t.Fatalf("asked for %s", got)
			}
			if recorded == "" {
				return ErrNoPeerRootfs
			}
			if err := os.MkdirAll(m.tpl.rootfs.dir, 0o700); err != nil {
				return err
			}
			if err := os.WriteFile(m.tpl.rootfs.path(key), []byte("ext4"), 0o600); err != nil {
				return err
			}
			return os.WriteFile(m.tpl.rootfs.recordPath(key), []byte(`{"imageDigest":"`+recorded+`","builtFrom":"dockerfile x"}`), 0o600)
		}
	}
	code := func(err error) string {
		var pe *proto.Error
		if errors.As(err, &pe) {
			return pe.Code
		}
		return ""
	}

	// No peer holds it: the copy fails, and builds nothing.
	m, docker, b := builderManager(t)
	asked := 0
	m.cfg.FetchRootfs = fetchAs(m, "", &asked)
	if _, err := m.BuildTemplate(context.Background(), copyOf("tsn_1", proto.TemplateCopy{RootfsKey: key, ImageDigest: digest})); code(err) != proto.ErrNotFound || asked != 1 {
		t.Fatalf("with no peer: %v (asked %d)", err, asked)
	}
	if len(b.jobs) != 0 || len(docker.calls) != 0 || fileExists(m.tpl.rootfs.path(key)) {
		t.Fatalf("built %d images, ran %v", len(b.jobs), docker.calls)
	}

	// A peer holds another image under the key: the copy fails, and the image isn't built either.
	m, docker, b = builderManager(t)
	asked = 0
	m.cfg.FetchRootfs = fetchAs(m, otherDigest, &asked)
	if _, err := m.BuildTemplate(context.Background(), copyOf("tsn_1", proto.TemplateCopy{RootfsKey: key, ImageDigest: digest})); code(err) != proto.ErrConflict {
		t.Fatalf("over another image: %v", err)
	}
	if len(b.jobs) != 0 || len(docker.calls) != 0 {
		t.Fatalf("built %d images, ran %v", len(b.jobs), docker.calls)
	}
	// Held here as another image (built here under the same key): the same, and no peer is asked.
	asked = 0
	if _, err := m.BuildTemplate(context.Background(), copyOf("tsn_2", proto.TemplateCopy{RootfsKey: key, ImageDigest: digest})); code(err) != proto.ErrConflict || asked != 0 {
		t.Fatalf("over another image held here: %v (asked %d)", err, asked)
	}

	// A peer holds the entry's image: the build goes on over it (to the snapshot, asked of a peer first), building no
	// image.
	m, docker, b = builderManager(t)
	asked = 0
	m.cfg.FetchRootfs = fetchAs(m, digest, &asked)
	snapshots := 0
	m.cfg.FetchTemplate = func(context.Context, string) error {
		snapshots++
		return ErrNoPeerTemplate
	}
	_, err := m.BuildTemplate(context.Background(), copyOf("tsn_1", proto.TemplateCopy{RootfsKey: key, ImageDigest: digest}))
	if c := code(err); c == proto.ErrNotFound || c == proto.ErrConflict || c == proto.ErrInvalid || asked != 1 || snapshots != 1 {
		t.Fatalf("over the entry's image: %v (asked %d, snapshot asked %d)", err, asked, snapshots)
	}
	if len(b.jobs) != 0 || len(docker.calls) != 0 {
		t.Fatalf("built %d images, ran %v", len(b.jobs), docker.calls)
	}
	if _, rec, ok := customCached(m.tpl.rootfs, key); !ok || rec.ImageDigest != digest {
		t.Fatalf("the fetched image %+v %v", rec, ok)
	}

	// Refused: another key, a digest that isn't one, and a copy of a template on a Kantel base.
	for _, c := range []proto.TemplateCopy{{RootfsKey: strings.Repeat("0", 64), ImageDigest: digest}, {RootfsKey: key, ImageDigest: "latest"}, {RootfsKey: key}} {
		if _, err := m.BuildTemplate(context.Background(), copyOf("tsn_3", c)); code(err) != proto.ErrInvalid {
			t.Fatalf("copy %+v: %v", c, err)
		}
	}
	base := copyOf("tsn_3", proto.TemplateCopy{RootfsKey: key, ImageDigest: digest})
	base.Image = nil
	if _, err := m.BuildTemplate(context.Background(), base); code(err) != proto.ErrInvalid {
		t.Fatalf("a copy of a base template: %v", err)
	}
	if len(b.jobs) != 0 {
		t.Fatalf("built %d images", len(b.jobs))
	}
}
