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
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// syncHost is fingerprintHost with its template cache, in pool.
func syncHost(t *testing.T, pool string) *Manager {
	t.Helper()
	m := fingerprintHost(t)
	m.log = slog.New(slog.DiscardHandler)
	m.tpl = newTemplateCache(m.cfg.Root, nil, testRegistry)
	m.tpl.rootfs.pool = func() string { return pool }
	return m
}

// builtTemplate makes template snapshot id on m as a build leaves it, booted on the host image's current version (new),
// with what it was made on, and answers its meta.json.
func builtTemplate(t *testing.T, m *Manager, id string) templateSnapshotMeta {
	t.Helper()
	dir := m.templateSnapshotDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	mem := make([]byte, 3*blockmap.BlockSize)
	copy(mem[blockmap.BlockSize:], bytes.Repeat([]byte("memory"), 1000))
	for name, data := range map[string][]byte{"state": []byte("vm state"), "mem": mem, fc.DiskFile: bytes.Repeat([]byte("d"), blockmap.BlockSize+7)} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeSnapshotStickyCount(dir, StickyDrives); err != nil {
		t.Fatal(err)
	}
	rootfs := m.baseRootfs()
	size := DefaultSizes[1]
	kept := templateSnapshotMeta{
		SnapshotID: id, KeyHash: "k1", Rootfs: rootfs, Runtime: m.runtimeFingerprint(rootfs), CPU: m.CPU(),
		PortableRuntime: m.portableRuntime(rootfs), BuiltFrom: templateBuiltFrom{Image: templateImageKind, BaseImage: "kantel/sandbox"},
		VCPUs: size.VCPUs, MemoryMiB: size.MemoryMiB, DiskGiB: size.DiskGiB,
	}
	if kept.PortableRuntime == "" {
		t.Fatal("the test host has no portable runtime")
	}
	stampTemplatePool(dir, "pool_a")
	if err := keepTemplateSnapshot(dir, &kept); err != nil {
		t.Fatal(err)
	}
	return kept
}

// fetchTemplateInto does what a fetch does with a holder's template snapshot: each part into its partial, then the
// parts published with their maps and the small files the holder has.
func fetchTemplateInto(t *testing.T, from, to *Manager, id string) error {
	t.Helper()
	parts := map[string]disksync.FetchedPart{}
	for _, part := range TemplateParts {
		f, raw, err := from.OpenTemplatePart(id, TemplateVersion, part, true)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(f.Name())
		f.Close()
		path, err := to.TemplatePartPartial(id, TemplateVersion, part)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		mine, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { mine.Close() })
		parts[part] = disksync.FetchedPart{File: mine, Map: raw}
	}
	files := map[string][]byte{}
	for _, name := range TemplateFiles {
		if raw, err := from.ReadTemplateFile(id, TemplateVersion, name); err == nil {
			files[name] = raw
		}
	}
	return to.PublishFetchedTemplate(id, TemplateVersion, parts, files)
}

