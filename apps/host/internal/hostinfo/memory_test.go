package hostinfo

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

const meminfo = `MemTotal:       131072000 kB
MemFree:        20000000 kB
MemAvailable:   116391936 kB
SwapTotal:      33554432 kB
SwapFree:       24117248 kB
`

const pressure = "some avg10=3.50 avg60=1.00 avg300=0.20 total=7993403368\nfull avg10=0.75 avg60=0.10 avg300=0.00 total=6828537898\n"

// The machine's figures when kantel-host's group (a systemd unit) has no limit.
func TestReadMemoryMachine(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"proc/meminfo":                   meminfo,
		"proc/vmstat":                    "pswpin 10\npswpout 2400000\n",
		"proc/pressure/memory":           pressure,
		"proc/self/cgroup":               "0::/system.slice/kantel-host.service\n",
		"cgroup/memory.max":              "max\n",
		"cgroup/system.slice/memory.max": "max\n",
		"cgroup/system.slice/kantel-host.service/memory.max": "max\n",
	})
	m := memoryPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")}.read()
	want := Memory{TotalMiB: 128000, AvailableMiB: 113664, SwapUsedMiB: 9216, SwapOutPages: 2400000, PressureSome: 3.5, PressureFull: 0.75}
	if m != want {
		t.Fatalf("got %+v\nwant %+v", m, want)
	}
}

// In a container (or a unit with MemoryMax) the group's limit is the total, and its own use, swap and pressure count.
func TestReadMemoryLimitedGroup(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"proc/meminfo":         meminfo,
		"proc/vmstat":          "pswpout 2400000\n",
		"proc/pressure/memory": pressure,
		"proc/self/cgroup":     "0::/\n",
		// 12 GiB, 9 GiB of it used, 1 GiB of that inactive page cache.
		"cgroup/memory.max":          "12884901888\n",
		"cgroup/memory.current":      "9663676416\n",
		"cgroup/memory.stat":         "anon 8000000000\nfile 1600000000\ninactive_file 1073741824\n",
		"cgroup/memory.swap.current": "104857600\n",
		"cgroup/memory.pressure":     "some avg10=42.00 avg60=1 avg300=0 total=1\nfull avg10=21.50 avg60=1 avg300=0 total=1\n",
	})
	m := memoryPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")}.read()
	want := Memory{TotalMiB: 12288, AvailableMiB: 12288 - 9216 + 1024, SwapUsedMiB: 100, PressureSome: 42, PressureFull: 21.5, Limited: true}
	if m != want {
		t.Fatalf("got %+v\nwant %+v", m, want)
	}
}

// The smallest limit above the process's own group counts (a slice with MemoryMax).
func TestReadMemoryLimitAbove(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"proc/meminfo":                                       meminfo,
		"proc/self/cgroup":                                   "0::/kantel.slice/kantel-host.service\n",
		"cgroup/kantel.slice/memory.max":                     "68719476736\n",
		"cgroup/kantel.slice/memory.current":                 "0\n",
		"cgroup/kantel.slice/kantel-host.service/memory.max": "max\n",
	})
	m := memoryPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")}.read()
	if !m.Limited || m.TotalMiB != 65536 || m.AvailableMiB != 65536 {
		t.Fatalf("%+v", m)
	}
	// A limit above the machine's memory is no limit.
	writeFiles(t, root, map[string]string{"cgroup/kantel.slice/memory.max": "999999999999999\n"})
	if m := (memoryPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")}).read(); m.Limited || m.TotalMiB != 128000 {
		t.Fatalf("%+v", m)
	}
}

