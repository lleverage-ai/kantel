package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// fakeHealth answers a guest's health as told: answering, or not (as a starved agent doesn't, until its timeout).
type fakeHealth struct {
	answering atomic.Bool
	asked     atomic.Int32
}

func (f *fakeHealth) Health(ctx context.Context) (guest.Health, error) {
	f.asked.Add(1)
	if f.answering.Load() {
		return guest.Health{OK: true}, nil
	}
	<-ctx.Done()
	return guest.Health{}, ctx.Err()
}

// events records the infos a manager emits.
type events struct {
	mu   sync.Mutex
	list []proto.SandboxInfo
}

func (e *events) add(info proto.SandboxInfo) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.list = append(e.list, info)
}

func (e *events) all() []proto.SandboxInfo {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]proto.SandboxInfo(nil), e.list...)
}

func fastHealth(t *testing.T) {
	t.Helper()
	interval, timeout, misses, mem := healthInterval, healthTimeout, healthMisses, readGuestMemory
	healthInterval, healthTimeout, healthMisses = 20*time.Millisecond, 30*time.Millisecond, 3
	t.Cleanup(func() { healthInterval, healthTimeout, healthMisses, readGuestMemory = interval, timeout, misses, mem })
}

// runningSandbox is a sandbox the manager has running on a stand-in machine (a sleeping process), whose agent's
// health is probe's.
func runningSandbox(t *testing.T, ev *events) (*Manager, *sandbox, *fakeHealth, *fc.Machine) {
	t.Helper()
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, Events: ev.add}, log: slog.New(slog.DiscardHandler), sandboxes: map[string]*sandbox{}}
	s := &sandbox{dir: filepath.Join(root, "sandboxes", "sbx_health")}
	s.meta.ID, s.meta.Size, s.meta.State, s.meta.Memory = "sbx_health", "small", proto.StateRunning, true
	machine := reapedMachine(t, s.vmDir())
	probe := &fakeHealth{}
	probe.answering.Store(true)
	s.machine, s.guest, s.probe = machine, guest.NewClient(filepath.Join(s.vmDir(), "none.sock")), probe
	m.sandboxes[s.meta.ID] = s
	return m, s, probe, machine
}