// A template snapshot is served, and listed with what it was made on, only once both its parts are mapped; its
// manifest's digest is its holding's map digest.
func TestTemplateSnapshotServedOnceMapped(t *testing.T) {
	m := syncHost(t, "pool_a")
	if got := m.TemplateHoldings(); got == nil || len(got) != 0 {
		t.Fatalf("with no directory: %v", got)
	}
	builtTemplate(t, m, "tsn_1")
	if !m.HoldsTemplate("tsn_1", TemplateVersion) || m.HoldsTemplate("tsn_1", "2") || m.HoldsTemplate("../x", TemplateVersion) {
		t.Fatal("holds")
	}
	if _, _, err := m.OpenTemplatePart("tsn_1", TemplateVersion, TemplatePartMem, true); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("served without a map: %v", err)
	}
	if got := m.TemplateHoldings(); len(got) != 0 {
		t.Fatalf("listed without maps: %v", got)
	}
	if err := m.mapTemplate(context.Background(), "tsn_1"); err != nil {
		t.Fatal(err)
	}
	manifest, err := disksync.ManifestOf(templatePartsOf{m}, disksync.Ref{Kind: proto.DiskKindTemplate, ObjectID: "tsn_1", Version: TemplateVersion})
	if err != nil {
		t.Fatal(err)
	}
	got := m.TemplateHoldings()
	if len(got) != 1 || got[0].ObjectID != "tsn_1" || len(got[0].Versions) != 1 {
		t.Fatalf("holdings %+v", got)
	}
	held := got[0].Versions[0]
	if held.Version != TemplateVersion || held.MapDigest != blockmap.Digest(manifest) || held.Pool != "pool_a" ||
		!held.CPU.Same(m.CPU()) || held.Runtime != m.portableRuntime(m.baseRootfs()) || held.AllocatedBytes == 0 {
		t.Fatalf("holding %+v", held)
	}
	for name, want := range map[string]string{"state": "vm state", "meta": `"snapshotId": "tsn_1"`, stickyCountFile: "2"} {
		if raw, err := m.ReadTemplateFile("tsn_1", TemplateVersion, name); err != nil || !strings.Contains(string(raw), want) {
			t.Fatalf("%s: %q %v", name, raw, err)
		}
	}
	for _, name := range []string{driveCountFile, "mem", "../meta.json"} {
		if _, err := m.ReadTemplateFile("tsn_1", TemplateVersion, name); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// One made before what it was made on was kept is neither mapped nor listed.
	old := builtTemplate(t, m, "tsn_old")
	old.CPU, old.PortableRuntime = nil, ""
	if err := keepTemplateSnapshot(m.templateSnapshotDir("tsn_old"), &old); err != nil {
		t.Fatal(err)
	}
	if err := m.mapTemplate(context.Background(), "tsn_old"); err != nil || fileExists(filepath.Join(m.templateSnapshotDir("tsn_old"), "mem.map")) {
		t.Fatalf("mapped one with no fingerprints: %v", err)
	}
	if got := m.TemplateHoldings(); len(got) != 1 {
		t.Fatalf("holdings %+v", got)
	}
}

// templatePartsOf is a tier as disksync.Parted, as the agent gives it.
type templatePartsOf struct{ m *Manager }

func (p templatePartsOf) Parts(string) []string { return TemplateParts }
func (p templatePartsOf) OpenPart(r disksync.Ref, part string, withMap bool) (*os.File, []byte, error) {
	return p.m.OpenTemplatePart(r.ObjectID, r.Version, part, withMap)
}
func (p templatePartsOf) PartPartial(r disksync.Ref, part string) (string, error) {
	return p.m.TemplatePartPartial(r.ObjectID, r.Version, part)
}
func (p templatePartsOf) PublishParts(r disksync.Ref, parts map[string]disksync.FetchedPart, files map[string][]byte) error {
	return p.m.PublishFetchedTemplate(r.ObjectID, r.Version, parts, files)
}

// A template snapshot fetched onto a host with the same CPU and runtime is that host's: over its own file of the host
// image version it was built on, its runtime by its own files, restorable as a build there leaves one, stamped with the
// pool the fetch began in, and listed with the holder's map digest.
func TestAFetchedTemplateSnapshotIsTheHostsOwn(t *testing.T) {
	a, b := syncHost(t, "pool_a"), syncHost(t, "pool_a")
	kept := builtTemplate(t, a, "tsn_1")
	if err := a.mapTemplate(context.Background(), "tsn_1"); err != nil {
		t.Fatal(err)
	}
	if err := fetchTemplateInto(t, a, b, "tsn_1"); err != nil {
		t.Fatal(err)
	}
	got, err := b.readTemplateSnapshot("tsn_1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Rootfs != versionFile(b, "new") || got.Rootfs == kept.Rootfs || got.Runtime != b.runtimeFingerprint(got.Rootfs) || got.Base != "new" {
		t.Fatalf("meta %+v", got)
	}
	if target, _ := os.Readlink(filepath.Join(b.templateSnapshotDir("tsn_1"), templateRootfsLink)); target != versionFile(b, "new") {
		t.Fatalf("linked to %q", target)
	}
	if _, err := b.restorableTemplateSnapshot("tsn_1", DefaultSizes[1]); err != nil {
		t.Fatalf("not restorable: %v", err)
	}
	if held := b.TemplateHoldings(); len(held) != 1 || held[0].Versions[0].MapDigest != a.TemplateHoldings()[0].Versions[0].MapDigest ||
		held[0].Versions[0].Pool != "pool_a" {
		t.Fatalf("holdings %+v, the holder's %+v", held, a.TemplateHoldings())
	}
	if fileExists(b.templateFetchDir("tsn_1")) || len(b.TemplatePartials()) != 0 {
		t.Fatal("the fetch's directory was left")
	}
	// Published again (a fetch that finished as another did): the one there is kept.
	if _, err := b.TemplatePartPartial("tsn_1", TemplateVersion, TemplatePartDisk); err != nil {
		t.Fatal(err)
	}
	if err := b.PublishFetchedTemplate("tsn_1", TemplateVersion, nil, nil); err != nil || fileExists(b.templateFetchDir("tsn_1")) {
		t.Fatalf("published over one held: %v", err)
	}
}

