package agent

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// The command history of E2E sandboxes is kept on the host, not on the gateway: a device's commands and their output
// never reach the gateway in plaintext, so it couldn't keep them, and the host is the one place that sees both.
// A device reads it back in a session (MethodHistory). Each sandbox keeps its last historyKeep commands, each with the
// last historyOutput bytes of its stdout and stderr, in <Root>/e2e/history/<sandbox>.jsonl (root only). Deleting the
// sandbox deletes its history.
const (
	historyKeep   = 200
	historyOutput = 64 << 10
)

// MethodHistory is a session's own method: the host answers it from its log, with no tier call.
const MethodHistory = "sandbox.history"

// HistoryEntry is one command a device ran in an E2E session.
type HistoryEntry struct {
	ID        string   `json:"id"`
	Command   string   `json:"command,omitempty"`
	Argv      []string `json:"argv,omitempty"`
	Cwd       string   `json:"cwd,omitempty"`
	User      string   `json:"user,omitempty"`
	Detached  bool     `json:"detached,omitempty"`
	StartedAt int64    `json:"startedAt"`
	EndedAt   int64    `json:"endedAt"`
	// ExitCode is nil when the command didn't finish (an error, or the session ended).
	ExitCode  *int   `json:"exitCode,omitempty"`
	TimedOut  bool   `json:"timedOut,omitempty"`
	Error     string `json:"error,omitempty"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated bool   `json:"truncated,omitempty"`
	// Device is who ran it: the chain's device ID and label, and the member it belongs to.
	Device      string `json:"device"`
	DeviceLabel string `json:"deviceLabel,omitempty"`
	DeviceClass string `json:"deviceClass,omitempty"`
	Member      string `json:"member,omitempty"`
}

// HistoryPage is MethodHistory's result: newest first.
type HistoryPage struct {
	Items []HistoryEntry `json:"items"`
	// Next is the ID to pass as before for the next page, "" at the end.
	Next string `json:"next,omitempty"`
}

type commandLog struct {
	dir string
	mu  sync.Mutex
	// lines counts each sandbox's file's entries, once it has been read: a file is let grow to twice historyKeep
	// before it is cut back, so a command costs an append, not a rewrite.
	lines map[string]int
}

func newCommandLog(root string) *commandLog {
	return &commandLog{dir: filepath.Join(root, "e2e", "history"), lines: map[string]int{}}
}

func (l *commandLog) path(sandboxID string) string {
	return filepath.Join(l.dir, sandboxID+".jsonl")
}

// read is the sandbox's history, oldest first, its newest historyKeep only.
func (l *commandLog) read(sandboxID string) []HistoryEntry {
	all := l.readAll(sandboxID)
	if len(all) > historyKeep {
		return all[len(all)-historyKeep:]
	}
	return all
}

// readAll is every entry in the sandbox's file, oldest first. A line that doesn't decode is skipped.
func (l *commandLog) readAll(sandboxID string) []HistoryEntry {
	raw, err := os.ReadFile(l.path(sandboxID))
	if err != nil {
		return nil
	}
	var out []HistoryEntry
	sc := bufio.NewScanner(bytes.NewReader(raw))
	// Two outputs, JSON-escaped (a control byte takes six).
	sc.Buffer(make([]byte, 0, 64<<10), 16*historyOutput)
	for sc.Scan() {
		var e HistoryEntry
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.ID != "" {
			out = append(out, e)
		}
	}
	return out
}

func (l *commandLog) add(sandboxID string, e HistoryEntry) error {
	if !validSandboxID(sandboxID) {
		return nil
	}
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(l.dir, 0o700); err != nil {
		return err
	}
	n, known := l.lines[sandboxID]
	if !known {
		n = len(l.readAll(sandboxID))
	}
	if n < 2*historyKeep {
		f, err := os.OpenFile(l.path(sandboxID), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		if _, err := f.Write(append(line, '\n')); err != nil {
			delete(l.lines, sandboxID)
			return err
		}
		l.lines[sandboxID] = n + 1
		return nil
	}
	// Twice the limit: keep the newest, written whole.
	all := append(l.readAll(sandboxID), e)
	var buf bytes.Buffer
	for _, kept := range all[len(all)-historyKeep:] {
		raw, _ := json.Marshal(kept)
		buf.Write(raw)
		buf.WriteByte('\n')
	}
	tmp := l.path(sandboxID) + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, l.path(sandboxID)); err != nil {
		delete(l.lines, sandboxID)
		return err
	}
	l.lines[sandboxID] = historyKeep
	return nil
}

// page is up to limit entries, newest first, older than the entry before ("" for the newest).
func (l *commandLog) page(sandboxID, before string, limit int) HistoryPage {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	l.mu.Lock()
	all := l.read(sandboxID)
	l.mu.Unlock()
	end := len(all)
	if before != "" {
		end = 0
		for i, e := range all {
			if e.ID == before {
				end = i
				break
			}
		}
	}
	out := HistoryPage{Items: []HistoryEntry{}}
	for i := end - 1; i >= 0 && len(out.Items) < limit; i-- {
		out.Items = append(out.Items, all[i])
	}
	if n := len(out.Items); n > 0 && end-n > 0 {
		out.Next = out.Items[n-1].ID
	}
	return out
}

func (l *commandLog) forget(sandboxID string) {
	if !validSandboxID(sandboxID) {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.lines, sandboxID)
	_ = os.Remove(l.path(sandboxID))
}

// validSandboxID keeps an ID from naming a path outside the log's folder.
func validSandboxID(id string) bool {
	return id != "" && len(id) <= 128 && !strings.ContainsAny(id, "/\\\x00") && id != "." && id != ".."
}

// outputTail keeps the last historyOutput bytes of a command's output.
type outputTail struct {
	b         []byte
	truncated bool
}

func (t *outputTail) write(s string) {
	t.b = append(t.b, s...)
	if over := len(t.b) - historyOutput; over > 0 {
		t.b = append([]byte{}, t.b[over:]...)
		t.truncated = true
	}
}

// streamed is a streamed output chunk as text: the guest sends base64, an isolate its text.
func streamed(s string) string {
	if raw, err := base64.StdEncoding.DecodeString(s); err == nil {
		return string(raw)
	}
	return s
}

func historyID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "cmd_" + hex.EncodeToString(b[:])
}

// runLogged runs a device's exec through run and records it in the sandbox's history, output included.
func (l *commandLog) runLogged(sandboxID string, by HistoryEntry, params []byte, run func(onEvent func(proto.Event)) (any, error), emit func(proto.Event)) (any, error) {
	var p proto.ExecParams
	_ = json.Unmarshal(params, &p)
	e := by
	e.ID, e.Command, e.Argv, e.Cwd, e.User, e.Detached = historyID(), p.Command, p.Argv, p.Cwd, p.User, p.Detached
	e.StartedAt = time.Now().UnixMilli()
	var stdout, stderr outputTail
	var mu sync.Mutex
	result, err := run(func(ev proto.Event) {
		if ev.Kind == "exec.output" {
			mu.Lock()
			stdout.write(streamed(ev.Stdout))
			stderr.write(streamed(ev.Stderr))
			mu.Unlock()
		}
		emit(ev)
	})
	e.EndedAt = time.Now().UnixMilli()
	mu.Lock()
	if r, ok := result.(proto.ExecResult); ok {
		code := r.ExitCode
		e.ExitCode, e.TimedOut = &code, r.TimedOut
		// A streamed command's result carries no output of its own: what came in events stands.
		if len(stdout.b) == 0 && len(stderr.b) == 0 {
			stdout.write(r.Stdout)
			stderr.write(r.Stderr)
		}
		e.Truncated = r.Truncated
	}
	if err != nil {
		e.Error = err.Error()
	}
	e.Stdout, e.Stderr = string(stdout.b), string(stderr.b)
	e.Truncated = e.Truncated || stdout.truncated || stderr.truncated
	mu.Unlock()
	_ = l.add(sandboxID, e)
	return result, err
}
