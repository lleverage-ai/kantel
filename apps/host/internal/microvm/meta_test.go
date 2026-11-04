package microvm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A boot that got its sandbox running but couldn't write meta.json failed; its retry finds it running, and saves
// what it holds before it answers, so a restart doesn't bring back the egress from before. A retry with nothing
// unsaved changes nothing.
func TestARetriedBootSavesWhatTheFailedOneCouldNot(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sbx_1")
	egress := &proto.Egress{Mode: "proxy", Revision: 30}
	s := &sandbox{meta: meta{ID: "sbx_1", State: proto.StateRunning, Egress: egress}, dir: dir, unsaved: true}
	m := &Manager{sandboxes: map[string]*sandbox{"sbx_1": s}}
	// The disk is still unwritable (its directory isn't there): the retry fails too.
	if _, err := m.Resume(context.Background(), proto.ResumeParams{SandboxID: "sbx_1"}, false); err == nil {
		t.Fatal("a retry acknowledged an egress it couldn't save")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Resume(context.Background(), proto.ResumeParams{SandboxID: "sbx_1"}, false); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		t.Fatalf("the retry didn't save it: %v", err)
	}
	var saved meta
	if err := json.Unmarshal(raw, &saved); err != nil || saved.Egress == nil || saved.Egress.Revision != 30 {
		t.Fatalf("saved %s (%v)", raw, err)
	}
	// Saved, a retry writes nothing.
	if err := os.Remove(filepath.Join(dir, "meta.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Resume(context.Background(), proto.ResumeParams{SandboxID: "sbx_1"}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "meta.json")); !os.IsNotExist(err) {
		t.Fatalf("a no-op retry wrote meta.json: %v", err)
	}
}
