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

// Reclaim takes page cache back from a running sandbox's guest through its balloon: it sets the balloon's target to
// what the guest has available less a margin, so the guest drops page cache to fill it and Firecracker frees those
// pages on the host, waits until it is filled (or reclaimHold), then gives it all back. The guest gets back empty
// pages, which take no host memory until it uses them again. It answers how much the balloon took, in MiB. It holds
// the sandbox's lock throughout, so no snapshot or stop sees the balloon inflated.
func (m *Manager) Reclaim(ctx context.Context, id string) (int64, error) {
	s, machine, err := m.runningMachine(id)
	if err != nil {
		return 0, err
	}
	defer s.mu.Unlock()
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
	if err := fc.SetBalloon(ctx, dir, target); err != nil {
		return 0, err
	}
	var took int64
	defer func() {
		// Always given back, even when ctx has ended.
		release, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := fc.SetBalloon(release, dir, 0); err != nil {
			m.log.Warn("could not deflate a sandbox's balloon after reclaiming", "sandbox", id, "err", err)
		}
	}()
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
func (m *Manager) OutOfMemory(ctx context.Context, id string) error {
	client, err := m.running(id)
	if err != nil {
		return err
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

// KillForMemory ends a running sandbox's VM, which then stops with KilledForMemory as its error: the guard's last step,
// when its guest couldn't free enough.
func (m *Manager) KillForMemory(id string) error {
	s, machine, err := m.runningMachine(id)
	if err != nil {
		return err
	}
	pid := machine.Pid()
	s.killedFor = KilledForMemory
	s.mu.Unlock()
	if pid <= 0 {
		return errors.New("no VM process")
	}
	m.log.Warn("stopping a sandbox's VM: the host is short of memory", "sandbox", id, "pid", pid)
	return syscall.Kill(pid, syscall.SIGKILL)
}
