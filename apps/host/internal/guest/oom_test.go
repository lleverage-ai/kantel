package guest

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParsePressureFullAvg10(t *testing.T) {
	got, err := ParsePressureFullAvg10(strings.NewReader(
		"some avg10=91.20 avg60=40.00 avg300=9.00 total=123\nfull avg10=63.75 avg60=30.00 avg300=7.00 total=99\n"))
	if err != nil || got != 63.75 {
		t.Fatalf("got %v, %v", got, err)
	}
	if _, err := ParsePressureFullAvg10(strings.NewReader("some avg10=1.00 total=1\n")); err == nil {
		t.Fatal("a file with no full line should fail")
	}
}

func TestParseAvailablePercent(t *testing.T) {
	got, err := ParseAvailablePercent(strings.NewReader(
		"MemTotal:        8000000 kB\nMemFree:          100000 kB\nMemAvailable:     200000 kB\n"))
	if err != nil || got != 2.5 {
		t.Fatalf("got %v, %v", got, err)
	}
	if _, err := ParseAvailablePercent(strings.NewReader("MemFree: 1 kB\n")); err == nil {
		t.Fatal("no MemTotal should fail")
	}
}

func TestThrashingNeedsPressureAndLittleLeft(t *testing.T) {
	for _, c := range []struct {
		state MemoryState
		want  bool
	}{
		{MemoryState{FullAvg10: 80, AvailablePercent: 2}, true},
		{MemoryState{FullAvg10: 80, AvailablePercent: 30}, false}, // stalls with memory to spare: IO, not memory
		{MemoryState{FullAvg10: 5, AvailablePercent: 1}, false},   // full but coping: page cache doing its job
		{MemoryState{FullAvg10: 40, AvailablePercent: 9.9}, true},
	} {
		if got := c.state.Thrashing(); got != c.want {
			t.Errorf("%+v: got %v", c.state, got)
		}
	}
}

func TestMemoryWatchKillsOnceAndCoolsDown(t *testing.T) {
	var reads atomic.Int64
	var kills atomic.Int64
	w := &MemoryWatch{
		Read: func() (MemoryState, error) {
			reads.Add(1)
			return MemoryState{FullAvg10: 90, AvailablePercent: 1}, nil
		},
		Kill:     func() error { kills.Add(1); return nil },
		Interval: time.Millisecond,
		Cooldown: time.Hour,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	w.Run(ctx)
	if kills.Load() != 1 || w.Kills.Load() != 1 {
		t.Fatalf("killed %d times (counted %d), want once inside the cooldown", kills.Load(), w.Kills.Load())
	}
	if reads.Load() < 2 {
		t.Fatalf("read %d times", reads.Load())
	}
}

func TestMemoryWatchLeavesAHealthyMachine(t *testing.T) {
	var kills atomic.Int64
	w := &MemoryWatch{
		Read:     func() (MemoryState, error) { return MemoryState{FullAvg10: 0, AvailablePercent: 60}, nil },
		Kill:     func() error { kills.Add(1); return nil },
		Interval: time.Millisecond,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	w.Run(ctx)
	if kills.Load() != 0 {
		t.Fatalf("killed %d times", kills.Load())
	}
}

func TestOOMNoteOnlyAfterAKill(t *testing.T) {
	if OOMNote(-1) != "" {
		t.Fatal("an unreadable count gives no note")
	}
	if now := OOMKills(); now >= 0 && OOMNote(now) != "" {
		t.Fatal("no kill since now gives no note")
	}
	if now := OOMKills(); now >= 1 && !strings.Contains(OOMNote(now-1), "ran out of memory") {
		t.Fatal("a kill since gives the note")
	}
}
