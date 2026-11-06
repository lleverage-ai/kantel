//go:build vmtest

// Real-VM test of a disk-only save of a running microVM (SaveSnapshot without memory): the guest trims its disk first,
// Firecracker's discard punches the deleted file's blocks out of disk.ext4, so the snapshot doesn't keep them; the copy
// is a consistent ext4 even with the guest writing all through the save; and a sandbox of another size starts from it.
//
// It needs root, /dev/kvm, Firecracker v1.17 or later (discard), the guest kernel, a sandbox image and a static
// kantel-guest (the agent that trims, put in through Kantel's initramfs):
//
//	KANTEL_VMTEST_KERNEL=/images/vmlinux KANTEL_VMTEST_FIRECRACKER=/opt/firecracker \
//	KANTEL_VMTEST_ROOTFS=/images/sandbox-amd64.ext4 KANTEL_VMTEST_AGENT=/opt/kantel-guest \
//	  go test -tags vmtest -run DiskOnlySave -v ./internal/microvm/
package microvm

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
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

func TestDiskOnlySave(t *testing.T) {
	kernel, firecracker, rootfs := os.Getenv("KANTEL_VMTEST_KERNEL"), os.Getenv("KANTEL_VMTEST_FIRECRACKER"), os.Getenv("KANTEL_VMTEST_ROOTFS")
	agent := os.Getenv("KANTEL_VMTEST_AGENT")
	if kernel == "" || firecracker == "" || rootfs == "" || agent == "" {
		t.Skip("KANTEL_VMTEST_KERNEL, KANTEL_VMTEST_FIRECRACKER, KANTEL_VMTEST_ROOTFS and KANTEL_VMTEST_AGENT")
	}
	version := hostinfo.FirecrackerVersion(firecracker)
	if !fc.DiscardSupported(version) {
		t.Skipf("Firecracker %q has no discard", version)
	}
	root := t.TempDir()
	initrd, err := guestinit.Build(filepath.Join(root, "initramfs"), agent)
	if err != nil {
		t.Fatal(err)
	}
	netm, err := network.New("10.234.0.0/16", 3129, false)
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
	const src = "sbx_diskonly_src"
	if _, err := m.Create(ctx, proto.CreateParams{SandboxID: src, Tier: Tier, VCPUs: 2, MemoryMiB: 2048, DiskGiB: 4, Egress: &proto.Egress{Mode: network.EgressNone}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Delete(context.Background(), src) })
	run := func(id, cmd string) string {
		t.Helper()
		res, err := m.Exec(ctx, proto.ExecParams{SandboxID: id, Command: cmd, User: "root"}, nil)
		if err != nil || res.ExitCode != 0 {
			t.Fatalf("%s: %q: %v %d %q", id, cmd, err, res.ExitCode, res.Stderr)
		}
		return strings.TrimSpace(res.Stdout)
	}
	s, err := m.get(src)
	if err != nil {
		t.Fatal(err)
	}
	// pauseMachine resumes a VM whose pause answer was lost, which may not have paused: resuming a running VM must be
	// harmless.
	if err := s.machine.Resume(ctx); err != nil {
		t.Fatalf("resuming a running VM: %v", err)
	}
	disk := filepath.Join(s.vmDir(), fc.DiskFile)
	const dir = "/var/tmp/kantel-vmtest"
	run(src, "mkdir -p "+dir+" && echo kept > "+dir+"/marker && sync")
	// The guest's own discard (mounted with it) would free these as they're deleted; a big file deleted is what a
	// snapshot shouldn't copy, whichever frees it.
	run(src, "dd if=/dev/urandom of="+dir+"/big bs=1M count=512 conv=fsync status=none && sync")
	full := diskUsage(disk)
	run(src, "rm "+dir+"/big && sync")
	t.Logf("disk.ext4 uses %d MiB with the 512 MiB file, %d MiB once deleted", full>>20, diskUsage(disk)>>20)

	// Writes all through the save, each fsynced: the copy has to be one instant of them.
	run(src, `setsid sh -c 'i=0; while :; do i=$((i+1)); dd if=/dev/urandom of=`+dir+`/w.$((i % 16)) bs=64k count=4 conv=fsync status=none; done' </dev/null >/dev/null 2>&1 &`)
	time.Sleep(time.Second)

	start := time.Now()
	snap, err := m.SaveSnapshot(ctx, proto.SnapshotParams{SandboxID: src, SnapshotID: "snap_diskonly", Name: "disk-only"})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("disk-only save in %v: %d MiB", time.Since(start).Round(time.Millisecond), snap.SizeBytes>>20)
	if snap.Memory {
		t.Fatal("a save without memory kept memory")
	}
	sdir := m.snapshotDir(snap.ID)
	if _, err := os.Stat(filepath.Join(sdir, "mem")); !os.IsNotExist(err) {
		t.Fatalf("a disk-only snapshot has a memory file: %v", err)
	}
	if !strings.Contains(logs.String(), "trimmed the disk before a snapshot") {
		t.Fatalf("no trim before the save:\n%s", logs.String())
	}
	if snap.SizeBytes > full-400<<20 {
		t.Fatalf("the snapshot is %d MiB, the disk was %d MiB with the deleted file: its blocks weren't freed", snap.SizeBytes>>20, full>>20)
	}

	// A copy, as a crash would leave it: the journal replays and the file system checks clean.
	check := filepath.Join(root, "check.ext4")
	if err := copySparse(filepath.Join(sdir, fc.DiskFile), check); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("e2fsck", "-fy", check).CombinedOutput()
	if code := exitCode(err); code > 1 {
		t.Fatalf("e2fsck %d: %s", code, out)
	}

	withMemory, err := m.SaveSnapshot(ctx, proto.SnapshotParams{SandboxID: src, SnapshotID: "snap_withmem", Name: "with-memory", Memory: true})
	if err != nil {
		t.Fatal(err)
	}
	if !withMemory.Memory {
		t.Fatal("a save asking for memory didn't keep it")
	}
	t.Logf("with memory: %d MiB", withMemory.SizeBytes>>20)

	// Another size than the source's: a disk-only snapshot isn't tied to its machine.
	const made = "sbx_diskonly_made"
	if _, err := m.Create(ctx, proto.CreateParams{SandboxID: made, Tier: Tier, From: snap.ID, VCPUs: 1, MemoryMiB: 1024, DiskGiB: 4, Egress: &proto.Egress{Mode: network.EgressNone}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Delete(context.Background(), made) })
	if got := run(made, "cat "+dir+"/marker"); got != "kept" {
		t.Fatalf("marker %q", got)
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	if exit, ok := err.(*exec.ExitError); ok {
		return exit.ExitCode()
	}
	return 99
}
