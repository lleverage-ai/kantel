package guest

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// A command run with an ID keeps its whole output on the sandbox's own disk too, past the MaxOutputBytes its status and
// answer hold: each stream up to OutputKeepBytes, in OutputDir/<id>/stdout and stderr, and an end file once it ends.
// The disk is the sandbox's, so the output outlives the agent, a reboot, a stop and a crash of the machine (all but
// what came in the last OutputSyncEvery, which may not be synced yet: a command with no end file reads as cut), and
// goes with the sandbox when it is deleted. GET
// /exec/{id}/output reads any part of it, while the command runs and after it ends. A guest from before answers that
// route 404 (IsUnknownRoute).

// OutputDir is where kantel-guest keeps commands' output: on the sandbox's disk (/disk, outside its overlay root), read
// by root only.
const OutputDir = "/disk/kantel/commands"

// OutputKeepBytes is how much of each of a command's stdout and stderr is kept on the disk: the rest is dropped, and
// the stream marked cut.
const OutputKeepBytes = 64 << 20

// OutputKeepTotal is the most output a sandbox keeps across its commands: a new command's start drops the oldest ended
// commands' output to leave room for its own, and a stream that would take what is kept past it is cut there (commands
// running at once share it). OutputKeepCommands is how many commands' output is kept, the oldest ended ones' dropped
// likewise (commands still running are never dropped, so as many more may be kept as run at once).
const (
	OutputKeepTotal    = 1 << 30
	OutputKeepCommands = 10_000
)

// MaxOutputRead is the most of a stream one GET /exec/{id}/output answers.
const MaxOutputRead = 1 << 20

// OutputSyncEvery is how often a stream being written is synced to the disk, at most: what a crash of the machine
// can lose of it.
const OutputSyncEvery = 2 * time.Second

// Stream names.
const (
	StreamStdout = "stdout"
	StreamStderr = "stderr"
)

// outputEndFile, in a command's directory, says it ended, and whether each stream was cut.
const outputEndFile = "end"

// outputEnd is a command's end file.
type outputEnd struct {
	StdoutCut bool `json:"stdoutCut,omitempty"`
	StderrCut bool `json:"stderrCut,omitempty"`
}

// CommandOutput is GET /exec/{id}/output's answer: a part of one of a command's streams as the disk keeps it.
// Known is false for a command whose output isn't kept (an ID the agent never ran, one whose output was dropped, or
// one that started when its directory couldn't be made); the rest is then empty.
type CommandOutput struct {
	Known bool `json:"known"`
	// Data is the part's bytes, base64: at most the length asked for (at most MaxOutputRead) from Offset.
	Data string `json:"data,omitempty"`
	// Offset is where the part starts: the offset asked for, or Size when that is past it.
	Offset int64 `json:"offset"`
	// Size is how much of the stream is kept now. It only grows while the command runs.
	Size int64 `json:"size"`
	// Ended: the command has ended, so Size is the stream's whole kept size.
	Ended bool `json:"ended,omitempty"`
	// Cut: the rest may be missing: the stream went past Limit or OutputKeepTotal, or the disk refused it, and what came
	// after was dropped; or the command ended with its machine or agent before its end file was written.
	Cut bool `json:"cut,omitempty"`
	// Limit is OutputKeepBytes.
	Limit int64 `json:"limit"`
}

// outputLog is one stream of a command, appended to its file as it comes, up to max. It never fails a write: past its
// limit, past what all commands may keep, or with a disk that refuses a write or a sync, the log stops for good, marked
// cut, so what it kept is always the start of the stream; the command carries on.
type outputLog struct {
	mu     sync.Mutex
	f      *os.File
	n      int64
	max    int64
	cut    bool
	synced time.Time
	// used is what all commands' kept output takes, and total its most (outputs.used): a write past it is cut.
	used  *atomic.Int64
	total int64
	// later syncs what a write left unsynced, OutputSyncEvery after the last sync: output that comes in a burst, then
	// stops, is on the disk within that too.
	later *time.Timer
}

