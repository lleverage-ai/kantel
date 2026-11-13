package hostinfo

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Memory is the memory the host's sandboxes live in, as the kernel has it now, in MiB: the machine's, or, when
// kantel-host runs in a control group with a memory limit (a container, a systemd unit with MemoryMax), that group's,
// which is all its microVMs can have.
type Memory struct {
	// TotalMiB is the machine's memory, or the group's limit when that is less.
	TotalMiB int64
	// AvailableMiB is what can still be had without swapping: MemAvailable, or within a limited group its limit less
	// what it uses, the page cache it can drop counted as free (droppableCacheMiB), as MemAvailable counts the
	// machine's; never more than the machine's MemAvailable.
	AvailableMiB int64
	// SwapUsedMiB is the swap in use (the machine's, or the group's).
	SwapUsedMiB int64
	// SwapOutPages counts the pages written to swap since boot (/proc/vmstat pswpout): its growth is the host
	// swapping now, which a large but steady SwapUsedMiB isn't. Zero in a limited group, which keeps no such count.
	SwapOutPages int64
	// PressureSome and PressureFull are memory pressure (PSI) over the last 10 s, in percent: the share of time some,
	// or all, tasks were stalled waiting on memory. The group's own in a limited group.
	PressureSome float64
	PressureFull float64
	// Limited: the figures are a control group's, with its memory limit.
	Limited bool
	// GroupMaxMiB is the memory.max of kantel-host's own control group, which its microVMs run in (0: none),
	// GroupHeadroomMiB what the group can still take before it (memory.max less memory.current), and GroupCacheMiB the
	// page cache in the group the kernel can drop at the limit without loss (droppableCacheMiB). With no memory.high,
	// a group's page cache grows until the group sits at its limit, so its headroom alone is near nothing on a host that
	// has written a few disk images; what it can still take before the kernel ends a VM is both together.
	GroupMaxMiB      int64
	GroupHeadroomMiB int64
	GroupCacheMiB    int64
	// GroupLimitHits counts the times the group reached its memory.max (memory.events "max"), where the kernel
	// reclaims from it and, failing, ends its largest process: its growth is the group at its limit now.
	GroupLimitHits int64
}

// memoryPaths is where ReadMemory looks: the real /proc and /sys/fs/cgroup, or a test's copy of them.
type memoryPaths struct {
	proc   string
	cgroup string
	// confined records the memory.max ConfineMemory set on its own group, in bytes, so the limit isn't then read as the
	// machine's memory (in /run: it goes with the reboot that ends the limit).
	confined string
}

var defaultMemoryPaths = memoryPaths{proc: "/proc", cgroup: "/sys/fs/cgroup", confined: "/run/kantel-host/memory-max"}

// ReadMemory reads the host's memory now. A figure that can't be read is left zero.
func ReadMemory() Memory {
	return defaultMemoryPaths.read()
}

