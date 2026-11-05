package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// heldTier is a tier whose commands run until released or their context ends, as an isolate's (or an older guest's)
// do: it keeps no commands of its own.
type heldTier struct {
	Tier // unimplemented methods panic

	mu      sync.Mutex
	execs   []proto.ExecParams
	release chan proto.ExecResult
	started chan struct{}
}

func newHeldTier() *heldTier {
	return &heldTier{release: make(chan proto.ExecResult, 4), started: make(chan struct{}, 4)}
}

func (f *heldTier) Get(id string) (proto.SandboxInfo, error) {
	return proto.SandboxInfo{ID: id, Tier: microvm.Tier, State: proto.StateRunning}, nil
}

func (f *heldTier) List() []proto.SandboxInfo { return nil }

func (f *heldTier) Delete(context.Context, string) error { return nil }

func (f *heldTier) Exec(ctx context.Context, p proto.ExecParams, _ func(string, string)) (proto.ExecResult, error) {
	f.mu.Lock()
	f.execs = append(f.execs, p)
	f.mu.Unlock()
	f.started <- struct{}{}
	select {
	case r := <-f.release:
		return r, nil
	case <-ctx.Done():
		return proto.ExecResult{}, ctx.Err()
	}
}

func (f *heldTier) lastExec() proto.ExecParams {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.execs[len(f.execs)-1]
}

// runnerTier keeps commands itself, as the microVM tier's guest agent does; with old set, it is a guest from before.
type runnerTier struct {
	*heldTier
	old    bool
	mu     sync.Mutex
	begun  []proto.ExecParams
	killed []string
	// hold, when set, holds a start until it is closed (the guest still registering it).
	hold    chan struct{}
	holding chan struct{}
	// lostAnswer: the guest starts the command but its answer is lost (a transport error).
	lostAnswer bool
	// killErr: the guest fails to take a kill.
	killErr error
	// probeErr: the guest can't be asked for a command's status either.
	probeErr error
	// soFar is a running command's output so far, as the guest reports it.
	soFar proto.ExecStatus
	// asked counts status asks.
	asked int
}

func (r *runnerTier) StartCommand(_ context.Context, p proto.ExecParams) (int, error) {
	if r.hold != nil {
		close(r.holding)
		<-r.hold
	}
	if r.old {
		return 0, &proto.Error{Code: proto.ErrUnsupported, Message: "guest from before"}
	}
	if r.lostAnswer {
		r.mu.Lock()
		r.begun = append(r.begun, p)
		r.mu.Unlock()
		return 0, errors.New("vsock: connection reset")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.begun = append(r.begun, p)
	return 42, nil
}

func (r *runnerTier) CommandStatus(_ context.Context, _, id string, _ time.Duration) (proto.ExecStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.asked++
	if r.probeErr != nil {
		return proto.ExecStatus{}, r.probeErr
	}
	for _, k := range r.killed {
		if k == id {
			return proto.ExecStatus{CommandID: id, State: proto.ExecEnded, Result: &proto.ExecResult{ExitCode: 137}}, nil
		}
	}
	return proto.ExecStatus{CommandID: id, State: proto.ExecRunning, Stdout: r.soFar.Stdout, Stderr: r.soFar.Stderr, Truncated: r.soFar.Truncated}, nil
}

func (r *runnerTier) KillCommand(_ context.Context, _, id string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.killErr != nil {
		return false, r.killErr
	}
	// Only a command it started is killed, as a guest's (one it doesn't know isn't).
	known := false
	for _, p := range r.begun {
		known = known || p.CommandID == id
	}
	if !known {
		return false, nil
	}
	r.killed = append(r.killed, id)
	return true, nil
}

func hostWith(t *testing.T, tier Tier) *Host {
	t.Helper()
	return &Host{
		cfg: Config{Root: t.TempDir()}, log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		tiers: map[string]Tier{microvm.Tier: tier}, order: []string{microvm.Tier}, bySlot: map[int]egress.Rules{},
	}
}

func callCmd[T any](t *testing.T, h *Host, ctx context.Context, method string, params any) (T, error) {
	t.Helper()
	raw, _ := json.Marshal(params)
	var out T
	res, err := h.Call(ctx, method, raw, nil)
	if err != nil {
		return out, err
	}
	encoded, _ := json.Marshal(res)
	return out, json.Unmarshal(encoded, &out)
}

func TestDetachedCommandOutlivesItsCallAndKeepsItsResult(t *testing.T) {
	tier := newHeldTier()
	h := hostWith(t, tier)
	callCtx, endCall := context.WithCancel(context.Background())
	status, err := callCmd[proto.ExecStatus](t, h, callCtx, proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "sleep 600", Detached: true, CommandID: "cmd_1"})
	if err != nil || status.State != proto.ExecRunning || status.CommandID != "cmd_1" {
		t.Fatalf("start: %+v, %v", status, err)
	}
	<-tier.started
	// The call has been answered: its context (and the connection's) ending doesn't end the command.
	endCall()
	if p := tier.lastExec(); p.Detached || p.TimeoutMs != 0 {
		t.Fatalf("the tier was given %+v: want a foreground run with its own default limit", p)
	}
	now, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_1"})
	if err != nil || now.State != proto.ExecRunning {
		t.Fatalf("get: %+v, %v", now, err)
	}
	tier.release <- proto.ExecResult{ExitCode: 3, Stdout: "out"}
	ended, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_1", WaitMs: 5000})
	if err != nil || ended.State != proto.ExecEnded || ended.Result == nil || ended.Result.ExitCode != 3 || ended.Result.Stdout != "out" {
		t.Fatalf("after its end: %+v, %v", ended, err)
	}
	// Its ID is taken while the host keeps it.
	if _, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "true", Detached: true, CommandID: "cmd_1"}); err == nil {
		t.Fatal("a second command with the same ID was started")
	}
}

