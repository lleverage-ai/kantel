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
	"sync/atomic"
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

// ArchiveExtractor is a tier that extracts archives (sandbox.files.extract) with its own code, never the sandbox's tar,
// shell or environment: a caller that may only use files runs nothing in the sandbox. A tier without it answers the
// call as unsupported.
type ArchiveExtractor interface {
	ExtractArchive(ctx context.Context, p proto.FileExtractParams) error
}

// archiveExtractor is the tier holding a sandbox, as an ArchiveExtractor.
func (h *Host) archiveExtractor(sandboxID string) (ArchiveExtractor, error) {
	t, name, err := h.tierOfNamed(sandboxID)
	if err != nil {
		return nil, err
	}
	x, ok := t.(ArchiveExtractor)
	if !ok {
		return nil, &proto.Error{Code: proto.ErrUnsupported, Message: fmt.Sprintf("%s sandboxes don't extract archives", name)}
	}
	return x, nil
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
	// taken is how much of a write the tier has read from the pipe; acks is signalled each FileStreamAckBytes of it,
	// for the goroutine that sends stream.ack. Write runs on the session's reader only, so signalled needs no lock.
	taken     atomic.Int64
	signalled int64
	acks      chan struct{}
	// acked is how much of a read Kantel's reader has taken (its stream.ack); more is signalled on each, for sendFile
	// waiting on its window.
	acked atomic.Int64
	more  chan struct{}
}

// ack is Kantel's stream.ack of a read: its reader has taken n bytes in all.
func (c *fileConn) ack(n int64) {
	if c.more == nil {
		return
	}
	for {
		cur := c.acked.Load()
		if n <= cur || c.acked.CompareAndSwap(cur, n) {
			break
		}
	}
	select {
	case c.more <- struct{}{}:
	default:
	}
}

// errFileInput is a write's input pipe failing because the tier closed its end (it gave up on the input, as the guest's
// HTTP client does on a refused write): the transfer reports how it went, so the stream isn't closed under it.
type errFileInput struct{ err error }

func (e *errFileInput) Error() string { return e.err.Error() }
func (e *errFileInput) Unwrap() error { return e.err }

func (c *fileConn) Read([]byte) (int, error) { return 0, io.EOF }

func (c *fileConn) Write(b []byte) (int, error) {
	if c.w == nil {
		return len(b), nil
	}
	// The pipe hands b to the tier's read, so it returns once the tier has taken it: what Kantel's window waits on.
	n, err := c.w.Write(b)
	if total := c.taken.Add(int64(n)); total-c.signalled >= proto.FileStreamAckBytes {
		c.signalled = total
		select {
		case c.acks <- struct{}{}:
		default:
		}
	}
	if err != nil {
		// The tier closed its end: its transfer ends with the reason, and says so on the stream itself.
		return n, &errFileInput{err: err}
	}
	return n, nil
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
func (s *session) openFile(ctx, call context.Context, raw json.RawMessage, release func()) (any, func(), error) {
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
	// Until its transfer is over, the call's end (a claim on its sandbox, or its space turning E2E on) ends it too:
	// the call's guard (release) is held as long, so a claim waits for the transfer to stop before it goes on.
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
		if p.Acks {
			conn.more = make(chan struct{}, 1)
		}
		transfer = func() (int64, error) { return s.sendFile(ctx, tctx, conn, p.Stream, body, size) }
		finish = func() { body.Close() }
	} else {
		pr, pw := io.Pipe()
		conn.w = pw
		// Ended (a claim on its sandbox, Kantel's abort): a tier waiting on the next frame reads the abort at once rather
		// than waiting for one, so a claim waiting on the transfer isn't held by a gateway that sends nothing more.
		context.AfterFunc(tctx, func() { _ = pw.CloseWithError(errFileStreamAborted) })
		conn.acks = make(chan struct{}, 1)
		result = struct{}{}
		transfer = func() (int64, error) { return streamer.WriteFileStream(tctx, fp, pr) }
		finish = func() { _ = pr.CloseWithError(errors.New("the file stream has ended")) }
	}
	if tctx.Err() != nil {
		// Ended while it was being set up: nothing was registered, so nothing else will close it.
		stop()
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
		if conn.acks != nil {
			// Off the session's reader, so a slow socket never holds the frames coming in; ends with the stream.
			go func() {
				for {
					select {
					case <-tctx.Done():
						return
					case <-conn.acks:
						_ = s.send(ctx, proto.Message{Type: "stream.ack", Stream: p.Stream, Acked: conn.taken.Load()})
					}
				}
			}()
		}
		go func() {
			defer forget()
			n, err := transfer()
			// Before the guard goes, as the guard's release ends the call's context.
			stop()
			s.mu.Lock()
			current := s.streams[p.Stream] == registered
			if current {
				delete(s.streams, p.Stream)
			}
			s.mu.Unlock()
			finish()
			if err != nil && tctx.Err() != nil && ctx.Err() == nil {
				err = &proto.Error{Code: proto.ErrConflict, Message: "this file stream was ended: its sandbox's space turned E2E on, or the sandbox is being deleted or replaced"}
			}
			conn.Close()
			// Nothing of the transfer is left to reach the sandbox: a claim waiting on it may go on.
			release()
			if current {
				_ = s.send(ctx, proto.Message{Type: "stream.close", Stream: p.Stream, Reason: fileStreamReason(n, err)})
			}
		}()
	}
	return result, start, nil
}

// sendFile sends r's bytes on a stream (on the session's context: a cancelled one closes the WebSocket) and answers how
// many it sent; fewer or more than size is an error, as the file changed while it was read. When Kantel's reader acks
// (FileOpenParams.Acks), it stays within FileStreamWindowBytes of what that has taken (conn's stream.acks), waiting
// while it can't, until the stream ends (tctx).
func (s *session) sendFile(ctx, tctx context.Context, conn *fileConn, stream uint32, r io.Reader, size int64) (int64, error) {
	// Well within proto.FileStreamFrameMaxBytes, past which Kantel ends the read.
	buf := make([]byte, min(32*1024, proto.FileStreamFrameMaxBytes))
	var sent int64
	for {
		for conn.more != nil && sent-conn.acked.Load() >= proto.FileStreamWindowBytes {
			select {
			case <-tctx.Done():
				return sent, tctx.Err()
			case <-conn.more:
			}
		}
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
