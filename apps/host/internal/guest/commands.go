package guest

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

// Commands run with an ID (ExecRequest.ID) are known to the agent by it while they run, so the host can stop one
// (POST /exec/{id}/kill), and a detached one (POST /exec/start) keeps its exit code and output once it ends, for the
// host to fetch (GET /exec/{id}). So does a foreground one kept past its connection (ExecRequest.Keep): its answer may
// never reach the host, and the host that fetches it may be another one, the sandbox having moved with its memory.
// A guest from before them answers these routes 404 or 405 (IsUnknownRoute): the host then runs a detached command
// itself, as a foreground one held open (agent's background runs).

// ExecStatus is GET /exec/{id}'s answer: State is ExecRunning or ExecEnded, and an ended one has its Result. A running
// one (detached, or a foreground one with an ID that isn't streamed) has its output so far (Stdout, Stderr and
// Truncated): the start of each stream up to its cap, so only ever more of the same, and never a partial UTF-8 sequence
// at its end. A guest from before running output leaves them out.
type ExecStatus struct {
	ID        string      `json:"id"`
	State     string      `json:"state"`
	Result    *ExecResult `json:"result,omitempty"`
	Stdout    string      `json:"stdout,omitempty"`
	Stderr    string      `json:"stderr,omitempty"`
	Truncated bool        `json:"truncated,omitempty"`
}

const (
	ExecRunning = "running"
	ExecEnded   = "exited"
)

// MaxExecWait is the longest GET /exec/{id} holds its answer for a command to end (its waitMs).
const MaxExecWait = 60 * time.Second

// maxEndedCommands is how many ended detached commands the agent keeps the results of, the oldest dropped first.
// Each holds at most twice its MaxOutputBytes (1 MiB a stream by default).
const maxEndedCommands = 32

// maxKeptCommands is how many ended foreground commands kept past their connection (ExecRequest.Keep) the agent keeps
// the results of, apart from the detached ones', so many short foreground commands never push out a detached one's.
const maxKeptCommands = 16

// maxCommandID bounds an ExecRequest.ID.
const maxCommandID = 128

// command is one command run with an ID.
type command struct {
	cancel context.CancelFunc
	done   chan struct{}
	// killed is set by a kill, so the command's end reads as killed (137), not as a failure to run.
	killed bool
	// detached: its result is kept once it ends.
	detached bool
	result   ExecResult
	// stdout and stderr are its output as it comes (its status while it runs): a detached command's, and a foreground
	// one's that isn't streamed.
	stdout, stderr *cappedBuffer
}

// commands are the agent's commands run with an ID.
type commands struct {
	mu   sync.Mutex
	byID map[string]*command
	// ended and kept are the ended detached and kept foreground commands' IDs, oldest first.
	ended, kept []string
	ensured     bool
	// early are kills that found no command, by ID, for earlyKillTTL: the host's kill of a command can overtake its
	// start (a foreground one kept past its call isn't ended by that call's cancelling), and the start it overtook is
	// then refused, never run.
	early map[string]time.Time
}

// earlyKillTTL is how long a kill that found no command waits for the start it may have overtaken.
const earlyKillTTL = time.Minute

func (c *commands) init() {
	if !c.ensured {
		c.byID = map[string]*command{}
		c.ensured = true
	}
}

// add records a command under id, or says no while one of that ID is known, or when a kill for it came first.
func (c *commands) add(id string, cmd *command) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	if _, known := c.byID[id]; known {
		return false
	}
	if at, killed := c.early[id]; killed && time.Since(at) <= earlyKillTTL {
		return false
	}
	c.byID[id] = cmd
	return true
}

