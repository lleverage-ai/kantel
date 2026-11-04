package agent

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/mounts"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// mounter is a tier that takes read-only mounts (the microVM tier); the others refuse them as unsupported.
type mounter interface {
	MountsSupported() bool
	RefreshMounts(ctx context.Context, p proto.MountsRefreshParams) ([]proto.MountStatus, error)
	// ReconcileMounts confirms the mounts of sandboxes adopted at start, now that their sources can be resolved.
	ReconcileMounts(ctx context.Context)
}

// reconcileMounts runs each tier's ReconcileMounts for the connection ctx: bucket.fetch reaches Kantel now.
func (h *Host) reconcileMounts(ctx context.Context) {
	for _, t := range h.tiers {
		if m, ok := t.(mounter); ok && m.MountsSupported() {
			m.ReconcileMounts(ctx)
		}
	}
}

func supportsMounts(t Tier) bool {
	m, ok := t.(mounter)
	return ok && m.MountsSupported()
}

// DefaultMountCacheMiB is the host's read cache for bucket mounts unless configured.
const DefaultMountCacheMiB = 10240

// newMounts makes the host's bucket mounts: the read cache in Root/mount-cache and a client for the stores that
// connects only where the egress proxy may (public addresses and the operator's EgressAllowCIDRs), so a bucket
// source's endpoint can't reach the host's own services or its LAN.
func (h *Host) newMounts(dest egress.Destinations) (*mounts.Manager, error) {
	if h.cfg.MountCacheMiB < 0 {
		return nil, nil
	}
	size := h.cfg.MountCacheMiB
	if size == 0 {
		size = DefaultMountCacheMiB
	}
	dir := h.cfg.MountCacheDir
	if dir == "" {
		dir = filepath.Join(h.cfg.Root, "mount-cache")
	}
	cache, err := mounts.OpenCache(dir, size<<20)
	if err != nil {
		return nil, fmt.Errorf("mount cache: %w", err)
	}
	key, err := mountProofKey(filepath.Join(h.cfg.Root, "mount-proof.key"))
	if err != nil {
		return nil, fmt.Errorf("mount proof key: %w", err)
	}
	return mounts.New(mounts.Config{
		Cache:    cache,
		HTTP:     storeClient(dest),
		Resolve:  h.resolveBucket,
		Log:      h.log,
		Changed:  h.mountsChanged,
		ProofKey: key,
	}), nil
}

// mountProofKey is the key the host signs mounted object versions with (mounts.Config.ProofKey), made the first
// time and kept at path, so a guest's open files still read across a restart of the host.
func mountProofKey(path string) ([]byte, error) {
	if raw, err := os.ReadFile(path); err == nil && len(raw) == 32 {
		return raw, nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := fsutil.WriteFileDurably(path, key, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

// storeClient reaches object stores, never an address the egress proxy would refuse a sandbox (checked after DNS).
func storeClient(dest egress.Destinations) *http.Client {
	dialer := &net.Dialer{
		Timeout: 10 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil {
				return fmt.Errorf("%s: %w", address, egress.ErrDestination)
			}
			return dest.Check(ap.Addr())
		},
	}
	return &http.Client{Transport: &http.Transport{
		// Not the host's environment's proxy: the store is reached as the dialer allows.
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConnsPerHost:   64,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
	}}
}

// resolveBucket asks Kantel for a bucket source a sandbox mounts. Its errors never quote the answer, which holds
// credentials.
func (h *Host) resolveBucket(ctx context.Context, sandboxID, sourceID string) (proto.BucketSource, error) {
	call := h.kantelCall
	if h.callKantel != nil {
		call = h.callKantel
	}
	raw, err := call(ctx, proto.MethodBucketResolve, proto.BucketResolveParams{SandboxID: sandboxID, SourceID: sourceID})
	if err != nil {
		return proto.BucketSource{}, err
	}
	var src proto.BucketSource
	if err := json.Unmarshal(raw, &src); err != nil {
		return proto.BucketSource{}, errors.New("bucket.resolve answered something that isn't a bucket source")
	}
	return src, nil
}

// mountsChanged tells Kantel a sandbox's mounts changed status outside a call: a sandbox.mounts event with the
// sandbox (and so its mounts' statuses).
func (h *Host) mountsChanged(sandboxID string) {
	t, err := h.tierOf(sandboxID)
	if err != nil {
		return
	}
	info, err := t.Get(sandboxID)
	if err != nil {
		return
	}
	h.mu.Lock()
	fn := h.events
	h.mu.Unlock()
	if fn != nil {
		fn(proto.Event{Kind: proto.EventMounts, Sandbox: &info})
	}
}

func (h *Host) refreshMounts(ctx context.Context, p proto.MountsRefreshParams) ([]proto.MountStatus, error) {
	if p.SandboxID == "" {
		return nil, invalid("sandbox.mounts.refresh needs sandboxId")
	}
	t, err := h.tierOf(p.SandboxID)
	if err != nil {
		return nil, err
	}
	m, ok := t.(mounter)
	if !ok || !m.MountsSupported() {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: "this sandbox's tier has no mounts"}
	}
	return m.RefreshMounts(ctx, p)
}
