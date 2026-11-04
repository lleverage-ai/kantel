package e2e

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// A session's wire format is packages/e2e/src/session.ts's (its comment has it); Serve is the host's side, and replays
// packages/e2e/vectors/session.json byte for byte.

const SessionVersion = 1

// MaxControlMessage is the largest control or RPC message.
const MaxControlMessage = 64 << 20

// Prologue binds a session to its space and host.
func Prologue(space, hostID string) []byte { return []byte("kantel-e2e/1\n" + space + "\n" + hostID) }

// Hello is what a device asks for in the first handshake message.
type Hello struct {
	V       int    `json:"v"`
	Sandbox string `json:"sandbox"`
	Op      string `json:"op"`
	Port    int    `json:"port,omitempty"`
}

// Chain is the host's verified chain of one space, and how it takes newer entries (verifying and keeping them).
type Chain interface {
	State() *State
	Extend(from int, entries []Entry) (*State, error)
}

// Error is an RPC error with a code the device shows.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

type ServeOptions struct {
	Static *ecdh.PrivateKey
	HostID string
	Chain  Chain
	// Authorize gives a reason to refuse the device's hello, or "" (such as: no such sandbox in this space).
	Authorize func(d Device, h Hello) string
	// RPC runs one call. Emit sends an event for it before the result.
	RPC func(ctx context.Context, d Device, sandbox, method string, params json.RawMessage, emit func(any)) (any, error)
	// Port connects to a sandbox port.
	Port func(ctx context.Context, d Device, sandbox string, port int) (net.Conn, error)
	// Ephemeral is for test vectors only.
	Ephemeral *ecdh.PrivateKey
	// OnOpen hears of each session that opens, for the host's log.
	OnOpen func(d Device, h Hello)
	// Revalidate is how often an open session looks at the chain again (default every 3s).
	Revalidate time.Duration
}

func readRecord(r io.Reader) ([]byte, error) {
	var n [2]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return nil, err
	}
	b := make([]byte, binary.BigEndian.Uint16(n[:]))
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	return b, nil
}

func frame2(b []byte) []byte {
	out := make([]byte, 2+len(b))
	binary.BigEndian.PutUint16(out, uint16(len(b)))
	copy(out[2:], b)
	return out
}

func parseHello(b []byte) (Hello, error) {
	o, err := fields(b, "hello", []string{"v", "sandbox", "op"}, "port")
	if err != nil {
		return Hello{}, err
	}
	var v float64
	if json.Unmarshal(o["v"], &v) != nil || v != SessionVersion {
		return Hello{}, errors.New("not a hello this host reads")
	}
	h := Hello{V: SessionVersion}
	if h.Sandbox, err = str(o["sandbox"], "sandbox"); err != nil {
		return Hello{}, err
	}
	if h.Op, err = oneOf(o["op"], []string{"rpc", "port"}, "op"); err != nil {
		return Hello{}, err
	}
	if h.Op == "port" {
		p, err := integer(o["port"], "port")
		if err != nil || p < 1 || p > 65535 {
			return Hello{}, errors.New("a port session names its port")
		}
		h.Port = int(p)
	}
	return h, nil
}

// secure is the plaintext stream over a finished handshake.
type secure struct {
	conn    io.ReadWriteCloser
	t       *Transport
	writeMu sync.Mutex
	buf     []byte
}

func (s *secure) Write(p []byte) (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for at := 0; at < len(p) || (at == 0 && len(p) == 0); at += NoiseMaxPlaintext {
		end := min(at+NoiseMaxPlaintext, len(p))
		sealed, err := s.t.Send.Encrypt(nil, p[at:end])
		if err != nil {
			return at, err
		}
		if _, err := s.conn.Write(frame2(sealed)); err != nil {
			return at, err
		}
		if len(p) == 0 {
			break
		}
	}
	return len(p), nil
}

