package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// Commands the control plane names (proto.ExecParams.CommandID, FeatureExecControl) can be killed while they run
// (sandbox.exec.kill), and a detached one is answered at once and fetched later (sandbox.exec.get).
//
// A tier whose sandboxes keep commands by ID themselves (CommandRunner: the microVM tier's guest agent) runs a
// detached command there, where it outlives the call, the connection and the host's own restarts. Otherwise (an
// isolate, or a guest agent from before) the host runs it as a foreground command held open in the background, kept
// here (commandRuns) until it ends and then for its result, the newest maxEndedRuns of them.

// CommandRunner is a tier whose sandboxes run commands by ID themselves.
type CommandRunner interface {
	// StartCommand starts p (with its CommandID) in the background and answers its pid; unsupported when the sandbox
	// can't (a guest agent from before).
	StartCommand(ctx context.Context, p proto.ExecParams) (int, error)
	// CommandStatus is the command's status, waiting up to wait for a running one to end; not_found when unknown.
	CommandStatus(ctx context.Context, sandboxID, commandID string, wait time.Duration) (proto.ExecStatus, error)
	// KillCommand kills it and its process group, saying whether it was running.
	KillCommand(ctx context.Context, sandboxID, commandID string) (bool, error)
}

// noLimitMs is the timeout a detached command with no limit of its own is given when the host runs it on a guest agent
// from before (which has a default of 120 s, and honours a timeout): about 35 years.
const noLimitMs = 1 << 40

// maxEndedRuns is how many ended commands the host keeps the results of (detached ones, and foreground ones whose
// connection went before they ended), across its sandboxes.
const maxEndedRuns = 256

// maxCommandID bounds a CommandID.
const maxCommandID = 128

// commandRun is a command with an ID the host is running, or a detached one it ran.
type commandRun struct {
	cancel   context.CancelFunc
	done     chan struct{}
	detached bool
	killed   bool
	result   proto.ExecResult
	// reserved: a guest's start in flight (startDetached). A get answers it running; a kill waits for the start to
	// settle (done closes), then kills what it left: the guest's command, or a host-run fallback.
	reserved bool
}

// addResult is what add made of a run.
type addResult int

const (
	added addResult = iota
	// alreadyKnown: a run of that key is known.
	alreadyKnown
	// killedFirst: a kill for that key came first (calls are handled concurrently), so the run isn't started at all.
	killedFirst
)

// refusal is add's answer as a call's error.
func (r addResult) refusal(commandID string) error {
	if r == killedFirst {
		return conflictf("command %s was killed before it started", commandID)
	}
	return conflictf("command %s is already known on this host", commandID)
}

type commandRuns struct {
	mu    sync.Mutex
	byKey map[string]*commandRun
	// ended are the ended detached runs' keys, oldest first.
	ended []string
	// early are kills that found no command, by key, for earlyKillTTL: calls are handled concurrently, so a kill sent
	// just after its command's start may be handled first, and the start it overtook is then started killed.
	early map[string]time.Time
}

// earlyKillTTL is how long a kill that found no command waits for the start it may have overtaken.
const earlyKillTTL = time.Minute

func runKey(sandboxID, commandID string) string { return sandboxID + "\x00" + commandID }

// add records a run under key. It refuses while one of that key is known, and when a kill for it came first: a
// command killed before it started is never started.
func (c *commandRuns) add(key string, run *commandRun) addResult {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byKey == nil {
		c.byKey = map[string]*commandRun{}
	}
	if _, known := c.byKey[key]; known {
		return alreadyKnown
	}
	if c.killedEarlyLocked(key) {
		return killedFirst
	}
	c.byKey[key] = run
	return added
}

// unreserve ends a guest start's reservation (the guest has the command, or the start failed): kills waiting on it go
// on to the guest.
func (c *commandRuns) unreserve(key string, run *commandRun) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byKey[key] == run {
		delete(c.byKey, key)
	}
	close(run.done)
}

// replace puts run in a reservation's place (a host-run fallback for a guest start), under one lock so no get or kill
// finds neither; kills waiting on the reservation go on to run.
func (c *commandRuns) replace(key string, reserved, run *commandRun) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	defer close(reserved.done)
	if c.byKey[key] != reserved {
		return false
	}
	c.byKey[key] = run
	return true
}

