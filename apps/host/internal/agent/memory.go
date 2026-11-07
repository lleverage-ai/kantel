package agent

import (
	"context"
	"errors"
	"maps"
	"os"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/memplan"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// The host's memory: its account of what its microVMs were given, use and may soon use (memplan), reported in every
// capacity report, and, with memoryOvercommit on (experimental), admission by use and the guard that acts when memory
// runs short.

// reserveMemoryMiB is what the host keeps for itself of total: reserveMemoryMiB, or 2048 or a tenth, whichever is more.
func (c Config) reserveMemoryMiB(total int64) int64 {
	if c.ReserveMemoryMiB > 0 {
		return c.ReserveMemoryMiB
	}
	return max(2048, total/10)
}

// overcommitOn says whether memory over-commit is on: asked for, with usage sampling to measure the VMs by.
func (c Config) overcommitOn() bool {
	return c.MemoryOvercommit.Enabled && c.usageInterval() > 0
}

// startMemoryPlan makes the host's memory plan once its facts (its memory less the reserve) are known.
func (h *Host) startMemoryPlan() {
	settings := h.cfg.MemoryOvercommit
	if settings.Enabled && h.cfg.usageInterval() <= 0 {
		h.log.Warn("memoryOvercommit is on but usage sampling is off (usageIntervalSeconds below 0): admitting sandboxes by the memory they were given")
		settings.Enabled = false
	}
	total := hostinfo.MemoryMiB()
	plan := memplan.New(settings, h.facts.MemoryMiB, h.cfg.reserveMemoryMiB(total), h.cfg.OvercommitMemory)
	h.mu.Lock()
	h.plan = plan
	h.mu.Unlock()
	if settings.Enabled {
		s := plan.Settings()
		h.log.Info("memory over-commit on (experimental): microVMs admitted by the memory they use",
			"capacityMiB", h.facts.MemoryMiB, "reserveMiB", plan.ReserveMiB(), "maxRatio", s.MaxRatio,
			"headroomMiB", s.HeadroomMiB, "headroomPercent", s.HeadroomPercent, "peakWindowMinutes", s.PeakWindowMinutes,
			"reclaim", s.Reclaims(), "outOfMemory", s.OutOfMemoryKills())
		h.confineMemory(plan, true)
	}
}

// confineMemoryMiB is the memory.max kantel-host gives its own control group with over-commit on: the machine's
// memory less a quarter of the reserve. So its microVMs, however they all grow at once, always leave the machine's
// other processes that much, and none of theirs is swapped (memory.swap.max 0). The guard is critical from a quarter
// of the reserve short of the limit (memplan), and the kernel's limit is the last line, behind it.
func confineMemoryMiB(total, reserve int64) int64 { return total - reserve/4 }

// confineMemory caps the host's own control group (hostinfo.ConfineMemory), logging what it did the first time
// (first) and whenever it had to set it again (systemd puts a unit's values back on a daemon-reload).
func (h *Host) confineMemory(plan *memplan.Plan, first bool) {
	c, err := hostinfo.ConfineMemory(confineMemoryMiB(hostinfo.MemoryMiB(), plan.ReserveMiB()))
	switch {
	case err != nil:
		h.log.Warn("memory over-commit: could not limit kantel-host's control group; a spike may push the machine into swap", "err", err)
	case c.Group == "":
		if first {
			h.log.Warn("memory over-commit: kantel-host runs in no control group it can limit (cgroup v2); a spike may push the machine into swap")
		}
	case first || c.SetMax || c.SetSwap:
		h.log.Info("memory over-commit: kantel-host's control group limited, so its microVMs can't swap or starve the machine",
			"group", c.Group, "memoryMaxMiB", c.MaxMiB, "swapOff", c.SwapOff, "setMax", c.SetMax, "setSwap", c.SetSwap)
	}
}

// memoryWatchEvery is how often, with over-commit on, the host reads the machine's memory between the VMs' readings,
// so the guard follows a spike within a second; memoryConfineEvery how often it checks its control group's limits.
var (
	memoryWatchEvery   = time.Second
	memoryConfineEvery = time.Minute
)

// watchMemory reads the machine's memory every memoryWatchEvery until ctx ends, and has the guard act when it is short.
func (h *Host) watchMemory(ctx context.Context) {
	ticker := time.NewTicker(memoryWatchEvery)
	defer ticker.Stop()
	confined := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			plan := h.memoryPlan()
			if plan == nil || !plan.Settings().Enabled {
				continue
			}
			plan.ObserveHost(now, hostinfo.ReadMemory())
			if level, _ := plan.Level(); level >= memplan.LevelTight {
				h.guard.pass(h, plan)
			}
			if now.Sub(confined) >= memoryConfineEvery {
				confined = now
				h.confineMemory(plan, false)
			}
		}
	}
}

