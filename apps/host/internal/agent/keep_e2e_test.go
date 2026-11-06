package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A kept copy is judged for E2E on when its source's state was taken, not when it was copied: after a sandbox ID is
// deleted and made again under E2E, keeping a snapshot of its earlier incarnation (one the gateway could have prepared)
// makes no snapshot a new E2E sandbox may start from, while a copy of the new incarnation's own snapshot stays usable.
// Real isolate files, and the host's E2E store.
func TestAKeptSnapshotKeepsItsSourcesE2EProvenance(t *testing.T) {
	h, _, v := e2eHost(t)
	root := t.TempDir()
	iso, err := isolate.New(isolate.Config{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(iso.Close)
	h.tiers[isolate.Tier] = iso
	h.order = append(h.order, isolate.Tier)
	write := func(id string, createdAt int64) {
		dir := filepath.Join(root, "snapshots", id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		files := map[string]any{
			"manifest.json": map[string]any{"/home/user/a": map[string]any{"kind": "file", "sha": id, "size": 1}},
			"meta.json":     map[string]any{"id": id, "sandboxId": "sbx_reused", "kind": "auto", "createdAt": createdAt, "tier": isolate.Tier, "owner": v.Space},
		}
		for name, body := range files {
			raw, _ := json.Marshal(body)
			if err := os.WriteFile(filepath.Join(dir, name), raw, 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	born := time.Now().Add(-10 * time.Second).UnixMilli()
	// The ID's earlier incarnation's snapshot, from before the one made under E2E now.
	write("snap_before", born-60_000)
	if err := h.e2e.RecordBorn("sbx_reused", e2e.Born{Space: v.Space, OnSince: h.onSince(v.Space), At: born}); err != nil {
		t.Fatal(err)
	}
	write("snap_since", born+1)
	keep := func(from, id string) proto.SnapshotInfo {
		t.Helper()
		raw, _ := json.Marshal(proto.SnapshotParams{SnapshotID: id, From: from})
		out, err := h.Call(context.Background(), proto.MethodSnapshotKeep, raw, nil)
		if err != nil {
			t.Fatal(err)
		}
		return out.(proto.SnapshotInfo)
	}
	if h.snapshotBorn(iso, "snap_before", v.Space) {
		t.Fatal("the earlier incarnation's snapshot passes as born under E2E")
	}
	old := keep("snap_before", "snap_kept_before")
	if old.CreatedAt <= born || old.TakenAt != born-60_000 {
		t.Fatalf("kept %+v: want its own save time and its source's taken time", old)
	}
	if h.snapshotBorn(iso, "snap_kept_before", v.Space) {
		t.Fatal("a copy made now of the earlier incarnation's files passes as born under E2E")
	}
	keep("snap_since", "snap_kept_since")
	if !h.snapshotBorn(iso, "snap_kept_since", v.Space) {
		t.Fatal("a copy of a snapshot taken under E2E isn't usable")
	}
}
