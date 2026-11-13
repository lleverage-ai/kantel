// Package memplan is the host's account of its microVMs' memory: what they were given (reserved), what they use and
// may soon use (committed), and how much memory the machine has left (available, pressure, swap). Every host reports
// it (proto.MemoryReport). With memory over-commit on (Settings.Enabled, experimental), it also admits microVMs by what
// they use rather than by what they were given, and says how short of memory the host is (Level), which the host's
// guard acts on: reclaim through the VMs' balloons, then refuse creates, then have the biggest VM's guest kill its
// largest process.
//
// # Committed memory
//
// A running VM of size S counts as min(S, peak + headroom(S)), where peak is the most its guest has used (MemTotal -
// MemAvailable, from its balloon's statistics; its resident memory when it can't say) in the last PeakWindowMinutes,
// and headroom(S) = max(HeadroomMiB, S * HeadroomPercent / 100). A VM not measured yet counts as StartMiB plus its
// headroom. A template build counts in full. The host's committed memory is the sum.
//
// # Admission (on)
//
// A microVM of size S is admitted when all of these hold:
//   - the host isn't refusing (Level below LevelRefusing);
//   - what sandboxes are given, with it, is at most MaxRatio times the host's memory less its reserve (the cap);
//   - committed memory, with it counted as unmeasured, is at most the host's memory less its reserve;
//   - the machine's available memory, less the reserve and less the headroom the running VMs haven't taken up yet
//     (their committed memory beyond what they hold now), still covers it.
//
// Off, the host admits by what sandboxes are given against overcommitMemory times its memory, as before, and only
// reports the rest.
package memplan

