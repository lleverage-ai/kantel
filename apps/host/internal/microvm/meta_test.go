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

// sandbox.env replaces a sandbox's whole env in meta.json, stopped or running: what its identity carries from its next
// boot and what a fork with none of its own inherits. An empty one leaves none.
func TestSetEnvReplacesTheRecordedEnv(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sbx_1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	s := &sandbox{meta: meta{ID: "sbx_1", State: proto.StateStopped, Env: map[string]string{"OLD": "1"}}, dir: dir}
	m := &Manager{sandboxes: map[string]*sandbox{"sbx_1": s}}
	read := func() meta {
		raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
		if err != nil {
			t.Fatal(err)
		}
		var got meta
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	given := map[string]string{"NEW": "2"}
	if err := m.SetEnv("sbx_1", given); err != nil {
		t.Fatal(err)
	}
	given["NEW"] = "changed by the caller"
	if got := read(); len(got.Env) != 1 || got.Env["NEW"] != "2" || s.meta.Env["NEW"] != "2" || got.State != proto.StateStopped {
		t.Fatalf("meta.json %+v, in memory %v", got, s.meta.Env)
	}
	if err := m.SetEnv("sbx_1", map[string]string{}); err != nil {
		t.Fatal(err)
	}
	if got := read().Env; got != nil || s.meta.Env != nil {
		t.Fatalf("an empty env kept %v", got)
	}
	if err := m.SetEnv("sbx_nope", nil); err == nil {
		t.Fatal("an unknown sandbox's env was set")
	}
}

func TestLiveSnapshotRefusesABadIDBeforeWriting(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root}}
	for _, id := range []string{"../sandboxes/plain/vm", "a/b", "..", ""} {
		snap := proto.SnapshotInfo{ID: id}
		if _, err := m.liveSnapshot(context.Background(), nil, &snap, timings{}, true, nil); err == nil {
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
