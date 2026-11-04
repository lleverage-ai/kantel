package microvm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/mounts"
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

func TestLiveSnapshotRefusesABadIDBeforeWriting(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root}}
	for _, id := range []string{"../sandboxes/plain/vm", "a/b", "..", ""} {
		snap := proto.SnapshotInfo{ID: id}
		if err := m.liveSnapshot(context.Background(), nil, &snap, timings{}); err == nil {
			t.Fatalf("liveSnapshot(%q) took it", id)
		}
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Fatalf("liveSnapshot wrote %v before refusing", entries)
	}
}

// Deleting a sandbox with mounts forgets them, and its last event doesn't make them again.
func TestDeleteForgetsMountsForGood(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sandboxes", "sbx_m")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	specs := []proto.Mount{{Path: "/mnt/x", Kind: proto.MountBucket, BucketSourceID: "bks_1"}}
	mm := mounts.New(mounts.Config{})
	var last proto.SandboxInfo
	m := &Manager{cfg: Config{Root: root, Mounts: mm, Events: func(info proto.SandboxInfo) { last = info }}}
	s := &sandbox{meta: meta{ID: "sbx_m", State: proto.StateStopped, Mounts: specs}, dir: dir}
	m.sandboxes = map[string]*sandbox{"sbx_m": s}
	if len(m.info(s).Mounts) != 1 || mm.Get("sbx_m") == nil {
		t.Fatal("a stopped sandbox's mounts aren't held")
	}
	if err := m.Delete(context.Background(), "sbx_m"); err != nil {
		t.Fatal(err)
	}
	if last.State != proto.StateDeleted {
		t.Errorf("the last event: %+v", last)
	}
	if mm.Get("sbx_m") != nil {
		t.Error("the deletion's event made the sandbox's mounts again")
	}
}
