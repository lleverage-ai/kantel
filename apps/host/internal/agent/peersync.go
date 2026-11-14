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
	"time"

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
// template snapshots, FeatureSnapshotSync for saved snapshots).
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
	if p.Kind == proto.DiskKindSnapshot {
		return h.fetchSnapshot(p)
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
	// A control plane that keeps no copies of template snapshots (one from before them, or with templates off), or no
	// such snapshot: none to fetch.
	if pe := (*proto.Error)(nil); errors.As(err, &pe) && (pe.Code == proto.ErrUnsupported || pe.Code == proto.ErrNotFound) {
		return microvm.ErrNoPeerTemplate
	}
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

// fetchSnapshot is disk.fetch for a saved snapshot, answered at once. Its disk: the record from a holder first, so the
// host has the root image the disk is over (microvm's PrepareSnapshotFetch: a template's root filesystem from a peer,
// a host image version from its release) before the disk is fetched; its memory follows once the disk is here, if the
// host restores it (fetchSnapshotMemory). Its memory: fetched only when the host holds its disk and restores it.
func (h *Host) fetchSnapshot(p proto.DiskFetchParams) (any, error) {
	t, ok := h.tiers[microvm.Tier].(SnapshotFetcher)
	if !ok {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "this host doesn't fetch snapshots"}
	}
	switch p.Version {
	case microvm.SnapshotMemory:
		if !t.WantsSnapshotMemory(p.ObjectID) {
			return nil, &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("this host doesn't hold snapshot %s's disk, has its memory already, or doesn't restore it (its CPU or runtime differs)", p.ObjectID)}
		}
		h.fetcher.Start(disksync.Request{
			Ref:       disksync.Ref{Kind: p.Kind, ObjectID: p.ObjectID, Version: p.Version},
			MapDigest: p.MapDigest, Holders: p.Holders, Grant: p.Grant,
		})
		return map[string]any{}, nil
	case microvm.SnapshotDisk:
	default:
		return nil, &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("a snapshot has no version %q", p.Version)}
	}
	req := disksync.Request{
		Ref:       disksync.Ref{Kind: p.Kind, ObjectID: p.ObjectID, Version: p.Version},
		MapDigest: p.MapDigest, Holders: p.Holders, Grant: p.Grant,
	}
	if t.HoldsSnapshot(p.ObjectID, microvm.SnapshotDisk) {
		go h.fetchSnapshotMemory(p.ObjectID)
		return map[string]any{}, nil
	}
	if h.fetcher.Running(req.Ref) {
		return map[string]any{}, nil
	}
	go func() {
		ctx := h.fetcher.Context
		record, err := h.fetcher.ReadFile(ctx, req, microvm.SnapshotRecordFile)
		if err == nil && record == nil {
			err = errors.New("no holder has its record")
		}
		if err == nil {
			err = t.PrepareSnapshotFetch(ctx, p.ObjectID, record)
		}
		if err != nil {
			h.log.Warn("a snapshot's fetch couldn't start", "snapshot", p.ObjectID, "error", err)
			return
		}
		// With the holders and grant it read the record with, or asked anew when they came from disk.locate.
		h.fetcher.Start(req)
	}()
	return map[string]any{}, nil
}

// snapshotMemoryRetry is how long a fetch of a snapshot's memory that failed waits before it is tried again, doubled
// each time up to 16 times as long, for snapshotMemoryTries in all: its holder may not have mapped or reported it yet
// when the disk arrives. One that still fails is tried again when the host next connects (ResumeAll).
var (
	snapshotMemoryRetry = 30 * time.Second
	snapshotMemoryTries = 8
)

