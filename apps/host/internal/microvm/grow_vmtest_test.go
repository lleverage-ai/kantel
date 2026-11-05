//go:build vmtest

// Real-VM test of a shared template's deferred disk growth: a sandbox restored from the template's smaller disk must
// end with its own size's however its growth after the create is cut short (a stop, a host restart, a snapshot).
//
// It needs root, /dev/kvm, Firecracker, the guest kernel and a sandbox image whose agent has /disk/grow:
//
//	KANTEL_VMTEST_KERNEL=/images/vmlinux KANTEL_VMTEST_FIRECRACKER=/opt/firecracker \
//	KANTEL_VMTEST_ROOTFS=/images/sandbox-amd64.ext4 go test -tags vmtest -run DeferredDiskGrowth -v ./internal/microvm/
package microvm

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func TestDeferredDiskGrowth(t *testing.T) {
	kernel, firecracker, rootfs := os.Getenv("KANTEL_VMTEST_KERNEL"), os.Getenv("KANTEL_VMTEST_FIRECRACKER"), os.Getenv("KANTEL_VMTEST_ROOTFS")
	if kernel == "" || firecracker == "" || rootfs == "" {
		t.Skip("KANTEL_VMTEST_KERNEL, KANTEL_VMTEST_FIRECRACKER and KANTEL_VMTEST_ROOTFS")
	}
	netm, err := network.New("10.232.0.0/16", 3129, false)
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		Root: t.TempDir(), Firecracker: firecracker, Kernel: kernel, Rootfs: rootfs, SharedTemplate: true,
		Sizes: []proto.Size{{Name: "default", VCPUs: 2, MemoryMiB: 2048, DiskGiB: 4}}, Network: netm, ProxyPort: 3129,
		Log: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})),
	}
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { m.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	// 12 GiB on the template's 4 GiB disk: restored, then grown.
	params := func(id string) proto.CreateParams {
		return proto.CreateParams{SandboxID: id, Tier: Tier, VCPUs: 2, MemoryMiB: 2048, DiskGiB: 12, Egress: &proto.Egress{Mode: network.EgressNone}}
	}
	if err := m.WaitTemplate(ctx, params("")); err != nil {
		t.Fatal(err)
	}
	const want = int64(12) << 30
	// fsBytes is the file system's size on the sandbox's disk.
	fsBytes := func(m *Manager, id string) int64 {
		t.Helper()
		res, err := m.Exec(ctx, proto.ExecParams{SandboxID: id, Command: `df -B1 --output=size "$(findmnt -n -o TARGET /dev/vdb | head -1)" | tail -1`}, nil)
		if err != nil || res.ExitCode != 0 {
			t.Fatalf("df on %s: %v %q", id, err, res.Stderr)
		}
		n, err := strconv.ParseInt(strings.TrimSpace(res.Stdout), 10, 64)
		if err != nil {
			t.Fatalf("df on %s: %q", id, res.Stdout)
		}
		return n
	}
	// grown waits for the file system to be (nearly: ext4 keeps some for itself) the size's.
	grown := func(m *Manager, id string) {
		t.Helper()
		deadline := time.Now().Add(time.Minute)
		for {
			n := fsBytes(m, id)
			if n > want*9/10 {
				t.Logf("%s: file system %d GiB", id, n>>30)
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s: file system still %d bytes, want about %d", id, n, want)
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	notGrown := func(m *Manager, id string) {
		t.Helper()
		if n := fsBytes(m, id); n > want/2 {
			t.Fatalf("%s grew (%d bytes) while growth was held", id, n)
		}
	}
	created := func(id string) {
		t.Helper()
		info, err := m.Create(ctx, params(id))
		if err != nil {
			t.Fatal(err)
		}
		if info.Source != "snapshot" {
			t.Fatalf("%s: made by %s, want a restore of the shared template", id, info.Source)
		}
		t.Cleanup(func() { _ = m.Delete(context.Background(), id) })
	}

	// A stop before the growth: the resume grows it.
	m.holdGrowth.Store(true)
	created("sbx_grow_stop")
	notGrown(m, "sbx_grow_stop")
	if _, err := m.Stop(ctx, proto.StopParams{SandboxID: "sbx_grow_stop", SnapshotID: "snap_grow_stop"}); err != nil {
		t.Fatal(err)
	}
	m.holdGrowth.Store(false)
	if _, err := m.Resume(ctx, proto.ResumeParams{SandboxID: "sbx_grow_stop"}, false); err != nil {
		t.Fatal(err)
	}
	grown(m, "sbx_grow_stop")

	// A fork of a sandbox not yet grown: the fork grows from its snapshot's disk.
	m.holdGrowth.Store(true)
	created("sbx_grow_src")
	m.holdGrowth.Store(false)
	if _, err := m.Fork(ctx, proto.ForkParams{SandboxID: "sbx_grow_src", NewID: "sbx_grow_fork", SnapshotID: "snap_grow_fork"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Delete(context.Background(), "sbx_grow_fork") })
	grown(m, "sbx_grow_fork")
	// The fork took its snapshot's disk: the snapshot, which nothing restores again, is gone.
	if _, err := m.readSnapshot("snap_grow_fork"); err == nil {
		t.Fatal("a live fork's snapshot is still on the host")
	}

	// A host restart before the growth: the next run adopts the sandbox and grows it.
	m.holdGrowth.Store(true)
	created("sbx_grow_adopt")
	m.Close()
	m, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	grown(m, "sbx_grow_adopt")
	if raw, _ := os.ReadFile(filepath.Join(cfg.Root, "sandboxes", "sbx_grow_adopt", "meta.json")); strings.Contains(string(raw), `"growDisk"`) {
		t.Fatalf("growth still pending once grown: %s", raw)
	}
}