func (l *outputLog) Write(p []byte) (int, error) {
	if l == nil {
		return len(p), nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	// Cut, it keeps nothing more, whatever room comes later: what it kept stays the start of the stream.
	if l.f == nil || l.cut {
		return len(p), nil
	}
	write, cutting := p, false
	if room := l.max - l.n; int64(len(write)) > room {
		write, cutting = write[:max(room, 0)], true
	}
	if taken := l.take(int64(len(write))); taken < int64(len(write)) {
		write, cutting = write[:taken], true
	}
	if len(write) > 0 {
		n, err := l.f.Write(write)
		l.n += int64(n)
		if n < len(write) && l.used != nil {
			l.used.Add(int64(n - len(write)))
		}
		cutting = cutting || err != nil
	}
	if cutting {
		l.cutLocked()
		return len(p), nil
	}
	if since := time.Since(l.synced); since >= OutputSyncEvery {
		l.syncLocked()
	} else if l.later == nil {
		l.later = time.AfterFunc(OutputSyncEvery-since, func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.later = nil
			l.syncLocked()
		})
	}
	return len(p), nil
}

// take takes up to n bytes of what all commands may keep, answering how many it took.
func (l *outputLog) take(n int64) int64 {
	if l.used == nil || n <= 0 {
		return n
	}
	for {
		used := l.used.Load()
		taken := min(n, l.total-used)
		if taken <= 0 {
			return 0
		}
		if l.used.CompareAndSwap(used, used+taken) {
			return taken
		}
	}
}

// syncLocked syncs the file, if it is open; one the disk won't sync is cut. l.mu is held.
func (l *outputLog) syncLocked() {
	if l.f != nil && l.f.Sync() != nil {
		l.cutLocked()
		return
	}
	l.synced = time.Now()
}

// cutLocked marks the stream cut and closes it: it keeps nothing more. l.mu is held.
func (l *outputLog) cutLocked() {
	l.cut = true
	l.closeLocked()
}

// isCut says the stream went past its limit, or its disk refused it.
func (l *outputLog) isCut() bool {
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cut
}

func (l *outputLog) close() {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closeLocked()
}

// closeLocked syncs and closes the file; one the disk won't sync is cut. l.mu is held.
func (l *outputLog) closeLocked() {
	if l.later != nil {
		l.later.Stop()
		l.later = nil
	}
	if l.f == nil {
		return
	}
	f := l.f
	l.f = nil
	failed := f.Sync() != nil
	_ = f.Close()
	if failed {
		l.cutLocked()
	}
}

// commandOutput is a command's two kept streams.
type commandOutput struct {
	id, dir        string
	stdout, stderr *outputLog
	// kept is the agent's index of kept output, told its size once it ends.
	kept *outputs
}

// streams are its stdout and stderr logs: nil, keeping nothing, for no output.
func (o *commandOutput) streams() (*outputLog, *outputLog) {
	if o == nil {
		return nil, nil
	}
	return o.stdout, o.stderr
}

// tee is w, writing to log too.
func tee(w io.Writer, log *outputLog) io.Writer {
	if log == nil {
		return w
	}
	return io.MultiWriter(w, log)
}

// size is how much of the stream is on the disk.
func (l *outputLog) size() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.n
}

// finish closes the streams and writes the end file: the command has ended. Once only: a second call does nothing.
// Done under outputs.mu, so a start's pruning sees it running or ended, with its end's size and time, never between.
func (o *commandOutput) finish() {
	if o == nil {
		return
	}
	o.kept.mu.Lock()
	defer o.kept.mu.Unlock()
	k, ok := o.kept.index[o.id]
	if !ok || k.live != o {
		return
	}
	o.stdout.close()
	o.stderr.close()
	end := outputEnd{StdoutCut: o.stdout.isCut(), StderrCut: o.stderr.isCut()}
	raw, _ := json.Marshal(end)
	_ = os.WriteFile(filepath.Join(o.dir, outputEndFile), raw, 0o600)
	k.live, k.end = nil, &end
	k.bytes, k.at = o.stdout.size()+o.stderr.size(), time.Now()
}

// outputs is the agent's index of the output it keeps, made from the disk at the first command's start.
type outputs struct {
	mu      sync.Mutex
	scanned bool
	index   map[string]*keptOutput
	// used is the bytes the index's output takes on the disk, running commands' as they write.
	used atomic.Int64
	// stream, total and commands replace OutputKeepBytes, OutputKeepTotal and OutputKeepCommands where set (tests).
	stream, total int64
	commands      int
}

