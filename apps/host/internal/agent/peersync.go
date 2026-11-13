package agent

// Peer sync (docs/design/disk-store.md, "2c. Peer sync"): while the host is in its pool's mesh, it serves the disk
// versions it holds to the pool's other hosts, on its mesh address, to those with a grant from the control plane; and
// it fetches versions from them (disk.fetch, or a create attaching a sticky disk version it doesn't hold), moving only
// the blocks that differ from its nearest version. Both directions are held to --sync-rate.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/netip"
	"os"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// kindSticky is the one kind of disk store object hosts sync so far.
const kindSticky = "sticky"

// startPeerSync readies the peer sync server and the fetcher, with the mesh: the server listens once a welcome brings
// the mesh up.
func (h *Host) startPeerSync() {
	if h.mesh == nil {
		return
	}
	serve, fetch := h.syncLimiters()
	h.peers = &disksync.Server{
		Source: peerStore{h},
		Self:   h.selfID,
		Key: func() string {
			if k := h.grantKey.Load(); k != nil {
				return *k
			}
			return ""
		},
		PeerAt: h.mesh.PeerAt,
		Limit:  serve,
		Log:    h.log.With("part", "peer-sync"),
	}
	ctx, stop := context.WithCancel(context.Background())
	h.syncStop = stop
	h.fetcher = &disksync.Fetcher{
		Store: peerStore{h}, Locate: h.locateDisk, Limit: fetch, Fetches: h.cfg.SyncFetches,
		Log: h.log.With("part", "peer-sync"), Context: ctx,
	}
}

// syncLimiters are --sync-rate's limiters, one each way: SyncRateMbit, else half the host's link; none for -1.
func (h *Host) syncLimiters() (serve, fetch *disksync.Limiter) {
	rate := int64(h.cfg.SyncRateMbit) * 1_000_000 / 8
	if h.cfg.SyncRateMbit == 0 {
		rate = disksync.DefaultRate()
	}
	if rate > 0 {
		h.log.Info("peer sync rate", "mbit", rate*8/1_000_000)
	}
	return disksync.NewLimiter(rate), disksync.NewLimiter(rate)
}

// selfID is the host's ID: the last welcome's, else its settings'.
func (h *Host) selfID() string {
	if id := h.welcomeID.Load(); id != nil && *id != "" {
		return *id
	}
	return h.cfg.HostID
}

// followPeerSync takes a welcome's grant key and host ID, and has the peer sync server listen on the mesh address while
// the mesh is up, and stop while it is down. A welcome without a key keeps the last one: the control plane's key
// doesn't change, and a welcome goes without it when the key couldn't be read just then.
func (h *Host) followPeerSync(w *proto.Welcome) {
	if key := w.GrantKey; key != "" {
		h.grantKey.Store(&key)
	}
	if id := w.HostID; id != "" {
		h.welcomeID.Store(&id)
	}
	if h.peers == nil {
		return
	}
	addr, up := h.mesh.Address()
	if !up {
		addr = netip.Addr{}
	}
	if err := h.peers.Serve(addr); err != nil {
		h.log.Error("the peer sync server couldn't listen", "error", err)
	}
	if up {
		// A welcome that brings the mesh up (the pool's sync turned on) lets unfinished fetches go on.
		go h.resumeFetches()
	}
}

// fetchesSticky says whether the host fetches sticky disk versions from its peers (FeatureDiskSync): it runs the mesh
// and has sticky disks.
func (h *Host) fetchesSticky() bool {
	_, ok := h.tiers[microvm.Tier].(StickyFetcher)
	return ok && h.fetcher != nil
}

// diskFetch is disk.fetch: the version's fetch started (or found under way), answered at once.
func (h *Host) diskFetch(params json.RawMessage) (any, error) {
	p, err := decode[proto.DiskFetchParams](params)
	if err != nil {
		return nil, err
	}
	if p.Kind != kindSticky || !h.fetchesSticky() {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("this host doesn't fetch %q disk versions", p.Kind)}
	}
	if p.ObjectID == "" || p.Version == "" {
		return nil, &proto.Error{Code: proto.ErrInvalid, Message: "disk.fetch names an object and a version"}
	}
	h.fetcher.Start(disksync.Request{
		Ref:       disksync.Ref{Kind: p.Kind, ObjectID: p.ObjectID, Version: p.Version},
		MapDigest: p.MapDigest, Holders: p.Holders, Grant: p.Grant,
	})
	return map[string]any{}, nil
}

