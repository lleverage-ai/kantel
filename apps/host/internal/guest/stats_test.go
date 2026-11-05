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
