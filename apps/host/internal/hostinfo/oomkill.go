package hostinfo

import (
	"errors"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
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
	f, err := os.OpenFile("/dev/kmsg", os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	return oomKilledIn(kmsgMessages(f), pid, name)
}

// kmsgMessages reads /dev/kmsg's records to its end (EAGAIN): each record's message, its "prefix;" taken off. A record
// overwritten while it was read (EPIPE) is skipped.
func kmsgMessages(f *os.File) []string {
	var out []string
	buf := make([]byte, 8192)
	for {
		n, err := f.Read(buf)
		if err != nil {
			if errors.Is(err, syscall.EPIPE) {
				continue
			}
			return out
		}
		record := string(buf[:n])
		if i := strings.IndexByte(record, ';'); i >= 0 {
			record = record[i+1:]
		}
		out = append(out, strings.TrimRight(record, "\n"))
	}
}

// oomKilledIn says whether one of the kernel's messages says it killed pid running name.
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
