package microvm

import (
	"path/filepath"
	"sort"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
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
	// Snapshots are the snapshots' files, of either kind: memory a stop's snapshot shares with its sandbox counts for
	// the sandbox. Which of them are saved isn't the host's to say (a snapshot it saved may be one the control plane
	// keeps as automatic, and one it kept automatic may be saved there), so the control plane splits them by its own
	// records.
	Snapshots int64
	// SnapshotOwn and SnapshotShared split Snapshots by snapshot, so the control plane can split it by its records:
	// each snapshot's files no other holds (by ID), and the files several hold, by their holders. Files counted before
	// the snapshots (a sandbox's memory, a bundle drive) are in neither.
	SnapshotOwn    map[string]int64
	SnapshotShared []proto.SharedBytes
}

// DiskBreakdown measures the tier's files (DiskBreakdown) in that order: images, templates, sandboxes, then
// snapshots.
func (m *Manager) DiskBreakdown(seen *fsutil.Seen) DiskBreakdown {
	var out DiskBreakdown
	out.Images = fsutil.Allocated(filepath.Join(m.cfg.Root, "images"), seen)
	out.Templates = fsutil.Allocated(filepath.Join(m.cfg.Root, "templates"), seen) +
		fsutil.Allocated(filepath.Join(m.cfg.Root, templateSnapshotsDir), seen)
	out.Sandboxes = fsutil.Allocated(filepath.Join(m.cfg.Root, "sandboxes"), seen)
	type file struct {
		bytes   int64
		holders []string
	}
	files := map[fsutil.FileID]*file{}
	out.SnapshotOwn = map[string]int64{}
	bundle := func(name string) bool { return strings.HasPrefix(name, "bundle") }
	for _, snap := range m.snapshotsOf("") {
		out.SnapshotOwn[snap.ID] = 0
		fsutil.Each(m.snapshotDir(snap.ID), seen, func(id fsutil.FileID, bytes int64) {
			f := files[id]
			if f == nil {
				f = &file{bytes: bytes}
				files[id] = f
			}
			f.holders = append(f.holders, snap.ID)
		}, bundle)
	}
	groups := map[string]*proto.SharedBytes{}
	for id, f := range files {
		if seen != nil {
			seen.Add(id)
		}
		out.Snapshots += f.bytes
		if len(f.holders) == 1 {
			out.SnapshotOwn[f.holders[0]] += f.bytes
			continue
		}
		sort.Strings(f.holders)
		key := strings.Join(f.holders, ",")
		if groups[key] == nil {
			groups[key] = &proto.SharedBytes{Snapshots: f.holders}
		}
		groups[key].Bytes += f.bytes
	}
	for _, group := range groups {
		out.SnapshotShared = append(out.SnapshotShared, *group)
	}
	sort.Slice(out.SnapshotShared, func(i, j int) bool {
		return strings.Join(out.SnapshotShared[i].Snapshots, ",") < strings.Join(out.SnapshotShared[j].Snapshots, ",")
	})
	return out
}