// keptOutput is one command's output on the disk: its streams' size once it ended (live while it runs), and when it
// ended.
type keptOutput struct {
	id    string
	bytes int64
	at    time.Time
	// live is its streams while it runs.
	live *commandOutput
	// end is what its end file says, once it has ended here: kept should the disk have refused the file.
	end *outputEnd
}

// limits are what the agent keeps: of each stream, in all, and how many commands' output.
func (o *outputs) limits() (stream, total int64, commands int) {
	stream, total, commands = OutputKeepBytes, OutputKeepTotal, OutputKeepCommands
	if o.stream > 0 {
		stream = o.stream
	}
	if o.total > 0 {
		total = o.total
	}
	if o.commands > 0 {
		commands = o.commands
	}
	return stream, total, commands
}

// openOutput makes the directory for a command's output, after dropping the oldest ended commands' output past
// OutputKeepTotal (leaving room for this one's) and OutputKeepCommands. Nil when the agent keeps no output
// (OutputDir unset) or the directory couldn't be made: the command runs as before, with what its answer holds.
func (s *Server) openOutput(id string) *commandOutput {
	if s.OutputDir == "" {
		return nil
	}
	o := &s.outputs
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := os.MkdirAll(s.OutputDir, 0o700); err != nil {
		return nil
	}
	if !o.scanned {
		var used int64
		o.index, used = scanOutput(s.OutputDir)
		o.used.Store(used)
		o.scanned = true
	}
	stream, total, commands := o.limits()
	s.pruneOutput(total-2*stream, commands-1)
	dir, ok := s.outputDirOf(id)
	if !ok {
		return nil
	}
	// A directory left for this ID (a start refused, then sent again) is replaced: its output is this run's.
	if k, ok := o.index[id]; ok {
		if k.live != nil {
			return nil
		}
		o.used.Add(-k.bytes)
		delete(o.index, id)
	}
	_ = os.RemoveAll(dir)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return nil
	}
	open := func(name string) *outputLog {
		f, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return nil
		}
		return &outputLog{f: f, max: stream, synced: time.Now(), used: &o.used, total: total}
	}
	out := &commandOutput{id: id, dir: dir, stdout: open(StreamStdout), stderr: open(StreamStderr), kept: o}
	if out.stdout == nil || out.stderr == nil {
		out.stdout.close()
		out.stderr.close()
		_ = os.RemoveAll(dir)
		return nil
	}
	o.index[id] = &keptOutput{id: id, at: time.Now(), live: out}
	return out
}

// outputDirOf is the directory of a command's output: a directory of its own in OutputDir, never OutputDir itself or
// outside it ("." and ".." are valid command IDs).
func (s *Server) outputDirOf(id string) (string, bool) {
	if !validCommandID(id) || id == "." || id == ".." {
		return "", false
	}
	dir := filepath.Join(s.OutputDir, id)
	return dir, filepath.Dir(dir) == filepath.Clean(s.OutputDir)
}

// scanOutput is the output kept in dir, as an earlier run of the agent (an earlier boot) left it: each command's size,
// and when it was last written, and their sum.
func scanOutput(dir string) (map[string]*keptOutput, int64) {
	index := map[string]*keptOutput{}
	var used int64
	entries, err := os.ReadDir(dir)
	if err != nil {
		return index, 0
	}
	for _, entry := range entries {
		if !entry.IsDir() || !validCommandID(entry.Name()) {
			continue
		}
		k := &keptOutput{id: entry.Name()}
		// Since a boot let go of whatever ran: ended, as its machine did.
		for _, name := range []string{StreamStdout, StreamStderr, outputEndFile} {
			if info, err := os.Stat(filepath.Join(dir, k.id, name)); err == nil {
				// Its streams' bytes (the end file's few are left out, as the streams are all a limit counts).
				if name != outputEndFile {
					k.bytes += info.Size()
				}
				if info.ModTime().After(k.at) {
					k.at = info.ModTime()
				}
			}
		}
		index[k.id] = k
		used += k.bytes
	}
	return index, used
}

