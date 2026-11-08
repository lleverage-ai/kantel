package guest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParsePressureSomeReadsTheSomeTotal(t *testing.T) {
	raw := "some avg10=1.50 avg60=0.40 avg300=0.10 total=123456\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=789\n"
	got, err := ParsePressureSome(strings.NewReader(raw))
	if err != nil || got != 123456 {
		t.Fatalf("got %d, %v; want 123456", got, err)
	}
	if _, err := ParsePressureSome(strings.NewReader("full avg10=0 total=1\n")); err == nil {
		t.Fatal("a file without a some line should fail")
	}
	if _, err := ParsePressureSome(strings.NewReader("some avg10=0 total=x\n")); err == nil {
		t.Fatal("a total that isn't a number should fail")
	}
}

func TestReadMemoryReadsPressureAndOOMKills(t *testing.T) {
	dir := t.TempDir()
	var none Stats
	none.ReadMemory(filepath.Join(dir, "no-pressure"), filepath.Join(dir, "no-vmstat"))
	if none.OOMKills != nil || none.MemorySomeAvg10 != nil || none.MemoryFullAvg10 != nil {
		t.Fatalf("figures from files that aren't there: %+v", none)
	}

	pressure, vmstat := filepath.Join(dir, "memory"), filepath.Join(dir, "vmstat")
	raw := "some avg10=85.25 avg60=40.00 avg300=10.00 total=123\nfull avg10=41.50 avg60=20.00 avg300=5.00 total=45\n"
	if err := os.WriteFile(pressure, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(vmstat, []byte("nr_free_pages 12\noom_kill 2\nnr_unevictable 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out Stats
	out.ReadMemory(pressure, vmstat)
	if out.MemorySomeAvg10 == nil || *out.MemorySomeAvg10 != 85.25 || out.MemoryFullAvg10 == nil || *out.MemoryFullAvg10 != 41.5 {
		t.Fatalf("pressure %v %v, want 85.25 and 41.5", out.MemorySomeAvg10, out.MemoryFullAvg10)
	}
	if out.OOMKills == nil || *out.OOMKills != 2 {
		t.Fatalf("OOM kills %v, want 2", out.OOMKills)
	}

	// A kernel without the counter (or one that can't be parsed) has none, not 0.
	if err := os.WriteFile(vmstat, []byte("nr_free_pages 12\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var missing Stats
	missing.ReadMemory(pressure, vmstat)
	if missing.OOMKills != nil {
		t.Fatalf("OOM kills %d from a vmstat without oom_kill", *missing.OOMKills)
	}
}

func TestReadStatsReadsTheDiskAndLeavesOutPressureItCantRead(t *testing.T) {
	dir := t.TempDir()
	out := ReadStats(dir, filepath.Join(dir, "no-such-file"))
	if out.DiskTotalBytes <= 0 || out.DiskUsedBytes < 0 || out.DiskUsedBytes > out.DiskTotalBytes {
		t.Fatalf("disk %d of %d", out.DiskUsedBytes, out.DiskTotalBytes)
	}
	if out.IOSomeMicros != nil {
		t.Fatalf("IO pressure %d from a file that isn't there", *out.IOSomeMicros)
	}

	pressure := filepath.Join(dir, "io")
	if err := os.WriteFile(pressure, []byte("some avg10=0.00 avg60=0.00 avg300=0.00 total=42\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if out := ReadStats(dir, pressure); out.IOSomeMicros == nil || *out.IOSomeMicros != 42 {
		t.Fatalf("IO pressure %v, want 42", out.IOSomeMicros)
	}
}
