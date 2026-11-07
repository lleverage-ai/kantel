package microvm

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/guest"
	"github.com/lleverage-ai/kantel/apps/host/internal/memplan"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// What the host's memory guard (package agent, memory over-commit) asks of the tier: the VMs holding memory, taking
// page cache back from one through its balloon, having its guest kill its largest process, and, last, ending it.

// Reclaim's limits: the balloon's target leaves the guest reclaimMarginShare of its memory, at least reclaimMarginMiB,
// beyond what it uses now; it waits reclaimHold for the guest to fill it, then gives it all back.
var (
	reclaimMarginMiB   int64 = 256
	reclaimMarginShare       = 0.05
	reclaimHold              = 10 * time.Second
	reclaimPoll              = 500 * time.Millisecond
	// outOfMemoryTimeout bounds the guest's call that runs its kernel's OOM killer.
	outOfMemoryTimeout = 5 * time.Second
)

// KilledForMemory is the error a sandbox the host ended for memory stops with.
const KilledForMemory = "out of memory: the host ran short of memory, and Kantel stopped this sandbox's VM, the largest, to protect it"

// heldVMsLocked is what holds memory against the tier's budget, as heldLocked counts it: the sandboxes starting,
// resuming or running, and the template builds (in full). Called with m.mu held.
func (m *Manager) heldVMsLocked() []memplan.VM {
	var out []memplan.VM
	for id, resume := range m.resuming {
		out = append(out, memplan.VM{ID: id, SizeMiB: int64(resume.MemoryMiB)})
	}
	for _, s := range m.sandboxes {
		if s.meta.State != proto.StateRunning && s.meta.State != proto.StateStarting {
			continue
		}
		if size, err := m.size(s.meta.Size); err == nil {
			out = append(out, memplan.VM{ID: s.meta.ID, SizeMiB: int64(size.MemoryMiB)})
		}
	}
	for _, build := range m.builds {
		out = append(out, memplan.VM{SizeMiB: int64(build.MemoryMiB), Full: true})
	}
	for _, build := range m.ownBuilds {
		out = append(out, memplan.VM{SizeMiB: int64(build.MemoryMiB), Full: true})
	}
	return out
}

// MemoryVMs is what holds memory in the tier now (heldVMsLocked).
func (m *Manager) MemoryVMs() []memplan.VM {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.heldVMsLocked()
}

// runningMachine is a running sandbox's machine, with its lock held: the caller unlocks.
func (m *Manager) runningMachine(id string) (*sandbox, *fc.Machine, error) {
	s, err := m.get(id)
	if err != nil {
		return nil, nil, err
	}
	s.mu.Lock()
	if s.meta.State != proto.StateRunning || s.machine == nil {
		s.mu.Unlock()
		return nil, nil, conflict("sandbox %s is %s, not running", id, s.meta.State)
	}
	return s, s.machine, nil
}

// ErrBusy answers a guard's step against a sandbox an operation holds (a stop, snapshot, resume or recovery): the step
// isn't taken, and the guard decides again on a later pass, with that pass's pressure and readings.
var ErrBusy = errors.New("the sandbox is mid-operation")

// guardMachine is a running sandbox's machine for one of the guard's steps, with its lock held (the caller unlocks),
// if that is its Firecracker process pid. It never waits on the lock: a sandbox an operation holds answers ErrBusy,
// so no step waits behind the operation and is taken after it, against what may be another VM, once pressure may
// have passed. One whose VM was replaced since answers ErrMachineChanged.
func (m *Manager) guardMachine(id string, pid int) (*sandbox, *fc.Machine, error) {
	s, err := m.get(id)
	if err != nil {
		return nil, nil, err
	}
	if !s.mu.TryLock() {
		return nil, nil, ErrBusy
	}
	if s.meta.State != proto.StateRunning || s.machine == nil {
		s.mu.Unlock()
		return nil, nil, conflict("sandbox %s is %s, not running", id, s.meta.State)
	}
	if pid <= 0 || s.machine.Pid() != pid {
		s.mu.Unlock()
		return nil, nil, ErrMachineChanged
	}
	return s, s.machine, nil
}

// reclaim is a Reclaim under way on a sandbox (sandbox.reclaiming): cancel ends it early, and done is closed once its
// balloon has been given back.
type reclaim struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// endReclaimLocked ends a Reclaim under way on s, and waits until its balloon has been given back, so what is about to
// pause or snapshot the VM doesn't keep it inflated. Called with s.mu held.
func (s *sandbox) endReclaimLocked() {
	if r := s.reclaiming; r != nil {
		r.cancel()
		<-r.done
		s.reclaiming = nil
	}
}

