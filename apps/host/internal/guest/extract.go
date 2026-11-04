package guest

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Archive extraction (POST /files/extract): a tar already in the sandbox, which Kantel checked as it arrived, written
// out into a directory by the agent itself, as its file writes are (root, entries owned by the sandbox's user). Never
// the sandbox's tar, shell or environment: those are the sandbox's to change, so running them would let a caller that
// may only use files run what it wrote.

// errArchive is an archive the agent won't extract as it is: answered 400, so Kantel says why.
type errArchive struct{ msg string }

func (e *errArchive) Error() string { return e.msg }

func archiveRefusal(format string, args ...any) error {
	return &errArchive{msg: fmt.Sprintf(format, args...)}
}

func (s *Server) extractArchive(w http.ResponseWriter, r *http.Request) {
	archive, err := cleanPath(r.URL.Query().Get("archive"))
	if err != nil {
		fail(w, 400, err)
		return
	}
	target, err := cleanPath(r.URL.Query().Get("target"))
	if err != nil {
		fail(w, 400, err)
		return
	}
	err = ExtractTar(archive, target, 1000, 1000)
	// The tar goes whatever happened: it was only ever staged for this.
	_ = os.Remove(archive)
	var refused *errArchive
	if errors.As(err, &refused) {
		fail(w, 400, err)
		return
	}
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ExtractTar writes the tar at archive out under target, making it (and any directory an entry needs) owned by
// uid:gid, as are the entries. Directories, regular files and symbolic links only, each inside target: an absolute
// name, one with "..", or one under a symbolic link (the archive's or one already there) is refused, as is a link
// that is absolute or climbs out lexically (Kantel checked how links resolve through each other before staging it,
// but nothing here relies on that: no link is ever followed). An existing file or link is replaced, never written
// through; an existing directory is kept. Modes are kept but setuid and setgid, and so are modification times.
func ExtractTar(archive, target string, uid, gid int) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := mkdirAllOwned(target, uid, gid); err != nil {
		return err
	}
	links := map[string]bool{}
	type dirTime struct {
		path string
		at   time.Time
	}
	var dirTimes []dirTime
	tr := tar.NewReader(f)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return archiveRefusal("the archive can't be read: %v", err)
		}
		if h.Typeflag == tar.TypeXGlobalHeader {
			// Global pax settings: nothing in them says where entries go.
			continue
		}
		rel, err := entryRel(h.Name)
		if err != nil {
			return err
		}
		if rel == "" {
			// The top itself ("./"): it is there already.
			continue
		}
		if links[rel] {
			return archiveRefusal("%s replaces the archive's own symbolic link", h.Name)
		}
		dest := filepath.Join(target, rel)
		// Never through a link, the archive's or one already there: the tar sits in the sandbox, where what is in it
		// could change after Kantel checked it, so nothing about it is trusted to stay inside.
		if err := dirsUnder(target, filepath.Dir(rel), uid, gid); err != nil {
			return err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			info, err := os.Lstat(dest)
			switch {
			case err == nil && info.IsDir():
			case err == nil:
				if err := os.Remove(dest); err != nil {
					return err
				}
				fallthrough
			default:
				if err := os.Mkdir(dest, 0o700); err != nil {
					return err
				}
			}
			if err := os.Lchown(dest, uid, gid); err != nil {
				return err
			}
			if err := os.Chmod(dest, dirMode(h.Mode)); err != nil {
				return err
			}
			dirTimes = append(dirTimes, dirTime{dest, h.ModTime})
		case tar.TypeReg, tar.TypeCont:
			if err := replaceable(dest, h.Name); err != nil {
				return err
			}
			// O_EXCL: what was there is gone, so a link put back meanwhile isn't written through.
			out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, tr)
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
			if err := os.Lchown(dest, uid, gid); err != nil {
				return err
			}
			// After the chown, which would clear setuid and setgid anyway; neither is kept.
			if err := os.Chmod(dest, os.FileMode(h.Mode).Perm()); err != nil {
				return err
			}
			if !h.ModTime.IsZero() {
				_ = os.Chtimes(dest, h.ModTime, h.ModTime)
			}
		case tar.TypeSymlink:
			if !linkInside(rel, h.Linkname) {
				return archiveRefusal("the archive has a symbolic link that points out: %s -> %s", h.Name, h.Linkname)
			}
			if err := replaceable(dest, h.Name); err != nil {
				return err
			}
			if err := os.Symlink(h.Linkname, dest); err != nil {
				return err
			}
			if err := os.Lchown(dest, uid, gid); err != nil {
				return err
			}
			links[rel] = true
		default:
			return archiveRefusal("the archive has an entry of a kind that isn't extracted (%q): %s", h.Typeflag, h.Name)
		}
	}
	// Last, as writing into a directory changes its time.
	for i := len(dirTimes) - 1; i >= 0; i-- {
		if !dirTimes[i].at.IsZero() {
			_ = os.Chtimes(dirTimes[i].path, dirTimes[i].at, dirTimes[i].at)
		}
	}
	return nil
}

