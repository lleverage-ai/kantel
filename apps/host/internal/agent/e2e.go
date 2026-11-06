package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
	"github.com/lleverage-ai/kantel/apps/host/internal/egress"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// End-to-end encryption on the host (package e2e). A sandbox's space is its owner. When the host holds that space's
// chain with E2E on, the gateway's own calls can still run the sandbox's lifecycle (create, stop, resume, fork,
// delete, snapshots) but not reach its content: commands, files, snapshot contents and ports are served only inside
// E2E sessions from the chain's devices, which the gateway relays as a port.open of port 0 and can't read.

// contentMethods are the calls that read or change what is in a sandbox. Its processes' command lines are content too:
// they hold what was typed, arguments and all.
var contentMethods = []string{
	proto.MethodExec, proto.MethodFileRead, proto.MethodFileWrite, proto.MethodFileDelete, proto.MethodFileList,
	proto.MethodProcesses,
}

// sessionMethods are what a device may call in an E2E session, on the session's sandbox only.
var sessionMethods = append([]string{proto.MethodGet}, contentMethods...)

// ownerOf is the space a sandbox belongs to ("" when the host has no such sandbox).
func (h *Host) ownerOf(sandboxID string) string {
	t, err := h.tierOf(sandboxID)
	if err != nil {
		return ""
	}
	info, err := t.Get(sandboxID)
	if err != nil {
		return ""
	}
	return info.Owner
}

// snapshotOwner is the space of the sandbox snapshotID in tier t is of: the one the call goes on to use, as snapshot IDs
// aren't unique across tiers. The snapshot keeps its sandbox's ID after the sandbox is deleted; a sandbox ID once seen
// in an E2E space keeps that space, whoever has the ID now. Unknown (false) when the sandbox is gone and wasn't E2E's.
func (h *Host) snapshotOwner(t Tier, snapshotID string) (string, bool) {
	if t == nil {
		return "", false
	}
	for _, snap := range t.Snapshots("") {
		if snap.ID != snapshotID {
			continue
		}
		if space, ok := h.recordedOwner(snap.SandboxID); ok {
			return space, true
		}
		if owner := h.ownerOf(snap.SandboxID); owner != "" {
			return owner, true
		}
		return "", false
	}
	return "", false
}

// recordE2E keeps that sandboxID is in space when E2E is on there, before the gateway can delete it and reuse its ID.
func (h *Host) recordE2E(sandboxID, space string) error {
	if h.e2e == nil || sandboxID == "" || space == "" || h.e2eMode(space) == e2e.ModeOff {
		return nil
	}
	if err := h.e2e.RecordOwner(sandboxID, space); err != nil {
		return &proto.Error{Code: proto.ErrInternal, Message: "couldn't record an E2E sandbox: " + err.Error()}
	}
	return nil
}

// anyE2E reports whether the host holds an E2E chain that is on (or one it can't verify).
// gatewayUpdate runs an update the gateway asked for (host.update or a welcome's version), on a host that has never
// joined a space only, and never across a join.
func (h *Host) gatewayUpdate(ctx context.Context, p proto.UpdateParams, update Updater) error {
	if h.e2e == nil {
		return update(ctx, p)
	}
	err := h.e2e.Unenrolled(func() error { return update(ctx, p) })
	if errors.Is(err, e2e.ErrEnrolled) {
		return &proto.Error{Code: proto.ErrUnsupported, Message: err.Error()}
	}
	return err
}

func (h *Host) anyE2E() bool {
	if h.e2e == nil {
		return false
	}
	for _, space := range h.e2e.Spaces() {
		if h.e2e.Mode(space) != e2e.ModeOff {
			return true
		}
	}
	return false
}

// snapshotGuarded is the space whose E2E covers a snapshot's content. A snapshot whose sandbox is gone has no owner
// the host knows, so on a host with any E2E space it is treated as covered (refused), not as plaintext.
func (h *Host) snapshotGuarded(t Tier, snapshotID string) (space string, covered bool) {
	owner, known := h.snapshotOwner(t, snapshotID)
	if !known {
		return "a space on this host", h.anyE2E()
	}
	return owner, h.e2eMode(owner) != e2e.ModeOff
}

// egressPublic is whether a sandbox's outbound requests may be told to the gateway: not one in an E2E space, whose
// request paths (and any token in them) are the space's own, nor, on a host holding E2E spaces, one whose space it
// can't tell.
func (h *Host) egressPublic(sandboxID string) bool {
	if h.e2e == nil || len(h.e2e.Spaces()) == 0 {
		return true
	}
	space := h.ownerOf(sandboxID)
	return space != "" && h.e2eMode(space) == e2e.ModeOff
}