// admitMemoryIf is admit when on, else nil (the tier admits by its budget).
func admitMemoryIf(on bool, admit func(memplan.VM, []memplan.VM) error) func(memplan.VM, []memplan.VM) error {
	if !on {
		return nil
	}
	return admit
}

func (h *Host) memoryPlan() *memplan.Plan {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.plan
}

// otherTiersMemoryMiB is what the tiers other than the microVM tier hold (their Usage). It never calls the microVM
// tier, so it may be called with that tier's lock held.
func (h *Host) otherTiersMemoryMiB() int64 {
	var other int64
	for name, t := range h.tiers {
		if name != microvm.Tier {
			used, _, _ := t.Usage()
			other += used
		}
	}
	return other
}

// admitMemory is the microVM tier's AdmitMemory with over-commit on (memplan.Plan.Check). Called with that tier's lock
// held.
func (h *Host) admitMemory(vm memplan.VM, held []memplan.VM) error {
	plan := h.memoryPlan()
	if plan == nil {
		return nil
	}
	return plan.Check(vm, held, h.otherTiersMemoryMiB())
}

// oomExit is what a microVM's exit is reported with when the kernel's out-of-memory killer ended it at the memory
// limit over-commit gives kantel-host's group (confineMemory): the guard didn't free memory fast enough.
const oomExit = "the host ran out of memory, and the kernel stopped this sandbox's VM to free it"

// oomKills tells the VMs the kernel ended at the host's memory limit (microvm.Config.ExitCause): each kill the group
// counted since explains one exit the host didn't cause.
type oomKills struct {
	mu        sync.Mutex
	explained int64
	read      func() int64
}

func newOOMKills(read func() int64) *oomKills { return &oomKills{explained: read(), read: read} }

func (k *oomKills) cause() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.read() > k.explained {
		k.explained++
		return oomExit
	}
	return ""
}

// exitCauseIf is the microVM tier's ExitCause: with over-commit on, the kernel's kills at the group's limit.
func exitCauseIf(on bool) func() string {
	if !on {
		return nil
	}
	return newOOMKills(hostinfo.OOMKills).cause
}

// microVMs is the microVM tier, if the host runs it.
func (h *Host) microVMs() *microvm.Manager {
	mv, _ := h.tiers[microvm.Tier].(*microvm.Manager)
	return mv
}

// memoryReport is the host's memory for its capacity report, and, with over-commit on, the largest microVM it would
// admit now (ok false when it isn't on).
func (h *Host) memoryReport() (report *proto.MemoryReport, free int64, ok bool) {
	plan := h.memoryPlan()
	if plan == nil {
		return nil, 0, false
	}
	var vms []memplan.VM
	if mv := h.microVMs(); mv != nil {
		vms = mv.MemoryVMs()
	}
	other := h.otherTiersMemoryMiB()
	if !plan.Settings().Enabled {
		// Off, nothing else need read the machine (the usage sampler may be off too): the report reads it itself.
		plan.ObserveHost(time.Now(), hostinfo.ReadMemory())
		r := plan.Report(vms, other)
		return &r, 0, false
	}
	r := plan.Report(vms, other)
	return &r, plan.Free(vms, other), true
}

