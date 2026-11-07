package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/memplan"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// fakeProc is a machine whose /proc a test writes.
type fakeProc struct {
	host   usage.HostCPU
	procs  map[int]usage.ProcCPU
	rss    map[int]int64
	vms    []usage.Process
	shared []usage.Shared
}

func (f *fakeProc) sampler() *usageSampler {
	return &usageSampler{
		processes:   func() []usage.Process { return f.vms },
		shared:      func() []usage.Shared { return f.shared },
		readHostCPU: func() (usage.HostCPU, error) { return f.host, nil },
		readMemory:  func() (usage.Memory, error) { return usage.Memory{Total: 64 << 30, Available: 48 << 30}, nil },
		readDisk:    func() (usage.Disk, error) { return usage.Disk{Total: 1 << 40, Used: 1 << 38}, nil },
		readCPU: func(pid int) (usage.ProcCPU, error) {
			p, ok := f.procs[pid]
			if !ok {
				return usage.ProcCPU{}, errors.New("no such process")
			}
			return p, nil
		},
		readRSS:  func(pid int) (int64, error) { return f.rss[pid], nil },
		counters: usage.NewCounters(),
	}
}

// sample takes a reading with the clock stopped at now: every counter is stamped now.
func (s *usageSampler) sample(now time.Time) (proto.UsageSample, bool) {
	s.now = func() time.Time { return now }
	return s.take()
}

func approx(t *testing.T, what string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-6 {
		t.Fatalf("%s = %v, want %v", what, got, want)
	}
}

func byID(sample proto.UsageSample) map[string]proto.SandboxUsage {
	out := map[string]proto.SandboxUsage{}
	for _, s := range sample.Sandboxes {
		out[s.ID] = s
	}
	return out
}

func TestUsageSampleHostAndMicroVMs(t *testing.T) {
	f := &fakeProc{
		host:  usage.HostCPU{Total: 10_000, Idle: 9_000},
		procs: map[int]usage.ProcCPU{100: {Ticks: 1_000, Start: 7}},
		rss:   map[int]int64{100: 700 << 20},
		vms:   []usage.Process{{SandboxID: "sbx_a", Pid: 100, CPUs: 2, MemLimitBytes: 2 << 30}},
	}
	s := f.sampler()
	t0 := time.Unix(10_000, 0)
	if _, ok := s.sample(t0); ok {
		t.Fatal("the first sample only sets where CPU starts")
	}
	// 5 s later: the host went 25% busy; sbx_a's Firecracker used 5 s of CPU, half of its 2 vCPUs.
	f.host = usage.HostCPU{Total: 14_000, Idle: 12_000}
	f.procs[100] = usage.ProcCPU{Ticks: 1_500, Start: 7}
	// sbx_b appears between ticks: it has no figure until its second reading.
	f.vms = append(f.vms, usage.Process{SandboxID: "sbx_b", Pid: 200, CPUs: 4, MemLimitBytes: 8 << 30})
	f.procs[200] = usage.ProcCPU{Ticks: 10, Start: 9}
	sample, ok := s.sample(t0.Add(5 * time.Second))
	if !ok {
		t.Fatal("want a sample")
	}
	if sample.At != t0.Add(5*time.Second).UnixMilli() || sample.IntervalMs != 5000 {
		t.Fatalf("at %d interval %d", sample.At, sample.IntervalMs)
	}
	approx(t, "host cpu", sample.Host.CPU, 0.25)
	if sample.Host.MemUsedBytes != 16<<30 || sample.Host.MemTotalBytes != 64<<30 || sample.Host.DiskUsedBytes != 1<<38 || sample.Host.DiskTotalBytes != 1<<40 {
		t.Fatalf("host %+v", sample.Host)
	}
	got := byID(sample)
	if len(got) != 1 {
		t.Fatalf("sandboxes %+v, want only sbx_a", sample.Sandboxes)
	}
	a := got["sbx_a"]
	approx(t, "sbx_a cpu", a.CPU, 0.5)
	// No guest figures to read (ReadGuest unset): its Firecracker's resident memory, and it says so.
	if a.Kind != "microvm" || a.MemUsedBytes != 700<<20 || a.MemLimitBytes != 2<<30 || a.MemSource != proto.MemSourceRSS {
		t.Fatalf("sbx_a %+v", a)
	}

	// Next tick: sbx_a stopped (gone from the list), sbx_b has its figure, flat out on its 4 vCPUs.
	f.host = usage.HostCPU{Total: 18_000, Idle: 15_000}
	f.vms = f.vms[1:]
	f.procs[200] = usage.ProcCPU{Ticks: 2_010, Start: 9}
	sample, _ = s.sample(t0.Add(10 * time.Second))
	got = byID(sample)
	if _, ok := got["sbx_a"]; ok || len(got) != 1 {
		t.Fatalf("sandboxes %+v, want only sbx_b", sample.Sandboxes)
	}
	approx(t, "sbx_b cpu", got["sbx_b"].CPU, 1)

	// sbx_a resumes in a new Firecracker (another pid): it starts again rather than being measured across the gap.
	f.vms = append(f.vms, usage.Process{SandboxID: "sbx_a", Pid: 300, CPUs: 2, MemLimitBytes: 2 << 30})
	f.procs[300] = usage.ProcCPU{Ticks: 5, Start: 20}
	f.host = usage.HostCPU{Total: 22_000, Idle: 18_000}
	sample, _ = s.sample(t0.Add(15 * time.Second))
	if _, ok := byID(sample)["sbx_a"]; ok {
		t.Fatal("a resumed sandbox has no figure on its first reading")
	}
	f.procs[300] = usage.ProcCPU{Ticks: 105, Start: 20}
	f.host = usage.HostCPU{Total: 26_000, Idle: 21_000}
	sample, _ = s.sample(t0.Add(20 * time.Second))
	approx(t, "sbx_a after resume", byID(sample)["sbx_a"].CPU, 0.1)
}

