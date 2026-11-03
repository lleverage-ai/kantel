package protect

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Extensions is what the server agreed to in its Sec-WebSocket-Extensions answer.
type Extensions struct {
	// Deflate is permessage-deflate (RFC 7692).
	Deflate bool
	// ClientNoContextTakeover: the client resets its compressor between messages; ServerNoContextTakeover: the
	// server does.
	ClientNoContextTakeover, ServerNoContextTakeover bool
}

// ParseExtensions reads the server's Sec-WebSocket-Extensions answer. Window-bits parameters are ignored: they only
// shrink the sender's window, and the inflater handles any up to 15.
func ParseExtensions(h http.Header) Extensions {
	var e Extensions
	for _, v := range h.Values("Sec-WebSocket-Extensions") {
		for _, ext := range strings.Split(v, ",") {
			params := strings.Split(ext, ";")
			if !strings.EqualFold(strings.TrimSpace(params[0]), "permessage-deflate") || e.Deflate {
				continue
			}
			e.Deflate = true
			for _, p := range params[1:] {
				name, _, _ := strings.Cut(p, "=")
				switch strings.ToLower(strings.TrimSpace(name)) {
				case "client_no_context_takeover":
					e.ClientNoContextTakeover = true
				case "server_no_context_takeover":
					e.ServerNoContextTakeover = true
				}
			}
		}
	}
	return e
}

// closeGrace is how long Relay waits, once one direction has ended, for the other to finish the closing handshake.
const closeGrace = 5 * time.Second

// Relay carries a WebSocket connection after its handshake (the 101 has been passed on): client is the sandbox's
// side, server the destination's. Any bytes already buffered from either side must be readable from client or server.
//
// Each message is held whole (up to 16 MiB; a larger one is closed with 1009), since a placeholder can be split
// across fragments and compressed. From the client, placeholders are swapped for their values through p; an unbound
// placeholder, or values that can't be fetched, closes the client with 1008, closes the server, and Relay answers the
// *Refusal. From the server, entries' values are scrubbed back to placeholders. Every message is forwarded as one
// unfragmented, uncompressed frame (RFC 7692 lets an endpoint send any message uncompressed), keeping its opcode;
// control frames pass through at once, between fragments too.
//
// Relay returns when either side closes (after giving the other up to closeGrace to finish the closing handshake),
// or ctx ends; it answers the first Refusal if there was one. It closes the server after a refusal or a broken frame,
// and both sides if they don't finish in time, when they are io.Closers; otherwise closing them is the caller's.
func Relay(ctx context.Context, client, server io.ReadWriter, ext Extensions, sandboxID string, dest Destination, p Provider, entries []Entry) error {
	r := &relay{
		ctx:       ctx,
		client:    client,
		server:    server,
		ext:       ext,
		sandboxID: sandboxID,
		dest:      dest,
		p:         p,
		scrub:     newScrubber(entries),
		toClient:  &wsWriter{w: client},
		toServer:  &wsWriter{w: server, mask: true},
	}
	errc := make(chan error, 2)
	go func() { errc <- r.up() }()
	go func() { errc <- r.down() }()
	var first error
	select {
	case first = <-errc:
		timer := time.NewTimer(closeGrace)
		select {
		case <-errc:
		case <-timer.C:
			r.closeAll()
		case <-ctx.Done():
			r.closeAll()
		}
		timer.Stop()
	case <-ctx.Done():
		r.closeAll()
		first = ctx.Err()
	}
	if ref := r.firstRefusal(); ref != nil {
		return ref
	}
	if closedErr(first) {
		return nil
	}
	return first
}

type relay struct {
	ctx       context.Context
	client    io.ReadWriter
	server    io.ReadWriter
	ext       Extensions
	sandboxID string
	dest      Destination
	p         Provider
	scrub     *scrubber
	toClient  *wsWriter
	toServer  *wsWriter

	mu         sync.Mutex
	refusal    *Refusal
	serverOnce sync.Once
	clientOnce sync.Once
}

// up carries the client's messages to the server, swapping placeholders.
func (r *relay) up() error {
	m := &messageReader{in: bufio.NewReader(r.client), masked: true, deflate: r.ext.Deflate, inflater: inflater{takeover: !r.ext.ClientNoContextTakeover}}
	for {
		op, payload, err := m.next()
		if err != nil {
			return r.clientFailed(err)
		}
		if op >= opClose {
			if err := r.toServer.write(op, payload); err != nil {
				return err
			}
			if op == opClose {
				return nil
			}
			continue
		}
		out, ref := r.swap(payload)
		if ref != nil {
			r.refuse(ref, closePolicy)
			return ref
		}
		if err := r.toServer.write(op, out); err != nil {
			return err
		}
	}
}