// observeMemory gives the plan a usage sample's readings and the machine's memory now, then lets the guard act.
func (h *Host) observeMemory(at time.Time, readings []memplan.Reading) {
	plan := h.memoryPlan()
	if plan == nil {
		return
	}
	plan.Observe(at, readings, hostinfo.ReadMemory())
	if plan.Settings().Enabled {
		h.guard.pass(h, plan)
	}
}

// The guard's pacing: a VM is reclaimed from at most every reclaimEvery, and only when its Firecracker holds at least
// reclaimMinMiB more than its guest uses (page cache), at most reclaimPerPass at a time; the out-of-memory step waits
// two critical readings in a row and outOfMemoryEvery between steps, takes the VM holding the most that it hasn't
// taken in outOfMemorySettle (what a guest frees takes seconds to come back to the host), and a VM whose guest has
// been asked twice in outOfMemoryRepeat is stopped instead.
var (
	reclaimEvery     = 2 * time.Minute
	reclaimMinMiB    = int64(512)
	reclaimPerPass   = 2
	reclaimTimeout   = 20 * time.Second
	outOfMemoryEvery = 5 * time.Second
	// outOfMemoryAtLimitEvery is the pacing with the VMs' group at its memory.max, where the kernel ends a VM next.
	outOfMemoryAtLimitEvery = time.Second
	outOfMemorySettle       = 10 * time.Second
	outOfMemoryRepeat       = time.Minute
	vmOOMScoreAdj           = 500
)

// memoryGuard acts when the host is short of memory (memplan.Level), over-commit on: reclaim page cache from VMs
// through their balloons (tight and worse), refuse creates (refusing, which admission does), and, critical, have the
// guest of the VM holding the most memory kill its largest process, then stop that VM if it still is. Every VM's
// Firecracker gets oom_score_adj 500, so if the host's own OOM killer ever has to act, it ends a VM, not the host's
// processes. One pass at a time, off the sampler's goroutine.
type memoryGuard struct {
	mu          sync.Mutex
	busy        bool
	scored      map[int]bool
	reclaimedAt map[string]time.Time
	asked       map[string][]time.Time
	// heldAt is when a step found a sandbox an operation held (microvm.ErrBusy): the step wasn't taken, and the VM is
	// passed over for outOfMemoryEvery, so the next step may take another.
	heldAt   map[string]time.Time
	lastStep time.Time
	// working are the reclaims and out-of-memory steps under way: a pass doesn't wait for them (a balloon takes seconds
	// to fill, a guest short of memory seconds to answer), so the next pass can take its step meanwhile.
	working sync.WaitGroup
	// act stands in for the microVM tier in a test (nil: the host's), readRSS for reading a process's resident memory
	// (nil: usage.ReadRSS).
	act     guardActions
	readRSS func(pid int) (int64, error)
}

// guardActions is what the guard asks of the microVM tier. The out-of-memory steps name the Firecracker process (pid)
// they were chosen by, and leave a sandbox whose VM has been replaced since alone (microvm.ErrMachineChanged); one an
// operation holds they never wait for (microvm.ErrBusy).
type guardActions interface {
	Reclaim(ctx context.Context, id string) (int64, error)
	OutOfMemory(ctx context.Context, id string, pid int) error
	KillForMemory(id string, pid int) error
}

func (g *memoryGuard) pass(h *Host, plan *memplan.Plan) {
	g.mu.Lock()
	if g.busy {
		g.mu.Unlock()
		return
	}
	act := g.act
	if act == nil {
		if mv := h.microVMs(); mv != nil {
			act = mv
		}
	}
	if act == nil {
		g.mu.Unlock()
		return
	}
	g.busy = true
	g.mu.Unlock()
	go func() {
		defer func() {
			g.mu.Lock()
			g.busy = false
			g.mu.Unlock()
		}()
		g.run(h, plan, act, time.Now())
	}()
}

