package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// fakeTemplateTier is the microVM tier as template calls see it.
type fakeTemplateTier struct {
	fakeTier
	buildMu sync.Mutex
	builds  []proto.TemplateBuildParams
	deleted []string
	// noDocker is why it can't build templates' images, if it can't.
	noDocker error
	// usedMiB is what its sandboxes use.
	usedMiB int64
	// held are the builds it reports admitted (TemplateBuilds).
	held map[string]proto.Size
}

func (f *fakeTemplateTier) CanBuildTemplates(context.Context) error { return f.noDocker }

func (f *fakeTemplateTier) TemplateBuildMachine(p proto.TemplateBuildParams) (proto.Size, error) {
	if p.MemoryMiB > 16_384 {
		return proto.Size{}, &proto.Error{Code: proto.ErrInvalid, Message: "too big"}
	}
	return proto.Size{Name: "template", VCPUs: p.VCPUs, MemoryMiB: p.MemoryMiB, DiskGiB: 20}, nil
}

func (f *fakeTemplateTier) BuildTemplate(_ context.Context, p proto.TemplateBuildParams) (proto.TemplateBuildResult, error) {
	f.buildMu.Lock()
	f.builds = append(f.builds, p)
	f.buildMu.Unlock()
	return proto.TemplateBuildResult{Ref: p.SnapshotID, ImageDigest: "sha256:feed", SizeBytes: 42}, nil
}

func (f *fakeTemplateTier) DeleteTemplate(id string) error {
	f.buildMu.Lock()
	defer f.buildMu.Unlock()
	f.deleted = append(f.deleted, id)
	return nil
}

func (f *fakeTemplateTier) TemplateBuilds() (ids []string, memoryMiB, diskGiB int64) {
	for id, size := range f.held {
		ids = append(ids, id)
		memoryMiB += int64(size.MemoryMiB)
		diskGiB += int64(size.DiskGiB)
	}
	slices.Sort(ids)
	return ids, memoryMiB, diskGiB
}

func (f *fakeTemplateTier) Usage() (int64, int, int) { return f.usedMiB, 0, 0 }

func templateHost(t *testing.T, tiers map[string]Tier, order []string) *Host {
	dir := t.TempDir()
	return &Host{
		cfg: Config{Root: dir, OvercommitMemory: 1}, facts: proto.Facts{MemoryMiB: 32_768}, log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		tiers: tiers, order: order, bySlot: map[int]egress.Rules{}, cas: egress.NewCAStore(dir + "/egress-ca"),
	}
}

func TestTemplateCallsGoToTheMicroVMTier(t *testing.T) {
	tier := &fakeTemplateTier{fakeTier: fakeTier{running: map[string]bool{}}}
	h := templateHost(t, map[string]Tier{microvm.Tier: tier}, []string{microvm.Tier})
	build := proto.TemplateBuildParams{
		SnapshotID: "tsn_1", BaseImage: "kantel/sandbox", BaseDigest: "sha256:" + strings.Repeat("ab", 32),
		Setup: "apt-get install -y jq", Env: map[string]string{"A": "1"}, VCPUs: 2, MemoryMiB: 2048, KeyHash: "k",
		// A grant that names a path is intercepted, so the build gets a CA of its own, as a sandbox would.
		Egress: &proto.Egress{Mode: "proxy", Grants: []proto.Grant{{Action: "allow", Host: "api.github.com", Paths: []string{"/repos/**"}, Rule: "allow api.github.com /repos/**"}}},
	}
	raw, _ := json.Marshal(build)
	got, err := h.Call(context.Background(), proto.MethodTemplateBuild, raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result, ok := got.(proto.TemplateBuildResult); !ok || result.Ref != "tsn_1" || result.SizeBytes != 42 {
		t.Fatalf("result %#v", got)
	}
	if len(tier.builds) != 1 || tier.builds[0].Setup != build.Setup || tier.builds[0].Env["A"] != "1" ||
		tier.builds[0].BaseImage != build.BaseImage || tier.builds[0].BaseDigest != build.BaseDigest {
		t.Fatalf("builds %+v", tier.builds)
	}
	if !strings.Contains(tier.builds[0].Egress.CACert, "BEGIN CERTIFICATE") {
		t.Fatalf("the build's egress has no CA: %+v", tier.builds[0].Egress)
	}
	if _, err := h.cas.Get("tsn_1"); err == nil {
		t.Fatal("the build's CA outlived it")
	}
	raw, _ = json.Marshal(proto.TemplateDeleteParams{SnapshotID: "tsn_1"})
	if _, err := h.Call(context.Background(), proto.MethodTemplateDelete, raw, nil); err != nil {
		t.Fatal(err)
	}
	if len(tier.deleted) != 1 || tier.deleted[0] != "tsn_1" {
		t.Fatalf("deleted %v", tier.deleted)
	}
}

// Facts say the host builds templates only while it can: the microVM tier, with Docker answering. Without Docker,
// template.build is refused and a template snapshot can still be deleted.
func TestTemplateBuildsNeedDocker(t *testing.T) {
	tier := &fakeTemplateTier{fakeTier: fakeTier{running: map[string]bool{}}}
	h := templateHost(t, map[string]Tier{microvm.Tier: tier}, []string{microvm.Tier})
	h.facts.Features = []string{proto.FeatureEgressPolicy}
	if f := h.Facts(); !slices.Equal(f.Features, []string{proto.FeatureEgressPolicy, proto.FeatureTemplateBuild}) {
		t.Fatalf("features %v", f.Features)
	}
	tier.noDocker = &proto.Error{Code: proto.ErrUnsupported, Message: "this host can't build templates' images: Docker isn't installed on this host"}
	if f := h.Facts(); !slices.Equal(f.Features, []string{proto.FeatureEgressPolicy}) {
		t.Fatalf("features without Docker %v", f.Features)
	}
	if !slices.Equal(h.facts.Features, []string{proto.FeatureEgressPolicy}) {
		t.Fatalf("the host's own facts changed: %v", h.facts.Features)
	}
	raw, _ := json.Marshal(proto.TemplateBuildParams{SnapshotID: "tsn_1", BaseImage: "kantel/sandbox", VCPUs: 1, MemoryMiB: 1024})
	var pe *proto.Error
	if _, err := h.Call(context.Background(), proto.MethodTemplateBuild, raw, nil); !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported || !strings.Contains(pe.Message, "Docker") {
		t.Fatalf("got %v", err)
	}
	if len(tier.builds) != 0 {
		t.Fatalf("built %v", tier.builds)
	}
	raw, _ = json.Marshal(proto.TemplateDeleteParams{SnapshotID: "tsn_1"})
	if _, err := h.Call(context.Background(), proto.MethodTemplateDelete, raw, nil); err != nil {
		t.Fatal(err)
	}
	// Isolates only: no template builds.
	iso := templateHost(t, map[string]Tier{isolate.Tier: &fakeTier{running: map[string]bool{}}}, []string{isolate.Tier})
	if f := iso.Facts(); slices.Contains(f.Features, proto.FeatureTemplateBuild) {
		t.Fatalf("features %v", f.Features)
	}
}

func TestTemplatesNeedTheMicroVMTier(t *testing.T) {
	tier := &fakeTier{running: map[string]bool{}}
	h := templateHost(t, map[string]Tier{isolate.Tier: tier}, []string{isolate.Tier})
	raw, _ := json.Marshal(proto.TemplateBuildParams{SnapshotID: "tsn_1"})
	var pe *proto.Error
	if _, err := h.Call(context.Background(), proto.MethodTemplateBuild, raw, nil); !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
		t.Fatalf("got %v", err)
	}
	create, _ := json.Marshal(proto.CreateParams{SandboxID: "sbx_1", Template: &proto.TemplateBoot{BaseImage: "kantel/sandbox"}})
	if _, err := h.Call(context.Background(), proto.MethodCreate, create, nil); !errors.As(err, &pe) || pe.Code != proto.ErrInvalid {
		t.Fatalf("an isolate from a template: %v", err)
	}
	if len(tier.created) != 0 {
		t.Fatalf("created %v", tier.created)
	}
}

