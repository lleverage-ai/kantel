package blockmap

import (
	"encoding/binary"
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/unix"
)

// seekData is lseek's SEEK_DATA: the next offset with data at or after the one given.
const seekData = unix.SEEK_DATA

// FIEMAP (linux/fiemap.h): FS_IOC_FIEMAP is _IOWR('f', 11, struct fiemap), whose header is 32 bytes, each extent 56.
const (
	fsIocFiemap     = 0xC020660B
	fiemapFlagSync  = 0x1
	fiemapHeader    = 32
	fiemapExtentLen = 56
	fiemapBatch     = 256
)

// An extent's flags (FIEMAP_EXTENT_*).
const (
	extentLast        = 0x1
	extentUnknown     = 0x2
	extentDelalloc    = 0x4
	extentEncoded     = 0x8
	extentEncrypted   = 0x80
	extentNotAligned  = 0x100
	extentInline      = 0x200
	extentTail        = 0x400
	extentUnwritten   = 0x800
	extentUnplacedSet = extentUnknown | extentDelalloc | extentEncoded | extentEncrypted | extentNotAligned | extentInline | extentTail
)

// extent is a run of a file's bytes at one place on the disk.
type extent struct {
	logical, physical, length int64
	flags                     uint32
}

func (e *extent) end() int64 { return e.logical + e.length }

// placed says whether the extent's physical place says where its bytes are: not yet allocated (delayed), unknown,
// compressed or encrypted (whose place doesn't map byte for byte), or kept in the inode or a shared tail, it doesn't.
func (e *extent) placed() bool { return e.flags&extentUnplacedSet == 0 }

// extents reads a file's extents in order, a batch at a time, as Make walks its blocks.
type extents struct {
	fd    int
	size  int64
	next  int64
	done  bool
	bad   bool
	first bool
	cur   []extent
	buf   []byte
}

// newExtents is f's extents, or nil when its file system has no FIEMAP.
func newExtents(f *os.File, size int64) *extents {
	x := &extents{fd: int(f.Fd()), size: size, first: true, buf: make([]byte, fiemapHeader+fiemapBatch*fiemapExtentLen)}
	if size == 0 {
		x.done = true
		return x
	}
	if err := x.fetch(); err != nil {
		return nil
	}
	return x
}

// within is the extents that meet [start, end), in order; calls go forward through the file. Not ok when FIEMAP
// failed, after which nothing is known.
func (x *extents) within(start, end int64) ([]extent, bool) {
	i := 0
	for i < len(x.cur) && x.cur[i].end() <= start {
		i++
	}
	x.cur = x.cur[i:]
	for !x.bad && !x.done && (len(x.cur) == 0 || x.cur[len(x.cur)-1].end() < end) {
		if err := x.fetch(); err != nil {
			x.bad = true
		}
	}
	if x.bad {
		return nil, false
	}
	j := 0
	for j < len(x.cur) && x.cur[j].logical < end {
		j++
	}
	return x.cur[:j], true
}

// fetch reads the next batch of extents, from x.next on. The first call syncs the file, so no extent is still to be
// allocated.
func (x *extents) fetch() error {
	if x.next >= x.size {
		x.done = true
		return nil
	}
	clear(x.buf)
	ne := binary.NativeEndian
	ne.PutUint64(x.buf[0:], uint64(x.next))
	ne.PutUint64(x.buf[8:], uint64(x.size-x.next))
	if x.first {
		ne.PutUint32(x.buf[16:], fiemapFlagSync)
	}
	ne.PutUint32(x.buf[24:], fiemapBatch)
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(x.fd), fsIocFiemap, uintptr(unsafe.Pointer(&x.buf[0]))); errno != 0 {
		return errno
	}
	x.first = false
	mapped := int(ne.Uint32(x.buf[20:]))
	if mapped == 0 {
		x.done = true
		return nil
	}
	for k := range min(mapped, fiemapBatch) {
		raw := x.buf[fiemapHeader+k*fiemapExtentLen:]
		e := extent{
			logical:  int64(ne.Uint64(raw[0:])),
			physical: int64(ne.Uint64(raw[8:])),
			length:   int64(ne.Uint64(raw[16:])),
			flags:    ne.Uint32(raw[40:]),
		}
		x.cur = append(x.cur, e)
		if e.flags&extentLast != 0 {
			x.done = true
		}
	}
	last := x.cur[len(x.cur)-1]
	if last.end() <= x.next {
		// No progress: never loop on a file system that answers the same extent again.
		return errEndless
	}
	x.next = last.end()
	return nil
}

var errEndless = errors.New("FIEMAP answered no further extents")