// down carries the server's messages to the client, scrubbing values.
func (r *relay) down() error {
	m := &messageReader{in: bufio.NewReader(r.server), masked: false, deflate: r.ext.Deflate, inflater: inflater{takeover: !r.ext.ServerNoContextTakeover}}
	for {
		op, payload, err := m.next()
		if err != nil {
			return r.serverFailed(err)
		}
		if op >= opClose {
			if err := r.toClient.write(op, r.scrubControl(op, payload)); err != nil {
				return err
			}
			if op == opClose {
				return nil
			}
			continue
		}
		out, _ := r.scrub.replace(payload)
		if err := r.toClient.write(op, out); err != nil {
			return err
		}
	}
}

// swap resolves every placeholder in a client's message before any is swapped, so a refused message sends nothing.
func (r *relay) swap(msg []byte) ([]byte, *Refusal) {
	matches := Find(msg)
	if len(matches) == 0 {
		return msg, nil
	}
	s := newSwapper(r.ctx, r.p, r.sandboxID, r.dest)
	for _, m := range matches {
		if ref := s.resolve(string(msg[m[0]:m[1]])); ref != nil {
			return nil, ref
		}
	}
	out, _ := s.apply(msg, matches, nil)
	return out, nil
}

// scrubControl scrubs a control frame from the server; one that would outgrow a control frame loses its payload
// (a close frame keeps its code).
func (r *relay) scrubControl(op byte, payload []byte) []byte {
	out, changed := r.scrub.replace(payload)
	if !changed || len(out) <= 125 {
		return out
	}
	if op == opClose && len(payload) >= 2 {
		return payload[:2]
	}
	return nil
}

func (r *relay) clientFailed(err error) error {
	switch {
	case errors.Is(err, errTooBig):
		ref := &Refusal{Code: CodeTooLarge, Message: "a WebSocket message was larger than 16 MiB"}
		r.refuse(ref, closeTooBig)
		return ref
	case errors.Is(err, errProtocol):
		r.fail(r.toClient, r.toServer, closeProtocolError, closeGoingAway, "kantel: protocol error")
	case errors.Is(err, errBadData):
		r.fail(r.toClient, r.toServer, closeInvalidData, closeGoingAway, "kantel: message can't be inflated")
	case closedErr(err):
		// The client went without closing: tell the server, and end its direction.
		_ = r.toServer.write(opClose, closePayload(closeGoingAway, ""))
		r.closeServer()
	}
	return err
}

func (r *relay) serverFailed(err error) error {
	switch {
	case errors.Is(err, errTooBig):
		r.fail(r.toServer, r.toClient, closeTooBig, closeInternal, "")
	case errors.Is(err, errProtocol):
		r.fail(r.toServer, r.toClient, closeProtocolError, closeInternal, "")
	case errors.Is(err, errBadData):
		r.fail(r.toServer, r.toClient, closeInvalidData, closeInternal, "")
	case closedErr(err):
		// The server went without closing (or was closed after a refusal, when the client has its answer already).
		_ = r.toClient.write(opClose, closePayload(closeGoingAway, ""))
	}
	return err
}

// refuse ends the connection for a refused client message: the client hears why (only the variable's name, never a
// value), the server that the proxy is going away.
func (r *relay) refuse(ref *Refusal, code int) {
	r.mu.Lock()
	if r.refusal == nil {
		r.refusal = ref
	}
	r.mu.Unlock()
	r.fail(r.toClient, r.toServer, code, closeGoingAway, "kantel: "+ref.Message)
}

// fail closes both sides: offender hears code and reason, other otherCode; then the server's connection is closed,
// which ends the server's direction. The client's direction ends when the client answers the close.
func (r *relay) fail(offender, other *wsWriter, code, otherCode int, reason string) {
	_ = offender.write(opClose, closePayload(code, reason))
	_ = other.write(opClose, closePayload(otherCode, ""))
	r.closeServer()
}

func (r *relay) firstRefusal() *Refusal {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.refusal
}

func (r *relay) closeServer() {
	r.serverOnce.Do(func() {
		if c, ok := r.server.(io.Closer); ok {
			c.Close()
		}
	})
}

func (r *relay) closeAll() {
	r.closeServer()
	r.clientOnce.Do(func() {
		if c, ok := r.client.(io.Closer); ok {
			c.Close()
		}
	})
}

// closedErr is a connection that ended rather than one that failed.
func closedErr(err error) bool {
	return err == nil || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) || errors.Is(err, io.ErrClosedPipe)
}

// wsWriter writes whole frames to one side; both directions write to each side (a close after a refusal), so
// writes are serialised, and nothing follows a close frame.
type wsWriter struct {
	mu     sync.Mutex
	w      io.Writer
	mask   bool
	closed bool
}

func (w *wsWriter) write(op byte, payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	if op == opClose {
		w.closed = true
	}
	return writeFrame(w.w, op, payload, w.mask)
}
