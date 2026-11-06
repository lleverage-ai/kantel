package agent

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// keepTier is a tier holding the snapshots in has, that records the keeps it is asked.
type keepTier struct {
	Tier
	has  []string
	kept []proto.SnapshotParams
}

func (f *keepTier) HasSnapshot(id string) bool { return slices.Contains(f.has, id) }

func (f *keepTier) KeepSnapshot(_ context.Context, p proto.SnapshotParams) (proto.SnapshotInfo, error) {
	f.kept = append(f.kept, p)
	return proto.SnapshotInfo{ID: p.SnapshotID, Kind: "saved"}, nil
}

// snapshot.keep goes to the tier holding the snapshot it keeps (from), whichever tier the call names, and the host
// says it serves it.
func TestSnapshotKeepGoesToTheTierOfItsSource(t *testing.T) {
	vm, iso := &keepTier{has: []string{"snap_vm"}}, &keepTier{has: []string{"snap_iso"}}
	h := newLifecycleHost(t, newLifecycleTier())
	h.tiers = map[string]Tier{microvm.Tier: vm, isolate.Tier: iso}
	h.order = []string{microvm.Tier, isolate.Tier}
	raw, _ := json.Marshal(proto.SnapshotParams{SnapshotID: "snap_k", From: "snap_iso"})
	out, err := h.Call(context.Background(), proto.MethodSnapshotKeep, raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	if info, ok := out.(proto.SnapshotInfo); !ok || info.ID != "snap_k" {
		t.Fatalf("answer %#v", out)
	}
	if len(vm.kept) != 0 || len(iso.kept) != 1 || iso.kept[0].From != "snap_iso" {
		t.Fatalf("kept on microvm %v, isolate %v", vm.kept, iso.kept)
	}
	raw, _ = json.Marshal(proto.SnapshotParams{SnapshotID: "snap_k2", From: "snap_none"})
	if _, err := h.Call(context.Background(), proto.MethodSnapshotKeep, raw, nil); err == nil {
		t.Fatal("kept a snapshot no tier has")
	}
	if !slices.Contains(h.makeFacts().Features, proto.FeatureSnapshotKeep) {
		t.Fatal("the host doesn't say it keeps snapshots")
	}
}
