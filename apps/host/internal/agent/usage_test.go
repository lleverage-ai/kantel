package agent

import (
	"encoding/json"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// fakeProc is a machine whose /proc a test writes.
type fakeProc struct {
	host    usage.HostCPU
	procs   map[int]usage.ProcCPU
	rss     map[int]int64
	vms     []usage.Process
	shared  []usage.Shared
	private map[string]bool
}

func (f *fakeProc) sampler() *usageSampler {
	return &usageSampler{
		processes:   func() []usage.Process { return f.vms },
		shared:      func() []usage.Shared { return f.shared },
		public:      func(id string) bool { return !f.private[id] },
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
	if a.Kind != "microvm" || a.MemUsedBytes != 700<<20 || a.MemLimitBytes != 2<<30 {
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

func TestUsageSampleLeavesOutE2ESpaces(t *testing.T) {
	f := &fakeProc{
		host:    usage.HostCPU{Total: 1_000, Idle: 500},
		procs:   map[int]usage.ProcCPU{100: {Ticks: 1, Start: 1}, 200: {Ticks: 1, Start: 1}},
		vms:     []usage.Process{{SandboxID: "sbx_open", Pid: 100, CPUs: 1}, {SandboxID: "sbx_e2e", Pid: 200, CPUs: 1}},
		private: map[string]bool{"sbx_e2e": true},
	}
	s := f.sampler()
	t0 := time.Unix(10_000, 0)
	s.sample(t0)
	f.host = usage.HostCPU{Total: 2_000, Idle: 1_000}
	sample, _ := s.sample(t0.Add(5 * time.Second))
	got := byID(sample)
	if _, ok := got["sbx_e2e"]; ok || len(got) != 1 {
		t.Fatalf("sandboxes %+v: an E2E space's aren't the gateway's to see", sample.Sandboxes)
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
	sentN, dropped := s.flush(func(u proto.UsageSample) error {
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
	sentN, dropped = s.flush(func(proto.UsageSample) error { return nil })
	if sentN != usageBacklog-10 || dropped != 0 || len(s.queue) != 0 {
		t.Fatalf("second flush: sent %d dropped %d left %d", sentN, dropped, len(s.queue))
	}
	if latest := s.latest; latest == nil || latest.At != usageBacklog+29 {
		t.Fatalf("latest %+v", latest)
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
		Sandboxes: []proto.SandboxUsage{{ID: "sbx_a", Kind: "microvm", CPU: 0.5, MemUsedBytes: 5, MemLimitBytes: 6}},
	}}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"usage","usage":{"at":1,"intervalMs":5000,"host":{"cpu":0.25,"memUsedBytes":1,"memTotalBytes":2,"diskUsedBytes":3,"diskTotalBytes":4},"sandboxes":[{"id":"sbx_a","kind":"microvm","cpu":0.5,"memUsedBytes":5,"memLimitBytes":6}]}}`
	if string(raw) != want {
		t.Fatalf("got  %s\nwant %s", raw, want)
	}
	// A host with no running sandbox sends [], not null.
	empty, _ := json.Marshal((&fakeProc{}).sampler().sandboxes(time.Now(), usage.Memory{}))
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