// pruneOutput drops the oldest ended commands' output until what is kept is at most total bytes and count commands:
// a running command's counts as what it has written so far, and is never dropped. s.outputs.mu is held.
func (s *Server) pruneOutput(total int64, count int) {
	o := &s.outputs
	if o.used.Load() <= total && len(o.index) <= count {
		return
	}
	kept := make([]*keptOutput, 0, len(o.index))
	for _, k := range o.index {
		if k.live == nil {
			kept = append(kept, k)
		}
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].at.Before(kept[j].at) })
	for _, k := range kept {
		if o.used.Load() <= total && len(o.index) <= count {
			return
		}
		if os.RemoveAll(filepath.Join(s.OutputDir, k.id)) == nil {
			o.used.Add(-k.bytes)
			delete(o.index, k.id)
		}
	}
}

// openStream opens a command's kept stream, with whether it runs and, for one that doesn't, its end where known (its
// end file, or what the agent noted as it ended), or a running one's cut so far as an end. Read together under
// outputs.mu, which a start's making of the files and an end's writing of its end file hold too: a stream is never seen
// made but not yet running, nor ended without its end. Nil for a stream not kept.
func (s *Server) openStream(id, dir, stream string) (*os.File, bool, *outputEnd, error) {
	o := &s.outputs
	o.mu.Lock()
	defer o.mu.Unlock()
	f, err := os.Open(filepath.Join(dir, stream))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil, nil
	}
	if err != nil {
		return nil, false, nil, err
	}
	k := o.index[id]
	switch {
	case k != nil && k.live != nil:
		return f, true, &outputEnd{StdoutCut: k.live.stdout.isCut(), StderrCut: k.live.stderr.isCut()}, nil
	case k != nil && k.end != nil:
		return f, false, k.end, nil
	}
	var end outputEnd
	if raw, err := os.ReadFile(filepath.Join(dir, outputEndFile)); err == nil && json.Unmarshal(raw, &end) == nil {
		return f, false, &end, nil
	}
	return f, false, nil, nil
}

// commandOutput is GET /exec/{id}/output?stream=stdout|stderr&offset=&length=: a part of a command's kept stream, at
// most MaxOutputRead bytes (length, default and most MaxOutputRead) from offset (default 0).
func (s *Server) commandOutput(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validCommandID(id) {
		fail(w, 400, errors.New("a command's id is letters, digits, _, - and ."))
		return
	}
	q := r.URL.Query()
	stream := q.Get("stream")
	if stream != StreamStdout && stream != StreamStderr {
		fail(w, 400, errors.New("stream is stdout or stderr"))
		return
	}
	offset, length := int64(0), int64(MaxOutputRead)
	for _, p := range []struct {
		name string
		to   *int64
	}{{"offset", &offset}, {"length", &length}} {
		if raw := q.Get(p.name); raw != "" {
			n, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || n < 0 {
				fail(w, 400, errors.New(p.name+" is a number of bytes"))
				return
			}
			*p.to = n
		}
	}
	length = min(length, MaxOutputRead)
	limit, _, _ := s.outputs.limits()
	answer := CommandOutput{Limit: limit}
	if s.OutputDir == "" {
		writeJSON(w, 200, answer)
		return
	}
	dir, ok := s.outputDirOf(id)
	if !ok {
		writeJSON(w, 200, answer)
		return
	}
	f, running, end, err := s.openStream(id, dir, stream)
	if err != nil {
		fail(w, 500, err)
		return
	}
	if f == nil {
		writeJSON(w, 200, answer)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		fail(w, 500, err)
		return
	}
	answer.Known, answer.Size, answer.Ended = true, info.Size(), !running
	answer.Offset = min(offset, answer.Size)
	buf := make([]byte, min(length, answer.Size-answer.Offset))
	n, err := f.ReadAt(buf, answer.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		fail(w, 500, err)
		return
	}
	answer.Data = base64.StdEncoding.EncodeToString(buf[:n])
	switch {
	case end != nil && stream == StreamStdout:
		answer.Cut = end.StdoutCut
	case end != nil:
		answer.Cut = end.StderrCut
	case !running:
		// No end: it ended with its machine (a reboot, a crash) or its agent, so its last output may not have reached the
		// disk, and whether it was cut before isn't known: cut.
		answer.Cut = true
	}
	writeJSON(w, 200, answer)
}
