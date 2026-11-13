package fsutil

import (
	"os"

	"golang.org/x/sys/unix"
)

// Reflink makes dst a clone of src (FICLONE), with src's permissions: its blocks shared until either is written. It
// fails on a file system without reflinks, leaving dst (made, empty) to the caller.
func Reflink(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	return ReflinkFrom(in, dst)
}

// ReflinkFrom is Reflink from a file open already: the file it is, whatever its name is now.
func ReflinkFrom(in *os.File, dst string) error {
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if err := unix.IoctlFileClone(int(out.Fd()), int(in.Fd())); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
