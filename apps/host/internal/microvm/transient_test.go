package microvm

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// A stand-in for a fork's Firecracker: a process attached as one, whose exit is noticed as a machine's.
func fakeMachine(t *testing.T, vm string, cmd *exec.Cmd) (*fc.Machine, func()) {
	t.Helper()
	if err := os.MkdirAll(vm, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vm, fc.APISocket), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if cmd == nil {
		cmd = exec.Command("sleep", "60")
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	machine, err := fc.Attach(vm, cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	stop := func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}
	t.Cleanup(stop)
	return machine, stop
}

func spoolFile(t *testing.T, sp *spool, n int64) string {
	t.Helper()
	path := sp.reserve(n)
	if path == "" {
		t.Fatal("no room in the spool")
	}
	if err := os.WriteFile(path, make([]byte, n), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func used(sp *spool) int64 {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return sp.used
}

// A live fork restored from spooled memory maps it until its machine exits: the spool counts it until then, so a
// snapshot meanwhile goes to the disk once the spool is full, and gets the room back after.
func TestSpoolCountsAForksMappedMemoryUntilItExits(t *testing.T) {
	root := t.TempDir()
	spoolDir := filepath.Join(root, "spool")
	sp := newSpool(spoolDir, 2<<20, slog.New(slog.NewTextHandler(io.Discard, nil)))
	m := &Manager{cfg: Config{Root: root, SpoolDir: spoolDir}, spool: sp, log: slog.New(slog.NewTextHandler(io.Discard, nil)), sandboxes: map[string]*sandbox{}}
	s := &sandbox{dir: filepath.Join(root, "sandboxes", "sbx_fork")}
	s.meta.ID = "sbx_fork"
	machine, exit := fakeMachine(t, s.vmDir(), nil)
	s.machine = machine
	m.sandboxes[s.meta.ID] = s

	mem := spoolFile(t, sp, 3<<19) // 1.5 MiB of the 2
	m.keepMapped("sbx_fork", mem)
	if got := sp.reserve(1 << 20); got != "" {
		t.Fatal("the spool took a snapshot it has no room for while a fork maps its memory")
	}
	if used(sp) != 3<<19 {
		t.Fatalf("the spool counts %d bytes, want the fork's %d", used(sp), 3<<19)
	}

	exit()
	deadline := time.Now().Add(10 * time.Second)
	for used(sp) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the fork's memory was never given back once its machine exited")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, err := os.Stat(mem); !os.IsNotExist(err) {
		t.Fatalf("the fork's spooled memory is still there: %v", err)
	}
	if got := sp.reserve(1 << 20); got == "" {
		t.Fatal("no room in the spool once the fork had gone")
	}
}

// TestHelperMapsAFile is a stand-in Firecracker for TestAdoptMappedMemory: it maps the file it is given, privately as
// Firecracker maps a memory file, and waits to be killed.
func TestHelperMapsAFile(t *testing.T) {
	path := os.Getenv("KANTEL_TEST_MAP")
	if path == "" {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		os.Exit(2)
	}
	if _, err := syscall.Mmap(int(f.Fd()), 0, 4096, syscall.PROT_READ, syscall.MAP_PRIVATE); err != nil {
		os.Exit(3)
	}
	_ = f.Close()
	fmt.Println("mapped")
	time.Sleep(time.Minute)
	os.Exit(0)
}

// After a daemon restart (or one between a fork starting and its memory being counted), the spooled memory a running
// fork maps is counted again, found in its machine's mappings; spooled memory nothing links or maps (an interrupted
// fork's) is deleted; memory a link still points at is left for spool.adopt.
func TestAdoptMappedMemory(t *testing.T) {
	root := t.TempDir()
	spoolDir := filepath.Join(root, "spool")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	before := newSpool(spoolDir, 2<<20, log)
	mappedMem := spoolFile(t, before, 4096)
	orphan := spoolFile(t, before, 4096)
	linked := spoolFile(t, before, 4096)
	stopped := &sandbox{dir: filepath.Join(root, "sandboxes", "sbx_stopped")}
	if err := os.MkdirAll(stopped.vmDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(linked, filepath.Join(stopped.vmDir(), "mem")); err != nil {
		t.Fatal(err)
	}

	// The new run's spool counts nothing yet.
	sp := newSpool(spoolDir, 2<<20, log)
	m := &Manager{cfg: Config{Root: root, SpoolDir: spoolDir}, spool: sp, log: log, sandboxes: map[string]*sandbox{}}
	fork := &sandbox{dir: filepath.Join(root, "sandboxes", "sbx_running")}
	fork.meta.ID = "sbx_running"
	helper := exec.Command(os.Args[0], "-test.run=^TestHelperMapsAFile$")
	helper.Env = append(os.Environ(), "KANTEL_TEST_MAP="+mappedMem)
	out, err := helper.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	machine, exit := fakeMachine(t, fork.vmDir(), helper)
	if line, err := bufio.NewReader(out).ReadString('\n'); err != nil || line != "mapped\n" {
		t.Fatalf("the stand-in Firecracker said %q, %v", line, err)
	}
	fork.machine = machine
	m.sandboxes[fork.meta.ID] = fork
	stopped.meta.ID = "sbx_stopped"
	m.sandboxes[stopped.meta.ID] = stopped

	m.adoptMappedMemory()
	if got := used(sp); got != 4096 {
		t.Fatalf("the spool counts %d bytes after adopting, want the running fork's 4096", got)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatalf("spooled memory nothing uses is still there: %v", err)
	}
	for _, kept := range []string{mappedMem, linked} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("%s went: %v", kept, err)
		}
	}
	exit()
	deadline := time.Now().Add(10 * time.Second)
	for used(sp) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("an adopted fork's memory was never given back once its machine exited")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A live fork's own snapshot is in no history: a stopped source forks from its newest other one. One a previous run
// left (its fork cut short, perhaps after taking its disk) is deleted when the host starts; the others stay.
func TestTransientSnapshots(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	write := func(id string, createdAt int64, transient bool) {
		dir := filepath.Join(root, "snapshots", id)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(snapshotMeta{SnapshotInfo: proto.SnapshotInfo{ID: id, SandboxID: "sbx_src", Kind: "auto", CreatedAt: createdAt, Memory: true}, Transient: transient})
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("snap_kept", 1, false)
	write("snap_fork", 2, true) // newer, and its disk gone into a fork
	if got := m.latestSnapshot("sbx_src"); got != "snap_kept" {
		t.Fatalf("latest snapshot %q, want snap_kept", got)
	}
	if got := m.Snapshots("sbx_src"); len(got) != 1 || got[0].ID != "snap_kept" {
		t.Fatalf("snapshots %v, want only snap_kept", got)
	}
	// Still readable as itself: the fork restores from it by its ID.
	if _, err := m.readSnapshot("snap_fork"); err != nil {
		t.Fatal(err)
	}
	m.reapTransientSnapshots()
	if _, err := os.Stat(filepath.Join(root, "snapshots", "snap_fork")); !os.IsNotExist(err) {
		t.Fatalf("a live fork's leftover snapshot is still there: %v", err)
	}
	if _, err := m.readSnapshot("snap_kept"); err != nil {
		t.Fatalf("a kept snapshot went with it: %v", err)
	}
}
