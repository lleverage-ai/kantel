package hostinfo

import "testing"

// The kernel's kill lines, global and at a group's limit, name the process killed: only that PID and name match.
func TestOOMKilledIn(t *testing.T) {
	messages := []string{
		"fc_vcpu 5 invoked oom-killer: gfp_mask=0x140dca(GFP_HIGHUSER_MOVABLE|__GFP_COMP|__GFP_ZERO), order=0, oom_score_adj=0",
		"Out of memory: Killed process 298175 (firecracker) total-vm:25189088kB, anon-rss:25139968kB, file-rss:528kB, shmem-rss:0kB, UID:0 pgtables:49300kB oom_score_adj:0",
		"Memory cgroup out of memory: Killed process 4242 (firecracker) total-vm:1kB, anon-rss:1kB",
		"Out of memory: Killed process 77 (node) total-vm:1kB",
	}
	for _, c := range []struct {
		pid  int
		name string
		want bool
	}{
		{298175, "firecracker", true},
		{4242, "firecracker", true},
		{4242, "", true},
		{29817, "firecracker", false},
		{2981750, "firecracker", false},
		{77, "firecracker", false},
		{77, "node", true},
		{5, "firecracker", false},
	} {
		if got := oomKilledIn(messages, c.pid, c.name); got != c.want {
			t.Errorf("pid %d %q: got %v, want %v", c.pid, c.name, got, c.want)
		}
	}
	if oomKilledIn(nil, 298175, "firecracker") {
		t.Error("an empty log says a process was killed")
	}
}