func TestUsageSampleCounterReset(t *testing.T) {
	f := &fakeProc{
		host:  usage.HostCPU{Total: 1_000, Idle: 500},
		procs: map[int]usage.ProcCPU{100: {Ticks: 5_000, Start: 7}},
		vms:   []usage.Process{{SandboxID: "sbx_a", Pid: 100, CPUs: 1}},
	}
	s := f.sampler()
	t0 := time.Unix(10_000, 0)
	s.sample(t0)
	// Both counters went backwards (the same pid and start, so a reset, not a new process): no figures this tick.
	f.host = usage.HostCPU{Total: 100, Idle: 50}
	f.procs[100] = usage.ProcCPU{Ticks: 10, Start: 7}
	if _, ok := s.sample(t0.Add(5 * time.Second)); ok {
		t.Fatal("a host counter reset should give no sample")
	}
	// The next tick measures from the reset.
	f.host = usage.HostCPU{Total: 600, Idle: 300}
	f.procs[100] = usage.ProcCPU{Ticks: 260, Start: 7}
	sample, ok := s.sample(t0.Add(10 * time.Second))
	if !ok {
		t.Fatal("want a sample after the reset")
	}
	approx(t, "host", sample.Host.CPU, 0.5)
	approx(t, "sbx_a", byID(sample)["sbx_a"].CPU, 0.5)
}

// A microVM's memory is its guest's own count, MemTotal - MemAvailable from its balloon's statistics: it falls when the
// guest frees memory, while its Firecracker's resident memory stays at its high point.
func TestUsageSampleMicroVMGuestMemory(t *testing.T) {
	guest := usage.Memory{Total: 1_950 << 20, Available: 1_450 << 20}
	var guestErr error
	var asked int
	f := &fakeProc{
		host:  usage.HostCPU{Total: 1_000, Idle: 500},
		procs: map[int]usage.ProcCPU{100: {Ticks: 10, Start: 7}},
		rss:   map[int]int64{100: 600 << 20},
		vms: []usage.Process{{SandboxID: "sbx_a", Pid: 100, CPUs: 2, MemLimitBytes: 2 << 30,
			ReadGuest: func(ctx context.Context) (usage.Memory, error) {
				asked++
				if _, ok := ctx.Deadline(); !ok {
					t.Error("the guest's figures are read with a deadline")
				}
				return guest, guestErr
			}}},
	}
	s := f.sampler()
	t0 := time.Unix(10_000, 0)
	tick := 0
	read := func() proto.SandboxUsage {
		t.Helper()
		tick++
		f.host.Total += 1_000
		f.host.Idle += 500
		f.procs[100] = usage.ProcCPU{Ticks: f.procs[100].Ticks + 100, Start: 7}
		sample, ok := s.sample(t0.Add(time.Duration(tick) * 5 * time.Second))
		if !ok {
			t.Fatal("want a sample")
		}
		got, ok := byID(sample)["sbx_a"]
		if !ok {
			t.Fatalf("no sbx_a in %+v", sample.Sandboxes)
		}
		return got
	}
	s.sample(t0)

	a := read()
	if a.MemUsedBytes != 500<<20 || a.MemSource != proto.MemSourceGuest || a.MemLimitBytes != 2<<30 {
		t.Fatalf("at rest %+v", a)
	}
	// The guest takes 1 GiB: both rise.
	guest.Available -= 1 << 30
	f.rss[100] = 1_900 << 20
	if a = read(); a.MemUsedBytes != 1_524<<20 || a.MemSource != proto.MemSourceGuest {
		t.Fatalf("after the allocation %+v", a)
	}
	// And frees it: the guest's figure falls back, though the process keeps every page it touched.
	guest.Available += 1 << 30
	if a = read(); a.MemUsedBytes != 500<<20 || a.MemSource != proto.MemSourceGuest {
		t.Fatalf("after the free %+v", a)
	}

	// No statistics (a VM restored from a snapshot made before the balloon): resident memory, marked as such.
	guestErr = errors.New("firecracker GET /balloon/statistics: 400")
	if a = read(); a.MemUsedBytes != 1_900<<20 || a.MemSource != proto.MemSourceRSS {
		t.Fatalf("without statistics %+v", a)
	}
	// Figures that make no sense are not taken either.
	guestErr = nil
	for _, bad := range []usage.Memory{{}, {Total: 1 << 30, Available: 2 << 30}, {Total: 1 << 30, Available: -1}} {
		guest = bad
		if a = read(); a.MemUsedBytes != 1_900<<20 || a.MemSource != proto.MemSourceRSS {
			t.Fatalf("from %+v: %+v", bad, a)
		}
	}

	// A held sandbox isn't asked: its lock may be a snapshot's, with its Firecracker busy.
	before := asked
	f.vms[0].Held = true
	f.host.Total += 1_000
	f.host.Idle += 500
	s.sample(t0.Add(time.Duration(tick+1) * 5 * time.Second))
	if asked != before {
		t.Fatal("a held sandbox's guest was asked")
	}
}