// end records a command's result. A foreground one is forgotten, unless kept past its connection (keep: its answer
// may never reach the host, the sandbox pausing or moving with its memory as it is sent), whose result is kept with the
// newest maxKeptCommands of them; a detached one's is kept with the newest maxEndedCommands.
func (c *commands) end(id string, cmd *command, result ExecResult, keep bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if cmd.killed {
		result.ExitCode, result.TimedOut = 137, false
	}
	cmd.result = result
	close(cmd.done)
	switch {
	case cmd.detached:
		c.ended = c.evict(append(c.ended, id), maxEndedCommands)
	case keep:
		c.kept = c.evict(append(c.kept, id), maxKeptCommands)
	default:
		if c.byID[id] == cmd {
			delete(c.byID, id)
		}
	}
}

// evict drops the oldest of ids past max, and answers the rest; c.mu is held.
func (c *commands) evict(ids []string, max int) []string {
	for len(ids) > max {
		delete(c.byID, ids[0])
		ids = ids[1:]
	}
	return ids
}

func (c *commands) get(id string) *command {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	return c.byID[id]
}

// kill ends a running command and its whole process group. It says whether one was running.
func (c *commands) kill(id string) bool {
	c.mu.Lock()
	cmd := c.byID[id]
	if cmd == nil {
		// Marked under the lock that found none, so a start can't be added in between unseen (add refuses it).
		now := time.Now()
		if c.early == nil {
			c.early = map[string]time.Time{}
		}
		for k, at := range c.early {
			if now.Sub(at) > earlyKillTTL {
				delete(c.early, k)
			}
		}
		c.early[id] = now
		c.mu.Unlock()
		return false
	}
	select {
	case <-cmd.done:
		c.mu.Unlock()
		return false
	default:
	}
	cmd.killed = true
	c.mu.Unlock()
	// Its context's Cancel kills the process group (buildCommand), and Wait returns.
	cmd.cancel()
	return true
}

func validCommandID(id string) bool {
	if id == "" || len(id) > maxCommandID {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.') {
			return false
		}
	}
	return true
}

