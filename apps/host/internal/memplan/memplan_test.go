package memplan

import (
	"strings"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

const gib = 1024

// The Lleverage host of 7 Nov 2026: 125 GB, a tenth kept back, 113 GB for sandboxes; checks VMs of 16 vCPU / 32 GB.
var (
	capacity = int64(113463)
	reserve  = int64(12607)
	check    = int64(32 * gib)
	t0       = time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
)

func idle(total int64) hostinfo.Memory {
	return hostinfo.Memory{TotalMiB: total, AvailableMiB: total - 4*gib}
}

func on() Settings { return Settings{Enabled: true} }

func TestDefaults(t *testing.T) {
	p := New(on(), capacity, reserve, 1.5)
	s := p.Settings()
	if s.MaxRatio != 2.5 || s.HeadroomMiB != 1024 || s.HeadroomPercent != 25 || s.PeakWindowMinutes != 10 || s.StartMiB != 1024 {
		t.Fatalf("defaults %+v", s)
	}
	if !s.Reclaims() || !s.OutOfMemoryKills() {
		t.Fatal("reclaim and the out-of-memory step are on by default with over-commit")
	}
	if (Settings{}).Reclaims() || (Settings{}).OutOfMemoryKills() {
		t.Fatal("the guard is off with over-commit off")
	}
	no := false
	if (Settings{Enabled: true, Reclaim: &no}).Reclaims() {
		t.Fatal("reclaim: false")
	}
}

// A VM counts as its recent peak plus headroom, never more than its size; before it is measured, StartMiB plus
// headroom; a template build in full.
func TestCommit(t *testing.T) {
	p := New(on(), capacity, reserve, 1.5)
	if got := p.commitLocked(VM{ID: "a", SizeMiB: check}); got != 1024+8*gib {
		t.Fatalf("unmeasured 32 GiB VM counts %d", got)
	}
	if got := p.commitLocked(VM{ID: "b", SizeMiB: 2 * gib}); got != 2*gib {
		t.Fatalf("unmeasured 2 GiB VM counts %d, not its size", got)
	}
	if got := p.commitLocked(VM{SizeMiB: 4 * gib, Full: true}); got != 4*gib {
		t.Fatalf("a build counts %d", got)
	}
	// Peak 12 GiB a minute ago, 3 GiB now: the peak counts.
	p.Observe(t0, []Reading{{ID: "a", UsedMiB: 12 * gib, RSSMiB: 13 * gib, Guest: true}}, idle(125*gib))
	p.Observe(t0.Add(time.Minute), []Reading{{ID: "a", UsedMiB: 3 * gib, RSSMiB: 13 * gib, Guest: true}}, idle(125*gib))
	if got := p.commitLocked(VM{ID: "a", SizeMiB: check}); got != 12*gib+8*gib {
		t.Fatalf("after a 12 GiB peak: %d", got)
	}
	// Past the window the peak is forgotten.
	p.Observe(t0.Add(11*time.Minute), []Reading{{ID: "a", UsedMiB: 3 * gib, RSSMiB: 4 * gib, Guest: true}}, idle(125*gib))
	if got := p.commitLocked(VM{ID: "a", SizeMiB: check}); got != 3*gib+8*gib {
		t.Fatalf("after the window: %d", got)
	}
	// Near its size: capped.
	p.Observe(t0.Add(12*time.Minute), []Reading{{ID: "a", UsedMiB: 30 * gib, RSSMiB: 30 * gib, Guest: true}}, idle(125*gib))
	if got := p.commitLocked(VM{ID: "a", SizeMiB: check}); got != check {
		t.Fatalf("at 30 of 32 GiB: %d", got)
	}
}

// Idle 32 GiB check VMs (2-4 GiB used, more resident in page cache): reservations allowed 5 (1.5x), use allows up to
// the 2.5x cap, 8.
func TestChecksFitByUse(t *testing.T) {
	p := New(on(), capacity, reserve, 1.5)
	var vms []VM
	var readings []Reading
	for i := 0; ; i++ {
		id := string(rune('a' + i))
		vm := VM{ID: id, SizeMiB: check}
		if err := p.Check(vm, vms, 0); err != nil {
			if !strings.Contains(err.Error(), "cap") {
				t.Fatalf("refused for %v, not the cap", err)
			}
			break
		}
		vms = append(vms, vm)
		readings = append(readings, Reading{ID: id, UsedMiB: 3 * gib, RSSMiB: 6 * gib, Guest: true})
		used := int64(len(readings)) * 6 * gib
		p.Observe(t0.Add(time.Duration(i)*time.Minute), readings, hostinfo.Memory{TotalMiB: 125 * gib, AvailableMiB: 125*gib - 2*gib - used})
	}
	if len(vms) != 8 {
		t.Fatalf("%d checks VMs fit, want 8 (the 2.5x cap)", len(vms))
	}
	if free, want := p.Free(vms, 0), int64(2.5*float64(capacity))-8*check; free != want {
		t.Fatalf("free %d, want what the cap leaves (%d)", free, want)
	}
	r := p.Report(vms, 0)
	if r.Mode != proto.MemoryModeUsed || r.ReservedMiB != 8*check || r.CommittedMiB != 8*(3*gib+8*gib) ||
		r.GuestUsedMiB != 8*3*gib || r.ResidentMiB != 8*6*gib || r.State != "ok" || r.MaxRatio != 2.5 || r.CapacityMiB != capacity {
		t.Fatalf("report %+v", r)
	}
}

// A higher cap lets committed memory decide: ten idle checks VMs count 110 GiB of the 110.8.
func TestCommittedDecidesUnderAHighCap(t *testing.T) {
	p := New(Settings{Enabled: true, MaxRatio: 4}, capacity, reserve, 1.5)
	var vms []VM
	var readings []Reading
	for i := 0; i < 20; i++ {
		id := string(rune('a' + i))
		vm := VM{ID: id, SizeMiB: check}
		if err := p.Check(vm, vms, 0); err != nil {
			if !strings.Contains(err.Error(), "committed") {
				t.Fatalf("refused for %v", err)
			}
			break
		}
		vms = append(vms, vm)
		readings = append(readings, Reading{ID: id, UsedMiB: 3 * gib, RSSMiB: 4 * gib, Guest: true})
		p.Observe(t0.Add(time.Duration(i)*time.Minute), readings, hostinfo.Memory{TotalMiB: 125 * gib, AvailableMiB: 120 * gib})
	}
	if len(vms) != 10 {
		t.Fatalf("%d fit, want 10", len(vms))
	}
}

// Room on the machine: a host whose own processes use most of its memory takes nothing, whatever the VMs count.
func TestRoomOnTheMachine(t *testing.T) {
	p := New(on(), capacity, reserve, 1.5)
	p.Observe(t0, nil, hostinfo.Memory{TotalMiB: 125 * gib, AvailableMiB: reserve + 5*gib})
	err := p.Check(VM{ID: "a", SizeMiB: check}, nil, 0)
	if err == nil || !strings.Contains(err.Error(), "available") {
		t.Fatalf("admitted a 32 GiB VM (counting 9 GiB) with 5 GiB beyond the reserve: %v", err)
	}
	// The largest that counts as at most 5 GiB: about 16 GiB (1 + 4).
	if free := p.Free(nil, 0); free < 16*gib || p.startCommit(free) > 5*gib || p.startCommit(free+1) <= 5*gib {
		t.Fatalf("free %d", free)
	}
	// A small one still fits.
	if err := p.Check(VM{ID: "b", SizeMiB: 4 * gib}, nil, 0); err != nil {
		t.Fatal(err)
	}
	// Headroom owed: a VM admitted but not measured holds its whole count against the room.
	p.Observe(t0, nil, hostinfo.Memory{TotalMiB: 125 * gib, AvailableMiB: reserve + 12*gib})
	if err := p.Check(VM{ID: "c", SizeMiB: check}, []VM{{ID: "d", SizeMiB: check}}, 0); err == nil {
		t.Fatal("admitted a second 32 GiB VM into room for one")
	}
}

func TestLevels(t *testing.T) {
	cases := []struct {
		name string
		host hostinfo.Memory
		want Level
	}{
		{"plenty", hostinfo.Memory{AvailableMiB: 60 * gib}, LevelOK},
		{"under twice the reserve", hostinfo.Memory{AvailableMiB: 2*reserve - 1}, LevelTight},
		{"some pressure", hostinfo.Memory{AvailableMiB: 60 * gib, PressureSome: 6}, LevelTight},
		{"under the reserve", hostinfo.Memory{AvailableMiB: reserve - 1}, LevelRefusing},
		{"real pressure", hostinfo.Memory{AvailableMiB: 60 * gib, PressureSome: 25}, LevelRefusing},
		{"under half the reserve", hostinfo.Memory{AvailableMiB: reserve/2 - 1}, LevelCritical},
		{"stalled", hostinfo.Memory{AvailableMiB: 60 * gib, PressureFull: 30}, LevelCritical},
	}
	for _, c := range cases {
		p := New(on(), capacity, reserve, 1.5)
		p.Observe(t0, nil, c.host)
		if got, _ := p.Level(); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	// Unread, it is ok.
	if got, _ := New(on(), capacity, reserve, 1.5).Level(); got != LevelOK {
		t.Fatal(got)
	}
}

// Critical readings in a row are counted; refusing refuses creates and reports nothing free.
func TestCriticalRunAndRefusal(t *testing.T) {
	p := New(on(), capacity, reserve, 1.5)
	low := hostinfo.Memory{AvailableMiB: 1 * gib}
	p.Observe(t0, nil, low)
	p.Observe(t0.Add(5*time.Second), nil, low)
	if level, run := p.Level(); level != LevelCritical || run != 2 {
		t.Fatalf("%v %d", level, run)
	}
	if err := p.Check(VM{ID: "a", SizeMiB: gib}, nil, 0); err == nil || !strings.Contains(err.Error(), "short of memory") {
		t.Fatalf("admitted while critical: %v", err)
	}
	if p.Free(nil, 0) != 0 {
		t.Fatal("free while critical")
	}
	p.Observe(t0.Add(10*time.Second), nil, idle(125*gib))
	if level, run := p.Level(); level != LevelOK || run != 0 {
		t.Fatalf("after: %v %d", level, run)
	}
}

// The machine's memory alone, read between the VMs' readings, moves the level and keeps the VMs' readings.
func TestObserveHost(t *testing.T) {
	p := New(on(), capacity, reserve, 1.5)
	p.Observe(t0, []Reading{{ID: "a", UsedMiB: gib, RSSMiB: 2 * gib, Guest: true}}, idle(125*gib))
	p.ObserveHost(t0.Add(time.Second), hostinfo.Memory{AvailableMiB: 1 * gib})
	p.ObserveHost(t0.Add(2*time.Second), hostinfo.Memory{AvailableMiB: 1 * gib})
	if level, run := p.Level(); level != LevelCritical || run != 2 {
		t.Fatalf("%v %d", level, run)
	}
	if got := p.Readings(); len(got) != 1 || got[0].ID != "a" {
		t.Fatalf("readings %+v", got)
	}
	if r := p.Report([]VM{{ID: "a", SizeMiB: 4 * gib}}, 0); r.ResidentMiB != 2*gib || r.AvailableMiB != gib || r.State != "critical" {
		t.Fatalf("report %+v", r)
	}
}

// The VMs' group at or near its memory.max is critical, whatever the machine has available.
func TestGroupLimitIsCritical(t *testing.T) {
	p := New(on(), capacity, reserve, 1.5)
	far := hostinfo.Memory{AvailableMiB: 125 * gib, GroupMaxMiB: 120 * gib, GroupHeadroomMiB: 20 * gib, GroupLimitHits: 40}
	p.ObserveHost(t0, far)
	if level, _ := p.Level(); level != LevelOK {
		t.Fatalf("first reading: %v", level)
	}
	hit := far
	hit.GroupLimitHits = 41
	p.ObserveHost(t0.Add(time.Second), hit)
	if level, _ := p.Level(); level != LevelCritical {
		t.Fatalf("reached its limit: %v", level)
	}
	p.ObserveHost(t0.Add(2*time.Second), hit)
	if level, _ := p.Level(); level != LevelOK {
		t.Fatalf("no longer: %v", level)
	}
	near := hit
	near.GroupHeadroomMiB = reserve/4 - 1
	p.ObserveHost(t0.Add(3*time.Second), near)
	if level, _ := p.Level(); level != LevelCritical {
		t.Fatalf("near its limit: %v", level)
	}
}

// The host swapping is refusing, though its swap in use alone (a big, steady figure) isn't.
func TestSwapping(t *testing.T) {
	p := New(on(), capacity, reserve, 1.5)
	steady := hostinfo.Memory{AvailableMiB: 100 * gib, SwapUsedMiB: 9 * gib, SwapOutPages: 1_000_000}
	p.Observe(t0, nil, steady)
	p.Observe(t0.Add(30*time.Second), nil, steady)
	if level, _ := p.Level(); level != LevelOK {
		t.Fatalf("steady swap: %v", level)
	}
	swapping := steady
	swapping.SwapOutPages += 512 << 8 // 512 MiB of 4 KiB pages
	p.Observe(t0.Add(40*time.Second), nil, swapping)
	if level, _ := p.Level(); level != LevelRefusing {
		t.Fatalf("swapping: %v", level)
	}
	// A minute later, no more swapping.
	p.Observe(t0.Add(2*time.Minute), nil, swapping)
	p.Observe(t0.Add(2*time.Minute+5*time.Second), nil, swapping)
	if level, _ := p.Level(); level != LevelOK {
		t.Fatalf("after: %v", level)
	}
	// In a limited group, the group's swap in use is what grows.
	g := New(on(), capacity, reserve, 1.5)
	g.Observe(t0, nil, hostinfo.Memory{AvailableMiB: 100 * gib, Limited: true, SwapUsedMiB: 0})
	g.Observe(t0.Add(5*time.Second), nil, hostinfo.Memory{AvailableMiB: 100 * gib, Limited: true, SwapUsedMiB: 300})
	if level, _ := g.Level(); level != LevelRefusing {
		t.Fatalf("group swapping: %v", level)
	}
}

// Off, the report says so and keeps the reservation ratio; the readings are the last observation's, the most resident
// first.
func TestReportOffAndReadings(t *testing.T) {
	p := New(Settings{}, capacity, reserve, 1.5)
	p.Observe(t0, []Reading{{ID: "a", UsedMiB: 1 * gib, RSSMiB: 2 * gib}, {ID: "b", UsedMiB: 1 * gib, RSSMiB: 5 * gib}}, idle(125*gib))
	p.Observe(t0.Add(5*time.Second), []Reading{{ID: "a", UsedMiB: 1 * gib, RSSMiB: 2 * gib}, {ID: "c", UsedMiB: 1 * gib, RSSMiB: 9 * gib}}, idle(125*gib))
	r := p.Report([]VM{{ID: "a", SizeMiB: 4 * gib}, {ID: "x", SizeMiB: 2 * gib}}, 512)
	if r.Mode != proto.MemoryModeReserved || r.MaxRatio != 1.5 || r.ReservedMiB != 6*gib+512 || r.TotalMiB != 125*gib ||
		r.AvailableMiB != 121*gib || r.MeasuredAt != t0.Add(5*time.Second).UnixMilli() || r.ResidentMiB != 2*gib {
		t.Fatalf("report %+v", r)
	}
	got := p.Readings()
	if len(got) != 2 || got[0].ID != "c" || got[1].ID != "a" {
		t.Fatalf("readings %+v", got)
	}
}