import (
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/hostinfo"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Settings are config.json's memoryOvercommit.
type Settings struct {
	// Enabled admits microVMs by the memory they use and turns the guard on: free page reporting in new VMs' balloons,
	// reclaim, refusing creates under pressure, and the out-of-memory step. Experimental, default off.
	Enabled bool `json:"enabled,omitempty"`
	// MaxRatio caps what sandboxes are given, as a multiple of the host's memory less its reserve (default 2.5):
	// a backstop for when every VM peaks at once, beyond what committed memory and the machine's own room allow.
	MaxRatio float64 `json:"maxRatio,omitempty"`
	// HeadroomMiB and HeadroomPercent are the room kept for each VM above its recent peak: the more of HeadroomMiB
	// (default 1024) and HeadroomPercent of its size (default 25).
	HeadroomMiB     int64   `json:"headroomMiB,omitempty"`
	HeadroomPercent float64 `json:"headroomPercent,omitempty"`
	// PeakWindowMinutes is how far back a VM's peak is taken from (default 10).
	PeakWindowMinutes int `json:"peakWindowMinutes,omitempty"`
	// StartMiB is what a VM is taken to use before it is first measured (default 1024).
	StartMiB int64 `json:"startMiB,omitempty"`
	// Reclaim (default true) lets the guard take page cache back from VMs through their balloons when memory is tight.
	Reclaim *bool `json:"reclaim,omitempty"`
	// OutOfMemory (default true) lets the guard, when the host is critically short of memory, have the guest of the VM
	// using the most memory kill its largest process, and stop that VM if that doesn't free enough.
	OutOfMemory *bool `json:"outOfMemory,omitempty"`
}

// Defaults fills what isn't set.
func (s *Settings) Defaults() {
	if s.MaxRatio <= 0 {
		s.MaxRatio = 2.5
	}
	if s.HeadroomMiB <= 0 {
		s.HeadroomMiB = 1024
	}
	if s.HeadroomPercent <= 0 {
		s.HeadroomPercent = 25
	}
	if s.PeakWindowMinutes <= 0 {
		s.PeakWindowMinutes = 10
	}
	if s.StartMiB <= 0 {
		s.StartMiB = 1024
	}
}

// Reclaims says whether the guard reclaims through balloons (on, and Reclaim not false).
func (s Settings) Reclaims() bool { return s.Enabled && (s.Reclaim == nil || *s.Reclaim) }

// OutOfMemoryKills says whether the guard's out-of-memory step is on.
func (s Settings) OutOfMemoryKills() bool {
	return s.Enabled && (s.OutOfMemory == nil || *s.OutOfMemory)
}

// Level is how short of memory the host is.
type Level int

const (
	// LevelOK: plenty available.
	LevelOK Level = iota
	// LevelTight: less than twice the reserve available, or some memory pressure: the guard reclaims page cache.
	LevelTight
	// LevelRefusing: less than the reserve available, real pressure, or the host swapping: creates are refused too.
	LevelRefusing
	// LevelCritical: less than half the reserve available, tasks stalled on memory much of the time, or the VMs' group
	// at or near its limit with little page cache left to drop: the guard ends the biggest VM's largest process.
	LevelCritical
)

func (l Level) String() string {
	switch l {
	case LevelTight:
		return "tight"
	case LevelRefusing:
		return "refusing"
	case LevelCritical:
		return "critical"
	default:
		return "ok"
	}
}

// The pressure thresholds, PSI avg10 in percent, and the swap growth that counts as swapping.
const (
	tightPressureSome    = 5
	refusingPressureSome = 20
	criticalPressureFull = 20
	swappingMiB          = 256
	swapWindow           = time.Minute
	pageKiB              = 4
)

// VM is a microVM holding memory on the host: running, starting or resuming, or a template build.
type VM struct {
	// ID is the sandbox's; empty for a template build.
	ID      string
	SizeMiB int64
	// Full counts it at its size whatever it uses (a template build).
	Full bool
}

// Reading is one VM's memory as the host's usage sample measured it.
type Reading struct {
	ID string
	// UsedMiB is what its guest uses (or its resident memory when the guest can't say, Guest false); RSSMiB its
	// Firecracker's resident memory: what it holds of the host's memory, page cache and all.
	UsedMiB int64
	RSSMiB  int64
	Guest   bool
	Pid     int
	SizeMiB int64
	// Held is a VM the sample couldn't read (an operation holds it): it keeps its last reading, still a candidate for
	// the guard, and adds no point to its peak.
	Held bool
}

type point struct {
	at   time.Time
	used int64
}

type history struct {
	points []point
	last   Reading
	seen   time.Time
}

type swapPoint struct {
	at  time.Time
	mib int64
}

// Plan keeps the readings and answers for admission and the report. Safe for concurrent use.
type Plan struct {
	settings Settings
	// reserveMiB is kept for the host itself; capacityMiB is the memory sandboxes may use, the host's less the reserve.
	reserveMiB  int64
	capacityMiB int64
	// overcommit is the reservation ratio used when over-commit is off (overcommitMemory).
	overcommit float64

	mu     sync.Mutex
	vms    map[string]*history
	host   hostinfo.Memory
	hostAt time.Time
	// vmsAt is the last observation with the VMs' readings (Observe); ObserveHost reads only the machine, more often.
	vmsAt time.Time
	swap  []swapPoint
	// limitHits is the last count of the times the VMs' group reached its memory.max (hostinfo.Memory.GroupLimitHits),
	// and atLimit whether it rose at the last observation.
	limitHits int64
	limitSeen time.Time
	atLimit   bool
	level     Level
	critical  int
}

// New makes a plan for a host with capacityMiB for sandboxes, reserveMiB kept back, and overcommit the reservation
// ratio when over-commit is off.
func New(settings Settings, capacityMiB, reserveMiB int64, overcommit float64) *Plan {
	settings.Defaults()
	return &Plan{settings: settings, capacityMiB: capacityMiB, reserveMiB: reserveMiB, overcommit: overcommit, vms: map[string]*history{}}
}

// Settings are the plan's, defaults filled.
func (p *Plan) Settings() Settings { return p.settings }

// ReserveMiB is the memory kept for the host itself.
func (p *Plan) ReserveMiB() int64 { return p.reserveMiB }

func (p *Plan) window() time.Duration {
	return time.Duration(p.settings.PeakWindowMinutes) * time.Minute
}

// Observe takes a usage sample's readings of the running VMs and the host's memory, at the time they were taken.
func (p *Plan) Observe(at time.Time, readings []Reading, host hostinfo.Memory) {
	p.mu.Lock()
	defer p.mu.Unlock()
	cutoff := at.Add(-p.window())
	for _, r := range readings {
		h := p.vms[r.ID]
		if r.Held {
			if h != nil && h.seen.Equal(p.vmsAt) {
				h.seen = at
			}
			continue
		}
		if h == nil {
			h = &history{}
			p.vms[r.ID] = h
		}
		h.points = append(h.points, point{at: at, used: r.UsedMiB})
		h.last, h.seen = r, at
	}
	for id, h := range p.vms {
		// A VM keeps its peak through a stop and resume within the window; one gone longer is forgotten.
		if h.seen.Before(cutoff) {
			delete(p.vms, id)
			continue
		}
		drop := 0
		for drop < len(h.points) && h.points[drop].at.Before(cutoff) {
			drop++
		}
		h.points = slices.Delete(h.points, 0, drop)
	}
	p.vmsAt = at
	p.observeHostLocked(at, host)
}

// ObserveHost takes the machine's memory alone, between the VMs' readings, so the host's level follows a fast spike.
func (p *Plan) ObserveHost(at time.Time, host hostinfo.Memory) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.observeHostLocked(at, host)
}

