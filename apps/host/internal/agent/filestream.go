package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path"
	"strconv"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// File streams (sandbox.files.open): a file's bytes on a port stream, both ways, so a large file (a signed file URL's,
// an archive's) is never held whole, nor base64'd, as sandbox.files.read and write hold it.

// FileStreamer is a tier that streams files. A tier without it answers sandbox.files.open as unsupported.
type FileStreamer interface {
	// ReadFileStream opens the whole file: its bytes, which the caller closes, and its size. A missing file is
	// not_found, as ReadFile's is.
	ReadFileStream(ctx context.Context, p proto.FileParams) (io.ReadCloser, int64, error)
	// WriteFileStream writes what r gives (with p.Mode), moving it over the file only once r has ended (io.EOF); a read
	// error from r, or a cancelled ctx, leaves the file as it was. It answers the size written.
	WriteFileStream(ctx context.Context, p proto.FileParams, r io.Reader) (int64, error)
}

// fileStreamer is the tier holding a sandbox, as a FileStreamer.
func (h *Host) fileStreamer(sandboxID string) (FileStreamer, error) {
	t, name, err := h.tierOfNamed(sandboxID)
	if err != nil {
		return nil, err
	}
	fs, ok := t.(FileStreamer)
	if !ok {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s sandboxes don't stream files", name)}
	}
	return fs, nil
}

// fileStreamReason is the reason of the stream.close that ends a file stream: "ok <size>", or
// "error <code>: <message>".
func fileStreamReason(size int64, err error) string {
	if err != nil {
		pe := toError(err)
		return "error " + pe.Code + ": " + pe.Message
	}
	return "ok " + strconv.FormatInt(size, 10)
}

// errFileStreamAborted is what a write's tier reads once its stream is aborted, rather than the end of the input.
var errFileStreamAborted = errors.New("the file stream was aborted")

// fileConn is a file stream as the session's streams hold it, so binary() and closeStream() reach it as they reach a
// port. For a write, what Kantel sends goes into a pipe the tier reads, and an empty frame (CloseWrite) is the end of
// it. Close aborts either way: it cancels the tier's call and fails the pipe, so a write is never moved into place.
type fileConn struct {
	// w is a write's pipe; nil for a read, whose stream carries nothing from Kantel (what it sends is dropped).
	w      *io.PipeWriter
	cancel context.CancelFunc
}

func (c *fileConn) Read([]byte) (int, error) { return 0, io.EOF }

func (c *fileConn) Write(b []byte) (int, error) {
	if c.w == nil {
		return len(b), nil
	}
	return c.w.Write(b)
}

// CloseWrite is the end of a write's input: the tier reads io.EOF, and moves the file into place.
func (c *fileConn) CloseWrite() error {
	if c.w == nil {
		return nil
	}
	return c.w.Close()
}

func (c *fileConn) Close() error {
	c.cancel()
	if c.w != nil {
		// After a CloseWrite the tier has its io.EOF already; the cancel is what stops it then.
		_ = c.w.CloseWithError(errFileStreamAborted)
	}
	return nil
}

func (c *fileConn) LocalAddr() net.Addr              { return fileAddr{} }
func (c *fileConn) RemoteAddr() net.Addr             { return fileAddr{} }
func (c *fileConn) SetDeadline(time.Time) error      { return nil }
func (c *fileConn) SetReadDeadline(time.Time) error  { return nil }
func (c *fileConn) SetWriteDeadline(time.Time) error { return nil }

type fileAddr struct{}

func (fileAddr) Network() string { return "kantel-file" }
func (fileAddr) String() string  { return "kantel-file" }

var _ net.Conn = (*fileConn)(nil)

