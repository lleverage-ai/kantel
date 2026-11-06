package guest

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// A microVM has no swap, so when its programs want more memory than it has, the kernel keeps dropping and re-reading
// the pages of their code and mapped files rather than killing anything: the machine runs flat out doing nothing
// useful, for many minutes, and this agent stalls with it ("guest lost"). A type-check of a large monorepo on an 8 GB
// machine did exactly that. The kernel's OOM killer only steps in once nothing at all is left to reclaim.
//
// MemoryWatch steps in earlier: when memory pressure says tasks have spent most of the last ten seconds stalled on
// memory and little memory is left, it has the kernel run its OOM killer now (sysrq f), which kills the process with
// the highest OOM score: the biggest, never this agent (OOMScoreAdjust=-1000). The command whose process it was then
// ends with 137, and its output says why (OOMNote).

// MemoryState is what MemoryWatch decides on.
type MemoryState struct {
	// FullAvg10 is /proc/pressure/memory's "full avg10": the share (0 to 100) of the last ten seconds in which every
	// task that wanted to run was stalled on memory.
	FullAvg10 float64
	// AvailablePercent is MemAvailable as a share (0 to 100) of MemTotal.
	AvailablePercent float64
}

// Thrashing is true when the machine is stuck reclaiming: most of the last ten seconds stalled, and little left.
func (m MemoryState) Thrashing() bool {
	return m.FullAvg10 >= 40 && m.AvailablePercent < 10
}

// MemoryWatch watches memory pressure and runs the kernel's OOM killer when the machine thrashes.
type MemoryWatch struct {
	// Read reads the state; default ReadMemoryState.
	Read func() (MemoryState, error)
	// Kill runs the OOM killer; default writing f to /proc/sysrq-trigger.
	Kill func() error
	// Interval between reads; default 1 s.
	Interval time.Duration
	// Cooldown after a kill, while pressure's ten-second average comes down; default 15 s.
	Cooldown time.Duration
	// Kills counts the kills it asked for.
	Kills atomic.Int64
}

// Run watches until ctx ends. A kernel without memory pressure figures (PSI off) leaves it with nothing to watch.
func (w *MemoryWatch) Run(ctx context.Context) {
	read, kill := w.Read, w.Kill
	if read == nil {
		read = ReadMemoryState
	}
	if kill == nil {
		kill = sysrqOOMKill
	}
	interval, cooldown := w.Interval, w.Cooldown
	if interval <= 0 {
		interval = time.Second
	}
	if cooldown <= 0 {
		cooldown = 15 * time.Second
	}
	if _, err := read(); err != nil {
		log.Printf("memory watch off: %v", err)
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var quietUntil time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if now.Before(quietUntil) {
				continue
			}
			state, err := read()
			if err != nil || !state.Thrashing() {
				continue
			}
			log.Printf("memory watch: thrashing (full avg10 %.0f%%, %.1f%% available): running the OOM killer", state.FullAvg10, state.AvailablePercent)
			if err := kill(); err != nil {
				log.Printf("memory watch: %v", err)
				continue
			}
			w.Kills.Add(1)
			quietUntil = now.Add(cooldown)
		}
	}
}

// StartMemoryWatch runs a MemoryWatch on its own OS thread at a raised priority, so it still runs while the machine
// thrashes. (Not with its pages locked: mlockall would pin Go's whole reserved heap, some 80 MB, a twelfth of a small
// sandbox.) It is best effort: without root (a test) it watches at the usual priority.
func StartMemoryWatch(ctx context.Context, w *MemoryWatch) {
	go func() {
		runtime.LockOSThread()
		// This thread only: on Linux, setpriority with a thread's ID sets that thread's nice value.
		_ = syscall.Setpriority(syscall.PRIO_PROCESS, syscall.Gettid(), -10)
		w.Run(ctx)
	}()
}

func sysrqOOMKill() error {
	return os.WriteFile("/proc/sysrq-trigger", []byte("f"), 0)
}

