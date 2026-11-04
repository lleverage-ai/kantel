package usage

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func near(t *testing.T, what string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("%s = %v, want %v", what, got, want)
	}
}

func TestParseHostCPU(t *testing.T) {
	stat := "cpu  100 5 50 800 40 3 2 0 7 0\ncpu0 50 2 25 400 20 1 1 0 0 0\nintr 12345\n"
	c, err := ParseHostCPU(strings.NewReader(stat))
	if err != nil {
		t.Fatal(err)
	}
	// user..steal, not guest (counted in user already); idle is idle + iowait.
	if c.Total != 100+5+50+800+40+3+2+0 || c.Idle != 840 {
		t.Fatalf("got %+v", c)
	}
	if _, err := ParseHostCPU(strings.NewReader("intr 1\n")); err == nil {
		t.Fatal("no cpu line should fail")
	}
	if _, err := ParseHostCPU(strings.NewReader("cpu  1 x 3 4 5\n")); err == nil {
		t.Fatal("a bad number should fail")
	}
}

func TestHostCPUBusy(t *testing.T) {
	prev := HostCPU{Total: 1000, Idle: 800}
	busy, ok := HostCPUBusy(prev, HostCPU{Total: 1400, Idle: 900})
	if !ok {
		t.Fatal("want a figure")
	}
	near(t, "busy", busy, 0.75)
	// No time passed, or a reset (counters back to zero after, say, a checkpoint restore): no figure.
	for _, cur := range []HostCPU{prev, {Total: 10, Idle: 5}, {Total: 1100, Idle: 700}} {
		if _, ok := HostCPUBusy(prev, cur); ok {
			t.Fatalf("%+v after %+v should have no figure", cur, prev)
		}
	}
	// Idle growing more than the total is a bad reading, not 0% busy below zero.
	if _, ok := HostCPUBusy(prev, HostCPU{Total: 1100, Idle: 1000}); ok {
		t.Fatal("idle past total should have no figure")
	}
}

func TestParseMeminfo(t *testing.T) {
	m, err := ParseMeminfo(strings.NewReader("MemTotal:       16384 kB\nMemFree:  100 kB\nMemAvailable:    4096 kB\n"))
	if err != nil {
		t.Fatal(err)
	}
	if m.Total != 16384*1024 || m.Available != 4096*1024 || m.Used() != 12288*1024 {
		t.Fatalf("got %+v", m)
	}
	if _, err := ParseMeminfo(strings.NewReader("MemTotal: 1 kB\n")); err == nil {
		t.Fatal("no MemAvailable should fail")
	}
}

func TestParseProcStat(t *testing.T) {
	// A command name with spaces and a ')' of its own: fields count from the last ')'.
	raw := "4242 (fire (cracker) x) S 1 4242 4242 0 -1 4194560 100 0 0 0 1234 567 0 0 20 0 9 0 98765 1000000 2000 18446744073709551615"
	p, err := ParseProcStat(raw)
	if err != nil {
		t.Fatal(err)
	}
	if p.Ticks != 1234+567 || p.Start != 98765 {
		t.Fatalf("got %+v", p)
	}
	near(t, "seconds", p.Seconds(), 18.01)
	if p.Epoch(4242) != "4242/98765" {
		t.Fatalf("epoch %q", p.Epoch(4242))
	}
	if _, err := ParseProcStat("4242 (short) S 1 2 3"); err == nil {
		t.Fatal("too few fields should fail")
	}
	if _, err := ParseProcStat("no name here"); err == nil {
		t.Fatal("no name should fail")
	}
}

func TestParseRSS(t *testing.T) {
	rss, err := ParseRSS(strings.NewReader("Name:\tfirecracker\nVmPeak:\t 9000 kB\nVmRSS:\t  524288 kB\nRssAnon: 1 kB\n"))
	if err != nil {
		t.Fatal(err)
	}
	if rss != 512<<20 {
		t.Fatalf("rss %d", rss)
	}
	if _, err := ParseRSS(strings.NewReader("Name: x\n")); err == nil {
		t.Fatal("no VmRSS (a zombie) should fail")
	}
}

