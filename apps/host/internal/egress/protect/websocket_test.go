package protect

import (
	"bufio"
	"bytes"
	"compress/flate"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

var wsDest = Destination{Host: "api.github.com", Port: 443, Method: "GET", Path: "/socket"}

// encodeFrame builds a frame by hand, fragments and RSV1 included; a client's frames are masked.
func encodeFrame(fin, rsv1 bool, op byte, payload []byte, mask bool) []byte {
	b0 := op
	if fin {
		b0 |= 0x80
	}
	if rsv1 {
		b0 |= 0x40
	}
	out := []byte{b0}
	var m byte
	if mask {
		m = 0x80
	}
	n := len(payload)
	switch {
	case n < 126:
		out = append(out, m|byte(n))
	case n <= 0xffff:
		out = append(out, m|126)
		out = binary.BigEndian.AppendUint16(out, uint16(n))
	default:
		out = append(out, m|127)
		out = binary.BigEndian.AppendUint64(out, uint64(n))
	}
	if !mask {
		return append(out, payload...)
	}
	key := [4]byte{0x12, 0x34, 0x56, 0x78}
	out = append(out, key[:]...)
	for i, c := range payload {
		out = append(out, c^key[i%4])
	}
	return out
}

// compressor compresses one side's messages as a browser does: one deflate stream across messages (context
// takeover), each sync-flushed and stripped of its 00 00 ff ff tail.
type compressor struct {
	buf bytes.Buffer
	w   *flate.Writer
}

func newCompressor(t *testing.T) *compressor {
	t.Helper()
	c := &compressor{}
	w, err := flate.NewWriter(&c.buf, flate.BestCompression)
	if err != nil {
		t.Fatal(err)
	}
	c.w = w
	return c
}

func (c *compressor) message(t *testing.T, msg string) []byte {
	t.Helper()
	c.buf.Reset()
	if _, err := c.w.Write([]byte(msg)); err != nil {
		t.Fatal(err)
	}
	if err := c.w.Flush(); err != nil {
		t.Fatal(err)
	}
	out := bytes.Clone(c.buf.Bytes())
	tail := []byte{0x00, 0x00, 0xff, 0xff}
	if !bytes.HasSuffix(out, tail) {
		t.Fatalf("a sync flush didn't end with its tail")
	}
	return out[:len(out)-len(tail)]
}

// wsHarness runs Relay between two pipes: the test plays the sandbox on client and the destination on server, and
// what each receives is collected.
type wsHarness struct {
	client   net.Conn
	server   net.Conn
	atClient chan wsFrame
	atServer chan wsFrame
	done     chan error
}

func startRelay(t *testing.T, ext Extensions) *wsHarness {
	t.Helper()
	clientApp, clientProxy := net.Pipe()
	serverProxy, serverApp := net.Pipe()
	h := &wsHarness{client: clientApp, server: serverApp, atClient: make(chan wsFrame, 16), atServer: make(chan wsFrame, 16), done: make(chan error, 1)}
	go collectFrames(clientApp, false, h.atClient)
	go collectFrames(serverApp, true, h.atServer)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		h.done <- Relay(ctx, clientProxy, serverProxy, ext, "sbx-1", wsDest, testStore(), testEntries())
	}()
	t.Cleanup(func() {
		cancel()
		clientApp.Close()
		serverApp.Close()
	})
	return h
}

// collectFrames reads what Relay sends one side; the frames from Relay must be masked towards the server and not
// towards the client, or readFrame fails and the channel closes early.
func collectFrames(r io.Reader, masked bool, out chan<- wsFrame) {
	defer close(out)
	br := bufio.NewReader(r)
	for {
		f, err := readFrame(br, masked, maxMessage)
		if err != nil {
			return
		}
		out <- f
	}
}

func (h *wsHarness) fromClient(t *testing.T, frames ...[]byte) {
	t.Helper()
	for _, f := range frames {
		if _, err := h.client.Write(f); err != nil {
			t.Fatal(err)
		}
	}
}

func (h *wsHarness) fromServer(t *testing.T, frames ...[]byte) {
	t.Helper()
	for _, f := range frames {
		if _, err := h.server.Write(f); err != nil {
			t.Fatal(err)
		}
	}
}

func recvFrame(t *testing.T, ch <-chan wsFrame) wsFrame {
	t.Helper()
	select {
	case f, ok := <-ch:
		if !ok {
			t.Fatal("the connection closed before the frame came")
		}
		return f
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for a frame")
	}
	return wsFrame{}
}