func TestUsageSampleMicroVMDiskAndIOPressure(t *testing.T) {
	stats := usage.GuestStats{DiskUsedBytes: 3 << 30, DiskTotalBytes: 10 << 30}
	var statsErr error
	f := &fakeProc{
		host:  usage.HostCPU{Total: 1_000, Idle: 500},
		procs: map[int]usage.ProcCPU{100: {Ticks: 10, Start: 7}},
		rss:   map[int]int64{100: 600 << 20},
		vms: []usage.Process{{SandboxID: "sbx_a", Pid: 100, CPUs: 2, MemLimitBytes: 2 << 30,
			ReadStats: func(ctx context.Context) (usage.GuestStats, error) {
				if _, ok := ctx.Deadline(); !ok {
					t.Error("the guest's stats are read with a deadline")
				}
				return stats, statsErr
			}}},
	}
	s := f.sampler()
	t0 := time.Unix(10_000, 0)
	tick := 0
	read := func() proto.SandboxUsage {
		t.Helper()
		tick++
		f.host.Total += 1_000
		f.host.Idle += 500
		f.procs[100] = usage.ProcCPU{Ticks: f.procs[100].Ticks + 100, Start: 7}
		sample, ok := s.sample(t0.Add(time.Duration(tick) * 5 * time.Second))
		if !ok {
			t.Fatal("want a sample")
		}
		return byID(sample)["sbx_a"]
	}
	s.sample(t0)
	micros := func(v uint64) *uint64 { return &v }

	// A kernel without pressure figures: the disk, and no IO pressure.
	a := read()
	if a.DiskUsedBytes != 3<<30 || a.DiskTotalBytes != 10<<30 || a.IOPressure != nil {
		t.Fatalf("without pressure %+v", a)
	}
	// With them, from the second answer: 1.25 s stalled in the 5 s between.
	stats.IOSomeMicros = micros(2_000_000)
	if a = read(); a.IOPressure != nil {
		t.Fatalf("a first pressure reading has nothing to differ from: %v", *a.IOPressure)
	}
	stats.IOSomeMicros = micros(3_250_000)
	if a = read(); a.IOPressure == nil {
		t.Fatal("no IO pressure")
	}
	approx(t, "IO pressure", *a.IOPressure, 0.25)

	// A guest that doesn't answer (an older agent's 404): neither, and its counter waits for the next answer.
	statsErr = errors.New("guest agent: 404 page not found")
	if a = read(); a.DiskTotalBytes != 0 || a.IOPressure != nil {
		t.Fatalf("unanswered %+v", a)
	}
	statsErr = nil
	stats.IOSomeMicros = micros(13_250_000)
	if a = read(); a.IOPressure == nil {
		t.Fatal("no IO pressure after a missed answer")
	}
	// 10 s stalled over the 10 s since the last answer.
	approx(t, "IO pressure after a miss", *a.IOPressure, 1)

	// A disk figure that makes no sense isn't sent.
	stats.DiskUsedBytes = 11 << 30
	if a = read(); a.DiskTotalBytes != 0 || a.DiskUsedBytes != 0 {
		t.Fatalf("used beyond its size %+v", a)
	}

	// On the wire, both are left out when there are none (a host that predates them sends the same).
	raw, _ := json.Marshal(proto.SandboxUsage{ID: "sbx_a", Kind: "microvm"})
	if string(raw) != `{"id":"sbx_a","kind":"microvm","cpu":0,"memUsedBytes":0,"memLimitBytes":0}` {
		t.Fatalf("wire %s", raw)
	}
}

