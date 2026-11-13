package microvm

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// putSticky publishes version v of disk ci holding data, with its map, as a commit would.
func putSticky(t *testing.T, m *Manager, v string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(m.stickyRoot(), "ci"), 0o700); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(m.stickyRoot(), "ci", "."+v)
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmp)
	if err := m.publishSticky("ci", v, tmp); err != nil {
		t.Fatal(err)
	}
	m.unpinStickyAnswer("ci", v)
	if _, err := m.mapSticky(context.Background(), "ci", v, "", nil); err != nil {
		t.Fatal(err)
	}
}

// A fetch starts from a clone of the newest version with a map, and publishes as the newest version with the map it
// fetched; its partial and bitmap go. A version the host holds already is kept as it is.
func TestStickyFetchStore(t *testing.T) {
	m := &Manager{cfg: Config{Root: t.TempDir()}, log: slog.New(slog.DiscardHandler)}
	dst := filepath.Join(t.TempDir(), "clone")
	if bm, err := m.CloneNearestSticky("ci", "v3", dst); bm != nil || err != nil || fileExists(dst) {
		t.Fatalf("with nothing held: %v %v", bm, err)
	}
	putSticky(t, m, "v1", bytes.Repeat([]byte{1}, 4096))
	putSticky(t, m, "v2", bytes.Repeat([]byte{2}, 4096))
	// The newest has no map: the next newest is the base.
	if err := os.Remove(m.stickyMapFile("ci", "v2")); err != nil {
		t.Fatal(err)
	}
	bm, err := m.CloneNearestSticky("ci", "v3", dst)
	if err != nil || bm == nil || bm.Size != 4096 {
		t.Fatalf("clone: %v %v", bm, err)
	}
	if got, _ := os.ReadFile(dst); !bytes.Equal(got, bytes.Repeat([]byte{1}, 4096)) {
		t.Fatal("cloned the wrong version")
	}

	partial, err := m.StickyPartial("ci", "v3")
	if err != nil || partial != filepath.Join(m.stickyRoot(), "ci", "v3.partial") {
		t.Fatalf("partial %q %v", partial, err)
	}
	data := bytes.Repeat([]byte{3}, 8192)
	if err := os.WriteFile(partial, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partial+stickyDoneSuffix, []byte("bits"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := m.StickyPartials(); len(got) != 1 || got[0] != [2]string{"ci", "v3"} {
		t.Fatalf("partials %v", got)
	}
	f, err := os.OpenFile(partial, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fetched, _, err := blockmap.Make(context.Background(), f, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := fetched.MarshalBinary()
	if m.HoldsSticky("ci", "v3") {
		t.Fatal("held before it is published")
	}
	// A partial removed (its version deleted) and made again by another isn't the fetch's to publish.
	if err := os.Rename(partial, partial+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partial, []byte("not the fetch's"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.PublishFetchedSticky("ci", "v3", f, raw); err == nil || m.HoldsSticky("ci", "v3") {
		t.Fatalf("published another file: %v", err)
	}
	if err := os.Rename(partial+".old", partial); err != nil {
		t.Fatal(err)
	}
	if err := m.PublishFetchedSticky("ci", "v3", f, raw); err != nil {
		t.Fatal(err)
	}
	if !m.HoldsSticky("ci", "v3") || fileExists(partial) || fileExists(partial+stickyDoneSuffix) || len(m.StickyPartials()) != 0 {
		t.Fatal("not published, or its partial left")
	}
	held := m.StickyHoldings()
	// The newest, with its map's digest; v1 pruned (two are kept).
	if len(held) != 1 || len(held[0].Versions) != 2 || held[0].Versions[0].Version != "v3" || held[0].Versions[0].MapDigest != blockmap.Digest(raw) ||
		held[0].Versions[1].Version != "v2" {
		t.Fatalf("holdings %+v", held)
	}

	// Again: the version is kept, the new partial dropped.
	if err := os.WriteFile(partial, []byte("other"), 0o600); err != nil {
		t.Fatal(err)
	}
	other, err := os.Open(partial)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if err := m.PublishFetchedSticky("ci", "v3", other, []byte("other map")); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(m.stickyVersionFile("ci", "v3")); !bytes.Equal(got, data) || fileExists(partial) {
		t.Fatal("a version held was replaced")
	}
}

// Deleting a disk's last version keeps its directory while a fetch of another has its partial there; deleting the
// version being fetched removes its partial.
func TestStickyDeleteAndFetches(t *testing.T) {
	m := &Manager{cfg: Config{Root: t.TempDir()}, log: slog.New(slog.DiscardHandler)}
	putSticky(t, m, "v1", []byte("one"))
	for _, v := range []string{"v2", "v3"} {
		partial, err := m.StickyPartial("ci", v)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(partial, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.DeleteSticky(proto.StickyDeleteParams{DiskID: "ci", Version: "v1"}); err != nil {
		t.Fatal(err)
	}
	if err := m.DeleteSticky(proto.StickyDeleteParams{DiskID: "ci", Version: "v2"}); err != nil {
		t.Fatal(err)
	}
	if got := m.StickyPartials(); len(got) != 1 || got[0][1] != "v3" {
		t.Fatalf("partials %v, want v3's alone", got)
	}
	m.DiscardStickyPartial("ci", "v3")
	if len(m.StickyPartials()) != 0 {
		t.Fatal("discarded partial left")
	}
}

// A create attaching a version the host doesn't hold starts on its newest, and asks for that version to be fetched;
// one it holds, or with no version asked for, asks for nothing.
func TestStickyAttachFetchesAVersionNotHeld(t *testing.T) {
	if _, err := exec.LookPath("mkfs.ext4"); err != nil {
		t.Skip("no mkfs.ext4")
	}
	var asked [][2]string
	m := &Manager{cfg: Config{Root: t.TempDir(), FetchSticky: func(d, v string) { asked = append(asked, [2]string{d, v}) }},
		sandboxes: map[string]*sandbox{}, log: slog.New(slog.DiscardHandler)}
	putSticky(t, m, "v1", []byte("one"))
	ctx := context.Background()
	for i, c := range []struct {
		version, want string
		asked         int
	}{{"v1", "v1", 0}, {"", "v1", 0}, {"v9", "v1", 1}} {
		f := newStickyFixture(t, "sbx_"+string(rune('a'+i)), m)
		m.attachSticky(ctx, f.s, []proto.StickyDisk{{DiskID: "ci", Path: "/ci", SizeGiB: 1, Version: c.version}})
		if d := f.s.meta.StickyDisks; len(d) != 1 || d[0].Version != c.want || d[0].State != stickyAttached {
			t.Fatalf("%q: %+v", c.version, d)
		}
		if len(asked) != c.asked {
			t.Fatalf("%q: asked %v", c.version, asked)
		}
	}
	if asked[0] != [2]string{"ci", "v9"} {
		t.Fatalf("asked %v", asked)
	}
}
