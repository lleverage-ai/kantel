package agent

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/lleverage-ai/kantel/apps/host/internal/microvm"
	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// streamTier is a microVM tier holding sbx_one, whose files are in memory and stream both ways.
type streamTier struct {
	Tier
	mu    sync.Mutex
	files map[string][]byte
	// writes gets what each write read instead of the end of its input (nil when it ended properly).
	writes chan error
}

func newStreamTier(files map[string][]byte) *streamTier {
	return &streamTier{files: files, writes: make(chan error, 8)}
}

func (f *streamTier) Get(id string) (proto.SandboxInfo, error) {
	if id != "sbx_one" {
		return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: id}
	}
	return proto.SandboxInfo{ID: id, Tier: microvm.Tier, State: proto.StateRunning}, nil
}

func (f *streamTier) ReadFileStream(_ context.Context, p proto.FileParams) (io.ReadCloser, int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.files[p.Path]
	if !ok {
		return nil, 0, &proto.Error{Code: proto.ErrNotFound, Message: p.Path}
	}
	return io.NopCloser(bytes.NewReader(data)), int64(len(data)), nil
}

// WriteFileStream keeps the file only once its input has ended, as the guest moves it into place only then.
func (f *streamTier) WriteFileStream(ctx context.Context, p proto.FileParams, r io.Reader) (int64, error) {
	data, err := io.ReadAll(r)
	if err == nil {
		err = ctx.Err()
	}
	f.writes <- err
	if err != nil {
		return 0, err
	}
	f.mu.Lock()
	f.files[p.Path] = data
	f.mu.Unlock()
	return int64(len(data)), nil
}

func (f *streamTier) file(path string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.files[path]
	return data, ok
}

func streamHost(t *testing.T, tier Tier) *Host {
	t.Helper()
	h := newLifecycleHost(t, newLifecycleTier())
	h.tiers = map[string]Tier{microvm.Tier: tier}
	return h
}

// controlPlane is Kantel's end of a session's WebSocket, played by the test.
type controlPlane struct {
	t   *testing.T
	ctx context.Context
	ws  *websocket.Conn
}

// connectSession is a session of h on a WebSocket whose other end the test plays; the host's end reads as
// connectOnce's loop does.
func connectSession(t *testing.T, h *Host) (*session, *controlPlane) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	accepted := make(chan *websocket.Conn, 1)
	hold := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		accepted <- c
		<-hold
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(hold) })
	kantel, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { kantel.CloseNow() })
	ws := <-accepted
	t.Cleanup(func() { ws.CloseNow() })
	ws.SetReadLimit(64 << 20)
	kantel.SetReadLimit(64 << 20)
	s := &session{host: h, ws: ws, streams: map[uint32]net.Conn{}, cancel: cancel}
	go func() {
		for {
			kind, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			if kind == websocket.MessageBinary {
				s.binary(raw)
				continue
			}
			var m proto.Message
			if json.Unmarshal(raw, &m) != nil {
				continue
			}
			switch m.Type {
			case "call":
				go s.call(ctx, m, nil)
			case "stream.close":
				s.closeStream(m.Stream)
			}
		}
	}()
	return s, &controlPlane{t: t, ctx: ctx, ws: kantel}
}

func (c *controlPlane) send(m proto.Message) {
	c.t.Helper()
	raw, _ := json.Marshal(m)
	if err := c.ws.Write(c.ctx, websocket.MessageText, raw); err != nil {
		c.t.Fatal(err)
	}
}

func (c *controlPlane) open(id string, p proto.FileOpenParams) {
	c.t.Helper()
	raw, _ := json.Marshal(p)
	c.send(proto.Message{Type: "call", ID: id, Method: proto.MethodFileOpen, Params: raw})
}

func (c *controlPlane) frame(stream uint32, payload []byte) {
	c.t.Helper()
	b := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(b, stream)
	copy(b[4:], payload)
	if err := c.ws.Write(c.ctx, websocket.MessageBinary, b); err != nil {
		c.t.Fatal(err)
	}
}

