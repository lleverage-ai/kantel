package fsutil

import (
	"io/fs"
	"path/filepath"
	"syscall"
)

// FileID is a file on the host: its device and inode, the same for every hard link to it.
type FileID struct{ Dev, Ino uint64 }

// Seen is the files counted already, so a file linked in several places counts once, and, made by OnFilesystemOf,
// the one filesystem they are counted on.
type Seen struct {
	files map[FileID]bool
	dev   uint64
	// oneDev: only files on dev count (OnFilesystemOf).
	oneDev bool
}

// NewSeen counts each file once, on whatever filesystem it is.
func NewSeen() *Seen { return &Seen{files: map[FileID]bool{}} }

// OnFilesystemOf counts each file once, and only those on the filesystem holding path: a file or directory on
// another (a bundle cache on a disk of its own, a mount under a walked directory) counts nothing, so what is counted
// is part of that filesystem's used space. A path that can't be read counts on every filesystem.
func OnFilesystemOf(path string) *Seen {
	s := NewSeen()
	var st syscall.Stat_t
	if syscall.Stat(path, &st) == nil {
		s.dev, s.oneDev = uint64(st.Dev), true
	}
	return s
}

// Allocated is the space the regular files under path take on the disk: the blocks they have allocated (a sparse
// file's holes take none). Symlinks aren't followed, so a link to a file elsewhere (in RAM, say) counts nothing. A file
// in seen counts nothing, and one counted here is added to it; one on another filesystem than seen's (OnFilesystemOf)
// counts nothing, nor does anything under a directory on another. seen may be nil: every file counts. A path that
// isn't there is 0.
func Allocated(path string, seen *Seen) int64 {
	var total int64
	Each(path, seen, func(id FileID, bytes int64) {
		if seen != nil {
			seen.Add(id)
		}
		total += bytes
	})
	return total
}

// Add counts a file as seen.
func (s *Seen) Add(id FileID) { s.files[id] = true }

// Each calls each with every regular file under path not in seen and on seen's filesystem (as Allocated counts them),
// once, with the blocks it has allocated, without adding it to seen: a caller that splits files among several holders
// adds them once it has. Names a skip leaves out (bundle drives in a snapshot, say). seen may be nil.
func Each(path string, seen *Seen, each func(id FileID, bytes int64), skip ...func(name string) bool) {
	visited := map[FileID]bool{}
	_ = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		dir, regular := d.IsDir(), d.Type().IsRegular()
		if !regular && !(dir && seen != nil && seen.oneDev) {
			return nil
		}
		var st syscall.Stat_t
		if syscall.Lstat(p, &st) != nil {
			return nil
		}
		if seen != nil && seen.oneDev && uint64(st.Dev) != seen.dev {
			if dir {
				return filepath.SkipDir
			}
			return nil
		}
		if dir {
			return nil
		}
		for _, leave := range skip {
			if leave(d.Name()) {
				return nil
			}
		}
		id := FileID{uint64(st.Dev), st.Ino}
		if visited[id] || (seen != nil && seen.files[id]) {
			return nil
		}
		visited[id] = true
		each(id, st.Blocks*512)
		return nil
	})
}
