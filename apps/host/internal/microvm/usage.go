package microvm

import (
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// Processes are the running sandboxes' Firecracker processes, each with the vCPUs and memory its size gives it, for
// the host's usage samples. A Firecracker process is the whole VM, its vCPU threads and the VMM's own, so its CPU
// and resident memory are what the sandbox costs the host.
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
		id, owner, sizeName, pid := s.meta.ID, s.meta.Owner, s.meta.Size, 0
		if running {
			pid = s.machine.Pid()
		}
		s.mu.Unlock()
		if !running || pid <= 0 {
			continue
		}
		p := usage.Process{SandboxID: id, Owner: owner, Pid: pid}
		if size, err := m.size(sizeName); err == nil {
			p.CPUs = float64(size.VCPUs)
			p.MemLimitBytes = int64(size.MemoryMiB) << 20
		}
		out = append(out, p)
	}
	return out
}