// A template snapshot is never published onto a host whose CPU or runtime isn't the one it was made on, or that hasn't
// the root filesystem it was made over; nor once its fetch has been removed (the snapshot deleted).
func TestATemplateSnapshotIsPublishedOnlyWhereItRestores(t *testing.T) {
	for name, c := range map[string]struct {
		change func(t *testing.T, b *Manager)
		want   string
	}{
		"another CPU": {change: func(_ *testing.T, b *Manager) {
			cpu := testCPU
			cpu.Model = 68
			b.cfg.CPU, b.fingerprints = &cpu, fingerprints{}
		}, want: "another CPU"},
		"another runtime": {change: func(_ *testing.T, b *Manager) { b.cfg.FreePageReporting = true }, want: "another runtime"},
		"without the image version": {change: func(t *testing.T, b *Manager) {
			// Its current version is old, and new has gone.
			images := filepath.Dir(b.cfg.Rootfs)
			if err := os.Remove(filepath.Join(images, "current")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join("v", "old"), filepath.Join(images, "current")); err != nil {
				t.Fatal(err)
			}
			if err := os.RemoveAll(filepath.Join(images, "v", "new")); err != nil {
				t.Fatal(err)
			}
		}, want: "isn't on this host"},
	} {
		t.Run(name, func(t *testing.T) {
			a, b := syncHost(t, "pool_a"), syncHost(t, "pool_a")
			builtTemplate(t, a, "tsn_1")
			if err := a.mapTemplate(context.Background(), "tsn_1"); err != nil {
				t.Fatal(err)
			}
			c.change(t, b)
			err := fetchTemplateInto(t, a, b, "tsn_1")
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want %q, got %v", c.want, err)
			}
			if fileExists(b.templateSnapshotDir("tsn_1")) {
				t.Fatal("published")
			}
		})
	}
	// Deleted while it was fetched: its partials are gone, and nothing is published.
	a, b := syncHost(t, "pool_a"), syncHost(t, "pool_a")
	builtTemplate(t, a, "tsn_1")
	if err := a.mapTemplate(context.Background(), "tsn_1"); err != nil {
		t.Fatal(err)
	}
	parts := map[string]disksync.FetchedPart{}
	for _, part := range TemplateParts {
		path, _ := b.TemplatePartPartial("tsn_1", TemplateVersion, part)
		_ = os.WriteFile(path, []byte(part), 0o600)
		f, _ := os.Open(path)
		defer f.Close()
		parts[part] = disksync.FetchedPart{File: f}
	}
	if err := b.DeleteTemplate("tsn_1"); err != nil {
		t.Fatal(err)
	}
	meta, _ := a.ReadTemplateFile("tsn_1", TemplateVersion, "meta")
	if err := b.PublishFetchedTemplate("tsn_1", TemplateVersion, parts, map[string][]byte{"meta": meta, "state": []byte("s")}); err == nil {
		t.Fatal("published a deleted snapshot's fetch")
	}
	if fileExists(b.templateSnapshotDir("tsn_1")) {
		t.Fatal("published")
	}
}