// fetchSnapshotMemory fetches a snapshot's memory, asking disk.locate where it is, while the host holds the snapshot's
// disk without it and restores it (WantsSnapshotMemory): once its disk is published. A fetch that fails is tried again
// a while later (snapshotMemoryRetry), unless the control plane has no such snapshot.
func (h *Host) fetchSnapshotMemory(id string) {
	t, ok := h.tiers[microvm.Tier].(SnapshotFetcher)
	if !ok || h.fetcher == nil {
		return
	}
	ctx := h.fetcher.Context
	wait := snapshotMemoryRetry
	for try := 0; try < snapshotMemoryTries && t.WantsSnapshotMemory(id); try++ {
		job := h.fetcher.Start(disksync.Request{Ref: disksync.Ref{Kind: proto.DiskKindSnapshot, ObjectID: id, Version: microvm.SnapshotMemory}})
		<-job.Done()
		_, err := job.Result()
		if err == nil || disksync.IsNotFound(err) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = min(2*wait, 16*snapshotMemoryRetry)
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

// SnapshotFetcher is a tier whose saved snapshots the host serves to its peers and fetches from them
// (FeatureSnapshotSync): the microVM tier.
type SnapshotFetcher interface {
	HoldsSnapshot(id, version string) bool
	OpenSnapshot(id, version string, withMap bool) (*os.File, []byte, error)
	ReadSnapshotFile(id, version, name string) ([]byte, error)
	PrepareSnapshotFetch(ctx context.Context, id string, record []byte) error
	WantsSnapshotMemory(id string) bool
	SnapshotPartial(id, version string) (string, error)
	PublishFetchedSnapshot(id, version string, partial *os.File, mapFile []byte, files map[string][]byte) error
	SnapshotPartials() [][2]string
	ReserveSnapshotFetch(bytes int64) (release func(), err error)
	DiscardSnapshotPartial(id, version string)
	// SnapshotHoldings are the saved snapshots' versions it holds with a map (Capacity.Holdings): nil when they can't
	// be read.
	SnapshotHoldings() []proto.ObjectHolding
}

var _ SnapshotFetcher = (*microvm.Manager)(nil)

// SandboxMover is a tier whose stopped sandboxes move between hosts (FeatureSandboxMove): it exports one as a disk
// store object (kind sandbox), serves it to its peers, and makes one fetched from a peer its own: the microVM tier.
type SandboxMover interface {
	ExportSandbox(ctx context.Context, p proto.SandboxExportParams) (proto.SandboxExportResult, error)
	DeleteSandboxExport(id, version string) error
	HoldsSandbox(id, version string) bool
	OpenSandboxPart(id, version, part string, withMap bool) (*os.File, []byte, error)
	ReadSandboxFile(id, version, name string) ([]byte, error)
	PrepareSandboxImport(ctx context.Context, id, version string, record []byte) error
	SandboxPartPartial(id, version, part string) (string, error)
	PublishFetchedSandbox(id, version string, parts map[string]disksync.FetchedPart) error
	ImportedSandbox(id, version string) (proto.SandboxInfo, error)
	SandboxImportPartials() [][2]string
	ReserveSandboxFetch(bytes int64) (release func(), err error)
	DiscardSandboxImport(id, version string)
	// DeleteMoved removes a sandbox moved to another host, its automatic snapshots kept.
	DeleteMoved(id string) error
}

var _ SandboxMover = (*microvm.Manager)(nil)

// movesSandboxes says whether the host moves stopped sandboxes to and from its peers (FeatureSandboxMove): it fetches
// saved snapshots (whose root images it gets the same way), and its microVM tier moves sandboxes.
func (h *Host) movesSandboxes() bool {
	_, ok := h.tiers[microvm.Tier].(SandboxMover)
	return ok && h.fetches(proto.DiskKindSandbox) && h.fetches(proto.DiskKindSnapshot)
}

// sandboxExport is sandbox.export: the stopped sandbox's files cloned and mapped as a version of its object, which the
// host then serves to its peers.
func (h *Host) sandboxExport(ctx context.Context, params json.RawMessage) (any, error) {
	p, err := decode[proto.SandboxExportParams](params)
	if err != nil {
		return nil, err
	}
	t, ok := h.tiers[microvm.Tier].(SandboxMover)
	if !ok || !h.movesSandboxes() {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "this host doesn't move sandboxes"}
	}
	// With the sandbox's other lifecycle calls, so a start waits for its files to be cloned.
	defer h.lifecycle.lock(p.SandboxID)()
	return t.ExportSandbox(ctx, p)
}

// sandboxExportDelete is sandbox.export.delete.
func (h *Host) sandboxExportDelete(params json.RawMessage) (any, error) {
	p, err := decode[proto.SandboxExportDeleteParams](params)
	if err != nil {
		return nil, err
	}
	t, ok := h.tiers[microvm.Tier].(SandboxMover)
	if !ok {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "this host doesn't move sandboxes"}
	}
	return map[string]any{}, t.DeleteSandboxExport(p.SandboxID, p.Version)
}