// run is one pass of the guard, at now.
func (g *memoryGuard) run(h *Host, plan *memplan.Plan, act guardActions, now time.Time) {
	readings := plan.Readings()
	g.scoreVMs(readings)
	level, critical := plan.Level()
	settings := plan.Settings()
	// Critical, the out-of-memory step goes first: a reclaim waits seconds for a balloon to fill. Its group at its
	// limit, at once and every pass: the kernel ends a whole VM next.
	atLimit := plan.AtLimit()
	if level == memplan.LevelCritical && (critical >= 2 || atLimit) && settings.OutOfMemoryKills() {
		g.outOfMemory(h, act, g.fresh(readings), atLimit, now)
	}
	if level >= memplan.LevelTight && settings.Reclaims() {
		g.reclaim(h, act, readings, now)
	}
}

// scoreVMs makes every VM's Firecracker the host OOM killer's first choice (oom_score_adj), once per process.
func (g *memoryGuard) scoreVMs(readings []memplan.Reading) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.scored == nil {
		g.scored = map[int]bool{}
	}
	live := map[int]bool{}
	for _, r := range readings {
		if r.Pid <= 0 {
			continue
		}
		live[r.Pid] = true
		if g.scored[r.Pid] {
			continue
		}
		_ = os.WriteFile("/proc/"+strconv.Itoa(r.Pid)+"/oom_score_adj", []byte(strconv.Itoa(vmOOMScoreAdj)), 0o644)
		g.scored[r.Pid] = true
	}
	for pid := range g.scored {
		if !live[pid] {
			delete(g.scored, pid)
		}
	}
}

// reclaim takes page cache back from the VMs holding the most of it beyond what their guests use, a few at a time.
func (g *memoryGuard) reclaim(h *Host, act guardActions, readings []memplan.Reading, now time.Time) {
	var picks []memplan.Reading
	g.mu.Lock()
	if g.reclaimedAt == nil {
		g.reclaimedAt = map[string]time.Time{}
	}
	for _, r := range readings {
		if r.Guest && r.RSSMiB-r.UsedMiB >= reclaimMinMiB && now.Sub(g.reclaimedAt[r.ID]) >= reclaimEvery {
			picks = append(picks, r)
		}
	}
	slices.SortFunc(picks, func(a, b memplan.Reading) int { return int((b.RSSMiB - b.UsedMiB) - (a.RSSMiB - a.UsedMiB)) })
	if len(picks) > reclaimPerPass {
		picks = picks[:reclaimPerPass]
	}
	for _, r := range picks {
		g.reclaimedAt[r.ID] = now
	}
	g.mu.Unlock()
	for _, r := range picks {
		g.working.Add(1)
		go func(r memplan.Reading) {
			defer g.working.Done()
			ctx, cancel := context.WithTimeout(context.Background(), reclaimTimeout)
			defer cancel()
			took, err := act.Reclaim(ctx, r.ID)
			if err != nil {
				h.log.Warn("memory guard: could not reclaim from a sandbox", "sandbox", r.ID, "err", err)
				return
			}
			h.log.Info("memory guard: reclaimed page cache from a sandbox through its balloon", "sandbox", r.ID,
				"tookMiB", took, "residentMiB", r.RSSMiB, "guestUsedMiB", r.UsedMiB)
		}(r)
	}
}

// outOfMemory is the last step: the guest of the VM holding the most memory is asked to kill its largest process; a
// VM asked twice in outOfMemoryRepeat, or whose guest doesn't answer, is stopped instead.
// fresh is readings with each VM's resident memory read again now, the most resident first: in a spike, the last
// sample's is seconds old.
func (g *memoryGuard) fresh(readings []memplan.Reading) []memplan.Reading {
	read := g.readRSS
	if read == nil {
		read = usage.ReadRSS
	}
	out := slices.Clone(readings)
	for i, r := range out {
		if r.Pid <= 0 {
			continue
		}
		if rss, err := read(r.Pid); err == nil {
			out[i].RSSMiB = rss >> 20
		}
	}
	slices.SortStableFunc(out, func(a, b memplan.Reading) int { return int(b.RSSMiB - a.RSSMiB) })
	return out
}

