package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
	// usageBacklog bounds the samples kept, those not sent yet and those Kantel hasn't acknowledged (FeatureUsageAcks):
	// past it the oldest go. 120 is 10 minutes at the default interval, a few hundred kilobytes for a busy host.
	usageBacklog = 120
	// unconfirmedWarnEvery spaces the warnings about acknowledged-delivery ticks dropped unacknowledged: with a control
	// plane that never answers them, one goes every tick.
	unconfirmedWarnEvery = 10 * time.Minute
	// maxUsageSandboxes is the most sandboxes one tick names.
	maxUsageSandboxes = 4096
	// guestMemoryTimeout bounds asking one microVM's Firecracker for its guest's memory, which it answers from what it
	// holds (it never waits on the guest): past it, that VM's reading is its resident memory.
	guestMemoryTimeout = time.Second
	// guestStatsTimeout bounds asking one microVM's agent for its disk and IO (a statfs and a read of
	// /proc/pressure/io in the guest, over vsock), so a busy or paused guest can't hold up the others' readings.
	guestStatsTimeout = 500 * time.Millisecond
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

	mu sync.Mutex
	// queue is what waits, oldest first, in Seq order: samples not yet sent on the current link, and with acks those
	// sent and not yet acknowledged (usage.ack).
	queue []proto.UsageSample
	// run names this sampler's run, and seq is the last Seq given (keep).
	run string
	seq uint64
	// link is the connection the samples up to sentSeq went out on: on another, everything queued goes again.
	link    *caller
	sentSeq uint64
	// everSent is the newest Seq sent on any link: a sample at or before it that the backlog drops may have arrived.
	everSent uint64
	// dropped are samples the backlog dropped before they were ever sent; unconfirmed, those it dropped sent but never
	// acknowledged.
	dropped     int
	unconfirmed int
	latest      *proto.UsageSample
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
		run:         newUsageRun(),
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
// a figure: a microVM's Firecracker process (and its guest's own memory figures), and each account's isolate runtime
// shared out among its sandboxes.
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
		used, source := s.microVMMemory(p)
		s.taken[p.SandboxID] = p.Owner
		reading := proto.SandboxUsage{
			ID: p.SandboxID, Kind: microvm.Tier, CPU: usage.Utilisation(grew, over, p.CPUs),
			MemUsedBytes: used, MemLimitBytes: p.MemLimitBytes, MemSource: source,
		}
		s.guestStats(p, cpu.Epoch(p.Pid), &reading)
		out = append(out, reading)
	}
	return out
}

// microVMMemory is a microVM's used memory and where it came from: the guest's own MemTotal - MemAvailable (its
// balloon statistics), so its page cache isn't counted and the figure falls when it frees memory; else, for a VM
// without them (restored from a snapshot made before the balloon, or a kernel without virtio_balloon) or one whose
// figures are missing or make no sense, its Firecracker process's resident memory.
func (s *usageSampler) microVMMemory(p usage.Process) (int64, string) {
	if p.ReadGuest != nil {
		ctx, cancel := context.WithTimeout(context.Background(), guestMemoryTimeout)
		guest, err := p.ReadGuest(ctx)
		cancel()
		if err == nil && guest.Total > 0 && guest.Available >= 0 && guest.Available <= guest.Total {
			return guest.Used(), proto.MemSourceGuest
		}
	}
	rss, _ := s.readRSS(p.Pid)
	return rss, proto.MemSourceRSS
}

// guestStats adds a microVM's disk and IO pressure, as its guest's agent has them, to its reading. IO pressure is a
// difference, so it comes from the second answer of the same VM (epoch, its Firecracker's) on. A guest that doesn't
// answer in time, or whose agent predates /stats, has neither: its counter is kept, so the next answer still has one
// to differ from.
func (s *usageSampler) guestStats(p usage.Process, epoch string, reading *proto.SandboxUsage) {
	key := "io/" + p.SandboxID
	if p.ReadStats == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), guestStatsTimeout)
	st, err := p.ReadStats(ctx)
	cancel()
	if err != nil {
		s.counters.Keep(key)
		return
	}
	if st.DiskTotalBytes > 0 && st.DiskUsedBytes >= 0 && st.DiskUsedBytes <= st.DiskTotalBytes {
		reading.DiskUsedBytes, reading.DiskTotalBytes = st.DiskUsedBytes, st.DiskTotalBytes
	}
	if st.IOSomeMicros == nil {
		return
	}
	grew, over, ok := s.counters.Delta(key, epoch, float64(*st.IOSomeMicros)/1e6, s.now())
	if ok && over > 0 {
		// Seconds of stall over seconds of wall time: a share, which a task stalled throughout makes 1.
		pressure := min(1, max(0, grew/over.Seconds()))
		reading.IOPressure = &pressure
	}
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
			MemUsedBytes: rss / n, MemLimitBytes: limit / n, MemSource: proto.MemSourceRSS,
		})
	}
	return out
}