// recordEgress batches a proxy record for the gateway, unless egressPublic says it isn't the gateway's to see.
func (h *Host) recordEgress(r egress.Record) {
	if h.egressPublic(r.SandboxID) {
		h.egressLog.add(r)
	}
}

func (h *Host) e2eMode(space string) string {
	if h.e2e == nil || space == "" {
		return e2e.ModeOff
	}
	return h.e2e.Mode(space)
}

func (h *Host) recordedOwner(sandboxID string) (string, bool) {
	if h.e2e == nil || sandboxID == "" {
		return "", false
	}
	return h.e2e.RecordedOwner(sandboxID)
}

func e2eRefusal(space string) error {
	return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: its sandboxes' content is reachable only in an E2E session (kantel e2e)", space)}
}

// gatewayMayCall refuses a call from the control plane that would reach the content of a sandbox in an E2E space.
func (h *Host) gatewayMayCall(method string, params json.RawMessage) error {
	var p struct {
		SandboxID         string              `json:"sandboxId"`
		NewID             string              `json:"newId"`
		SnapshotID        string              `json:"snapshotId"`
		Port              int                 `json:"port"`
		From              string              `json:"from"`
		Owner             string              `json:"owner"`
		Tier              string              `json:"tier"`
		Env               map[string]string   `json:"env"`
		SSHAuthorizedKeys []string            `json:"sshAuthorizedKeys"`
		Egress            *proto.Egress       `json:"egress"`
		Template          *proto.TemplateBoot `json:"template"`
		// Mounts are only counted: a mount is files the gateway chooses (a bucket it names, answering bucket.fetch), so
		// an E2E space's sandbox takes none.
		Mounts []json.RawMessage `json:"mounts"`
	}
	_ = json.Unmarshal(params, &p)
	// A create or fork reads its space's E2E epoch once, before any check (egress included): if E2E comes on while the
	// checks run, the sandbox is recorded under the epoch before (none, or an older one), so it isn't trusted under the
	// new one (markBorn, bornUnder).
	var since string
	switch method {
	case proto.MethodCreate:
		since = h.onSince(p.Owner)
	case proto.MethodFork:
		since = h.onSince(h.ownerOf(p.SandboxID))
	}
	if method == proto.MethodHostUpdate && h.e2e != nil && h.e2e.Enrolled() {
		// A binary the gateway picks could read every session and take the host's key: a host that has joined a space,
		// on or off now, is updated on the machine. gatewayUpdate checks again under the enrolment lock.
		return &proto.Error{Code: proto.ErrUnsupported, Message: e2e.ErrEnrolled.Error()}
	}
	if method != proto.MethodCreate {
		if err := h.recordE2E(p.SandboxID, h.ownerOf(p.SandboxID)); err != nil {
			return err
		}
	}
	// Egress the gateway sets may not put a CA of its own in the sandbox, nor take its traffic to an upstream of its
	// own: either would let the gateway read what the sandbox sends.
	if p.Egress != nil {
		target := h.ownerOf(p.SandboxID)
		if method == proto.MethodCreate {
			target = p.Owner
		}
		if h.e2eMode(target) != e2e.ModeOff {
			if why := egressReaches(p.Egress); why != "" {
				return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: its sandboxes take no %s from the gateway", target, why)}
			}
		}
	}
	// On a host holding E2E spaces a snapshot's ID is its own, in every tier: with two of one ID, which one a later call
	// reached would depend on which tier looked first.
	if h.anyE2E() {
		var made []string
		switch method {
		case proto.MethodStop, proto.MethodSnapshotSave:
			made = []string{p.SnapshotID}
		case proto.MethodFork:
			made = []string{p.SnapshotID, "fork-" + p.NewID}
		}
		for _, id := range made {
			if id != "" && h.snapshotExists(id) {
				return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("snapshot %s already exists on this host", id)}
			}
		}
	}
	space := ""
	switch {
	case slices.Contains(contentMethods, method), method == proto.MethodFileOpen, method == proto.MethodFileExtract,
		method == proto.MethodExecGet, method == proto.MethodExecKill:
		// A command's output (sandbox.exec.get) is what its exec would have answered, and a kill reaches what it runs.
		// A file stream (or an archive's extraction) reads or writes what the file calls do, so it is refused exactly when
		// they are.
		space = h.ownerOf(p.SandboxID)
	case method == proto.MethodPortOpen && p.Port != proto.PortE2E:
		space = h.ownerOf(p.SandboxID)
	case method == proto.MethodSnapshotRead || method == proto.MethodSnapshotTree:
		// The tier the read will use (Host.Call's tierOfSnapshot), not whichever has a snapshot of that ID.
		t, err := h.tierOfSnapshot(p.SnapshotID)
		if err != nil {
			return nil
		}
		if s, covered := h.snapshotGuarded(t, p.SnapshotID); covered {
			return e2eRefusal(s)
		}
		return nil
	case method == proto.MethodCreate:
		// An ID once used in an E2E space isn't given to another space: its snapshots would follow it.
		if was, ok := h.recordedOwner(p.SandboxID); ok && was != p.Owner {
			return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox ID %s was used in %s, which is end-to-end encrypted", p.SandboxID, was)}
		}
		if err := h.freshForE2E(p.SandboxID, p.Owner); err != nil {
			return err
		}
		// The gateway gives an E2E space's sandbox no environment or SSH keys of its own, made fresh or from a snapshot: an
		// exported function such as BASH_FUNC_cat%% (or LD_PRELOAD, BASH_ENV) would run in every command a device runs.
		if h.e2eMode(p.Owner) != e2e.ModeOff && (len(p.Env) > 0 || len(p.SSHAuthorizedKeys) > 0) {
			return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: its sandboxes take no environment variables or SSH keys from the gateway", p.Owner)}
		}
		// Nor a template: its image and setup are the gateway's, and would run in every command a device runs.
		if h.e2eMode(p.Owner) != e2e.ModeOff && p.Template != nil {
			return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: its sandboxes aren't made from templates", p.Owner)}
		}
		// Nor mounts: the gateway picks the bucket and answers bucket.fetch, so it would choose what a mount holds, such
		// as a .bash_profile at /home/user that every command a device runs (bash -lc) sources.
		if h.e2eMode(p.Owner) != e2e.ModeOff && len(p.Mounts) > 0 {
			return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: its sandboxes take no mounts from the gateway", p.Owner)}
		}
		if p.From != "" {
			// A sandbox made from an E2E sandbox's snapshot stays in that space, or its content would be plaintext; and the
			// gateway can't give it environment variables or SSH keys of its own. The snapshot is the one in the tier the
			// create uses.
			t, _ := h.tier(p.Tier)
			owner, known := h.snapshotOwner(t, p.From)
			// Nor does an E2E space take a disk from elsewhere: a plaintext snapshot the gateway prepared (with its own
			// /etc/profile.d, say) would run in every command a device runs.
			if h.e2eMode(p.Owner) != e2e.ModeOff && (!known || owner != p.Owner) {
				return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: its sandboxes are made fresh or from its own snapshots, not from another space's", p.Owner)}
			}
			// Its own, taken of a sandbox made under E2E: not one from before E2E was on, which the gateway could have
			// written.
			if h.e2eMode(p.Owner) != e2e.ModeOff && !h.snapshotBorn(t, p.From, p.Owner) {
				return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: snapshot %s is of a sandbox made while E2E was off, so a new sandbox isn't made from it", p.Owner, p.From)}
			}
			if s, covered := h.snapshotGuarded(t, p.From); covered {
				if !known || owner != p.Owner {
					return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("a sandbox made from a snapshot in %s, which is end-to-end encrypted, must be in that space", s)}
				}
				if len(p.Env) > 0 || len(p.SSHAuthorizedKeys) > 0 || len(p.Mounts) > 0 {
					return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: a sandbox made from its snapshot takes no environment variables, SSH keys or mounts from the gateway", s)}
				}
			}
		}
		if err := h.recordE2E(p.SandboxID, p.Owner); err != nil {
			return err
		}
		return h.markBorn(p.SandboxID, p.Owner, since)
	case method == proto.MethodFork:
		owner := h.ownerOf(p.SandboxID)
		if h.e2eMode(owner) != e2e.ModeOff {
			if len(p.Env) > 0 || len(p.Mounts) > 0 {
				return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: a fork takes no environment variables or mounts from the gateway", owner)}
			}
			// A fork copies its source's disk: one of a sandbox made while E2E was off would carry what the gateway left.
			if since == "" || !h.bornUnder(p.SandboxID, owner, since) {
				return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: %s was made while E2E was off, so it isn't forked", owner, p.SandboxID)}
			}
			if was, ok := h.recordedOwner(p.NewID); ok && was != owner {
				return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox ID %s was used in %s", p.NewID, was)}
			}
			if err := h.freshForE2E(p.NewID, owner); err != nil {
				return err
			}
			if err := h.recordE2E(p.NewID, owner); err != nil {
				return err
			}
			return h.markBorn(p.NewID, owner, since)
		}
		if was, ok := h.recordedOwner(p.NewID); ok && was != owner {
			return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox ID %s was used in %s, which is end-to-end encrypted", p.NewID, was)}
		}
		return h.markBorn(p.NewID, owner, since)
	default:
		return nil
	}
	if h.e2eMode(space) != e2e.ModeOff {
		return e2eRefusal(space)
	}
	return nil
}

