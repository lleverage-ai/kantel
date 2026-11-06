package guest

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// clientFor is a Client that reaches handler over TCP rather than a VM's vsock.
func clientFor(t *testing.T, handler http.Handler) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", srv.Listener.Addr().String())
	}
	return &Client{http: &http.Client{Transport: &http.Transport{DialContext: dial}}}
}

func testFile(t *testing.T, size int) (string, []byte) {
	t.Helper()
	content := make([]byte, size)
	for i := range content {
		content[i] = byte(i * 7)
	}
	path := filepath.Join(t.TempDir(), "big.bin")
	if err := os.WriteFile(path, content, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o640); err != nil { // whatever the umask
		t.Fatal(err)
	}
	return path, content
}

func TestReadFileRanges(t *testing.T) {
	path, content := testFile(t, 3000)
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()

	whole, mode, size, err := client.ReadFile(ctx, path, 0, 0)
	if err != nil || !bytes.Equal(whole, content) || size != 3000 || mode != 0o640 {
		t.Fatalf("whole file: %d bytes, mode %o, size %d, %v", len(whole), mode, size, err)
	}
	for _, c := range []struct{ offset, length, want int64 }{
		{0, 1024, 1024},
		{1024, 1024, 1024},
		{2048, 1024, 952}, // the last part is short
		{3000, 1024, 0},   // at the end
		{5000, 1024, 0},   // past it
	} {
		part, _, size, err := client.ReadFile(ctx, path, c.offset, c.length)
		if err != nil {
			t.Fatalf("offset %d: %v", c.offset, err)
		}
		start := min(c.offset, 3000)
		if size != 3000 || int64(len(part)) != c.want || !bytes.Equal(part, content[start:start+c.want]) {
			t.Fatalf("offset %d length %d: %d bytes of a %d-byte file, want %d", c.offset, c.length, len(part), size, c.want)
		}
	}
	if _, _, _, err := client.ReadFile(ctx, filepath.Join(filepath.Dir(path), "missing"), 0, 10); !IsNotFound(err) {
		t.Fatalf("a missing file: %v", err)
	}
}

// A guest agent from before ranged reads ignores offset and length and sends the whole file; the client still answers
// only the range, and the file's size from content-length.
func TestReadFileRangeFromAnOlderAgent(t *testing.T) {
	path, content := testFile(t, 3000)
	older := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-length", strconv.Itoa(len(content)))
		w.Header().Set("x-file-mode", "640")
		_, _ = w.Write(content)
	})
	client := clientFor(t, older)
	part, mode, size, err := client.ReadFile(context.Background(), path, 1000, 500)
	if err != nil || size != 3000 || mode != 0o640 || !bytes.Equal(part, content[1000:1500]) {
		t.Fatalf("%d bytes, mode %o, size %d, %v", len(part), mode, size, err)
	}
	tail, _, size, err := client.ReadFile(context.Background(), path, 2900, 500)
	if err != nil || size != 3000 || !bytes.Equal(tail, content[2900:]) {
		t.Fatalf("the tail: %d bytes, size %d, %v", len(tail), size, err)
	}
}

// A file of several megabytes goes both ways as it comes: written from a reader of unknown length (so the body is
// chunked), renamed into place, then read back whole with its size and mode.
func TestFileStreamsRoundTrip(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	ctx := context.Background()
	content := make([]byte, 6<<20+123)
	for i := range content {
		content[i] = byte(i * 31)
	}
	path := filepath.Join(t.TempDir(), "dir", "big.bin")
	// A pipe, so the client can't know the length up front, as with a stream from the control plane.
	pr, pw := io.Pipe()
	go func() {
		for rest := content; len(rest) > 0; {
			n := min(len(rest), 100_000)
			if _, err := pw.Write(rest[:n]); err != nil {
				return
			}
			rest = rest[n:]
		}
		pw.Close()
	}()
	n, err := client.WriteFileStream(ctx, path, pr, 0o640)
	if err != nil || n != int64(len(content)) {
		t.Fatalf("write: %d bytes, %v", n, err)
	}
	if names, err := os.ReadDir(filepath.Dir(path)); err != nil || len(names) != 1 {
		t.Fatalf("a temporary file was left: %d entries, %v", len(names), err)
	}
	body, size, mode, err := client.ReadFileStream(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	got, err := io.ReadAll(body)
	if err != nil || size != int64(len(content)) || mode != 0o640 || !bytes.Equal(got, content) {
		t.Fatalf("read: %d bytes, size %d, mode %o, %v", len(got), size, mode, err)
	}
}

func TestReadFileStreamOfAMissingFile(t *testing.T) {
	client := clientFor(t, (&Server{}).Handler())
	body, _, _, err := client.ReadFileStream(context.Background(), filepath.Join(t.TempDir(), "missing"))
	if !IsNotFound(err) || body != nil {
		t.Fatalf("a missing file: %v", err)
	}
}

// A write whose sender fails part-way (the control plane's stream aborted) leaves the file as it was: the body never
// ends properly, so the agent never renames what it got into place.
func TestAnAbortedFileStreamLeavesTheFile(t *testing.T) {
	path, content := testFile(t, 3000)
	client := clientFor(t, (&Server{}).Handler())
	pr, pw := io.Pipe()
	go func() {
		_, _ = pw.Write(bytes.Repeat([]byte("x"), 1<<20))
		pw.CloseWithError(errors.New("the sender went away"))
	}()
	if _, err := client.WriteFileStream(context.Background(), path, pr, 0); err == nil {
		t.Fatal("an aborted write succeeded")
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("the file changed: %d bytes, %v", len(got), err)
	}
}

func TestReadFileRefusesABadRange(t *testing.T) {
	path, _ := testFile(t, 10)
	srv := httptest.NewServer((&Server{}).Handler())
	defer srv.Close()
	res, err := http.Get(srv.URL + "/files?path=" + path + "&offset=-1&length=5")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("a negative offset: %d", res.StatusCode)
	}
}

func TestWriteFileMakesItsDirectories(t *testing.T) {
	root := t.TempDir()
	client := clientFor(t, (&Server{}).Handler())
	path := filepath.Join(root, "repo", "apps", "app", "x.txt")
	if err := client.WriteFile(context.Background(), path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "x" {
		t.Fatalf("read back %q, %v", got, err)
	}
	// Writable by whoever the file is, so a command beside it (pnpm install, a part join) can add files there.
	for _, dir := range []string{"repo", "repo/apps", "repo/apps/app"} {
		info, err := os.Stat(filepath.Join(root, dir))
		if err != nil || !info.IsDir() {
			t.Fatalf("%s: %v, %v", dir, info, err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "repo", "apps", "app", "y"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
}