func (h *wsHarness) wait(t *testing.T) error {
	t.Helper()
	select {
	case err := <-h.done:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("Relay didn't return")
	}
	return nil
}

// finish runs the closing handshake, client first, and checks Relay ends cleanly.
func (h *wsHarness) finish(t *testing.T) {
	t.Helper()
	h.fromClient(t, encodeFrame(true, false, opClose, closePayload(closeNormal, ""), true))
	if f := recvFrame(t, h.atServer); f.opcode != opClose {
		t.Fatalf("the server got opcode %d, want close", f.opcode)
	}
	h.fromServer(t, encodeFrame(true, false, opClose, closePayload(closeNormal, ""), false))
	if f := recvFrame(t, h.atClient); f.opcode != opClose {
		t.Fatalf("the client got opcode %d, want close", f.opcode)
	}
	if err := h.wait(t); err != nil {
		t.Fatalf("Relay: %v", err)
	}
}

type wantFrame struct {
	op      byte
	payload string
}

func checkFrame(t *testing.T, f wsFrame, want wantFrame) {
	t.Helper()
	if f.opcode != want.op || string(f.payload) != want.payload {
		t.Fatalf("got opcode %d %q, want opcode %d %q", f.opcode, f.payload, want.op, want.payload)
	}
	if !f.fin || f.rsv1 {
		t.Fatalf("got fin %v rsv1 %v, want one whole uncompressed frame", f.fin, f.rsv1)
	}
}

func TestRelayClientMessages(t *testing.T) {
	first := `{"auth":"` + phGitHub + `","op":"subscribe","channel":"repository-events"}`
	second := `{"auth":"` + phGitHub + `","op":"subscribe","channel":"repository-issues"}`
	swapped := func(s string) string { return strings.ReplaceAll(s, phGitHub, githubValue) }
	tests := []struct {
		name   string
		ext    Extensions
		frames func(t *testing.T) [][]byte
		want   []wantFrame
	}{
		{
			name: "text",
			frames: func(t *testing.T) [][]byte {
				return [][]byte{encodeFrame(true, false, opText, []byte("auth "+phGitHub), true)}
			},
			want: []wantFrame{{opText, "auth " + githubValue}},
		},
		{
			name: "binary without placeholders",
			frames: func(t *testing.T) [][]byte {
				return [][]byte{encodeFrame(true, false, opBinary, []byte{0, 1, 2, 0xff}, true)}
			},
			want: []wantFrame{{opBinary, "\x00\x01\x02\xff"}},
		},
		{
			name: "fragmented, with a ping between the fragments",
			frames: func(t *testing.T) [][]byte {
				return [][]byte{
					encodeFrame(false, false, opText, []byte("start "+phGitHub[:20]), true),
					encodeFrame(true, false, opPing, []byte("are you there"), true),
					encodeFrame(true, false, opContinuation, []byte(phGitHub[20:]+" end"), true),
				}
			},
			want: []wantFrame{{opPing, "are you there"}, {opText, "start " + githubValue + " end"}},
		},
		{
			name: "permessage-deflate with context takeover",
			ext:  Extensions{Deflate: true},
			frames: func(t *testing.T) [][]byte {
				c := newCompressor(t)
				return [][]byte{
					encodeFrame(true, true, opText, c.message(t, first), true),
					encodeFrame(true, true, opText, c.message(t, second), true),
				}
			},
			want: []wantFrame{{opText, swapped(first)}, {opText, swapped(second)}},
		},
		{
			name: "permessage-deflate, fragmented, then uncompressed",
			ext:  Extensions{Deflate: true},
			frames: func(t *testing.T) [][]byte {
				compressed := newCompressor(t).message(t, first)
				return [][]byte{
					encodeFrame(false, true, opText, compressed[:5], true),
					encodeFrame(true, false, opContinuation, compressed[5:], true),
					encodeFrame(true, false, opText, []byte(second), true),
				}
			},
			want: []wantFrame{{opText, swapped(first)}, {opText, swapped(second)}},
		},
		{
			name: "permessage-deflate without context takeover",
			ext:  Extensions{Deflate: true, ClientNoContextTakeover: true},
			frames: func(t *testing.T) [][]byte {
				return [][]byte{
					encodeFrame(true, true, opText, newCompressor(t).message(t, first), true),
					encodeFrame(true, true, opText, newCompressor(t).message(t, second), true),
				}
			},
			want: []wantFrame{{opText, swapped(first)}, {opText, swapped(second)}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := startRelay(t, tt.ext)
			h.fromClient(t, tt.frames(t)...)
			for _, want := range tt.want {
				checkFrame(t, recvFrame(t, h.atServer), want)
			}
			h.finish(t)
		})
	}
}

