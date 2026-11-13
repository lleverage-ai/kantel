package blockmap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// fullMap is f's map made the plain way: every block read and hashed, start to end.
func fullMap(t *testing.T, path string) *Map {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	info, _ := f.Stat()
	m := New(info.Size())
	buf := make([]byte, BlockSize)
	for i := range m.Blocks() {
		start, end := m.Range(i)
		if _, err := f.ReadAt(buf[:end-start], start); err != nil && err != io.EOF {
			t.Fatal(err)
		}
		block := buf[:end-start]
		if !bytes.Equal(block, make([]byte, len(block))) {
			m.Set(i, sha256.Sum256(block))
		}
	}
	return m
}

func encode(m *Map) []byte {
	raw, _ := m.MarshalBinary()
	return raw
}

// pattern fills b with bytes that say which disk (seed) and block they are from, so no two blocks are the same.
func pattern(b []byte, seed, block uint64) {
	for k := 0; k+8 <= len(b); k += 8 {
		binary.LittleEndian.PutUint64(b[k:], seed<<48^block<<24^uint64(k)|1)
	}
}

func makeMap(t *testing.T, path string, base *Base) (*Map, Stats) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	m, st, err := Make(context.Background(), f, base)
	if err != nil {
		t.Fatal(err)
	}
	return m, st
}

// A map's file is its header and a hash per block; it reads back the same, and a file that isn't a whole map is
// refused. Its digest is its file's SHA-256.
func TestMapFile(t *testing.T) {
	m := New(2*BlockSize + 10)
	if m.Blocks() != 3 {
		t.Fatalf("%d blocks", m.Blocks())
	}
	if s, e := m.Range(2); s != 2*BlockSize || e != 2*BlockSize+10 {
		t.Fatalf("the last block is %d to %d", s, e)
	}
	m.Set(1, HashBlock([]byte("data")))
	raw := encode(m)
	if len(raw) != headerSize+3*HashSize || string(raw[:8]) != "KTBMAP01" || binary.BigEndian.Uint64(raw[8:]) != 2*BlockSize+10 || binary.BigEndian.Uint64(raw[16:]) != BlockSize {
		t.Fatalf("header %x", raw[:headerSize])
	}
	path := filepath.Join(t.TempDir(), "v.map")
	digest, err := WriteFile(path, m)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	if want := "sha256:" + hex.EncodeToString(sum[:]); digest != want {
		t.Fatalf("digest %s, want %s", digest, want)
	}
	got, again, err := ReadFile(path)
	if err != nil || again != digest || !bytes.Equal(encode(got), raw) || got.Hash(1) != HashBlock([]byte("data")) {
		t.Fatalf("read back %v %s", err, again)
	}
	for name, bad := range map[string][]byte{
		"empty":       nil,
		"not a map":   append([]byte("KTBMAP02"), raw[8:]...),
		"short":       raw[:len(raw)-1],
		"long":        append(append([]byte(nil), raw...), 0),
		"other block": func() []byte { b := append([]byte(nil), raw...); binary.BigEndian.PutUint64(b[16:], 1<<20); return b }(),
	} {
		if err := (&Map{}).UnmarshalBinary(bad); err == nil {
			t.Errorf("%s: read as a map", name)
		}
	}
	if New(0).Blocks() != 0 || len(encode(New(0))) != headerSize {
		t.Fatal("an empty file's map isn't just its header")
	}
}

// A block of zeros hashes to all zeros, whatever its length; any other block to its SHA-256.
func TestHashBlock(t *testing.T) {
	if HashBlock(make([]byte, BlockSize)) != [HashSize]byte{} || HashBlock(nil) != [HashSize]byte{} {
		t.Fatal("a block of zeros isn't all zeros")
	}
	b := make([]byte, BlockSize)
	b[BlockSize-1] = 1
	if HashBlock(b) != sha256.Sum256(b) {
		t.Fatal("a block with one byte set isn't its SHA-256")
	}
}