func (p *Plan) observeHostLocked(at time.Time, host hostinfo.Memory) {
	p.host, p.hostAt = host, at
	swapped := host.SwapUsedMiB
	if !host.Limited {
		swapped = host.SwapOutPages * pageKiB / 1024
	}
	p.swap = append(p.swap, swapPoint{at: at, mib: swapped})
	drop := 0
	for drop < len(p.swap)-1 && p.swap[drop].at.Before(at.Add(-swapWindow)) {
		drop++
	}
	p.swap = slices.Delete(p.swap, 0, drop)
	// At its limit since the last reading: the VMs' group reached its memory.max with less than half the reserve of
	// page cache left to drop. The kernel counts every charge that meets the limit, before it reclaims, so a group full
	// of cache counts one for each write through it while dropping that cache holds it; only with little left is a VM
	// what it ends next.
	p.atLimit = !p.limitSeen.IsZero() && host.GroupLimitHits > p.limitHits && host.GroupCacheMiB < p.reserveMiB/2
	p.limitHits, p.limitSeen = host.GroupLimitHits, at
	p.level = p.levelLocked()
	if p.level == LevelCritical {
		p.critical++
	} else {
		p.critical = 0
	}
}

// Forget drops a VM's history (deleted).
func (p *Plan) Forget(id string) {
	p.mu.Lock()
	delete(p.vms, id)
	p.mu.Unlock()
}

// The readings that make the host critical, named as the guard's log names its figures.
const (
	WhyAvailable     = "available"
	WhyPressure      = "pressureFull"
	WhyAtLimit       = "atLimit"
	WhyGroupHeadroom = "groupHeadroom"
)

// criticalLocked is why the host is critical at the last observation: none when it isn't.
//
// The VMs' group is critical within a quarter of the reserve of its limit, its page cache the kernel can drop counted
// as room. At the limit the kernel drops that cache to hold a spike, so counting it doesn't hide one: what a spike
// takes is the VMs' own memory, which can't be dropped, and the headroom with the cache shrinks by every MiB of it,
// whichever the kernel gives up to make room. It is what the kernel has left before it ends a VM, so the guard still
// acts a quarter of the reserve before that. Cache the VMs need back as soon as it is dropped (their disks' working
// set) makes the kernel stall them while it reclaims and reads it again, which is memory pressure, critical on its
// own. Cache counted as used instead keeps a group critical whenever it has read or written as much as its limit.
func (p *Plan) criticalLocked() []string {
	h, r := p.host, p.reserveMiB
	var why []string
	if h.AvailableMiB < r/2 {
		why = append(why, WhyAvailable)
	}
	if h.PressureFull >= criticalPressureFull {
		why = append(why, WhyPressure)
	}
	if p.atLimit {
		why = append(why, WhyAtLimit)
	}
	if h.GroupMaxMiB > 0 && h.GroupHeadroomMiB+h.GroupCacheMiB < r/4 {
		why = append(why, WhyGroupHeadroom)
	}
	return why
}

func (p *Plan) levelLocked() Level {
	if p.hostAt.IsZero() {
		return LevelOK
	}
	h, r := p.host, p.reserveMiB
	swapping := len(p.swap) > 1 && p.swap[len(p.swap)-1].mib-p.swap[0].mib >= swappingMiB
	switch {
	case len(p.criticalLocked()) > 0:
		return LevelCritical
	case h.AvailableMiB < r || h.PressureSome >= refusingPressureSome || swapping:
		return LevelRefusing
	case h.AvailableMiB < 2*r || h.PressureSome >= tightPressureSome:
		return LevelTight
	}
	return LevelOK
}

// Level is how short of memory the host was at the last observation, and for how many observations in a row it has
// been critical.
func (p *Plan) Level() (Level, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.level, p.critical
}

