package guest

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

func TestParseOnDemand(t *testing.T) {
	got := parseOnDemand("# comment\n\n6081 kantel-browser-stream.service 5m\n7000 other.service\n7001 keep.service 0\n" +
		"bad line here too\n0 zero.service\n7002 notaunit\n7003 x.service soon\n")
	want := map[int]onDemandService{
		6081: {Unit: "kantel-browser-stream.service", Idle: 5 * time.Minute},
		7000: {Unit: "other.service", Idle: DefaultOnDemandIdle},
		7001: {Unit: "keep.service", Idle: 0},
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for port, service := range want {
		if got[port] != service {
			t.Errorf("%d: got %+v, want %+v", port, got[port], service)
		}
	}
}

// fakeUnit is a service whose port answers only while it runs.
type fakeUnit struct {
	mu      sync.Mutex
	running bool
	starts  int
	stops   int
}

func (u *fakeUnit) start(context.Context, string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.running = true
	u.starts++
	return nil
}

func (u *fakeUnit) stop(context.Context, string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.running = false
	u.stops++
	return nil
}

func (u *fakeUnit) connect() (net.Conn, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.running {
		return nil, errors.New("connection refused")
	}
	a, b := net.Pipe()
	b.Close()
	return a, nil
}

func (u *fakeUnit) state() (bool, int, int) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.running, u.starts, u.stops
}

func TestOnDemandStartsOnFirstDialAndStopsWhenIdle(t *testing.T) {
	unit := &fakeUnit{}
	idle := 80 * time.Millisecond
	d := newOnDemand(map[int]onDemandService{6081: {Unit: "s.service", Idle: idle}}, unit.start, unit.stop)

	conn, done, err := d.dial(context.Background(), 6081, unit.connect)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if running, starts, _ := unit.state(); !running || starts != 1 {
		t.Fatalf("not started by its first dial: running %v, starts %d", running, starts)
	}
	// A second connection finds it running.
	_, done2, err := d.dial(context.Background(), 6081, unit.connect)
	if err != nil {
		t.Fatal(err)
	}
	done()
	time.Sleep(2 * idle)
	if running, starts, stops := unit.state(); !running || starts != 1 || stops != 0 {
		t.Fatalf("stopped while a connection is open: running %v, starts %d, stops %d", running, starts, stops)
	}
	done2()
	done2() // twice is once
	time.Sleep(idle / 2)
	// Back before the idle time is up: the timer is off.
	_, done3, err := d.dial(context.Background(), 6081, unit.connect)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * idle)
	if running, _, stops := unit.state(); !running || stops != 0 {
		t.Fatalf("stopped though a viewer came back in time: running %v, stops %d", running, stops)
	}
	done3()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if running, _, stops := unit.state(); !running && stops == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("not stopped once idle")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// And started again by the next viewer.
	if _, _, err := d.dial(context.Background(), 6081, unit.connect); err != nil {
		t.Fatal(err)
	}
	if running, starts, _ := unit.state(); !running || starts != 2 {
		t.Fatalf("not started again: running %v, starts %d", running, starts)
	}
}

func TestOnDemandLeavesOtherPortsAlone(t *testing.T) {
	unit := &fakeUnit{}
	d := newOnDemand(map[int]onDemandService{}, unit.start, unit.stop)
	if _, _, err := d.dial(context.Background(), 6080, unit.connect); err == nil {
		t.Fatal("a port that isn't on demand was started")
	}
	if _, starts, _ := unit.state(); starts != 0 {
		t.Fatalf("starts %d", starts)
	}
}

func TestOnDemandStopsOneLeftRunning(t *testing.T) {
	// Running before the agent read the file, with nothing connected: stopped once idle all the same.
	unit := &fakeUnit{running: true}
	newOnDemand(map[int]onDemandService{6081: {Unit: "s.service", Idle: 20 * time.Millisecond}}, unit.start, unit.stop)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if running, _, _ := unit.state(); !running {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("left running")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestOnDemandStartFails(t *testing.T) {
	failing := func(context.Context, string) error { return errors.New("no such unit") }
	unit := &fakeUnit{}
	d := newOnDemand(map[int]onDemandService{6081: {Unit: "s.service", Idle: time.Minute}}, failing, unit.stop)
	if _, _, err := d.dial(context.Background(), 6081, unit.connect); err == nil || err.Error() != "no such unit" {
		t.Fatalf("got %v", err)
	}
}