// Guests that don't answer cost a pass one guestStatsTimeout in all, not one each, and the others' figures still come.
func TestUsageSampleGuestStatsAskedAtOnce(t *testing.T) {
	const vms = 20
	f := &fakeProc{
		host:  usage.HostCPU{Total: 1_000, Idle: 500},
		procs: map[int]usage.ProcCPU{},
		rss:   map[int]int64{},
	}
	for i := range vms {
		pid := 100 + i
		f.procs[pid] = usage.ProcCPU{Ticks: 10, Start: 7}
		stuck := i%2 == 0
		f.vms = append(f.vms, usage.Process{SandboxID: fmt.Sprintf("sbx_%d", i), Pid: pid, CPUs: 1, MemLimitBytes: 1 << 30,
			ReadStats: func(ctx context.Context) (usage.GuestStats, error) {
				if stuck {
					<-ctx.Done()
					return usage.GuestStats{}, ctx.Err()
				}
				return usage.GuestStats{DiskUsedBytes: 1 << 30, DiskTotalBytes: 4 << 30}, nil
			}})
	}
	s := f.sampler()
	t0 := time.Unix(10_000, 0)
	s.sample(t0)
	f.host.Total += 1_000
	f.host.Idle += 500
	for pid, p := range f.procs {
		f.procs[pid] = usage.ProcCPU{Ticks: p.Ticks + 100, Start: 7}
	}
	started := time.Now()
	sample, ok := s.sample(t0.Add(5 * time.Second))
	if took := time.Since(started); took > 3*guestStatsTimeout {
		t.Fatalf("a pass with %d stuck guests took %v", vms/2, took)
	}
	if !ok || len(sample.Sandboxes) != vms {
		t.Fatalf("want %d sandboxes, got %+v", vms, sample.Sandboxes)
	}
	for i := range vms {
		got := byID(sample)[fmt.Sprintf("sbx_%d", i)]
		if got.CPU == 0 {
			t.Fatalf("sbx_%d lost its CPU", i)
		}
		var want int64 // a stuck guest's: none
		if i%2 == 1 {
			want = 4 << 30
		}
		if got.DiskTotalBytes != want {
			t.Fatalf("sbx_%d disk %d, want %d", i, got.DiskTotalBytes, want)
		}
	}
}

func TestUsageSampleIsolatesShareTheirRuntime(t *testing.T) {
	f := &fakeProc{
		host:  usage.HostCPU{Total: 1_000, Idle: 500},
		procs: map[int]usage.ProcCPU{500: {Ticks: 100, Start: 3}},
		rss:   map[int]int64{500: 600 << 20},
	}
	runtime := func(a, b, c float64) []usage.Shared {
		return []usage.Shared{
			{Key: "isolate/acct/rt-1", Pid: 500, CPUs: 1, MemLimitBytes: 1 << 30, Sandboxes: []usage.Busy{
				{SandboxID: "iso_a", Seconds: a}, {SandboxID: "iso_b", Seconds: b}, {SandboxID: "iso_c", Seconds: c},
			}},
			// An account whose VM was reaped while idle: its sandboxes are running and use nothing.
			{Key: "isolate/other", Pid: 0, CPUs: 1, MemLimitBytes: 1 << 30, Sandboxes: []usage.Busy{{SandboxID: "iso_z", Seconds: 9}}},
		}
	}
	f.shared = runtime(1, 0, 0)
	s := f.sampler()
	t0 := time.Unix(10_000, 0)
	s.sample(t0)
	// Over 5 s: iso_a ran commands for 3 s and iso_b for 1 s; the VM used 4 s of CPU.
	f.host = usage.HostCPU{Total: 2_000, Idle: 1_000}
	f.procs[500] = usage.ProcCPU{Ticks: 500, Start: 3}
	f.shared = runtime(4, 1, 0)
	sample, ok := s.sample(t0.Add(5 * time.Second))
	if !ok {
		t.Fatal("want a sample")
	}
	got := byID(sample)
	// 3 of the 4 s to iso_a: 3 / (5 s x one CPU); 1 to iso_b; none to iso_c, which ran nothing.
	approx(t, "iso_a", got["iso_a"].CPU, 0.6)
	approx(t, "iso_b", got["iso_b"].CPU, 0.2)
	approx(t, "iso_c", got["iso_c"].CPU, 0)
	approx(t, "iso_z", got["iso_z"].CPU, 0)
	// Memory evenly: the VM's resident memory and its limit, a third each.
	if got["iso_a"].Kind != "isolate" || got["iso_a"].MemUsedBytes != 200<<20 || got["iso_a"].MemLimitBytes != (1<<30)/3 {
		t.Fatalf("iso_a %+v", got["iso_a"])
	}
	if got["iso_z"].MemUsedBytes != 0 {
		t.Fatalf("iso_z %+v", got["iso_z"])
	}

	// Nobody ran anything: the VM's own 0.5 s (workerd idling) is nobody's.
	f.host = usage.HostCPU{Total: 3_000, Idle: 2_000}
	f.procs[500] = usage.ProcCPU{Ticks: 550, Start: 3}
	sample, _ = s.sample(t0.Add(10 * time.Second))
	for _, u := range sample.Sandboxes {
		if u.CPU != 0 {
			t.Fatalf("%s got %v with no command run", u.ID, u.CPU)
		}
	}

	// The account's VM is replaced (reaped, then a new one): no CPU figure across the two.
	f.procs[600] = usage.ProcCPU{Ticks: 10, Start: 50}
	f.shared = runtime(6, 1, 0)
	f.shared[0].Key, f.shared[0].Pid = "isolate/acct/rt-2", 600
	f.host = usage.HostCPU{Total: 4_000, Idle: 3_000}
	sample, _ = s.sample(t0.Add(15 * time.Second))
	if _, ok := byID(sample)["iso_a"]; ok {
		t.Fatal("a new runtime has no figure on its first reading")
	}
}

