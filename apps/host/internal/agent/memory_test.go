package agent

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/memplan"
)

type fakeGuardActions struct {
	mu        sync.Mutex
	reclaimed []string
	asked     []string
	killed    []string
	oomErr    error
}

func (f *fakeGuardActions) Reclaim(_ context.Context, id string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reclaimed = append(f.reclaimed, id)
	return 100, nil
}

func (f *fakeGuardActions) OutOfMemory(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, id)
	return f.oomErr
}

func (f *fakeGuardActions) KillForMemory(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.killed = append(f.killed, id)
	return nil
}

func quietHost() *Host { return &Host{log: slog.New(slog.NewTextHandler(io.Discard, nil))} }

// runAll is one guard pass at now, and the steps it started.
func (g *memoryGuard) runAll(h *Host, plan *memplan.Plan, act guardActions, now time.Time) {
	g.run(h, plan, act, now)
	g.working.Wait()
}

// Three VMs: b holds the most, c the most page cache beyond what its guest uses, a little of either.
var guardReadings = []memplan.Reading{
	{ID: "a", UsedMiB: 1000, RSSMiB: 1200, Guest: true},
	{ID: "b", UsedMiB: 9000, RSSMiB: 9800, Guest: true},
	{ID: "c", UsedMiB: 2000, RSSMiB: 7000, Guest: true},
}

func TestGuardReclaimsWhenTight(t *testing.T) {
	plan := memplan.New(memplan.Settings{Enabled: true}, 10000, 2000, 1.5)
	t0 := time.Now()
	plan.Observe(t0, guardReadings, hostinfo.Memory{AvailableMiB: 3000}) // under twice the reserve
	act := &fakeGuardActions{}
	g := &memoryGuard{}
	h := quietHost()
	g.runAll(h, plan, act, t0)
	// The two with most page cache, b (800) after c (5000); a has too little to be worth it.
	slices.Sort(act.reclaimed)
	if !slices.Equal(act.reclaimed, []string{"b", "c"}) || len(act.asked) != 0 {
		t.Fatalf("reclaimed %v, asked %v", act.reclaimed, act.asked)
	}
	// Not again within reclaimEvery.
	g.runAll(h, plan, act, t0.Add(30*time.Second))
	if len(act.reclaimed) != 2 {
		t.Fatalf("reclaimed again: %v", act.reclaimed)
	}
	g.runAll(h, plan, act, t0.Add(reclaimEvery))
	if len(act.reclaimed) != 4 {
		t.Fatalf("not reclaimed after %v: %v", reclaimEvery, act.reclaimed)
	}
	// With reclaim off, never.
	no := false
	off := memplan.New(memplan.Settings{Enabled: true, Reclaim: &no}, 10000, 2000, 1.5)
	off.Observe(t0, guardReadings, hostinfo.Memory{AvailableMiB: 3000})
	act = &fakeGuardActions{}
	(&memoryGuard{}).runAll(h, off, act, t0)
	if len(act.reclaimed) != 0 {
		t.Fatalf("reclaimed with reclaim off: %v", act.reclaimed)
	}
}

func TestGuardOutOfMemoryLadder(t *testing.T) {
	plan := memplan.New(memplan.Settings{Enabled: true}, 10000, 2000, 1.5)
	t0 := time.Now()
	critical := hostinfo.Memory{AvailableMiB: 500}
	act := &fakeGuardActions{}
	g := &memoryGuard{}
	h := quietHost()
	plan.Observe(t0, guardReadings, critical)
	g.runAll(h, plan, act, t0)
	// One critical reading: reclaim only.
	if len(act.asked) != 0 || len(act.killed) != 0 || len(act.reclaimed) == 0 {
		t.Fatalf("after one critical reading: %+v", act)
	}
	plan.Observe(t0.Add(5*time.Second), guardReadings, critical)
	g.runAll(h, plan, act, t0.Add(5*time.Second))
	// Two: the guest holding the most (b) kills its largest process.
	if !slices.Equal(act.asked, []string{"b"}) || len(act.killed) != 0 {
		t.Fatalf("after two: %+v", act)
	}
	// Within outOfMemoryEvery, nothing more.
	plan.Observe(t0.Add(7*time.Second), guardReadings, critical)
	g.runAll(h, plan, act, t0.Add(7*time.Second))
	if len(act.asked) != 1 {
		t.Fatalf("asked again too soon: %+v", act)
	}
	// Then the next holding the most: what b's guest freed may not be back yet.
	plan.Observe(t0.Add(10*time.Second), guardReadings, critical)
	g.runAll(h, plan, act, t0.Add(10*time.Second))
	if !slices.Equal(act.asked, []string{"b", "c"}) {
		t.Fatalf("next offender: %+v", act)
	}
	plan.Observe(t0.Add(20*time.Second), guardReadings, critical)
	g.runAll(h, plan, act, t0.Add(20*time.Second))
	if !slices.Equal(act.asked, []string{"b", "c", "b"}) || len(act.killed) != 0 {
		t.Fatalf("second ask: %+v", act)
	}
	// A third time in a minute: stopped.
	plan.Observe(t0.Add(40*time.Second), guardReadings, critical)
	g.runAll(h, plan, act, t0.Add(40*time.Second))
	if len(act.asked) != 3 || !slices.Equal(act.killed, []string{"b"}) {
		t.Fatalf("third: %+v", act)
	}
}

