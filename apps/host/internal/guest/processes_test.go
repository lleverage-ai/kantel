package guest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// statLine is a /proc/<pid>/stat line for a process named name with utime+stime ticks (all in utime), starttime start
// and rss pages.
func statLine(pid int, name string, ticks, start uint64, rss int64) string {
	return fmt.Sprintf("%d (%s) S 1 1 1 0 -1 4194560 100 0 0 0 %d 0 0 0 20 0 1 0 %d 12345678 %d 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n",
		pid, name, ticks, start, rss)
}

func TestParseProcStatReadsANameWithSpacesAndBrackets(t *testing.T) {
	st, ok := parseProcStat([]byte(statLine(42, "tmux: server (1) )", 250, 900, 3)))
	if !ok {
		t.Fatal("not parsed")
	}
	if st.name != "tmux: server (1) )" || st.ticks != 250 || st.start != 900 || st.rssPages != 3 {
		t.Fatalf("got %+v", st)
	}
	// utime and stime both count.
	raw := "7 (sh) R 1 1 1 0 -1 0 0 0 0 0 30 12 0 0 20 0 1 0 55 0 9 0\n"
	if st, ok := parseProcStat([]byte(raw)); !ok || st.ticks != 42 || st.start != 55 || st.rssPages != 9 {
		t.Fatalf("got %+v, %v", st, ok)
	}
	for _, bad := range []string{"", "1 sh R", "1 (sh) R 1 2 3"} {
		if _, ok := parseProcStat([]byte(bad)); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestTopProcessesRanksByCPUThenMemory(t *testing.T) {
	before := map[int]procStat{
		1:  {name: "init", ticks: 100, start: 1, rssPages: 10},
		10: {name: "yes", ticks: 1000, start: 50, rssPages: 1},
		11: {name: "node", ticks: 500, start: 60, rssPages: 1000},
		// The PID is used again by a new process between the two reads.
		12: {name: "old", ticks: 9000, start: 70, rssPages: 1},
	}
	after := map[int]procStat{
		1:  {name: "init", ticks: 100, start: 1, rssPages: 10},
		10: {name: "yes", ticks: 1100, start: 50, rssPages: 1},
		11: {name: "node", ticks: 525, start: 60, rssPages: 1000},
		12: {name: "new", ticks: 5, start: 900, rssPages: 2},
		// Started between them: all its time counts.
		13: {name: "make", ticks: 50, start: 950, rssPages: 4},
	}
	got := topProcesses(before, after, time.Second, 10)
	want := []struct {
		pid int
		cpu float64
	}{{10, 100}, {13, 50}, {11, 25}, {12, 5}, {1, 0}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i, w := range want {
		if got[i].PID != w.pid || got[i].CPUPercent != w.cpu {
			t.Fatalf("at %d got %+v, want pid %d at %v%%", i, got[i], w.pid, w.cpu)
		}
	}
	if page := int64(os.Getpagesize()); got[2].MemoryBytes != 1000*page {
		t.Fatalf("node's memory %d", got[2].MemoryBytes)
	}
	if top := topProcesses(before, after, time.Second, 2); len(top) != 2 || top[1].PID != 13 {
		t.Fatalf("limited to 2: %+v", top)
	}
	// Equal CPU: the larger first.
	idle := map[int]procStat{2: {rssPages: 1}, 3: {rssPages: 5}}
	if top := topProcesses(idle, idle, time.Second, 2); top[0].PID != 3 {
		t.Fatalf("idle: %+v", top)
	}
}

func TestReadProcessesReadsAProcDirectory(t *testing.T) {
	root := t.TempDir()
	write := func(pid int, file, content string) {
		dir := filepath.Join(root, fmt.Sprint(pid))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(1, "stat", statLine(1, "systemd", 10, 1, 100))
	write(1, "cmdline", "/sbin/init\x00splash\x00")
	write(2, "stat", statLine(2, "kthreadd", 0, 1, 0))
	write(2, "cmdline", "")
	write(3, "stat", statLine(3, "huge", 0, 1, 1))
	write(3, "cmdline", string(make([]byte, 3*MaxCommandBytes)))
	// Not processes.
	write(0, "stat", statLine(0, "zero", 0, 1, 0))
	if err := os.WriteFile(filepath.Join(root, "uptime"), []byte("1 1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "self"), 0o755); err != nil {
		t.Fatal(err)
	}

	list, err := ReadProcesses(context.Background(), root, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if list.Total != 3 || len(list.Processes) != 3 {
		t.Fatalf("got %+v", list)
	}
	if p := list.Processes[0]; p.PID != 1 || p.Command != "/sbin/init splash" {
		t.Fatalf("first %+v", p)
	}
	byPID := map[int]string{}
	for _, p := range list.Processes {
		byPID[p.PID] = p.Command
	}
	if byPID[2] != "[kthreadd]" {
		t.Fatalf("a kernel thread's command %q", byPID[2])
	}
	// All NULs: no arguments, so its name.
	if byPID[3] != "[huge]" {
		t.Fatalf("a command line of NULs %q", byPID[3])
	}

	write(3, "cmdline", longArgs(3*MaxCommandBytes))
	list, _ = ReadProcesses(context.Background(), root, 0, 10)
	for _, p := range list.Processes {
		if p.PID == 3 && len(p.Command) > MaxCommandBytes {
			t.Fatalf("a long command line kept %d bytes", len(p.Command))
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ReadProcesses(ctx, root, time.Minute, 10); err == nil {
		t.Fatal("a cancelled read waited out its sample")
	}
}

func longArgs(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'a'
		if i%10 == 9 {
			b[i] = 0
		}
	}
	return string(b)
}

// GET /processes measures this machine's own /proc: the test's process is among them, and the limit holds.
func TestProcessesRouteListsTheGuestsProcesses(t *testing.T) {
	was := processSample
	processSample = 20 * time.Millisecond
	t.Cleanup(func() { processSample = was })
	s := &Server{}

	rec := httptest.NewRecorder()
	s.processes(rec, httptest.NewRequest("GET", "/processes?limit=500", nil))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var list ProcessList
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if list.Total == 0 || len(list.Processes) == 0 || len(list.Processes) > MaxProcesses || list.SampleMs < 20 {
		t.Fatalf("got %d of %d over %d ms", len(list.Processes), list.Total, list.SampleMs)
	}
	for i := 1; i < len(list.Processes); i++ {
		if list.Processes[i].CPUPercent > list.Processes[i-1].CPUPercent {
			t.Fatalf("not by CPU: %+v", list.Processes)
		}
	}

	rec = httptest.NewRecorder()
	s.processes(rec, httptest.NewRequest("GET", "/processes?limit=1", nil))
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list.Processes) != 1 {
		t.Fatalf("limit=1: %s", rec.Body)
	}

	rec = httptest.NewRecorder()
	s.processes(rec, httptest.NewRequest("GET", "/processes", nil))
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list.Processes) > DefaultProcesses {
		t.Fatalf("no limit: %s", rec.Body)
	}

	for _, bad := range []string{"0", "-1", "ten"} {
		rec = httptest.NewRecorder()
		s.processes(rec, httptest.NewRequest("GET", "/processes?limit="+bad, nil))
		if rec.Code != 400 {
			t.Errorf("limit=%s: status %d", bad, rec.Code)
		}
	}
}