func TestUsageBacklogIsBoundedAndKeepsOrder(t *testing.T) {
	s := (&fakeProc{}).sampler()
	for i := range usageBacklog + 30 {
		s.keep(proto.UsageSample{At: int64(i)})
	}
	if len(s.queue) != usageBacklog || s.queue[0].At != 30 {
		t.Fatalf("queue %d from %d, want %d from 30", len(s.queue), s.queue[0].At, usageBacklog)
	}
	// The link fails part-way: what wasn't sent waits for the next try, in order.
	var sent []int64
	fail := 40
	sentN, dropped, _ := s.flush(nil, false, func(u proto.UsageSample) error {
		if u.At == int64(fail) {
			return errDisconnected
		}
		sent = append(sent, u.At)
		return nil
	})
	if sentN != 10 || dropped != 30 || sent[0] != 30 || sent[9] != 39 {
		t.Fatalf("sent %d (%v), dropped %d", sentN, sent, dropped)
	}
	if len(s.queue) != usageBacklog-10 || s.queue[0].At != 40 {
		t.Fatalf("left %d from %d", len(s.queue), s.queue[0].At)
	}
	fail = -1
	sentN, dropped, _ = s.flush(nil, false, func(proto.UsageSample) error { return nil })
	if sentN != usageBacklog-10 || dropped != 0 || len(s.queue) != 0 {
		t.Fatalf("second flush: sent %d dropped %d left %d", sentN, dropped, len(s.queue))
	}
	if latest := s.latest; latest == nil || latest.At != usageBacklog+29 {
		t.Fatalf("latest %+v", latest)
	}
}

// seqs are the Seq of each sample.
func seqs(samples []proto.UsageSample) []uint64 {
	out := make([]uint64, 0, len(samples))
	for _, s := range samples {
		out = append(out, s.Seq)
	}
	return out
}

// Each sample is numbered in the sampler's run, from 1 up; another sampler (a restarted host) has another run.
func TestUsageSamplesAreNumberedInTheirRun(t *testing.T) {
	s := (&fakeProc{}).sampler()
	s.run = newUsageRun()
	for i := range 3 {
		s.keep(proto.UsageSample{At: int64(i)})
	}
	if got := seqs(s.queue); !slices.Equal(got, []uint64{1, 2, 3}) {
		t.Fatalf("seqs %v", got)
	}
	for _, q := range s.queue {
		if q.Run != s.run || len(q.Run) != 16 {
			t.Fatalf("run %q, the sampler's %q", q.Run, s.run)
		}
	}
	if newUsageRun() == s.run {
		t.Fatal("two runs with one name")
	}
}

// With acks, a sample sent stays queued until a usage.ack covers it, and isn't sent again on the same link; on the next
// link, everything unacknowledged goes again, in order: ticks written into a connection that then died aren't lost.
func TestUsageUnackedSamplesAreSentAgainOnTheNextLink(t *testing.T) {
	s := (&fakeProc{}).sampler()
	first, second := &caller{}, &caller{}
	var sent []uint64
	send := func(u proto.UsageSample) error { sent = append(sent, u.Seq); return nil }
	for i := range 3 {
		s.keep(proto.UsageSample{At: int64(i)})
	}
	if n, _, _ := s.flush(first, true, send); n != 3 || len(s.queue) != 3 {
		t.Fatalf("sent %d, %d queued", n, len(s.queue))
	}
	// The same link again: nothing goes twice.
	s.keep(proto.UsageSample{At: 3})
	if n, _, _ := s.flush(first, true, send); n != 1 || !slices.Equal(sent, []uint64{1, 2, 3, 4}) {
		t.Fatalf("sent %d: %v", n, sent)
	}
	s.acked(2)
	if got := seqs(s.queue); !slices.Equal(got, []uint64{3, 4}) {
		t.Fatalf("after ack 2: %v", got)
	}
	// The link died with 3 and 4 written into it; 5 and 6 were taken while it was down.
	s.keep(proto.UsageSample{At: 4})
	s.keep(proto.UsageSample{At: 5})
	sent = nil
	if n, _, _ := s.flush(second, true, send); n != 4 || !slices.Equal(sent, []uint64{3, 4, 5, 6}) {
		t.Fatalf("resent %d: %v", n, sent)
	}
	// An ack can't take back what it covers, nor one from the link before be wrong: it covers what was taken.
	s.acked(6)
	s.acked(4)
	if len(s.queue) != 0 {
		t.Fatalf("left %v", seqs(s.queue))
	}
}

