package microvm

import (
	"context"
	"errors"

	"github.com/lleverage-ai/kantel/apps/host/internal/fc"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// Processes are the running sandboxes' Firecracker processes, each with the vCPUs and memory its size gives it, for
// the host's usage samples. A Firecracker process is the whole VM, its vCPU threads and the VMM's own, so its CPU
// and resident memory are what the sandbox costs the host. Each also reads its guest's own memory figures, from the
// statistics of the balloon every VM is booted with (BalloonStatsSeconds), which Firecracker keeps: what the guest
// uses, rather than every page it has ever touched.
//
// It never waits on a sandbox: one whose lock a create, snapshot or stop holds (for minutes, at a cold boot) is
// answered Held, unread this time, so the samples go on.
func (m *Manager) Processes() []usage.Process {
	m.mu.Lock()
	ids := make([]string, 0, len(m.sandboxes))
	list := make([]*sandbox, 0, len(m.sandboxes))
	for id, s := range m.sandboxes {
		ids = append(ids, id)
		list = append(list, s)
	}
	m.mu.Unlock()
	out := make([]usage.Process, 0, len(list))
	for i, s := range list {
		if !s.mu.TryLock() {
			out = append(out, usage.Process{SandboxID: ids[i], Held: true})
			continue
		}
		running := s.meta.State == proto.StateRunning && s.machine != nil
		id, owner, sizeName, pid, dir, agent := s.meta.ID, s.meta.Owner, s.meta.Size, 0, "", s.guest
		if running {
			pid, dir = s.machine.Pid(), s.machine.Dir
		}
		s.mu.Unlock()
		if !running || pid <= 0 {
			continue
		}
		p := usage.Process{SandboxID: id, Owner: owner, Pid: pid, ReadGuest: func(ctx context.Context) (usage.Memory, error) {
			return guestMemory(ctx, dir)
		}}
		if agent != nil {
			// Its disk and IO, which only the guest knows: its agent answers them (an agent from before /stats answers
			// 404, and the sandbox has neither).
			p.ReadStats = func(ctx context.Context) (usage.GuestStats, error) {
				st, err := agent.Stats(ctx)
				if err != nil {
					return usage.GuestStats{}, err
				}
				return usage.GuestStats{DiskUsedBytes: st.DiskUsedBytes, DiskTotalBytes: st.DiskTotalBytes, IOSomeMicros: st.IOSomeMicros}, nil
			}
		}
		if size, err := m.size(sizeName); err == nil {
			p.CPUs = float64(size.VCPUs)
			p.MemLimitBytes = int64(size.MemoryMiB) << 20
		}
		out = append(out, p)
	}
	return out
}

// guestMemory is the guest's MemTotal and MemAvailable as the balloon of the Firecracker in dir last had them from its
// driver; an error for a VM without the balloon's statistics, or before the driver has reported both.
func guestMemory(ctx context.Context, dir string) (usage.Memory, error) {
	stats, err := fc.ReadBalloonStats(ctx, dir)
	if err != nil {
		return usage.Memory{}, err
	}
	if stats.TotalMemory == nil || stats.AvailableMemory == nil {
		return usage.Memory{}, errNoGuestMemory
	}
	return usage.Memory{Total: *stats.TotalMemory, Available: *stats.AvailableMemory}, nil
}

var errNoGuestMemory = errors.New("the guest hasn't reported its memory yet")
