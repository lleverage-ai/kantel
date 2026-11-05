package protect

import (
	"bufio"
	"bytes"
	"compress/flate"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"strings"
)

// WebSocket opcodes (RFC 6455 5.2).
const (
	opContinuation byte = 0x0
	opText         byte = 0x1
	opBinary       byte = 0x2
	opClose        byte = 0x8
	opPing         byte = 0x9
	opPong         byte = 0xa
)

// Close codes (RFC 6455 7.4.1).
const (
	closeNormal        = 1000
	closeGoingAway     = 1001
	closeProtocolError = 1002
	closeInvalidData   = 1007
	closePolicy        = 1008
	closeTooBig        = 1009
	closeInternal      = 1011
)

// maxMessage is the largest WebSocket message relayed, before and after inflating: a message is held whole to be
// swapped, so it is bounded.
const maxMessage = 16 << 20

var (
	errProtocol = errors.New("protect: websocket protocol error")
	errTooBig   = errors.New("protect: websocket message larger than 16 MiB")
	errBadData  = errors.New("protect: websocket message can't be inflated")
)

type wsFrame struct {
	fin, rsv1 bool
	opcode    byte
	payload   []byte
}

// readFrame reads one frame, unmasked. masked says whether frames from this side must be masked (a client's) or
// must not be (a server's). A data frame longer than limit is errTooBig, found before its payload is read.
func readFrame(r io.Reader, masked bool, limit int) (wsFrame, error) {
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return wsFrame{}, err
	}
	f := wsFrame{fin: h[0]&0x80 != 0, rsv1: h[0]&0x40 != 0, opcode: h[0] & 0x0f}
	if h[0]&0x30 != 0 || (h[1]&0x80 != 0) != masked {
		return f, errProtocol
	}
	switch {
	case f.opcode >= opClose && f.opcode <= opPong:
		if !f.fin || f.rsv1 || h[1]&0x7f > 125 {
			return f, errProtocol
		}
	case f.opcode > opBinary:
		return f, errProtocol
	}
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return f, err
		}
		n = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return f, err
		}
		n = binary.BigEndian.Uint64(b[:])
	}
	if n > uint64(max(limit, 0)) && f.opcode < opClose {
		return f, errTooBig
	}
	var key [4]byte
	if masked {
		if _, err := io.ReadFull(r, key[:]); err != nil {
			return f, err
		}
	}
	f.payload = make([]byte, n)
	if _, err := io.ReadFull(r, f.payload); err != nil {
		return f, err
	}
	if masked {
		for i := range f.payload {
			f.payload[i] ^= key[i&3]
		}
	}
	return f, nil
}

// writeFrame writes one whole (FIN, RSV1 = 0) frame; mask is for frames to a server, each with a fresh key.
func writeFrame(w io.Writer, opcode byte, payload []byte, mask bool) error {
	n := len(payload)
	frame := make([]byte, 0, 14+n)
	frame = append(frame, 0x80|opcode)
	var m byte
	if mask {
		m = 0x80
	}
	switch {
	case n < 126:
		frame = append(frame, m|byte(n))
	case n <= 0xffff:
		frame = append(frame, m|126)
		frame = binary.BigEndian.AppendUint16(frame, uint16(n))
	default:
		frame = append(frame, m|127)
		frame = binary.BigEndian.AppendUint64(frame, uint64(n))
	}
	if mask {
		var key [4]byte
		if _, err := rand.Read(key[:]); err != nil {
			return err
		}
		frame = append(frame, key[:]...)
		for i, c := range payload {
			frame = append(frame, c^key[i&3])
		}
	} else {
		frame = append(frame, payload...)
	}
	_, err := w.Write(frame)
	return err
}

// closePayload is a close frame's body: the code, then a reason cut to fit a control frame.
func closePayload(code int, reason string) []byte {
	if len(reason) > 123 {
		reason = strings.ToValidUTF8(reason[:123], "")
	}
	b := binary.BigEndian.AppendUint16(make([]byte, 0, 2+len(reason)), uint16(code))
	return append(b, reason...)
}

// deflateTail completes a permessage-deflate message for compress/flate: the empty stored block the sender stripped
// (RFC 7692 7.2.2), then a final empty stored block, so the reader ends cleanly at the message's end instead of
// waiting for more.
var deflateTail = []byte{0x00, 0x00, 0xff, 0xff, 0x01, 0x00, 0x00, 0xff, 0xff}

// deflateWindow is how far back a deflate stream can refer.
const deflateWindow = 32 << 10

// inflater inflates one direction's messages. With context takeover a message may refer back into the ones before
// it; deflate refers back at most 32 KiB, so the last 32 KiB of output, given as the next message's dictionary, is
// the whole of the context.
type inflater struct {
	takeover bool
	r        io.ReadCloser
	window   []byte
}

func (in *inflater) inflate(data []byte, limit int) ([]byte, error) {
	src := io.MultiReader(bytes.NewReader(data), bytes.NewReader(deflateTail))
	var dict []byte
	if in.takeover {
		dict = in.window
	}
	if rs, ok := in.r.(flate.Resetter); ok {
		if err := rs.Reset(src, dict); err != nil {
			return nil, errBadData
		}
	} else {
		in.r = flate.NewReaderDict(src, dict)
	}
	out, err := io.ReadAll(io.LimitReader(in.r, int64(limit)+1))
	if err != nil {
		return nil, errBadData
	}
	if len(out) > limit {
		return nil, errTooBig
	}
	if in.takeover {
		in.window = append(in.window, out...)
		if len(in.window) > deflateWindow {
			in.window = append([]byte(nil), in.window[len(in.window)-deflateWindow:]...)
		}
	}
	return out, nil
}

// messageReader reads one side's frames as whole messages: a data message reassembled from its fragments and
// inflated, or a control frame as it came (control frames may arrive between a message's fragments).
type messageReader struct {
	in       *bufio.Reader
	masked   bool
	deflate  bool
	inflater inflater

	msg        []byte
	op         byte
	compressed bool
	inMsg      bool
}

// next answers the next control frame or whole data message. The payload is only good until the next call.
func (m *messageReader) next() (byte, []byte, error) {
	if !m.inMsg {
		if cap(m.msg) > 1<<20 {
			m.msg = nil
		}
		m.msg = m.msg[:0]
	}
	for {
		f, err := readFrame(m.in, m.masked, maxMessage-len(m.msg))
		if err != nil {
			return 0, nil, err
		}
		if f.opcode >= opClose {
			return f.opcode, f.payload, nil
		}
		if f.opcode == opContinuation {
			if !m.inMsg || f.rsv1 {
				return 0, nil, errProtocol
			}
		} else {
			if m.inMsg || (f.rsv1 && !m.deflate) {
				return 0, nil, errProtocol
			}
			m.inMsg, m.op, m.compressed = true, f.opcode, f.rsv1
		}
		m.msg = append(m.msg, f.payload...)
		if !f.fin {
			continue
		}
		m.inMsg = false
		if !m.compressed {
			return m.op, m.msg, nil
		}
		out, err := m.inflater.inflate(m.msg, maxMessage)
		if err != nil {
			return 0, nil, err
		}
		return m.op, out, nil
	}
}