// A larger limit above, shared with siblings, can have the least left: the smallest limit is still the total, but
// what is available is what every limit leaves, the most constrained one's (its inactive page cache counted free).
func TestReadMemorySharedLimitAbove(t *testing.T) {
	root := t.TempDir()
	const gib = int64(1) << 30
	n := func(v int64) string { return strconv.FormatInt(v, 10) + "\n" }
	writeFiles(t, root, map[string]string{
		"proc/meminfo":     meminfo,
		"proc/self/cgroup": "0::/kantel.slice/kantel-host.service\n",
		// The slice: 16 GiB, 15 GiB of it used by the service and its siblings, 256 MiB of that inactive cache.
		"cgroup/kantel.slice/memory.max":     n(16 * gib),
		"cgroup/kantel.slice/memory.current": n(15 * gib),
		"cgroup/kantel.slice/memory.stat":    "inactive_file " + n(256<<20),
		// The service: 8 GiB, 2 GiB of it used.
		"cgroup/kantel.slice/kantel-host.service/memory.max":     n(8 * gib),
		"cgroup/kantel.slice/kantel-host.service/memory.current": n(2 * gib),
	})
	paths := memoryPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")}
	if m := paths.read(); !m.Limited || m.TotalMiB != 8192 || m.AvailableMiB != 1024+256 {
		t.Fatalf("%+v", m)
	}
	// The slice with room again, the service's own limit binds.
	writeFiles(t, root, map[string]string{"cgroup/kantel.slice/memory.current": n(4 * gib)})
	if m := paths.read(); m.TotalMiB != 8192 || m.AvailableMiB != 6144 {
		t.Fatalf("%+v", m)
	}
	// The service's limit kantel-host set itself (over-commit's confinement) isn't its total, but the slice's still
	// bounds what is available.
	confined := filepath.Join(root, "run", "memory-max")
	writeFiles(t, root, map[string]string{
		"run/memory-max":                     n(8 * gib),
		"cgroup/kantel.slice/memory.current": n(15 * gib),
	})
	paths.confined = confined
	if m := paths.read(); m.TotalMiB != 16384 || m.AvailableMiB != 1024+256 {
		t.Fatalf("%+v", m)
	}
	// No limits anywhere: the machine's.
	writeFiles(t, root, map[string]string{
		"cgroup/kantel.slice/memory.max":                     "max\n",
		"cgroup/kantel.slice/kantel-host.service/memory.max": "max\n",
	})
	if m := paths.read(); m.Limited || m.TotalMiB != 128000 || m.AvailableMiB != 113664 {
		t.Fatalf("%+v", m)
	}
}

// The production host of LLE-19010: an operator's MemoryMax of 48 GiB on kantel-host.service, the group at its
// limit, nearly all of it clean page cache from copying disk images and the VMs' disk files (the kernel keeps about a
// twentieth of that much file cache inactive), about 10 GiB anonymous, no swap, and the machine with over 100 GiB
// available.
const (
	incidentMeminfo = "MemTotal:       131072000 kB\nMemAvailable:   110100480 kB\nSwapTotal:      0 kB\nSwapFree:       0 kB\n"
	incidentGroup   = "cgroup/system.slice/kantel-host.service/"
	incidentStat    = "anon 11005853696\nfile 40231763968\nkernel 268435456\nshmem 16777216\nfile_mapped 1073741824\n" +
		"file_dirty 50331648\nfile_writeback 0\nactive_anon 11005853696\ninactive_anon 16777216\n" +
		"active_file 38168166400\ninactive_file 2046820352\n"
)

func incidentFiles() map[string]string {
	return map[string]string{
		"proc/meminfo":                        incidentMeminfo,
		"proc/vmstat":                         "pswpout 0\n",
		"proc/self/cgroup":                    "0::/system.slice/kantel-host.service\n",
		"cgroup/system.slice/memory.max":      "max\n",
		incidentGroup + "memory.max":          "51539607552\n",
		incidentGroup + "memory.current":      "51505004544\n",
		incidentGroup + "memory.stat":         incidentStat,
		incidentGroup + "memory.events":       "low 0\nhigh 0\nmax 1200\noom 0\noom_kill 0\n",
		incidentGroup + "memory.pressure":     "some avg10=3.10 avg60=1 avg300=0 total=1\nfull avg10=0.40 avg60=0 avg300=0 total=1\n",
		incidentGroup + "memory.swap.current": "0\n",
	}
}

// The incident's group has 38 GiB it can still take before the kernel ends a VM: its page cache, clean, can be
// dropped at the limit. Which share of it the kernel keeps inactive doesn't change that.
func TestReadMemoryIncident(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, incidentFiles())
	paths := memoryPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")}
	// 36400 active and 1952 inactive, 48 of it dirty.
	const cache = 36400 + 1952 - 48
	want := Memory{TotalMiB: 49152, AvailableMiB: 33 + cache, PressureSome: 3.1, PressureFull: 0.4, Limited: true,
		GroupMaxMiB: 49152, GroupHeadroomMiB: 33, GroupCacheMiB: cache, GroupLimitHits: 1200}
	if m := paths.read(); m != want {
		t.Fatalf("got %+v\nwant %+v", m, want)
	}
	half := strings.NewReplacer("active_file 38168166400", "active_file 20115881984", "inactive_file 2046820352",
		"inactive_file 20099104768").Replace(incidentStat)
	writeFiles(t, root, map[string]string{incidentGroup + "memory.stat": half})
	if m := paths.read(); m != want {
		t.Fatalf("half inactive: got %+v\nwant %+v", m, want)
	}
}

