package fsutil

import (
	"io/fs"
	"path/filepath"
	"syscall"
)

// FileID is a file on the host: its device and inode, the same for every hard link to it.
type FileID struct{ Dev, Ino uint64 }

// Seen is the files counted already, so a file linked in several places counts once.
type Seen map[FileID]bool

// Allocated is the space the regular files under path take on the disk: the blocks they have allocated (a sparse
// file's holes take none). Symlinks aren't followed, so a link to a file elsewhere (in RAM, say) counts nothing. A file
// in seen counts nothing, and one counted here is added to it; seen may be nil. A path that isn't there is 0.
func Allocated(path string, seen Seen) int64 {
	var total int64
	_ = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return nil
		}
		var st syscall.Stat_t
		if syscall.Lstat(p, &st) != nil {
			return nil
		}
		id := FileID{uint64(st.Dev), st.Ino}
		if seen != nil {
			if seen[id] {
				return nil
			}
			seen[id] = true
		}
		total += st.Blocks * 512
		return nil
	})
	return total
}