func TestKillStopsADetachedCommandTheHostRuns(t *testing.T) {
	tier := newHeldTier()
	h := hostWith(t, tier)
	if _, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "sleep 600", Detached: true, CommandID: "cmd_k"}); err != nil {
		t.Fatal(err)
	}
	<-tier.started
	killed, err := callCmd[proto.ExecKilled](t, h, context.Background(), proto.MethodExecKill, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_k"})
	if err != nil || !killed.Killed {
		t.Fatalf("kill: %+v, %v", killed, err)
	}
	ended, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_k", WaitMs: 5000})
	if err != nil || ended.State != proto.ExecEnded || ended.Result.ExitCode != 137 {
		t.Fatalf("after the kill: %+v, %v", ended, err)
	}
	again, err := callCmd[proto.ExecKilled](t, h, context.Background(), proto.MethodExecKill, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_k"})
	if err != nil || again.Killed {
		t.Fatalf("kill again: %+v, %v", again, err)
	}
}

func TestKillStopsAForegroundCommandByItsID(t *testing.T) {
	tier := newHeldTier()
	h := hostWith(t, tier)
	answered := make(chan proto.ExecResult, 1)
	go func() {
		res, err := callCmd[proto.ExecResult](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "sleep 600", CommandID: "cmd_f"})
		if err != nil {
			res = proto.ExecResult{ExitCode: -1, Stderr: err.Error()}
		}
		answered <- res
	}()
	<-tier.started
	killed, err := callCmd[proto.ExecKilled](t, h, context.Background(), proto.MethodExecKill, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_f"})
	if err != nil || !killed.Killed {
		t.Fatalf("kill: %+v, %v", killed, err)
	}
	select {
	case res := <-answered:
		if res.ExitCode != 137 {
			t.Fatalf("answer %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the killed command wasn't answered")
	}
	// A foreground command's end is kept, as killed (137), for a control plane whose answer was lost.
	if status, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_f"}); err != nil || status.State != proto.ExecEnded || status.Result == nil || status.Result.ExitCode != 137 {
		t.Fatalf("an ended foreground command reads as %+v, %v", status, err)
	}
}

// A foreground command whose connection goes while it runs runs on (its call's context outlives the session), and its
// result, with nowhere to go, is kept for a get; a get with a wait waits for it to end.
func TestAForegroundCommandRunsOnPastItsConnectionAndKeepsItsResult(t *testing.T) {
	tier := newHeldTier()
	h := hostWith(t, tier)
	session, endSession := context.WithCancel(context.Background())
	ctx := context.WithoutCancel(session)
	answered := make(chan error, 1)
	go func() {
		_, err := callCmd[proto.ExecResult](t, h, ctx, proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "pnpm install", CommandID: "cmd_c", TimeoutMs: 600_000})
		answered <- err
	}()
	<-tier.started
	endSession()
	now, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_c"})
	if err != nil || now.State != proto.ExecRunning {
		t.Fatalf("after its connection went: %+v, %v", now, err)
	}
	got := make(chan proto.ExecStatus, 1)
	go func() {
		status, _ := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_c", WaitMs: 5000})
		got <- status
	}()
	tier.release <- proto.ExecResult{ExitCode: 0, Stdout: "Done in 42s\n"}
	if err := <-answered; err != nil {
		t.Fatalf("its call: %v", err)
	}
	select {
	case ended := <-got:
		if ended.State != proto.ExecEnded || ended.Result == nil || ended.Result.Stdout != "Done in 42s\n" {
			t.Fatalf("the held get: %+v", ended)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the held get wasn't answered at its end")
	}
	again, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_c"})
	if err != nil || again.State != proto.ExecEnded {
		t.Fatalf("kept: %+v, %v", again, err)
	}
}

// A foreground command that ends while its connection still looks up keeps its result too: its answer may be lost as
// it is sent (the connection going just then), and the control plane then asks for it by its ID.
func TestAForegroundCommandKeepsItsResultWhenItsAnswerIsSent(t *testing.T) {
	tier := newHeldTier()
	h := hostWith(t, tier)
	answered := make(chan proto.ExecResult, 1)
	go func() {
		result, _ := callCmd[proto.ExecResult](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "make", CommandID: "cmd_s"})
		answered <- result
	}()
	<-tier.started
	tier.release <- proto.ExecResult{ExitCode: 3, Stdout: "built\n"}
	if got := <-answered; got.ExitCode != 3 {
		t.Fatalf("its answer: %+v", got)
	}
	kept, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_s"})
	if err != nil || kept.State != proto.ExecEnded || kept.Result == nil || kept.Result.ExitCode != 3 || kept.Result.Stdout != "built\n" {
		t.Fatalf("kept: %+v, %v", kept, err)
	}
}