// sandboxImport is sandbox.import: the sandbox's record read from a holder first, so its size and root image are known
// to be had here (a host image version from its release, a template's root filesystem from a peer) before its files
// are fetched; then the fetch, waited for; then the sandbox, stopped here. A call that ends first leaves the fetch
// going on, and the same call again waits for it.
func (h *Host) sandboxImport(ctx context.Context, params json.RawMessage) (any, error) {
	p, err := decode[proto.SandboxImportParams](params)
	if err != nil {
		return nil, err
	}
	t, ok := h.tiers[microvm.Tier].(SandboxMover)
	if !ok || !h.movesSandboxes() {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "this host doesn't move sandboxes"}
	}
	if p.SandboxID == "" || p.Version == "" {
		return nil, invalid("sandbox.import names a sandbox and a version")
	}
	req := disksync.Request{
		Ref:       disksync.Ref{Kind: proto.DiskKindSandbox, ObjectID: p.SandboxID, Version: p.Version},
		MapDigest: p.MapDigest, Holders: p.Holders, Grant: p.Grant,
	}
	if !t.HoldsSandbox(p.SandboxID, p.Version) && !h.fetcher.Running(req.Ref) {
		record, err := h.fetcher.ReadFile(ctx, req, proto.SandboxRecordFile)
		if err == nil && record == nil {
			err = errors.New("no holder has its record")
		}
		if err != nil {
			return nil, fmt.Errorf("the sandbox's record: %w", err)
		}
		if err := t.PrepareSandboxImport(ctx, p.SandboxID, p.Version, record); err != nil {
			return nil, err
		}
	}
	job := h.fetcher.Start(req)
	select {
	case <-job.Done():
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if _, err := job.Result(); err != nil {
		return nil, err
	}
	return t.ImportedSandbox(p.SandboxID, p.Version)
}