// next is what the host sends next: a text frame's message, or a binary frame's stream and payload.
func (c *controlPlane) next() (proto.Message, uint32, []byte) {
	c.t.Helper()
	kind, raw, err := c.ws.Read(c.ctx)
	if err != nil {
		c.t.Fatal(err)
	}
	if kind == websocket.MessageBinary {
		if len(raw) < 4 {
			c.t.Fatalf("a binary frame of %d bytes", len(raw))
		}
		return proto.Message{}, binary.BigEndian.Uint32(raw), raw[4:]
	}
	var m proto.Message
	if err := json.Unmarshal(raw, &m); err != nil {
		c.t.Fatal(err)
	}
	return m, 0, nil
}

// result is the answer to call id, which must come next.
func (c *controlPlane) result(id string) proto.Message {
	c.t.Helper()
	m, stream, _ := c.next()
	if m.Type != "result" || m.ID != id {
		c.t.Fatalf("got %q (stream %d) before call %s's result", m.Type, stream, id)
	}
	return m
}

func content(size int) []byte {
	b := make([]byte, size)
	for i := range b {
		b[i] = byte(i * 13)
	}
	return b
}

// A read answers the file's size, then its bytes on the stream, then a stream.close of "ok <size>": nothing of the
// stream before the answer, an empty file too.
func TestAFileIsReadOnItsStream(t *testing.T) {
	big := content(1<<20 + 77)
	tier := newStreamTier(map[string][]byte{"/home/user/big.bin": big, "/home/user/empty": {}})
	s, cp := connectSession(t, streamHost(t, tier))
	for i, c := range []struct {
		path string
		want []byte
	}{{"/home/user/big.bin", big}, {"/home/user/empty", nil}} {
		id := fmt.Sprintf("c%d", i)
		stream := uint32(7 + i)
		cp.open(id, proto.FileOpenParams{SandboxID: "sbx_one", Stream: stream, Path: c.path, Op: proto.FileOpRead})
		m := cp.result(id)
		var res struct {
			Size *int64 `json:"size"`
		}
		if m.Error != nil || json.Unmarshal(m.Result, &res) != nil || res.Size == nil || *res.Size != int64(len(c.want)) {
			t.Fatalf("%s: result %s, error %v", c.path, m.Result, m.Error)
		}
		var got bytes.Buffer
		for {
			m, on, payload := cp.next()
			if m.Type == "" {
				if on != stream {
					t.Fatalf("%s: bytes on stream %d", c.path, on)
				}
				got.Write(payload)
				continue
			}
			if m.Type != "stream.close" || m.Stream != stream || m.Reason != fmt.Sprintf("ok %d", len(c.want)) {
				t.Fatalf("%s: %s %d %q", c.path, m.Type, m.Stream, m.Reason)
			}
			break
		}
		if !bytes.Equal(got.Bytes(), c.want) {
			t.Fatalf("%s: %d bytes of %d, or not the file's", c.path, got.Len(), len(c.want))
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.streams) != 0 {
		t.Fatalf("%d streams left", len(s.streams))
	}
}

// A write answers {}, takes the bytes Kantel sends and an empty frame for the end, keeps the file only then, and
// ends the stream with "ok <size>". On the way it may ack what the tier has taken (stream.ack), rising, never more
// than was sent.
func TestAFileIsWrittenFromItsStream(t *testing.T) {
	tier := newStreamTier(map[string][]byte{})
	_, cp := connectSession(t, streamHost(t, tier))
	cp.open("w", proto.FileOpenParams{SandboxID: "sbx_one", Stream: 3, Path: "/home/user/up.bin", Op: proto.FileOpWrite, Mode: 0o600})
	if m := cp.result("w"); m.Error != nil || string(m.Result) != "{}" {
		t.Fatalf("result %s, error %v", m.Result, m.Error)
	}
	want := content(2<<20 + 5)
	for rest := want; len(rest) > 0; {
		n := min(len(rest), 64*1024)
		cp.frame(3, rest[:n])
		rest = rest[n:]
	}
	// Before the end: acks up to the last FileStreamAckBytes the tier has taken.
	var acked int64
	for acked < int64(len(want))/proto.FileStreamAckBytes*proto.FileStreamAckBytes {
		m, _, _ := cp.next()
		if m.Type != "stream.ack" || m.Stream != 3 || m.Acked < acked || m.Acked > int64(len(want)) {
			t.Fatalf("%s on %d for %d, after %d", m.Type, m.Stream, m.Acked, acked)
		}
		acked = m.Acked
	}
	cp.frame(3, nil)
	m, _, _ := cp.next()
	for m.Type == "stream.ack" {
		if m.Stream != 3 || m.Acked < acked || m.Acked > int64(len(want)) {
			t.Fatalf("stream.ack on %d for %d, after %d", m.Stream, m.Acked, acked)
		}
		acked = m.Acked
		m, _, _ = cp.next()
	}
	if m.Type != "stream.close" || m.Stream != 3 || m.Reason != fmt.Sprintf("ok %d", len(want)) {
		t.Fatalf("%s %d %q", m.Type, m.Stream, m.Reason)
	}
	if got, ok := tier.file("/home/user/up.bin"); !ok || !bytes.Equal(got, want) {
		t.Fatalf("the file: %d bytes of %d", len(got), len(want))
	}
}

// A stream.close from Kantel part-way through a write aborts it: the tier reads an error, not the end, so nothing is
// moved into place, and the stream is gone.
func TestAnAbortedWriteKeepsNothing(t *testing.T) {
	tier := newStreamTier(map[string][]byte{})
	s, cp := connectSession(t, streamHost(t, tier))
	cp.open("w", proto.FileOpenParams{SandboxID: "sbx_one", Stream: 5, Path: "/home/user/up.bin", Op: proto.FileOpWrite})
	if m := cp.result("w"); m.Error != nil {
		t.Fatal(m.Error)
	}
	cp.frame(5, content(1000))
	cp.send(proto.Message{Type: "stream.close", Stream: 5, Reason: "the caller went away"})
	select {
	case err := <-tier.writes:
		if !errors.Is(err, errFileStreamAborted) && !errors.Is(err, context.Canceled) {
			t.Fatalf("the write read %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the write never ended")
	}
	if _, ok := tier.file("/home/user/up.bin"); ok {
		t.Fatal("an aborted write was kept")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.streams) != 0 {
		t.Fatalf("%d streams left", len(s.streams))
	}
}

// What is wrong with a file stream is the call's error, and registers no stream.
func TestAFileStreamIsRefused(t *testing.T) {
	ctx := context.Background()
	refused := func(h *Host, p proto.FileOpenParams, code string) {
		t.Helper()
		s := &session{host: h, streams: map[uint32]net.Conn{}}
		raw, _ := json.Marshal(p)
		_, start, err := s.openFile(ctx, ctx, raw)
		var pe *proto.Error
		if !errors.As(err, &pe) || pe.Code != code || start != nil || len(s.streams) != 0 {
			t.Errorf("%+v: %v, want %s", p, err, code)
		}
	}
	h := streamHost(t, newStreamTier(map[string][]byte{}))
	refused(h, proto.FileOpenParams{SandboxID: "sbx_one", Path: "/a", Op: proto.FileOpRead}, proto.ErrInvalid)
	refused(h, proto.FileOpenParams{SandboxID: "sbx_one", Stream: 1, Path: "/a", Op: "append"}, proto.ErrInvalid)
	refused(h, proto.FileOpenParams{SandboxID: "sbx_one", Stream: 1, Path: "a/b", Op: proto.FileOpWrite}, proto.ErrInvalid)
	refused(h, proto.FileOpenParams{SandboxID: "sbx_one", Stream: 1, Path: "/missing", Op: proto.FileOpRead}, proto.ErrNotFound)
	refused(h, proto.FileOpenParams{SandboxID: "sbx_none", Stream: 1, Path: "/a", Op: proto.FileOpRead}, proto.ErrNotFound)
	// A tier that doesn't stream files.
	plain := newLifecycleTier()
	plain.running["sbx_one"] = true
	refused(newLifecycleHost(t, plain), proto.FileOpenParams{SandboxID: "sbx_one", Stream: 1, Path: "/a", Op: proto.FileOpRead}, proto.ErrUnsupported)
}

// A file stream reaches a sandbox's content, so the gateway's is refused exactly when sandbox.files.read and write are.
func TestTheGatewayCantStreamAnE2ESpacesFiles(t *testing.T) {
	h, _, _ := e2eHost(t)
	for id, want := range map[string]bool{"sbx_one": true, "sbx_other": false} {
		raw, _ := json.Marshal(proto.FileOpenParams{SandboxID: id, Stream: 1, Path: "/home/user/a", Op: proto.FileOpRead})
		err := h.gatewayMayCall(proto.MethodFileOpen, raw)
		var pe *proto.Error
		refused := errors.As(err, &pe) && strings.Contains(pe.Message, "end-to-end encrypted")
		if refused != want {
			t.Errorf("%s: refused %v (%v), want %v", id, refused, err, want)
		}
		if read := h.gatewayMayCall(proto.MethodFileRead, raw) != nil; read != refused {
			t.Errorf("%s: a file stream refused %v, a file read %v", id, refused, read)
		}
	}
}

// The host offers file streams only when a tier of its streams files.
func TestFactsReportFileStreams(t *testing.T) {
	if !slices.Contains(streamHost(t, newStreamTier(nil)).makeFacts().Features, proto.FeatureFileStreams) {
		t.Error("a host with a streaming tier didn't report file streams")
	}
	if slices.Contains(newLifecycleHost(t, newLifecycleTier()).makeFacts().Features, proto.FeatureFileStreams) {
		t.Error("a host with no streaming tier reported file streams")
	}
}

func TestFileStreamReason(t *testing.T) {
	for _, c := range []struct {
		size int64
		err  error
		want string
	}{
		{42, nil, "ok 42"},
		{0, nil, "ok 0"},
		{3, &proto.Error{Code: proto.ErrNotFound, Message: "no such file"}, "error not_found: no such file"},
		{3, errors.New("disk full"), "error internal: disk full"},
	} {
		if got := fileStreamReason(c.size, c.err); got != c.want {
			t.Errorf("%d, %v: %q, want %q", c.size, c.err, got, c.want)
		}
	}
}

// A write's conn passes what is written to the tier's reader, ends it with CloseWrite, and aborts it with Close.
func TestFileConn(t *testing.T) {
	pr, pw := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	var c net.Conn = &fileConn{w: pw, cancel: cancel}
	go func() {
		_, _ = c.Write([]byte("hello "))
		_, _ = c.Write([]byte("world"))
		_ = c.(interface{ CloseWrite() error }).CloseWrite()
	}()
	got, err := io.ReadAll(pr)
	if err != nil || string(got) != "hello world" {
		t.Fatalf("%q, %v", got, err)
	}
	if ctx.Err() != nil {
		t.Fatal("the end of the input cancelled the write")
	}

	pr, pw = io.Pipe()
	ctx, cancel = context.WithCancel(context.Background())
	c = &fileConn{w: pw, cancel: cancel}
	go func() {
		_, _ = c.Write([]byte("part"))
		_ = c.Close()
	}()
	if _, err := io.ReadAll(pr); !errors.Is(err, errFileStreamAborted) {
		t.Fatalf("an aborted write read %v", err)
	}
	if ctx.Err() == nil {
		t.Fatal("an abort didn't cancel the write")
	}
	if _, err := c.Write([]byte("more")); err == nil {
		t.Fatal("a write after an abort was taken")
	}

	// A read's conn drops what Kantel sends on it, and its Close cancels the read.
	ctx, cancel = context.WithCancel(context.Background())
	c = &fileConn{cancel: cancel}
	if n, err := c.Write([]byte("x")); n != 1 || err != nil {
		t.Fatalf("%d, %v", n, err)
	}
	_ = c.Close()
	if ctx.Err() == nil {
		t.Fatal("closing a read didn't cancel it")
	}
}