// Capacity counts the tier's template builds as it counts its sandboxes, the builds' disk too, and names them, so a
// control plane holding room for one stops when a report names it (packages/hosts reservedOn): counted once.
func TestCapacityNamesTheTemplateBuildsItCounts(t *testing.T) {
	tier := &fakeTemplateTier{fakeTier: fakeTier{running: map[string]bool{}}, usedMiB: 2048}
	h := templateHost(t, map[string]Tier{microvm.Tier: tier}, []string{microvm.Tier})
	h.facts.MemoryMiB = 8192
	before := h.Capacity()
	if before.FreeMemoryMiB != 6144 || len(before.Builds) != 0 {
		t.Fatalf("capacity %+v", before)
	}
	tier.held = map[string]proto.Size{"tsn_a": {VCPUs: 2, MemoryMiB: 4096, DiskGiB: 1}}
	during := h.Capacity()
	if during.FreeMemoryMiB != 2048 || !slices.Equal(during.Builds, []string{"tsn_a"}) || during.FreeDiskGiB != max(0, before.FreeDiskGiB-1) {
		t.Fatalf("capacity during the build %+v (before %+v)", during, before)
	}
	// What the tier may use (microvm.Config.Budget) is the budget less the other tiers' use, never its own.
	iso := &fakeTier{running: map[string]bool{}}
	h.tiers[isolate.Tier] = &usedTier{fakeTier: iso, usedMiB: 512}
	if memory, _ := h.budgetBeside(microvm.Tier)(); memory != 8192-512 {
		t.Fatalf("budget %d MiB", memory)
	}
}

// usedTier is a tier whose sandboxes use usedMiB.
type usedTier struct {
	*fakeTier
	usedMiB int64
}

func (u *usedTier) Usage() (int64, int, int) { return u.usedMiB, 0, 0 }

// templateRegistry, the operator's registry templates' bases are pulled from, is read from the settings file and has no
// default: unset, the host pulls no base.
func TestTemplateRegistryIsTheSettingsFiles(t *testing.T) {
	dir := t.TempDir()
	for raw, want := range map[string]string{`{"templateRegistry": "ghcr.io/lleverage-ai"}`: "ghcr.io/lleverage-ai", `{}`: ""} {
		path := filepath.Join(dir, "config.json")
		if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		cfg, err := LoadConfig(path)
		if err != nil || cfg.TemplateRegistry != want {
			t.Fatalf("%s: templateRegistry %q %v, want %q", raw, cfg.TemplateRegistry, err, want)
		}
	}
}