func (p memoryPaths) read() Memory {
	info := readKeyed(filepath.Join(p.proc, "meminfo"))
	m := Memory{
		TotalMiB:     info["MemTotal:"] / 1024,
		AvailableMiB: info["MemAvailable:"] / 1024,
		SwapUsedMiB:  max(0, info["SwapTotal:"]-info["SwapFree:"]) / 1024,
	}
	vmstat := readKeyed(filepath.Join(p.proc, "vmstat"))
	m.SwapOutPages = vmstat["pswpout"]
	m.PressureSome, m.PressureFull = readPressure(filepath.Join(p.proc, "pressure", "memory"))
	if own := p.ownGroup(); own != "" && own != "/" {
		dir := filepath.Join(p.cgroup, own)
		if raw, err := os.ReadFile(filepath.Join(dir, "memory.max")); err == nil {
			if limit, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64); err == nil && limit > 0 {
				m.GroupMaxMiB = limit >> 20
				m.GroupHeadroomMiB = max(0, limit-readNumber(filepath.Join(dir, "memory.current"))) >> 20
				m.GroupCacheMiB = droppableCacheMiB(readKeyed(filepath.Join(dir, "memory.stat")))
			}
		}
		m.GroupLimitHits = readKeyed(filepath.Join(dir, "memory.events"))["max"]
	}
	groups := p.limitedGroups()
	if len(groups) == 0 {
		return m
	}
	// Every limit above it bounds what it can still have: a larger one shared with siblings may have the least left.
	available := m.AvailableMiB
	for _, g := range groups {
		current := readNumber(filepath.Join(g.dir, "memory.current")) >> 20
		cache := droppableCacheMiB(readKeyed(filepath.Join(g.dir, "memory.stat")))
		available = min(available, max(0, g.limitMiB-current+cache), g.limitMiB)
	}
	// The smallest is its total, and has its swap and pressure.
	dir, limit := groups[0].dir, groups[0].limitMiB
	for _, g := range groups[1:] {
		if g.limitMiB < limit {
			dir, limit = g.dir, g.limitMiB
		}
	}
	if m.TotalMiB == 0 || limit < m.TotalMiB {
		m.Limited = true
		m.TotalMiB = limit
		m.AvailableMiB = available
		m.SwapUsedMiB = readNumber(filepath.Join(dir, "memory.swap.current")) >> 20
		m.SwapOutPages = 0
		m.PressureSome, m.PressureFull = readPressure(filepath.Join(dir, "memory.pressure"))
	} else {
		m.AvailableMiB = available
	}
	return m
}

// droppableCacheMiB is the page cache a group's memory.stat shows the kernel can drop at its limit without loss: the
// file pages on its reclaim lists (active_file and inactive_file, both: the kernel moves active pages to the inactive
// list as it reclaims, and with the multi-generational LRU the split is only the youngest generations), less those
// dirty or under writeback, which must reach the disk first. tmpfs and shared memory count in memory.stat's "file"
// but sit on the anonymous lists, as they can't be dropped, so they are not in it. Clean pages a process maps, such
// as a VM's memory restored from its snapshot file and not yet written, are: the kernel reads them back when touched.
func droppableCacheMiB(stat map[string]int64) int64 {
	return max(0, stat["active_file"]+stat["inactive_file"]-stat["file_dirty"]-stat["file_writeback"]) >> 20
}

// Confinement is what ConfineMemory found or set on kantel-host's own control group.
type Confinement struct {
	// Group is the group's directory under /sys/fs/cgroup; "" without one that has memory limits (cgroup v1, the root).
	Group string
	// MaxMiB is its memory.max now (0: none); SetMax says ConfineMemory set it.
	MaxMiB int64
	SetMax bool
	// SwapOff says its memory.swap.max is 0; SetSwap says ConfineMemory set it.
	SwapOff bool
	SetSwap bool
}

// ConfineMemory caps kantel-host's own control group (cgroup v2), which its microVMs run in, so that what they take
// can't push the machine's other processes into swap or out of memory: its memory.max to maxMiB unless it has a limit
// already (an operator's), and its memory.swap.max to 0 unless set. At memory.max the kernel reclaims the group's
// page cache, then ends its largest process, a VM's Firecracker (oom_score_adj 500), never one outside the group.
// No memory.high: its throttling would hold kantel-host, in the same group, as well as the VMs, and with it the
// guard that acts on the spike. systemd puts a unit's own values back when the unit restarts or is reloaded.
func ConfineMemory(maxMiB int64) (Confinement, error) {
	return defaultMemoryPaths.confine(maxMiB)
}

