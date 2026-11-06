//go:build vmtest

// Real-VM test of a live fork whose memory goes to the RAM spool, so its disk is copied beside the memory
// (liveSnapshot): a guest writing to its disk all through the fork must find, in the fork, every write its memory holds
// as written back on the disk too.
//
// It needs root, /dev/kvm, Firecracker, the guest kernel, a sandbox image and a tmpfs at /dev/shm with room for a few
// GiB of memory files:
//
//	KANTEL_VMTEST_KERNEL=/images/vmlinux KANTEL_VMTEST_FIRECRACKER=/opt/firecracker \
//	KANTEL_VMTEST_ROOTFS=/images/sandbox-amd64.ext4 go test -tags vmtest -run SpooledFork -v ./internal/microvm/
package microvm

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/network"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func TestSpooledForkDiskMatchesMemory(t *testing.T) {
	kernel, firecracker, rootfs := os.Getenv("KANTEL_VMTEST_KERNEL"), os.Getenv("KANTEL_VMTEST_FIRECRACKER"), os.Getenv("KANTEL_VMTEST_ROOTFS")
	if kernel == "" || firecracker == "" || rootfs == "" {
		t.Skip("KANTEL_VMTEST_KERNEL, KANTEL_VMTEST_FIRECRACKER and KANTEL_VMTEST_ROOTFS")
	}
	spoolDir, err := os.MkdirTemp("/dev/shm", "kantel-vmtest-spool-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(spoolDir) })
	netm, err := network.New("10.232.0.0/16", 3129, false)
	if err != nil {
		t.Fatal(err)
	}
	logs := &lockedBuffer{}
	cfg := Config{
		Root: t.TempDir(), Firecracker: firecracker, Kernel: kernel, Rootfs: rootfs, SharedTemplate: true,
		Sizes: []proto.Size{{Name: "default", VCPUs: 2, MemoryMiB: 2048, DiskGiB: 4}}, Network: netm, ProxyPort: 3129,
		SpoolDir: spoolDir, SpoolMaxMiB: 8192,
		Log: slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelInfo})),
	}
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { m.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	params := proto.CreateParams{SandboxID: "sbx_spool_src", Tier: Tier, Size: "default", Egress: &proto.Egress{Mode: network.EgressNone}}
	if err := m.WaitTemplate(ctx, params); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Create(ctx, params); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Delete(context.Background(), "sbx_spool_src") })
	run := func(id, cmd string) string {
		t.Helper()
		res, err := m.Exec(ctx, proto.ExecParams{SandboxID: id, Command: cmd}, nil)
		if err != nil || res.ExitCode != 0 {
			t.Fatalf("%s: %q: %v %d %q", id, cmd, err, res.ExitCode, res.Stderr)
		}
		return strings.TrimSpace(res.Stdout)
	}
	const dir = "/var/tmp/kantel-vmtest"
	t.Logf("writes go to %s", run("sbx_spool_src", "mkdir -p "+dir+" && findmnt -n -o SOURCE,FSTYPE --target "+dir))
	// Writes all the time, each one written back (fsync) before the next: whichever the pause cuts into, the memory
	// holds what was written back as clean pages, which the disk must hold too.
	run("sbx_spool_src", `setsid sh -c 'echo $$ > /var/tmp/kantel-vmtest.pid; i=0; while :; do i=$((i+1)); dd if=/dev/urandom of=`+dir+`/w.$((i % 16)) bs=64k count=4 conv=fsync status=none; echo $i > `+dir+`/seq; sync `+dir+`/seq; done' </dev/null >/dev/null 2>&1 &`)
	time.Sleep(2 * time.Second)

	const forks = 4
	for i := range forks {
		id := fmt.Sprintf("sbx_spool_fork%d", i)
		start := time.Now()
		info, err := m.Fork(ctx, proto.ForkParams{SandboxID: "sbx_spool_src", NewID: id, SnapshotID: fmt.Sprintf("snap_spool_fork%d", i)})
		if err != nil {
			t.Fatal(err)
		}
		took := time.Since(start)
		m.spool.mu.Lock()
		used := m.spool.used
		m.spool.mu.Unlock()
		if used == 0 {
			t.Fatalf("%s: the memory didn't go to the spool, so the disk wasn't copied beside it", id)
		}
		// The writer came along in memory; stop it, write back what it left dirty, and read every file from the page
		// cache (the memory's view), then again from the disk.
		run(id, `p=$(cat /var/tmp/kantel-vmtest.pid); kill $p; while kill -0 $p 2>/dev/null; do sleep 0.05; done; pkill -x dd || true; while pgrep -x dd >/dev/null; do sleep 0.05; done; sync`)
		cached := run(id, "cd "+dir+" && md5sum w.* seq")
		run(id, "sudo -n sh -c 'echo 3 > /proc/sys/vm/drop_caches'")
		onDisk := run(id, "cd "+dir+" && md5sum w.* seq")
		if cached != onDisk {
			t.Fatalf("%s: the disk lacks writes its memory holds as written back:\nmemory:\n%s\ndisk:\n%s", id, cached, onDisk)
		}
		t.Logf("%s: forked in %v (seq %s), timings %v", id, took.Round(time.Millisecond), run(id, "cat "+dir+"/seq"), info.Timings)
		if err := m.Delete(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	again := strings.Count(logs.String(), "copying it again")
	t.Logf("the disk was copied again in %d of %d forks", again, forks)
	if strings.Contains(logs.String(), "can't watch the disk") {
		t.Fatal("the disk couldn't be watched, so it was copied after the memory")
	}
}
