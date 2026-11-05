package bundles

import (
	"archive/tar"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
)

// gnuSparseHeader is a GNU sparse entry (typeflag 'S') with no data and the logical size realSize, written in
// base-256 so it can be as large as math.MaxInt64: archive/tar answers that size as the header's Size.
func gnuSparseHeader(name string, realSize int64) []byte {
	h := make([]byte, 512)
	copy(h[0:100], name)
	copy(h[100:108], "0000644\x00")
	copy(h[108:116], "0000000\x00")
	copy(h[116:124], "0000000\x00")
	copy(h[124:136], "00000000000\x00") // its data on disk: none
	copy(h[136:148], "00000000000\x00")
	h[156] = tar.TypeGNUSparse
	copy(h[257:265], "ustar  \x00") // GNU magic and version
	// realsize, at 483: base-256 (the first byte's top bit), big-endian.
	h[483] = 0x80
	binary.BigEndian.PutUint64(h[487:495], uint64(realSize))
	for i := 148; i < 156; i++ {
		h[i] = ' '
	}
	var sum int64
	for _, b := range h {
		sum += int64(b)
	}
	copy(h[148:156], fmt.Sprintf("%06o\x00 ", sum))
	return h
}

// TestExtractRefusesAnOverflowingSparseSize: one byte, then a sparse entry whose logical size is math.MaxInt64,
// would wrap the running total negative and pass a check of the sum. It must be refused before its file is made.
// RLIMIT_FSIZE bounds what a regression could write.
func TestExtractRefusesAnOverflowingSparseSize(t *testing.T) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{Name: "one", Mode: 0o644, Typeflag: tar.TypeReg, Size: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Flush(); err != nil {
		t.Fatal(err)
	}
	buf.Write(gnuSparseHeader("sparse", math.MaxInt64))
	buf.Write(make([]byte, 1024))

	// The reader sees what an attacker's tar says.
	tr := tar.NewReader(bytes.NewReader(buf.Bytes()))
	if _, err := tr.Next(); err != nil {
		t.Fatal(err)
	}
	hdr, err := tr.Next()
	if err != nil || hdr.Typeflag != tar.TypeGNUSparse || hdr.Size != math.MaxInt64 {
		t.Fatalf("the sparse entry as archive/tar reads it: %+v %v", hdr, err)
	}
	if _, err := tr.Next(); err != io.EOF {
		t.Fatalf("then the end: %v", err)
	}

	dir := t.TempDir()
	p := filepath.Join(dir, "sparse.tar")
	if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	var old syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_FSIZE, &old); err != nil {
		t.Fatal(err)
	}
	signal.Ignore(syscall.SIGXFSZ)
	defer signal.Reset(syscall.SIGXFSZ)
	limit := old
	limit.Cur = 4 << 20
	if err := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &limit); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "root")
	err = Extract(p, root, 1<<20)
	if rerr := syscall.Setrlimit(syscall.RLIMIT_FSIZE, &old); rerr != nil {
		t.Fatal(rerr)
	}
	if err == nil || !bytes.Contains([]byte(err.Error()), []byte("more than")) {
		t.Fatalf("refused for its size: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(root, "sparse")); !os.IsNotExist(err) {
		t.Fatalf("nothing made for the sparse entry: %v", err)
	}

	// Files that add up to exactly the most are fine.
	exact := makeTar(t, entry{name: "a", body: string(make([]byte, 600))}, entry{name: "b", body: string(make([]byte, 424))})
	if err := os.WriteFile(p, exact, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Extract(p, filepath.Join(dir, "exact"), 1024); err != nil {
		t.Fatalf("exactly the most: %v", err)
	}
}