// entryRel is an entry's name relative to the top ("" for the top itself), refusing an absolute one or one with "..".
func entryRel(name string) (string, error) {
	if strings.HasPrefix(name, "/") {
		return "", archiveRefusal("the archive has an absolute name: %q", name)
	}
	parts := []string{}
	for _, part := range strings.Split(name, "/") {
		switch part {
		case "", ".":
			continue
		case "..":
			return "", archiveRefusal("the archive has a name that climbs out: %q", name)
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, "/"), nil
}

// linkInside is whether a link at rel pointing at target stays inside the top, read lexically.
func linkInside(rel, target string) bool {
	if target == "" || strings.HasPrefix(target, "/") {
		return false
	}
	depth := strings.Count(rel, "/")
	for _, part := range strings.Split(target, "/") {
		switch part {
		case "", ".":
		case "..":
			if depth == 0 {
				return false
			}
			depth--
		default:
			depth++
		}
	}
	return true
}

// dirsUnder makes the directories of rel (a clean relative path, "." for none) under target, refusing any that is
// there as a symbolic link or not a directory, so nothing written under them goes elsewhere.
func dirsUnder(target, rel string, uid, gid int) error {
	if rel == "." {
		return nil
	}
	at := target
	for _, part := range strings.Split(rel, "/") {
		at = filepath.Join(at, part)
		info, err := os.Lstat(at)
		switch {
		case errors.Is(err, os.ErrNotExist):
			if err := os.Mkdir(at, 0o755); err != nil {
				return err
			}
			if err := os.Lchown(at, uid, gid); err != nil {
				return err
			}
		case err != nil:
			return err
		case info.Mode()&os.ModeSymlink != 0:
			return archiveRefusal("%s is a symbolic link; nothing is extracted through one", at)
		case !info.IsDir():
			return archiveRefusal("%s isn't a directory", at)
		}
	}
	return nil
}

// replaceable clears dest for a file or link: what is there (a file, a link) is removed, but not a directory.
func replaceable(dest, name string) error {
	info, err := os.Lstat(dest)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return archiveRefusal("the archive has %s where a directory is", name)
	}
	return os.Remove(dest)
}

// dirMode is a directory entry's mode: its permissions and sticky bit (the agent, as root, writes into it whatever
// they are).
func dirMode(raw int64) os.FileMode {
	mode := os.FileMode(raw).Perm()
	if raw&0o1000 != 0 {
		mode |= os.ModeSticky
	}
	return mode
}

// mkdirAllOwned makes dir and what it needs above it, each one it makes owned by uid:gid.
func mkdirAllOwned(dir string, uid, gid int) error {
	info, err := os.Stat(dir)
	if err == nil {
		if !info.IsDir() {
			return archiveRefusal("%s isn't a directory", dir)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if parent := filepath.Dir(dir); parent != dir {
		if err := mkdirAllOwned(parent, uid, gid); err != nil {
			return err
		}
	}
	if err := os.Mkdir(dir, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	return os.Lchown(dir, uid, gid)
}
