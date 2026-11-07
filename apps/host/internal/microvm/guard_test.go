package microvm

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// balloonAPI stands in for a Firecracker's balloon API on vm's socket: its guest has 4 GiB, 3 GiB of them available,
// and never fills the balloon, so a reclaim waits its whole hold. It records every target set.
type balloonAPI struct {
	mu      sync.Mutex
	targets []int64
}

func (b *balloonAPI) last() (int64, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.targets) == 0 {
		return -1, 0
	}
	return b.targets[len(b.targets)-1], len(b.targets)
}

func serveBalloon(t *testing.T, vm string) *balloonAPI {
	t.Helper()
	socket := filepath.Join(vm, fc.APISocket)
	_ = os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	api := &balloonAPI{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/balloon/statistics":
			total, available := int64(4096)<<20, int64(3072)<<20
			_ = json.NewEncoder(w).Encode(fc.BalloonStats{TotalMemory: &total, AvailableMemory: &available})
		case r.Method == http.MethodPatch && r.URL.Path == "/balloon":
			var body struct {
				AmountMiB int64 `json:"amount_mib"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			api.mu.Lock()
			api.targets = append(api.targets, body.AmountMiB)
			api.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return api
}

func slowReclaim(t *testing.T) {
	t.Helper()
	hold, poll := reclaimHold, reclaimPoll
	reclaimHold, reclaimPoll = 30*time.Second, 10*time.Millisecond
	t.Cleanup(func() { reclaimHold, reclaimPoll = hold, poll })
}

// A reclaim under way holds no lock on its sandbox: the usage sampler still reads it, and the guard's last step acts
// on it at once, not after the balloon's hold; the reclaim then ends with the VM.
func TestReclaimLeavesItsVMToTheGuard(t *testing.T) {
	slowReclaim(t)
	ev := &events{}
	m, s, _, machine := runningSandbox(t, ev)
	api := serveBalloon(t, s.vmDir())
	s.mu.Lock()
	m.watch(s, machine)
	s.mu.Unlock()
	done := make(chan error, 1)
	go func() {
		_, err := m.Reclaim(context.Background(), s.meta.ID)
		done <- err
	}()
	waitFor(t, "the balloon inflated", func() bool { target, _ := api.last(); return target > 0 })
	// The sampler reads it rather than answering it held.
	procs := m.Processes()
	if len(procs) != 1 || procs[0].Held || procs[0].Pid != machine.Pid() {
		t.Fatalf("processes during a reclaim: %+v", procs)
	}
	// A second reclaim of the same VM is refused, not stacked.
	if _, err := m.Reclaim(context.Background(), s.meta.ID); err == nil {
		t.Fatal("a second reclaim ran beside the first")
	}
	start := time.Now()
	if err := m.KillForMemory(s.meta.ID, machine.Pid()); err != nil {
		t.Fatal(err)
	}
	if waited := time.Since(start); waited > time.Second {
		t.Fatalf("the kill waited %v behind the reclaim", waited)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the reclaim outlived its VM")
	}
	if target, _ := api.last(); target != 0 {
		t.Fatalf("the balloon was left at %d MiB", target)
	}
	waitFor(t, "the VM's exit", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.meta.State == proto.StateStopped
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.Error != KilledForMemory {
		t.Fatalf("stopped with %q", s.meta.Error)
	}
}

// A stop or snapshot ends a reclaim first, and goes on only once the balloon has been given back.
func TestPauseEndsAReclaimFirst(t *testing.T) {
	slowReclaim(t)
	m, s, _, _ := runningSandbox(t, &events{})
	api := serveBalloon(t, s.vmDir())
	done := make(chan struct{})
	go func() {
		_, _ = m.Reclaim(context.Background(), s.meta.ID)
		close(done)
	}()
	waitFor(t, "the balloon inflated", func() bool { target, _ := api.last(); return target > 0 })
	s.mu.Lock()
	s.endReclaimLocked()
	target, n := api.last()
	reclaiming := s.reclaiming
	s.mu.Unlock()
	if target != 0 || n != 2 || reclaiming != nil {
		t.Fatalf("after ending the reclaim: target %d after %d sets, reclaiming %v", target, n, reclaiming)
	}
	<-done
}

// A guard step never waits on a sandbox an operation (a stop, snapshot or recovery) holds, so none is taken after the
// operation, once pressure may have passed: both answer ErrBusy at once, and the VM runs on.
func TestGuardStepsDontWaitOnAHeldSandbox(t *testing.T) {
	m, s, _, machine := runningSandbox(t, &events{})
	m.watch(s, machine)
	s.mu.Lock()
	start := time.Now()
	errOOM := m.OutOfMemory(context.Background(), s.meta.ID, machine.Pid())
	errKill := m.KillForMemory(s.meta.ID, machine.Pid())
	waited := time.Since(start)
	s.mu.Unlock()
	if !errors.Is(errOOM, ErrBusy) || !errors.Is(errKill, ErrBusy) {
		t.Fatalf("steps against a held sandbox: %v, %v", errOOM, errKill)
	}
	if waited > time.Second {
		t.Fatalf("the steps waited %v on the sandbox", waited)
	}
	time.Sleep(50 * time.Millisecond)
	if !processAlive(machine.Pid()) {
		t.Fatal("the VM was killed once the sandbox was let go")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.State != proto.StateRunning || s.killedFor != "" {
		t.Fatalf("after the steps: %s, killed for %q", s.meta.State, s.killedFor)
	}
}

// The guest is asked to kill its largest process with the sandbox's lock held: a replacement VM would answer on the
// same socket, and no recovery can put one there meanwhile. The lock is let go once the request ends.
func TestOutOfMemoryAsksTheGuestWithTheSandboxHeld(t *testing.T) {
	m, s, _, machine := runningSandbox(t, &events{})
	socket := filepath.Join(s.vmDir(), "g.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	accepted := make(chan net.Conn, 1)
	go func() {
		// Accepts and never answers, as a guest too short of memory to.
		if c, err := ln.Accept(); err == nil {
			accepted <- c
		}
	}()
	s.mu.Lock()
	s.guest = guest.NewClient(socket)
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- m.OutOfMemory(ctx, s.meta.ID, machine.Pid()) }()
	select {
	case c := <-accepted:
		defer c.Close()
	case <-time.After(5 * time.Second):
		t.Fatal("the guest wasn't asked")
	}
	if s.mu.TryLock() {
		s.mu.Unlock()
		t.Fatal("the sandbox's lock was free while its guest was asked")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil || errors.Is(err, ErrBusy) || errors.Is(err, ErrMachineChanged) {
			t.Fatalf("a guest that didn't answer: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the request outlived its context")
	}
	if !s.mu.TryLock() {
		t.Fatal("the sandbox's lock was kept after the request")
	}
	s.mu.Unlock()
}

// The guard's steps name the Firecracker process they chose: once a recovery has replaced the VM, a late fallback
// leaves the new one running, and the exit of the old one isn't taken for the guard's.
func TestGuardStepsLeaveAReplacedVM(t *testing.T) {
	ev := &events{}
	m, s, _, old := runningSandbox(t, ev)
	oldPid := old.Pid()
	replacement := reapedMachine(t, filepath.Join(s.dir, "vm2"))
	s.mu.Lock()
	s.machine = replacement
	m.watch(s, replacement)
	s.mu.Unlock()
	if err := m.OutOfMemory(context.Background(), s.meta.ID, oldPid); !errors.Is(err, ErrMachineChanged) {
		t.Fatalf("out of memory against the old VM: %v", err)
	}
	if err := m.KillForMemory(s.meta.ID, oldPid); !errors.Is(err, ErrMachineChanged) {
		t.Fatalf("kill of the old VM: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if !processAlive(replacement.Pid()) {
		t.Fatal("the replacement was killed")
	}
	s.mu.Lock()
	state, killed := s.meta.State, s.killedFor
	s.mu.Unlock()
	if state != proto.StateRunning || killed != "" {
		t.Fatalf("after the stale steps: %s, killed for %q", state, killed)
	}
	// Against the VM it runs now, the kill goes ahead and its exit says why.
	if err := m.KillForMemory(s.meta.ID, replacement.Pid()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the replacement's exit", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.meta.State == proto.StateStopped
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.meta.Error != KilledForMemory {
		t.Fatalf("stopped with %q", s.meta.Error)
	}
}
