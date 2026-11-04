package agent

import (
	"context"
	"slices"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
	"github.com/lleverage-ai/kantel/apps/host/internal/isolate"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

const (
	// defaultUsageInterval is how often the host samples itself and its sandboxes (usageIntervalSeconds).
	defaultUsageInterval = 5 * time.Second
	// usageBacklog bounds the samples kept while the control plane can't be reached: past it the oldest go.
	usageBacklog = 120
	// maxUsageSandboxes is the most sandboxes one tick names.
	maxUsageSandboxes = 4096
)

// usageInterval is how often the host samples usage, 1 s to 5 minutes (the range the control plane takes); 0 is
// never (usageIntervalSeconds below 0).
func (c Config) usageInterval() time.Duration {
	switch {
	case c.UsageIntervalSeconds < 0:
		return 0
	case c.UsageIntervalSeconds == 0:
		return defaultUsageInterval
	default:
		return time.Duration(min(c.UsageIntervalSeconds, 300)) * time.Second
	}
}

// usageSampler measures the host and its running sandboxes from the host's side (package usage) and keeps the
// samples the control plane hasn't had yet.
type usageSampler struct {
	// Where the readings come from: the tiers and /proc, or a test's.
	processes func() []usage.Process
	shared    func() []usage.Shared
	// public says whether a sandbox of this owner (space) is the control plane's to see: not one in an E2E space.
	// It takes the owner read with the sandbox, so it never has to look the sandbox up (and wait on its lock).
	public      func(owner string) bool
	readHostCPU func() (usage.HostCPU, error)
	readMemory  func() (usage.Memory, error)
	readDisk    func() (usage.Disk, error)
	readCPU     func(pid int) (usage.ProcCPU, error)
	readRSS     func(pid int) (int64, error)
	// now is the clock each reading is stamped with as it is taken (time.Now; a test's).
	now func() time.Time

	counters *usage.Counters
	hostCPU  usage.HostCPU
	hostAt   time.Time
	// taken is the owner of each sandbox in the last reading (take's, for keep).
	taken map[string]string

	mu      sync.Mutex
	queue   []proto.UsageSample
	dropped int
	latest  *proto.UsageSample
	// owners is the owner of each sandbox in a queued sample, to check again as it leaves.
	owners map[string]string
}

func (h *Host) newUsageSampler() *usageSampler {
	s := &usageSampler{
		public:      h.usageVisible,
		readHostCPU: usage.ReadHostCPU,
		readMemory:  usage.ReadMemory,
		readDisk:    func() (usage.Disk, error) { return usage.ReadDisk(h.cfg.Root) },
		readCPU:     usage.ReadProcCPU,
		readRSS:     usage.ReadRSS,
		now:         time.Now,
		counters:    usage.NewCounters(),
	}
	s.processes = func() []usage.Process {
		if t, ok := h.tiers[microvm.Tier].(interface{ Processes() []usage.Process }); ok {
			return t.Processes()
		}
		return nil
	}
	s.shared = func() []usage.Shared {
		if t, ok := h.tiers[isolate.Tier].(interface{ Shared() []usage.Shared }); ok {
			return t.Shared()
		}
		return nil
	}
	return s
}

// take takes one reading of everything. ok is false for the host's first (CPU is a difference, so the first
// reading only sets where it starts) and when /proc/stat can't be read. A sandbox appears from its second reading.
//
// Each counter is stamped when it is read, not when the tick was due: a tick late after a slow send, or one that
// waited on the tiers, still divides each CPU time by the time it took.
func (s *usageSampler) take() (proto.UsageSample, bool) {
	defer s.counters.Sweep()
	procs := s.processes()
	cpu, err := s.readHostCPU()
	now := s.now()
	if err != nil {
		return proto.UsageSample{}, false
	}
	prev, prevAt := s.hostCPU, s.hostAt
	s.hostCPU, s.hostAt = cpu, now
	if prevAt.IsZero() {
		// The sandboxes' counters start here too, so they have a figure at the next sample.
		s.sandboxes(procs, usage.Memory{})
		return proto.UsageSample{}, false
	}
	busy, ok := usage.HostCPUBusy(prev, cpu)
	if !ok || !now.After(prevAt) {
		s.sandboxes(procs, usage.Memory{})
		return proto.UsageSample{}, false
	}
	// The interval as measured, in the 1 s to 5 minutes the control plane takes (a tick a little early, or one after the
	// host was paused, is still a reading of that interval).
	interval := min(max(now.Sub(prevAt).Milliseconds(), 1000), 300_000)
	out := proto.UsageSample{At: now.UnixMilli(), IntervalMs: interval, Host: proto.HostUsage{CPU: busy}}
	mem, err := s.readMemory()
	if err == nil {
		out.Host.MemUsedBytes, out.Host.MemTotalBytes = mem.Used(), mem.Total
	}
	if disk, err := s.readDisk(); err == nil {
		out.Host.DiskUsedBytes, out.Host.DiskTotalBytes = disk.Used, disk.Total
	}
	out.Sandboxes = s.sandboxes(procs, mem)
	if len(out.Sandboxes) > maxUsageSandboxes {
		// The control plane refuses a tick with more (packages/hosts/src/facts.ts, MAX_USAGE_SANDBOXES).
		out.Sandboxes = out.Sandboxes[:maxUsageSandboxes]
	}
	return out, true
}

// sandboxes reads every running sandbox the control plane may see (not one in an E2E space), answering those with
// a figure: a microVM's Firecracker process, and each account's isolate runtime shared out among its sandboxes.
func (s *usageSampler) sandboxes(procs []usage.Process, mem usage.Memory) []proto.SandboxUsage {
	out := []proto.SandboxUsage{}
	s.taken = map[string]string{}
	// The isolates first, and each runtime read as soon as its sandboxes' command times were (Shared), so the two
	// cover the same interval.
	for _, sh := range s.shared() {
		out = append(out, s.isolates(mem, sh)...)
	}
	for _, p := range procs {
		if p.Held {
			// Mid-operation, so unread (its owner too): keep following it.
			s.counters.Keep("microvm/" + p.SandboxID)
			continue
		}
		if !s.public(p.Owner) {
			continue
		}
		cpu, err := s.readCPU(p.Pid)
		if err != nil {
			continue
		}
		grew, over, ok := s.counters.Delta("microvm/"+p.SandboxID, cpu.Epoch(p.Pid), cpu.Seconds(), s.now())
		if !ok {
			continue
		}
		rss, _ := s.readRSS(p.Pid)
		s.taken[p.SandboxID] = p.Owner
		out = append(out, proto.SandboxUsage{
			ID: p.SandboxID, Kind: microvm.Tier, CPU: usage.Utilisation(grew, over, p.CPUs),
			MemUsedBytes: rss, MemLimitBytes: p.MemLimitBytes,
		})
	}
	return out
}

// isolates shares out an account's runtime among its running sandboxes: CPU by the time each spent running commands
// over the interval (usage.Attribute), as a share of one CPU (sh.CPUs); memory evenly, the runtime's resident memory
// and its limit alike, since workerd says nothing of an isolate's own.
func (s *usageSampler) isolates(mem usage.Memory, sh usage.Shared) []proto.SandboxUsage {
	for _, id := range sh.Held {
		s.counters.Keep("isolate-busy/" + id)
	}
	if len(sh.Held) > 0 {
		// A held sandbox's command time is unknown this time, so the runtime's CPU can't be shared out: keep
		// following it, and give its sandboxes figures from the next reading.
		s.counters.Keep(sh.Key)
		for _, b := range sh.Sandboxes {
			s.counters.Keep("isolate-busy/" + b.SandboxID)
		}
		return nil
	}
	if len(sh.Sandboxes) == 0 {
		return nil
	}
	// The runtime's CPU first, read just after Shared took its sandboxes' command times.
	var cpuSeconds float64
	var over time.Duration
	var rss int64
	runtimeOK := true
	if sh.Pid > 0 {
		cpu, err := s.readCPU(sh.Pid)
		if err != nil {
			return nil
		}
		cpuSeconds, over, runtimeOK = s.counters.Delta(sh.Key, cpu.Epoch(sh.Pid), cpu.Seconds(), s.now())
		rss, _ = s.readRSS(sh.Pid)
	}
	at := sh.At
	if at.IsZero() {
		at = s.now()
	}
	busy := map[string]float64{}
	var shown []usage.Busy
	for _, b := range sh.Sandboxes {
		// The runtime is part of the epoch: a sandbox moved to another runtime starts again. Every one is read, E2E's
		// too, so the runtime's CPU is shared out among all that ran in it.
		grew, _, ok := s.counters.Delta("isolate-busy/"+b.SandboxID, sh.Key, b.Seconds, at)
		if ok {
			busy[b.SandboxID] = grew
			if s.public(b.Owner) {
				shown = append(shown, b)
			}
		}
	}
	if !runtimeOK {
		return nil
	}
	limit := sh.MemLimitBytes
	if limit <= 0 {
		limit = mem.Total
	}
	n := int64(len(sh.Sandboxes))
	given := usage.Attribute(cpuSeconds, busy)
	out := make([]proto.SandboxUsage, 0, len(shown))
	for _, b := range shown {
		s.taken[b.SandboxID] = b.Owner
		out = append(out, proto.SandboxUsage{
			ID: b.SandboxID, Kind: isolate.Tier, CPU: usage.Utilisation(given[b.SandboxID], over, sh.CPUs),
			MemUsedBytes: rss / n, MemLimitBytes: limit / n,
		})
	}
	return out
}

// keep queues a sample for the control plane, dropping the oldest past usageBacklog.
func (s *usageSampler) keep(sample proto.UsageSample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.latest = &sample
	s.queue = append(s.queue, sample)
	if over := len(s.queue) - usageBacklog; over > 0 {
		s.queue = slices.Delete(s.queue, 0, over)
		s.dropped += over
	}
	// The owners of what waits: the last reading's, and those still queued.
	owners := make(map[string]string, len(s.taken))
	for _, q := range s.queue {
		for _, u := range q.Sandboxes {
			if owner, ok := s.taken[u.ID]; ok {
				owners[u.ID] = owner
			} else if owner, ok := s.owners[u.ID]; ok {
				owners[u.ID] = owner
			}
		}
	}
	s.owners = owners
}

// leaving is a queued sample as it leaves: without a sandbox whose space turned E2E on while it waited, by the owner
// it was read with, so sending never looks a sandbox up (and waits on its lock) either.
func (s *usageSampler) leaving(sample proto.UsageSample, visible func(owner string) bool) proto.UsageSample {
	sample.Sandboxes = slices.DeleteFunc(slices.Clone(sample.Sandboxes), func(u proto.SandboxUsage) bool {
		owner, ok := s.ownerOf(u.ID)
		return !ok || !visible(owner)
	})
	return sample
}

// ownerOf is the owner of a sandbox in a queued sample, as it was read.
func (s *usageSampler) ownerOf(sandboxID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	owner, ok := s.owners[sandboxID]
	return owner, ok
}

// flush sends what waits, oldest first, one message a sample; a send that fails keeps it and what's after it for the
// next try. It answers how many were sent and dropped since the last flush that sent any.
func (s *usageSampler) flush(send func(proto.UsageSample) error) (sent, dropped int) {
	for {
		s.mu.Lock()
		if len(s.queue) == 0 {
			s.mu.Unlock()
			return sent, dropped
		}
		next := s.queue[0]
		s.mu.Unlock()
		if err := send(next); err != nil {
			return sent, dropped
		}
		s.mu.Lock()
		if len(s.queue) > 0 && s.queue[0].At == next.At {
			s.queue = s.queue[1:]
		}
		if sent == 0 {
			dropped, s.dropped = s.dropped, 0
		}
		s.mu.Unlock()
		sent++
	}
}

// RunUsage samples the host and its sandboxes every usageIntervalSeconds (5 by default) until ctx ends, and pushes each
// sample to the control plane as a "usage" message while connected, independent of any call: samples taken while it
// can't be reached wait (at most usageBacklog of them) and go when it can.
func (h *Host) RunUsage(ctx context.Context) {
	interval := h.cfg.usageInterval()
	if interval <= 0 {
		return
	}
	s := h.newUsageSampler()
	h.mu.Lock()
	h.usage = s
	h.mu.Unlock()
	s.take()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// The tick only wakes the sampler: each reading is stamped as it is taken.
			if sample, ok := s.take(); ok {
				s.keep(sample)
			}
			if !h.connected() {
				continue
			}
			if sent, dropped := s.flush(h.sendUsage); dropped > 0 {
				h.log.Warn("usage samples dropped while the control plane was out of reach", "dropped", dropped, "sent", sent)
			}
		}
	}
}