// A send that fails part-way on a link keeps what didn't go, which goes next on that link or the next.
func TestUsageAFailedSendIsTriedAgainInOrder(t *testing.T) {
	s := (&fakeProc{}).sampler()
	link := &caller{}
	for i := range 5 {
		s.keep(proto.UsageSample{At: int64(i)})
	}
	var sent []uint64
	failAt := uint64(3)
	send := func(u proto.UsageSample) error {
		if u.Seq == failAt {
			return errDisconnected
		}
		sent = append(sent, u.Seq)
		return nil
	}
	s.flush(link, true, send)
	failAt = 0
	s.flush(link, true, send)
	if !slices.Equal(sent, []uint64{1, 2, 3, 4, 5}) {
		t.Fatalf("sent %v", sent)
	}
}

// Talking to a control plane that predates acks (its welcome has no UsageAcks), a sample is done with once written,
// as before: nothing is kept for an ack that never comes, and nothing goes again on the next link.
func TestUsageWithoutAcksASampleIsDoneOnceWritten(t *testing.T) {
	s := (&fakeProc{}).sampler()
	first, second := &caller{}, &caller{}
	var sent []uint64
	send := func(u proto.UsageSample) error { sent = append(sent, u.Seq); return nil }
	for i := range 3 * usageBacklog {
		s.keep(proto.UsageSample{At: int64(i)})
		if _, dropped, unconfirmed := s.flush(first, false, send); dropped != 0 || unconfirmed != 0 {
			t.Fatalf("dropped %d, unconfirmed %d", dropped, unconfirmed)
		}
		if len(s.queue) != 0 {
			t.Fatalf("%d queued after a flush", len(s.queue))
		}
	}
	s.keep(proto.UsageSample{At: 9999})
	sent = nil
	s.flush(second, false, send)
	if !slices.Equal(sent, []uint64{3*usageBacklog + 1}) {
		t.Fatalf("on the next link: %v", sent)
	}
}

// With acks that never come (a control plane that says it acks and doesn't), the backlog stays bounded: the oldest
// go, counted as unconfirmed rather than as dropped unsent.
func TestUsageUnackedBacklogIsBounded(t *testing.T) {
	s := (&fakeProc{}).sampler()
	link := &caller{}
	send := func(proto.UsageSample) error { return nil }
	unconfirmed := 0
	for i := range usageBacklog + 80 {
		s.keep(proto.UsageSample{At: int64(i)})
		_, dropped, n := s.flush(link, true, send)
		if dropped != 0 {
			t.Fatalf("dropped %d unsent", dropped)
		}
		unconfirmed += n
	}
	if len(s.queue) != usageBacklog || s.queue[0].Seq != 81 || unconfirmed != 80 {
		t.Fatalf("queue %d from %d, %d unconfirmed", len(s.queue), s.queue[0].Seq, unconfirmed)
	}
}

// The wire: a tick's run and seq, a welcome's usageAcks, Kantel's usage.ack.
func TestUsageAckWireShape(t *testing.T) {
	raw, _ := json.Marshal(proto.Message{Type: "usage", Usage: &proto.UsageSample{Seq: 7, Run: "0123456789abcdef", At: 1, IntervalMs: 5000}})
	want := `{"type":"usage","usage":{"seq":7,"run":"0123456789abcdef","at":1,"intervalMs":5000,"host":{"cpu":0,"memUsedBytes":0,"memTotalBytes":0,"diskUsedBytes":0,"diskTotalBytes":0},"sandboxes":null}}`
	if string(raw) != want {
		t.Fatalf("got  %s\nwant %s", raw, want)
	}
	var m proto.Message
	if err := json.Unmarshal([]byte(`{"type":"welcome","welcome":{"hostId":"h","heartbeatSeconds":15,"usageAcks":true}}`), &m); err != nil || !m.Welcome.UsageAcks {
		t.Fatalf("welcome %+v %v", m.Welcome, err)
	}
	if err := json.Unmarshal([]byte(`{"type":"usage.ack","acked":42}`), &m); err != nil || m.Acked != 42 {
		t.Fatalf("ack %+v %v", m, err)
	}
	if !slices.Contains(streamHost(t, newStreamTier(nil)).makeFacts().Features, proto.FeatureUsageAcks) {
		t.Fatal("the facts don't say usage-acks")
	}
}

