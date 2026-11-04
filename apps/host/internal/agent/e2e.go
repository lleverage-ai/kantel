package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"slices"

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

// snapshotOwner is the space of the sandbox a snapshot is of, when that sandbox is still on the host.
func (h *Host) snapshotOwner(snapshotID string) (string, bool) {
	for _, info := range h.List() {
		for _, name := range h.order {
			for _, snap := range h.tiers[name].Snapshots(info.ID) {
				if snap.ID == snapshotID {
					return info.Owner, true
				}
			}
		}
	}
	return "", false
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
func (h *Host) snapshotGuarded(snapshotID string) (space string, covered bool) {
	owner, known := h.snapshotOwner(snapshotID)
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

func e2eRefusal(space string) error {
	return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s is end-to-end encrypted: its sandboxes' content is reachable only in an E2E session (kantel e2e)", space)}
}

// gatewayMayCall refuses a call from the control plane that would reach the content of a sandbox in an E2E space.
func (h *Host) gatewayMayCall(method string, params json.RawMessage) error {
	var p struct {
		SandboxID  string `json:"sandboxId"`
		SnapshotID string `json:"snapshotId"`
		Port       int    `json:"port"`
		From       string `json:"from"`
		Owner      string `json:"owner"`
	}
	_ = json.Unmarshal(params, &p)
	space := ""
	switch {
	case slices.Contains(contentMethods, method):
		space = h.ownerOf(p.SandboxID)
	case method == proto.MethodPortOpen && p.Port != proto.PortE2E:
		space = h.ownerOf(p.SandboxID)
	case method == proto.MethodSnapshotRead || method == proto.MethodSnapshotTree:
		if s, covered := h.snapshotGuarded(p.SnapshotID); covered {
			return e2eRefusal(s)
		}
		return nil
	case method == proto.MethodCreate && p.From != "":
		// A sandbox made from an E2E sandbox's snapshot stays in that space, or its content would be plaintext.
		owner, known := h.snapshotOwner(p.From)
		if s, covered := h.snapshotGuarded(p.From); covered && (!known || owner != p.Owner) {
			return &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("a sandbox made from a snapshot in %s, which is end-to-end encrypted, must be in that space", s)}
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
			// The session's sandbox, whatever the params say.
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