func (h *Host) snapshotExists(id string) bool {
	for _, name := range h.order {
		if h.tiers[name].HasSnapshot(id) {
			return true
		}
	}
	return false
}

// freshForE2E refuses to give id to E2E space when it names a sandbox, or snapshots, the host doesn't already know as
// that space's: recording it would make another space's disk (one the gateway could have prepared) the E2E space's.
func (h *Host) freshForE2E(id, space string) error {
	if h.e2eMode(space) == e2e.ModeOff {
		return nil
	}
	if _, err := h.tierOf(id); err == nil {
		return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox %s already exists on this host", id)}
	}
	for _, name := range h.order {
		if len(h.tiers[name].Snapshots(id)) > 0 {
			return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox ID %s has snapshots on this host: an E2E sandbox takes an ID of its own", id)}
		}
	}
	return nil
}

// egressReaches says what in e would let the gateway read a sandbox's traffic ("" when nothing): an upstream proxy, a
// CA, or interception (protected variables, or grants on methods or paths). Rules on hosts alone are fine.
func egressReaches(e *proto.Egress) string {
	switch {
	case e.Upstream != "" || e.Token != "" || len(e.Headers) > 0:
		return "upstream proxy"
	case strings.TrimSpace(e.CACert) != "":
		return "certificate authority"
	case e.Protected != nil:
		return "protected variables"
	}
	for _, g := range e.Grants {
		if len(g.Methods) > 0 || len(g.Paths) > 0 {
			return "intercepting grants"
		}
	}
	return ""
}

