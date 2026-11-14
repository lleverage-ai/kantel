package agent

// Peer sync (docs/design/disk-store.md, "2c. Peer sync"): while the host is in its pool's mesh, it serves the disk
// store objects it holds (sticky disks' versions, templates' root filesystems, template snapshots) to the pool's other hosts, on its mesh
// address, to those with a grant from the control plane; and it fetches versions from them (disk.fetch, or a create
// attaching a sticky disk version it doesn't hold), moving only the blocks that differ from its nearest version. Both
// directions are held to --sync-rate.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/netip"
	"os"
	"slices"

	"github.com/lleverage-ai/kantel/apps/host/internal/blockmap"
	"github.com/lleverage-ai/kantel/apps/host/internal/disksync"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

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
		Keys: func() []proto.GrantKey {
			if k := h.grantKeys.Load(); k != nil {
				return *k
			}
			return nil
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

// pool is the pool the last welcome named the host in: "" before one, or with a control plane that doesn't say.
func (h *Host) pool() string {
	if p := h.welcomePool.Load(); p != nil {
		return *p
	}
	return ""
}

// followPeerSync takes a welcome's grant keys and host ID, and has the peer sync server listen on the mesh address while
// the mesh is up, and stop while it is down. A welcome with GrantKeys replaces the keys (a rotation adds a key and,
// once its time is up, drops the old one); one from a control plane from before rotation has GrantKey alone. A welcome
// without either keeps the last keys: a welcome goes without them when they couldn't be read just then.
func (h *Host) followPeerSync(w *proto.Welcome) {
	if keys := slices.Clone(w.GrantKeys); len(keys) > 0 {
		h.grantKeys.Store(&keys)
	} else if w.GrantKey != "" {
		keys := []proto.GrantKey{{PublicKey: w.GrantKey}}
		h.grantKeys.Store(&keys)
	}
	if id := w.HostID; id != "" {
		h.welcomeID.Store(&id)
	}
	pool := w.PoolID
	h.welcomePool.Store(&pool)
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
func (h *Host) fetchesSticky() bool { return h.fetches(proto.DiskKindSticky) }

// fetches says whether the host fetches objects of a kind from its peers: it runs the mesh, and a tier has the kind
// (FeatureDiskSync for sticky disks, FeatureRootfsSync for templates' root filesystems, FeatureTemplateSync for
// template snapshots).
func (h *Host) fetches(kind string) bool {
	_, ok := h.syncKinds()[kind]
	return ok && h.fetcher != nil
}

// diskFetch is disk.fetch: the version's fetch started (or found under way), answered at once.
func (h *Host) diskFetch(params json.RawMessage) (any, error) {
	p, err := decode[proto.DiskFetchParams](params)
	if err != nil {
		return nil, err
	}
	if !h.fetches(p.Kind) {
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
	h.fetcher.Start(disksync.Request{Ref: disksync.Ref{Kind: proto.DiskKindSticky, ObjectID: diskID, Version: version}})
}

// fetchRootfs fetches a template's root filesystem from a host in the pool that holds it, for a build
// (microvm.Config.FetchRootfs), and waits for it: microvm.ErrNoPeerRootfs when the host doesn't fetch them, or none
// holds it. A build that stops waiting leaves the fetch to go on, for the next.
func (h *Host) fetchRootfs(ctx context.Context, key string) error {
	if !h.fetches(proto.DiskKindRootfs) || !h.connected() {
		return microvm.ErrNoPeerRootfs
	}
	if _, up := h.mesh.Address(); !up {
		return microvm.ErrNoPeerRootfs
	}
	ref := disksync.Ref{Kind: proto.DiskKindRootfs, ObjectID: key, Version: microvm.RootfsVersion}
	at, err := h.locateDisk(ctx, ref)
	if err != nil {
		return fmt.Errorf("disk.locate: %w", err)
	}
	if len(at.Holders) == 0 || at.Grant == "" || at.MapDigest == "" {
		return microvm.ErrNoPeerRootfs
	}
	job := h.fetcher.Start(disksync.Request{Ref: ref, MapDigest: at.MapDigest, Holders: at.Holders, Grant: at.Grant})
	select {
	case <-job.Done():
		_, err := job.Result()
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// fetchTemplate fetches a template snapshot from a host in the pool whose copy restores on this host's CPU and runtime,
// for a build (microvm.Config.FetchTemplate), and waits for it: microvm.ErrNoPeerTemplate when the host doesn't fetch
// them, or none holds one. A build that stops waiting leaves the fetch to go on, for the next.
func (h *Host) fetchTemplate(ctx context.Context, snapshotID string) error {
	if !h.fetches(proto.DiskKindTemplate) || !h.connected() {
		return microvm.ErrNoPeerTemplate
	}
	if _, up := h.mesh.Address(); !up {
		return microvm.ErrNoPeerTemplate
	}
	ref := disksync.Ref{Kind: proto.DiskKindTemplate, ObjectID: snapshotID, Version: microvm.TemplateVersion}
	at, err := h.locateDisk(ctx, ref)
	if err != nil {
		return fmt.Errorf("disk.locate: %w", err)
	}
	if len(at.Holders) == 0 || at.Grant == "" || at.MapDigest == "" {
		return microvm.ErrNoPeerTemplate
	}
	job := h.fetcher.Start(disksync.Request{Ref: ref, MapDigest: at.MapDigest, Holders: at.Holders, Grant: at.Grant})
	select {
	case <-job.Done():
		_, err := job.Result()
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// resumeFetches starts the fetches left unfinished, while the host is connected and in a mesh.
func (h *Host) resumeFetches() {
	if h.fetcher == nil || len(h.syncKinds()) == 0 || !h.connected() {
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
	ReserveStickyFetch(bytes int64) (release func(), err error)
	DiscardStickyPartial(diskID, version string)
}

var _ StickyFetcher = (*microvm.Manager)(nil)

// RootfsFetcher is a tier whose templates' root filesystems the host serves to its peers and fetches from them
// (FeatureRootfsSync): the microVM tier.
type RootfsFetcher interface {
	HoldsRootfs(key, version string) bool
	OpenRootfs(key, version string, withMap bool) (*os.File, []byte, error)
	ReadRootfsFile(key, version, name string) ([]byte, error)
	RootfsPartial(key, version string) (string, error)
	PublishFetchedRootfs(key, version string, partial *os.File, mapFile []byte, files map[string][]byte) error
	RootfsPartials() []string
	ReserveRootfsFetch(bytes int64) (release func(), err error)
	DiscardRootfsPartial(key string)
	// RootfsHoldings are the root filesystems it holds with a map (Capacity.Holdings): nil when they can't be read.
	RootfsHoldings() []proto.ObjectHolding
}

var _ RootfsFetcher = (*microvm.Manager)(nil)

// TemplateFetcher is a tier whose template snapshots the host serves to its peers and fetches from them
// (FeatureTemplateSync): the microVM tier.
type TemplateFetcher interface {
	HoldsTemplate(id, version string) bool
	OpenTemplatePart(id, version, part string, withMap bool) (*os.File, []byte, error)
	ReadTemplateFile(id, version, name string) ([]byte, error)
	TemplatePartPartial(id, version, part string) (string, error)
	PublishFetchedTemplate(id, version string, parts map[string]disksync.FetchedPart, files map[string][]byte) error
	TemplatePartials() []string
	ReserveTemplateFetch(bytes int64) (release func(), err error)
	DiscardTemplateFetch(id string)
	// TemplateHoldings are the template snapshots it holds with maps (Capacity.Holdings): nil when they can't be read.
	TemplateHoldings() []proto.ObjectHolding
}

var _ TemplateFetcher = (*microvm.Manager)(nil)

// syncKinds are the kinds of object the host serves to its peers and fetches from them, each the microVM tier's: its
// sticky disks' versions, its templates' root filesystems, and its template snapshots. Looked up on each call: the
// tiers are made after peer sync is.
func (h *Host) syncKinds() disksync.Kinds {
	k := disksync.Kinds{}
	if t, ok := h.tiers[microvm.Tier].(StickyFetcher); ok {
		k[proto.DiskKindSticky] = stickyObjects{t}
	}
	if t, ok := h.tiers[microvm.Tier].(RootfsFetcher); ok {
		k[proto.DiskKindRootfs] = rootfsObjects{t}
	}
	if t, ok := h.tiers[microvm.Tier].(TemplateFetcher); ok {
		k[proto.DiskKindTemplate] = templateObjects{t}
	}
	return k
}

// peerStore is the objects the host holds and fetches, for peer sync: its syncKinds', as they are at each call.
type peerStore struct{ h *Host }

func (s peerStore) Open(kind, objectID, version string, withMap bool) (*os.File, []byte, error) {
	return s.h.syncKinds().Open(kind, objectID, version, withMap)
}

func (s peerStore) ReadFile(kind, objectID, version, name string) ([]byte, error) {
	return s.h.syncKinds().ReadFile(kind, objectID, version, name)
}

func (s peerStore) Held(r disksync.Ref) bool { return s.h.syncKinds().Held(r) }

func (s peerStore) Partial(r disksync.Ref) (string, error) { return s.h.syncKinds().Partial(r) }

func (s peerStore) CloneNearest(r disksync.Ref, dst string) (*blockmap.Map, error) {
	return s.h.syncKinds().CloneNearest(r, dst)
}

func (s peerStore) Files(r disksync.Ref) []string { return s.h.syncKinds().Files(r) }

func (s peerStore) Publish(r disksync.Ref, partial *os.File, mapFile []byte, files map[string][]byte) error {
	return s.h.syncKinds().Publish(r, partial, mapFile, files)
}

func (s peerStore) Partials() []disksync.Ref { return s.h.syncKinds().Partials() }

func (s peerStore) Reserve(r disksync.Ref, bytes int64) (func(), error) {
	return s.h.syncKinds().Reserve(r, bytes)
}

func (s peerStore) Discard(r disksync.Ref) { s.h.syncKinds().Discard(r) }

func (s peerStore) Parts(kind string) []string { return s.h.syncKinds().Parts(kind) }

func (s peerStore) OpenPart(r disksync.Ref, part string, withMap bool) (*os.File, []byte, error) {
	return s.h.syncKinds().OpenPart(r, part, withMap)
}

func (s peerStore) PartPartial(r disksync.Ref, part string) (string, error) {
	return s.h.syncKinds().PartPartial(r, part)
}

func (s peerStore) PublishParts(r disksync.Ref, parts map[string]disksync.FetchedPart, files map[string][]byte) error {
	return s.h.syncKinds().PublishParts(r, parts, files)
}

// stickyObjects are a tier's sticky disks' versions: one file each, with no small files.
type stickyObjects struct{ t StickyFetcher }

func (s stickyObjects) Open(_, objectID, version string, withMap bool) (*os.File, []byte, error) {
	return s.t.OpenStickyVersion(objectID, version, withMap)
}

func (s stickyObjects) ReadFile(string, string, string, string) ([]byte, error) {
	return nil, fs.ErrNotExist
}

func (s stickyObjects) Held(r disksync.Ref) bool { return s.t.HoldsSticky(r.ObjectID, r.Version) }

func (s stickyObjects) Partial(r disksync.Ref) (string, error) {
	return s.t.StickyPartial(r.ObjectID, r.Version)
}

func (s stickyObjects) CloneNearest(r disksync.Ref, dst string) (*blockmap.Map, error) {
	return s.t.CloneNearestSticky(r.ObjectID, r.Version, dst)
}

func (s stickyObjects) Files(disksync.Ref) []string { return nil }

func (s stickyObjects) Publish(r disksync.Ref, partial *os.File, mapFile []byte, _ map[string][]byte) error {
	return s.t.PublishFetchedSticky(r.ObjectID, r.Version, partial, mapFile)
}

func (s stickyObjects) Partials() []disksync.Ref {
	var out []disksync.Ref
	for _, p := range s.t.StickyPartials() {
		out = append(out, disksync.Ref{Kind: proto.DiskKindSticky, ObjectID: p[0], Version: p[1]})
	}
	return out
}

func (s stickyObjects) Reserve(_ disksync.Ref, bytes int64) (func(), error) {
	return s.t.ReserveStickyFetch(bytes)
}

func (s stickyObjects) Discard(r disksync.Ref) { s.t.DiscardStickyPartial(r.ObjectID, r.Version) }

// rootfsObjects are a tier's templates' root filesystems: one version each, with its record beside it, and no nearest
// version to start a fetch from.
type rootfsObjects struct{ t RootfsFetcher }

func (s rootfsObjects) Open(_, objectID, version string, withMap bool) (*os.File, []byte, error) {
	return s.t.OpenRootfs(objectID, version, withMap)
}

func (s rootfsObjects) ReadFile(_, objectID, version, name string) ([]byte, error) {
	return s.t.ReadRootfsFile(objectID, version, name)
}

func (s rootfsObjects) Held(r disksync.Ref) bool { return s.t.HoldsRootfs(r.ObjectID, r.Version) }

func (s rootfsObjects) Partial(r disksync.Ref) (string, error) {
	return s.t.RootfsPartial(r.ObjectID, r.Version)
}

func (s rootfsObjects) CloneNearest(disksync.Ref, string) (*blockmap.Map, error) { return nil, nil }

func (s rootfsObjects) Files(disksync.Ref) []string { return []string{microvm.RootfsRecordFile} }

func (s rootfsObjects) Publish(r disksync.Ref, partial *os.File, mapFile []byte, files map[string][]byte) error {
	return s.t.PublishFetchedRootfs(r.ObjectID, r.Version, partial, mapFile, files)
}

func (s rootfsObjects) Partials() []disksync.Ref {
	var out []disksync.Ref
	for _, key := range s.t.RootfsPartials() {
		out = append(out, disksync.Ref{Kind: proto.DiskKindRootfs, ObjectID: key, Version: microvm.RootfsVersion})
	}
	return out
}

func (s rootfsObjects) Reserve(_ disksync.Ref, bytes int64) (func(), error) {
	return s.t.ReserveRootfsFetch(bytes)
}

func (s rootfsObjects) Discard(r disksync.Ref) { s.t.DiscardRootfsPartial(r.ObjectID) }

// templateObjects are a tier's template snapshots: one version each, its disk and memory its parts and its state, meta
// and drive counts whole, with no nearest version to start a fetch from.
type templateObjects struct{ t TemplateFetcher }

var _ disksync.Parted = templateObjects{}

func (s templateObjects) Parts(string) []string { return microvm.TemplateParts }

func (s templateObjects) Open(string, string, string, bool) (*os.File, []byte, error) {
	return nil, nil, fs.ErrNotExist
}

func (s templateObjects) OpenPart(r disksync.Ref, part string, withMap bool) (*os.File, []byte, error) {
	return s.t.OpenTemplatePart(r.ObjectID, r.Version, part, withMap)
}

func (s templateObjects) ReadFile(_, objectID, version, name string) ([]byte, error) {
	return s.t.ReadTemplateFile(objectID, version, name)
}

func (s templateObjects) Held(r disksync.Ref) bool { return s.t.HoldsTemplate(r.ObjectID, r.Version) }

func (s templateObjects) Partial(disksync.Ref) (string, error) {
	return "", errors.New("a template snapshot is fetched by its parts")
}

func (s templateObjects) PartPartial(r disksync.Ref, part string) (string, error) {
	return s.t.TemplatePartPartial(r.ObjectID, r.Version, part)
}

func (s templateObjects) CloneNearest(disksync.Ref, string) (*blockmap.Map, error) { return nil, nil }

func (s templateObjects) Files(disksync.Ref) []string { return microvm.TemplateFiles }

func (s templateObjects) Publish(disksync.Ref, *os.File, []byte, map[string][]byte) error {
	return errors.New("a template snapshot is published by its parts")
}

func (s templateObjects) PublishParts(r disksync.Ref, parts map[string]disksync.FetchedPart, files map[string][]byte) error {
	return s.t.PublishFetchedTemplate(r.ObjectID, r.Version, parts, files)
}

func (s templateObjects) Partials() []disksync.Ref {
	var out []disksync.Ref
	for _, id := range s.t.TemplatePartials() {
		out = append(out, disksync.Ref{Kind: proto.DiskKindTemplate, ObjectID: id, Version: microvm.TemplateVersion})
	}
	return out
}

func (s templateObjects) Reserve(_ disksync.Ref, bytes int64) (func(), error) {
	return s.t.ReserveTemplateFetch(bytes)
}

func (s templateObjects) Discard(r disksync.Ref) { s.t.DiscardTemplateFetch(r.ObjectID) }
