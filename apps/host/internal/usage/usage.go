// Package usage measures CPU and memory from the host's side, with nothing run inside a sandbox: the host's own from
// /proc/stat and /proc/meminfo, and a sandbox's from the process that runs it (its Firecracker, or the workerd or
// isolate VM its account's isolates run in), through /proc/<pid>/stat and /proc/<pid>/status.
//
// CPU is a counter, so a reading is only a figure once there is a second one: Counters keeps the last reading of each
// thing it is asked about and answers the difference, starting again when a counter goes backwards or its process
// changes, and forgetting what it wasn't asked about since.
package usage

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ClockTicks is USER_HZ, the unit of /proc/<pid>/stat's utime and stime: 100 on every Linux that kantel-host runs on
// (it is part of the kernel's user ABI, whatever CONFIG_HZ is).
const ClockTicks = 100

// Proc is where /proc is; tests point it at a fixture.
var Proc = "/proc"

// HostCPU is /proc/stat's aggregate line, in clock ticks: all of it, and the part spent idle (idle and iowait).
type HostCPU struct {
	Total uint64
	Idle  uint64
}

// ParseHostCPU reads the first `cpu ` line of /proc/stat.
func ParseHostCPU(r io.Reader) (HostCPU, error) {
	s := bufio.NewScanner(r)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 5 || fields[0] != "cpu" {
			continue
		}
		var v [8]uint64
		// user nice system idle iowait irq softirq steal; guest and guest_nice are counted in user and nice already.
		for i := 0; i < len(v) && i+1 < len(fields); i++ {
			n, err := strconv.ParseUint(fields[i+1], 10, 64)
			if err != nil {
				return HostCPU{}, fmt.Errorf("/proc/stat: %w", err)
			}
			v[i] = n
		}
		var c HostCPU
		for _, n := range v {
			c.Total += n
		}
		c.Idle = v[3] + v[4]
		return c, nil
	}
	if err := s.Err(); err != nil {
		return HostCPU{}, err
	}
	return HostCPU{}, errors.New("/proc/stat has no cpu line")
}

// ReadHostCPU reads /proc/stat.
func ReadHostCPU() (HostCPU, error) {
	f, err := os.Open(filepath.Join(Proc, "stat"))
	if err != nil {
		return HostCPU{}, err
	}
	defer f.Close()
	return ParseHostCPU(f)
}

// HostCPUBusy is the share of the host's CPU that was busy between two readings, 0 to 1. ok is false when there is
// no figure: the first reading, no time between them, or a counter that went backwards.
func HostCPUBusy(prev, cur HostCPU) (busy float64, ok bool) {
	if cur.Total <= prev.Total || cur.Idle < prev.Idle {
		return 0, false
	}
	total := cur.Total - prev.Total
	idle := cur.Idle - prev.Idle
	if idle > total {
		return 0, false
	}
	return clamp01(float64(total-idle) / float64(total)), true
}

// Memory is /proc/meminfo's MemTotal and MemAvailable, in bytes.
type Memory struct {
	Total     int64
	Available int64
}

// Used is what isn't available.
func (m Memory) Used() int64 { return max(0, m.Total-m.Available) }

// ParseMeminfo reads MemTotal and MemAvailable.
func ParseMeminfo(r io.Reader) (Memory, error) {
	var m Memory
	var total, avail bool
	s := bufio.NewScanner(r)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 2 {
			continue
		}
		kb, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			m.Total, total = kb*1024, true
		case "MemAvailable:":
			m.Available, avail = kb*1024, true
		}
	}
	if !total || !avail {
		return Memory{}, errors.New("/proc/meminfo has no MemTotal or MemAvailable")
	}
	return m, nil
}

// ReadMemory reads /proc/meminfo.
func ReadMemory() (Memory, error) {
	f, err := os.Open(filepath.Join(Proc, "meminfo"))
	if err != nil {
		return Memory{}, err
	}
	defer f.Close()
	return ParseMeminfo(f)
}

// Disk is the size of the filesystem holding a path and what of it is used, in bytes, as df counts them (used is
// what isn't free, the root-reserved blocks included).
type Disk struct {
	Total int64
	Used  int64
}

// ReadDisk is statfs of path.
func ReadDisk(path string) (Disk, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return Disk{}, err
	}
	bs := int64(st.Bsize)
	return Disk{Total: int64(st.Blocks) * bs, Used: int64(st.Blocks-st.Bfree) * bs}, nil
}

// ProcCPU is a process's CPU so far, all its threads: utime and stime in clock ticks, and when it started (clock
// ticks after boot), which tells a process from a later one with the same pid.
type ProcCPU struct {
	Ticks uint64
	Start uint64
}