func TestRelayScrubsServerMessages(t *testing.T) {
	echo := "you said " + githubValue + " and " + npmValue
	scrubbed := "you said " + phGitHub + " and " + phNPM

	t.Run("plain", func(t *testing.T) {
		h := startRelay(t, Extensions{})
		h.fromServer(t, encodeFrame(true, false, opText, []byte(echo), false))
		checkFrame(t, recvFrame(t, h.atClient), wantFrame{opText, scrubbed})
		h.finish(t)
	})

	t.Run("permessage-deflate with context takeover", func(t *testing.T) {
		h := startRelay(t, Extensions{Deflate: true})
		c := newCompressor(t)
		h.fromServer(t,
			encodeFrame(true, true, opText, c.message(t, echo), false),
			encodeFrame(true, true, opText, c.message(t, echo+"!"), false),
		)
		checkFrame(t, recvFrame(t, h.atClient), wantFrame{opText, scrubbed})
		checkFrame(t, recvFrame(t, h.atClient), wantFrame{opText, scrubbed + "!"})
		h.finish(t)
	})
}

func TestRelayRefusesAnUnboundPlaceholder(t *testing.T) {
	h := startRelay(t, Extensions{})
	h.fromClient(t, encodeFrame(true, false, opText, []byte("token "+phNPM), true))
	f := recvFrame(t, h.atClient)
	if f.opcode != opClose || len(f.payload) < 2 || binary.BigEndian.Uint16(f.payload) != closePolicy {
		t.Fatalf("the client got opcode %d %q, want close 1008", f.opcode, f.payload)
	}
	if reason := string(f.payload[2:]); !strings.Contains(reason, "NPM_TOKEN") || strings.Contains(reason, npmValue) {
		t.Fatalf("the close reason %q should name the variable and only that", reason)
	}
	for f := range h.atServer {
		if f.opcode != opClose {
			t.Fatalf("the server got opcode %d %q, want only a close", f.opcode, f.payload)
		}
	}
	var ref *Refusal
	if err := h.wait(t); !errors.As(err, &ref) || ref.Code != CodeUnbound || ref.Variable != "NPM_TOKEN" {
		t.Fatalf("Relay answered %v, want an unbound refusal", err)
	}
}

func TestRelayClosesAMessageTooBig(t *testing.T) {
	h := startRelay(t, Extensions{})
	header := []byte{0x80 | opBinary, 0x80 | 127}
	header = binary.BigEndian.AppendUint64(header, maxMessage+1)
	h.fromClient(t, header)
	f := recvFrame(t, h.atClient)
	if f.opcode != opClose || len(f.payload) < 2 || binary.BigEndian.Uint16(f.payload) != closeTooBig {
		t.Fatalf("the client got opcode %d %q, want close 1009", f.opcode, f.payload)
	}
	var ref *Refusal
	if err := h.wait(t); !errors.As(err, &ref) || ref.Code != CodeTooLarge {
		t.Fatalf("Relay answered %v, want a too-large refusal", err)
	}
}

func TestParseExtensions(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   Extensions
	}{
		{"none", "", Extensions{}},
		{"deflate", "permessage-deflate", Extensions{Deflate: true}},
		{"client no context takeover", "permessage-deflate; client_no_context_takeover; server_max_window_bits=10", Extensions{Deflate: true, ClientNoContextTakeover: true}},
		{"server no context takeover", "Permessage-Deflate;server_no_context_takeover", Extensions{Deflate: true, ServerNoContextTakeover: true}},
		{"both", "permessage-deflate; client_no_context_takeover; server_no_context_takeover", Extensions{Deflate: true, ClientNoContextTakeover: true, ServerNoContextTakeover: true}},
		{"another extension", "x-webkit-deflate-frame", Extensions{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := http.Header{}
			if tt.header != "" {
				h.Set("Sec-WebSocket-Extensions", tt.header)
			}
			if got := ParseExtensions(h); got != tt.want {
				t.Fatalf("ParseExtensions = %+v, want %+v", got, tt.want)
			}
		})
	}
}