// ReadMemoryState reads /proc/pressure/memory and /proc/meminfo.
func ReadMemoryState() (MemoryState, error) {
	pressure, err := os.Open("/proc/pressure/memory")
	if err != nil {
		return MemoryState{}, err
	}
	defer pressure.Close()
	full, err := ParsePressureFullAvg10(pressure)
	if err != nil {
		return MemoryState{}, err
	}
	meminfo, err := os.Open("/proc/meminfo")
	if err != nil {
		return MemoryState{}, err
	}
	defer meminfo.Close()
	available, err := ParseAvailablePercent(meminfo)
	if err != nil {
		return MemoryState{}, err
	}
	return MemoryState{FullAvg10: full, AvailablePercent: available}, nil
}

// ParsePressureFullAvg10 reads a /proc/pressure file's "full" line's avg10=.
func ParsePressureFullAvg10(r io.Reader) (float64, error) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 || fields[0] != "full" {
			continue
		}
		for _, field := range fields[1:] {
			if value, ok := strings.CutPrefix(field, "avg10="); ok {
				return strconv.ParseFloat(value, 64)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	return 0, fmt.Errorf("no full avg10")
}

// ParseAvailablePercent reads MemAvailable as a share of MemTotal from /proc/meminfo.
func ParseAvailablePercent(r io.Reader) (float64, error) {
	var total, available float64
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			total = value
		case "MemAvailable:":
			available = value
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, err
	}
	if total <= 0 {
		return 0, fmt.Errorf("no MemTotal")
	}
	return available / total * 100, nil
}

// OOMKills is the kernel's count of OOM kills since boot (/proc/vmstat oom_kill), or -1 when it can't be read.
func OOMKills() int64 {
	f, err := os.Open("/proc/vmstat")
	if err != nil {
		return -1
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if value, ok := strings.CutPrefix(scanner.Text(), "oom_kill "); ok {
			n, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return -1
			}
			return n
		}
	}
	return -1
}

// OOMNote is the line a command's stderr ends with when the kernel killed a process for memory while it ran (before
// is OOMKills() from its start), or "" when it didn't. The process may not have been the command's own; the note
// says so.
func OOMNote(before int64) string {
	if before < 0 {
		return ""
	}
	after := OOMKills()
	if after <= before {
		return ""
	}
	return fmt.Sprintf("\nkantel: this sandbox ran out of memory (%s) while the command ran, and the kernel killed its largest process. Give the sandbox more memory, or run less at once.\n", memTotal())
}

func memTotal() string {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return "of its memory"
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kb, err := strconv.ParseFloat(fields[1], 64)
			if err == nil {
				return fmt.Sprintf("%.1f GB", kb/1024/1024)
			}
		}
	}
	return "of its memory"
}

// ExecCommandVerb is the agent's own subcommand every command starts through: kantel-guest exec-command <path>
// <argv…>.
const ExecCommandVerb = "exec-command"

// ExecCommandMain is exec-command: it sets this process's OOM score adjustment to 0 and becomes the command (path,
// with argv). The agent runs at -1000 so the kernel never kills it for memory, and a child inherits that: without
// this, every command and all it starts could never be killed for memory either, so a command wanting more than the
// machine has stalled it for good rather than being killed. Raising one's own adjustment needs no privilege, so it
// works after the command's user has been taken on. It doesn't return.
func ExecCommandMain(args []string) {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: kantel-guest exec-command <path> <argv0> [args…]")
		os.Exit(2)
	}
	_ = os.WriteFile("/proc/self/oom_score_adj", []byte("0\n"), 0)
	err := syscall.Exec(args[0], args[1:], os.Environ())
	fmt.Fprintf(os.Stderr, "kantel: %s: %v\n", args[0], err)
	os.Exit(127)
}

// setArgv0 sets the argv[0] the command itself sees, whether or not it starts through exec-command.
func setArgv0(cmd *exec.Cmd, name string) {
	if len(cmd.Args) >= 4 && cmd.Args[1] == ExecCommandVerb {
		cmd.Args[3] = name
		return
	}
	cmd.Args[0] = name
}

// UsableTrampoline says whether path can start commands for any user: the file and every directory above it are
// executable by everyone. Commands start as their user, so one that couldn't run the agent's file couldn't start.
func UsableTrampoline(path string) bool {
	for p := path; ; p = filepath.Dir(p) {
		info, err := os.Stat(p)
		if err != nil || info.Mode().Perm()&0o001 == 0 {
			return false
		}
		if p == "/" || p == "." {
			return true
		}
	}
}