// A build asks for its template snapshot from a peer once its root filesystem is in place, and boots nothing when it
// comes, answering it; with none from a peer, or one that can't be restored as the build's machine, it builds.
func TestABuildFetchesItsTemplateSnapshotFromAPeerFirst(t *testing.T) {
	p := proto.TemplateBuildParams{SnapshotID: "tsn_1", KeyHash: "k1", BaseImage: "kantel/sandbox", BaseDigest: testDigest, VCPUs: 2, MemoryMiB: 2048, DiskGiB: 20}
	img := templateImage{BaseImage: p.BaseImage, BaseDigest: p.BaseDigest}
	for name, c := range map[string]struct {
		// fetch puts what a fetch would in place, or fails.
		fetch func(t *testing.T, m *Manager) error
		built bool
	}{
		"held by a peer": {fetch: func(t *testing.T, m *Manager) error {
			if !fileExists(m.tpl.rootfs.path(img.key())) {
				t.Fatal("asked before its root filesystem was in place")
			}
			kept := keepTestTemplateSnapshot(t, m, "tsn_1", img)
			kept.VCPUs, kept.MemoryMiB, kept.Timings = 2, 2048, timings{"peer": 1}
			return keepTemplateSnapshot(m.templateSnapshotDir("tsn_1"), &kept)
		}},
		"held by none":    {fetch: func(*testing.T, *Manager) error { return ErrNoPeerTemplate }, built: true},
		"a fetch failing": {fetch: func(*testing.T, *Manager) error { return errors.New("the peer went away") }, built: true},
		"another machine": {fetch: func(t *testing.T, m *Manager) error {
			keepTestTemplateSnapshot(t, m, "tsn_1", img)
			return nil
		}, built: true},
	} {
		t.Run(name, func(t *testing.T) {
			m, _, _ := builderManager(t)
			if err := os.MkdirAll(m.tpl.rootfs.dir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(m.tpl.rootfs.path(img.key()), []byte("ext4"), 0o600); err != nil {
				t.Fatal(err)
			}
			asked := 0
			m.cfg.FetchTemplate = func(_ context.Context, id string) error {
				asked++
				if id != "tsn_1" {
					t.Fatalf("asked for %s", id)
				}
				return c.fetch(t, m)
			}
			// The snapshot's boot needs Firecracker, which the tests haven't: a build fails there.
			res, err := m.BuildTemplate(context.Background(), p)
			if asked != 1 {
				t.Fatalf("asked %d times", asked)
			}
			if c.built {
				if err == nil {
					t.Fatalf("answered %+v without a boot", res)
				}
				if fileExists(m.templateSnapshotDir("tsn_1")) {
					t.Fatal("a snapshot it couldn't use was kept")
				}
				return
			}
			if err != nil || res.Ref != "tsn_1" || res.Timings["peer"] != 1 {
				t.Fatalf("%+v %v", res, err)
			}
			if ids, _, _ := m.TemplateBuilds(); len(ids) != 0 {
				t.Fatalf("builds held after it ended: %v", ids)
			}
		})
	}
}

// A template snapshot's meta.json is what its holdings say it was made on.
func TestTemplateHoldingsJSON(t *testing.T) {
	cpu := testCPU
	raw, _ := json.Marshal(proto.ObjectVersionHolding{Version: "1", MapDigest: "sha256:x", CPU: &cpu, Runtime: "firecracker=v1"})
	if !strings.Contains(string(raw), `"cpu":{"vendor":"AuthenticAMD"`) || !strings.Contains(string(raw), `"runtime":"firecracker=v1"`) {
		t.Fatalf("%s", raw)
	}
	raw, _ = json.Marshal(proto.ObjectVersionHolding{Version: "1", MapDigest: "sha256:x"})
	if strings.Contains(string(raw), "cpu") || strings.Contains(string(raw), "runtime") {
		t.Fatalf("a root filesystem's holding: %s", raw)
	}
}
