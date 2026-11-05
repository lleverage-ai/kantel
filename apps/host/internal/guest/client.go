package guest

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
	"github.com/lleverage-ai/kantel/apps/host/internal/vsock"
)

// Client talks to one guest's agent through Firecracker's vsock socket.
type Client struct {
	udsPath string
	http    *http.Client
}

func NewClient(udsPath string) *Client {
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		return vsock.Dial(ctx, udsPath, vsock.AgentPort)
	}
	return &Client{udsPath: udsPath, http: &http.Client{Transport: &http.Transport{DialContext: dial, MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second}}}
}

// Close drops idle connections (a VM about to be snapshotted or stopped).
func (c *Client) Close() { c.http.CloseIdleConnections() }

type apiError struct {
	Status  int
	Message string
}

func (e *apiError) Error() string { return fmt.Sprintf("guest agent %d: %s", e.Status, e.Message) }

// IsNotFound reports a 404 from the agent.
func IsNotFound(err error) bool {
	var api *apiError
	return errors.As(err, &api) && api.Status == 404
}

func (c *Client) do(ctx context.Context, method, path string, body io.Reader, out any) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, "http://guest"+path, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		return nil, refusal(res)
	}
	if out != nil {
		defer res.Body.Close()
		return res, json.NewDecoder(res.Body).Decode(out)
	}
	return res, nil
}

// refusal is the agent's answer of 300 or more as an apiError, with its JSON error or else its text. It closes the
// body.
func refusal(res *http.Response) error {
	defer res.Body.Close()
	var e struct {
		Error string `json:"error"`
	}
	raw, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(raw, &e)
	if e.Error == "" {
		e.Error = strings.TrimSpace(string(raw))
	}
	return &apiError{Status: res.StatusCode, Message: e.Error}
}

func jsonBody(v any) io.Reader {
	raw, _ := json.Marshal(v)
	return bytes.NewReader(raw)
}

// Health asks once.
func (c *Client) Health(ctx context.Context) (Health, error) {
	var h Health
	_, err := c.do(ctx, http.MethodGet, "/health", nil, &h)
	return h, err
}

