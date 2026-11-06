package isolate

import (
	"fmt"
	"sort"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/usage"
)

// markBusy notes that a command started running in the sandbox's runtime; the func it answers notes it ended.
// Commands run one at a time per sandbox (exec), so one start is open at most.
func (s *sandbox) markBusy() func() {
	s.mu.Lock()
	s.busySince = time.Now()
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		if !s.busySince.IsZero() {
			s.busy += time.Since(s.busySince)
			s.busySince = time.Time{}
		}
		s.mu.Unlock()
	}
}

// busySeconds is the sandbox's command time so far, the one running now counted up to now. Under mu.
func (s *sandbox) busySeconds(now time.Time) float64 {
	d := s.busy
	if !s.busySince.IsZero() && now.After(s.busySince) {
		d += now.Sub(s.busySince)
	}
	return d.Seconds()
}

// Shared is each account's runtime (its isolate VM, or with the native runtime its workerd) with the account's
// running sandboxes, for the host's usage samples. workerd keeps no account of CPU or memory per isolate that the
// host can read (its WorkerLoader limits only cap a request's CPU), so the runtime's process is measured and shared
// out among its sandboxes (usage.Attribute).
//
// It never waits on a sandbox: one whose lock an operation holds is left out of its account's share this time (Held),
// so the samples go on.
func (m *Manager) Shared() []usage.Shared {
	now := time.Now()
	m.mu.Lock()
	ids := make([]string, 0, len(m.sandboxes))
	list := make([]*sandbox, 0, len(m.sandboxes))
	for id, s := range m.sandboxes {
		ids = append(ids, id)
		list = append(list, s)
	}
	runtimes := map[string]*runtime{}
	for owner, r := range m.runtimes {
		runtimes[owner] = r
	}
	m.mu.Unlock()
	byOwner := map[string][]usage.Busy{}
	held := map[string][]string{}
	// Only the sampler calls Shared, one at a time; usageOwners is the account of each sandbox that was running at the
	// last call, for one whose lock is taken now.
	m.usageMu.Lock()
	defer m.usageMu.Unlock()
	running := make(map[string]string, len(list))
	for i, s := range list {
		if !s.mu.TryLock() {
			if owner, ok := m.usageOwners[ids[i]]; ok {
				held[owner] = append(held[owner], ids[i])
				running[ids[i]] = owner
			}
			continue
		}
		if s.meta.State == proto.StateRunning {
			byOwner[s.meta.Owner] = append(byOwner[s.meta.Owner], usage.Busy{SandboxID: s.meta.ID, Seconds: s.busySeconds(now)})
			running[s.meta.ID] = s.meta.Owner
		}
		s.mu.Unlock()
	}
	m.usageOwners = running
	owners := make([]string, 0, len(byOwner))
	for owner := range byOwner {
		owners = append(owners, owner)
	}
	for owner := range held {
		if _, ok := byOwner[owner]; !ok {
			owners = append(owners, owner)
		}
	}
	sort.Strings(owners)
	out := make([]usage.Shared, 0, len(owners))
	for _, owner := range owners {
		busy := byOwner[owner]
		sort.Slice(busy, func(i, j int) bool { return busy[i].SandboxID < busy[j].SandboxID })
		// An isolate's JavaScript runs on one thread, so one CPU of its runtime is all a sandbox can use: its CPU is a
		// share of one, whatever the VM's vCPUs.
		sh := usage.Shared{Key: "isolate/" + owner, CPUs: 1, Sandboxes: busy, At: now, Held: held[owner]}
		if m.cfg.Runtime != "native" {
			sh.MemLimitBytes = int64(m.cfg.MemoryMiB) << 20
		}
		if r, ok := runtimes[owner]; ok && r.alive() {
			sh.Pid = r.pid()
			sh.Key = fmt.Sprintf("isolate/%s/%s", owner, r.dir)
		}
		out = append(out, sh)
	}
	return out
}

// pid is the runtime's process: its Firecracker, or the native runtime's workerd.
func (r *runtime) pid() int {
	if r.machine != nil {
		return r.machine.Pid()
	}
	if r.proc != nil {
		return r.proc.Pid
	}
	return 0
}
