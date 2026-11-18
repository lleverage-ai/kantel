package hostinfo

import (
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

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

// The reader answers at the log's end as it is now, with its writer still open: it never waits for the next record,
// whether the record it wants is there or not.
func TestKmsgMessagesReturnsAtTheEnd(t *testing.T) {
	var fds [2]int
	if err := unix.Pipe2(fds[:], unix.O_NONBLOCK|unix.O_CLOEXEC); err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fds[0])
	defer unix.Close(fds[1])
	for _, record := range []string{
		"6,100,5,-;fc_vcpu 5 invoked oom-killer: order=0\n",
		"3,101,6,-;Out of memory: Killed process 298175 (firecracker) total-vm:1kB\n",
	} {
		if _, err := unix.Write(fds[1], []byte(record)); err != nil {
			t.Fatal(err)
		}
	}
	done := make(chan []string, 1)
	go func() { done <- kmsgMessages(fds[0]) }()
	select {
	case messages := <-done:
		if !oomKilledIn(messages, 298175, "firecracker") || oomKilledIn(messages, 4242, "firecracker") {
			t.Fatalf("messages %q", messages)
		}
		if messages[0] != "fc_vcpu 5 invoked oom-killer: order=0" {
			t.Fatalf("the record's prefix wasn't taken off: %q", messages[0])
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the reader waited for another record")
	}
	// Nothing at all to read: it answers at once too.
	go func() { done <- kmsgMessages(fds[0]) }()
	select {
	case messages := <-done:
		if len(messages) != 0 {
			t.Fatalf("messages %q from an empty log", messages)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the reader waited on an empty log")
	}
}