// openFile sets up a file stream the control plane named, on a sandbox whose tier streams files: a read answers the
// file's size once it is open, a write {} once its stream takes frames. The transfer outlives the call, so it runs on
// the session's context (call, the call's own, can end it only until it is set up); start, called once the call is
// answered, runs it, so neither the bytes nor the stream.close that ends it come before the answer. When it ends, the
// stream goes from the session's and a stream.close says how it went, unless Kantel closed the stream itself.
func (s *session) openFile(ctx, call context.Context, raw json.RawMessage) (any, func(), error) {
	var p proto.FileOpenParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, nil, invalid("bad sandbox.files.open: %v", err)
	}
	switch {
	case p.Stream == 0:
		return nil, nil, invalid("sandbox.files.open needs a stream")
	case p.Op != proto.FileOpRead && p.Op != proto.FileOpWrite:
		return nil, nil, invalid("sandbox.files.open's op is read or write, not %q", p.Op)
	case !path.IsAbs(p.Path):
		return nil, nil, invalid("sandbox.files.open needs an absolute path, not %q", p.Path)
	}
	streamer, err := s.host.fileStreamer(p.SandboxID)
	if err != nil {
		return nil, nil, err
	}
	fp := proto.FileParams{SandboxID: p.SandboxID, Path: p.Path, Mode: p.Mode}
	tctx, cancel := context.WithCancel(ctx)
	// Until it is set up, the call's end (a claim on its sandbox, or its space turning E2E on) ends it too.
	stop := context.AfterFunc(call, cancel)
	conn := &fileConn{cancel: cancel}
	var result any
	var transfer func() (int64, error)
	// finish runs once the stream is out of the session's: a read's file is closed, and a write's pipe fails, so a frame
	// still being written to it returns rather than holding the session's reads.
	var finish func()
	if p.Op == proto.FileOpRead {
		body, size, err := streamer.ReadFileStream(tctx, fp)
		if err != nil {
			stop()
			cancel()
			return nil, nil, err
		}
		result = map[string]int64{"size": size}
		transfer = func() (int64, error) { return s.sendFile(ctx, p.Stream, body, size) }
		finish = func() { body.Close() }
	} else {
		pr, pw := io.Pipe()
		conn.w = pw
		result = struct{}{}
		transfer = func() (int64, error) { return streamer.WriteFileStream(tctx, fp, pr) }
		finish = func() { _ = pr.CloseWithError(errors.New("the file stream has ended")) }
	}
	stop()
	if tctx.Err() != nil {
		// Ended while it was being set up: nothing was registered, so nothing else will close it.
		cancel()
		finish()
		return nil, nil, &proto.Error{Code: proto.ErrConflict, Message: "this call was ended: its sandbox's space turned E2E on, or the sandbox is being replaced"}
	}
	var registered net.Conn = conn
	s.mu.Lock()
	if old, ok := s.streams[p.Stream]; ok {
		old.Close()
	}
	s.streams[p.Stream] = registered
	s.mu.Unlock()
	// A plaintext file stream ends if its sandbox's space turns E2E on while it runs, as a port does.
	forget := s.host.watchPlain(s.host.ownerOf(p.SandboxID), func() { conn.Close() })
	start := func() {
		go func() {
			defer forget()
			n, err := transfer()
			s.mu.Lock()
			current := s.streams[p.Stream] == registered
			if current {
				delete(s.streams, p.Stream)
			}
			s.mu.Unlock()
			finish()
			if err != nil && tctx.Err() != nil && ctx.Err() == nil {
				err = &proto.Error{Code: proto.ErrConflict, Message: "this file stream was ended: its sandbox's space turned E2E on"}
			}
			conn.Close()
			if current {
				_ = s.send(ctx, proto.Message{Type: "stream.close", Stream: p.Stream, Reason: fileStreamReason(n, err)})
			}
		}()
	}
	return result, start, nil
}

// sendFile sends r's bytes on a stream (on the session's context: a cancelled one closes the WebSocket) and answers how
// many it sent; fewer or more than size is an error, as the file changed while it was read.
func (s *session) sendFile(ctx context.Context, stream uint32, r io.Reader, size int64) (int64, error) {
	buf := make([]byte, 32*1024)
	var sent int64
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if werr := s.sendBinary(ctx, stream, buf[:n]); werr != nil {
				return sent, werr
			}
			sent += int64(n)
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return sent, err
		}
	}
	if sent != size {
		return sent, &proto.Error{Code: proto.ErrConflict, Message: fmt.Sprintf("the file changed while it was read: %d bytes of %d", sent, size)}
	}
	return sent, nil
}