// Without a base, a map is every block's hash, as a full read makes it, and a block with no data on the disk (a hole)
// is zeros without being read, on any file system that says where its holes are (lseek SEEK_DATA, or FIEMAP).
func TestMakeWithoutBase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v.img")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	size := int64(6*BlockSize + 4096 + 3) // a short last block
	if err := f.Truncate(size); err != nil {
		t.Fatal(err)
	}
	block := make([]byte, BlockSize)
	pattern(block, 1, 1)
	_, _ = f.WriteAt(block, BlockSize)
	_, _ = f.WriteAt([]byte("tail"), size-4)
	_, _ = f.WriteAt(make([]byte, 4096), 4*BlockSize) // data that is zeros: read, and zeros
	f.Close()

	m, st := makeMap(t, path, nil)
	if !bytes.Equal(encode(m), encode(fullMap(t, path))) {
		t.Fatal("the map differs from a full rehash")
	}
	if m.Hash(1) != sha256.Sum256(block) || m.Hash(0) != [HashSize]byte{} || m.Hash(4) != [HashSize]byte{} || m.Hash(6) == [HashSize]byte{} {
		t.Fatal("wrong hashes")
	}
	t.Logf("%+v", st)
	if st.Blocks != 7 || st.Reused != 0 || st.Read+st.Empty != 7 {
		t.Fatalf("stats %+v", st)
	}
	// tmpfs and every disk file system a host runs on say where holes are: then only blocks with data are read.
	if st.Empty > 0 && (st.Read != 3 || st.BytesRead != 2*BlockSize+(size-6*BlockSize)) {
		t.Fatalf("read %+v, want blocks 1, 4 and 6 only", st)
	}
}

// A base whose file isn't the same size, or on another file system, gives no hashes: the map is still right.
func TestMakeIgnoresAnUnfitBase(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	block := make([]byte, BlockSize)
	pattern(block, 2, 0)
	_ = os.WriteFile(a, block, 0o600)
	_ = os.WriteFile(b, append(block, 1), 0o600)
	bm, _ := makeMap(t, b, nil)
	bf, _ := os.Open(b)
	defer bf.Close()
	m, st := makeMap(t, a, &Base{File: bf, Map: bm})
	if st.Reused != 0 || !bytes.Equal(encode(m), encode(fullMap(t, a))) {
		t.Fatalf("%+v", st)
	}
}

// A cancelled make stops, with no map.
func TestMakeCancelled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v.img")
	block := make([]byte, BlockSize)
	pattern(block, 3, 0)
	_ = os.WriteFile(path, bytes.Repeat(block, 3), 0o600)
	f, _ := os.Open(path)
	defer f.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if m, _, err := Make(ctx, f, nil); err == nil || m != nil {
		t.Fatalf("a cancelled make answered %v", err)
	}
}

// at and shared, on extents: bytes at the same place in both files are shared; a hole in one and data in the other,
// another place, or an extent whose place isn't known, aren't.
func TestShared(t *testing.T) {
	mk := func(list ...extent) *extents { return &extents{done: true, cur: list} }
	e := func(logical, physical, length int64, flags uint32) extent {
		return extent{logical: logical, physical: physical, length: length, flags: flags}
	}
	B := int64(BlockSize)
	for name, c := range map[string]struct {
		a, b []extent
		want bool
	}{
		"one extent each":          {[]extent{e(0, 100*B, B, 0)}, []extent{e(0, 100*B, B, 0)}, true},
		"split differently":        {[]extent{e(0, 100*B, B/2, 0), e(B/2, 100*B+B/2, B/2, 0)}, []extent{e(0, 100*B, B, 0)}, true},
		"holes in both":            {nil, nil, true},
		"the same hole":            {[]extent{e(0, 7*B, B/4, 0), e(B/2, 9*B, B/2, 0)}, []extent{e(0, 7*B, B/4, 0), e(B/2, 9*B, B/2, 0)}, true},
		"hole in one":              {[]extent{e(0, 7*B, B/4, 0)}, []extent{e(0, 7*B, B, 0)}, false},
		"moved":                    {[]extent{e(0, 100*B, B, 0)}, []extent{e(0, 101*B, B, 0)}, false},
		"one page moved":           {[]extent{e(0, 100*B, B-4096, 0), e(B-4096, 5, 4096, 0)}, []extent{e(0, 100*B, B, 0)}, false},
		"delayed":                  {[]extent{e(0, 0, B, extentDelalloc)}, []extent{e(0, 0, B, extentDelalloc)}, false},
		"compressed":               {[]extent{e(0, 100*B, B, extentEncoded)}, []extent{e(0, 100*B, B, extentEncoded)}, false},
		"unwritten in one":         {[]extent{e(0, 100*B, B, extentUnwritten)}, []extent{e(0, 100*B, B, 0)}, false},
		"from before the block":    {[]extent{e(-B, 99*B, 2*B, 0)}, []extent{e(0, 100*B, B, 0)}, true},
		"shared and last, flagged": {[]extent{e(0, 100*B, B, extentLast|0x2000)}, []extent{e(0, 100*B, B, 0x2000)}, true},
	} {
		if got := shared(mk(c.a...), mk(c.b...), 0, B); got != c.want {
			t.Errorf("%s: shared %v, want %v", name, got, c.want)
		}
	}
	if shared(&extents{bad: true}, mk(), 0, B) {
		t.Error("extents that couldn't be read are shared")
	}
}
