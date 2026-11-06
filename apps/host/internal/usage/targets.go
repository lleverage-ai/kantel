package usage

import (
	"context"
	"time"
)

// Process is a running sandbox that is a process of its own on the host (a microVM's Firecracker): its CPU is that
// process's, as a share of the CPUs the sandbox was given. Its memory is what the guest itself counts as used
// (ReadGuest), or, where the guest can't say, the process's resident memory.
type Process struct {
	SandboxID string
	Pid       int
	// CPUs is the sandbox's allocation (its vCPUs); MemLimitBytes the memory its size gives it.
	CPUs          float64
	MemLimitBytes int64
	// ReadGuest, if set, reads the guest's own MemTotal and MemAvailable from outside it (a microVM's balloon
	// statistics, which Firecracker keeps): nothing runs in the guest to answer it. It fails for a VM without them.
	ReadGuest func(ctx context.Context) (Memory, error)
	// ReadStats, if set, asks the guest's agent for its disk and IO pressure: the one reading that runs in the guest.
	ReadStats func(ctx context.Context) (GuestStats, error)
	// Held: the sandbox was mid-operation (its lock taken by a create, snapshot or stop), so it wasn't read this time.
	// It has no figure in this sample, and its counters are kept for the next.
	Held bool
}

// GuestStats is a guest's own disk and IO figures (guest.Stats): its disk as df counts it, and its IO pressure's "some"
// total in microseconds since boot, nil when its kernel has none.
type GuestStats struct {
	DiskUsedBytes  int64
	DiskTotalBytes int64
	IOSomeMicros   *uint64
}

// Shared is a process that runs several sandboxes, which can't be measured apart from the host's side: an account's
// isolate VM (or, with the native runtime, its workerd). Its CPU and memory are shared out among its sandboxes
// (Attribute).
type Shared struct {
	// Key names the process's run for the counters, apart from its pid (an account's VM, then another one).
	Key string
	// Pid is 0 when the account has no process now (its VM was reaped while idle): its sandboxes use nothing.
	Pid int
	// CPUs is what one sandbox in it can use (one, for isolates: their JavaScript runs on one thread), the figure its
	// CPU is a share of. MemLimitBytes is the process's memory (the VM's); 0 is no limit of its own.
	CPUs          float64
	MemLimitBytes int64
	// Sandboxes are its running sandboxes, with the time each has spent running commands so far, as of At.
	Sandboxes []Busy
	At        time.Time
	// Held are sandboxes of its that were mid-operation, so not read this time (as Process.Held).
	Held []string
}

// Busy is a sandbox's time running commands so far, in seconds (the one in progress counted up to now): a counter.
type Busy struct {
	SandboxID string
	Seconds   float64
}

// Attribute shares out a shared process's CPU seconds over an interval among its sandboxes by the time each spent
// running commands in it in that interval (busy, in seconds). With no sandbox busy, none is given any: what the
// process used then (workerd idling, the VM's kernel) was no sandbox's doing. Sandboxes busy at the same time get the
// CPU in proportion to their busy time, which is fair only on average: one busy sandbox spinning and another waiting
// on its files look the same from outside.
func Attribute(cpuSeconds float64, busy map[string]float64) map[string]float64 {
	out := make(map[string]float64, len(busy))
	var total float64
	for id, b := range busy {
		out[id] = 0
		if b > 0 {
			total += b
		}
	}
	if total <= 0 || cpuSeconds <= 0 {
		return out
	}
	for id, b := range busy {
		if b > 0 {
			out[id] = cpuSeconds * b / total
		}
	}
	return out
}
