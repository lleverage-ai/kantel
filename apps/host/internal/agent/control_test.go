package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

type fakeSandboxes []proto.SandboxInfo

func (f fakeSandboxes) List() []proto.SandboxInfo { return f }

func (f fakeSandboxes) Sandbox(id string) (proto.SandboxInfo, error) {
	for _, s := range f {
		if s.ID == id {
			return s, nil
		}
	}
	return proto.SandboxInfo{}, &proto.Error{Code: proto.ErrNotFound, Message: "no sandbox " + id + " on this host"}
}

func unixClient(path string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}}}
}

// The control socket lists the host's sandboxes and shows one, and answers nothing that changes them.
func TestControlSocketReadsOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run", "agent.sock")
	sandboxes := fakeSandboxes{{ID: "sb_1", Tier: "microvm", State: proto.StateRunning}, {ID: "sb_2", Tier: "isolate", State: proto.StateStopped}}
	stop, err := ServeControl(path, sandboxes, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	c := unixClient(path)
	get := func(method, p string) (int, string) {
		req, _ := http.NewRequest(method, "http://host"+p, strings.NewReader("{}"))
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	code, body := get("GET", "/sandboxes")
	var list []proto.SandboxInfo
	if code != 200 || json.Unmarshal([]byte(body), &list) != nil || len(list) != 2 || list[1].ID != "sb_2" {
		t.Fatalf("list: %d %s", code, body)
	}
	code, body = get("GET", "/sandboxes/sb_2")
	var one proto.SandboxInfo
	if code != 200 || json.Unmarshal([]byte(body), &one) != nil || one.State != proto.StateStopped {
		t.Fatalf("get: %d %s", code, body)
	}
	if code, body = get("GET", "/sandboxes/sb_9"); code != 404 || !strings.Contains(body, `"not_found"`) {
		t.Fatalf("missing: %d %s", code, body)
	}
	for _, p := range []string{"/call/sandbox.stop", "/call/sandbox.delete", "/sandboxes/sb_1"} {
		if code, _ := get("POST", p); code == 200 {
			t.Errorf("POST %s answered 200", p)
		}
	}
	if code, _ := get("GET", "/port/sb_1/80"); code != 404 {
		t.Errorf("port: %d", code)
	}

	fi, err := os.Stat(path)
	if err != nil || fi.Mode()&os.ModeSocket == 0 || fi.Mode().Perm() != 0o600 {
		t.Fatalf("socket: %v %v", fi.Mode(), err)
	}
	if di, _ := os.Stat(filepath.Dir(path)); di.Mode().Perm() != 0o700 {
		t.Errorf("directory: %v", di.Mode())
	}
	stop()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Errorf("socket left after stop: %v", err)
	}
}

// A socket left by a daemon that died is replaced; one another daemon answers on, or a file that isn't a socket, isn't.
func TestControlSocketStaleAndLive(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.DiscardHandler)

	stale := filepath.Join(dir, "stale.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: stale, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	ln.SetUnlinkOnClose(false)
	ln.Close()
	stop, err := ServeControl(stale, fakeSandboxes{}, log)
	if err != nil {
		t.Fatalf("stale socket not replaced: %v", err)
	}
	if _, err := ServeControl(stale, fakeSandboxes{}, log); err == nil || !strings.Contains(err.Error(), "another kantel-host") {
		t.Errorf("a live socket was taken over: %v", err)
	}
	if resp, err := unixClient(stale).Get("http://host/sandboxes"); err != nil || resp.StatusCode != 200 {
		t.Errorf("the first daemon stopped answering: %v", err)
	}
	stop()

	file := filepath.Join(dir, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ServeControl(file, fakeSandboxes{}, log); err == nil {
		t.Error("a regular file was replaced")
	}
}

// A directory others may write to, or a symlink to one, isn't taken for the socket: a name in it could be swapped
// between the bind, the chmod and the rename.
func TestControlSocketRefusesUnsafeDirectory(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	shared := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(shared, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(shared, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := ServeControl(filepath.Join(shared, "agent.sock"), fakeSandboxes{}, log); err == nil || !strings.Contains(err.Error(), "writable by others") {
		t.Fatalf("a world-writable directory: want refused, got %v", err)
	}
	private := filepath.Join(t.TempDir(), "private")
	if err := os.Mkdir(private, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(private, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ServeControl(filepath.Join(link, "agent.sock"), fakeSandboxes{}, log); err == nil || !strings.Contains(err.Error(), "isn't a directory") {
		t.Fatalf("a symlinked directory: want refused, got %v", err)
	}
	stop, err := ServeControl(filepath.Join(private, "agent.sock"), fakeSandboxes{}, log)
	if err != nil {
		t.Fatalf("a private directory: %v", err)
	}
	stop()
}