// Shortage is the reading behind the host's level at the last observation, for the guard's log: why it is critical
// (the Why names; none when it isn't) and the figures that decide it.
type Shortage struct {
	Why              []string
	AvailableMiB     int64
	ReserveMiB       int64
	PressureFull     float64
	GroupMaxMiB      int64
	GroupHeadroomMiB int64
	GroupCacheMiB    int64
	GroupLimitHits   int64
}

// Shortage is why the host is critical at the last observation, with its figures.
func (p *Plan) Shortage() Shortage {
	p.mu.Lock()
	defer p.mu.Unlock()
	h := p.host
	s := Shortage{AvailableMiB: h.AvailableMiB, ReserveMiB: p.reserveMiB, PressureFull: h.PressureFull,
		GroupMaxMiB: h.GroupMaxMiB, GroupHeadroomMiB: h.GroupHeadroomMiB, GroupCacheMiB: h.GroupCacheMiB,
		GroupLimitHits: h.GroupLimitHits}
	if !p.hostAt.IsZero() {
		s.Why = p.criticalLocked()
	}
	return s
}

// AtLimit says whether the VMs' control group reached its memory.max since the observation before the last with little
// page cache left to drop: the kernel is reclaiming from it, and ends a VM next.
func (p *Plan) AtLimit() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.atLimit
}

// Readings are the VMs' last readings, those seen at the last observation, the most resident first.
func (p *Plan) Readings() []Reading {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []Reading
	for _, h := range p.vms {
		if h.seen.Equal(p.vmsAt) {
			out = append(out, h.last)
		}
	}
	slices.SortFunc(out, func(a, b Reading) int {
		if a.RSSMiB != b.RSSMiB {
			return int(b.RSSMiB - a.RSSMiB)
		}
		if a.ID < b.ID {
			return -1
		}
		return 1
	})
	return out
}

// headroom is the room kept above a VM's peak.
func (p *Plan) headroom(sizeMiB int64) int64 {
	return min(sizeMiB, max(p.settings.HeadroomMiB, int64(float64(sizeMiB)*p.settings.HeadroomPercent/100)))
}

// startCommit is what a VM of size counts as before it is measured.
func (p *Plan) startCommit(sizeMiB int64) int64 {
	return min(sizeMiB, p.settings.StartMiB+p.headroom(sizeMiB))
}

// commitLocked is what vm counts as now.
func (p *Plan) commitLocked(vm VM) int64 {
	if vm.Full {
		return vm.SizeMiB
	}
	h := p.vms[vm.ID]
	if vm.ID == "" || h == nil || len(h.points) == 0 {
		return p.startCommit(vm.SizeMiB)
	}
	var peak int64
	for _, pt := range h.points {
		peak = max(peak, pt.used)
	}
	return min(vm.SizeMiB, peak+p.headroom(vm.SizeMiB))
}

// owedLocked is the headroom the VMs haven't taken up: what each counts as beyond what it holds now (none for a VM
// not measured yet, which holds nothing of its count).
func (p *Plan) owedLocked(vms []VM) int64 {
	var owed int64
	for _, vm := range vms {
		held := int64(0)
		if h := p.vms[vm.ID]; vm.ID != "" && h != nil && h.seen.Equal(p.vmsAt) {
			held = h.last.RSSMiB
		}
		owed += max(0, p.commitLocked(vm)-held)
	}
	return owed
}

// totals are the reserved and committed memory of vms plus otherMiB, the other tiers' (counted in full).
func (p *Plan) totalsLocked(vms []VM, otherMiB int64) (reserved, committed int64) {
	reserved, committed = otherMiB, otherMiB
	for _, vm := range vms {
		reserved += vm.SizeMiB
		committed += p.commitLocked(vm)
	}
	return reserved, committed
}

