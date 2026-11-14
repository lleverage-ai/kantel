package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// moveTier is a microVM tier whose stopped sandboxes move too: it records the exports, the imports made ready and the
// sandboxes deleted as moved.
type moveTier struct {
	*snapshotFetchTier
	exported []string
	prepared []string
	moved    []string
	// made are the sandboxes each version made here, which its cancel deletes.
	made map[string]string
}

func (s *moveTier) ExportSandbox(_ context.Context, p proto.SandboxExportParams) (proto.SandboxExportResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.exported = append(s.exported, p.SandboxID+"/"+p.Version)
	return proto.SandboxExportResult{MapDigest: "sha256:export"}, nil
}
func (s *moveTier) DeleteSandboxExport(string, string) error { return nil }
func (s *moveTier) HoldsSandbox(string, string) bool         { return false }
func (s *moveTier) OpenSandboxPart(string, string, string, bool) (*os.File, []byte, error) {
	return nil, nil, os.ErrNotExist
}
func (s *moveTier) ReadSandboxFile(string, string, string) ([]byte, error) {
	return nil, os.ErrNotExist
}
func (s *moveTier) ImportGeneration(string) uint64 { return 0 }
func (s *moveTier) PrepareSandboxImport(_ context.Context, id, version string, _ uint64, _ []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prepared = append(s.prepared, id+"/"+version)
	return nil
}
func (s *moveTier) SandboxPartPartial(string, string, string) (string, error) {
	return "", errors.New("no partials here")
}
func (s *moveTier) PublishFetchedSandbox(string, string, map[string]disksync.FetchedPart) error {
	return nil
}
func (s *moveTier) ImportedSandbox(id, _ string) (proto.SandboxInfo, error) {
	return proto.SandboxInfo{ID: id, State: proto.StateStopped}, nil
}
func (s *moveTier) SandboxImportPartials() [][2]string        { return nil }
func (s *moveTier) ReserveSandboxFetch(int64) (func(), error) { return func() {}, nil }
func (s *moveTier) DiscardSandboxImport(string, string)       {}
func (s *moveTier) CancelSandboxImport(id, version string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.made[id] == version, nil
}
func (s *moveTier) DeleteExported(id, _ string) error { return s.DeleteMoved(id) }
func (s *moveTier) DeleteMoved(id string) error {
	s.mu.Lock()
	s.moved = append(s.moved, id)
	s.mu.Unlock()
	return s.Delete(context.Background(), id)
}

// A host whose microVM tier moves sandboxes reports sandbox-move with the mesh and snapshot sync, and not without;
// exports a sandbox under its lifecycle lock; asks a holder for an import's record before it makes the import ready,
// so one no holder has (disk.locate: none) is refused with nothing made ready; and deletes a moved sandbox with its
// snapshots kept.
func TestSandboxMove(t *testing.T) {
	newTier := func() *moveTier {
		return &moveTier{snapshotFetchTier: &snapshotFetchTier{rootfsFetchTier: &rootfsFetchTier{fetchTier: &fetchTier{stickyTier: &stickyTier{lifecycleTier: newLifecycleTier()}}}}}
	}
	tier := newTier()
	tier.made = map[string]string{"sb4": "mov_4"}
	without := newLifecycleHost(t, tier.lifecycleTier)
	without.tiers[microvm.Tier] = tier
	if slices.Contains(without.makeFacts().Features, proto.FeatureSandboxMove) {
		t.Fatal("sandbox-move without the mesh")
	}
	var pe *proto.Error
	if err := call(t, without, proto.MethodSandboxExport, proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
		t.Fatalf("an export without the mesh: %v", err)
	}

	h := newLifecycleHost(t, tier.lifecycleTier)
	h.tiers[microvm.Tier] = tier
	h.mesh = &fakeMesh{}
	h.cfg.SyncRateMbit = -1
	h.callKantel = func(context.Context, string, any) (json.RawMessage, error) {
		return json.Marshal(proto.DiskLocateResult{Holders: []proto.DiskHolder{}})
	}
	h.startPeerSync()
	defer h.syncStop()
	if !slices.Contains(h.makeFacts().Features, proto.FeatureSandboxMove) {
		t.Fatal("sandbox-move not reported")
	}
	if got := h.syncKinds().Parts(proto.DiskKindSandbox); !slices.Equal(got, microvm.SandboxParts) {
		t.Fatalf("a moved sandbox's parts %v", got)
	}
	if err := call(t, h, proto.MethodSandboxExport, proto.SandboxExportParams{SandboxID: "sb1", Version: "mov_1"}); err != nil {
		t.Fatal(err)
	}
	if err := call(t, h, proto.MethodSandboxImport, proto.SandboxImportParams{SandboxID: "sb2", Version: "mov_2"}); err == nil {
		t.Fatal("imported with no holder")
	}
	tier.lifecycleTier.stopped["sb3"] = true
	if err := call(t, h, proto.MethodDelete, proto.DeleteParams{SandboxID: "sb3", KeepSnapshots: true}); err != nil {
		t.Fatal(err)
	}
	// A cancel that deleted the sandbox its move made here lets go of what the host kept of it; one of another move's
	// sandbox leaves that.
	for _, id := range []string{"sb4", "sb5"} {
		h.floorMu.Lock()
		if h.floors == nil {
			h.floors = map[string]int64{}
		}
		h.floors[id] = 7
		h.floorMu.Unlock()
		if err := call(t, h, proto.MethodSandboxImportCancel, proto.SandboxExportParams{SandboxID: id, Version: "mov_4"}); err != nil {
			t.Fatal(err)
		}
	}
	h.floorMu.Lock()
	_, kept4 := h.floors["sb4"]
	_, kept5 := h.floors["sb5"]
	h.floorMu.Unlock()
	if kept4 || !kept5 {
		t.Fatalf("after the cancels, sb4's floor kept %v, sb5's %v", kept4, kept5)
	}
	// A source's late cleanup (by its move's export, or of a tier) finds nothing of its own where the host has only a
	// later move's import under way, or a sandbox of another tier: refused, nothing deleted.
	for name, p := range map[string]proto.DeleteParams{
		"an exported copy not here": {SandboxID: "sb6", KeepSnapshots: true, Exported: "mov_1"},
		"an isolate not here":       {SandboxID: "sb6", KeepSnapshots: true, Tier: "isolate"},
	} {
		if err := call(t, h, proto.MethodDelete, p); !errors.As(err, &pe) || pe.Code != proto.ErrNotFound {
			t.Errorf("%s: %v", name, err)
		}
	}
	tier.lifecycleTier.stopped["sb7"] = true
	if err := call(t, h, proto.MethodDelete, proto.DeleteParams{SandboxID: "sb7", KeepSnapshots: true, Tier: "isolate"}); !errors.As(err, &pe) || pe.Code != proto.ErrNotFound {
		t.Fatalf("an isolate's cleanup of a microVM: %v", err)
	}
	if _, err := tier.lifecycleTier.Get("sb7"); err != nil {
		t.Fatal("an isolate's cleanup deleted a microVM")
	}
	tier.mu.Lock()
	defer tier.mu.Unlock()
	if !slices.Equal(tier.exported, []string{"sb1/mov_1"}) || len(tier.prepared) != 0 || !slices.Equal(tier.moved, []string{"sb3"}) {
		t.Fatalf("exported %v, made ready %v, deleted as moved %v", tier.exported, tier.prepared, tier.moved)
	}
}