// A running foreground command in a sandbox that keeps commands by ID has its output so far in sandbox.exec.get, from
// the guest, as a detached one has: what attach shows of a command whose call outlived its connection. A guest that
// can't be asked leaves it out, and the command is still running.
func TestARunningForegroundCommandShowsTheGuestsOutputSoFar(t *testing.T) {
	tier := &runnerTier{heldTier: newHeldTier(), soFar: proto.ExecStatus{Stdout: "Reading package lists...\n", Stderr: "warn\n", Truncated: true}}
	h := hostWith(t, tier)
	answered := make(chan error, 1)
	go func() {
		_, err := callCmd[proto.ExecResult](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "apt-get install -y gcc", CommandID: "cmd_l", TimeoutMs: 600_000})
		answered <- err
	}()
	<-tier.started
	now, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_l"})
	if err != nil || now.State != proto.ExecRunning || now.Stdout != "Reading package lists...\n" || now.Stderr != "warn\n" || !now.Truncated {
		t.Fatalf("while it runs: %+v, %v", now, err)
	}
	tier.mu.Lock()
	tier.probeErr = errors.New("vsock: connection reset")
	tier.mu.Unlock()
	now, err = callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_l"})
	if err != nil || now.State != proto.ExecRunning || now.Stdout != "" {
		t.Fatalf("with the guest out of reach: %+v, %v", now, err)
	}
	tier.release <- proto.ExecResult{ExitCode: 0, Stdout: "Reading package lists...\nDone\n"}
	if err := <-answered; err != nil {
		t.Fatalf("its call: %v", err)
	}
	// Once it has ended, its kept result is the answer, and the guest isn't asked.
	tier.mu.Lock()
	asked := tier.asked
	tier.mu.Unlock()
	ended, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_l"})
	if err != nil || ended.State != proto.ExecEnded || ended.Result == nil || ended.Result.Stdout != "Reading package lists...\nDone\n" || ended.Stdout != "" {
		t.Fatalf("after its end: %+v, %v", ended, err)
	}
	tier.mu.Lock()
	defer tier.mu.Unlock()
	if tier.asked != asked {
		t.Fatalf("the guest was asked about an ended command")
	}
}