// Read gives the plaintext of the next records; a record that doesn't decrypt ends the stream.
func (s *secure) Read(p []byte) (int, error) {
	for len(s.buf) == 0 {
		rec, err := readRecord(s.conn)
		if err != nil {
			return 0, err
		}
		plain, err := s.t.Receive.Decrypt(nil, rec)
		if err != nil {
			return 0, err
		}
		s.buf = plain
	}
	n := copy(p, s.buf)
	s.buf = s.buf[n:]
	return n, nil
}

func (s *secure) send(m any) error {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(m); err != nil {
		return err
	}
	body := bytes.TrimSuffix(b.Bytes(), []byte("\n"))
	out := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(out, uint32(len(body)))
	copy(out[4:], body)
	_, err := s.Write(out)
	return err
}

func (s *secure) next() (json.RawMessage, error) {
	var n [4]byte
	if _, err := io.ReadFull(s, n[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(n[:])
	if size > MaxControlMessage {
		return nil, errors.New("a control message was too long")
	}
	b := make([]byte, size)
	if _, err := io.ReadFull(s, b); err != nil {
		return nil, err
	}
	if !json.Valid(b) {
		return nil, errors.New("a control message wasn't JSON")
	}
	return b, nil
}

type refused struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

type ready struct {
	Type string `json:"type"`
}

type rpcReply struct {
	ID     json.RawMessage `json:"id"`
	Result any             `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
	Event  any             `json:"event,omitempty"`
}

// Serve runs one session on conn (the relay's stream) until it ends, and gives why. It closes conn.
func Serve(ctx context.Context, conn io.ReadWriteCloser, o ServeOptions) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer conn.Close()
	go func() {
		<-ctx.Done()
		conn.Close()
	}()
	state := o.Chain.State()
	if state == nil {
		return errors.New("this host's chain for the space doesn't verify: no sessions")
	}
	first, err := readRecord(conn)
	if err != nil {
		return err
	}
	r := &Responder{Prologue: Prologue(state.Space, o.HostID), Static: o.Static, Ephemeral: o.Ephemeral}
	rs, hp, err := r.ReadMessage1(first)
	if err != nil {
		return fmt.Errorf("the handshake failed: %w", err)
	}
	hello, err := parseHello(hp)
	if err != nil {
		return err
	}
	head, _ := json.Marshal(struct {
		V    int `json:"v"`
		Head struct {
			Seq  int    `json:"seq"`
			Hash string `json:"hash"`
		} `json:"head"`
	}{V: SessionVersion, Head: struct {
		Seq  int    `json:"seq"`
		Hash string `json:"hash"`
	}{state.Seq, state.Head}})
	m2, t, err := r.WriteMessage2(head)
	if err != nil {
		return err
	}
	if _, err := conn.Write(frame2(m2)); err != nil {
		return err
	}
	s := &secure{conn: conn, t: t}
	device, why := open(s, o, rs, hello)
	if why != "" {
		_ = s.send(refused{"refused", why})
		return errors.New(why)
	}
	if o.OnOpen != nil {
		o.OnOpen(device, hello)
	}
	// The session lasts only while the chain lets the device in: it is looked at again every few seconds, so a removal
	// (or strict mode) that reaches the host from another session or a join ends this one, calls in flight included.
	var revoked atomic.Pointer[string]
	go func() {
		every := o.Revalidate
		if every <= 0 {
			every = 3 * time.Second
		}
		tick := time.NewTicker(every)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if why := stillAllowed(o, device); why != "" {
					revoked.Store(&why)
					cancel()
					return
				}
			}
		}
	}()
	ended := func(err error) error {
		if why := revoked.Load(); why != nil {
			return errors.New(*why)
		}
		return err
	}
	if hello.Op == "port" {
		if o.Port == nil {
			_ = s.send(refused{"refused", "This host has no ports"})
			return errors.New("no ports")
		}
		target, err := o.Port(ctx, device, hello.Sandbox, hello.Port)
		if err != nil {
			_ = s.send(refused{"refused", err.Error()})
			return err
		}
		defer target.Close()
		if err := s.send(ready{"ready"}); err != nil {
			return err
		}
		done := make(chan error, 2)
		go func() {
			_, err := io.Copy(target, s)
			if c, ok := target.(interface{ CloseWrite() error }); ok {
				_ = c.CloseWrite()
			}
			done <- err
		}()
		go func() {
			buf := make([]byte, 32*1024)
			for {
				n, err := target.Read(buf)
				if n > 0 {
					if _, werr := s.Write(buf[:n]); werr != nil {
						done <- werr
						return
					}
				}
				if err != nil {
					done <- err
					return
				}
			}
		}()
		select {
		case err := <-done:
			return ended(err)
		case <-ctx.Done():
			return ended(ctx.Err())
		}
	}
	if err := s.send(ready{"ready"}); err != nil {
		return err
	}
	var calls sync.WaitGroup
	// Cancel the calls and unblock their I/O before waiting for them, or a call would hold the session open.
	defer func() {
		cancel()
		conn.Close()
		calls.Wait()
	}()
	for {
		raw, err := s.next()
		if err != nil {
			return ended(err)
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(raw, &req) != nil || len(req.ID) == 0 || req.Method == "" {
			continue
		}
		var n float64
		if json.Unmarshal(req.ID, &n) != nil {
			continue
		}
		// Each call is let in by the chain as it is now: a device removed since the session opened is refused, and its
		// session ended.
		if why := stillAllowed(o, device); why != "" {
			_ = s.send(rpcReply{ID: req.ID, Error: &Error{"forbidden", why}})
			return errors.New(why)
		}
		calls.Add(1)
		go func() {
			defer calls.Done()
			reply := rpcReply{ID: req.ID}
			if o.RPC == nil {
				reply.Error = &Error{"unsupported", "No calls here"}
			} else {
				result, err := o.RPC(ctx, device, hello.Sandbox, req.Method, req.Params, func(e any) {
					_ = s.send(rpcReply{ID: req.ID, Event: e})
				})
				if err != nil {
					var e *Error
					if errors.As(err, &e) {
						reply.Error = e
					} else {
						reply.Error = &Error{"internal", err.Error()}
					}
				} else {
					if result == nil {
						result = struct{}{}
					}
					reply.Result = result
				}
			}
			if s.send(reply) != nil {
				cancel()
			}
		}()
	}
}

// stillAllowed says why device may no longer use its session under the chain as it is now, or "".
func stillAllowed(o ServeOptions, device Device) string {
	state := o.Chain.State()
	if state == nil {
		return "This host's chain for the space doesn't verify"
	}
	d, ok := state.Devices[device.ID]
	if !ok || d.DH != device.DH {
		return "This device isn't in the space's chain"
	}
	return state.Allowed(device.ID)
}

// open reads the device's `open`, takes the entries it brings, and finds the device.
func open(s *secure, o ServeOptions, remoteStatic []byte, hello Hello) (Device, string) {
	raw, err := s.next()
	if err != nil {
		return Device{}, "The device didn't open the session"
	}
	m, err := fields(raw, "open", []string{"type"}, "chain")
	if err != nil {
		return Device{}, "The device didn't open the session"
	}
	if typ, _ := str(m["type"], "type"); typ != "open" {
		return Device{}, "The device didn't open the session"
	}
	state := o.Chain.State()
	if c, ok := m["chain"]; ok {
		var chain struct {
			From    *int    `json:"from"`
			Entries []Entry `json:"entries"`
		}
		if json.Unmarshal(c, &chain) != nil || chain.From == nil {
			return Device{}, "A bad chain"
		}
		if state, err = o.Chain.Extend(*chain.From, chain.Entries); err != nil {
			return Device{}, err.Error()
		}
	}
	if state == nil {
		return Device{}, "This host's chain for the space doesn't verify"
	}
	d, ok := state.DeviceByDH(B64(remoteStatic))
	if !ok {
		return Device{}, "This device isn't in the space's chain"
	}
	if why := state.Allowed(d.ID); why != "" {
		return Device{}, why
	}
	if o.Authorize != nil {
		if why := o.Authorize(d, hello); why != "" {
			return Device{}, why
		}
	}
	return d, ""
}
