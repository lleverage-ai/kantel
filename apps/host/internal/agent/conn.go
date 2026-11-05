package agent

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// ErrRevoked stops the daemon: the control plane refused the host's credential for good.
var ErrRevoked = errors.New("the control plane revoked this host's credential")

// revokedClose reports whether err is the control plane closing the connection because it refused the credential:
// 4003, or 4401 and 4403, the close codes the gateway gives for an upgrade it would once have refused with 401 or 403
// (Bun drops an HTTP status written to an upgrade, so the gateway completes the handshake and closes instead).
func revokedClose(err error) (websocket.CloseError, bool) {
	var ce websocket.CloseError
	if !errors.As(err, &ce) {
		return ce, false
	}
	return ce, ce.Code == 4003 || ce.Code == 4401 || ce.Code == 4403
}

// Updater moves the host to another version (download, check, swap the binary, restart).
type Updater func(ctx context.Context, p proto.UpdateParams) error

// session is one WebSocket connection to the control plane.
type session struct {
	host    *Host
	ws      *websocket.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	streams map[uint32]net.Conn
	cancel  context.CancelFunc
	// calls are the host's own calls to Kantel on this connection.
	calls *caller
}

func (s *session) send(ctx context.Context, m proto.Message) error {
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return s.ws.Write(wctx, websocket.MessageText, raw)
}

func (s *session) sendBinary(ctx context.Context, stream uint32, payload []byte) error {
	frame := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(frame, stream)
	copy(frame[4:], payload)
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return s.ws.Write(wctx, websocket.MessageBinary, frame)
}

