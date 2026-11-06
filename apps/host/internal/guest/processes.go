package guest

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Process is one of the guest's processes as GET /processes lists it: what `top` would show of it.
type Process struct {
	PID int `json:"pid"`
	// Command is its command line, its arguments joined by spaces (at most MaxCommandBytes of it), or its name in
	// brackets, as ps writes a kernel thread's, where it has none.
	Command string `json:"command"`
	// CPUPercent is its CPU over the sample, as a share of one vCPU in percent: 150 is one and a half.
	CPUPercent float64 `json:"cpuPercent"`
	// MemoryBytes is its resident memory (RSS).
	MemoryBytes int64 `json:"memoryBytes"`
}

// ProcessList is GET /processes' answer: the busiest processes, by CPU (then memory), most first.
type ProcessList struct {
	Processes []Process `json:"processes"`
	// Total is how many processes the guest has.
	Total int `json:"total"`
	// SampleMs is how long the CPU was measured over.
	SampleMs int64 `json:"sampleMs"`
}

const (
	// DefaultProcesses and MaxProcesses are how many GET /processes lists without a limit, and at most.
	DefaultProcesses = 10
	MaxProcesses     = 50
	// MaxCommandBytes is the most of a command line it answers.
	MaxCommandBytes = 1024
	// userHZ is the clock tick /proc/<pid>/stat counts CPU time in: USER_HZ, 100 on every Linux Kantel runs on.
	userHZ = 100
)

// processSample is how long GET /processes measures CPU over. It is polled while a console's metrics dialog is open
// (every 10 seconds), so it reads /proc twice this far apart and keeps nothing between calls.
var processSample = 500 * time.Millisecond

// processes answers ProcessList (?limit=, DefaultProcesses unless given, at most MaxProcesses).
func (s *Server) processes(w http.ResponseWriter, r *http.Request) {
	limit := DefaultProcesses
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			fail(w, http.StatusBadRequest, errors.New("limit is a whole number of at least 1"))
			return
		}
		limit = min(n, MaxProcesses)
	}
	list, err := ReadProcesses(r.Context(), "/proc", processSample, limit)
	if err != nil {
		fail(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, 200, list)
}

// procStat is what one read of /proc/<pid>/stat says of a process.
type procStat struct {
	name string
	// ticks is its user and system CPU time, in userHZ ticks; start when it started, in ticks after boot, which tells a
	// PID used again from the process that had it.
	ticks, start uint64
	// rssPages is its resident set, in pages.
	rssPages int64
}

// ReadProcesses measures the processes under root (a /proc) over sample and answers the limit busiest, by CPU then
// memory. A process that ends meanwhile is left out; one that starts meanwhile counts all its CPU time.
func ReadProcesses(ctx context.Context, root string, sample time.Duration, limit int) (ProcessList, error) {
	before, err := readProcStats(root)
	if err != nil {
		return ProcessList{}, err
	}
	began := time.Now()
	select {
	case <-ctx.Done():
		return ProcessList{}, ctx.Err()
	case <-time.After(sample):
	}
	after, err := readProcStats(root)
	if err != nil {
		return ProcessList{}, err
	}
	elapsed := time.Since(began)
	out := ProcessList{Total: len(after), SampleMs: elapsed.Milliseconds(), Processes: []Process{}}
	for _, p := range topProcesses(before, after, elapsed, limit) {
		p.Command = commandOf(root, p.PID, after[p.PID].name)
		out.Processes = append(out.Processes, p)
	}
	return out, nil
}

// topProcesses ranks the processes in after by their CPU since before over elapsed, then by memory, then by PID, and
// answers the first limit, their commands not yet filled in.
func topProcesses(before, after map[int]procStat, elapsed time.Duration, limit int) []Process {
	page := int64(os.Getpagesize())
	seconds := elapsed.Seconds()
	all := make([]Process, 0, len(after))
	for pid, now := range after {
		used := now.ticks
		if was, ok := before[pid]; ok && was.start == now.start && was.ticks <= now.ticks {
			used = now.ticks - was.ticks
		}
		cpu := 0.0
		if seconds > 0 {
			cpu = float64(used) / userHZ / seconds * 100
		}
		all = append(all, Process{PID: pid, CPUPercent: round1(cpu), MemoryBytes: now.rssPages * page})
	}
	sort.Slice(all, func(i, j int) bool {
		a, b := all[i], all[j]
		if a.CPUPercent != b.CPUPercent {
			return a.CPUPercent > b.CPUPercent
		}
		if a.MemoryBytes != b.MemoryBytes {
			return a.MemoryBytes > b.MemoryBytes
		}
		return a.PID < b.PID
	})
	return all[:min(limit, len(all))]
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }

// readProcStats reads every process's stat under root. A process gone before its file is read is left out.
func readProcStats(root string) (map[int]procStat, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	out := make(map[int]procStat, len(entries))
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(root, e.Name(), "stat"))
		if err != nil {
			continue
		}
		if st, ok := parseProcStat(raw); ok {
			out[pid] = st
		}
	}
	return out, nil
}

// parseProcStat reads a /proc/<pid>/stat line (proc(5)): the name is between the first "(" and the last ")", as a
// name may hold spaces and brackets; after it, utime and stime are fields 14 and 15, starttime 22 and rss 24.
func parseProcStat(raw []byte) (procStat, bool) {
	open, end := bytes.IndexByte(raw, '('), bytes.LastIndexByte(raw, ')')
	if open < 0 || end < open {
		return procStat{}, false
	}
	// Fields from 3 (state) on.
	rest := strings.Fields(string(raw[end+1:]))
	if len(rest) < 22 {
		return procStat{}, false
	}
	field := func(n int) uint64 {
		v, _ := strconv.ParseUint(rest[n-3], 10, 64)
		return v
	}
	rss, _ := strconv.ParseInt(rest[24-3], 10, 64)
	return procStat{
		name:     string(raw[open+1 : end]),
		ticks:    field(14) + field(15),
		start:    field(22),
		rssPages: max(0, rss),
	}, true
}

// commandOf is a process's command line, its arguments joined by spaces, or "[name]" for one with none (a kernel
// thread, or a zombie).
func commandOf(root string, pid int, name string) string {
	raw, err := readAtMost(filepath.Join(root, strconv.Itoa(pid), "cmdline"), MaxCommandBytes)
	if err == nil {
		if line := strings.TrimSpace(strings.ReplaceAll(string(bytes.TrimRight(raw, "\x00")), "\x00", " ")); line != "" {
			return line
		}
	}
	return "[" + name + "]"
}

func readAtMost(path string, n int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, n)
	read := 0
	for read < n {
		m, err := f.Read(buf[read:])
		read += m
		if err != nil {
			break
		}
	}
	return buf[:read], nil
}
