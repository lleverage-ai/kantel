package microvm

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A snapshot's files are read without starting it: its disk holds the overlay's upper layer (/root on the disk) over
// the shared image, so a path is looked up in the upper layer first, then in the image, as overlayfs does in the
// guest. debugfs (e2fsprogs) reads both ext4 images without mounting them, so no root is needed and nothing the
// sandbox wrote is ever mounted on the host.

type dentry struct {
	name  string
	mode  uint32
	size  int64
	inode string
}

// debugfsList lists a directory of an ext4 image (`ls -p`: /inode/mode/uid/gid/name/size/).
func debugfsList(image, dir string) ([]dentry, bool) {
	out, err := exec.Command("debugfs", "-R", "ls -p "+quoteDebugfs(dir), image).Output()
	if err != nil {
		return nil, false
	}
	var entries []dentry
	found := false
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.HasPrefix(line, "/") {
			continue
		}
		found = true
		fields := strings.Split(strings.Trim(line, "/"), "/")
		if len(fields) < 6 {
			continue
		}
		name := fields[4]
		if name == "." || name == ".." || name == "" {
			continue
		}
		mode, _ := strconv.ParseUint(fields[1], 8, 32)
		size, _ := strconv.ParseInt(fields[5], 10, 64)
		entries = append(entries, dentry{name: name, mode: uint32(mode), size: size, inode: fields[0]})
	}
	return entries, found
}

func quoteDebugfs(p string) string {
	return `"` + strings.ReplaceAll(p, `"`, `\"`) + `"`
}

func kind(mode uint32) string {
	switch mode & 0o170000 {
	case 0o040000:
		return "dir"
	case 0o100000:
		return "file"
	case 0o120000:
		return "symlink"
	}
	return "other"
}

// whiteout is overlayfs's mark of a deleted file: a character device 0/0.
func whiteout(e dentry) bool { return e.mode&0o170000 == 0o020000 }

func (m *Manager) snapshotImages(id string) (string, error) {
	if _, err := m.readSnapshot(id); err != nil {
		return "", err
	}
	return filepath.Join(m.snapshotDir(id), fc.DiskFile), nil
}

// HasSnapshot says whether a snapshot is this tier's.
func (m *Manager) HasSnapshot(id string) bool {
	_, err := m.readSnapshot(id)
	return err == nil
}

// SnapshotFiles lists a directory of a snapshot as the sandbox saw it.
func (m *Manager) SnapshotFiles(id, p string) ([]proto.FileEntry, error) {
	disk, err := m.snapshotImages(id)
	if err != nil {
		return nil, err
	}
	p = path.Clean("/" + p)
	merged := map[string]proto.FileEntry{}
	hidden := map[string]bool{}
	upper, upperFound := debugfsList(disk, path.Join("/root", p))
	for _, e := range upper {
		if whiteout(e) {
			hidden[e.name] = true
			continue
		}
		merged[e.name] = proto.FileEntry{Name: e.name, Path: path.Join(p, e.name), Type: kind(e.mode), Size: e.size, Mode: e.mode & 0o7777}
	}
	opaque := false
	if upperFound {
		// An opaque directory (trusted.overlay.opaque=y) hides the image's entries; debugfs shows its xattrs.
		if out, err := exec.Command("debugfs", "-R", "ea_list "+quoteDebugfs(path.Join("/root", p)), disk).Output(); err == nil && bytes.Contains(out, []byte("overlay.opaque")) {
			opaque = true
		}
	}
	lowerFound := false
	if !opaque {
		var lower []dentry
		lower, lowerFound = debugfsList(m.cfg.Rootfs, p)
		for _, e := range lower {
			if hidden[e.name] {
				continue
			}
			if _, ok := merged[e.name]; ok {
				continue
			}
			merged[e.name] = proto.FileEntry{Name: e.name, Path: path.Join(p, e.name), Type: kind(e.mode), Size: e.size, Mode: e.mode & 0o7777}
		}
	}
	if !upperFound && !lowerFound {
		return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no directory " + p + " in snapshot " + id}
	}
	out := make([]proto.FileEntry, 0, len(merged))
	for _, e := range merged {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// SnapshotRead reads a file of a snapshot (up to 16 MiB).
func (m *Manager) SnapshotRead(id, p string) ([]byte, error) {
	disk, err := m.snapshotImages(id)
	if err != nil {
		return nil, err
	}
	p = path.Clean("/" + p)
	parent, name := path.Dir(p), path.Base(p)
	images := []struct{ image, dir string }{{disk, path.Join("/root", parent)}, {m.cfg.Rootfs, parent}}
	for _, im := range images {
		entries, _ := debugfsList(im.image, im.dir)
		for _, e := range entries {
			if e.name != name {
				continue
			}
			if whiteout(e) {
				return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no file " + p}
			}
			if kind(e.mode) != "file" {
				return nil, &proto.Error{Code: proto.ErrInvalid, Message: p + " is not a file"}
			}
			if e.size > 16<<20 {
				return nil, &proto.Error{Code: proto.ErrInvalid, Message: fmt.Sprintf("%s is %d bytes; read it from a running sandbox", p, e.size)}
			}
			tmp, err := os.CreateTemp("", "kantel-snapread-")
			if err != nil {
				return nil, err
			}
			tmp.Close()
			defer os.Remove(tmp.Name())
			if out, err := exec.Command("debugfs", "-R", "dump -p <"+e.inode+"> "+quoteDebugfs(tmp.Name()), im.image).CombinedOutput(); err != nil {
				return nil, fmt.Errorf("debugfs dump: %v: %s", err, out)
			}
			return os.ReadFile(tmp.Name())
		}
	}
	return nil, &proto.Error{Code: proto.ErrNotFound, Message: "no file " + p + " in snapshot " + id}
}

// ResetTemplates forgets every size's template snapshot (a benchmark's cold start).
func (m *Manager) ResetTemplates() {
	for _, size := range m.cfg.Sizes {
		lock := m.templates[size.Name]
		lock.Lock()
		_ = os.RemoveAll(filepath.Join(m.cfg.Root, "templates", size.Name))
		lock.Unlock()
	}
}