func TestDetachedCommandRunsInAGuestThatKeepsCommands(t *testing.T) {
	tier := &runnerTier{heldTier: newHeldTier()}
	h := hostWith(t, tier)
	status, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "npm run dev", Detached: true, CommandID: "cmd_g", TimeoutMs: 5000})
	if err != nil || status.State != proto.ExecRunning || status.Pid != 42 {
		t.Fatalf("start: %+v, %v", status, err)
	}
	if len(tier.begun) != 1 || tier.begun[0].TimeoutMs != 5000 || len(tier.execs) != 0 {
		t.Fatalf("started %+v, ran %+v", tier.begun, tier.execs)
	}
	killed, err := callCmd[proto.ExecKilled](t, h, context.Background(), proto.MethodExecKill, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_g"})
	if err != nil || !killed.Killed || len(tier.killed) != 1 {
		t.Fatalf("kill: %+v, %v (%v)", killed, err, tier.killed)
	}
	ended, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_g"})
	if err != nil || ended.State != proto.ExecEnded || ended.Result.ExitCode != 137 {
		t.Fatalf("get: %+v, %v", ended, err)
	}
}

func TestDetachedCommandOnAnOlderGuestIsHeldOpenWithNoLimit(t *testing.T) {
	tier := &runnerTier{heldTier: newHeldTier(), old: true}
	h := hostWith(t, tier)
	if _, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "npm run dev", Detached: true, CommandID: "cmd_o"}); err != nil {
		t.Fatal(err)
	}
	<-tier.started
	// Not the guest's own 120 s default: an older guest honours the timeout it is given.
	if p := tier.lastExec(); p.Detached || p.TimeoutMs != noLimitMs || p.CommandID != "cmd_o" {
		t.Fatalf("the guest was given %+v", p)
	}
	tier.release <- proto.ExecResult{ExitCode: 0, Stdout: "served"}
	ended, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_o", WaitMs: 5000})
	if err != nil || ended.State != proto.ExecEnded || ended.Result.Stdout != "served" {
		t.Fatalf("get: %+v, %v", ended, err)
	}
}

func TestDeletingASandboxEndsItsCommands(t *testing.T) {
	tier := newHeldTier()
	h := hostWith(t, tier)
	if _, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "sleep 600", Detached: true, CommandID: "cmd_d"}); err != nil {
		t.Fatal(err)
	}
	<-tier.started
	h.runs.forget("iso_1")
	if h.runs.get(runKey("iso_1", "cmd_d")) != nil {
		t.Fatal("the sandbox's command is still kept")
	}
}

func TestCommandIDsAreChecked(t *testing.T) {
	h := hostWith(t, newHeldTier())
	for _, id := range []string{"../x", "a b", string(make([]byte, 200))} {
		if _, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "true", Detached: true, CommandID: id}); err == nil {
			t.Fatalf("ID %q was taken", id)
		}
	}
}

// A detached command the host runs itself holds its gateway call's guard until it ends, not until the call is answered:
// a delete's claim waits for it, and ends it by ending the guard's context.
func TestADetachedRunHoldsItsCallsGuardUntilItEnds(t *testing.T) {
	tier := newHeldTier()
	h := hostWith(t, tier)
	guard, claim := context.WithCancel(context.Background())
	released := make(chan struct{})
	ctx, rel := withRelease(guard, func() { close(released) })
	if _, err := callCmd[proto.ExecStatus](t, h, ctx, proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "sleep 600", Detached: true, CommandID: "cmd_r"}); err != nil {
		t.Fatal(err)
	}
	<-tier.started
	// The call is over: its own release is a no-op, the run holds the guard.
	rel.release()
	select {
	case <-released:
		t.Fatal("the guard was released with the call, while its command still runs")
	case <-time.After(50 * time.Millisecond):
	}
	// A claim on the sandbox ends the guard's context: the run ends, and only then is the guard released.
	claim()
	select {
	case <-released:
	case <-time.After(5 * time.Second):
		t.Fatal("the run didn't end and release its guard")
	}
	ended, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_r"})
	if err != nil || ended.State != proto.ExecEnded {
		t.Fatalf("after the claim: %+v, %v", ended, err)
	}
}

