package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/lleverage-ai/kantel/apps/host/internal/proto"
)

// LocalHandler serves the host's calls over plain HTTP, for tests and for running a host with no control plane:
//
//	POST /call/<method>        body: the call's params; answer: its result, or {"error": {...}}
//	GET  /facts, /capacity
//	GET  /usage                the newest usage sample (404 until the host has one)
//	GET  /port/<sandbox>/<port> (Upgrade: tcp)  a raw stream to the sandbox's port
//
// It has no authentication: listen on loopback only.
func (h *Host) LocalHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /call/{method}", func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if len(raw) == 0 {
			raw = []byte("{}")
		}
		result, err := h.Call(r.Context(), r.PathValue("method"), raw, nil)
		writeResult(w, result, err)
	})
	mux.HandleFunc("GET /facts", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(h.Facts())
	})
	mux.HandleFunc("GET /capacity", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(h.Capacity())
	})
	mux.HandleFunc("GET /usage", func(w http.ResponseWriter, _ *http.Request) {
		sample, ok := h.LatestUsage()
		if !ok {
			http.Error(w, "no usage sample yet", 404)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(sample)
	})
	mux.HandleFunc("GET /port/{sandbox}/{port}", func(w http.ResponseWriter, r *http.Request) {
		port, err := strconv.Atoi(r.PathValue("port"))
		if err != nil || !strings.EqualFold(r.Header.Get("Upgrade"), "tcp") {
			http.Error(w, "want Upgrade: tcp and a port", 400)
			return
		}
		conn, err := h.DialPort(r.Context(), r.PathValue("sandbox"), port)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			conn.Close()
			http.Error(w, "can't hijack", 500)
			return
		}
		client, buf, err := hj.Hijack()
		if err != nil {
			conn.Close()
			return
		}
		_, _ = io.WriteString(client, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: tcp\r\nConnection: Upgrade\r\n\r\n")
		if n := buf.Reader.Buffered(); n > 0 {
			pending, _ := buf.Reader.Peek(n)
			_, _ = conn.Write(pending)
		}
		splice(client, conn)
	})
	return mux
}

// writeResult answers with a call's result, or with {"error": {...}} and the status its code maps to.
func writeResult(w http.ResponseWriter, result any, err error) {
	w.Header().Set("content-type", "application/json")
	if err != nil {
		pe := toError(err)
		status := 500
		switch pe.Code {
		case proto.ErrNotFound:
			status = 404
		case proto.ErrInvalid:
			status = 400
		case proto.ErrConflict:
			status = 409
		case proto.ErrUnsupported:
			status = 501
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": pe})
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}

// SandboxReader is what the control socket answers from: the sandboxes a host holds. *Host is one.
type SandboxReader interface {
	List() []proto.SandboxInfo
	Sandbox(id string) (proto.SandboxInfo, error)
}

// Sandbox is one sandbox on the host, as sandbox.get answers it.
func (h *Host) Sandbox(id string) (proto.SandboxInfo, error) {
	t, err := h.tierOf(id)
	if err != nil {
		return proto.SandboxInfo{}, err
	}
	return t.Get(id)
}

// ControlHandler is the control socket's API, for an operator on the machine (`kantel-host sandboxes`):
//
//	GET /sandboxes        every sandbox on the host, as sandbox.list answers
//	GET /sandboxes/{id}   one, as sandbox.get answers (404 with {"error": {...}} when the host has no such sandbox)
//
// It only reads. Sandboxes are stopped and deleted through Kantel, which is their record: one stopped here would
// still be running as far as the control plane knew. So there is no /call and no port streams, as LocalHandler has.
func ControlHandler(r SandboxReader) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /sandboxes", func(w http.ResponseWriter, _ *http.Request) {
		writeResult(w, r.List(), nil)
	})
	mux.HandleFunc("GET /sandboxes/{id}", func(w http.ResponseWriter, req *http.Request) {
		info, err := r.Sandbox(req.PathValue("id"))
		writeResult(w, info, err)
	})
	return mux
}

// ServeControl serves ControlHandler on the Unix socket at path until stop is called, which closes it and removes the
// socket. The socket is 0600 and its directory, made if missing, 0700; a connection from anyone but root or the
// daemon's own user is closed unanswered as well. A stale socket left by a daemon that died is replaced, but one
// another daemon still answers on is not. It returns once the socket is listening, or with why it couldn't be.
func ServeControl(path string, r SandboxReader, log *slog.Logger) (stop func(), err error) {
	ln, err := listenControl(path)
	if err != nil {
		return nil, err
	}
	srv := &http.Server{Handler: ControlHandler(r), ReadHeaderTimeout: 10 * time.Second}
	ours, _ := os.Lstat(path)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("control socket", "error", err)
		}
	}()
	return func() {
		_ = srv.Close()
		// Removed only if it is still ours: a daemon started since may have put its own there.
		if now, err := os.Lstat(path); err == nil && ours != nil && os.SameFile(ours, now) {
			_ = os.Remove(path)
		}
	}, nil
}

func listenControl(path string) (net.Listener, error) {
	dir := filepath.Dir(path)
	if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	if err := safeSocketDir(dir); err != nil {
		return nil, err
	}
	if fi, err := os.Lstat(path); err == nil {
		if fi.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("%s is there and isn't a socket", path)
		}
		if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
			c.Close()
			return nil, fmt.Errorf("another kantel-host answers on %s", path)
		}
	}
	// Bound at a name of its own, made 0600, then moved into place, so the socket is never at path with looser
	// permissions, and a stale one is replaced in the same step.
	tmp := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	_ = os.Remove(tmp)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: tmp, Net: "unix"})
	if err != nil {
		return nil, err
	}
	ln.SetUnlinkOnClose(false)
	if err := os.Chmod(tmp, 0o600); err != nil {
		ln.Close()
		_ = os.Remove(tmp)
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		ln.Close()
		_ = os.Remove(tmp)
		return nil, err
	}
	return peerListener{ln}, nil
}

// safeSocketDir refuses a directory someone else could change names in: the socket is bound, chmodded and renamed by
// name, so in a directory another user may write to they could swap a symlink in between and have root chmod or
// replace a file of their choosing. It must be a real directory (not a symlink), owned by root or the daemon's user,
// and writable by no one else.
func safeSocketDir(dir string) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s isn't a directory (a symlink to one isn't taken either)", dir)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("can't tell who owns %s", dir)
	}
	if st.Uid != 0 && int(st.Uid) != os.Getuid() {
		return fmt.Errorf("%s belongs to another user (uid %d): put the control socket in a directory of root's", dir, st.Uid)
	}
	if fi.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%s is writable by others (%s): put the control socket in a directory only root can write to", dir, fi.Mode().Perm())
	}
	return nil
}

// peerListener closes connections from anyone but root or the daemon's own user, whatever the socket's permissions.
type peerListener struct{ *net.UnixListener }

func (l peerListener) Accept() (net.Conn, error) {
	for {
		c, err := l.AcceptUnix()
		if err != nil {
			return nil, err
		}
		if peerAllowed(c) {
			return c, nil
		}
		c.Close()
	}
}

func peerAllowed(c *net.UnixConn) bool {
	raw, err := c.SyscallConn()
	if err != nil {
		return false
	}
	var cred *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil || credErr != nil {
		return false
	}
	return cred.Uid == 0 || int(cred.Uid) == os.Getuid()
}

func splice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if c, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		} else {
			_ = dst.Close()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	<-done
	a.Close()
	b.Close()
}
