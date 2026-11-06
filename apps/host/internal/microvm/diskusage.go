package microvm

import (
	"path/filepath"

	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
)

// DiskBreakdown is what the tier's files take on the disk now, by what they are for, each file counted once: one
// in seen already (a bundle image, a base image) counts nothing, and every one counted here is added to it.
type DiskBreakdown struct {
	// Images are the templates' root filesystems, made from their pulled bases (images/templates).
	Images int64
	// Templates are each size's template snapshot and the templates' snapshots (templates/, template-snapshots/).
	Templates int64
	// Sandboxes are the sandboxes' own files: their disks, and their memory after a stop.
	Sandboxes int64
	// Automatic and Saved are the snapshots of each kind: memory a stop shares with its sandbox counts for the sandbox.
	Automatic int64
	Saved     int64
}

// DiskBreakdown measures the tier's files (DiskBreakdown) in that order: images, templates, sandboxes, then
// snapshots, oldest first.
func (m *Manager) DiskBreakdown(seen fsutil.Seen) DiskBreakdown {
	var out DiskBreakdown
	out.Images = fsutil.Allocated(filepath.Join(m.cfg.Root, "images"), seen)
	out.Templates = fsutil.Allocated(filepath.Join(m.cfg.Root, "templates"), seen) +
		fsutil.Allocated(filepath.Join(m.cfg.Root, templateSnapshotsDir), seen)
	out.Sandboxes = fsutil.Allocated(filepath.Join(m.cfg.Root, "sandboxes"), seen)
	snaps := m.snapshotsOf("")
	for i := len(snaps) - 1; i >= 0; i-- {
		n := fsutil.Allocated(m.snapshotDir(snaps[i].ID), seen)
		if snaps[i].Kind == "saved" {
			out.Saved += n
		} else {
			out.Automatic += n
		}
	}
	return out
}
