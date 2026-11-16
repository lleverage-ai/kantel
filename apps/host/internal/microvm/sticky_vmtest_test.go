//go:build vmtest

// Real-VM test of a sticky disk's commit with discard on its drive: the guest trims the disk before the freeze,
// Firecracker punches the deleted file's blocks out of the drive's file, and the version doesn't keep them.
//
// It needs root, /dev/kvm, Firecracker v1.17 or later (discard), the guest kernel, a sandbox image and a static
// kantel-guest (the agent that trims a sticky disk, put in through Kantel's initramfs):
//
//	KANTEL_VMTEST_KERNEL=/images/vmlinux KANTEL_VMTEST_FIRECRACKER=/opt/firecracker \
//	KANTEL_VMTEST_ROOTFS=/images/sandbox-amd64.ext4 KANTEL_VMTEST_AGENT=/opt/kantel-guest \
//	  go test -tags vmtest -run StickyCommitDiscard -v ./internal/microvm/
package microvm

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guestinit"
	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func TestStickyCommitDiscard(t *testing.T) {
	kernel, firecracker, rootfs := os.Getenv("KANTEL_VMTEST_KERNEL"), os.Getenv("KANTEL_VMTEST_FIRECRACKER"), os.Getenv("KANTEL_VMTEST_ROOTFS")
	agent := os.Getenv("KANTEL_VMTEST_AGENT")
	if kernel == "" || firecracker == "" || rootfs == "" || agent == "" {
		t.Skip("KANTEL_VMTEST_KERNEL, KANTEL_VMTEST_FIRECRACKER, KANTEL_VMTEST_ROOTFS and KANTEL_VMTEST_AGENT")
	}
	if version := hostinfo.FirecrackerVersion(firecracker); !fc.DiscardSupported(version) {
		t.Skipf("Firecracker %q has no discard", version)
	}
	root := t.TempDir()
	initrd, err := guestinit.Build(filepath.Join(root, "initramfs"), agent)
	if err != nil {
		t.Fatal(err)
	}
	netm, err := network.New("10.235.0.0/16", 3129, false)
	if err != nil {
		t.Fatal(err)
	}
	logs := &lockedBuffer{}
	m, err := New(Config{
		Root: filepath.Join(root, "microvm"), Firecracker: firecracker, Kernel: kernel, Rootfs: rootfs, Initrd: initrd,
		Sizes: []proto.Size{{Name: "default", VCPUs: 2, MemoryMiB: 2048, DiskGiB: 4}}, Network: netm, ProxyPort: 3129,
		Discard: true,
		Log:     slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelInfo})),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	const id, path = "sbx_sticky_discard", "/var/lib/ci"
	if _, err := m.Create(ctx, proto.CreateParams{SandboxID: id, Tier: Tier, VCPUs: 2, MemoryMiB: 2048, DiskGiB: 4,
		Egress: &proto.Egress{Mode: network.EgressNone}, StickyDisks: []proto.StickyDisk{{DiskID: "ci", Path: path, SizeGiB: 4}}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Delete(context.Background(), id) })
	run := func(cmd string) {
		t.Helper()
		res, err := m.Exec(ctx, proto.ExecParams{SandboxID: id, Command: cmd, User: "root"}, nil)
		if err != nil || res.ExitCode != 0 {
			t.Fatalf("%q: %v %d %q", cmd, err, res.ExitCode, res.Stderr)
		}
	}
	run("echo kept > " + path + "/kept && dd if=/dev/urandom of=" + path + "/big bs=1M count=512 conv=fsync status=none && rm " + path + "/big && sync")
	res, err := m.CommitSticky(ctx, proto.StickyCommitParams{SandboxID: id, DiskID: "ci", Version: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("the version has %d MiB allocated", res.AllocatedBytes>>20)
	if !strings.Contains(logs.String(), "trimmed a sticky disk before its commit") {
		t.Fatalf("no trim before the commit:\n%s", logs.String())
	}
	if res.AllocatedBytes > 256<<20 {
		t.Fatalf("the version has %d MiB allocated after a 512 MiB file was deleted: its blocks weren't freed", res.AllocatedBytes>>20)
	}
}
