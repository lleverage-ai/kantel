package agent

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
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
	// historyAnswer caps each output stream of a non-streamed answer, as the guest does (guest.ExecRequest's
	// MaxOutputBytes): the host runs such a command streamed, to keep its real tail, and answers its first bytes.
	historyAnswer = 1 << 20
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

// read is the sandbox's history, oldest first, its newest historyKeep only (none if the file can't be read).
func (l *commandLog) read(sandboxID string) []HistoryEntry {
	all, err := l.readAll(sandboxID)
	if err != nil {
		return nil
	}
	return newest(all)
}

func newest(all []HistoryEntry) []HistoryEntry {
	if len(all) > historyKeep {
		return all[len(all)-historyKeep:]
	}
	return all
}

// readAll is every entry in the sandbox's file, oldest first, or the error reading it. Every line is read, however
// long; one that doesn't decode is skipped, and those after it are still read.
func (l *commandLog) readAll(sandboxID string) ([]HistoryEntry, error) {
	raw, err := os.ReadFile(l.path(sandboxID))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []HistoryEntry
	for line := range bytes.SplitSeq(raw, []byte{'\n'}) {
		var e HistoryEntry
		if len(bytes.TrimSpace(line)) > 0 && json.Unmarshal(line, &e) == nil && e.ID != "" {
			out = append(out, e)
		}
	}
	return out, nil
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
	var all []HistoryEntry
	if !known || n >= 2*historyKeep {
		read, err := l.readAll(sandboxID)
		if err != nil {
			// Not cut back from a file it couldn't read: the entry is added, and the file read again next time.
			delete(l.lines, sandboxID)
			return l.appendLine(sandboxID, line)
		}
		all, n = read, len(read)
	}
	if n < 2*historyKeep {
		if err := l.appendLine(sandboxID, line); err != nil {
			delete(l.lines, sandboxID)
			return err
		}
		l.lines[sandboxID] = n + 1
		return nil
	}
	// Twice the limit, counted from a whole read: keep the newest, written whole.
	var buf bytes.Buffer
	for _, kept := range newest(append(all, e)) {
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
	l.lines[sandboxID] = len(newest(append(all, e)))
	return nil
}

func (l *commandLog) appendLine(sandboxID string, line []byte) error {
	f, err := os.OpenFile(l.path(sandboxID), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(line, '\n'))
	return err
}

// historyPageOutput bounds the output one page carries, well inside a session's message (e2e.MaxControlMessage)
// however its bytes escape in JSON: a page stops early, at one entry at least, rather than outgrow it.
const historyPageOutput = 4 << 20

// page is up to limit entries, newest first, older than the entry before ("" for the newest); without output, their
// stdout and stderr are left out (a list that shows none needs none).
func (l *commandLog) page(sandboxID, before string, limit int, output bool) HistoryPage {
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
	carried := 0
	for i := end - 1; i >= 0 && len(out.Items) < limit; i-- {
		e := all[i]
		if !output {
			e.Stdout, e.Stderr = "", ""
		}
		size := len(e.Stdout) + len(e.Stderr) + len(e.Command)
		for _, arg := range e.Argv {
			size += len(arg)
		}
		if len(out.Items) > 0 && carried+size > historyPageOutput {
			break
		}
		carried += size
		out.Items = append(out.Items, e)
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

// outputHead keeps the first max bytes of a command's output, as a non-streamed answer has them.
type outputHead struct {
	b         []byte
	max       int
	truncated bool
}

func (h *outputHead) write(s string) {
	if room := h.max - len(h.b); len(s) > room {
		h.b = append(h.b, s[:max(room, 0)]...)
		h.truncated = true
		return
	}
	h.b = append(h.b, s...)
}

// clip keeps the first n bytes of s, saying if it cut any.
func clip(s string, n int) (string, bool) {
	if len(s) <= n {
		return s, false
	}
	return s[:n], true
}

// StreamEncoding is how a tier's streamed output chunks are written: the microVM guest's are base64 (guest's
// streamPipe); an isolate's are its text.
type StreamEncoding int

const (
	StreamText StreamEncoding = iota
	StreamBase64
)

// text is a streamed chunk as the bytes it stands for, by its tier's encoding, never by what it looks like.
func (enc StreamEncoding) text(s string) string {
	if enc != StreamBase64 || s == "" {
		return s
	}
	if raw, err := base64.StdEncoding.DecodeString(s); err == nil {
		return string(raw)
	}
	// Not the guest's base64 after all: kept as it came rather than lost.
	return s
}

func historyID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "cmd_" + hex.EncodeToString(b[:])
}

// runLogged runs a device's exec through run and records it in the sandbox's history, output included.
//
// The output kept is the real tail of each stream. A tier whose non-streamed answer is cut to its first bytes (the
// guest's, enc StreamBase64) is run streamed here, unseen by the device: the host keeps the tail and answers the
// device as the tier would have, with the first historyAnswer bytes. The exit code is kept only for a command that
// finished: not for one that failed to run, nor a detached one, which has only started.
func (l *commandLog) runLogged(sandboxID string, by HistoryEntry, params []byte, enc StreamEncoding, run func(params []byte, onEvent func(proto.Event)) (any, error), emit func(proto.Event)) (any, error) {
	var p proto.ExecParams
	_ = json.Unmarshal(params, &p)
	e := by
	e.ID, e.Cwd, e.User, e.Detached = historyID(), p.Cwd, p.User, p.Detached
	var cut bool
	e.Command, cut = clip(p.Command, historyOutput)
	e.Argv, e.Truncated = clipArgv(p.Argv)
	e.Truncated = e.Truncated || cut
	e.StartedAt = time.Now().UnixMilli()
	var stdout, stderr outputTail
	var mu sync.Mutex
	// Run streamed for its tail, answered whole.
	quiet := enc == StreamBase64 && !p.Stream && !p.Detached
	var headOut, headErr outputHead
	if quiet {
		headOut.max, headErr.max = historyAnswer, historyAnswer
		p.Stream = true
		params, _ = json.Marshal(p)
	}
	result, err := run(params, func(ev proto.Event) {
		if ev.Kind == "exec.output" {
			out, errOut := enc.text(ev.Stdout), enc.text(ev.Stderr)
			mu.Lock()
			stdout.write(out)
			stderr.write(errOut)
			if quiet {
				headOut.write(out)
				headErr.write(errOut)
			}
			mu.Unlock()
			if quiet {
				return
			}
		}
		emit(ev)
	})
	e.EndedAt = time.Now().UnixMilli()
	mu.Lock()
	defer mu.Unlock()
	if r, ok := result.(proto.ExecResult); ok {
		if quiet {
			r.Stdout, r.Stderr = string(headOut.b), string(headErr.b)
			r.Truncated = headOut.truncated || headErr.truncated
			result = r
		}
		if err == nil && !p.Detached {
			code := r.ExitCode
			e.ExitCode, e.TimedOut = &code, r.TimedOut
		}
		// A command whose output came in no events (not streamed, or an isolate's): its answer's output, which is
		// whole for those tiers. A detached one's is where its log went, not output.
		if len(stdout.b) == 0 && len(stderr.b) == 0 && !p.Detached {
			stdout.write(r.Stdout)
			stderr.write(r.Stderr)
			e.Truncated = e.Truncated || r.Truncated
		}
	}
	if err != nil {
		e.Error = err.Error()
	}
	e.Stdout, e.Stderr = string(stdout.b), string(stderr.b)
	e.Truncated = e.Truncated || stdout.truncated || stderr.truncated
	_ = l.add(sandboxID, e)
	return result, err
}

// clipArgv keeps argv's first arguments up to historyOutput bytes in all, the one that crosses it cut.
func clipArgv(argv []string) ([]string, bool) {
	var out []string
	room := historyOutput
	for i, arg := range argv {
		kept, cut := clip(arg, room)
		out = append(out, kept)
		room -= len(kept)
		if cut || (room == 0 && i < len(argv)-1) {
			return out, true
		}
	}
	return out, false
}