// markEarlyLocked records a kill that found no command; c.mu is held.
func (c *commandRuns) markEarlyLocked(key string) {
	now := time.Now()
	if c.early == nil {
		c.early = map[string]time.Time{}
	}
	for k, at := range c.early {
		if now.Sub(at) > earlyKillTTL {
			delete(c.early, k)
		}
	}
	c.early[key] = now
}

// killedEarlyLocked is whether a kill for key came before its command; c.mu is held.
func (c *commandRuns) killedEarlyLocked(key string) bool {
	at, ok := c.early[key]
	return ok && time.Since(at) <= earlyKillTTL
}

func (c *commandRuns) get(key string) *commandRun {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byKey[key]
}

// end records a run's result: a killed one's is 137, and a run that failed to run has its error as stderr. It is kept,
// a foreground run's as a detached one's (its answer may never reach the control plane: its connection may go as it
// is sent), the newest maxEndedRuns of them.
func (c *commandRuns) end(key string, run *commandRun, result proto.ExecResult, err error) (proto.ExecResult, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	killed := run.killed
	switch {
	case run.killed:
		result = proto.ExecResult{ExitCode: 137, Stdout: result.Stdout, Stderr: result.Stderr, DurationMs: result.DurationMs}
	case err != nil:
		result = proto.ExecResult{ExitCode: 1, Stderr: err.Error() + "\n", DurationMs: result.DurationMs}
	}
	run.result = result
	close(run.done)
	c.ended = append(c.ended, key)
	for len(c.ended) > maxEndedRuns {
		if old := c.byKey[c.ended[0]]; old != nil && !old.reserved && ended(old) {
			delete(c.byKey, c.ended[0])
		}
		c.ended = c.ended[1:]
	}
	return result, killed
}

func ended(run *commandRun) bool {
	select {
	case <-run.done:
		return true
	default:
		return false
	}
}

// kill cancels a running command's context, saying whether it was running. One it doesn't know yet is marked, so its
// start, if that comes after, is refused (add). One whose guest start is in flight answers the reservation's done, to
// wait on and kill again once the start has settled.
func (c *commandRuns) kill(key string) (bool, <-chan struct{}) {
	c.mu.Lock()
	run := c.byKey[key]
	if run != nil && run.reserved {
		c.mu.Unlock()
		return false, run.done
	}
	if run == nil || ended(run) {
		// Marked under the lock that found none, so a start can't be added in between unseen.
		if run == nil {
			c.markEarlyLocked(key)
		}
		c.mu.Unlock()
		return false, nil
	}
	run.killed = true
	c.mu.Unlock()
	run.cancel()
	return true, nil
}

// status is a run's status now.
func (c *commandRuns) status(commandID string, run *commandRun) proto.ExecStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	// A reservation's done closing is its start settling, never the command ending: it is running (or starting).
	if run.reserved || !ended(run) {
		return proto.ExecStatus{CommandID: commandID, State: proto.ExecRunning}
	}
	result := run.result
	return proto.ExecStatus{CommandID: commandID, State: proto.ExecEnded, Result: &result}
}

// forget ends a sandbox's runs and drops them (its delete).
func (c *commandRuns) forget(sandboxID string) {
	prefix := sandboxID + "\x00"
	c.mu.Lock()
	var cancels []context.CancelFunc
	for key, run := range c.byKey {
		if len(key) > len(prefix) && key[:len(prefix)] == prefix {
			if !ended(run) {
				run.killed = true
				cancels = append(cancels, run.cancel)
			}
			delete(c.byKey, key)
		}
	}
	c.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
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

func conflictf(format string, args ...any) error {
	return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf(format, args...)}
}

func isUnsupported(err error) bool {
	var pe *proto.Error
	return errors.As(err, &pe) && pe.Code == proto.ErrUnsupported
}

