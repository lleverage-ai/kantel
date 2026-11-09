package agent

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func TestFetchBundle(t *testing.T) {
	digest := "sha256:" + strings.Repeat("ab", 32)
	var got *http.Request
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(context.Background())
		if r.URL.Query().Get("sandboxId") == "sb-gone" {
			http.Error(w, `{"error":{"code":"not_found","message":"no such bundle for sb-gone"}}`, http.StatusNotFound)
			return
		}
		io.WriteString(w, "tar bytes")
	}))
	defer cp.Close()
	h := &Host{cfg: Config{ControlPlane: cp.URL + "/", Credential: "khc_secret"}, version: "1.2.3"}

	body, err := h.fetchBundle(context.Background(), "sb 1", digest)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(body)
	body.Close()
	if string(raw) != "tar bytes" {
		t.Fatalf("got %q", raw)
	}
	if got.URL.Path != "/v1/hosts/bundles/"+digest || got.URL.Query().Get("sandboxId") != "sb 1" {
		t.Fatalf("asked for %s", got.URL)
	}
	if got.Header.Get("Authorization") != "Bearer khc_secret" || got.Header.Get("Kantel-Host-Version") != "1.2.3" {
		t.Fatalf("headers %v", got.Header)
	}

	_, err = h.fetchBundle(context.Background(), "sb-gone", digest)
	if err == nil || !strings.Contains(err.Error(), "404") || !strings.Contains(err.Error(), "no such bundle") {
		t.Fatalf("a refusal says why: %v", err)
	}
	if strings.Contains(err.Error(), "khc_secret") {
		t.Fatal("an error never holds the credential")
	}

	none := &Host{cfg: Config{}}
	if _, err := none.fetchBundle(context.Background(), "sb", digest); err == nil {
		t.Fatal("a host with no control plane can't fetch")
	}
}

// bundleTier is a tier that takes bundle mounts.
// listTier lists fixed sandboxes.
type listTier struct {
	Tier
	list []proto.SandboxInfo
}

func (l listTier) List() []proto.SandboxInfo { return l.list }

// A connection replays the mounts that settled while no connection carried their events, and only those: a pending
// one Kantel has already, and replaying it could overwrite the event that settles it.
func TestReplayMountsSendsSettledOnes(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	h.tiers["microvm"] = listTier{list: []proto.SandboxInfo{
		{ID: "a", Mounts: []proto.MountStatus{
			{Path: "/x", Kind: proto.MountBundle, State: proto.MountReady},
			{Path: "/y", Kind: proto.MountBundle, State: proto.MountPending},
			{Path: "/z", Kind: proto.MountBundle, State: proto.MountFailed, Error: "404"},
		}},
		{ID: "b", Mounts: []proto.MountStatus{{Path: "/x", Kind: proto.MountBundle, State: proto.MountPending}}},
		{ID: "c"},
	}}
	h.order = []string{"microvm"}
	var got []proto.Event
	h.events = func(e proto.Event) { got = append(got, e) }
	h.replayMounts()
	if len(got) != 1 || got[0].Kind != proto.EventMounts || got[0].Sandbox == nil || got[0].Sandbox.ID != "a" {
		t.Fatalf("one event, for the sandbox with settled mounts: %+v", got)
	}
	if m := got[0].Sandbox.Mounts; len(m) != 2 || m[0].Path != "/x" || m[1].Path != "/z" || m[1].Error != "404" {
		t.Fatalf("its ready and failed mounts, not the pending one: %+v", m)
	}
}

// A connection replays each running sandbox's guest health and each exit the host didn't cause by a call, so one in
// the handshake (after the hello's read, before events were wired) still reaches Kantel; a stop Kantel asked for (no
// error) and a running sandbox without a stamp aren't sent.
func TestReplayHealthSendsHealthAndExits(t *testing.T) {
	h := newLifecycleHost(t, newLifecycleTier())
	h.tiers["microvm"] = listTier{list: []proto.SandboxInfo{
		{ID: "running", State: proto.StateRunning, HealthAt: 10},
		{ID: "unstamped", State: proto.StateRunning},
		{ID: "ended", State: proto.StateStopped, Error: "the VM exited", HealthAt: 20},
		{ID: "failed", State: proto.StateError, Error: "it couldn't boot", HealthAt: 30},
		{ID: "stopped", State: proto.StateStopped, HealthAt: 40},
	}}
	h.order = []string{"microvm"}
	var got []string
	h.events = func(e proto.Event) {
		if e.Kind == "sandbox" && e.Sandbox != nil {
			got = append(got, e.Sandbox.ID)
		}
	}
	h.replayHealth()
	if strings.Join(got, ",") != "running,ended,failed" {
		t.Fatalf("replayed %v, want running,ended,failed", got)
	}
}

type bundleTier struct{ *lifecycleTier }

func (bundleTier) SupportsMount(kind string) bool { return kind == proto.MountBundle }

func TestMountsATierCantTakeAreRefused(t *testing.T) {
	bundle := []proto.Mount{{Path: "/workspace/skills", Kind: proto.MountBundle, Digest: "sha256:" + strings.Repeat("0", 64)}}
	bucket := []proto.Mount{{Path: "/data", Kind: proto.MountBucket, BucketSourceID: "bs_1"}}

	// A tier with no mounts at all (the isolate tier, or a microVM tier on a host without mkfs.erofs).
	h := newLifecycleHost(t, newLifecycleTier())
	err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sb", Tier: "microvm", Mounts: bundle})
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
		t.Fatalf("refused as unsupported, not ignored: %v", err)
	}

	// A tier with bundle mounts refuses a kind it hasn't.
	h = newLifecycleHost(t, newLifecycleTier())
	h.tiers["microvm"] = bundleTier{newLifecycleTier()}
	if err := call(t, h, proto.MethodCreate, proto.CreateParams{SandboxID: "sb", Tier: "microvm", Mounts: bucket}); !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
		t.Fatalf("a bucket mount on a bundles-only tier: %v", err)
	}
	if !supportsMounts(h.tiers["microvm"], bundle...) || supportsMounts(h.tiers["microvm"], append(bundle, bucket...)...) {
		t.Fatal("supportsMounts takes a list only when it takes every kind in it")
	}
}
