package agent

import (
	"path/filepath"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// DiskUsageEvery is how often the host measures what takes the space on its disk (proto.DiskUsage): a walk of its
// files, so not on every heartbeat.
const DiskUsageEvery = 5 * time.Minute

// diskMeasure keeps the host's last disk measure and measures it again, in the background, once it is older than
// DiskUsageEvery: a heartbeat never waits for a walk of the disk.
type diskMeasure struct {
	mu        sync.Mutex
	last      *proto.DiskUsage
	measuring bool
	// measure stands in for measureDisk in tests.
	measure func() proto.DiskUsage
}

// diskUsage is the last measure (nil before the first is done), starting a new one when it is due.
func (h *Host) diskUsage() *proto.DiskUsage {
	d := &h.disk
	d.mu.Lock()
	defer d.mu.Unlock()
	due := d.last == nil || time.Since(time.UnixMilli(d.last.MeasuredAt)) >= DiskUsageEvery
	if due && !d.measuring {
		d.measuring = true
		measure := d.measure
		if measure == nil {
			measure = h.measureDisk
		}
		go func() {
			usage := measure()
			d.mu.Lock()
			d.last, d.measuring = &usage, false
			d.mu.Unlock()
		}()
	}
	if d.last == nil {
		return nil
	}
	out := *d.last
	return &out
}

// measureDisk walks the host's files (proto.DiskUsage), each counted once, in the order the categories say, and only
// those on the filesystem holding Root, whose used and total it reports: a bundle cache on another disk, or a mount
// under a walked directory, counts nothing.
func (h *Host) measureDisk() proto.DiskUsage {
	seen := fsutil.OnFilesystemOf(h.cfg.Root)
	used, total := hostinfo.DiskUsed(h.cfg.Root)
	out := proto.DiskUsage{TotalBytes: total, UsedBytes: used}
	bundles := h.cfg.BundleCacheDir
	if bundles == "" {
		bundles = filepath.Join(h.cfg.Root, "bundles")
	}
	out.BundlesBytes = fsutil.Allocated(bundles, seen)
	out.ImagesBytes = fsutil.Allocated(filepath.Join(h.cfg.Root, "images"), seen)
	if mv, ok := h.tiers[microvm.Tier].(*microvm.Manager); ok {
		b := mv.DiskBreakdown(seen)
		out.ImagesBytes += b.Images
		out.TemplatesBytes = b.Templates
		out.SandboxesBytes = b.Sandboxes
		out.SnapshotsBytes = b.Snapshots
		out.SnapshotOwnBytes, out.SnapshotShared = b.SnapshotOwn, b.SnapshotShared
	}
	// An isolate's workspace and snapshots are its sandbox's.
	out.SandboxesBytes += fsutil.Allocated(filepath.Join(h.cfg.Root, "isolate"), seen)
	known := out.BundlesBytes + out.ImagesBytes + out.TemplatesBytes + out.SandboxesBytes + out.SnapshotsBytes
	out.OtherBytes = max(0, used-known)
	out.MeasuredAt = time.Now().UnixMilli()
	return out
}