// A tick that comes late (a slow send before it, or the tiers slow to list) is stamped when its counters were read,
// so CPU time is divided by the time it really took.
func TestUsageStampsReadingsWhenTaken(t *testing.T) {
	f := &fakeProc{
		host:  usage.HostCPU{Total: 10_000, Idle: 9_000},
		procs: map[int]usage.ProcCPU{100: {Ticks: 0, Start: 7}},
		vms:   []usage.Process{{SandboxID: "sbx_a", Pid: 100, CPUs: 1}},
	}
	s := f.sampler()
	t0 := time.Unix(10_000, 0)
	clock := t0
	s.now = func() time.Time { return clock }
	listed, slow := s.processes, false
	s.processes = func() []usage.Process {
		if slow {
			// Listing the tiers took 10 s: the tick was due at t0+5s, the readings were taken at t0+15s.
			clock = clock.Add(10 * time.Second)
		}
		return listed()
	}
	s.take()
	clock, slow = t0.Add(5*time.Second), true
	// 15 s after the first reading, sbx_a used 3.75 s: 25% of its one vCPU.
	f.procs[100] = usage.ProcCPU{Ticks: 375, Start: 7}
	f.host.Total += 1_000
	sample, ok := s.take()
	if !ok {
		t.Fatal("want a sample")
	}
	if sample.At != t0.Add(15*time.Second).UnixMilli() || sample.IntervalMs != 15_000 {
		t.Fatalf("at %d interval %d", sample.At-t0.UnixMilli(), sample.IntervalMs)
	}
	approx(t, "sbx_a", byID(sample)["sbx_a"].CPU, 0.25)
}

// A sandbox mid-operation (its lock held) is skipped that time but still followed: the next reading has its figure,
// over both intervals, rather than starting again.
func TestUsageHeldSandboxKeepsItsCounters(t *testing.T) {
	f := &fakeProc{
		host:  usage.HostCPU{Total: 10_000, Idle: 9_000},
		procs: map[int]usage.ProcCPU{100: {Ticks: 0, Start: 7}, 500: {Ticks: 0, Start: 3}},
		vms:   []usage.Process{{SandboxID: "sbx_a", Pid: 100, CPUs: 1}},
		shared: []usage.Shared{{Key: "isolate/acct/rt", Pid: 500, CPUs: 1, MemLimitBytes: 1 << 30,
			Sandboxes: []usage.Busy{{SandboxID: "iso_a", Seconds: 0}}}},
	}
	s := f.sampler()
	t0 := time.Unix(10_000, 0)
	s.sample(t0)
	// At 5 s both are mid-operation: no figures, the host's still goes.
	f.vms = []usage.Process{{SandboxID: "sbx_a", Held: true}}
	f.shared = []usage.Shared{{Key: "isolate/acct/rt", Pid: 500, CPUs: 1, Held: []string{"iso_a"}}}
	f.host.Total += 1_000
	sample, ok := s.sample(t0.Add(5 * time.Second))
	if !ok || len(sample.Sandboxes) != 0 {
		t.Fatalf("held: ok %v, %+v", ok, sample.Sandboxes)
	}
	// At 10 s: sbx_a used 5 s and the runtime 2 s, all iso_a's, over the 10 s.
	f.vms = []usage.Process{{SandboxID: "sbx_a", Pid: 100, CPUs: 1}}
	f.procs[100] = usage.ProcCPU{Ticks: 500, Start: 7}
	f.procs[500] = usage.ProcCPU{Ticks: 200, Start: 3}
	f.shared = []usage.Shared{{Key: "isolate/acct/rt", Pid: 500, CPUs: 1, MemLimitBytes: 1 << 30,
		Sandboxes: []usage.Busy{{SandboxID: "iso_a", Seconds: 4}}}}
	f.host.Total += 1_000
	sample, _ = s.sample(t0.Add(10 * time.Second))
	got := byID(sample)
	approx(t, "sbx_a", got["sbx_a"].CPU, 0.5)
	approx(t, "iso_a", got["iso_a"].CPU, 0.2)
}

