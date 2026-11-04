package microvm

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A snapshot's files are read without starting it: its disk holds the overlay's upper layer (/root on the disk) over
// the shared image, so a path is looked up in the upper layer first, then in the image, as overlayfs does in the
// guest. debugfs (e2fsprogs) reads both ext4 images without mounting them, so no root is needed and nothing the
// sandbox wrote is ever mounted on the host. A squashfs image (a custom image, injectGuestAgent) is read with
// unsquashfs where the host has it; an erofs one isn't read at all (unsupported, never an empty directory).

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

// imageFormat is an image file's file system, by its magic: "ext4" (any ext), "squashfs", "erofs" or "".
func imageFormat(image string) string {
	f, err := os.Open(image)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 1084)
	n, _ := io.ReadFull(f, buf)
	switch {
	case n >= 4 && string(buf[:4]) == "hsqs":
		return "squashfs"
	case n >= 1028 && binary.LittleEndian.Uint32(buf[1024:]) == 0xE0F5E1E2:
		return "erofs"
	case n >= 1082 && binary.LittleEndian.Uint16(buf[1080:]) == 0xEF53:
		return "ext4"
	}
	return ""
}

// imageList lists a directory of image, a sandbox's image (the overlay's lower layer: a snapshot's own base,
// snapshotLower), whichever file system it is: found is whether the directory is there; an error is an image this
// host can't read, never an empty directory.
func imageList(image, dir string) (entries []dentry, found bool, err error) {
	switch format := imageFormat(image); format {
	case "ext4":
		entries, found = debugfsList(image, dir)
		return entries, found, nil
	case "squashfs":
		return unsquashfsList(image, dir)
	default:
		return nil, false, unreadable(format)
	}
}

// imageRead reads a file of image found by imageList.
func imageRead(image, p string, e dentry) ([]byte, error) {
	if imageFormat(image) == "squashfs" {
		// -no-wildcards: the path is a name, not a pattern (a file called "[ab].txt" beside a.txt).
		out, err := exec.Command("unsquashfs", "-no-wildcards", "-cat", image, p).Output()
		if err != nil {
			return nil, fmt.Errorf("unsquashfs -cat %s: %w", p, err)
		}
		return out, nil
	}
	return debugfsDump(image, e)
}

func unreadable(format string) error {
	if format == "" {
		format = "unrecognised"
	}
	return &proto.Error{Code: proto.ErrUnsupported, Message: "this host can't read a stopped sandbox's files from its " + format + " image: start the sandbox to read them"}
}

// unsquashfsLine is a line of `unsquashfs -lln`: mode, uid/gid, size, date, time, path ("name -> target" for a link).
var unsquashfsLine = regexp.MustCompile(`^([-dlpcbs][-rwxsStT]{9})\s+\S+\s+(\d+)\s+\S+\s+\S+\s(.*)$`)

// unsquashfsList lists a directory of a squashfs image with unsquashfs (squashfs-tools 4.6 or later), one level deep.
func unsquashfsList(image, dir string) ([]dentry, bool, error) {
	if _, err := exec.LookPath("unsquashfs"); err != nil {
		return nil, false, &proto.Error{Code: proto.ErrUnsupported, Message: "reading a stopped sandbox's files from a squashfs image needs unsquashfs (squashfs-tools 4.6 or later) on the host: install it, or start the sandbox to read them"}
	}
	dir = path.Clean("/" + dir)
	depth := 1
	args := []string{"-no-wildcards", "-lln", "-d", "", image}
	if dir != "/" {
		depth = strings.Count(dir, "/") + 1
		args = append(args, dir)
	}
	args = append([]string{"-max-depth", strconv.Itoa(depth)}, args...)
	out, err := exec.Command("unsquashfs", args...).Output()
	if err != nil {
		return nil, false, fmt.Errorf("unsquashfs -lln %s: %w", dir, err)
	}
	return parseUnsquashfs(string(out), dir)
}

func parseUnsquashfs(out, dir string) ([]dentry, bool, error) {
	var entries []dentry
	found := dir == "/"
	for _, line := range strings.Split(out, "\n") {
		m := unsquashfsLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		mode := modeOf(m[1])
		p := m[3]
		if mode&0o170000 == 0o120000 {
			p, _, _ = strings.Cut(p, " -> ")
		}
		p = path.Clean("/" + p)
		if p == dir {
			found = mode&0o170000 == 0o040000
			continue
		}
		if path.Dir(p) != dir {
			continue
		}
		size, _ := strconv.ParseInt(m[2], 10, 64)
		entries = append(entries, dentry{name: path.Base(p), mode: mode, size: size})
	}
	return entries, found, nil
}

// modeOf is ls's "drwxr-xr-x" as a mode (type bits as stat's).
func modeOf(s string) uint32 {
	var mode uint32
	switch s[0] {
	case 'd':
		mode = 0o040000
	case 'l':
		mode = 0o120000
	case 'p':
		mode = 0o010000
	case 'c':
		mode = 0o020000
	case 'b':
		mode = 0o060000
	case 's':
		mode = 0o140000
	default:
		mode = 0o100000
	}
	// The x of owner, group and other (positions 2, 5, 8) also shows setuid, setgid and sticky: s/t with x, S/T without.
	special := [9]uint32{2: 0o4000, 5: 0o2000, 8: 0o1000}
	for i, c := range s[1:10] {
		bit := uint32(1) << (8 - i)
		switch c {
		case 'r', 'w', 'x':
			mode |= bit
		case 's', 't':
			mode |= bit | special[i]
		case 'S', 'T':
			mode |= special[i]
		}
	}
	return mode
}

// debugfsDump reads a file of an ext4 image by its inode.
func debugfsDump(image string, e dentry) ([]byte, error) {
	tmp, err := os.CreateTemp("", "kantel-snapread-")
	if err != nil {
		return nil, err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	if out, err := exec.Command("debugfs", "-R", "dump -p <"+e.inode+"> "+quoteDebugfs(tmp.Name()), image).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("debugfs dump: %v: %s", err, out)
	}
	return os.ReadFile(tmp.Name())
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
		lower, lowerFound, err = imageList(m.snapshotLower(id), p)
		if err != nil {
			return nil, err
		}
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
	lower := m.snapshotLower(id)
	for _, upper := range []bool{true, false} {
		var entries []dentry
		if upper {
			entries, _ = debugfsList(disk, path.Join("/root", parent))
		} else if entries, _, err = imageList(lower, parent); err != nil {
			return nil, err
		}
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
			if upper {
				return debugfsDump(disk, e)
			}
			return imageRead(lower, p, e)
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
