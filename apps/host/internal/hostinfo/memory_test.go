package hostinfo

import (
	"os"
	"path/filepath"
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
