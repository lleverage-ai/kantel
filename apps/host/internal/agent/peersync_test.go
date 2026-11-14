package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// The peer sync server listens on the mesh address while a welcome has the host in a mesh, and stops on a welcome
// without one; it checks grants against the last key a welcome gave, for the host the welcome named.
func TestPeerSyncFollowsTheWelcome(t *testing.T) {
	ln, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skip("no IPv6 loopback")
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	m := &fakeMesh{addr: netip.IPv6Loopback()}
	h := &Host{tiers: map[string]Tier{}, log: slog.New(slog.DiscardHandler), mesh: m, cfg: Config{HostID: "host_cfg"}}
	h.startPeerSync()
	h.peers.Port = port
	defer h.peers.Close()
	// keys are the server's grant keys, as "id:publicKey:until" each.
	keys := func() string {
		var out []string
		for _, k := range h.peers.Keys() {
			out = append(out, fmt.Sprintf("%s:%s:%d", k.ID, k.PublicKey, k.Until))
		}
		return strings.Join(out, " ")
	}
	if h.selfID() != "host_cfg" || keys() != "" {
		t.Fatalf("before a welcome: %q %q", h.selfID(), keys())
	}
	dial := func() error {
		c, err := net.DialTimeout("tcp", netip.AddrPortFrom(netip.IPv6Loopback(), uint16(port)).String(), time.Second)
		if err == nil {
			c.Close()
		}
		return err
	}
	if h.pool() != "" {
		t.Fatalf("a pool before a welcome: %q", h.pool())
	}
	h.applyWelcome(context.Background(), &proto.Welcome{HostID: "host_a", PoolID: "pool_a", GrantKey: "key", Mesh: &proto.WelcomeMesh{Address: "::1", Prefix: "::/48"}}, nil)
	if err := dial(); err != nil {
		t.Fatalf("not listening with the mesh up: %v", err)
	}
	if h.pool() != "pool_a" {
		t.Fatalf("the welcome's pool: %q", h.pool())
	}
	// A control plane from before rotation sends one key, with no ID.
	if h.selfID() != "host_a" || keys() != ":key:0" || h.peers.Self() != "host_a" {
		t.Fatalf("after a welcome: %q %q", h.selfID(), keys())
	}
	h.applyWelcome(context.Background(), &proto.Welcome{HostID: "host_a"}, nil)
	if err := dial(); err == nil {
		t.Fatal("still listening with the mesh down")
	}
	if keys() != ":key:0" {
		t.Fatal("a welcome without the grant key dropped it")
	}
	// A rotation: the welcome's GrantKeys replace the keys, its GrantKey (for older hosts) aside; then the old key's time is
	// up and a welcome drops it.
	rotated := []proto.GrantKey{{ID: "k2", PublicKey: "new"}, {ID: "k1", PublicKey: "key", Until: 99}}
	h.applyWelcome(context.Background(), &proto.Welcome{HostID: "host_a", GrantKey: "new", GrantKeys: rotated}, nil)
	if keys() != "k2:new:0 k1:key:99" {
		t.Fatalf("after a rotation: %q", keys())
	}
	h.applyWelcome(context.Background(), &proto.Welcome{HostID: "host_a", GrantKey: "new", GrantKeys: rotated[:1]}, nil)
	if keys() != "k2:new:0" {
		t.Fatalf("after the old key's time: %q", keys())
	}
	h.applyWelcome(context.Background(), &proto.Welcome{HostID: "host_a"}, nil)
	if keys() != "k2:new:0" {
		t.Fatalf("a welcome without grant keys dropped them: %q", keys())
	}
}

// fetchTier is a microVM tier whose sticky disk versions can be fetched: it holds v1 of disk ci.
type fetchTier struct {
	*stickyTier
	mu        sync.Mutex
	discarded []string
}

func (f *fetchTier) Usage() (int64, int, int) { return 0, 0, 0 }

func (f *fetchTier) OpenStickyVersion(string, string, bool) (*os.File, []byte, error) {
	return nil, nil, fs.ErrNotExist
}
func (f *fetchTier) HoldsSticky(diskID, version string) bool {
	return diskID == "ci" && version == "v1"
}
func (f *fetchTier) StickyPartial(diskID, version string) (string, error) {
	return "", errors.New("no partials here")
}
func (f *fetchTier) CloneNearestSticky(string, string, string) (*blockmap.Map, error) {
	return nil, nil
}
func (f *fetchTier) PublishFetchedSticky(string, string, *os.File, []byte) error { return nil }
func (f *fetchTier) ReserveStickyFetch(int64) (func(), error)                    { return func() {}, nil }
func (f *fetchTier) StickyPartials() [][2]string                                 { return nil }
func (f *fetchTier) DiscardStickyPartial(diskID, version string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.discarded = append(f.discarded, diskID+"/"+version)
}