// Run keeps the host connected to the control plane until ctx ends or the credential is revoked, reconnecting with
// backoff (1 s doubling to 30 s, with jitter).
func (h *Host) Run(ctx context.Context, update Updater) error {
	if h.cfg.ControlPlane == "" || h.cfg.Credential == "" {
		return errors.New("not registered: run `kantel-host join`")
	}
	// Usage samples go out on whichever connection is up, and wait (a bounded few) while none is.
	usageCtx, stopUsage := context.WithCancel(ctx)
	defer stopUsage()
	go h.RunUsage(usageCtx)
	backoff := time.Second
	for {
		started := time.Now()
		err := h.connectOnce(ctx, update)
		if errors.Is(err, ErrRevoked) || ctx.Err() != nil {
			return err
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		wait := backoff + time.Duration(rand.Int64N(int64(backoff/2)+1))
		h.log.Warn("disconnected from the control plane; reconnecting", "error", err, "in", wait.Round(100*time.Millisecond))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func connectURL(origin string) string {
	u := strings.TrimRight(origin, "/") + "/v1/hosts/connect"
	if strings.HasPrefix(u, "https://") {
		return "wss://" + strings.TrimPrefix(u, "https://")
	}
	return "ws://" + strings.TrimPrefix(u, "http://")
}

func (h *Host) connectOnce(parent context.Context, update Updater) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	dialCtx, dialCancel := context.WithTimeout(ctx, 30*time.Second)
	ws, res, err := websocket.Dial(dialCtx, connectURL(h.cfg.ControlPlane), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + h.cfg.Credential}, "Kantel-Host-Version": {h.version}},
	})
	dialCancel()
	if err != nil {
		if res != nil && (res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden) {
			return fmt.Errorf("%w (%d)", ErrRevoked, res.StatusCode)
		}
		return err
	}
	ws.SetReadLimit(64 << 20)
	s := &session{host: h, ws: ws, streams: map[uint32]net.Conn{}, cancel: cancel}
	s.calls = newCaller(s.send)
	defer func() {
		h.mu.Lock()
		h.events = nil
		if h.link == s.calls {
			h.link, h.usageAcks = nil, false
		}
		h.mu.Unlock()
		// Calls waiting on this connection fail now rather than at their timeout.
		s.calls.close()
		ws.Close(websocket.StatusGoingAway, "host stopping")
		s.mu.Lock()
		for _, c := range s.streams {
			c.Close()
		}
		s.mu.Unlock()
	}()
	hello := proto.Message{Type: "hello", Hello: &proto.Hello{HostID: h.cfg.HostID, Facts: h.Facts(), Sandboxes: h.List(), Capacity: h.Capacity()}}
	if err := s.send(ctx, hello); err != nil {
		return err
	}
	kind, raw, err := ws.Read(ctx)
	if err != nil {
		if ce, revoked := revokedClose(err); revoked {
			return fmt.Errorf("%w: %s", ErrRevoked, ce.Reason)
		}
		return err
	}
	var welcome proto.Message
	if kind != websocket.MessageText || json.Unmarshal(raw, &welcome) != nil || welcome.Type != "welcome" || welcome.Welcome == nil {
		return errors.New("the control plane didn't welcome the host")
	}
	h.log.Info("connected to the control plane", "url", h.cfg.ControlPlane, "host", welcome.Welcome.HostID)
	h.applyWelcome(ctx, welcome.Welcome, update)
	h.mu.Lock()
	h.events = func(e proto.Event) {
		e.At = time.Now().UnixMilli()
		_ = s.send(ctx, proto.Message{Type: "event", Event: &e})
	}
	h.link = s.calls
	// The first welcome decides it for the connection, as on Kantel's side (a rewelcome forwarded by an older gateway
	// replica may lack it).
	h.usageAcks = welcome.Welcome.UsageAcks
	h.mu.Unlock()
	// Mounts of sandboxes adopted at start can resolve their bucket sources now.
	go h.reconcileMounts(ctx)
	beat := welcome.Welcome.HeartbeatSeconds
	if beat <= 0 {
		beat = 15
	}
	go func() {
		ticker := time.NewTicker(time.Duration(beat) * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := s.send(ctx, proto.Message{Type: "heartbeat", Heartbeat: &proto.Heartbeat{Capacity: h.Capacity()}}); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	for {
		kind, raw, err := ws.Read(ctx)
		if err != nil {
			if ce, revoked := revokedClose(err); revoked {
				return fmt.Errorf("%w: %s", ErrRevoked, ce.Reason)
			}
			return err
		}
		if kind == websocket.MessageBinary {
			s.binary(raw)
			continue
		}
		var m proto.Message
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		s.text(ctx, m, update)
	}
}

// text handles a text message from Kantel.
func (s *session) text(ctx context.Context, m proto.Message, update Updater) {
	switch m.Type {
	case "call":
		go s.call(ctx, m, update)
	case "result":
		// The answer to one of the host's own calls (secrets.fetch).
		s.calls.deliver(m)
	case "welcome":
		if m.Welcome != nil {
			s.host.applyWelcome(ctx, m.Welcome, update)
		}
	case "usage.ack":
		// Kantel has taken the usage ticks up to this one: the backlog lets them go.
		s.host.usageAcked(uint64(max(m.Acked, 0)))
	case "stream.close":
		s.closeStream(m.Stream)
	case "stream.ack":
		// Kantel's reader of a file read stream has taken this much: its window moves on.
		s.mu.Lock()
		conn := s.streams[m.Stream]
		s.mu.Unlock()
		if fc, ok := conn.(*fileConn); ok {
			fc.ack(m.Acked)
		}
	}
}

func (h *Host) applyWelcome(ctx context.Context, w *proto.Welcome, update Updater) {
	// Before the binary's update, which returns early for an E2E host; followImages has the same rule.
	h.followImages(ctx, w.Images)
	if update != nil && h.cfg.autoUpdate() && w.DesiredVersion != "" && w.DesiredVersion != h.version && w.UpdateURL != "" {
		if h.e2e != nil && h.e2e.Enrolled() {
			h.log.Info("not updating from the gateway: this host has joined an E2E space, so it is updated on the machine", "to", w.DesiredVersion)
			return
		}
		h.log.Info("updating", "from", h.version, "to", w.DesiredVersion)
		go func() {
			if err := h.gatewayUpdate(ctx, proto.UpdateParams{Version: w.DesiredVersion, URL: w.UpdateURL}, update); err != nil {
				h.log.Error("update failed", "error", err)
			}
		}()
	}
}

func toError(err error) *proto.Error {
	var pe *proto.Error
	if errors.As(err, &pe) {
		return pe
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &proto.Error{Code: proto.ErrTimeout, Message: err.Error()}
	}
	return &proto.Error{Code: proto.ErrInternal, Message: err.Error()}
}

func (s *session) call(ctx context.Context, m proto.Message, update Updater) {
	reply := proto.Message{Type: "result", ID: m.ID}
	var result any
	var err error
	callCtx, done, err := s.host.gatewayGuard(ctx, m.Method, m.Params)
	if err != nil {
		reply.Error = toError(err)
		if err := s.send(ctx, reply); err != nil {
			s.host.log.Warn("couldn't answer a call", "method", m.Method, "error", err)
		}
		return
	}
	// start, when set, begins what follows the answer (a file stream's transfer), so nothing of it comes before it.
	var start func()
	switch m.Method {
	case proto.MethodPortOpen:
		// The stream outlives the call, so it runs on the session's context; the gate holds until it is connected.
		result, err = s.openPort(ctx, callCtx, m.Params)
		done()
	case proto.MethodFileOpen:
		// As a port's, the stream outlives the call: it runs on the session's context. The gate holds until its transfer
		// has ended, not only until it is set up: a write finds its sandbox only once it starts, so a claim on the
		// sandbox (its delete, or another made with its ID) ends the transfer and waits for it, and the bytes can never
		// reach a sandbox the gateway may not write to. openFile releases it (done) once the transfer is over.
		result, start, err = s.openFile(ctx, callCtx, m.Params, done)
		if err != nil {
			done()
		}
	case proto.MethodHostUpdate:
		var p proto.UpdateParams
		if err = json.Unmarshal(m.Params, &p); err == nil {
			if update == nil {
				err = &proto.Error{Code: proto.ErrUnsupported, Message: "this host doesn't update itself"}
			} else {
				err = s.host.gatewayUpdate(ctx, p, update)
			}
		}
		result = map[string]bool{"ok": err == nil}
		done()
	default:
		result, err = s.host.Call(callCtx, m.Method, m.Params, func(e proto.Event) {
			if callCtx.Err() != nil {
				return
			}
			e.At = time.Now().UnixMilli()
			_ = s.send(ctx, proto.Message{Type: "event", Call: m.ID, Event: &e})
		})
		// Ended (its space turned E2E on, or its sandbox is going): what it got after isn't sent.
		if callCtx.Err() != nil && ctx.Err() == nil {
			result, err = nil, &proto.Error{Code: proto.ErrConflict, Message: "this call was ended: its sandbox's space turned E2E on, or the sandbox is being replaced"}
		}
		done()
	}
	if err != nil {
		reply.Error = toError(err)
	} else {
		reply.Result, _ = json.Marshal(result)
	}
	if err := s.send(ctx, reply); err != nil {
		s.host.log.Warn("couldn't answer a call", "method", m.Method, "error", err)
	}
	if start != nil {
		start()
	}
}

// openPort connects a stream the control plane named to a port of a sandbox, or for port 0 to an E2E session with the
// host (e2e.go); binary frames carry it both ways.
func (s *session) openPort(ctx, dial context.Context, raw json.RawMessage) (any, error) {
	var p proto.PortParams
	if err := json.Unmarshal(raw, &p); err != nil || p.Stream == 0 || p.Port < 0 || p.Port > 65535 {
		return nil, invalid("bad port.open")
	}
	var conn net.Conn
	if p.Port == proto.PortE2E {
		var session net.Conn
		conn, session = net.Pipe()
		if err := s.host.serveE2E(ctx, session, p.SandboxID); err != nil {
			conn.Close()
			session.Close()
			return nil, err
		}
	} else {
		dialCtx, cancel := context.WithTimeout(dial, 15*time.Second)
		defer cancel()
		var err error
		if conn, err = s.host.DialPort(dialCtx, p.SandboxID, p.Port); err != nil {
			return nil, err
		}
	}
	s.mu.Lock()
	if old, ok := s.streams[p.Stream]; ok {
		old.Close()
	}
	s.streams[p.Stream] = conn
	s.mu.Unlock()
	// A plaintext port closes if its sandbox's space turns E2E on while it is open.
	forget := func() {}
	if p.Port != proto.PortE2E {
		forget = s.host.watchPlain(s.host.ownerOf(p.SandboxID), func() { conn.Close() })
	}
	go func() {
		defer forget()
		buf := make([]byte, 32*1024)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				if s.sendBinary(ctx, p.Stream, buf[:n]) != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		s.mu.Lock()
		current := s.streams[p.Stream] == conn
		if current {
			delete(s.streams, p.Stream)
		}
		s.mu.Unlock()
		conn.Close()
		if current {
			_ = s.send(ctx, proto.Message{Type: "stream.close", Stream: p.Stream, Reason: "closed by the sandbox"})
		}
	}()
	return map[string]bool{"ok": true}, nil
}

func (s *session) binary(frame []byte) {
	if len(frame) < 4 {
		return
	}
	id := binary.BigEndian.Uint32(frame)
	s.mu.Lock()
	conn := s.streams[id]
	s.mu.Unlock()
	if conn == nil {
		return
	}
	if len(frame) == 4 {
		if c, ok := conn.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
		return
	}
	if _, err := conn.Write(frame[4:]); err != nil {
		// A file write whose tier gave up on its input still owns its stream: its transfer reports how it went.
		var input *errFileInput
		if errors.As(err, &input) {
			return
		}
		s.closeStream(id)
	}
}

func (s *session) closeStream(id uint32) {
	s.mu.Lock()
	conn := s.streams[id]
	delete(s.streams, id)
	s.mu.Unlock()
	if conn != nil {
		conn.Close()
	}
}