// ParseProcStat reads /proc/<pid>/stat. The command name, field 2, is in parentheses and may hold spaces and
// parentheses itself, so the fields are counted from the last ')'.
func ParseProcStat(raw string) (ProcCPU, error) {
	end := strings.LastIndexByte(raw, ')')
	if end < 0 {
		return ProcCPU{}, errors.New("/proc/<pid>/stat: no command name")
	}
	// After the name: field 3 (state) onwards. utime and stime are fields 14 and 15, starttime 22.
	fields := strings.Fields(raw[end+1:])
	const utime, stime, start = 14 - 3, 15 - 3, 22 - 3
	if len(fields) <= start {
		return ProcCPU{}, fmt.Errorf("/proc/<pid>/stat: %d fields after the name", len(fields))
	}
	var v [3]uint64
	for i, at := range []int{utime, stime, start} {
		n, err := strconv.ParseUint(fields[at], 10, 64)
		if err != nil {
			return ProcCPU{}, fmt.Errorf("/proc/<pid>/stat: %w", err)
		}
		v[i] = n
	}
	return ProcCPU{Ticks: v[0] + v[1], Start: v[2]}, nil
}

// ReadProcCPU reads a process's /proc/<pid>/stat.
func ReadProcCPU(pid int) (ProcCPU, error) {
	if pid <= 0 {
		return ProcCPU{}, errors.New("no process")
	}
	raw, err := os.ReadFile(filepath.Join(Proc, strconv.Itoa(pid), "stat"))
	if err != nil {
		return ProcCPU{}, err
	}
	return ParseProcStat(string(raw))
}

// ParseRSS reads VmRSS from /proc/<pid>/status, in bytes: for a Firecracker process, the guest memory it has touched
// (anonymous and from a snapshot's memory file) and the VMM's own.
func ParseRSS(r io.Reader) (int64, error) {
	s := bufio.NewScanner(r)
	for s.Scan() {
		line := s.Text()
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			break
		}
		kb, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("VmRSS: %w", err)
		}
		return kb * 1024, nil
	}
	return 0, errors.New("/proc/<pid>/status has no VmRSS")
}

// ReadRSS reads a process's resident memory.
func ReadRSS(pid int) (int64, error) {
	if pid <= 0 {
		return 0, errors.New("no process")
	}
	f, err := os.Open(filepath.Join(Proc, strconv.Itoa(pid), "status"))
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return ParseRSS(f)
}

// Counters turns cumulative readings into differences. Each thing it follows is named by a key (a sandbox's ID, a
// runtime's) and tells its readings apart from another run's by an epoch (a process's pid and start time): a new
// epoch, or a counter that went backwards, starts the thing again, with no figure until its next reading.
type Counters struct {
	last map[string]reading
	seen map[string]bool
}

type reading struct {
	epoch string
	value float64
	at    time.Time
}

func NewCounters() *Counters {
	return &Counters{last: map[string]reading{}, seen: map[string]bool{}}
}

// Delta records value for key and answers how much it grew since key's last reading and in how long. ok is false
// for a first reading, a new epoch, a counter that went backwards (a reset) or no time between readings.
func (c *Counters) Delta(key, epoch string, value float64, at time.Time) (grew float64, over time.Duration, ok bool) {
	c.seen[key] = true
	prev, had := c.last[key]
	c.last[key] = reading{epoch: epoch, value: value, at: at}
	if !had || prev.epoch != epoch || value < prev.value || !at.After(prev.at) {
		return 0, 0, false
	}
	return value - prev.value, at.Sub(prev.at), true
}

// Sweep forgets every key not read since the last Sweep: sandboxes that went away, so one that comes back later with
// the same ID starts again rather than being measured across the gap.
func (c *Counters) Sweep() {
	for key := range c.last {
		if !c.seen[key] {
			delete(c.last, key)
		}
	}
	clear(c.seen)
}

// Len is how many things it follows.
func (c *Counters) Len() int { return len(c.last) }

// Epoch names a process's run: its pid and start time.
func (p ProcCPU) Epoch(pid int) string {
	return strconv.Itoa(pid) + "/" + strconv.FormatUint(p.Start, 10)
}

// Seconds is the CPU time in seconds.
func (p ProcCPU) Seconds() float64 { return float64(p.Ticks) / ClockTicks }

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// Utilisation is CPU seconds used over a wall-clock span on a given number of CPUs, 0 to 1.
func Utilisation(cpuSeconds float64, over time.Duration, cpus float64) float64 {
	if over <= 0 || cpus <= 0 {
		return 0
	}
	return clamp01(cpuSeconds / (over.Seconds() * cpus))
}