// sendUsage sends one sample as a "usage" message over the current connection. A control plane that doesn't know the
// type drops it (packages/hosts/src/hub.ts answers a type it doesn't know with nothing, and keeps the connection), so
// this needs no gate.
func (h *Host) sendUsage(sample proto.UsageSample) error {
	h.mu.Lock()
	c, s := h.link, h.usage
	h.mu.Unlock()
	if s != nil {
		sample = s.leaving(sample, h.usageVisible)
	}
	if c == nil {
		return errDisconnected
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.send(ctx, proto.Message{Type: "usage", Usage: &sample})
}

// usageVisible says whether a sandbox of owner (its space) is the control plane's to see: all are, unless the host
// has joined an E2E space, and then only one of a space with E2E off (as egressPublic, from the owner read with the
// sandbox rather than by looking it up).
func (h *Host) usageVisible(owner string) bool {
	if h.e2e == nil || len(h.e2e.Spaces()) == 0 {
		return true
	}
	return owner != "" && h.e2eMode(owner) == e2e.ModeOff
}

// LatestUsage is the newest sample, if the host samples (RunUsage) and has one.
func (h *Host) LatestUsage() (proto.UsageSample, bool) {
	h.mu.Lock()
	s := h.usage
	h.mu.Unlock()
	if s == nil {
		return proto.UsageSample{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.latest == nil {
		return proto.UsageSample{}, false
	}
	return *s.latest, true
}
