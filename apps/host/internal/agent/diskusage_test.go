package agent

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A heartbeat never waits for the disk to be walked: the first has no measure, and a measure is taken again only once
// it is DiskUsageEvery old.
func TestDiskUsageIsMeasuredInTheBackground(t *testing.T) {
	var measured atomic.Int32
	h := &Host{}
	at := time.Now().UnixMilli()
	h.disk.measure = func() proto.DiskUsage {
		measured.Add(1)
		return proto.DiskUsage{TotalBytes: 100, UsedBytes: 40, OtherBytes: 40, MeasuredAt: at}
	}
	if got := h.diskUsage(); got != nil {
		t.Fatalf("a measure before any was taken: %+v", got)
	}
	deadline := time.Now().Add(5 * time.Second)
	var got *proto.DiskUsage
	for got == nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
		h.disk.mu.Lock()
		got = h.disk.last
		h.disk.mu.Unlock()
	}
	if got == nil || got.UsedBytes != 40 {
		t.Fatalf("no measure: %+v", got)
	}
	if again := h.diskUsage(); again == nil || again.TotalBytes != 100 {
		t.Fatalf("the measure isn't answered: %+v", again)
	}
	time.Sleep(20 * time.Millisecond)
	if n := measured.Load(); n != 1 {
		t.Fatalf("measured %d times within DiskUsageEvery", n)
	}
}

// Without a microVM tier, the host's bundles, images and isolates are counted, and the rest of the used space is other.
func TestMeasureDiskWithoutTiers(t *testing.T) {
	root := t.TempDir()
	h := &Host{cfg: Config{Root: root}}
	for path, n := range map[string]int{"bundles/a.erofs": 1 << 20, "images/vmlinux": 2 << 20, "isolate/ws/file": 3 << 20} {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, make([]byte, n), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got := h.measureDisk()
	if got.BundlesBytes == 0 || got.ImagesBytes == 0 || got.SandboxesBytes == 0 || got.TotalBytes == 0 {
		t.Fatalf("not measured: %+v", got)
	}
	known := got.BundlesBytes + got.ImagesBytes + got.SandboxesBytes
	if got.OtherBytes != max(0, got.UsedBytes-known) {
		t.Fatalf("other is %d, want used %d less %d", got.OtherBytes, got.UsedBytes, known)
	}
}

// A bundle cache on another filesystem than Root's isn't part of Root's used space, so it counts nothing.
func TestMeasureDiskCountsOnlyRootsFilesystem(t *testing.T) {
	root := t.TempDir()
	var at, st syscall.Stat_t
	if err := syscall.Stat(root, &at); err != nil {
		t.Fatal(err)
	}
	cache, err := os.MkdirTemp("/dev/shm", "bundles-")
	if err != nil || syscall.Stat(cache, &st) != nil || st.Dev == at.Dev {
		t.Skip("no other filesystem for the bundle cache")
	}
	t.Cleanup(func() { _ = os.RemoveAll(cache) })
	if err := os.WriteFile(filepath.Join(cache, "a.erofs"), make([]byte, 1<<20), 0o600); err != nil {
		t.Fatal(err)
	}
	h := &Host{cfg: Config{Root: root, BundleCacheDir: cache}}
	if got := h.measureDisk(); got.BundlesBytes != 0 {
		t.Fatalf("a bundle cache on another filesystem counted %d bytes", got.BundlesBytes)
	}
}