// Reclaim takes page cache back from a running sandbox's guest through its balloon: it sets the balloon's target to
// what the guest has available less a margin, so the guest drops page cache to fill it and Firecracker frees those
// pages on the host, waits until it is filled (or reclaimHold), then gives it all back. The guest gets back empty
// pages, which take no host memory until it uses them again. It answers how much the balloon took, in MiB.
//
// It doesn't hold the sandbox's lock while it waits, so the usage sampler goes on reading the VM and the guard's
// out-of-memory step can act on it at once; a stop or snapshot ends it first (endReclaimLocked), so none sees the
// balloon inflated.
func (m *Manager) Reclaim(ctx context.Context, id string) (int64, error) {
	s, machine, err := m.runningMachine(id)
	if err != nil {
		return 0, err
	}
	if s.reclaiming != nil {
		s.mu.Unlock()
		return 0, conflict("sandbox %s is being reclaimed from already", id)
	}
	ctx, cancel := context.WithCancel(ctx)
	r := &reclaim{cancel: cancel, done: make(chan struct{})}
	s.reclaiming = r
	s.mu.Unlock()
	var inflated bool
	defer func() {
		cancel()
		if inflated {
			// Always given back, even when ctx has ended.
			release, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := fc.SetBalloon(release, machine.Dir, 0); err != nil {
				m.log.Warn("could not deflate a sandbox's balloon after reclaiming", "sandbox", id, "err", err)
			}
			cancel()
		}
		close(r.done)
		s.mu.Lock()
		if s.reclaiming == r {
			s.reclaiming = nil
		}
		s.mu.Unlock()
	}()
	dir := machine.Dir
	stats, err := fc.ReadBalloonStats(ctx, dir)
	if err != nil {
		return 0, err
	}
	if stats.TotalMemory == nil || stats.AvailableMemory == nil {
		return 0, errNoGuestMemory
	}
	totalMiB, availableMiB := *stats.TotalMemory>>20, *stats.AvailableMemory>>20
	margin := max(reclaimMarginMiB, int64(float64(totalMiB)*reclaimMarginShare))
	target := availableMiB - margin
	if target <= 0 {
		return 0, nil
	}
	// Inflated from here: an error setting it may still have reached Firecracker.
	inflated = true
	if err := fc.SetBalloon(ctx, dir, target); err != nil {
		return 0, err
	}
	var took int64
	deadline := time.Now().Add(reclaimHold)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return took, ctx.Err()
		case <-machine.Done():
			return took, nil
		case <-time.After(reclaimPoll):
		}
		st, err := fc.ReadBalloonStats(ctx, dir)
		if err != nil {
			continue
		}
		took = st.ActualMiB
		if took >= target {
			break
		}
	}
	return took, nil
}

// OutOfMemory has a running sandbox's guest run its kernel's OOM killer (sysrq f), which kills its largest process:
// the guest's memory watch (#772) tells a command running then that the sandbox ran out of memory, and, with free page
// reporting, the memory it frees goes back to the host.
//
// pid is the Firecracker process the guard chose: a sandbox whose VM has been replaced since (a recovery) is left
// alone, answering ErrMachineChanged, and one an operation holds now answers ErrBusy. The sandbox's lock is held
// while its guest is asked (at most outOfMemoryTimeout), as a replacement VM would answer on the same socket: so the
// request reaches the VM chosen or none. The usage sampler and health check pass a sandbox held so.
func (m *Manager) OutOfMemory(ctx context.Context, id string, pid int) error {
	s, _, err := m.guardMachine(id, pid)
	if err != nil {
		return err
	}
	defer s.mu.Unlock()
	client := s.guest
	if client == nil {
		return conflict("sandbox %s has no guest agent", id)
	}
	ctx, cancel := context.WithTimeout(ctx, outOfMemoryTimeout)
	defer cancel()
	res, err := client.Exec(ctx, guest.ExecRequest{
		Argv: []string{"/bin/sh", "-c", "echo f > /proc/sysrq-trigger"}, User: "root", TimeoutMs: outOfMemoryTimeout.Milliseconds(),
	})
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("the guest's sysrq-trigger answered exit %d: %s", res.ExitCode, res.Stderr)
	}
	return nil
}

// ErrMachineChanged answers a guard's step against a VM a sandbox no longer runs: it was replaced (a recovery), and the
// step is dropped.
var ErrMachineChanged = errors.New("the sandbox's VM has been replaced since")

// KillForMemory ends a running sandbox's VM, the Firecracker process pid the guard chose, which then stops with
// KilledForMemory as its error: the guard's last step, when its guest couldn't free enough. A sandbox whose VM has been
// replaced since is left alone (ErrMachineChanged), and one an operation holds now isn't waited for (ErrBusy).
func (m *Manager) KillForMemory(id string, pid int) error {
	s, machine, err := m.guardMachine(id, pid)
	if err != nil {
		return err
	}
	// Killed with the lock held, so the exit watcher, which takes it, attributes this exit to this machine.
	defer s.mu.Unlock()
	s.killedFor, s.killed = KilledForMemory, machine
	m.log.Warn("stopping a sandbox's VM: the host is short of memory", "sandbox", id, "pid", pid)
	return syscall.Kill(pid, syscall.SIGKILL)
}