// WaitReady polls Health until the agent answers or ctx ends.
func (c *Client) WaitReady(ctx context.Context) (Health, error) {
	for {
		attempt, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		h, err := c.Health(attempt)
		cancel()
		if err == nil {
			return h, nil
		}
		select {
		case <-ctx.Done():
			return Health{}, fmt.Errorf("guest agent never answered: %w", err)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// WaitFor polls Health until every service in want is ready.
func (c *Client) WaitFor(ctx context.Context, want ...string) (Health, error) {
	return c.waitFor(ctx, func(Health) []string { return want })
}

// WaitExpected polls Health until every service the image lists in its ReadyFile is ready, or every one in
// fallback when the image lists none.
func (c *Client) WaitExpected(ctx context.Context, fallback ...string) (Health, error) {
	return c.waitFor(ctx, func(h Health) []string {
		if len(h.Expect) > 0 {
			return h.Expect
		}
		return fallback
	})
}

func (c *Client) waitFor(ctx context.Context, wanted func(Health) []string) (Health, error) {
	for {
		h, err := c.WaitReady(ctx)
		if err != nil {
			return h, err
		}
		want := wanted(h)
		have := map[string]bool{}
		for _, r := range h.Ready {
			have[r] = true
		}
		missing := false
		for _, w := range want {
			if !have[w] {
				missing = true
			}
		}
		if !missing {
			return h, nil
		}
		select {
		case <-ctx.Done():
			return h, fmt.Errorf("guest services not ready (have %v, want %v)", h.Ready, want)
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// Capabilities asks the agent what its image has; nil (and no error) from an agent too old to say.
func (c *Client) Capabilities(ctx context.Context) (*proto.GuestCapabilities, error) {
	var out proto.GuestCapabilities
	if _, err := c.do(ctx, http.MethodGet, "/capabilities", nil, &out); err != nil {
		if IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return &out, nil
}

// Stats asks the agent for its disk and IO figures; an IsNotFound error from an agent too old to say.
func (c *Client) Stats(ctx context.Context) (Stats, error) {
	var out Stats
	_, err := c.do(ctx, http.MethodGet, "/stats", nil, &out)
	return out, err
}

func (c *Client) SetIdentity(ctx context.Context, id Identity) error {
	_, err := c.SetIdentitySteps(ctx, id)
	return err
}

// SetIdentitySteps is SetIdentity, answering how long the guest took over each part (ms; none from an older agent).
func (c *Client) SetIdentitySteps(ctx context.Context, id Identity) (map[string]float64, error) {
	var out struct {
		StepsMs map[string]float64 `json:"stepsMs"`
	}
	_, err := c.do(ctx, http.MethodPost, "/identity", jsonBody(id), &out)
	return out.StepsMs, err
}

// GrowDisk grows the file system on the sandbox's disk (/dev/vdb) to fill the device, online, after the host made the
// device bytes long: the agent first waits until the guest kernel sees that capacity. An older agent answers 404
// (IsNotFound).
func (c *Client) GrowDisk(ctx context.Context, bytes int64) error {
	_, err := c.do(ctx, http.MethodPost, "/disk/grow?bytes="+strconv.FormatInt(bytes, 10), nil, &map[string]any{})
	return err
}

// Mount makes the guest's read-only mounts the specs (an empty list unmounts them all).
func (c *Client) Mount(ctx context.Context, specs []MountSpec) ([]MountResult, error) {
	if specs == nil {
		specs = []MountSpec{}
	}
	var out []MountResult
	_, err := c.do(ctx, http.MethodPost, "/mounts", jsonBody(specs), &out)
	return out, err
}

func (c *Client) Sync(ctx context.Context) error {
	_, err := c.do(ctx, http.MethodPost, "/sync", nil, &map[string]any{})
	return err
}

func (c *Client) Exec(ctx context.Context, req ExecRequest) (ExecResult, error) {
	req.Stream = false
	var out ExecResult
	_, err := c.do(ctx, http.MethodPost, "/exec", jsonBody(req), &out)
	return out, err
}

// ExecStream runs a command and calls onEvent for each line until its exit.
func (c *Client) ExecStream(ctx context.Context, req ExecRequest, onEvent func(ExecEvent) error) error {
	req.Stream = true
	res, err := c.do(ctx, http.MethodPost, "/exec", jsonBody(req), nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var event ExecEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			return err
		}
		if err := onEvent(event); err != nil {
			return err
		}
		if event.Exit != nil || event.Error != "" {
			return nil
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return errors.New("command stream ended without an exit")
}

// ReadFile reads the file at path, or with a length, at most length bytes of it from offset. It answers the bytes,
// the file's mode and the whole file's size.
func (c *Client) ReadFile(ctx context.Context, path string, offset, length int64) ([]byte, uint32, int64, error) {
	q := url.Values{"path": {path}}
	if length > 0 {
		q.Set("offset", strconv.FormatInt(offset, 10))
		q.Set("length", strconv.FormatInt(length, 10))
	}
	res, err := c.do(ctx, http.MethodGet, "/files?"+q.Encode(), nil, nil)
	if err != nil {
		return nil, 0, 0, err
	}
	defer res.Body.Close()
	mode, _ := strconv.ParseUint(res.Header.Get("x-file-mode"), 8, 32)
	if length <= 0 {
		raw, err := io.ReadAll(res.Body)
		return raw, uint32(mode), int64(len(raw)), err
	}
	if header := res.Header.Get("x-file-size"); header != "" {
		size, err := strconv.ParseInt(header, 10, 64)
		if err != nil {
			return nil, 0, 0, fmt.Errorf("guest agent: x-file-size %q", header)
		}
		raw, err := io.ReadAll(io.LimitReader(res.Body, length))
		return raw, uint32(mode), size, err
	}
	// A guest agent from before ranged reads (in an older image) sends the whole file: skip to offset and keep length,
	// without holding the rest.
	skipped, err := io.CopyN(io.Discard, res.Body, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, 0, 0, err
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, length))
	if err != nil {
		return nil, 0, 0, err
	}
	size := res.ContentLength
	if size < 0 {
		rest, err := io.Copy(io.Discard, res.Body)
		if err != nil {
			return nil, 0, 0, err
		}
		size = skipped + int64(len(raw)) + rest
	}
	return raw, uint32(mode), size, nil
}

func (c *Client) WriteFile(ctx context.Context, path string, data []byte, mode uint32) error {
	q := url.Values{"path": {path}}
	if mode != 0 {
		q.Set("mode", strconv.FormatUint(uint64(mode), 8))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://guest/files?"+q.Encode(), bytes.NewReader(data))
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		raw, _ := io.ReadAll(res.Body)
		return &apiError{Status: res.StatusCode, Message: strings.TrimSpace(string(raw))}
	}
	return nil
}

// ReadFileStream opens the whole file at path to be read as the guest sends it, so a large file is never held in the
// host's memory. It answers the body (the caller closes it), the file's size and its mode; a missing file is the
// agent's 404, as ReadFile's is (IsNotFound).
func (c *Client) ReadFileStream(ctx context.Context, path string) (io.ReadCloser, int64, uint32, error) {
	res, err := c.do(ctx, http.MethodGet, "/files?"+url.Values{"path": {path}}.Encode(), nil, nil)
	if err != nil {
		return nil, 0, 0, err
	}
	mode, _ := strconv.ParseUint(res.Header.Get("x-file-mode"), 8, 32)
	size := res.ContentLength
	if header := res.Header.Get("x-file-size"); size < 0 && header != "" {
		if size, err = strconv.ParseInt(header, 10, 64); err != nil {
			res.Body.Close()
			return nil, 0, 0, fmt.Errorf("guest agent: x-file-size %q", header)
		}
	}
	if size < 0 {
		// The size is answered before the first byte is sent on, so a read without one can't be streamed.
		res.Body.Close()
		return nil, 0, 0, errors.New("guest agent: a file read answered without its size")
	}
	return res.Body, size, uint32(mode), nil
}

// WriteFileStream writes what r gives to the file at path as it comes, with mode (0 is the agent's default, 0644). The
// agent writes beside the file and renames it into place only once the body has ended, so a read error from r (or a
// cancelled ctx) leaves the file as it was. It answers the size the agent wrote.
func (c *Client) WriteFileStream(ctx context.Context, path string, r io.Reader, mode uint32) (int64, error) {
	q := url.Values{"path": {path}}
	if mode != 0 {
		q.Set("mode", strconv.FormatUint(uint64(mode), 8))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://guest/files?"+q.Encode(), r)
	if err != nil {
		return 0, err
	}
	// Unknown until the last byte has come: the body goes chunked, and only a body that ended properly is complete.
	req.ContentLength = -1
	res, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	if res.StatusCode >= 300 {
		return 0, refusal(res)
	}
	defer res.Body.Close()
	var out struct {
		Size int64 `json:"size"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return 0, fmt.Errorf("guest agent: a write's answer: %w", err)
	}
	return out.Size, nil
}

// ExtractArchive has the agent extract the tar at archive into the directory target with its own code (ExtractTar),
// then delete the tar. An archive it won't extract is the agent's 400 (IsRefused); an agent from before it, 404 or
// 405 (IsUnknownRoute).
func (c *Client) ExtractArchive(ctx context.Context, archive, target string) error {
	q := url.Values{"archive": {archive}, "target": {target}}
	res, err := c.do(ctx, http.MethodPost, "/files/extract?"+q.Encode(), nil, nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

// IsRefused reports a 400 from the agent: what it was asked can't be done as asked.
func IsRefused(err error) bool {
	var api *apiError
	return errors.As(err, &api) && api.Status == 400
}

// IsConflict reports a 409 from the agent (a command ID already known).
func IsConflict(err error) bool {
	var api *apiError
	return errors.As(err, &api) && api.Status == 409
}

// IsUnknownRoute reports the agent not serving what it was asked for at all: one from before it.
func IsUnknownRoute(err error) bool {
	var api *apiError
	return errors.As(err, &api) && (api.Status == 404 || api.Status == 405)
}

// RefusalMessage is the agent's own words for a refusal, without the status.
func RefusalMessage(err error) string {
	var api *apiError
	if errors.As(err, &api) {
		return api.Message
	}
	return err.Error()
}

func (c *Client) DeleteFile(ctx context.Context, path string, recursive bool) error {
	q := url.Values{"path": {path}}
	if recursive {
		q.Set("recursive", "true")
	}
	_, err := c.do(ctx, http.MethodDelete, "/files?"+q.Encode(), nil, &map[string]any{})
	return err
}

func (c *Client) ListFiles(ctx context.Context, path string) ([]FileEntry, error) {
	var out struct {
		Entries []FileEntry `json:"entries"`
	}
	_, err := c.do(ctx, http.MethodGet, "/files/list?path="+url.QueryEscape(path), nil, &out)
	return out.Entries, err
}

// DialPort opens a byte stream to a TCP port on the guest's loopback.
func (c *Client) DialPort(ctx context.Context, port int) (net.Conn, error) {
	conn, err := vsock.Dial(ctx, c.udsPath, vsock.AgentPort)
	if err != nil {
		return nil, err
	}
	// Until the upgrade is answered, a cancelled ctx closes the socket, so a guest that never answers can't hold the
	// dial (and what waits on it, such as the sandbox's delete) open. stop disarms it for the stream that's returned.
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	fmt.Fprintf(conn, "GET /ports/%d HTTP/1.1\r\nHost: guest\r\nConnection: Upgrade\r\nUpgrade: %s\r\n\r\n", port, PortUpgrade)
	reader := bufio.NewReader(conn)
	res, err := http.ReadResponse(reader, nil)
	if err != nil {
		stop()
		conn.Close()
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return nil, err
	}
	if res.StatusCode != http.StatusSwitchingProtocols {
		// Still armed while the refusal's body is read, which a guest could withhold too.
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		stop()
		conn.Close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &apiError{Status: res.StatusCode, Message: strings.TrimSpace(string(raw))}
	}
	if !stop() {
		conn.Close()
		return nil, ctx.Err()
	}
	if reader.Buffered() > 0 {
		return &readerConn{Conn: conn, reader: reader}, nil
	}
	return conn, nil
}

type readerConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *readerConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

// StartCommand runs req (with its ID) in the background (POST /exec/start) and answers its pid. A guest from before
// detached commands by ID answers IsUnknownRoute.
func (c *Client) StartCommand(ctx context.Context, req ExecRequest) (ExecResult, error) {
	req.Stream, req.Detached = false, false
	var out ExecResult
	_, err := c.do(ctx, http.MethodPost, "/exec/start", jsonBody(req), &out)
	return out, err
}

// CommandStatus is a command's state by its ID (GET /exec/{id}), waiting up to wait for a running one to end. A
// command the guest doesn't know is IsNotFound.
func (c *Client) CommandStatus(ctx context.Context, id string, wait time.Duration) (ExecStatus, error) {
	var out ExecStatus
	path := "/exec/" + url.PathEscape(id)
	if wait > 0 {
		path += "?waitMs=" + strconv.FormatInt(wait.Milliseconds(), 10)
	}
	_, err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

// KillCommand kills a command by its ID and its process group (POST /exec/{id}/kill), saying whether it was running.
// A command the guest doesn't know is IsNotFound; a guest from before kills answers IsUnknownRoute.
func (c *Client) KillCommand(ctx context.Context, id string) (bool, error) {
	var out struct {
		Killed bool `json:"killed"`
	}
	_, err := c.do(ctx, http.MethodPost, "/exec/"+url.PathEscape(id)+"/kill", nil, &out)
	return out.Killed, err
}
