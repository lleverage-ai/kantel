package hostinfo

import (
	"errors"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// killedProcess is the kernel's line for a process its out-of-memory killer ended, global or at a group's limit:
// "Out of memory: Killed process 298175 (firecracker) total-vm:…" or "Memory cgroup out of memory: Killed process …".
var killedProcess = regexp.MustCompile(`Killed process (\d+) \(([^)]*)\)`)

// OOMKilled says whether the kernel's log, as /dev/kmsg still holds it, says its out-of-memory killer ended process pid
// running name (such as "firecracker"). It reads the log only, so it answers for a process that ended before this one
// started: a VM the kernel killed while kantel-host was restarting. A log that can't be read says no.
func OOMKilled(pid int, name string) bool {
	if pid <= 0 {
		return false
	}
	fd, err := unix.Open("/dev/kmsg", unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return false
	}
	defer unix.Close(fd)
	return oomKilledIn(kmsgMessages(fd), pid, name)
}

// kmsgMessages reads a non-blocking descriptor of /dev/kmsg up to the log's end as it is now (EAGAIN), with read(2)
// itself: an *os.File of a pollable device would wait in Go's poller for the next record instead. Each read is one
// record, "prefix;message", whose message it answers; a record overwritten while it was read (EPIPE) is skipped.
func kmsgMessages(fd int) []string {
	var out []string
	buf := make([]byte, 8192)
	for {
		n, err := unix.Read(fd, buf)
		if errors.Is(err, unix.EINTR) || errors.Is(err, unix.EPIPE) {
			continue
		}
		if err != nil || n <= 0 {
			return out
		}
		// One record per read from /dev/kmsg; split anyway, so a descriptor that joins them (a pipe) reads the same.
		for _, record := range strings.Split(strings.TrimRight(string(buf[:n]), "\n"), "\n") {
			if i := strings.IndexByte(record, ';'); i >= 0 {
				record = record[i+1:]
			}
			out = append(out, record)
		}
	}
}

// oomKilledIn says whether one of the kernel's messages says it killed pid running name ("" for any).
func oomKilledIn(messages []string, pid int, name string) bool {
	want := strconv.Itoa(pid)
	for _, message := range messages {
		m := killedProcess.FindStringSubmatch(message)
		if m != nil && m[1] == want && (name == "" || m[2] == name) {
			return true
		}
	}
	return false
}