// The VMs' group at its limit: the guard acts at once, every second, on the VM holding the most now (not at the
// last sample), a different one each time while what the last freed comes back.
func TestGuardAtTheGroupLimit(t *testing.T) {
	plan := memplan.New(memplan.Settings{Enabled: true}, 10000, 2000, 1.5)
	t0 := time.Now()
	readings := []memplan.Reading{
		{ID: "a", UsedMiB: 1000, RSSMiB: 1200, Guest: true, Pid: 11},
		{ID: "b", UsedMiB: 3000, RSSMiB: 3000, Guest: true, Pid: 12},
		{ID: "c", UsedMiB: 2000, RSSMiB: 2000, Guest: true, Pid: 13},
	}
	now := map[int]int64{11: 4000 << 20, 12: 3000 << 20, 13: 2000 << 20} // a has grown most since
	g := &memoryGuard{readRSS: func(pid int) (int64, error) { return now[pid], nil }}
	limited := hostinfo.Memory{AvailableMiB: 5000, GroupMaxMiB: 9500, GroupHeadroomMiB: 2000, GroupLimitHits: 1}
	plan.Observe(t0, readings, limited)
	limited.GroupLimitHits = 2
	plan.ObserveHost(t0.Add(time.Second), limited)
	act := &fakeGuardActions{}
	h := quietHost()
	g.runAll(h, plan, act, t0.Add(time.Second))
	if !slices.Equal(act.asked, []string{"a"}) {
		t.Fatalf("first: %+v", act)
	}
	limited.GroupLimitHits = 3
	plan.ObserveHost(t0.Add(2*time.Second), limited)
	g.runAll(h, plan, act, t0.Add(2*time.Second))
	if !slices.Equal(act.asked, []string{"a", "b"}) {
		t.Fatalf("second: %+v", act)
	}
}

func TestGuardStopsAVMWhoseGuestDoesNotAnswer(t *testing.T) {
	plan := memplan.New(memplan.Settings{Enabled: true}, 10000, 2000, 1.5)
	t0 := time.Now()
	critical := hostinfo.Memory{AvailableMiB: 500}
	plan.Observe(t0, guardReadings, critical)
	plan.Observe(t0.Add(5*time.Second), guardReadings, critical)
	act := &fakeGuardActions{oomErr: errors.New("sandbox.exec took longer than 5000 ms")}
	(&memoryGuard{}).runAll(quietHost(), plan, act, t0.Add(5*time.Second))
	if !slices.Equal(act.asked, []string{"b"}) || !slices.Equal(act.killed, []string{"b"}) {
		t.Fatalf("%+v", act)
	}
	// With the step off, nothing is killed.
	no := false
	off := memplan.New(memplan.Settings{Enabled: true, OutOfMemory: &no}, 10000, 2000, 1.5)
	off.Observe(t0, guardReadings, critical)
	off.Observe(t0.Add(5*time.Second), guardReadings, critical)
	act = &fakeGuardActions{}
	(&memoryGuard{}).runAll(quietHost(), off, act, t0.Add(5*time.Second))
	if len(act.asked)+len(act.killed) != 0 {
		t.Fatalf("out-of-memory step off: %+v", act)
	}
}

// Each kill the kernel counted at the group's limit explains one VM exit, and no more.
func TestOOMKillsExplainExits(t *testing.T) {
	count := int64(3)
	k := newOOMKills(func() int64 { return count })
	if got := k.cause(); got != "" {
		t.Fatalf("before any kill: %q", got)
	}
	count = 5
	if k.cause() != oomExit || k.cause() != oomExit || k.cause() != "" {
		t.Fatal("two kills explain two exits")
	}
	if exitCauseIf(false) != nil {
		t.Fatal("over-commit off: no exit cause")
	}
}

func TestReserveMemory(t *testing.T) {
	if got := (Config{}).reserveMemoryMiB(128000); got != 12800 {
		t.Fatal(got)
	}
	if got := (Config{}).reserveMemoryMiB(8000); got != 2048 {
		t.Fatal(got)
	}
	if got := (Config{ReserveMemoryMiB: 20000}).reserveMemoryMiB(128000); got != 20000 {
		t.Fatal(got)
	}
	on := Config{MemoryOvercommit: memplan.Settings{Enabled: true}}
	if !on.overcommitOn() {
		t.Fatal("on")
	}
	on.UsageIntervalSeconds = -1
	if on.overcommitOn() {
		t.Fatal("on without usage sampling")
	}
}
