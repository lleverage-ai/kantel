// Package blockmap makes and reads block maps (docs/design/disk-store.md, "On one host" and 2b): a disk file's size,
// and the SHA-256 of each of its 4 MiB blocks, all-zero bytes standing for a block that is all zeros. Two hosts compare
// a version's map with one they have to move only the blocks that differ.
//
// A map is cheap to make from an older one of the same disk (Make with a Base): a block whose extents the file still
// shares with the older file (the same physical extents at the same offsets, from FIEMAP) holds the same bytes, so it
// keeps the older map's hash, and only the other blocks are read. A block with no data on the disk (a hole, or an
// unwritten extent) is all zeros and isn't read either. Without FIEMAP, or reflinks, every block with data is read.
//
// The map's file is a header, then HashSize bytes per block, in order:
//
//	magic     8 bytes  "KTBMAP01"
//	size      8 bytes  the file's size in bytes, big-endian
//	blockSize 8 bytes  BlockSize, big-endian
//
// The last block is short when the size isn't a multiple of the block size, and is hashed as it is. A map's digest
// (Digest) is the SHA-256 of its file, which a catalogue keeps to check a map fetched from elsewhere.
package blockmap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/lleverage-ai/kantel/apps/host/internal/fsutil"
)

// BlockSize is a map's block: 4 MiB.
const BlockSize = 4 << 20

// HashSize is the bytes of each block's hash in a map.
const HashSize = sha256.Size

const headerSize = 24

var magic = [8]byte{'K', 'T', 'B', 'M', 'A', 'P', '0', '1'}

// Map is a file's block map: its size, and each block's hash (all zeros for a block of zeros).
type Map struct {
	Size   int64
	hashes []byte
}

// New is an empty map of a file of size bytes: every block's hash is all zeros until it is set.
func New(size int64) *Map {
	return &Map{Size: size, hashes: make([]byte, blocks(size)*HashSize)}
}

func blocks(size int64) int64 { return (size + BlockSize - 1) / BlockSize }

// Blocks is how many blocks the map has.
func (m *Map) Blocks() int { return len(m.hashes) / HashSize }

// Hash is block i's hash.
func (m *Map) Hash(i int) [HashSize]byte {
	var h [HashSize]byte
	copy(h[:], m.hashes[i*HashSize:])
	return h
}

// Set sets block i's hash.
func (m *Map) Set(i int, h [HashSize]byte) { copy(m.hashes[i*HashSize:], h[:]) }

// Range is the bytes block i covers in its file: [start, end).
func (m *Map) Range(i int) (start, end int64) {
	start = int64(i) * BlockSize
	return start, min(start+BlockSize, m.Size)
}

// MarshalBinary is the map's file.
func (m *Map) MarshalBinary() ([]byte, error) {
	out := make([]byte, headerSize, headerSize+len(m.hashes))
	copy(out, magic[:])
	binary.BigEndian.PutUint64(out[8:], uint64(m.Size))
	binary.BigEndian.PutUint64(out[16:], BlockSize)
	return append(out, m.hashes...), nil
}

// UnmarshalBinary reads a map's file, refusing one that isn't a whole map of BlockSize blocks.
func (m *Map) UnmarshalBinary(b []byte) error {
	if len(b) < headerSize || !bytes.Equal(b[:8], magic[:]) {
		return errors.New("not a block map")
	}
	size, bs := binary.BigEndian.Uint64(b[8:]), binary.BigEndian.Uint64(b[16:])
	if bs != BlockSize {
		return fmt.Errorf("a block map of %d-byte blocks, not %d", bs, BlockSize)
	}
	if size > 1<<62 || int64(len(b)-headerSize) != blocks(int64(size))*HashSize {
		return fmt.Errorf("a block map of %d bytes for a %d-byte file", len(b), size)
	}
	m.Size = int64(size)
	m.hashes = append([]byte(nil), b[headerSize:]...)
	return nil
}

