package agent

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/bundles"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// DefaultBundleCacheMiB bounds the host's bundle images not in use, unless configured.
const DefaultBundleCacheMiB = 10240

// DefaultBundleDrives is how many bundles a microVM can mount, unless configured; MaxBundleDrives is the most.
// Firecracker gives each device a legacy interrupt, of which a microVM has 19, and the root image, disk, network,
// vsock and entropy device take 5.
const (
	DefaultBundleDrives = 8
	MaxBundleDrives     = 12
)

// newBundles opens the host's bundle cache (Root/bundles), or answers nil when bundle mounts are off in the config.
// A cache without mkfs.erofs is answered too, so the host can say why a bundle mount fails, but the host doesn't
// offer bundle mounts (FeatureBundleMounts) then.
func (h *Host) newBundles() (*bundles.Cache, int, error) {
	if h.cfg.BundleCacheMiB < 0 || h.cfg.BundleDrives < 0 {
		return nil, 0, nil
	}
	size := h.cfg.BundleCacheMiB
	if size == 0 {
		size = DefaultBundleCacheMiB
	}
	drives := h.cfg.BundleDrives
	if drives == 0 {
		drives = DefaultBundleDrives
	}
	drives = min(drives, MaxBundleDrives)
	dir := h.cfg.BundleCacheDir
	if dir == "" {
		dir = filepath.Join(h.cfg.Root, "bundles")
	}
	cache, err := bundles.New(bundles.Config{Dir: dir, MaxBytes: size << 20, Log: h.log})
	if err != nil {
		return nil, 0, fmt.Errorf("bundle cache: %w", err)
	}
	if err := cache.Available(); err != nil {
		h.log.Warn("bundle mounts off", "reason", err.Error())
		return cache, 0, nil
	}
	h.log.Info("bundle mounts on", "drives", drives, "tool", cache.Tool(), "cacheMiB", size)
	return cache, drives, nil
}

// fetchBundle opens a bundle's tar from the control plane, for a sandbox on this host that mounts it: GET
// /v1/hosts/bundles/{digest}?sandboxId=, with the host's credential. Kantel answers only for a sandbox placed here
// that mounts that bundle.
func (h *Host) fetchBundle(ctx context.Context, sandboxID, digest string) (io.ReadCloser, error) {
	if h.cfg.ControlPlane == "" || h.cfg.Credential == "" {
		return nil, fmt.Errorf("this host has no control plane to fetch bundle %s from", digest)
	}
	u := strings.TrimRight(h.cfg.ControlPlane, "/") + "/v1/hosts/bundles/" + url.PathEscape(digest) + "?sandboxId=" + url.QueryEscape(sandboxID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+h.cfg.Credential)
	req.Header.Set("Kantel-Host-Version", h.version)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching bundle %s: %w", digest, err)
	}
	if res.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		res.Body.Close()
		msg := strings.TrimSpace(string(raw))
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, fmt.Errorf("fetching bundle %s: %s %s", digest, res.Status, msg)
	}
	return res.Body, nil
}

// mountsEvent tells the control plane a sandbox's mounts changed after its call answered (a bundle that was still
// being built is mounted, or failed).
func (h *Host) mountsEvent(info proto.SandboxInfo) {
	h.mu.Lock()
	fn := h.events
	h.mu.Unlock()
	if fn != nil {
		fn(proto.Event{Kind: proto.EventMounts, Sandbox: &info})
	}
}

// replayHealth sends, once a connection can carry events, a sandbox event for each running sandbox with its guest
// health (HealthAt set), and for each that ended without Kantel asking (stopped or error, with its Error: an exit,
// FeatureExitStamps): one that changed between its hello's read and the events being wired would otherwise reach
// Kantel only in the hello's older read, and an exit then would not reach it at all. Its HealthAt orders a health
// report against the hello and live events, and fences an exit to the run whose machine ended, so a repeat is harmless.
func (h *Host) replayHealth() {
	for _, info := range h.List() {
		running := info.State == proto.StateRunning && info.HealthAt > 0
		ended := (info.State == proto.StateStopped || info.State == proto.StateError) && info.Error != ""
		if running || ended {
			h.sandboxEvent(info)
		}
	}
}

// replayMounts sends, once a connection can carry events, every sandbox's mounts that are settled (ready or failed).
// A sandbox.mounts event is sent once, so one sent while the host had no connection (a bundle finishing while it was
// away, or one adopt() finished before the first connection) is otherwise lost, and its mount looks pending for good.
// The sandboxes are read after events are wired, so a mount settled during the handshake is in it. Pending mounts
// aren't replayed: Kantel has them as pending already, and a pending read before a mount settles must never overwrite
// the event that settled it.
func (h *Host) replayMounts() {
	for _, info := range h.List() {
		var settled []proto.MountStatus
		for _, m := range info.Mounts {
			if m.State == proto.MountReady || m.State == proto.MountFailed {
				settled = append(settled, m)
			}
		}
		if len(settled) == 0 {
			continue
		}
		info.Mounts = settled
		h.mountsEvent(info)
	}
}