// runCommand is sandbox.exec with a CommandID: a foreground one run so a kill can stop it, a detached one started.
//
// A foreground one runs on when the connection its call came on goes (a reconnect, a newer connection taking over):
// its call's context outlives the session (keptExec), so it ends at its own limit or a kill.
// Its result is kept, as a detached one's is, for the control plane to fetch by its ID (sandbox.exec.get) on the next
// connection when its answer had nowhere to go.
func (h *Host) runCommand(ctx context.Context, t Tier, p proto.ExecParams, onOutput func(stdout, stderr string)) (any, error) {
	if !validCommandID(p.CommandID) {
		return nil, invalid("a command's ID is up to %d letters, digits, _, - and .", maxCommandID)
	}
	key := runKey(p.SandboxID, p.CommandID)
	if p.Detached {
		return h.startDetached(ctx, t, key, p)
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	run := &commandRun{cancel: cancel, done: make(chan struct{})}
	if r := h.runs.add(key, run); r != added {
		return nil, r.refusal(p.CommandID)
	}
	result, err := t.Exec(runCtx, p, onOutput)
	answer, killed := h.runs.end(key, run, result, err)
	if err != nil && !killed {
		return nil, err
	}
	return answer, nil
}

// startDetached starts a detached command and answers at once: in the sandbox where it can keep commands itself, or
// else here, on a context of its own (not the call's, which ends with the answer, nor the connection's).
//
// The start owns the command's ID until it has settled: a guest start is reserved (a get answers it running, and a
// kill waits for the start, then kills what it left), and a host-run fallback takes the reservation's place under one
// lock. A kill that came before the start makes the start refused, so the command never runs.
func (h *Host) startDetached(ctx context.Context, t Tier, key string, p proto.ExecParams) (any, error) {
	var reserved *commandRun
	if runner, ok := t.(CommandRunner); ok {
		reserved = &commandRun{cancel: func() {}, done: make(chan struct{}), reserved: true}
		if r := h.runs.add(key, reserved); r != added {
			return nil, r.refusal(p.CommandID)
		}
		pid, err := runner.StartCommand(ctx, p)
		var pe *proto.Error
		if err != nil && !errors.As(err, &pe) {
			// No answer from the guest (its connection failed): it may have started it all the same, so it is asked; and
			// when it can't be asked either, the start is unconfirmed, not failed. Answered running, unconfirmed: Kantel
			// follows it by its ID, and the guest says whether it has it.
			status, statusErr := runner.CommandStatus(ctx, p.SandboxID, p.CommandID, 0)
			if statusErr == nil && status.State != "" {
				err = nil
			} else if statusErr == nil || !errors.As(statusErr, &pe) || pe.Code != proto.ErrNotFound {
				h.runs.unreserve(key, reserved)
				return proto.ExecStatus{CommandID: p.CommandID, State: proto.ExecRunning, Unconfirmed: true}, nil
			}
		}
		if err == nil {
			h.runs.unreserve(key, reserved)
			return proto.ExecStatus{CommandID: p.CommandID, State: proto.ExecRunning, Pid: pid}, nil
		}
		if !isUnsupported(err) {
			h.runs.unreserve(key, reserved)
			return nil, err
		}
		// A guest agent from before: run it here, held open, past the guest's own default limit.
		if p.TimeoutMs <= 0 {
			p.TimeoutMs = noLimitMs
		}
	}
	p.Detached, p.Stream = false, false
	// Neither the call's answer nor the session's going ends it.
	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	run := &commandRun{cancel: cancel, done: make(chan struct{}), detached: true}
	var refused error
	if reserved != nil {
		if !h.runs.replace(key, reserved, run) {
			refused = alreadyKnown.refusal(p.CommandID)
		}
	} else if r := h.runs.add(key, run); r != added {
		refused = r.refusal(p.CommandID)
	}
	if refused != nil {
		cancel()
		return nil, refused
	}
	go func() {
		defer cancel()
		result, err := t.Exec(runCtx, p, nil)
		h.runs.end(key, run, result, err)
	}()
	return proto.ExecStatus{CommandID: p.CommandID, State: proto.ExecRunning}, nil
}

// keptExec is whether a call is a sandbox.exec with a CommandID, whose run outlives the session it came on: a detached
// one runs on its own context (startDetached), and a foreground one runs on to its own end when the session goes
// (runCommand).
func keptExec(method string, params json.RawMessage) bool {
	if method != proto.MethodExec {
		return false
	}
	var p struct {
		CommandID string `json:"commandId"`
	}
	return json.Unmarshal(params, &p) == nil && p.CommandID != ""
}

// stopGrace is how long a stop runs on after the session it came on has gone (outliving): long enough for a pause and
// a snapshot to finish, as asked, rather than be cut off half-way; short enough that one stuck on a Firecracker that
// never answers ends (it holds the sandbox, which the next session's hello lists) before Kantel stops waiting for the
// host to come back and send the stop again (STOP_RECONNECT_WAIT_MS, 2 minutes).
var stopGrace = 60 * time.Second

// outliving is a context for a call that runs on for grace once parent has ended, then ends too.
func outliving(parent context.Context, grace time.Duration) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.WithoutCancel(parent))
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-parent.Done():
		}
		timer := time.NewTimer(grace)
		defer timer.Stop()
		select {
		case <-ctx.Done():
		case <-timer.C:
			cancel()
		}
	}()
	return ctx, cancel
}