// syncKinds are the kinds of object the host serves to its peers and fetches from them, each the microVM tier's: its
// sticky disks' versions, its templates' root filesystems, its template snapshots, its saved snapshots, and the
// sandboxes it moves. Looked up on each call: the tiers are made after peer sync is.
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
	if t, ok := h.tiers[microvm.Tier].(SnapshotFetcher); ok {
		k[proto.DiskKindSnapshot] = snapshotObjects{t: t, published: h.snapshotPublished, known: h.snapshotKnown}
	}
	if t, ok := h.tiers[microvm.Tier].(SandboxMover); ok {
		k[proto.DiskKindSandbox] = sandboxObjects{t}
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

// snapshotKnown asks Kantel (disk.locate) whether it still has a snapshot whose version is about to be published here,
// just before it is: not_found, which the fetcher takes as the version gone and discards its fetch, when it doesn't (it
// was deleted while the copy was fetched). Any other answer, or none, lets it be published: Kantel has a copy of a
// snapshot it no longer knows deleted from the host's next report, so this only saves the copy being made.
func (h *Host) snapshotKnown(r disksync.Ref) error {
	ctx, cancel := context.WithTimeout(h.fetcher.Context, 30*time.Second)
	defer cancel()
	if _, err := h.locateDisk(ctx, r); disksync.IsNotFound(err) {
		return err
	}
	return nil
}

// snapshotPublished follows a snapshot's version published: its disk here, its memory comes next if the host restores
// it.
func (h *Host) snapshotPublished(id, version string) {
	if version == microvm.SnapshotDisk {
		go h.fetchSnapshotMemory(id)
	}
}

// snapshotObjects are a tier's saved snapshots: two versions each, its disk with its record beside it and its memory
// with the machine's state, and no nearest version to start a fetch from. known, before a version is published, says
// whether Kantel still has the snapshot (a delete may have come while it was fetched); published is told of each
// version published.
type snapshotObjects struct {
	t         SnapshotFetcher
	known     func(r disksync.Ref) error
	published func(id, version string)
}

func (s snapshotObjects) Open(_, objectID, version string, withMap bool) (*os.File, []byte, error) {
	return s.t.OpenSnapshot(objectID, version, withMap)
}

func (s snapshotObjects) ReadFile(_, objectID, version, name string) ([]byte, error) {
	return s.t.ReadSnapshotFile(objectID, version, name)
}

func (s snapshotObjects) Held(r disksync.Ref) bool { return s.t.HoldsSnapshot(r.ObjectID, r.Version) }

func (s snapshotObjects) Partial(r disksync.Ref) (string, error) {
	return s.t.SnapshotPartial(r.ObjectID, r.Version)
}

func (s snapshotObjects) CloneNearest(disksync.Ref, string) (*blockmap.Map, error) { return nil, nil }

func (s snapshotObjects) Files(r disksync.Ref) []string {
	if r.Version == microvm.SnapshotMemory {
		return []string{microvm.SnapshotStateFile}
	}
	return []string{microvm.SnapshotRecordFile}
}

func (s snapshotObjects) Publish(r disksync.Ref, partial *os.File, mapFile []byte, files map[string][]byte) error {
	if s.known != nil {
		if err := s.known(r); err != nil {
			return err
		}
	}
	if err := s.t.PublishFetchedSnapshot(r.ObjectID, r.Version, partial, mapFile, files); err != nil {
		return err
	}
	if s.published != nil {
		s.published(r.ObjectID, r.Version)
	}
	return nil
}

func (s snapshotObjects) Partials() []disksync.Ref {
	var out []disksync.Ref
	for _, p := range s.t.SnapshotPartials() {
		out = append(out, disksync.Ref{Kind: proto.DiskKindSnapshot, ObjectID: p[0], Version: p[1]})
	}
	return out
}

func (s snapshotObjects) Reserve(_ disksync.Ref, bytes int64) (func(), error) {
	return s.t.ReserveSnapshotFetch(bytes)
}

func (s snapshotObjects) Discard(r disksync.Ref) { s.t.DiscardSnapshotPartial(r.ObjectID, r.Version) }

// sandboxObjects are a tier's moved sandboxes: a version for each export, its disk and sticky drives its parts and its
// record whole, with no nearest version to start a fetch from (the target has no copy of it).
type sandboxObjects struct{ t SandboxMover }

var _ disksync.Parted = sandboxObjects{}

func (s sandboxObjects) Parts(string) []string { return microvm.SandboxParts }

func (s sandboxObjects) Open(string, string, string, bool) (*os.File, []byte, error) {
	return nil, nil, fs.ErrNotExist
}

func (s sandboxObjects) OpenPart(r disksync.Ref, part string, withMap bool) (*os.File, []byte, error) {
	return s.t.OpenSandboxPart(r.ObjectID, r.Version, part, withMap)
}

func (s sandboxObjects) ReadFile(_, objectID, version, name string) ([]byte, error) {
	return s.t.ReadSandboxFile(objectID, version, name)
}

func (s sandboxObjects) Held(r disksync.Ref) bool { return s.t.HoldsSandbox(r.ObjectID, r.Version) }

func (s sandboxObjects) Partial(disksync.Ref) (string, error) {
	return "", errors.New("a moved sandbox is fetched by its parts")
}

func (s sandboxObjects) PartPartial(r disksync.Ref, part string) (string, error) {
	return s.t.SandboxPartPartial(r.ObjectID, r.Version, part)
}

func (s sandboxObjects) CloneNearest(disksync.Ref, string) (*blockmap.Map, error) { return nil, nil }

func (s sandboxObjects) Files(disksync.Ref) []string { return microvm.SandboxFiles }

func (s sandboxObjects) Publish(disksync.Ref, *os.File, []byte, map[string][]byte) error {
	return errors.New("a moved sandbox is published by its parts")
}

func (s sandboxObjects) PublishParts(r disksync.Ref, parts map[string]disksync.FetchedPart, _ map[string][]byte) error {
	return s.t.PublishFetchedSandbox(r.ObjectID, r.Version, parts)
}

func (s sandboxObjects) Partials() []disksync.Ref {
	var out []disksync.Ref
	for _, p := range s.t.SandboxImportPartials() {
		out = append(out, disksync.Ref{Kind: proto.DiskKindSandbox, ObjectID: p[0], Version: p[1]})
	}
	return out
}

func (s sandboxObjects) Reserve(_ disksync.Ref, bytes int64) (func(), error) {
	return s.t.ReserveSandboxFetch(bytes)
}

func (s sandboxObjects) Discard(r disksync.Ref) { s.t.DiscardSandboxImport(r.ObjectID, r.Version) }