// A host with the mesh and sticky disks reports disk-sync and takes disk.fetch, answered at once; a version it isn't
// told where to find is asked of disk.locate. One without either refuses disk.fetch.
func TestDiskFetch(t *testing.T) {
	without := newLifecycleHost(t, newLifecycleTier())
	if slices.Contains(without.makeFacts().Features, proto.FeatureDiskSync) || without.fetcher != nil {
		t.Fatal("disk-sync, or a fetcher, without the mesh")
	}
	var pe *proto.Error
	if err := call(t, without, proto.MethodDiskFetch, proto.DiskFetchParams{Kind: "sticky", ObjectID: "ci", Version: "v2"}); !errors.As(err, &pe) || pe.Code != proto.ErrUnsupported {
		t.Fatalf("without the feature: %v", err)
	}

	tier := &fetchTier{stickyTier: &stickyTier{lifecycleTier: newLifecycleTier()}}
	h := newLifecycleHost(t, tier.lifecycleTier)
	h.tiers[microvm.Tier] = tier
	h.mesh = &fakeMesh{}
	h.cfg.SyncRateMbit = -1
	located := make(chan proto.DiskLocateParams, 4)
	h.callKantel = func(ctx context.Context, method string, params any) (json.RawMessage, error) {
		if method != proto.MethodDiskLocate {
			return nil, errors.New("unexpected " + method)
		}
		located <- params.(proto.DiskLocateParams)
		return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no such version"}
	}
	h.startPeerSync()
	defer h.syncStop()
	if !slices.Contains(h.makeFacts().Features, proto.FeatureDiskSync) {
		t.Fatal("disk-sync not reported")
	}
	// None under way: reported as none, not left out.
	if raw, _ := json.Marshal(h.Capacity()); !strings.Contains(string(raw), `"fetches":[]`) {
		t.Fatalf("capacity %s", raw)
	}
	for name, c := range map[string]struct {
		p    proto.DiskFetchParams
		code string
	}{
		"another kind":   {proto.DiskFetchParams{Kind: "template", ObjectID: "ci", Version: "v1"}, proto.ErrUnsupported},
		"no version":     {proto.DiskFetchParams{Kind: "sticky", ObjectID: "ci"}, proto.ErrInvalid},
		"a version held": {proto.DiskFetchParams{Kind: "sticky", ObjectID: "ci", Version: "v1"}, ""},
	} {
		err := call(t, h, proto.MethodDiskFetch, c.p)
		if c.code == "" && err != nil || c.code != "" && (!errors.As(err, &pe) || pe.Code != c.code) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// Held already: nothing asked.
	select {
	case p := <-located:
		t.Fatalf("located %+v for a version held", p)
	case <-time.After(100 * time.Millisecond):
	}
	// A create's version not held: asked of disk.locate, and dropped as the control plane has no such version.
	h.fetchStickyLater("ci", "v2")
	select {
	case p := <-located:
		if p != (proto.DiskLocateParams{Kind: "sticky", ObjectID: "ci", Version: "v2"}) {
			t.Fatalf("located %+v", p)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("disk.locate not asked")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		tier.mu.Lock()
		got := slices.Clone(tier.discarded)
		tier.mu.Unlock()
		// v1's partial too: a version held keeps none.
		if slices.Contains(got, "ci/v1") && slices.Contains(got, "ci/v2") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("discarded %v", got)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// rootfsFetchTier is a microVM tier whose templates' root filesystems sync too: it holds root filesystem k1.
type rootfsFetchTier struct {
	*fetchTier
}

func (r *rootfsFetchTier) Usage() (int64, int, int) { return 0, 0, 0 }

func (r *rootfsFetchTier) HoldsRootfs(key, version string) bool { return key == "k1" && version == "1" }
func (r *rootfsFetchTier) OpenRootfs(string, string, bool) (*os.File, []byte, error) {
	return nil, nil, fs.ErrNotExist
}
func (r *rootfsFetchTier) ReadRootfsFile(string, string, string) ([]byte, error) {
	return nil, fs.ErrNotExist
}
func (r *rootfsFetchTier) RootfsPartial(string, string) (string, error) {
	return "", errors.New("no partials here")
}
func (r *rootfsFetchTier) PublishFetchedRootfs(string, string, *os.File, []byte, map[string][]byte) error {
	return nil
}
func (r *rootfsFetchTier) RootfsPartials() []string                 { return nil }
func (r *rootfsFetchTier) ReserveRootfsFetch(int64) (func(), error) { return func() {}, nil }
func (r *rootfsFetchTier) DiscardRootfsPartial(key string)          { r.DiscardStickyPartial("rootfs", key) }
func (r *rootfsFetchTier) RootfsHoldings() []proto.ObjectHolding {
	return []proto.ObjectHolding{{ObjectID: "k1", Versions: []proto.ObjectVersionHolding{{Version: "1", MapDigest: "sha256:1"}}}}
}

// A host whose microVM tier has templates' root filesystems, with the mesh, reports rootfs-sync and the root
// filesystems it holds, and takes disk.fetch for them; without the mesh it does neither.
func TestRootfsSync(t *testing.T) {
	tier := &rootfsFetchTier{fetchTier: &fetchTier{stickyTier: &stickyTier{lifecycleTier: newLifecycleTier()}}}
	without := newLifecycleHost(t, tier.lifecycleTier)
	without.tiers[microvm.Tier] = tier
	if slices.Contains(without.makeFacts().Features, proto.FeatureRootfsSync) || without.Capacity().Holdings != nil {
		t.Fatal("rootfs-sync, or holdings, without the mesh")
	}

	h := newLifecycleHost(t, tier.lifecycleTier)
	h.tiers[microvm.Tier] = tier
	h.mesh = &fakeMesh{}
	h.cfg.SyncRateMbit = -1
	located := make(chan proto.DiskLocateParams, 4)
	h.callKantel = func(ctx context.Context, method string, params any) (json.RawMessage, error) {
		located <- params.(proto.DiskLocateParams)
		return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no such version"}
	}
	h.startPeerSync()
	defer h.syncStop()
	features := h.makeFacts().Features
	if !slices.Contains(features, proto.FeatureRootfsSync) || !slices.Contains(features, proto.FeatureDiskSync) {
		t.Fatalf("features %v", features)
	}
	held := h.Capacity().Holdings[proto.DiskKindRootfs]
	if len(held) != 1 || held[0].ObjectID != "k1" || held[0].Versions[0].MapDigest != "sha256:1" {
		t.Fatalf("holdings %+v", held)
	}
	if err := call(t, h, proto.MethodDiskFetch, proto.DiskFetchParams{Kind: "rootfs", ObjectID: "k1", Version: "1"}); err != nil {
		t.Fatalf("a root filesystem held: %v", err)
	}
	if err := call(t, h, proto.MethodDiskFetch, proto.DiskFetchParams{Kind: "rootfs", ObjectID: "k2", Version: "1"}); err != nil {
		t.Fatalf("a root filesystem not held: %v", err)
	}
	select {
	case p := <-located:
		if p != (proto.DiskLocateParams{Kind: "rootfs", ObjectID: "k2", Version: "1"}) {
			t.Fatalf("located %+v", p)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("disk.locate not asked")
	}
}

// templateFetchTier is a microVM tier whose template snapshots sync too: it holds template snapshot tsn_1.
type templateFetchTier struct {
	*rootfsFetchTier
}

func (r *templateFetchTier) HoldsTemplate(id, version string) bool {
	return id == "tsn_1" && version == "1"
}
func (r *templateFetchTier) OpenTemplatePart(string, string, string, bool) (*os.File, []byte, error) {
	return nil, nil, fs.ErrNotExist
}
func (r *templateFetchTier) ReadTemplateFile(string, string, string) ([]byte, error) {
	return nil, fs.ErrNotExist
}
func (r *templateFetchTier) TemplatePartPartial(string, string, string) (string, error) {
	return "", errors.New("no partials here")
}
func (r *templateFetchTier) PublishFetchedTemplate(string, string, map[string]disksync.FetchedPart, map[string][]byte) error {
	return nil
}
func (r *templateFetchTier) TemplatePartials() []string                 { return nil }
func (r *templateFetchTier) ReserveTemplateFetch(int64) (func(), error) { return func() {}, nil }
func (r *templateFetchTier) DiscardTemplateFetch(string)                {}
func (r *templateFetchTier) TemplateHoldings() []proto.ObjectHolding {
	return []proto.ObjectHolding{{ObjectID: "tsn_1", Versions: []proto.ObjectVersionHolding{{Version: "1", MapDigest: "sha256:2", Runtime: "firecracker=v1"}}}}
}

// A host whose microVM tier has template snapshots, with the mesh, reports template-sync and the snapshots it holds
// beside its root filesystems, and a build's fetch asks disk.locate for the snapshot's one version, answering that
// none holds it when none does; without the mesh it does none of that.
func TestTemplateSync(t *testing.T) {
	tier := &templateFetchTier{&rootfsFetchTier{fetchTier: &fetchTier{stickyTier: &stickyTier{lifecycleTier: newLifecycleTier()}}}}
	without := newLifecycleHost(t, tier.lifecycleTier)
	without.tiers[microvm.Tier] = tier
	if slices.Contains(without.makeFacts().Features, proto.FeatureTemplateSync) ||
		slices.Contains(without.makeFacts().Features, proto.FeatureTemplateImageCopies) || without.Capacity().Holdings != nil {
		t.Fatal("template-sync, or holdings, without the mesh")
	}
	if err := without.fetchTemplate(context.Background(), "tsn_2"); !errors.Is(err, microvm.ErrNoPeerTemplate) {
		t.Fatalf("a fetch without the mesh: %v", err)
	}

	h := newLifecycleHost(t, tier.lifecycleTier)
	h.tiers[microvm.Tier] = tier
	h.mesh = &fakeMesh{up: true}
	h.cfg.SyncRateMbit = -1
	located := make(chan proto.DiskLocateParams, 4)
	h.callKantel = func(ctx context.Context, method string, params any) (json.RawMessage, error) {
		located <- params.(proto.DiskLocateParams)
		return json.RawMessage(`{"holders":[]}`), nil
	}
	h.startPeerSync()
	defer h.syncStop()
	if !slices.Contains(h.makeFacts().Features, proto.FeatureTemplateSync) ||
		!slices.Contains(h.makeFacts().Features, proto.FeatureTemplateImageCopies) {
		t.Fatalf("features %v", h.makeFacts().Features)
	}
	holdings := h.Capacity().Holdings
	if held := holdings[proto.DiskKindTemplate]; len(held) != 1 || held[0].ObjectID != "tsn_1" || held[0].Versions[0].Runtime != "firecracker=v1" {
		t.Fatalf("holdings %+v", holdings)
	}
	if len(holdings[proto.DiskKindRootfs]) != 1 {
		t.Fatalf("the root filesystems went: %+v", holdings)
	}
	h.mu.Lock()
	h.link = &caller{}
	h.mu.Unlock()
	if err := h.fetchTemplate(context.Background(), "tsn_2"); !errors.Is(err, microvm.ErrNoPeerTemplate) {
		t.Fatalf("a fetch none holds: %v", err)
	}
	select {
	case p := <-located:
		if p != (proto.DiskLocateParams{Kind: "template", ObjectID: "tsn_2", Version: "1"}) {
			t.Fatalf("located %+v", p)
		}
	default:
		t.Fatal("disk.locate not asked")
	}
	// A control plane from before template snapshots were objects refuses the kind: none to fetch, not a failure.
	h.callKantel = func(context.Context, string, any) (json.RawMessage, error) {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "Kantel keeps no copies of template objects yet"}
	}
	if err := h.fetchTemplate(context.Background(), "tsn_2"); !errors.Is(err, microvm.ErrNoPeerTemplate) {
		t.Fatalf("an older control plane: %v", err)
	}
	if got := (peerStore{h}).Parts(proto.DiskKindTemplate); !slices.Equal(got, microvm.TemplateParts) {
		t.Fatalf("parts %v", got)
	}
}

// snapshotFetchTier is a microVM tier whose saved snapshots sync too: it holds snapshot s1's disk, without the memory,
// which it wants, and records the fetches made ready.
type snapshotFetchTier struct {
	*rootfsFetchTier
	prepared []string
}

func (s *snapshotFetchTier) HoldsSnapshot(id, version string) bool {
	return id == "s1" && version == microvm.SnapshotDisk
}
func (s *snapshotFetchTier) OpenSnapshot(string, string, bool) (*os.File, []byte, error) {
	return nil, nil, fs.ErrNotExist
}
func (s *snapshotFetchTier) ReadSnapshotFile(string, string, string) ([]byte, error) {
	return nil, fs.ErrNotExist
}
func (s *snapshotFetchTier) PrepareSnapshotFetch(_ context.Context, id string, _ []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prepared = append(s.prepared, id)
	return nil
}
func (s *snapshotFetchTier) WantsSnapshotMemory(id string) bool { return id == "s1" }
func (s *snapshotFetchTier) SnapshotPartial(string, string) (string, error) {
	return "", errors.New("no partials here")
}
func (s *snapshotFetchTier) PublishFetchedSnapshot(string, string, *os.File, []byte, map[string][]byte) error {
	return nil
}
func (s *snapshotFetchTier) SnapshotPartials() [][2]string              { return nil }
func (s *snapshotFetchTier) ReserveSnapshotFetch(int64) (func(), error) { return func() {}, nil }
func (s *snapshotFetchTier) DiscardSnapshotPartial(id, version string) {
	s.DiscardStickyPartial("snapshot", id+"/"+version)
}
func (s *snapshotFetchTier) SnapshotHoldings() []proto.ObjectHolding {
	return []proto.ObjectHolding{{ObjectID: "s1", Versions: []proto.ObjectVersionHolding{{Version: "disk", MapDigest: "sha256:2"}}}}
}

// A host whose microVM tier has saved snapshots, with the mesh, reports snapshot-sync and the snapshots it holds beside
// its root filesystems, and takes disk.fetch for a snapshot: its disk once the snapshot's record from a holder has made
// the fetch ready, and its memory, which it asks for itself once it holds the disk.
func TestSnapshotSync(t *testing.T) {
	tier := &snapshotFetchTier{rootfsFetchTier: &rootfsFetchTier{fetchTier: &fetchTier{stickyTier: &stickyTier{lifecycleTier: newLifecycleTier()}}}}
	without := newLifecycleHost(t, tier.lifecycleTier)
	without.tiers[microvm.Tier] = tier
	if slices.Contains(without.makeFacts().Features, proto.FeatureSnapshotSync) || without.Capacity().Holdings != nil {
		t.Fatal("snapshot-sync, or holdings, without the mesh")
	}

	h := newLifecycleHost(t, tier.lifecycleTier)
	h.tiers[microvm.Tier] = tier
	h.mesh = &fakeMesh{}
	h.cfg.SyncRateMbit = -1
	located := make(chan proto.DiskLocateParams, 8)
	h.callKantel = func(ctx context.Context, method string, params any) (json.RawMessage, error) {
		located <- params.(proto.DiskLocateParams)
		return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no such snapshot"}
	}
	h.startPeerSync()
	defer h.syncStop()
	if !slices.Contains(h.makeFacts().Features, proto.FeatureSnapshotSync) {
		t.Fatal("snapshot-sync not reported")
	}
	holdings := h.Capacity().Holdings
	if len(holdings[proto.DiskKindRootfs]) != 1 || len(holdings[proto.DiskKindSnapshot]) != 1 || holdings[proto.DiskKindSnapshot][0].ObjectID != "s1" {
		t.Fatalf("holdings %+v", holdings)
	}
	kinds := h.syncKinds()
	if got := kinds.Files(disksyncRef("s1", "disk")); !slices.Equal(got, []string{microvm.SnapshotRecordFile}) {
		t.Fatalf("a disk's files %v", got)
	}
	if got := kinds.Files(disksyncRef("s1", "memory")); !slices.Equal(got, []string{microvm.SnapshotStateFile}) {
		t.Fatalf("a memory's files %v", got)
	}
	var pe *proto.Error
	for name, c := range map[string]struct {
		p    proto.DiskFetchParams
		code string
	}{
		"another version":   {proto.DiskFetchParams{Kind: "snapshot", ObjectID: "s1", Version: "1"}, proto.ErrInvalid},
		"memory not wanted": {proto.DiskFetchParams{Kind: "snapshot", ObjectID: "s2", Version: "memory"}, proto.ErrConflict},
		"a disk not held":   {proto.DiskFetchParams{Kind: "snapshot", ObjectID: "s2", Version: "disk"}, ""},
		"a disk held":       {proto.DiskFetchParams{Kind: "snapshot", ObjectID: "s1", Version: "disk"}, ""},
	} {
		if err := call(t, h, proto.MethodDiskFetch, c.p); c.code == "" && err != nil || c.code != "" && (!errors.As(err, &pe) || pe.Code != c.code) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// s2's disk: its record is asked for where disk.locate says, which has no such snapshot, so its fetch isn't made
	// ready. s1's disk is here: its memory is asked for.
	want := map[proto.DiskLocateParams]bool{
		{Kind: "snapshot", ObjectID: "s2", Version: "disk"}:   true,
		{Kind: "snapshot", ObjectID: "s1", Version: "memory"}: true,
	}
	for len(want) > 0 {
		select {
		case p := <-located:
			if !want[p] {
				t.Fatalf("located %+v", p)
			}
			delete(want, p)
		case <-time.After(5 * time.Second):
			t.Fatalf("not located: %v", want)
		}
	}
	time.Sleep(50 * time.Millisecond)
	tier.mu.Lock()
	defer tier.mu.Unlock()
	if len(tier.prepared) != 0 {
		t.Fatalf("made ready %v", tier.prepared)
	}
}

func disksyncRef(id, version string) disksync.Ref {
	return disksync.Ref{Kind: proto.DiskKindSnapshot, ObjectID: id, Version: version}
}

// A snapshot's memory that no host holds yet when its disk arrives (its holder hasn't reported it) is asked for again a
// while later; once the control plane has no such snapshot, no more.
func TestSnapshotMemoryAskedAgain(t *testing.T) {
	defer func(wait time.Duration) { snapshotMemoryRetry = wait }(snapshotMemoryRetry)
	snapshotMemoryRetry = 10 * time.Millisecond
	tier := &snapshotFetchTier{rootfsFetchTier: &rootfsFetchTier{fetchTier: &fetchTier{stickyTier: &stickyTier{lifecycleTier: newLifecycleTier()}}}}
	h := newLifecycleHost(t, tier.lifecycleTier)
	h.tiers[microvm.Tier] = tier
	h.mesh = &fakeMesh{}
	h.cfg.SyncRateMbit = -1
	var mu sync.Mutex
	asked := 0
	h.callKantel = func(ctx context.Context, method string, params any) (json.RawMessage, error) {
		mu.Lock()
		defer mu.Unlock()
		if p := params.(proto.DiskLocateParams); p.Version != microvm.SnapshotMemory {
			return nil, fmt.Errorf("located %+v", p)
		}
		asked++
		if asked < 3 {
			return json.RawMessage(`{"holders":[]}`), nil
		}
		return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no such snapshot"}
	}
	h.startPeerSync()
	defer h.syncStop()
	done := make(chan struct{})
	go func() {
		h.fetchSnapshotMemory("s1")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("still asking")
	}
	mu.Lock()
	defer mu.Unlock()
	if asked != 3 {
		t.Fatalf("asked %d times", asked)
	}
}

// Just before a fetched snapshot's version is published, Kantel is asked whether it still has the snapshot: one it
// doesn't (deleted while it was fetched) is refused as not_found, which the fetcher takes to discard the fetch.
func TestSnapshotPublishedOnlyWhileKantelHasIt(t *testing.T) {
	tier := &snapshotFetchTier{rootfsFetchTier: &rootfsFetchTier{fetchTier: &fetchTier{stickyTier: &stickyTier{lifecycleTier: newLifecycleTier()}}}}
	h := newLifecycleHost(t, tier.lifecycleTier)
	h.tiers[microvm.Tier] = tier
	h.mesh = &fakeMesh{}
	h.cfg.SyncRateMbit = -1
	gone := true
	h.callKantel = func(ctx context.Context, method string, params any) (json.RawMessage, error) {
		if gone {
			return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no such saved snapshot"}
		}
		return json.RawMessage(`{"holders":[]}`), nil
	}
	h.startPeerSync()
	defer h.syncStop()
	ref := disksyncRef("s3", "disk")
	if err := h.syncKinds().Publish(ref, nil, nil, nil); !disksync.IsNotFound(err) {
		t.Fatalf("published a snapshot Kantel no longer has: %v", err)
	}
	gone = false
	if err := h.syncKinds().Publish(ref, nil, nil, nil); err != nil {
		t.Fatalf("a snapshot Kantel has: %v", err)
	}
}