func (p memoryPaths) confine(maxMiB int64) (Confinement, error) {
	var c Confinement
	path := p.ownGroup()
	if path == "" || path == "/" {
		return c, nil
	}
	dir := filepath.Join(p.cgroup, path)
	maxFile, swapFile := filepath.Join(dir, "memory.max"), filepath.Join(dir, "memory.swap.max")
	current, err := os.ReadFile(maxFile)
	if err != nil {
		return c, nil
	}
	c.Group = dir
	if v := strings.TrimSpace(string(current)); v == "max" && maxMiB > 0 {
		value := []byte(strconv.FormatInt(maxMiB<<20, 10))
		if p.confined != "" {
			if err := os.MkdirAll(filepath.Dir(p.confined), 0o755); err != nil {
				return c, err
			}
			if err := os.WriteFile(p.confined, value, 0o644); err != nil {
				return c, err
			}
		}
		if err := os.WriteFile(maxFile, value, 0o644); err != nil {
			return c, err
		}
		c.MaxMiB, c.SetMax = maxMiB, true
	} else if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		c.MaxMiB = n >> 20
	}
	swap, err := os.ReadFile(swapFile)
	if err != nil {
		// No swap accounting: the kernel was booted without it, or there is no swap to account.
		return c, nil
	}
	switch strings.TrimSpace(string(swap)) {
	case "0":
		c.SwapOff = true
	case "max":
		if err := os.WriteFile(swapFile, []byte("0"), 0o644); err != nil {
			return c, err
		}
		c.SwapOff, c.SetSwap = true, true
	}
	return c, nil
}

// OOMKills counts the processes the kernel's out-of-memory killer ended in kantel-host's own control group at its
// memory limit (memory.events oom_kill); 0 outside one.
func OOMKills() int64 { return defaultMemoryPaths.oomKills() }

func (p memoryPaths) oomKills() int64 {
	own := p.ownGroup()
	if own == "" || own == "/" {
		return 0
	}
	return readKeyed(filepath.Join(p.cgroup, own, "memory.events"))["oom_kill"]
}

// ownGroup is this process's control group (cgroup v2), such as /system.slice/kantel-host.service; "" for none.
func (p memoryPaths) ownGroup() string {
	raw, err := os.ReadFile(filepath.Join(p.proc, "self", "cgroup"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if rest, ok := strings.CutPrefix(line, "0::"); ok {
			return filepath.Clean("/" + rest)
		}
	}
	return ""
}

// limitedGroup is a control group with a memory limit, in MiB.
type limitedGroup struct {
	dir      string
	limitMiB int64
}

// limitedGroups are the control groups, of this process's and the ones above it (cgroup v2), with a memory limit, its
// own first; none when none has one. Inside a container the group's namespace shows the container's own group as the
// root, whose memory.max is the container's limit.
func (p memoryPaths) limitedGroups() []limitedGroup {
	path := p.ownGroup()
	if path == "" {
		return nil
	}
	var out []limitedGroup
	var confined int64
	if p.confined != "" {
		confined = readNumber(p.confined)
	}
	for at := path; ; at = filepath.Dir(at) {
		candidate := filepath.Join(p.cgroup, at)
		if raw, err := os.ReadFile(filepath.Join(candidate, "memory.max")); err == nil {
			// The limit ConfineMemory set on the host's own group is its own doing, not the machine's memory.
			if n, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64); err == nil && n > 0 && !(at == path && n == confined) {
				out = append(out, limitedGroup{dir: candidate, limitMiB: n >> 20})
			}
		}
		if at == "/" {
			return out
		}
	}
}

// readKeyed reads a file of "key value" lines (/proc/meminfo's "MemTotal: 123 kB", vmstat's, memory.stat's) into a
// map; a file that can't be read is empty.
func readKeyed(path string) map[string]int64 {
	out := map[string]int64{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	return parseKeyed(f)
}

func parseKeyed(r io.Reader) map[string]int64 {
	out := map[string]int64{}
	s := bufio.NewScanner(r)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 2 {
			continue
		}
		if n, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
			out[fields[0]] = n
		}
	}
	return out
}

func readNumber(path string) int64 {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	n, _ := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	return n
}

// readPressure reads a PSI file's "some" and "full" avg10, in percent; zero for a kernel without PSI.
func readPressure(path string) (some, full float64) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, 0
	}
	return ParsePressure(string(raw))
}

// ParsePressure reads the avg10 of a PSI file's "some" and "full" lines ("some avg10=1.23 avg60=... total=...").
func ParsePressure(text string) (some, full float64) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		var value float64
		for _, f := range fields[1:] {
			if v, ok := strings.CutPrefix(f, "avg10="); ok {
				value, _ = strconv.ParseFloat(v, 64)
			}
		}
		switch fields[0] {
		case "some":
			some = value
		case "full":
			full = value
		}
	}
	return some, full
}