func TestAForegroundCallKeepsItsOwnGuard(t *testing.T) {
	tier := newHeldTier()
	h := hostWith(t, tier)
	released := false
	ctx, rel := withRelease(context.Background(), func() { released = true })
	tier.release <- proto.ExecResult{ExitCode: 0}
	if _, err := callCmd[proto.ExecResult](t, h, ctx, proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "true", CommandID: "cmd_fg"}); err != nil {
		t.Fatal(err)
	}
	rel.release()
	if !released {
		t.Fatal("a foreground call's guard wasn't released with it")
	}
	if !keptExec(proto.MethodExec, []byte(`{"detached":true,"commandId":"cmd_x"}`)) ||
		!keptExec(proto.MethodExec, []byte(`{"commandId":"cmd_x"}`)) ||
		keptExec(proto.MethodExec, []byte(`{"detached":true}`)) ||
		keptExec(proto.MethodExecGet, []byte(`{"commandId":"cmd_x"}`)) {
		t.Fatal("keptExec")
	}
}

// killAsync sends a kill and answers its outcome when it comes: a kill of a command still starting waits for the start.
func killAsync(t *testing.T, h *Host, sandboxID, commandID string) <-chan error {
	out := make(chan error, 1)
	go func() {
		killed, err := callCmd[proto.ExecKilled](t, h, context.Background(), proto.MethodExecKill, proto.ExecRef{SandboxID: sandboxID, CommandID: commandID})
		if err == nil && !killed.Killed {
			err = errors.New("not killed")
		}
		out <- err
	}()
	return out
}

func noAnswerYet(t *testing.T, ch <-chan error) {
	t.Helper()
	select {
	case err := <-ch:
		t.Fatalf("answered while the start was in flight: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
}

// While the guest is still registering a detached start, the host answers a get for it as running (never unknown);
// a kill waits for the start, then kills the guest's command and answers how that went.
func TestAGuestStartInFlightIsKnownAndKillable(t *testing.T) {
	tier := &runnerTier{heldTier: newHeldTier(), hold: make(chan struct{}), holding: make(chan struct{})}
	h := hostWith(t, tier)
	started := make(chan error, 1)
	go func() {
		_, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "./serve", Detached: true, CommandID: "cmd_s"})
		started <- err
	}()
	<-tier.holding
	status, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_s"})
	if err != nil || status.State != proto.ExecRunning {
		t.Fatalf("get while it starts: %+v, %v", status, err)
	}
	kill := killAsync(t, h, "sbx_1", "cmd_s")
	noAnswerYet(t, kill)
	close(tier.hold)
	if err := <-started; err != nil {
		t.Fatal(err)
	}
	if err := <-kill; err != nil {
		t.Fatalf("kill after the start: %v", err)
	}
	tier.mu.Lock()
	defer tier.mu.Unlock()
	if n := len(tier.killed); n == 0 || tier.killed[n-1] != "cmd_s" {
		t.Fatalf("the guest's command wasn't killed once it had it: %v", tier.killed)
	}
	if h.runs.get(runKey("sbx_1", "cmd_s")) != nil {
		t.Fatal("the reservation outlived the start")
	}
}