// newUsageRun names a sampler's run: 16 hex digits, random, so a restarted host's Seq starting again at 1 is told
// apart from the ticks Kantel had from the run before.
func newUsageRun() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// keep numbers a sample (Run, Seq) and queues it for the control plane, dropping the oldest past usageBacklog.
func (s *usageSampler) keep(sample proto.UsageSample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	sample.Seq, sample.Run = s.seq, s.run
	s.latest = &sample
	s.queue = append(s.queue, sample)
	if over := len(s.queue) - usageBacklog; over > 0 {
		for _, q := range s.queue[:over] {
			if q.Seq <= s.everSent {
				s.unconfirmed++
			} else {
				s.dropped++
			}
		}
		s.queue = slices.Delete(s.queue, 0, over)
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

// flush sends on link what waits and hasn't gone on it yet, oldest first, one message a sample; a send that fails
// keeps it and what's after it for the next try. On a link other than the last one's, everything queued goes again:
// what went on the last may have been lost with it. With acks (the link's welcome had UsageAcks) a sample sent stays
// queued until a usage.ack covers it (acked); without (an older control plane), it is done with once written, as
// before. It answers how many were sent, and how many the backlog dropped (never sent, and sent but unacknowledged)
// since the last flush that sent any.
func (s *usageSampler) flush(link *caller, acks bool, send func(proto.UsageSample) error) (sent, dropped, unconfirmed int) {
	for {
		s.mu.Lock()
		if link != s.link {
			s.link, s.sentSeq = link, 0
		}
		i := slices.IndexFunc(s.queue, func(q proto.UsageSample) bool { return q.Seq > s.sentSeq })
		if i < 0 {
			s.mu.Unlock()
			return sent, dropped, unconfirmed
		}
		next := s.queue[i]
		s.mu.Unlock()
		if err := send(next); err != nil {
			return sent, dropped, unconfirmed
		}
		s.mu.Lock()
		s.sentSeq = max(s.sentSeq, next.Seq)
		s.everSent = max(s.everSent, next.Seq)
		if !acks {
			s.dropThrough(next.Seq)
		}
		if sent == 0 {
			dropped, s.dropped = s.dropped, 0
			unconfirmed, s.unconfirmed = s.unconfirmed, 0
		}
		s.mu.Unlock()
		sent++
	}
}

// acked lets go of the samples Kantel has taken: a usage.ack covers its Seq and every one before it. One from an
// earlier connection is as good: what it covers was taken.
func (s *usageSampler) acked(seq uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropThrough(seq)
}

// dropThrough removes the queued samples up to seq; s.mu is held.
func (s *usageSampler) dropThrough(seq uint64) {
	n := 0
	for n < len(s.queue) && s.queue[n].Seq <= seq {
		n++
	}
	if n > 0 {
		s.queue = slices.Delete(s.queue, 0, n)
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
	var warnedUnconfirmed time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// The tick only wakes the sampler: each reading is stamped as it is taken.
			if sample, ok := s.take(); ok {
				s.keep(sample)
			}
			h.mu.Lock()
			link, acks := h.link, h.usageAcks
			h.mu.Unlock()
			if link == nil {
				continue
			}
			sent, dropped, unconfirmed := s.flush(link, acks, func(sample proto.UsageSample) error { return h.sendUsage(link, sample) })
			if dropped > 0 {
				h.log.Warn("usage samples dropped while the control plane was out of reach", "dropped", dropped, "sent", sent)
			}
			if unconfirmed > 0 && time.Since(warnedUnconfirmed) >= unconfirmedWarnEvery {
				warnedUnconfirmed = time.Now()
				h.log.Warn("usage samples dropped from the backlog before the control plane acknowledged them", "dropped", unconfirmed)
			}
		}
	}
}

// sendUsage sends one sample as a "usage" message on link. A control plane that doesn't know the type drops it
// (packages/hosts/src/hub.ts answers a type it doesn't know with nothing, and keeps the connection), and one that
// predates FeatureUsageAcks ignores Run and Seq, so this needs no gate.
func (h *Host) sendUsage(link *caller, sample proto.UsageSample) error {
	h.mu.Lock()
	s := h.usage
	h.mu.Unlock()
	if s != nil {
		sample = s.leaving(sample, h.usageVisible)
	}
	if link == nil {
		return errDisconnected
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return link.send(ctx, proto.Message{Type: "usage", Usage: &sample})
}

// usageAcked is Kantel's usage.ack: the samples up to seq are taken, so the backlog lets them go.
func (h *Host) usageAcked(seq uint64) {
	h.mu.Lock()
	s := h.usage
	h.mu.Unlock()
	if s != nil {
		s.acked(seq)
	}
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