// Digest is the digest of a map's file: "sha256:" and its SHA-256 in hex.
func Digest(file []byte) string {
	sum := sha256.Sum256(file)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// ReadFile reads the map at path, with its digest.
func ReadFile(path string) (*Map, string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	m := &Map{}
	if err := m.UnmarshalBinary(raw); err != nil {
		return nil, "", fmt.Errorf("%s: %w", path, err)
	}
	return m, Digest(raw), nil
}

// WriteFile writes m to path, replacing whatever is there atomically and durably, and answers its digest.
func WriteFile(path string, m *Map) (string, error) {
	raw, _ := m.MarshalBinary()
	if err := fsutil.WriteFileDurably(path, raw, 0o600); err != nil {
		return "", err
	}
	return Digest(raw), nil
}

// HashBlock is a block's hash: all zeros for a block of zeros, else its SHA-256.
func HashBlock(b []byte) [HashSize]byte {
	if allZero(b) {
		return [HashSize]byte{}
	}
	return sha256.Sum256(b)
}

var zeros = make([]byte, 64<<10)

func allZero(b []byte) bool {
	for len(b) > 0 {
		n := min(len(b), len(zeros))
		if !bytes.Equal(b[:n], zeros[:n]) {
			return false
		}
		b = b[n:]
	}
	return true
}

// Base is an older file of the same disk and its map, which Make takes hashes from where the new file still shares
// its extents. Neither may change while Make runs.
type Base struct {
	File *os.File
	Map  *Map
}

// Stats is what Make did: of the map's blocks, how many kept the base's hash (Reused), how many had no data on the disk
// (Empty), and how many it read and hashed (Read), with the bytes it read.
type Stats struct {
	Blocks    int
	Reused    int
	Empty     int
	Read      int
	BytesRead int64
}

// readers is how many blocks Make reads and hashes at once.
var readers = min(4, runtime.GOMAXPROCS(0))

// Make makes f's map. With a base on the same file system and of the same size, a block whose extents f shares with
// the base's file keeps the base's hash. f must not change while it runs.
func Make(ctx context.Context, f *os.File, base *Base) (*Map, Stats, error) {
	info, err := f.Stat()
	if err != nil {
		return nil, Stats{}, err
	}
	m := New(info.Size())
	st := Stats{Blocks: m.Blocks()}
	mine := newExtents(f, m.Size)
	var theirs *extents
	if mine != nil && base != nil && base.File != nil && base.Map != nil {
		if bi, err := base.File.Stat(); err == nil && bi.Size() == base.Map.Size && sameDevice(info, bi) {
			theirs = newExtents(base.File, bi.Size())
		}
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var (
		read     atomic.Int64
		failOnce sync.Once
		failed   error
		wg       sync.WaitGroup
	)
	fail := func(err error) {
		failOnce.Do(func() { failed = err })
		cancel()
	}
	work := make(chan int)
	for range readers {
		wg.Go(func() {
			buf := make([]byte, BlockSize)
			for i := range work {
				start, end := m.Range(i)
				n, err := f.ReadAt(buf[:end-start], start)
				if err != nil && !(errors.Is(err, io.EOF) && int64(n) == end-start) {
					fail(fmt.Errorf("reading block %d: %w", i, err))
					continue
				}
				m.Set(i, HashBlock(buf[:n]))
				read.Add(int64(n))
			}
		})
	}
	for i := 0; i < st.Blocks && ctx.Err() == nil; i++ {
		start, end := m.Range(i)
		if theirs != nil && i < base.Map.Blocks() {
			if _, theirEnd := base.Map.Range(i); theirEnd == end && shared(mine, theirs, start, end) {
				m.Set(i, base.Map.Hash(i))
				st.Reused++
				continue
			}
		}
		if empty(f, mine, start, end) {
			st.Empty++
			continue
		}
		st.Read++
		select {
		case work <- i:
		case <-ctx.Done():
		}
	}
	close(work)
	wg.Wait()
	if failed != nil {
		return nil, Stats{}, failed
	}
	if err := ctx.Err(); err != nil {
		return nil, Stats{}, err
	}
	st.BytesRead = read.Load()
	return m, st, nil
}

func sameDevice(a, b os.FileInfo) bool {
	sa, ok1 := a.Sys().(*syscall.Stat_t)
	sb, ok2 := b.Sys().(*syscall.Stat_t)
	return ok1 && ok2 && sa.Dev == sb.Dev
}

// shared says whether every byte of [start, end) is at the same place on the disk in both files (or a hole in both),
// in extents whose place can be trusted.
func shared(mine, theirs *extents, start, end int64) bool {
	a, ok := mine.within(start, end)
	if !ok {
		return false
	}
	b, ok := theirs.within(start, end)
	if !ok {
		return false
	}
	for pos := start; pos < end; {
		ea, na := at(a, pos, end)
		eb, nb := at(b, pos, end)
		if (ea == nil) != (eb == nil) {
			return false
		}
		if ea != nil {
			if !ea.placed() || !eb.placed() || ea.flags&extentUnwritten != eb.flags&extentUnwritten ||
				ea.physical+(pos-ea.logical) != eb.physical+(pos-eb.logical) {
				return false
			}
		}
		pos = min(na, nb)
	}
	return true
}

// empty says whether [start, end) of f has no data on the disk, so reads as zeros: holes and unwritten extents only.
// Without FIEMAP it asks lseek(SEEK_DATA); when neither can say, it has data.
func empty(f *os.File, mine *extents, start, end int64) bool {
	if mine != nil {
		if exts, ok := mine.within(start, end); ok {
			for _, e := range exts {
				if e.flags&extentUnwritten == 0 || !e.placed() {
					return false
				}
			}
			return true
		}
	}
	off, err := f.Seek(start, seekData)
	if errors.Is(err, syscall.ENXIO) {
		return true // no data after start
	}
	return err == nil && off >= end
}

// at is the extent of exts holding pos (nil: a hole), and where that ends: the extent's end, or the next extent's
// start, at most limit.
func at(exts []extent, pos, limit int64) (*extent, int64) {
	for i := range exts {
		e := &exts[i]
		if pos < e.logical {
			return nil, min(e.logical, limit)
		}
		if pos < e.end() {
			return e, min(e.end(), limit)
		}
	}
	return nil, limit
}