// A kill that waited for a guest start, whose guest then fails to take the kill, answers that failure: the caller
// knows it may run on, and can kill it again.
func TestAKillTheGuestDidntTakeIsReportedNotForgotten(t *testing.T) {
	tier := &runnerTier{heldTier: newHeldTier(), hold: make(chan struct{}), holding: make(chan struct{}), killErr: errors.New("vsock: connection reset")}
	h := hostWith(t, tier)
	go func() {
		_, _ = callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "./serve", Detached: true, CommandID: "cmd_f"})
	}()
	<-tier.holding
	kill := killAsync(t, h, "sbx_1", "cmd_f")
	close(tier.hold)
	if err := <-kill; err == nil {
		t.Fatal("a kill the guest didn't take was answered done")
	}
}

// An older guest answers unsupported after a get and a kill came for the start: the get saw it running, and the kill,
// which waited for the start, kills the host-run fallback that took the reservation's place.
func TestAKillDuringAnOlderGuestsStartReachesTheFallback(t *testing.T) {
	tier := &runnerTier{heldTier: newHeldTier(), old: true, hold: make(chan struct{}), holding: make(chan struct{})}
	h := hostWith(t, tier)
	started := make(chan error, 1)
	go func() {
		_, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "./serve", Detached: true, CommandID: "cmd_o"})
		started <- err
	}()
	<-tier.holding
	if status, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_o"}); err != nil || status.State != proto.ExecRunning {
		t.Fatalf("get while it starts: %+v, %v", status, err)
	}
	kill := killAsync(t, h, "sbx_1", "cmd_o")
	noAnswerYet(t, kill)
	close(tier.hold)
	if err := <-started; err != nil {
		t.Fatal(err)
	}
	if err := <-kill; err != nil {
		t.Fatalf("kill after the fallback started: %v", err)
	}
	ended, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_o", WaitMs: 5000})
	if err != nil || ended.State != proto.ExecEnded || ended.Result.ExitCode != 137 {
		t.Fatalf("the fallback after the kill: %+v, %v", ended, err)
	}
}

// A guest whose answer to the start was lost (a transport error) but which has the command is taken as started.
func TestAGuestStartWhoseAnswerWasLostIsAskedFor(t *testing.T) {
	tier := &runnerTier{heldTier: newHeldTier(), lostAnswer: true}
	h := hostWith(t, tier)
	status, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "./serve", Detached: true, CommandID: "cmd_l"})
	if err != nil || status.State != proto.ExecRunning {
		t.Fatalf("start: %+v, %v", status, err)
	}
	if len(tier.begun) != 1 || len(tier.execs) != 0 {
		t.Fatalf("started %d in the guest, ran %d here", len(tier.begun), len(tier.execs))
	}
	if h.runs.get(runKey("sbx_1", "cmd_l")) != nil {
		t.Fatal("the reservation outlived the start")
	}
}

// A guest whose start answer and status probe both fail may have the command: the start is answered running but
// unconfirmed, for Kantel to follow by its ID, never as a failure. A probe that says it has none leaves the error.
func TestAGuestStartThatCantBeConfirmedIsntAFailure(t *testing.T) {
	tier := &runnerTier{heldTier: newHeldTier(), lostAnswer: true, probeErr: errors.New("vsock: connection reset")}
	h := hostWith(t, tier)
	status, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "./serve", Detached: true, CommandID: "cmd_u"})
	if err != nil || status.State != proto.ExecRunning || !status.Unconfirmed {
		t.Fatalf("start: %+v, %v", status, err)
	}
	tier.probeErr = &proto.Error{Code: proto.ErrNotFound, Message: "no such command"}
	if _, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "./serve", Detached: true, CommandID: "cmd_n"}); err == nil {
		t.Fatal("a start the guest says it doesn't have was answered started")
	}
}

