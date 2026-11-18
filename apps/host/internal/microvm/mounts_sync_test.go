package microvm

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/mounts"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A sync waits out the kernel's cache timeout only when the guest didn't say, for a mount it synced, that the kernel
// already forgot the changed names (an older guest agent); a mount it didn't sync doesn't count.
func TestAllCurrent(t *testing.T) {
	synced := map[string]int64{"/mnt/a": 1, "/mnt/b": 2}
	for name, c := range map[string]struct {
		results []guest.MountResult
		want    bool
	}{
		"all said":       {[]guest.MountResult{{Path: "/mnt/a", Current: true}, {Path: "/mnt/b", Current: true}}, true},
		"one didn't":     {[]guest.MountResult{{Path: "/mnt/a", Current: true}, {Path: "/mnt/b"}}, false},
		"an older guest": {[]guest.MountResult{{Path: "/mnt/a"}, {Path: "/mnt/b"}}, false},
		"one not synced": {[]guest.MountResult{{Path: "/mnt/a", Current: true}, {Path: "/mnt/b", Current: true}, {Path: "/mnt/c"}}, true},
	} {
		if got := allCurrent(synced, c.results); got != c.want {
			t.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
}

// A refresh shows the guest its whole set of mounts: only the listed ones normally, but every one while the host
// still reconciles an adopted sandbox's, so a mount the guest holds whose listing the restarted host hasn't
// recovered isn't unmounted by a refresh of another.
func TestRefreshKeepsAnAdoptedSandboxsUnlistedMounts(t *testing.T) {
	store := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")
	}))
	defer store.Close()
	mm := mounts.New(mounts.Config{HTTP: store.Client(), Resolve: func(_ context.Context, _, sourceID string) (proto.BucketSource, error) {
		if sourceID != "bks_ok" {
			return proto.BucketSource{}, &proto.Error{Code: proto.ErrUnavailable, Message: "the store is away"}
		}
		return proto.BucketSource{Provider: "s3", Bucket: "b", Endpoint: store.URL, Credentials: &proto.BucketCredentials{AccessKeyID: "k", SecretAccessKey: "s"}}, nil
	}})
	mt := mm.Sandbox("sbx", []proto.Mount{
		{Path: "/mnt/ok", Kind: proto.MountBucket, BucketSourceID: "bks_ok"},
		{Path: "/mnt/away", Kind: proto.MountBucket, BucketSourceID: "bks_away"},
	})
	mt.Load(context.Background())
	s := &sandbox{}
	paths := func() []string {
		var out []string
		for _, spec := range refreshSpecs(s, mt) {
			out = append(out, spec.Path)
		}
		return out
	}
	if got := paths(); len(got) != 1 || got[0] != "/mnt/ok" {
		t.Errorf("a sandbox the host booted: %v (want only the listed mount)", got)
	}
	s.adoptedMounts.Store(true)
	if got := paths(); len(got) != 2 {
		t.Errorf("an adopted sandbox still reconciling: %v (want both, the unlisted one kept)", got)
	}
}

// A refresh's statuses reach the control plane as a mounts event (the only one it takes mount statuses from), with
// the ordering stamp, besides the sandbox's own event.
func TestARefreshSendsAMountsEvent(t *testing.T) {
	mm := mounts.New(mounts.Config{Resolve: func(context.Context, string, string) (proto.BucketSource, error) {
		return proto.BucketSource{}, &proto.Error{Code: proto.ErrUnavailable, Message: "the store is away"}
	}})
	var sandboxEvents int
	var mountEvents []proto.SandboxInfo
	m := &Manager{cfg: Config{
		Root: t.TempDir(), Mounts: mm,
		Events:      func(proto.SandboxInfo) { sandboxEvents++ },
		MountEvents: func(info proto.SandboxInfo) { mountEvents = append(mountEvents, info) },
	}}
	s := &sandbox{meta: meta{ID: "sbx", State: proto.StateRunning, Mounts: []proto.Mount{{Path: "/mnt/x", Kind: proto.MountBucket, BucketSourceID: "bks_1"}}}}
	m.mountsOf(s).Load(context.Background())
	m.emitMounts(s)
	if sandboxEvents != 1 || len(mountEvents) != 1 {
		t.Fatalf("%d sandbox events and %d mounts events (want one of each)", sandboxEvents, len(mountEvents))
	}
	got := mountEvents[0]
	if len(got.Mounts) != 1 || got.Mounts[0].State != proto.MountFailed || got.MountsAt == 0 {
		t.Errorf("the mounts event: %+v (want /mnt/x failed, stamped)", got)
	}
}
