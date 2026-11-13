package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
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
	if h.selfID() != "host_cfg" || h.peers.Key() != "" {
		t.Fatalf("before a welcome: %q %q", h.selfID(), h.peers.Key())
	}
	dial := func() error {
		c, err := net.DialTimeout("tcp", netip.AddrPortFrom(netip.IPv6Loopback(), uint16(port)).String(), time.Second)
		if err == nil {
			c.Close()
		}
		return err
	}
	h.applyWelcome(context.Background(), &proto.Welcome{HostID: "host_a", GrantKey: "key", Mesh: &proto.WelcomeMesh{Address: "::1", Prefix: "::/48"}}, nil)
	if err := dial(); err != nil {
		t.Fatalf("not listening with the mesh up: %v", err)
	}
	if h.selfID() != "host_a" || h.peers.Key() != "key" || h.peers.Self() != "host_a" {
		t.Fatalf("after a welcome: %q %q", h.selfID(), h.peers.Key())
	}
	h.applyWelcome(context.Background(), &proto.Welcome{HostID: "host_a"}, nil)
	if err := dial(); err == nil {
		t.Fatal("still listening with the mesh down")
	}
	if h.peers.Key() != "key" {
		t.Fatal("a welcome without the grant key dropped it")
	}
}

// fetchTier is a microVM tier whose sticky disk versions can be fetched: it holds v1 of disk ci.
type fetchTier struct {
	*stickyTier
	mu        sync.Mutex
	discarded []string
}

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
	if slices.Contains(without.makeFacts().Features, proto.FeatureDiskSync) {
		t.Fatal("disk-sync reported without the mesh")
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
		if len(got) == 1 && got[0] == "ci/v2" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("discarded %v", got)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