func TestReadFromProc(t *testing.T) {
	dir := t.TempDir()
	old := Proc
	Proc = dir
	t.Cleanup(func() { Proc = old })
	must := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	must(filepath.Join(dir, "stat"), "cpu  1 2 3 4 5 6 7 8 0 0\n")
	must(filepath.Join(dir, "meminfo"), "MemTotal: 2 kB\nMemAvailable: 1 kB\n")
	must(filepath.Join(dir, "77", "stat"), "77 (fc) S 1 1 1 0 -1 0 0 0 0 0 30 20 0 0 20 0 1 0 555 0 0")
	must(filepath.Join(dir, "77", "status"), "VmRSS: 8 kB\n")
	if c, err := ReadHostCPU(); err != nil || c.Total != 36 {
		t.Fatalf("host cpu %+v %v", c, err)
	}
	if m, err := ReadMemory(); err != nil || m.Total != 2048 {
		t.Fatalf("memory %+v %v", m, err)
	}
	if p, err := ReadProcCPU(77); err != nil || p.Ticks != 50 || p.Start != 555 {
		t.Fatalf("proc %+v %v", p, err)
	}
	if rss, err := ReadRSS(77); err != nil || rss != 8192 {
		t.Fatalf("rss %d %v", rss, err)
	}
	// A process that went away between listing and reading.
	if _, err := ReadProcCPU(78); err == nil {
		t.Fatal("a missing process should fail")
	}
	if _, err := ReadProcCPU(0); err == nil {
		t.Fatal("pid 0 should fail")
	}
}

func TestReadDisk(t *testing.T) {
	d, err := ReadDisk(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if d.Total <= 0 || d.Used < 0 || d.Used > d.Total {
		t.Fatalf("disk %+v", d)
	}
}

func TestCounters(t *testing.T) {
	c := NewCounters()
	t0 := time.Unix(1000, 0)
	if _, _, ok := c.Delta("a", "1/1", 10, t0); ok {
		t.Fatal("a first reading has no figure")
	}
	grew, over, ok := c.Delta("a", "1/1", 12.5, t0.Add(5*time.Second))
	if !ok || grew != 2.5 || over != 5*time.Second {
		t.Fatalf("delta %v %v %v", grew, over, ok)
	}
	// A counter that went backwards (the process's accounting reset): no figure, and it starts again from there.
	if _, _, ok := c.Delta("a", "1/1", 1, t0.Add(10*time.Second)); ok {
		t.Fatal("a reset should have no figure")
	}
	if grew, _, ok := c.Delta("a", "1/1", 3, t0.Add(15*time.Second)); !ok || grew != 2 {
		t.Fatalf("after a reset: %v %v", grew, ok)
	}
	// Another process (the sandbox resumed in a new Firecracker): no figure across the two.
	if _, _, ok := c.Delta("a", "2/9", 50, t0.Add(20*time.Second)); ok {
		t.Fatal("a new epoch should have no figure")
	}
	// No time between readings.
	if _, _, ok := c.Delta("a", "2/9", 51, t0.Add(20*time.Second)); ok {
		t.Fatal("no time between readings should have no figure")
	}
}

func TestCountersSweepForgetsWhatWentAway(t *testing.T) {
	c := NewCounters()
	t0 := time.Unix(1000, 0)
	c.Delta("a", "e", 1, t0)
	c.Delta("b", "e", 1, t0)
	c.Sweep()
	// b went away: only a is read this time.
	c.Delta("a", "e", 2, t0.Add(time.Second))
	c.Sweep()
	if c.Len() != 1 {
		t.Fatalf("following %d, want 1", c.Len())
	}
	// b comes back with the same ID later: it starts again, not measured across the gap.
	if _, _, ok := c.Delta("b", "e", 100, t0.Add(2*time.Second)); ok {
		t.Fatal("a sandbox that came back should start again")
	}
}

func TestUtilisation(t *testing.T) {
	near(t, "2 of 4 cpus", Utilisation(10, 5*time.Second, 4), 0.5)
	// The VMM's own threads can take a VM past its vCPUs: capped at 1.
	near(t, "capped", Utilisation(30, 5*time.Second, 4), 1)
	near(t, "no time", Utilisation(1, 0, 4), 0)
	near(t, "no cpus", Utilisation(1, time.Second, 0), 0)
}

func TestAttribute(t *testing.T) {
	got := Attribute(3, map[string]float64{"a": 4, "b": 2, "c": 0})
	near(t, "a", got["a"], 2)
	near(t, "b", got["b"], 1)
	near(t, "c", got["c"], 0)
	// Nobody busy: the runtime's idling is nobody's.
	got = Attribute(0.4, map[string]float64{"a": 0, "b": 0})
	if got["a"] != 0 || got["b"] != 0 || len(got) != 2 {
		t.Fatalf("idle: %v", got)
	}
	if len(Attribute(1, nil)) != 0 {
		t.Fatal("no sandboxes, nothing given")
	}
}