// e2eGate keeps every gateway call's E2E check true while it runs: the check is made on IDs, which the call then
// resolves again, so what an ID names mustn't change in between. One rule does it, whatever the call: a gateway call
// "uses" each sandbox and snapshot ID it names, from before its check until it ends; a call that changes what an ID
// names (a create or delete, the new ID of a fork, a snapshot it saves or deletes) "claims" that ID first, which
// cancels the calls using it, waits for them to end, and turns new ones away until the claim is done. So an ID's
// owner is the same at a call's check and all through it, whichever tier it resolves to.
type e2eGate struct {
	mu      sync.Mutex
	cond    *sync.Cond
	calls   map[string]map[int]context.CancelFunc
	claimed map[string]int
	next    int
}

func (g *e2eGate) init() {
	if g.cond == nil {
		g.cond = sync.NewCond(&g.mu)
		g.calls = map[string]map[int]context.CancelFunc{}
		g.claimed = map[string]int{}
	}
}

// use puts a call on keys; false when one of them is claimed. leave is to be called when the call ends. A claim cancels
// a cancellable call (one reading or running something); others (lifecycle calls) are let finish.
func (g *e2eGate) use(ctx context.Context, keys []string, cancellable bool) (context.Context, func(), bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.init()
	for _, key := range keys {
		if g.claimed[key] > 0 {
			return ctx, func() {}, false
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	g.next++
	n := g.next
	onClaim := cancel
	if !cancellable {
		onClaim = func() {}
	}
	for _, key := range keys {
		if g.calls[key] == nil {
			g.calls[key] = map[int]context.CancelFunc{}
		}
		g.calls[key][n] = onClaim
	}
	return ctx, func() {
		g.mu.Lock()
		for _, key := range keys {
			delete(g.calls[key], n)
			if len(g.calls[key]) == 0 {
				delete(g.calls, key)
			}
		}
		g.cond.Broadcast()
		g.mu.Unlock()
		cancel()
	}, true
}

// claim takes keys for one call at a time (waiting for another claim of any of them to be done), cancels the calls
// using them and waits for those to end, and keeps new ones out until release. A claim is taken whole or not at all,
// and waits only on calls past their own claims, which wait on nothing in the gate, so claims can't deadlock.
func (g *e2eGate) claim(keys []string) (release func()) {
	release, _ = g.claimIf(keys, true)
	return release
}

// tryClaim is claim, but false at once (rather than waiting) when another claim holds one of keys: for a second claim
// made holding a first, which waiting could deadlock.
func (g *e2eGate) tryClaim(keys []string) (func(), bool) {
	return g.claimIf(keys, false)
}

func (g *e2eGate) claimIf(keys []string, wait bool) (func(), bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.init()
	for slices.ContainsFunc(keys, func(key string) bool { return g.claimed[key] > 0 }) {
		if !wait {
			return func() {}, false
		}
		g.cond.Wait()
	}
	for _, key := range keys {
		g.claimed[key]++
		for _, cancel := range g.calls[key] {
			cancel()
		}
	}
	for slices.ContainsFunc(keys, func(key string) bool { return len(g.calls[key]) > 0 }) {
		g.cond.Wait()
	}
	return func() {
		g.mu.Lock()
		for _, key := range keys {
			g.claimed[key]--
			if g.claimed[key] == 0 {
				delete(g.claimed, key)
			}
		}
		g.cond.Broadcast()
		g.mu.Unlock()
	}, true
}

// sandboxOf is the sandbox a stop, save, fork, start or resume acts on.
func sandboxOf(method string, params json.RawMessage) (string, bool) {
	switch method {
	case proto.MethodStop, proto.MethodSnapshotSave, proto.MethodFork, proto.MethodStart, proto.MethodResume:
		var p struct {
			SandboxID string `json:"sandboxId"`
		}
		_ = json.Unmarshal(params, &p)
		return p.SandboxID, p.SandboxID != ""
	}
	return "", false
}

// gateKeys are the IDs a gateway call uses and claims (e2eGate).
func gateKeys(method string, params json.RawMessage) (uses, claims []string) {
	var p struct {
		SandboxID  string `json:"sandboxId"`
		NewID      string `json:"newId"`
		SnapshotID string `json:"snapshotId"`
		From       string `json:"from"`
	}
	_ = json.Unmarshal(params, &p)
	sandbox := func(id string) string { return "sandbox:" + id }
	snapshot := func(id string) string { return "snapshot:" + id }
	// A sandbox's snapshot-making and -restoring calls (stop, save, fork, start, resume) take turns, so one restoring
	// the newest snapshot holds all of them (gatewayGuard).
	lifecycle := func(id string) string { return "lifecycle:" + id }
	add := func(list *[]string, key, id string) {
		if id != "" {
			*list = append(*list, key)
		}
	}
	switch method {
	case proto.MethodCreate:
		add(&claims, sandbox(p.SandboxID), p.SandboxID)
		add(&uses, snapshot(p.From), p.From)
	case proto.MethodDelete:
		add(&claims, sandbox(p.SandboxID), p.SandboxID)
	case proto.MethodFork:
		add(&uses, sandbox(p.SandboxID), p.SandboxID)
		add(&claims, lifecycle(p.SandboxID), p.SandboxID)
		add(&claims, sandbox(p.NewID), p.NewID)
		add(&claims, snapshot(p.SnapshotID), p.SnapshotID)
		// The isolate tier names a fork's snapshot after the fork when the call doesn't.
		add(&claims, snapshot("fork-"+p.NewID), p.NewID)
	case proto.MethodStop, proto.MethodSnapshotSave:
		add(&uses, sandbox(p.SandboxID), p.SandboxID)
		add(&claims, lifecycle(p.SandboxID), p.SandboxID)
		add(&claims, snapshot(p.SnapshotID), p.SnapshotID)
	case proto.MethodStart, proto.MethodResume:
		add(&uses, sandbox(p.SandboxID), p.SandboxID)
		add(&claims, lifecycle(p.SandboxID), p.SandboxID)
	case proto.MethodSnapshotDel:
		add(&claims, snapshot(p.SnapshotID), p.SnapshotID)
	case proto.MethodSnapshotRead, proto.MethodSnapshotTree:
		add(&uses, snapshot(p.SnapshotID), p.SnapshotID)
	default:
		add(&uses, sandbox(p.SandboxID), p.SandboxID)
	}
	slices.Sort(claims)
	claims = slices.Compact(claims)
	uses = slices.DeleteFunc(uses, func(k string) bool { return slices.Contains(claims, k) })
	return uses, claims
}

// gatewayGuard is gatewayMayCall with the call bound to what it checked (e2eGate): ctx is the call's context, and done
// is called when the call has ended.
func (h *Host) gatewayGuard(ctx context.Context, method string, params json.RawMessage) (context.Context, func(), error) {
	uses, claims := gateKeys(method, params)
	release := func() {}
	if len(claims) > 0 {
		release = h.gate.claim(claims)
	}
	// A sandbox's own snapshots too, listed once the call holds the sandbox's lifecycle claim (so no stop or save of it
	// can add one the list missed): a start, resume or fork of a stopped sandbox restores the newest of them, which
	// mustn't be deleted and made again from another sandbox's disk while it does; and a stop, save or fork deletes
	// the oldest automatic ones, so it claims them all, as a snapshot.delete would.
	var own []string
	if id, ok := sandboxOf(method, params); ok {
		for _, name := range h.order {
			for _, snap := range h.tiers[name].Snapshots(id) {
				own = append(own, "snapshot:"+snap.ID)
			}
		}
	}
	switch method {
	case proto.MethodStart, proto.MethodResume:
		uses = append(uses, own...)
	case proto.MethodStop, proto.MethodSnapshotSave, proto.MethodFork:
		more := slices.DeleteFunc(own, func(k string) bool { return slices.Contains(claims, k) })
		if len(more) > 0 {
			slices.Sort(more)
			releaseMore, ok := h.gate.tryClaim(slices.Compact(more))
			if !ok {
				release()
				return ctx, func() {}, &proto.Error{Code: proto.ErrConflict, Message: "a snapshot of this sandbox is being made or deleted: try again"}
			}
			first := release
			release = func() {
				releaseMore()
				first()
			}
		}
		claims = append(claims, more...)
	}
	slices.Sort(uses)
	uses = slices.DeleteFunc(slices.Compact(uses), func(k string) bool { return slices.Contains(claims, k) })
	cancellable := slices.Contains(contentMethods, method) || method == proto.MethodExecGet || method == proto.MethodPortOpen ||
		method == proto.MethodFileOpen || method == proto.MethodSnapshotRead || method == proto.MethodSnapshotTree
	ctx, leave, ok := h.gate.use(ctx, uses, cancellable)
	if !ok {
		release()
		return ctx, func() {}, &proto.Error{Code: proto.ErrConflict, Message: "a sandbox or snapshot this call names is being made or deleted: try again"}
	}
	done := func() {
		leave()
		release()
	}
	// A plaintext call that reads or runs something ends if its space turns E2E on while it runs (a join, or an entry a
	// session brings), rather than keeping what it reached; it is watched from before its check (watchPlain).
	if cancellable && !isE2EPort(method, params) {
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		forget := h.watchPlain(h.spaceOfCall(method, params), cancel)
		inner := done
		done = func() {
			forget()
			cancel()
			inner()
		}
	}
	if err := h.gatewayMayCall(method, params); err != nil {
		done()
		return ctx, func() {}, err
	}
	return ctx, done, nil
}

// isE2EPort is whether a call opens port 0, a device's E2E session, which isn't plaintext.
func isE2EPort(method string, params json.RawMessage) bool {
	if method != proto.MethodPortOpen {
		return false
	}
	var p proto.PortParams
	return json.Unmarshal(params, &p) == nil && p.Port == proto.PortE2E
}

// spaceOfCall is the space of the sandbox (or snapshot) a content call reaches, or "".
func (h *Host) spaceOfCall(method string, params json.RawMessage) string {
	var p struct {
		SandboxID  string `json:"sandboxId"`
		SnapshotID string `json:"snapshotId"`
	}
	_ = json.Unmarshal(params, &p)
	if method == proto.MethodSnapshotRead || method == proto.MethodSnapshotTree {
		t, err := h.tierOfSnapshot(p.SnapshotID)
		if err != nil {
			return ""
		}
		space, _ := h.snapshotOwner(t, p.SnapshotID)
		return space
	}
	return h.ownerOf(p.SandboxID)
}

// plainCalls are the gateway's plaintext calls and port streams in flight, by their space ("" when the host can't
// tell it), so none outlives its space turning E2E on by long (watchPlainLoop).
type plainCalls struct {
	mu       sync.Mutex
	cond     *sync.Cond
	next     int
	calls    map[int]*plainCall
	watching bool
}

type plainCall struct {
	space string
	end   func()
	ended bool
}

// watchPlain tracks a plaintext call or stream until forget: end stops it (cancels its context, closes its stream)
// when its space turns E2E on. A call registers before it checks its space's mode, so either it sees E2E on and is
// refused, or watchPlainLoop finds it. (A device never reaches what such a call touched: only sandboxes made under E2E
// take sessions, bornIn.)
func (h *Host) watchPlain(space string, end func()) (forget func()) {
	if h.e2e == nil {
		return func() {}
	}
	pc := &h.plain
	pc.mu.Lock()
	defer pc.mu.Unlock()
	if pc.calls == nil {
		pc.calls = map[int]*plainCall{}
		pc.cond = sync.NewCond(&pc.mu)
	}
	pc.next++
	n := pc.next
	pc.calls[n] = &plainCall{space: space, end: end}
	if !pc.watching {
		pc.watching = true
		go h.watchPlainLoop()
	}
	return func() {
		pc.mu.Lock()
		delete(pc.calls, n)
		pc.cond.Broadcast()
		pc.mu.Unlock()
	}
}

// protectedNow is whether a plaintext call in space mustn't run on: its space is E2E on or strict, or the host can't
// tell its space and holds some space that is.
func (h *Host) protectedNow(space string) bool {
	if space != "" {
		return h.e2eMode(space) != e2e.ModeOff
	}
	for _, sp := range h.e2e.Spaces() {
		if h.e2eMode(sp) != e2e.ModeOff {
			return true
		}
	}
	return false
}

// watchPlainLoop ends, every plainRecheck while any plaintext call runs, those whose space has turned E2E on.
func (h *Host) watchPlainLoop() {
	every := h.plainRecheck
	if every <= 0 {
		every = 2 * time.Second
	}
	tick := time.NewTicker(every)
	defer tick.Stop()
	pc := &h.plain
	for range tick.C {
		pc.mu.Lock()
		if len(pc.calls) == 0 {
			pc.watching = false
			pc.mu.Unlock()
			return
		}
		calls := slices.Collect(maps.Values(pc.calls))
		pc.mu.Unlock()
		protected := map[string]bool{}
		for _, c := range calls {
			if _, ok := protected[c.space]; !ok {
				protected[c.space] = h.protectedNow(c.space)
			}
		}
		var ending []func()
		pc.mu.Lock()
		for _, c := range calls {
			if protected[c.space] && !c.ended {
				c.ended = true
				ending = append(ending, c.end)
			}
		}
		pc.mu.Unlock()
		for _, end := range ending {
			end()
		}
	}
}

// serveE2E runs one E2E session on conn, for a session the control plane relays to sandboxID.
// notBorn is a session's refusal of a sandbox the host didn't make while its space was E2E.
const notBorn = "This sandbox was made while E2E was off in its space (or before this host joined its chain): " +
	"the gateway could have changed it, so no E2E session reaches it. Delete it and make a new one"

// bornIn is whether sandboxID is one the host made while space was E2E, with E2E on there without a break since
// (the chain's OnSince is still the one it was made under), and still in space. The record is the host's own
// (born.json): nothing the gateway sends sets it.
func (h *Host) bornIn(sandboxID, space string) bool {
	return h.bornUnder(sandboxID, space, h.onSince(space))
}

// bornUnder is bornIn, for the epoch since that a call read once.
func (h *Host) bornUnder(sandboxID, space, since string) bool {
	if h.e2e == nil || space == "" || since == "" {
		return false
	}
	b, ok := h.e2e.BornRecord(sandboxID)
	return ok && b.Space == space && b.OnSince == since && h.ownerOf(sandboxID) == space
}

// onSince is space's E2E epoch (its chain's OnSince), "" when E2E is off there.
func (h *Host) onSince(space string) string {
	if h.e2e == nil || space == "" {
		return ""
	}
	return h.e2e.OnSince(space)
}

// snapshotBorn is whether a snapshot in tier t was taken of a sandbox bornIn space, after it was made: one taken of an
// earlier sandbox of that ID, or while E2E was off, isn't.
func (h *Host) snapshotBorn(t Tier, snapshotID, space string) bool {
	if t == nil || h.e2e == nil {
		return false
	}
	for _, snap := range t.Snapshots("") {
		if snap.ID != snapshotID {
			continue
		}
		b, ok := h.e2e.BornRecord(snap.SandboxID)
		if !ok || b.Space != space || snap.CreatedAt <= b.At {
			return false
		}
		since := h.e2e.OnSince(space)
		return since != "" && since == b.OnSince
	}
	return false
}

// markBorn records, before the create or fork runs, whether sandboxID is made under E2E: born in space under the epoch
// since the call read before its checks, when there was one, and otherwise any record an earlier sandbox of that ID
// left is dropped.
func (h *Host) markBorn(sandboxID, space, since string) error {
	if h.e2e == nil || sandboxID == "" {
		return nil
	}
	var err error
	if space != "" && since != "" {
		err = h.e2e.RecordBorn(sandboxID, e2e.Born{Space: space, OnSince: since, At: time.Now().UnixMilli()})
	} else {
		err = h.e2e.ForgetBorn(sandboxID)
	}
	if err != nil {
		return &proto.Error{Code: proto.ErrInternal, Message: "couldn't record how a sandbox was made: " + err.Error()}
	}
	return nil
}

func (h *Host) serveE2E(ctx context.Context, conn net.Conn, sandboxID string) error {
	space := h.ownerOf(sandboxID)
	if space == "" {
		return &proto.Error{Code: proto.ErrNotFound, Message: fmt.Sprintf("no sandbox %s on this host", sandboxID)}
	}
	if h.e2e == nil {
		return &proto.Error{Code: proto.ErrUnsupported, Message: "this host has no E2E store"}
	}
	chain := h.e2e.Space(space)
	if chain == nil || chain.State() == nil {
		return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("this host hasn't joined %s's E2E chain", space)}
	}
	id, err := h.e2e.Identity()
	if err != nil {
		return err
	}
	opts := e2e.ServeOptions{
		Static:     id.Static,
		HostID:     h.cfg.HostID,
		Chain:      chain,
		Revalidate: h.e2eRevalidate,
		Authorize: func(_ e2e.Device, hello e2e.Hello) string {
			if hello.Sandbox != sandboxID {
				return "This session was relayed for another sandbox"
			}
			if h.ownerOf(hello.Sandbox) != space {
				return "No such sandbox in this space"
			}
			if !h.bornIn(hello.Sandbox, space) {
				return notBorn
			}
			return ""
		},
		RPC: func(ctx context.Context, d e2e.Device, sandbox, method string, params json.RawMessage, emit func(any)) (any, error) {
			if !slices.Contains(sessionMethods, method) && method != MethodHistory {
				return nil, &e2e.Error{Code: proto.ErrUnsupported, Message: "not in an E2E session: " + method}
			}
			// Like a gateway call, a device's holds its sandbox until it ends (e2eGate), and finds it still in the session's
			// space: a delete cancels it, and an ID made again elsewhere isn't this session's.
			ctx, leave, ok := h.gate.use(ctx, []string{"sandbox:" + sandbox}, true)
			if !ok {
				return nil, &e2e.Error{Code: proto.ErrConflict, Message: "This sandbox is being made or deleted"}
			}
			defer leave()
			if h.ownerOf(sandbox) != space {
				return nil, &e2e.Error{Code: proto.ErrNotFound, Message: "No such sandbox in this space"}
			}
			if !h.bornIn(sandbox, space) {
				return nil, &e2e.Error{Code: proto.ErrUnsupported, Message: notBorn}
			}
			var p map[string]any
			if len(params) > 0 && string(params) != "null" {
				if err := json.Unmarshal(params, &p); err != nil {
					return nil, &e2e.Error{Code: proto.ErrInvalid, Message: "bad params"}
				}
			}
			if p == nil {
				p = map[string]any{}
			}
			// The session's sandbox, whatever the params say: every spelling Go's case-insensitive decoding would take
			// for sandboxId goes, or {"sandboxid": "another"} would win over the one set here.
			for key := range p {
				if strings.EqualFold(key, "sandboxId") {
					delete(p, key)
				}
			}
			p["sandboxId"] = sandbox
			if method == MethodHistory {
				if h.commands == nil {
					return HistoryPage{Items: []HistoryEntry{}}, nil
				}
				before, _ := p["before"].(string)
				limit, _ := p["limit"].(float64)
				// Output comes unless the device says it wants none.
				output, said := p["output"].(bool)
				return h.commands.page(sandbox, before, int(limit), output || !said), nil
			}
			raw, _ := json.Marshal(p)
			call := func(params []byte, onEvent func(proto.Event)) (any, error) {
				return h.Call(ctx, method, params, onEvent)
			}
			var result any
			var err error
			if method == proto.MethodExec && h.commands != nil {
				// Kept on the host, which is the only place that sees it (history.go).
				by := HistoryEntry{Device: d.ID, DeviceLabel: d.Label, DeviceClass: d.Class, Member: d.User}
				result, err = h.commands.runLogged(sandbox, by, raw, h.streamEncoding(sandbox), call, func(e proto.Event) { emit(e) })
			} else {
				result, err = call(raw, func(e proto.Event) { emit(e) })
			}
			if err != nil {
				pe := toError(err)
				return nil, &e2e.Error{Code: pe.Code, Message: pe.Message}
			}
			return result, nil
		},
		Port: func(ctx context.Context, _ e2e.Device, sandbox string, port int) (net.Conn, error) {
			// Held until it connects, as a gateway port is; a delete cancels the dial.
			ctx, leave, ok := h.gate.use(ctx, []string{"sandbox:" + sandbox}, true)
			if !ok {
				return nil, &e2e.Error{Code: proto.ErrConflict, Message: "This sandbox is being made or deleted"}
			}
			defer leave()
			if h.ownerOf(sandbox) != space {
				return nil, &e2e.Error{Code: proto.ErrNotFound, Message: "No such sandbox in this space"}
			}
			if !h.bornIn(sandbox, space) {
				return nil, &e2e.Error{Code: proto.ErrUnsupported, Message: notBorn}
			}
			return h.DialPort(ctx, sandbox, port)
		},
		OnOpen: func(d e2e.Device, hello e2e.Hello) {
			h.log.Info("e2e session", "space", space, "sandbox", hello.Sandbox, "op", hello.Op, "port", hello.Port, "device", d.ID, "user", d.User, "class", d.Class, "label", d.Label)
		},
	}
	go func() {
		if err := e2e.Serve(ctx, conn, opts); err != nil {
			h.log.Debug("e2e session ended", "sandbox", sandboxID, "reason", err)
		}
	}()
	return nil
}