// Page cache that must reach the disk first (dirty, under writeback) isn't droppable, nor is tmpfs or shared memory,
// which memory.stat counts as file but keeps on the anonymous lists.
func TestDroppableCache(t *testing.T) {
	stat := parseKeyed(strings.NewReader("file 12884901888\nshmem 4294967296\nactive_file 6442450944\n" +
		"inactive_file 2147483648\nfile_dirty 1073741824\nfile_writeback 536870912\n"))
	if got := droppableCacheMiB(stat); got != 6144+2048-1024-512 {
		t.Fatalf("droppable %d", got)
	}
	if got := droppableCacheMiB(map[string]int64{"inactive_file": 1 << 20, "file_dirty": 2 << 20}); got != 0 {
		t.Fatalf("more dirty than on the lists: %d", got)
	}
}

// Over-commit caps the host's own group: memory.max and no swap, where unset, recorded so the cap isn't then read as
// the machine's memory; an operator's limit is left as it is.
func TestConfineMemory(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, map[string]string{
		"proc/meminfo":     meminfo,
		"proc/self/cgroup": "0::/system.slice/kantel-host.service\n",
		"cgroup/system.slice/kantel-host.service/memory.max":      "max\n",
		"cgroup/system.slice/kantel-host.service/memory.swap.max": "max\n",
		"cgroup/system.slice/kantel-host.service/memory.current":  "1073741824\n",
		"cgroup/system.slice/kantel-host.service/memory.events":   "low 0\nhigh 0\nmax 7\noom 1\noom_kill 1\n",
	})
	p := memoryPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup"), confined: filepath.Join(root, "run/memory-max")}
	if m := p.read(); m.GroupMaxMiB != 0 || m.GroupLimitHits != 7 {
		t.Fatalf("before confining: %+v", m)
	}
	c, err := p.confine(120000)
	if err != nil {
		t.Fatal(err)
	}
	group := filepath.Join(root, "cgroup/system.slice/kantel-host.service")
	if c.Group != group || c.MaxMiB != 120000 || !c.SetMax || !c.SwapOff || !c.SetSwap {
		t.Fatalf("%+v", c)
	}
	if got := readNumber(filepath.Join(group, "memory.max")); got != 120000<<20 {
		t.Fatalf("memory.max %d", got)
	}
	if got, _ := os.ReadFile(filepath.Join(group, "memory.swap.max")); string(got) != "0" {
		t.Fatalf("memory.swap.max %q", got)
	}
	// Its own cap isn't the machine's memory.
	if m := p.read(); m.Limited || m.TotalMiB != 128000 || m.GroupMaxMiB != 120000 || m.GroupHeadroomMiB != 120000-1024 {
		t.Fatalf("read after confining: %+v", m)
	}
	if p.oomKills() != 1 {
		t.Fatalf("oom kills %d", p.oomKills())
	}
	// Again: nothing to set.
	if c, err := p.confine(120000); err != nil || c.SetMax || c.SetSwap || c.MaxMiB != 120000 || !c.SwapOff {
		t.Fatalf("%+v %v", c, err)
	}
	// An operator's limit is kept, and is the machine's memory as before.
	writeFiles(t, root, map[string]string{"cgroup/system.slice/kantel-host.service/memory.max": "68719476736\n"})
	if c, _ := p.confine(120000); c.SetMax || c.MaxMiB != 65536 {
		t.Fatalf("%+v", c)
	}
	if m := p.read(); !m.Limited || m.TotalMiB != 65536 {
		t.Fatalf("%+v", m)
	}
	// The root group, or none: nothing to do.
	writeFiles(t, root, map[string]string{"proc/self/cgroup": "0::/\n"})
	if c, err := p.confine(120000); err != nil || c.Group != "" {
		t.Fatalf("%+v %v", c, err)
	}
}

func TestParsePressure(t *testing.T) {
	if some, full := ParsePressure("some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"); some != 0 || full != 0 {
		t.Fatal(some, full)
	}
	if some, full := ParsePressure(pressure); some != 3.5 || full != 0.75 {
		t.Fatal(some, full)
	}
}