// Check says whether a microVM of size may start beside vms (what the tier holds) and otherMiB (what the other tiers
// hold), with over-commit on: nil, or why not. vm.ID is the sandbox's, whose earlier peak (a resume) counts.
func (p *Plan) Check(vm VM, vms []VM, otherMiB int64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.level >= LevelRefusing {
		return fmt.Errorf("this host is short of memory now (%d MiB available, %d MiB kept for the host)", p.host.AvailableMiB, p.reserveMiB)
	}
	reserved, committed := p.totalsLocked(vms, otherMiB)
	capRatio := int64(p.settings.MaxRatio * float64(p.capacityMiB))
	if reserved+vm.SizeMiB > capRatio {
		return fmt.Errorf("this host's sandboxes have %d MiB, and a %d MiB one would take them past its cap of %d MiB (memoryOvercommit.maxRatio %.2g)", reserved, vm.SizeMiB, capRatio, p.settings.MaxRatio)
	}
	need := p.commitLocked(vm)
	if committed+need > p.capacityMiB {
		return fmt.Errorf("this host has %d MiB of its %d MiB committed, and a %d MiB sandbox counts as %d MiB", committed, p.capacityMiB, vm.SizeMiB, need)
	}
	if room := p.roomLocked(vms); room < need {
		return fmt.Errorf("this host has %d MiB available beyond its reserve and the headroom its sandboxes may still take, and a %d MiB sandbox counts as %d MiB", max(0, room), vm.SizeMiB, need)
	}
	return nil
}

// roomLocked is what the machine has available now beyond the reserve and the headroom the VMs may still take; the
// most there is when the host hasn't been read yet.
func (p *Plan) roomLocked(vms []VM) int64 {
	if p.hostAt.IsZero() {
		return p.capacityMiB
	}
	return p.host.AvailableMiB - p.reserveMiB - p.owedLocked(vms)
}

// Free is the largest microVM, in MiB of its size, the host would admit now with over-commit on (what the capacity
// report says is free, which the control plane places against).
func (p *Plan) Free(vms []VM, otherMiB int64) int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	byRatio, room := p.spareLocked(vms, otherMiB)
	if byRatio <= 0 || room <= 0 {
		return 0
	}
	// startCommit grows with size: the largest size whose count fits the room, at most byRatio.
	lo, hi := int64(0), byRatio
	for lo < hi {
		mid := lo + (hi-lo+1)/2
		if p.startCommit(mid) <= room {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return lo
}

// spareLocked is what reservations may still grow by (byRatio) and what committed memory may (room), with over-commit
// on; none while refusing.
func (p *Plan) spareLocked(vms []VM, otherMiB int64) (byRatio, room int64) {
	if p.level >= LevelRefusing {
		return 0, 0
	}
	reserved, committed := p.totalsLocked(vms, otherMiB)
	byRatio = int64(p.settings.MaxRatio*float64(p.capacityMiB)) - reserved
	room = min(p.capacityMiB-committed, p.roomLocked(vms))
	return byRatio, room
}

// Report is the host's memory for its capacity report: vms (what the microVM tier holds) and otherMiB (the other
// tiers), with what the machine has now.
func (p *Plan) Report(vms []VM, otherMiB int64) proto.MemoryReport {
	p.mu.Lock()
	defer p.mu.Unlock()
	reserved, committed := p.totalsLocked(vms, otherMiB)
	r := proto.MemoryReport{
		Mode:         proto.MemoryModeReserved,
		CapacityMiB:  p.capacityMiB,
		ReserveMiB:   p.reserveMiB,
		ReservedMiB:  reserved,
		CommittedMiB: committed,
		MaxRatio:     p.overcommit,
		State:        p.level.String(),
	}
	if p.settings.Enabled {
		r.Mode, r.MaxRatio = proto.MemoryModeUsed, p.settings.MaxRatio
		byRatio, room := p.spareLocked(vms, otherMiB)
		r.Admission = &proto.MemoryAdmission{
			ReservableMiB:   max(0, byRatio),
			CommittableMiB:  max(0, room),
			StartMiB:        p.settings.StartMiB,
			HeadroomMiB:     p.settings.HeadroomMiB,
			HeadroomPercent: p.settings.HeadroomPercent,
		}
	}
	for _, vm := range vms {
		if h := p.vms[vm.ID]; vm.ID != "" && h != nil && h.seen.Equal(p.vmsAt) {
			r.GuestUsedMiB += h.last.UsedMiB
			r.ResidentMiB += h.last.RSSMiB
		}
	}
	if !p.hostAt.IsZero() {
		r.TotalMiB = p.host.TotalMiB
		r.AvailableMiB = p.host.AvailableMiB
		r.SwapUsedMiB = p.host.SwapUsedMiB
		r.PressureSome, r.PressureFull = p.host.PressureSome, p.host.PressureFull
		r.MeasuredAt = p.hostAt.UnixMilli()
	}
	return r
}