func (g *memoryGuard) outOfMemory(h *Host, act guardActions, readings []memplan.Reading, atLimit bool, now time.Time) {
	if len(readings) == 0 {
		return
	}
	every := outOfMemoryEvery
	if atLimit {
		every = outOfMemoryAtLimitEvery
	}
	g.mu.Lock()
	if now.Sub(g.lastStep) < every {
		g.mu.Unlock()
		return
	}
	if g.asked == nil {
		g.asked = map[string][]time.Time{}
	}
	// The VM holding the most that hasn't been taken in outOfMemorySettle; none, and the step waits for what they free.
	var offender memplan.Reading
	found := false
	for _, r := range readings {
		if at, ok := g.heldAt[r.ID]; ok && now.Sub(at) < outOfMemoryEvery {
			continue
		}
		if asked := g.asked[r.ID]; len(asked) == 0 || now.Sub(asked[len(asked)-1]) >= outOfMemorySettle {
			offender, found = r, true
			break
		}
	}
	if !found {
		g.mu.Unlock()
		return
	}
	g.lastStep = now
	recent := slices.DeleteFunc(g.asked[offender.ID], func(t time.Time) bool { return now.Sub(t) > outOfMemoryRepeat })
	g.asked[offender.ID] = append(recent, now)
	g.mu.Unlock()
	// held undoes the step when an operation holds the sandbox: it wasn't asked, and the next pass decides afresh.
	held := func() {
		h.log.Info("memory guard: the sandbox is mid-operation; leaving it for now", "sandbox", offender.ID)
		g.mu.Lock()
		defer g.mu.Unlock()
		if asked := g.asked[offender.ID]; len(asked) > 0 && asked[len(asked)-1].Equal(now) {
			g.asked[offender.ID] = asked[:len(asked)-1]
		}
		if g.lastStep.Equal(now) {
			g.lastStep = time.Time{}
		}
		if g.heldAt == nil {
			g.heldAt = map[string]time.Time{}
		}
		maps.DeleteFunc(g.heldAt, func(_ string, at time.Time) bool { return now.Sub(at) >= outOfMemoryEvery })
		g.heldAt[offender.ID] = now
	}
	kill := func() {
		err := act.KillForMemory(offender.ID, offender.Pid)
		switch {
		case errors.Is(err, microvm.ErrBusy):
			held()
		case errors.Is(err, microvm.ErrMachineChanged):
			h.log.Info("memory guard: the sandbox's VM was replaced meanwhile; leaving it", "sandbox", offender.ID)
		case err != nil:
			h.log.Warn("memory guard: could not stop a sandbox", "sandbox", offender.ID, "err", err)
		}
	}
	g.working.Add(1)
	if len(recent) >= 2 {
		h.log.Warn("memory guard: the host is still critically short of memory; stopping the sandbox holding the most",
			"sandbox", offender.ID, "residentMiB", offender.RSSMiB)
		// Off the pass, as the guest's request is: a sandbox a stop or snapshot holds would hold the guard up.
		go func() {
			defer g.working.Done()
			kill()
		}()
		return
	}
	h.log.Warn("memory guard: the host is critically short of memory; the sandbox holding the most is killing its largest process",
		"sandbox", offender.ID, "residentMiB", offender.RSSMiB, "guestUsedMiB", offender.UsedMiB)
	go func() {
		defer g.working.Done()
		ctx, cancel := context.WithTimeout(context.Background(), reclaimTimeout)
		defer cancel()
		err := act.OutOfMemory(ctx, offender.ID, offender.Pid)
		switch {
		case err == nil:
		case errors.Is(err, microvm.ErrBusy):
			held()
		case errors.Is(err, microvm.ErrMachineChanged):
			h.log.Info("memory guard: the sandbox's VM was replaced meanwhile; leaving it", "sandbox", offender.ID)
		default:
			h.log.Warn("memory guard: the sandbox's guest didn't answer; stopping it", "sandbox", offender.ID, "err", err)
			kill()
		}
	}()
}
