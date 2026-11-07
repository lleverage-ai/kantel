//go:build vmtest

// Real-VM test of a guest agent that stops answering (TASK-5682): the host marks the sandbox unresponsive and says so
// in an event; a start with Reset (a recovery) ends the frozen VM and boots it cold from its disk, its files kept and
// its agent answering again; a plain start of a frozen one does the same; a stop of a frozen one doesn't wait on its
// sync; and a stop of one already stopped answers a snapshot of its disk.
//
// It needs root, /dev/kvm, Firecracker, the guest kernel, a sandbox image and a static kantel-guest:
//
//	KANTEL_VMTEST_KERNEL=/images/vmlinux KANTEL_VMTEST_FIRECRACKER=/opt/firecracker \
//	KANTEL_VMTEST_ROOTFS=/images/sandbox.ext4 KANTEL_VMTEST_AGENT=/opt/kantel-guest \
//	  go test -tags vmtest -run UnresponsiveGuest -v ./internal/microvm/
package microvm

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/guestinit"
	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

func TestUnresponsiveGuest(t *testing.T) {
	kernel, firecracker, rootfs := os.Getenv("KANTEL_VMTEST_KERNEL"), os.Getenv("KANTEL_VMTEST_FIRECRACKER"), os.Getenv("KANTEL_VMTEST_ROOTFS")
	agent := os.Getenv("KANTEL_VMTEST_AGENT")
	if kernel == "" || firecracker == "" || rootfs == "" || agent == "" {
		t.Skip("KANTEL_VMTEST_KERNEL, KANTEL_VMTEST_FIRECRACKER, KANTEL_VMTEST_ROOTFS and KANTEL_VMTEST_AGENT")
	}
	healthInterval, healthTimeout, healthMisses = time.Second, time.Second, 3
	root := t.TempDir()
	initrd, err := guestinit.Build(filepath.Join(root, "initramfs"), agent)
	if err != nil {
		t.Fatal(err)
	}
	netm, err := network.New("10.235.0.0/16", 3129, false)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var events []proto.SandboxInfo
	logs := &lockedBuffer{}
	m, err := New(Config{
		Root: filepath.Join(root, "microvm"), Firecracker: firecracker, Kernel: kernel, Rootfs: rootfs, Initrd: initrd,
		Sizes: []proto.Size{{Name: "default", VCPUs: 2, MemoryMiB: 2048, DiskGiB: 4}}, Network: netm, ProxyPort: 3129,
		AutoSnapshots: 2,
		Events: func(info proto.SandboxInfo) {
			mu.Lock()
			defer mu.Unlock()
			events = append(events, info)
		},
		Log: slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelInfo})),
	})
	if err != nil {
		t.Fatal(err)
	}
	// The one in use at the end: the test restarts it.
	defer func() { m.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	const id = "sbx_unresponsive"
	if _, err := m.Create(ctx, proto.CreateParams{SandboxID: id, Tier: Tier, VCPUs: 2, MemoryMiB: 2048, DiskGiB: 4, Egress: &proto.Egress{Mode: network.EgressNone}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Delete(context.Background(), id) })
	run := func(cmd string) string {
		t.Helper()
		cctx, ccancel := context.WithTimeout(ctx, 30*time.Second)
		defer ccancel()
		res, err := m.Exec(cctx, proto.ExecParams{SandboxID: id, Command: cmd, User: "root"}, nil)
		if err != nil || res.ExitCode != 0 {
			t.Fatalf("%q: %v %d %q", cmd, err, res.ExitCode, res.Stderr)
		}
		return strings.TrimSpace(res.Stdout)
	}
	unresponsive := func() proto.SandboxInfo {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			info, err := m.Get(id)
			if err == nil && info.Health == proto.HealthUnresponsive {
				return info
			}
			time.Sleep(200 * time.Millisecond)
		}
		t.Fatalf("never reported unresponsive:\n%s", logs.String())
		return proto.SandboxInfo{}
	}
	// The agent stops itself a moment after answering: a stand-in for one starved of memory.
	freeze := func() {
		t.Helper()
		run(`setsid sh -c 'sleep 1; kill -STOP $(pidof kantel-guest)' </dev/null >/dev/null 2>&1 &`)
	}
	bootID := func() string { return run("cat /proc/sys/kernel/random/boot_id") }

	run("mkdir -p /var/tmp/k && echo kept > /var/tmp/k/marker && sync")
	first := bootID()
	freeze()
	info := unresponsive()
	t.Logf("unresponsive: %q", info.HealthReason)
	if info.State != proto.StateRunning || !strings.Contains(info.HealthReason, "hasn't answered") {
		t.Fatalf("info %+v", info)
	}
	mu.Lock()
	reported := false
	for _, e := range events {
		reported = reported || e.Health == proto.HealthUnresponsive
	}
	mu.Unlock()
	if !reported {
		t.Fatal("no event said it was unresponsive")
	}

	// A recovery: reset and cold boot, the disk kept.
	start := time.Now()
	after, err := m.Resume(ctx, proto.ResumeParams{SandboxID: id, Reset: true}, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("recovered in %v", time.Since(start).Round(time.Millisecond))
	if after.State != proto.StateRunning || after.Health != "" {
		t.Fatalf("after the recovery %+v", after)
	}
	if got := run("cat /var/tmp/k/marker"); got != "kept" {
		t.Fatalf("marker %q", got)
	}
	second := bootID()
	if second == first {
		t.Fatal("the recovery didn't boot it again")
	}

	// A plain start of a frozen one resets it too, rather than answering it as running.
	freeze()
	unresponsive()
	if _, err := m.Resume(ctx, proto.ResumeParams{SandboxID: id}, true); err != nil {
		t.Fatal(err)
	}
	if third := bootID(); third == second {
		t.Fatal("a start of a frozen sandbox didn't boot it again")
	}

	// A stop of a frozen one isn't held up by its sync; a stop of one stopped answers its disk.
	freeze()
	unresponsive()
	no := false
	start = time.Now()
	if _, err := m.Stop(ctx, proto.StopParams{SandboxID: id, SnapshotID: "snap_unresp_1", Memory: &no}); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 30*time.Second {
		t.Fatalf("the stop took %v", took)
	}
	t.Logf("stopped a frozen sandbox in %v", time.Since(start).Round(time.Millisecond))
	if _, err := m.Stop(ctx, proto.StopParams{SandboxID: id, SnapshotID: "snap_unresp_2", Memory: &no}); err != nil {
		t.Fatalf("a stop of a stopped sandbox: %v", err)
	}
	if _, err := m.Resume(ctx, proto.ResumeParams{SandboxID: id}, true); err != nil {
		t.Fatal(err)
	}
	if got := run("cat /var/tmp/k/marker"); got != "kept" {
		t.Fatalf("marker after stop and start %q", got)
	}

	// Paused with its memory, then stopped without it: the memory goes for good, so its next start (after the host
	// restarts, too) boots from its disk.
	pausedBoot := bootID()
	yes := true
	if snap, err := m.Stop(ctx, proto.StopParams{SandboxID: id, SnapshotID: "snap_unresp_3", Memory: &yes}); err != nil || !snap.Memory {
		t.Fatalf("the pause: %+v %v", snap, err)
	}
	if snap, err := m.Stop(ctx, proto.StopParams{SandboxID: id, SnapshotID: "snap_unresp_4", Memory: &no}); err != nil || snap.Memory {
		t.Fatalf("the disk-only stop of a paused sandbox: %+v %v", snap, err)
	}
	m.Close()
	m, err = New(m.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Resume(ctx, proto.ResumeParams{SandboxID: id}, true); err != nil {
		t.Fatal(err)
	}
	if got := bootID(); got == pausedBoot {
		t.Fatal("a sandbox stopped without its memory resumed its memory")
	}
	if got := run("cat /var/tmp/k/marker"); got != "kept" {
		t.Fatalf("marker after the disk-only stop of a paused sandbox %q", got)
	}
}