// startCommand is POST /exec/start: an ExecRequest with an ID run in the background, with no time limit unless it has
// a TimeoutMs, answered at once with its pid. Its stdout and stderr are kept up to MaxOutputBytes each (1 MiB by
// default), as a foreground command's answer has them, and with its exit code are GET /exec/{id}'s once it ends.
func (s *Server) startCommand(w http.ResponseWriter, r *http.Request) {
	var req ExecRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	if req.Command == "" && len(req.Argv) == 0 {
		fail(w, 400, errors.New("command or argv is required"))
		return
	}
	if !validCommandID(req.ID) {
		fail(w, 400, errors.New("a detached command needs an id of letters, digits, _, - and ."))
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	if req.TimeoutMs > 0 {
		ctx, cancel = context.WithTimeout(context.Background(), time.Duration(req.TimeoutMs)*time.Millisecond)
	}
	cmd, err := s.buildCommand(ctx, &req)
	if err != nil {
		cancel()
		fail(w, 400, err)
		return
	}
	max := req.MaxOutputBytes
	if max <= 0 {
		max = 1 << 20
	}
	stdout, stderr := &cappedBuffer{max: max}, &cappedBuffer{max: max}
	run := &command{cancel: cancel, done: make(chan struct{}), detached: true, stdout: stdout, stderr: stderr}
	if !s.commands.add(req.ID, run) {
		cancel()
		fail(w, 409, errors.New("a command with this id is already known, or was killed before it started"))
		return
	}
	// Its whole output kept on the disk too, past what its result holds (output.go).
	output := s.openOutput(req.ID)
	outLog, errLog := output.streams()
	cmd.Stdout, cmd.Stderr = tee(stdout, outLog), tee(stderr, errLog)
	started := time.Now()
	oomBefore := OOMKills()
	if err := cmd.Start(); err != nil {
		cancel()
		_, _ = cmd.Stderr.Write([]byte(err.Error() + "\n"))
		output.finish()
		s.commands.end(req.ID, run, ExecResult{ExitCode: 127, Stderr: err.Error() + "\n"}, false)
		fail(w, 500, err)
		return
	}
	pid := cmd.Process.Pid
	go func() {
		defer cancel()
		err := cmd.Wait()
		if note := OOMNote(oomBefore); note != "" {
			_, _ = cmd.Stderr.Write([]byte(note))
		}
		// Ended on the disk before it reads as ended (GET /exec/{id}/output reads an ended one's end file).
		output.finish()
		result := ExecResult{
			Stdout: string(stdout.bytes()), Stderr: string(stderr.bytes()), Truncated: stdout.cut() || stderr.cut(),
			DurationMs: time.Since(started).Milliseconds(), Pid: pid, ExitCode: exitCode(err),
		}
		s.commands.mu.Lock()
		killed := run.killed
		s.commands.mu.Unlock()
		if killed {
			// end makes it 137.
		} else if ctx.Err() == context.DeadlineExceeded {
			result.ExitCode, result.TimedOut = 124, true
		} else if result.ExitCode == -1 {
			result.ExitCode = 1
			result.Stderr += err.Error() + "\n"
		}
		s.commands.end(req.ID, run, result, false)
	}()
	writeJSON(w, 200, ExecResult{Pid: pid})
}

// commandStatus is GET /exec/{id}: a command's state, and once it has ended its result. With waitMs it waits up to
// that long (at most MaxExecWait) for a running one to end. 404 for an ID the agent doesn't know.
func (s *Server) commandStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	cmd := s.commands.get(id)
	if cmd == nil {
		fail(w, 404, errors.New("no command with this id"))
		return
	}
	if raw := r.URL.Query().Get("waitMs"); raw != "" {
		ms, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || ms < 0 {
			fail(w, 400, errors.New("waitMs is a number of milliseconds"))
			return
		}
		wait := min(time.Duration(ms)*time.Millisecond, MaxExecWait)
		timer := time.NewTimer(wait)
		select {
		case <-cmd.done:
		case <-timer.C:
		case <-r.Context().Done():
		}
		timer.Stop()
	}
	select {
	case <-cmd.done:
		s.commands.mu.Lock()
		result := cmd.result
		s.commands.mu.Unlock()
		writeJSON(w, 200, ExecStatus{ID: id, State: ExecEnded, Result: &result})
	default:
		status := ExecStatus{ID: id, State: ExecRunning}
		if cmd.stdout != nil && cmd.stderr != nil {
			status.Stdout, status.Stderr = string(cmd.stdout.whole()), string(cmd.stderr.whole())
			status.Truncated = cmd.stdout.cut() || cmd.stderr.cut()
		}
		writeJSON(w, 200, status)
	}
}

// whole is a copy of the buffer up to its last whole UTF-8 sequence: a running command's output so far, which a later
// look only adds to (a sequence cut short now would read as U+FFFD, then as itself once the rest has come).
func (b *cappedBuffer) whole() []byte {
	b.mu.Lock()
	out := append([]byte(nil), b.buf...)
	b.mu.Unlock()
	// Back over at most one sequence's continuation bytes to its lead byte: dropped when its sequence isn't whole yet.
	for i := len(out) - 1; i >= 0 && i >= len(out)-utf8.UTFMax; i-- {
		if !utf8.RuneStart(out[i]) {
			continue
		}
		if !utf8.FullRune(out[i:]) {
			return out[:i]
		}
		break
	}
	return out
}

// killCommand is POST /exec/{id}/kill: SIGKILL to the command's whole process group. {"killed": false} for one that
// has already ended, 404 for an ID the agent doesn't know, whose start, if it comes within earlyKillTTL, is refused.
func (s *Server) killCommand(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if s.commands.get(id) == nil {
		// Marked, so a start it overtook is refused.
		s.commands.kill(id)
		fail(w, 404, errors.New("no command with this id"))
		return
	}
	writeJSON(w, 200, map[string]bool{"killed": s.commands.kill(id)})
}

// killGroup is buildCommand's Cancel: SIGKILL to the command's process group, not just its shell.
func killGroup(pid int) error {
	return syscall.Kill(-pid, syscall.SIGKILL)
}