// fetchStickyLater fetches a sticky disk version in the background (microvm.Config.FetchSticky), asking disk.locate
// where it is: a create attached the host's newest version instead.
func (h *Host) fetchStickyLater(diskID, version string) {
	if !h.fetchesSticky() {
		return
	}
	h.fetcher.Start(disksync.Request{Ref: disksync.Ref{Kind: kindSticky, ObjectID: diskID, Version: version}})
}

// resumeFetches starts the fetches left unfinished, while the host is connected and in a mesh.
func (h *Host) resumeFetches() {
	if !h.fetchesSticky() || !h.connected() {
		return
	}
	if _, up := h.mesh.Address(); up {
		h.fetcher.ResumeAll()
	}
}

// locateDisk is disk.locate to Kantel.
func (h *Host) locateDisk(ctx context.Context, r disksync.Ref) (proto.DiskLocateResult, error) {
	call := h.kantelCall
	if h.callKantel != nil {
		call = h.callKantel
	}
	raw, err := call(ctx, proto.MethodDiskLocate, proto.DiskLocateParams{Kind: r.Kind, ObjectID: r.ObjectID, Version: r.Version})
	if err != nil {
		return proto.DiskLocateResult{}, err
	}
	var res proto.DiskLocateResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return proto.DiskLocateResult{}, errors.New("disk.locate answered something that isn't a location")
	}
	return res, nil
}

// StickyServer is a tier whose sticky disk versions the host serves to its peers: the microVM tier.
type StickyServer interface {
	// OpenStickyVersion opens a version the host holds, and its map, for a peer to fetch (fs.ErrNotExist: not held).
	OpenStickyVersion(diskID, version string, withMap bool) (*os.File, []byte, error)
}

// StickyFetcher is a tier whose sticky disk versions can be fetched from peers (FeatureDiskSync): the microVM tier.
type StickyFetcher interface {
	StickyDisks
	StickyServer
	HoldsSticky(diskID, version string) bool
	StickyPartial(diskID, version string) (string, error)
	CloneNearestSticky(diskID, version, dst string) (*blockmap.Map, error)
	PublishFetchedSticky(diskID, version string, partial *os.File, mapFile []byte) error
	StickyPartials() [][2]string
	DiscardStickyPartial(diskID, version string)
}

var _ StickyFetcher = (*microvm.Manager)(nil)

// peerStore is the versions the host holds and fetches, for peer sync: sticky disks' on the microVM tier.
type peerStore struct{ h *Host }

func (s peerStore) sticky(kind string) (StickyFetcher, bool) {
	t, ok := s.h.tiers[microvm.Tier].(StickyFetcher)
	return t, ok && kind == kindSticky
}

func (s peerStore) Open(kind, objectID, version string, withMap bool) (*os.File, []byte, error) {
	t, ok := s.sticky(kind)
	if !ok {
		return nil, nil, fs.ErrNotExist
	}
	return t.OpenStickyVersion(objectID, version, withMap)
}

func (s peerStore) Held(r disksync.Ref) bool {
	t, ok := s.sticky(r.Kind)
	return ok && t.HoldsSticky(r.ObjectID, r.Version)
}

func (s peerStore) Partial(r disksync.Ref) (string, error) {
	t, ok := s.sticky(r.Kind)
	if !ok {
		return "", fs.ErrNotExist
	}
	return t.StickyPartial(r.ObjectID, r.Version)
}

func (s peerStore) CloneNearest(r disksync.Ref, dst string) (*blockmap.Map, error) {
	t, ok := s.sticky(r.Kind)
	if !ok {
		return nil, nil
	}
	return t.CloneNearestSticky(r.ObjectID, r.Version, dst)
}

func (s peerStore) Publish(r disksync.Ref, partial *os.File, mapFile []byte) error {
	t, ok := s.sticky(r.Kind)
	if !ok {
		return fs.ErrNotExist
	}
	return t.PublishFetchedSticky(r.ObjectID, r.Version, partial, mapFile)
}

func (s peerStore) Partials() []disksync.Ref {
	t, ok := s.sticky(kindSticky)
	if !ok {
		return nil
	}
	var out []disksync.Ref
	for _, p := range t.StickyPartials() {
		out = append(out, disksync.Ref{Kind: kindSticky, ObjectID: p[0], Version: p[1]})
	}
	return out
}

func (s peerStore) Discard(r disksync.Ref) {
	if t, ok := s.sticky(r.Kind); ok {
		t.DiscardStickyPartial(r.ObjectID, r.Version)
	}
}