// commandStatus is sandbox.exec.get.
func (h *Host) commandStatus(ctx context.Context, p proto.ExecRef) (any, error) {
	if !validCommandID(p.CommandID) {
		return nil, invalid("a command's ID is up to %d letters, digits, _, - and .", maxCommandID)
	}
	wait := time.Duration(min(max(p.WaitMs, 0), proto.ExecMaxWaitMs)) * time.Millisecond
	if run := h.runs.get(runKey(p.SandboxID, p.CommandID)); run != nil {
		if wait > 0 {
			timer := time.NewTimer(wait)
			select {
			case <-run.done:
			case <-timer.C:
			case <-ctx.Done():
			}
			timer.Stop()
		}
		status := h.runs.status(p.CommandID, run)
		if status.State == proto.ExecRunning && !run.reserved {
			status = h.outputSoFar(ctx, p, status)
		}
		return status, nil
	}
	t, err := h.tierOf(p.SandboxID)
	if err != nil {
		return nil, err
	}
	if runner, ok := t.(CommandRunner); ok {
		return runner.CommandStatus(ctx, p.SandboxID, p.CommandID, wait)
	}
	return nil, &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no command %s in sandbox %s on this host", p.CommandID, p.SandboxID)}
}

// guestStatusTimeout bounds asking a guest for a running command's output so far.
const guestStatusTimeout = 5 * time.Second

// outputSoFar adds a running run's output so far to its status, from the sandbox where it runs when that keeps
// commands by ID (the microVM tier's guest agent keeps a foreground command's output while it runs too): what attach
// shows of a foreground command whose call outlived its connection. Where the sandbox can't say (an isolate, a guest
// from before, a guest out of reach), the status is as it was: running, with no output.
func (h *Host) outputSoFar(ctx context.Context, p proto.ExecRef, status proto.ExecStatus) proto.ExecStatus {
	t, err := h.tierOf(p.SandboxID)
	if err != nil {
		return status
	}
	runner, ok := t.(CommandRunner)
	if !ok {
		return status
	}
	ask, cancel := context.WithTimeout(ctx, guestStatusTimeout)
	defer cancel()
	guest, err := runner.CommandStatus(ask, p.SandboxID, p.CommandID, 0)
	if err != nil || guest.State != proto.ExecRunning {
		return status
	}
	status.Stdout, status.Stderr, status.Truncated = guest.Stdout, guest.Stderr, guest.Truncated
	return status
}

// killCommand is sandbox.exec.kill: the run here ended, and the sandbox's own command killed with its process group.
func (h *Host) killCommand(ctx context.Context, p proto.ExecRef) (any, error) {
	if !validCommandID(p.CommandID) {
		return nil, invalid("a command's ID is up to %d letters, digits, _, - and .", maxCommandID)
	}
	key := runKey(p.SandboxID, p.CommandID)
	killed, starting := h.runs.kill(key)
	// A guest start in flight: once it settles, what it left (the guest's command, or a host-run fallback) is killed,
	// and how that went is the answer, so a kill the guest didn't take isn't reported done.
	for starting != nil {
		select {
		case <-starting:
		case <-ctx.Done():
			return nil, &proto.Error{Code: proto.ErrUnavailable, Message: "the command was still starting; kill it again"}
		}
		killed, starting = h.runs.kill(key)
	}
	t, err := h.tierOf(p.SandboxID)
	if err != nil {
		if killed {
			return proto.ExecKilled{Killed: true}, nil
		}
		return nil, err
	}
	if runner, ok := t.(CommandRunner); ok {
		inGuest, err := runner.KillCommand(ctx, p.SandboxID, p.CommandID)
		if err != nil && !killed {
			return nil, err
		}
		killed = killed || inGuest
	}
	return proto.ExecKilled{Killed: killed}, nil
}