// A get that took a reservation as its start settled reads it as running, never as an exit with no result.
func TestAReleasedReservationIsNeverAnEnd(t *testing.T) {
	var runs commandRuns
	for _, release := range []func(key string, r *commandRun){
		func(key string, r *commandRun) { runs.unreserve(key, r) },
		func(key string, r *commandRun) {
			runs.replace(key, r, &commandRun{cancel: func() {}, done: make(chan struct{}), detached: true})
		},
	} {
		key := runKey("sbx_1", "cmd_r")
		reserved := &commandRun{cancel: func() {}, done: make(chan struct{}), reserved: true}
		if r := runs.add(key, reserved); r != added {
			t.Fatalf("add: %v", r)
		}
		seen := runs.get(key)
		release(key, reserved)
		if status := runs.status("cmd_r", seen); status.State != proto.ExecRunning || status.Result != nil {
			t.Fatalf("a released reservation read as %+v", status)
		}
		runs.forget("sbx_1")
	}
	// A run that really ended keeps its result.
	key := runKey("sbx_1", "cmd_d")
	run := &commandRun{cancel: func() {}, done: make(chan struct{}), detached: true}
	runs.add(key, run)
	runs.end(key, run, proto.ExecResult{ExitCode: 4, Stdout: "out"}, nil)
	if status := runs.status("cmd_d", run); status.State != proto.ExecEnded || status.Result.ExitCode != 4 {
		t.Fatalf("an ended run read as %+v", status)
	}
}

// A kill that overtakes its start (calls are handled concurrently) makes the start refused: the command never runs.
func TestAKillThatOvertakesItsStartKeepsItFromRunning(t *testing.T) {
	held := newHeldTier()
	guest := &runnerTier{heldTier: newHeldTier()}
	for name, tier := range map[string]Tier{"host-run": held, "guest": guest} {
		t.Run(name, func(t *testing.T) {
			h := hostWith(t, tier)
			killed, err := callCmd[proto.ExecKilled](t, h, context.Background(), proto.MethodExecKill, proto.ExecRef{SandboxID: "sbx_1", CommandID: "cmd_e"})
			if err != nil || killed.Killed {
				t.Fatalf("kill: %+v, %v", killed, err)
			}
			for _, detached := range []bool{true, false} {
				_, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExec, proto.ExecParams{SandboxID: "sbx_1", Command: "sleep 600", Detached: detached, CommandID: "cmd_e"})
				var pe *proto.Error
				if !errors.As(err, &pe) || pe.Code != proto.ErrConflict {
					t.Fatalf("detached %v: the overtaken start wasn't refused: %v", detached, err)
				}
			}
		})
	}
	if len(held.execs) != 0 || len(guest.begun) != 0 || len(guest.execs) != 0 {
		t.Fatalf("ran %d, started %d in the guest, ran %d there", len(held.execs), len(guest.begun), len(guest.execs))
	}
}

// A host-run detached command that ends before its start is answered doesn't release its call's guard (which would end
// the call's context and turn the answer into a conflict): the guard goes only once the call and the run have both let
// go.
func TestAShortDetachedRunDoesntEndItsCallFirst(t *testing.T) {
	tier := newHeldTier()
	h := hostWith(t, tier)
	guard, end := context.WithCancel(context.Background())
	defer end()
	var mu sync.Mutex
	releases := 0
	ctx, rel := withRelease(guard, func() {
		mu.Lock()
		releases++
		mu.Unlock()
		end()
	})
	count := func() int {
		mu.Lock()
		defer mu.Unlock()
		return releases
	}
	tier.release <- proto.ExecResult{ExitCode: 0, Stdout: "quick"}
	if _, err := callCmd[proto.ExecStatus](t, h, ctx, proto.MethodExec, proto.ExecParams{SandboxID: "iso_1", Command: "true", Detached: true, CommandID: "cmd_q"}); err != nil {
		t.Fatal(err)
	}
	ended, err := callCmd[proto.ExecStatus](t, h, context.Background(), proto.MethodExecGet, proto.ExecRef{SandboxID: "iso_1", CommandID: "cmd_q", WaitMs: 5000})
	if err != nil || ended.State != proto.ExecEnded || ended.Result.Stdout != "quick" {
		t.Fatalf("the run: %+v, %v", ended, err)
	}
	time.Sleep(20 * time.Millisecond)
	// The run has ended and let go; the call hasn't yet, so its context is still live and the guard held.
	if guard.Err() != nil || count() != 0 {
		t.Fatalf("the run's end released the call's guard (released %d)", count())
	}
	rel.release()
	if count() != 1 || guard.Err() == nil {
		t.Fatalf("the guard wasn't released once both let go (released %d)", count())
	}
}