// reapedMachine is fakeMachine's stand-in, reaped as it exits, so a kill shows as the machine's end (a zombie still
// answers signal 0).
func reapedMachine(t *testing.T, vm string) *fc.Machine {
	t.Helper()
	if err := os.MkdirAll(vm, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vm, fc.APISocket), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(reaped)
	}()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		<-reaped
	})
	machine, err := fc.Attach(vm, cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	return machine
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A guest agent that stops answering makes the sandbox unresponsive, with a reason in its info and an event, after
// healthMisses probes in a row; when it answers again the sandbox is reported healthy again.
func TestWatchHealthReportsAnUnresponsiveGuestAndItsReturn(t *testing.T) {
	fastHealth(t)
	readGuestMemory = func(context.Context, string) (usage.Memory, error) {
		return usage.Memory{Total: 8 << 30, Available: 100 << 20}, nil
	}
	ev := &events{}
	m, s, probe, machine := runningSandbox(t, ev)
	s.mu.Lock()
	m.watch(s, machine)
	s.mu.Unlock()
	waitFor(t, "a few answered probes", func() bool { return probe.asked.Load() >= 3 })
	if len(ev.all()) != 0 {
		t.Fatalf("a healthy guest was reported: %+v", ev.all())
	}
	probe.answering.Store(false)
	waitFor(t, "the unresponsive event", func() bool { return len(ev.all()) == 1 })
	got := ev.all()[0]
	if got.Health != proto.HealthUnresponsive || got.State != proto.StateRunning {
		t.Fatalf("event %+v, want running and unresponsive", got)
	}
	if !strings.Contains(got.HealthReason, "hasn't answered") || !strings.Contains(got.HealthReason, "out of memory (7.9 GB of 8.0 GB in use)") {
		t.Fatalf("reason %q", got.HealthReason)
	}
	s.mu.Lock()
	if info := m.info(s); info.Health != proto.HealthUnresponsive {
		t.Fatalf("info says %q", info.Health)
	}
	s.mu.Unlock()
	probe.answering.Store(true)
	waitFor(t, "the healthy event", func() bool { return len(ev.all()) == 2 })
	if got := ev.all()[1]; got.Health != "" || got.HealthReason != "" {
		t.Fatalf("event after the agent answered again: %+v", got)
	}
	// Each change moves HealthAt on, so Kantel orders them whichever reaches it first.
	if first, second := ev.all()[0].HealthAt, ev.all()[1].HealthAt; first <= 0 || second <= first {
		t.Fatalf("HealthAt %d then %d, want them increasing", first, second)
	}
}

// A sandbox paused with its memory and then stopped without it lets the memory go, for good: its next start boots
// from its disk, after a restart of the host too.
func TestDiskOnlyStopOfAPausedSandboxDropsItsMemory(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, AutoSnapshots: 2}, log: slog.New(slog.DiscardHandler), sandboxes: map[string]*sandbox{}}
	m.spool = newSpool(filepath.Join(root, "spool"), 0, m.log)
	s := &sandbox{dir: filepath.Join(root, "sandboxes", "sbx_paused")}
	s.meta.ID, s.meta.Size, s.meta.State, s.meta.Memory = "sbx_paused", "small", proto.StateStopped, true
	if err := os.MkdirAll(s.vmDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{fc.DiskFile: "disk", "state": "state", "mem": "mem"} {
		if err := os.WriteFile(filepath.Join(s.vmDir(), name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m.sandboxes[s.meta.ID] = s
	yes, no := true, false
	// A memory-keeping stop of it again keeps it.
	snap, err := m.Stop(context.Background(), proto.StopParams{SandboxID: s.meta.ID, SnapshotID: "snap_kept", Memory: &yes})
	if err != nil || !snap.Memory || !s.meta.Memory {
		t.Fatalf("a paused stop again: %+v %v, memory %v", snap, err, s.meta.Memory)
	}
	snap, err = m.Stop(context.Background(), proto.StopParams{SandboxID: s.meta.ID, SnapshotID: "snap_disk", Memory: &no})
	if err != nil || snap.Memory || s.meta.Memory {
		t.Fatalf("a disk-only stop: %+v %v, memory %v", snap, err, s.meta.Memory)
	}
	for _, name := range []string{"state", "mem"} {
		if _, err := os.Lstat(filepath.Join(s.vmDir(), name)); !os.IsNotExist(err) {
			t.Fatalf("its %s is still there: %v", name, err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(s.dir, "meta.json"))
	if err != nil || strings.Contains(string(raw), `"memory":true`) {
		t.Fatalf("its written state: %s %v", raw, err)
	}
	// The earlier snapshot is kept, its memory let go as the automatic snapshots' pruning does for all but the newest.
	if raw, err := os.ReadFile(filepath.Join(m.snapshotDir("snap_kept"), fc.DiskFile)); err != nil || string(raw) != "disk" {
		t.Fatalf("the earlier snapshot's disk: %q %v", raw, err)
	}
}

// A guest that isn't out of memory is unresponsive without that being said.
func TestUnresponsiveReasonWithMemoryToSpare(t *testing.T) {
	spare := func(context.Context, string) (usage.Memory, error) {
		return usage.Memory{Total: 8 << 30, Available: 4 << 30}, nil
	}
	reason := unresponsiveReason(spare, t.TempDir(), time.Minute)
	if strings.Contains(reason, "out of memory") || !strings.Contains(reason, "60 seconds") {
		t.Fatalf("reason %q", reason)
	}
	none := func(context.Context, string) (usage.Memory, error) { return usage.Memory{}, errors.New("no balloon") }
	if reason := unresponsiveReason(none, t.TempDir(), time.Minute); reason != "Its guest agent hasn't answered for 60 seconds" {
		t.Fatalf("reason without memory %q", reason)
	}
}

// A probe that would wait on the sandbox's lock (a snapshot holds it, perhaps with the VM paused) isn't counted.
func TestWatchHealthSkipsWhileTheSandboxIsHeld(t *testing.T) {
	fastHealth(t)
	ev := &events{}
	m, s, probe, machine := runningSandbox(t, ev)
	probe.answering.Store(false)
	s.mu.Lock()
	m.watch(s, machine)
	time.Sleep(20 * healthInterval)
	asked := probe.asked.Load()
	s.mu.Unlock()
	if asked != 0 || len(ev.all()) != 0 {
		t.Fatalf("probed %d times and reported %d events while the lock was held", asked, len(ev.all()))
	}
}

// A reset ends the machine (its exit isn't taken for the VM's own), keeps the disk, drops the memory and leaves the
// sandbox stopped for a cold boot; answers says a sandbox whose agent doesn't answer doesn't.
func TestResetEndsTheMachineAndKeepsTheDisk(t *testing.T) {
	fastHealth(t)
	ev := &events{}
	m, s, probe, machine := runningSandbox(t, ev)
	disk := filepath.Join(s.vmDir(), fc.DiskFile)
	if err := os.WriteFile(disk, []byte("disk"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	m.watch(s, machine)
	if !m.answers(context.Background(), s) {
		t.Fatal("an answering agent was taken not to answer")
	}
	probe.answering.Store(false)
	if m.answers(context.Background(), s) {
		t.Fatal("an agent that doesn't answer was taken to")
	}
	m.reset(s, "a test")
	s.mu.Unlock()
	select {
	case <-machine.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the machine is still running")
	}
	time.Sleep(50 * time.Millisecond)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.machine != nil || s.meta.State != proto.StateStopped || s.meta.Memory || s.meta.Pid != 0 || s.meta.Error != "" {
		t.Fatalf("after the reset: machine %v state %q memory %v pid %d error %q", s.machine, s.meta.State, s.meta.Memory, s.meta.Pid, s.meta.Error)
	}
	if raw, err := os.ReadFile(disk); err != nil || string(raw) != "disk" {
		t.Fatalf("the disk after the reset: %q %v", raw, err)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "meta.json")); err != nil {
		t.Fatalf("the stopped state wasn't written: %v", err)
	}
	for _, e := range ev.all() {
		if e.Error == "the VM exited" {
			t.Fatal("the reset was taken for the VM exiting by itself")
		}
	}
}

// A stop of a running sandbox whose Firecracker doesn't answer (its API socket refuses) stops it cold, rather than
// failing and leaving it running; a guest that doesn't answer isn't waited on for its sync.
func TestStopOfAMachineThatWontPauseStopsItCold(t *testing.T) {
	fastHealth(t)
	ev := &events{}
	m, s, probe, machine := runningSandbox(t, ev)
	m.cfg.AutoSnapshots = 2
	m.spool = newSpool(filepath.Join(m.cfg.Root, "spool"), 0, m.log)
	probe.answering.Store(false)
	s.unresponsive = "Its guest agent hasn't answered for 60 seconds"
	if err := os.WriteFile(filepath.Join(s.vmDir(), fc.DiskFile), []byte("disk"), 0o600); err != nil {
		t.Fatal(err)
	}
	yes := true
	start := time.Now()
	snap, err := m.Stop(context.Background(), proto.StopParams{SandboxID: s.meta.ID, SnapshotID: "snap_cold", Memory: &yes})
	if err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 8*time.Second {
		t.Fatalf("the stop took %v", took)
	}
	if snap.Memory || s.meta.State != proto.StateStopped || s.meta.Memory || s.machine != nil {
		t.Fatalf("snapshot %+v, state %q memory %v", snap, s.meta.State, s.meta.Memory)
	}
	select {
	case <-machine.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the machine is still running")
	}
	if raw, err := os.ReadFile(filepath.Join(m.snapshotDir("snap_cold"), fc.DiskFile)); err != nil || string(raw) != "disk" {
		t.Fatalf("the snapshot's disk: %q %v", raw, err)
	}
}

// A stop of a sandbox the host has stopped already answers a snapshot of its disk rather than a conflict.
func TestStopOfAStoppedSandboxAnswersItsDisk(t *testing.T) {
	root := t.TempDir()
	m := &Manager{cfg: Config{Root: root, AutoSnapshots: 2}, log: slog.New(slog.DiscardHandler), sandboxes: map[string]*sandbox{}}
	m.spool = newSpool(filepath.Join(root, "spool"), 0, m.log)
	s := &sandbox{dir: filepath.Join(root, "sandboxes", "sbx_stopped")}
	s.meta.ID, s.meta.Size, s.meta.State = "sbx_stopped", "small", proto.StateStopped
	if err := os.MkdirAll(s.vmDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.vmDir(), fc.DiskFile), []byte("disk"), 0o600); err != nil {
		t.Fatal(err)
	}
	m.sandboxes[s.meta.ID] = s
	no := false
	snap, err := m.Stop(context.Background(), proto.StopParams{SandboxID: s.meta.ID, SnapshotID: "snap_again", Memory: &no})
	if err != nil {
		t.Fatal(err)
	}
	if snap.ID != "snap_again" || snap.Memory {
		t.Fatalf("snapshot %+v", snap)
	}
	if raw, err := os.ReadFile(filepath.Join(m.snapshotDir("snap_again"), fc.DiskFile)); err != nil || string(raw) != "disk" {
		t.Fatalf("the snapshot's disk: %q %v", raw, err)
	}
	if _, err := m.Stop(context.Background(), proto.StopParams{SandboxID: s.meta.ID}); err == nil {
		t.Fatal("a stop with no snapshot of a stopped sandbox was answered")
	}
}

// A VM that exits without being asked is reported stopped with its error and its machine's last health stamp, which
// Kantel fences the exit with: the next machine's stamps all come later.
func TestAnExitIsReportedWithItsMachinesHealthStamp(t *testing.T) {
	fastHealth(t)
	ev := &events{}
	m, s, _, machine := runningSandbox(t, ev)
	s.mu.Lock()
	m.watch(s, machine)
	started := m.info(s).HealthAt
	s.mu.Unlock()
	if started <= 0 {
		t.Fatalf("a running machine's HealthAt is %d, want its start's stamp", started)
	}
	machine.Kill()
	waitFor(t, "the exit's event", func() bool { return len(ev.all()) == 1 })
	got := ev.all()[0]
	if got.State != proto.StateStopped || got.Error != "the VM exited" || got.HealthAt != started {
		t.Fatalf("exit event %+v, want stopped, its error and HealthAt %d", got, started)
	}
	s.mu.Lock()
	next := reapedMachine(t, s.vmDir())
	s.machine = next
	s.meta.State = proto.StateRunning
	m.watch(s, next)
	again := m.info(s).HealthAt
	s.mu.Unlock()
	if again <= started {
		t.Fatalf("the next machine's HealthAt %d isn't after the one that ended (%d)", again, started)
	}
}

// A sandbox whose VM a restart of the host ended is stopped with that error and stamped then, so the hello's report of
// it names the machine that ended (its HealthAt is after that machine's start, before any later machine's).
func TestARestartsEndedSandboxIsStamped(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sandboxes", "sbx_restarted")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(meta{ID: "sbx_restarted", Size: "small", State: proto.StateRunning})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	m := &Manager{cfg: Config{Root: root}, log: slog.New(slog.DiscardHandler), sandboxes: map[string]*sandbox{}}
	before := time.Now().UnixMilli()
	if err := m.adopt(); err != nil {
		t.Fatal(err)
	}
	s := m.sandboxes["sbx_restarted"]
	if s == nil {
		t.Fatal("not loaded")
	}
	info := m.info(s)
	if info.State != proto.StateStopped || info.Error != "the host restarted while it ran" || info.HealthAt < before {
		t.Fatalf("info %+v, want stopped with the restart's error, stamped from %d on", info, before)
	}
}

// An exit's stamp is written with the sandbox, so it outlasts restarts of the host: a sandbox adopted already stopped
// keeps the stamp its exit had, and the next machine's stamps start above it.
func TestAnExitsStampOutlastsARestart(t *testing.T) {
	fastHealth(t)
	ev := &events{}
	m, s, _, machine := runningSandbox(t, ev)
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	m.watch(s, machine)
	s.mu.Unlock()
	machine.Kill()
	waitFor(t, "the exit's event", func() bool { return len(ev.all()) == 1 })
	stamp := ev.all()[0].HealthAt
	if stamp <= 0 {
		t.Fatalf("the exit's HealthAt is %d", stamp)
	}

	for range 2 {
		again := &Manager{cfg: Config{Root: m.cfg.Root}, log: slog.New(slog.DiscardHandler), sandboxes: map[string]*sandbox{}}
		if err := again.adopt(); err != nil {
			t.Fatal(err)
		}
		adopted := again.sandboxes[s.meta.ID]
		if adopted == nil {
			t.Fatal("not loaded")
		}
		info := again.info(adopted)
		if info.State != proto.StateStopped || info.Error != "the VM exited" || info.HealthAt != stamp {
			t.Fatalf("after a restart %+v, want the exit as it was, stamped %d", info, stamp)
		}
		adopted.setUnresponsive("")
		if adopted.healthAt <= stamp {
			t.Fatalf("a later machine's stamp %d isn't above the exit's %d", adopted.healthAt, stamp)
		}
	}
}

// A machine's first stamp is written as it starts, before its boot answers with it, so a restart of the host while it
// runs never stamps its exit before it.
func TestAMachinesStampIsWrittenAsItStarts(t *testing.T) {
	fastHealth(t)
	ev := &events{}
	m, s, _, machine := runningSandbox(t, ev)
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	s.healthAt = time.Now().UnixMilli() + 60_000 // a stamp ahead of the clock, as after the clock went back
	s.mu.Lock()
	m.watch(s, machine)
	started := m.info(s).HealthAt
	s.mu.Unlock()
	raw, err := os.ReadFile(filepath.Join(s.dir, "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	var written meta
	if err := json.Unmarshal(raw, &written); err != nil {
		t.Fatal(err)
	}
	if written.HealthAt != started {
		t.Fatalf("meta.json has HealthAt %d, want the machine's first stamp %d", written.HealthAt, started)
	}
	// The host restarts while it runs, and finds its VM gone: the exit is stamped after the machine's start.
	written.Pid = 0
	raw, _ = json.Marshal(written)
	if err := os.WriteFile(filepath.Join(s.dir, "meta.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	again := &Manager{cfg: Config{Root: m.cfg.Root}, log: slog.New(slog.DiscardHandler), sandboxes: map[string]*sandbox{}}
	if err := again.adopt(); err != nil {
		t.Fatal(err)
	}
	if info := again.info(again.sandboxes[s.meta.ID]); info.Error != "the host restarted while it ran" || info.HealthAt <= started {
		t.Fatalf("after a restart %+v, want the restart's exit stamped after %d", info, started)
	}
}
