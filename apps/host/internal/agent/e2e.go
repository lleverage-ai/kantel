package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"slices"
	"strings"
	"sync"

	"github.com/lleverage-ai/kantel/apps/host/internal/e2e"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// End-to-end encryption on the host (package e2e). A sandbox's space is its owner. When the host holds that space's
// chain with E2E on, the gateway's own calls can still run the sandbox's lifecycle (create, stop, resume, fork,
// delete, snapshots) but not reach its content: commands, files, snapshot contents and ports are served only inside
// E2E sessions from the chain's devices, which the gateway relays as a port.open of port 0 and can't read.

// contentMethods are the calls that read or change what is in a sandbox.
var contentMethods = []string{
	proto.MethodExec, proto.MethodFileRead, proto.MethodFileWrite, proto.MethodFileDelete, proto.MethodFileList,
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
		SandboxID         string            `json:"sandboxId"`
		NewID             string            `json:"newId"`
		SnapshotID        string            `json:"snapshotId"`
		Port              int               `json:"port"`
		From              string            `json:"from"`
		Owner             string            `json:"owner"`
		Tier              string            `json:"tier"`
		Env               map[string]string `json:"env"`
		SSHAuthorizedKeys []string          `json:"sshAuthorizedKeys"`
		Egress            *proto.Egress     `json:"egress"`
	}
	_ = json.Unmarshal(params, &p)
	if method == proto.MethodHostUpdate && h.anyE2E() {
		// A binary the gateway picks could read every session: with E2E on, the host is updated on the machine.
		return &proto.Error{Code: proto.ErrUnsupported, Message: "this host holds E2E spaces: it is updated on the machine, not by the gateway"}
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
	space := ""
	switch {
	case slices.Contains(contentMethods, method):
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
		// The gateway gives an E2E space's sandbox no environment or SSH keys of its own, made fresh or from a snapshot: an
		// exported function such as BASH_FUNC_cat%% (or LD_PRELOAD, BASH_ENV) would run in every command a device runs.
		if h.e2eMode(p.Owner) != e2e.ModeOff && (len(p.Env) > 0 || len(p.SSHAuthorizedKeys) > 0) {
			return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: its sandboxes take no environment variables or SSH keys from the gateway", p.Owner)}
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
			if s, covered := h.snapshotGuarded(t, p.From); covered {
				if !known || owner != p.Owner {
					return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("a sandbox made from a snapshot in %s, which is end-to-end encrypted, must be in that space", s)}
				}
				if len(p.Env) > 0 || len(p.SSHAuthorizedKeys) > 0 {
					return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: a sandbox made from its snapshot takes no environment variables or SSH keys from the gateway", s)}
				}
			}
		}
		return h.recordE2E(p.SandboxID, p.Owner)
	case method == proto.MethodFork:
		owner := h.ownerOf(p.SandboxID)
		if h.e2eMode(owner) != e2e.ModeOff {
			if len(p.Env) > 0 {
				return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: a fork takes no environment variables from the gateway", owner)}
			}
			if was, ok := h.recordedOwner(p.NewID); ok && was != owner {
				return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox ID %s was used in %s", p.NewID, was)}
			}
			return h.recordE2E(p.NewID, owner)
		}
		if was, ok := h.recordedOwner(p.NewID); ok && was != owner {
			return &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("sandbox ID %s was used in %s, which is end-to-end encrypted", p.NewID, was)}
		}
		return nil
	default:
		return nil
	}
	if h.e2eMode(space) != e2e.ModeOff {
		return e2eRefusal(space)
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

// e2eGate keeps a gateway call's E2E check bound to the sandbox (or snapshot) it goes on to reach. The check is made
// before the call resolves its ID again, so without it a sandbox deleted and made again in an E2E space between the two
// would be reached. A gateway content call is in the gate from before its check until it is done; making an ID E2E's
// (a create or fork into an E2E space, a snapshot of an E2E sandbox) first cancels and waits for the calls in the
// gate for that ID, and keeps new ones out until it is done, after which their check sees the E2E owner.
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

// enter puts a gateway call on key in the gate; false while key is being made E2E's.
func (g *e2eGate) enter(ctx context.Context, key string) (context.Context, func(), bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.init()
	if g.claimed[key] > 0 {
		return ctx, func() {}, false
	}
	ctx, cancel := context.WithCancel(ctx)
	g.next++
	n := g.next
	if g.calls[key] == nil {
		g.calls[key] = map[int]context.CancelFunc{}
	}
	g.calls[key][n] = cancel
	return ctx, func() {
		g.mu.Lock()
		delete(g.calls[key], n)
		if len(g.calls[key]) == 0 {
			delete(g.calls, key)
		}
		g.cond.Broadcast()
		g.mu.Unlock()
		cancel()
	}, true
}

// claim cancels the gateway calls on key and waits for them to end, keeping new ones out until release.
func (g *e2eGate) claim(key string) (release func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.init()
	g.claimed[key]++
	for _, cancel := range g.calls[key] {
		cancel()
	}
	for len(g.calls[key]) > 0 {
		g.cond.Wait()
	}
	return func() {
		g.mu.Lock()
		g.claimed[key]--
		if g.claimed[key] == 0 {
			delete(g.claimed, key)
		}
		g.mu.Unlock()
	}
}

// gatewayGuard is gatewayMayCall with the call bound to what it checked (e2eGate): ctx is the call's context, and done
// is called when the call has ended.
func (h *Host) gatewayGuard(ctx context.Context, method string, params json.RawMessage) (context.Context, func(), error) {
	var p struct {
		SandboxID  string `json:"sandboxId"`
		NewID      string `json:"newId"`
		SnapshotID string `json:"snapshotId"`
		Port       int    `json:"port"`
		Owner      string `json:"owner"`
	}
	_ = json.Unmarshal(params, &p)
	var claims []string
	var key string
	switch {
	case slices.Contains(contentMethods, method) || (method == proto.MethodPortOpen && p.Port != proto.PortE2E):
		key = "sandbox:" + p.SandboxID
	case method == proto.MethodSnapshotRead || method == proto.MethodSnapshotTree:
		key = "snapshot:" + p.SnapshotID
	case method == proto.MethodCreate:
		if h.e2eMode(p.Owner) != e2e.ModeOff {
			claims = append(claims, "sandbox:"+p.SandboxID)
		}
	case method == proto.MethodFork || method == proto.MethodStop || method == proto.MethodSnapshotSave:
		if h.e2eMode(h.ownerOf(p.SandboxID)) != e2e.ModeOff {
			if p.NewID != "" {
				claims = append(claims, "sandbox:"+p.NewID)
			}
			if p.SnapshotID != "" {
				claims = append(claims, "snapshot:"+p.SnapshotID)
			}
		}
	}
	done := func() {}
	if key != "" {
		var ok bool
		var leave func()
		if ctx, leave, ok = h.gate.enter(ctx, key); !ok {
			return ctx, done, &proto.Error{Code: proto.ErrConflict, Message: "that sandbox is being made in an end-to-end encrypted space"}
		}
		done = leave
	}
	slices.Sort(claims)
	var releases []func()
	for _, c := range claims {
		releases = append(releases, h.gate.claim(c))
	}
	if len(releases) > 0 {
		done = func() {
			for _, r := range releases {
				r()
			}
		}
	}
	if err := h.gatewayMayCall(method, params); err != nil {
		done()
		return ctx, func() {}, err
	}
	return ctx, done, nil
}

// serveE2E runs one E2E session on conn, for a session the control plane relays to sandboxID.
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
		Static: id.Static,
		HostID: h.cfg.HostID,
		Chain:  chain,
		Authorize: func(_ e2e.Device, hello e2e.Hello) string {
			if hello.Sandbox != sandboxID {
				return "This session was relayed for another sandbox"
			}
			if h.ownerOf(hello.Sandbox) != space {
				return "No such sandbox in this space"
			}
			return ""
		},
		RPC: func(ctx context.Context, d e2e.Device, sandbox, method string, params json.RawMessage, emit func(any)) (any, error) {
			if !slices.Contains(sessionMethods, method) {
				return nil, &e2e.Error{Code: proto.ErrUnsupported, Message: "not in an E2E session: " + method}
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
			raw, _ := json.Marshal(p)
			result, err := h.Call(ctx, method, raw, func(e proto.Event) { emit(e) })
			if err != nil {
				pe := toError(err)
				return nil, &e2e.Error{Code: pe.Code, Message: pe.Message}
			}
			return result, nil
		},
		Port: func(ctx context.Context, _ e2e.Device, sandbox string, port int) (net.Conn, error) {
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
