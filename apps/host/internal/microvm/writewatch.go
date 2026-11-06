package microvm

import (
	"errors"

	"golang.org/x/sys/unix"
)

// writeWatch tells whether anything wrote to a file after it was started: inotify's IN_MODIFY, which the kernel raises
// for every write, truncate and fallocate (hole punched or not), by read and write or io_uring alike, whatever the
// file's timestamps say. A file's times come from a coarse clock, so two writes within one tick leave the same mtime
// and ctime; this doesn't depend on them.
//
// The event is queued in the writer's own call, before its write returns. So a write that Firecracker has told the
// guest is done (and that a memory snapshot then records as done) is in the queue by the time that snapshot is written.
type writeWatch struct {
	fd int
}

// watchWrites starts watching path for writes, or says why it can't.
func watchWrites(path string) (*writeWatch, error) {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return nil, err
	}
	if _, err := unix.InotifyAddWatch(fd, path, unix.IN_MODIFY|unix.IN_DELETE_SELF|unix.IN_MOVE_SELF); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	return &writeWatch{fd: fd}, nil
}

// written says whether the file was written, truncated, moved or deleted since watchWrites, or an event may have been
// lost (the queue overflowed) or the watch can't be read: anything but certainty that it wasn't is a write.
func (w *writeWatch) written() bool {
	buf := make([]byte, 4096)
	n, err := unix.Read(w.fd, buf)
	if errors.Is(err, unix.EAGAIN) {
		return false
	}
	return err != nil || n > 0
}

func (w *writeWatch) close() {
	_ = unix.Close(w.fd)
}