// Memory is read of now: the memory plan, and with it the guard, has a new or resumed VM from its first reading, before
// its CPU has a figure; a held one keeps its place in the plan.
func TestUsageMemoryPlanHasEveryVMAtOnce(t *testing.T) {
	f := &fakeProc{
		host:  usage.HostCPU{Total: 10_000, Idle: 9_000},
		procs: map[int]usage.ProcCPU{100: {Ticks: 0, Start: 7}},
		rss:   map[int]int64{100: 700 << 20, 200: 3 << 30, 300: 900 << 20},
		vms:   []usage.Process{{SandboxID: "sbx_a", Pid: 100, CPUs: 1, MemLimitBytes: 2 << 30}},
	}
	s := f.sampler()
	plan := memplan.New(memplan.Settings{Enabled: true}, 10_000, 2_000, 1.5)
	t0 := time.Unix(10_000, 0)
	observe := func(at time.Time) []memplan.Reading {
		t.Helper()
		plan.Observe(at, s.memory, hostinfo.Memory{TotalMiB: 12_000, AvailableMiB: 8_000})
		return plan.Readings()
	}
	// The very first sample, which only starts the CPU counters, reads memory.
	s.sample(t0)
	if got := observe(t0); len(got) != 1 || got[0].ID != "sbx_a" || got[0].RSSMiB != 700 || got[0].Pid != 100 {
		t.Fatalf("first sample: %+v", got)
	}
	// sbx_b starts between ticks, already holding 3 GiB: no CPU figure yet, but the guard can take it.
	f.vms = append(f.vms, usage.Process{SandboxID: "sbx_b", Pid: 200, CPUs: 4, MemLimitBytes: 8 << 30})
	f.procs[200] = usage.ProcCPU{Ticks: 10, Start: 9}
	f.host.Total += 1_000
	sample, _ := s.sample(t0.Add(5 * time.Second))
	if _, ok := byID(sample)["sbx_b"]; ok {
		t.Fatal("a new VM's CPU has a figure on its first reading")
	}
	got := observe(t0.Add(5 * time.Second))
	if len(got) != 2 || got[0].ID != "sbx_b" || got[0].RSSMiB != 3<<10 || got[0].Pid != 200 || got[0].SizeMiB != 8<<10 {
		t.Fatalf("with a new VM: %+v", got)
	}
	// sbx_a resumes in a new Firecracker, sbx_b is held mid-operation: both stay candidates, sbx_a's new process at once.
	f.vms = []usage.Process{{SandboxID: "sbx_a", Pid: 300, CPUs: 1, MemLimitBytes: 2 << 30}, {SandboxID: "sbx_b", Held: true}}
	f.procs[300] = usage.ProcCPU{Ticks: 1, Start: 30}
	f.host.Total += 1_000
	s.sample(t0.Add(10 * time.Second))
	got = observe(t0.Add(10 * time.Second))
	if len(got) != 2 || got[0].ID != "sbx_b" || got[0].Pid != 200 || got[1].ID != "sbx_a" || got[1].Pid != 300 || got[1].RSSMiB != 900 {
		t.Fatalf("resumed and held: %+v", got)
	}
}

// The control plane takes an interval of 1 s to 5 minutes: a tick a little early, or the first after the host was
// paused, still goes.
func TestUsageIntervalInRange(t *testing.T) {
	f := &fakeProc{host: usage.HostCPU{Total: 10_000, Idle: 9_000}}
	s := f.sampler()
	t0 := time.Unix(10_000, 0)
	s.sample(t0)
	for _, step := range []struct {
		after time.Duration
		want  int64
	}{{999 * time.Millisecond, 1000}, {4999 * time.Millisecond, 4999}, {time.Hour, 300_000}} {
		t0 = t0.Add(step.after)
		f.host.Total += 1_000
		sample, ok := s.sample(t0)
		if !ok || sample.IntervalMs != step.want {
			t.Fatalf("after %v: interval %d (ok %v), want %d", step.after, sample.IntervalMs, ok, step.want)
		}
	}
}

// The wire shape the control plane reads (packages/hosts/src/protocol.ts HostUsageReport): keep the two in step.
func TestUsageEventWireShape(t *testing.T) {
	m := proto.Message{Type: "usage", Usage: &proto.UsageSample{
		At: 1, IntervalMs: 5000,
		Host:      proto.HostUsage{CPU: 0.25, MemUsedBytes: 1, MemTotalBytes: 2, DiskUsedBytes: 3, DiskTotalBytes: 4},
		Sandboxes: []proto.SandboxUsage{{ID: "sbx_a", Kind: "microvm", CPU: 0.5, MemUsedBytes: 5, MemLimitBytes: 6, MemSource: "guest"}},
	}}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"usage","usage":{"at":1,"intervalMs":5000,"host":{"cpu":0.25,"memUsedBytes":1,"memTotalBytes":2,"diskUsedBytes":3,"diskTotalBytes":4},"sandboxes":[{"id":"sbx_a","kind":"microvm","cpu":0.5,"memUsedBytes":5,"memLimitBytes":6,"memSource":"guest"}]}}`
	if string(raw) != want {
		t.Fatalf("got  %s\nwant %s", raw, want)
	}
	// A host with no running sandbox sends [], not null.
	empty, _ := json.Marshal((&fakeProc{}).sampler().sandboxes(nil, usage.Memory{}))
	if string(empty) != "[]" {
		t.Fatalf("no sandboxes: %s", empty)
	}
}

func TestUsageInterval(t *testing.T) {
	for in, want := range map[int]time.Duration{0: 5 * time.Second, 2: 2 * time.Second, -1: 0, 1000: 300 * time.Second} {
		if got := (Config{UsageIntervalSeconds: in}).usageInterval(); got != want {
			t.Fatalf("%d: %v, want %v", in, got, want)
		}
	}
}
