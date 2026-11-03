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
	defer func() {
		ws.Close(websocket.StatusGoingAway, "host stopping")
		s.mu.Lock()
		for _, c := range s.streams {
			c.Close()
		}
		s.mu.Unlock()
		h.mu.Lock()
		h.events = nil
		h.mu.Unlock()
	}()
	hello := proto.Message{Type: "hello", Hello: &proto.Hello{HostID: h.cfg.HostID, Facts: h.facts, Sandboxes: h.List(), Capacity: h.Capacity()}}
	if err := s.send(ctx, hello); err != nil {
		return err
	}
	kind, raw, err := ws.Read(ctx)
	if err != nil {
		var ce websocket.CloseError
		if errors.As(err, &ce) && ce.Code == 4003 {
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
	h.mu.Unlock()
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
			var ce websocket.CloseError
			if errors.As(err, &ce) && ce.Code == 4003 {
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
		switch m.Type {
		case "call":
			go s.call(ctx, m, update)
		case "welcome":
			if m.Welcome != nil {
				h.applyWelcome(ctx, m.Welcome, update)
			}
		case "stream.close":
			s.closeStream(m.Stream)
		}
	}
}

func (h *Host) applyWelcome(ctx context.Context, w *proto.Welcome, update Updater) {
	if w.Pools != nil {
		h.SetPools(w.Pools)
	}
	if update != nil && h.cfg.autoUpdate() && w.DesiredVersion != "" && w.DesiredVersion != h.version && w.UpdateURL != "" {
		h.log.Info("updating", "from", h.version, "to", w.DesiredVersion)
		go func() {
			if err := update(ctx, proto.UpdateParams{Version: w.DesiredVersion, URL: w.UpdateURL}); err != nil {
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
	switch m.Method {
	case proto.MethodPortOpen:
		result, err = s.openPort(ctx, m.Params)
	case proto.MethodHostUpdate:
		var p proto.UpdateParams
		if err = json.Unmarshal(m.Params, &p); err == nil {
			if update == nil {
				err = &proto.Error{Code: proto.ErrUnsupported, Message: "this host doesn't update itself"}
			} else {
				err = update(ctx, p)
			}
		}
		result = map[string]bool{"ok": err == nil}
	default:
		result, err = s.host.Call(ctx, m.Method, m.Params, func(e proto.Event) {
			e.At = time.Now().UnixMilli()
			_ = s.send(ctx, proto.Message{Type: "event", Call: m.ID, Event: &e})
		})
	}
	if err != nil {
		reply.Error = toError(err)
	} else {
		reply.Result, _ = json.Marshal(result)
	}
	if err := s.send(ctx, reply); err != nil {
		s.host.log.Warn("couldn't answer a call", "method", m.Method, "error", err)
	}
}

// openPort connects a stream the control plane named to a port of a sandbox; binary frames carry it both ways.
func (s *session) openPort(ctx context.Context, raw json.RawMessage) (any, error) {
	var p proto.PortParams
	if err := json.Unmarshal(raw, &p); err != nil || p.Stream == 0 || p.Port <= 0 || p.Port > 65535 {
		return nil, invalid("bad port.open")
	}
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, err := s.host.DialPort(dialCtx, p.SandboxID, p.Port)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if old, ok := s.streams[p.Stream]; ok {
		old.Close()
	}
	s.streams[p.Stream] = conn
	s.mu.Unlock()
	go func() {
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
