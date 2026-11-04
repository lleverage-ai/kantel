package guest

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
)

// Server is the guest agent's HTTP handler.
type Server struct {
	Version string

	mu       sync.Mutex
	identity *Identity
	// upstream is the host proxy LocalProxyAddr forwards to (a string, host:port or "").
	upstream atomic.Value
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /identity", s.setIdentity)
	mux.HandleFunc("POST /exec", s.exec)
	mux.HandleFunc("POST /sync", s.sync)
	mux.HandleFunc("GET /files", s.readFile)
	mux.HandleFunc("PUT /files", s.writeFile)
	mux.HandleFunc("DELETE /files", s.deleteFile)
	mux.HandleFunc("GET /files/list", s.listFiles)
	mux.HandleFunc("POST /files/extract", s.extractArchive)
	mux.HandleFunc("GET /ports/{port}", s.port)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func fail(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	boot, _ := os.ReadFile("/proc/sys/kernel/random/boot_id")
	uptimeRaw, _ := os.ReadFile("/proc/uptime")
	uptime, _ := strconv.ParseFloat(strings.Fields(string(uptimeRaw) + " 0")[0], 64)
	var ready []string
	for name, port := range map[string]int{"ssh": PortSSH, "desktop": PortDesktop, "browser": PortBrowser, "stream": PortStream, "isolate": PortIsolate} {
		if conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 50*time.Millisecond); err == nil {
			conn.Close()
			ready = append(ready, name)
		}
	}
	if _, err := os.Stat("/run/docker.sock"); err == nil {
		ready = append(ready, "docker")
	}
	sort.Strings(ready)
	raw, _ := os.ReadFile(ReadyFile)
	expect := parseReady(string(raw))
	s.mu.Lock()
	id := ""
	if s.identity != nil {
		id = s.identity.SandboxID
	}
	s.mu.Unlock()
	writeJSON(w, 200, Health{OK: true, BootID: strings.TrimSpace(string(boot)), Uptime: uptime, Identity: id, Version: s.Version, Ready: ready, Expect: expect})
}

// parseReady reads a ReadyFile: one service per line; blank lines and # comments are skipped.
func parseReady(raw string) []string {
	var names []string
	for _, line := range strings.Split(raw, "\n") {
		if name := strings.TrimSpace(line); name != "" && !strings.HasPrefix(name, "#") {
			names = append(names, name)
		}
	}
	return names
}

// writeHostKey makes an ed25519 SSH host key in OpenSSH's format, without a process for ssh-keygen.
func writeHostKey(path, comment string) error {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	block, err := ssh.MarshalPrivateKey(priv, comment)
	if err != nil {
		return err
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		return err
	}
	line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub)))
	return os.WriteFile(path+".pub", []byte(line+" "+comment+"\n"), 0o644)
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (s *Server) setIdentity(w http.ResponseWriter, r *http.Request) {
	var id Identity
	if err := json.NewDecoder(r.Body).Decode(&id); err != nil {
		fail(w, 400, err)
		return
	}
	if err := applyIdentity(&id); err != nil {
		fail(w, 500, err)
		return
	}
	s.mu.Lock()
	s.identity = &id
	s.mu.Unlock()
	s.upstream.Store(proxyUpstream(id.ProxyEnv))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func applyIdentity(id *Identity) error {
	if id.Entropy != "" {
		if raw, err := base64.StdEncoding.DecodeString(id.Entropy); err == nil {
			_ = addEntropy(raw)
		}
	}
	if id.UnixTimeMs > 0 {
		tv := syscall.NsecToTimeval(id.UnixTimeMs * int64(time.Millisecond))
		_ = syscall.Settimeofday(&tv)
	}
	if id.Hostname != "" {
		_ = syscall.Sethostname([]byte(id.Hostname))
		_ = os.WriteFile("/etc/hostname", []byte(id.Hostname+"\n"), 0o644)
		_ = os.WriteFile("/etc/hosts", []byte(fmt.Sprintf("127.0.0.1 localhost\n127.0.1.1 %s\n::1 localhost ip6-localhost ip6-loopback\n", id.Hostname)), 0o644)
	}
	if id.Address != "" {
		// One ip process for the lot: each process costs milliseconds in a just-restored VM.
		batch := "link set eth0 up\naddr flush dev eth0\naddr add " + id.Address + " dev eth0\n"
		if id.Gateway != "" {
			batch += "route replace default via " + id.Gateway + "\n"
		}
		cmd := exec.Command("ip", "-batch", "-")
		cmd.Stdin = strings.NewReader(batch)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("ip: %v: %s", err, strings.TrimSpace(string(out)))
		}
	}
	if len(id.DNS) > 0 {
		var b strings.Builder
		for _, server := range id.DNS {
			fmt.Fprintf(&b, "nameserver %s\n", server)
		}
		_ = os.Remove("/etc/resolv.conf")
		_ = os.WriteFile("/etc/resolv.conf", []byte(b.String()), 0o644)
	}
	if err := os.MkdirAll("/etc/kantel", 0o755); err != nil {
		return err
	}
	if len(id.ProxyEnv) > 0 {
		var b strings.Builder
		keys := make([]string, 0, len(id.ProxyEnv))
		for k := range id.ProxyEnv {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(&b, "%s=%s\n", k, id.ProxyEnv[k])
		}
		_ = os.WriteFile("/etc/kantel/proxy.env", []byte(b.String()), 0o644)
	} else {
		_ = os.Remove("/etc/kantel/proxy.env")
	}
	if id.CACert != "" {
		_ = os.WriteFile("/usr/local/share/ca-certificates/kantel-egress.crt", []byte(id.CACert), 0o644)
		_ = run("update-ca-certificates")
	}
	if id.Fresh {
		machineID := make([]byte, 16)
		_, _ = rand.Read(machineID)
		_ = os.WriteFile("/etc/machine-id", []byte(hex.EncodeToString(machineID)+"\n"), 0o444)
		for _, f := range []string{"/etc/ssh/ssh_host_ed25519_key", "/etc/ssh/ssh_host_ed25519_key.pub", "/etc/ssh/ssh_host_rsa_key", "/etc/ssh/ssh_host_rsa_key.pub", "/etc/ssh/ssh_host_ecdsa_key", "/etc/ssh/ssh_host_ecdsa_key.pub"} {
			_ = os.Remove(f)
		}
		if err := writeHostKey("/etc/ssh/ssh_host_ed25519_key", id.Hostname); err != nil {
			return err
		}
		// sshd fails to start with no host keys (a template, a fresh clone), so restart rather than try-restart, which
		// leaves a failed unit alone.
		if err := run("systemctl", "restart", "--no-block", "ssh.service"); err != nil {
			return err
		}
	}
	if id.SSHAuthorizedKeys != nil {
		if err := os.MkdirAll("/home/user/.ssh", 0o700); err == nil {
			_ = os.WriteFile("/home/user/.ssh/authorized_keys", []byte(strings.Join(id.SSHAuthorizedKeys, "\n")+"\n"), 0o600)
			_ = os.Chown("/home/user/.ssh", 1000, 1000)
			_ = os.Chown("/home/user/.ssh/authorized_keys", 1000, 1000)
		}
	}
	writeEnv(envFile, id.Env)
	// dockerd and Chromium use LocalProxyAddr, which follows the identity's proxy, so nothing restarts here: a restart
	// would stop a resumed or forked sandbox's containers and close its tabs (and, as a restored sandbox's monotonic
	// clock carries on from its template's, soon trips systemd's start limit).
	return nil
}

// addEntropy mixes bytes into the kernel's pool and credits them (RNDADDENTROPY).
func addEntropy(raw []byte) error {
	f, err := os.OpenFile("/dev/urandom", os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(raw)
	return err
}

func (s *Server) sync(w http.ResponseWriter, _ *http.Request) {
	syscall.Sync()
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// envFile holds the sandbox's own variables, which every command gets.
const envFile = "/etc/kantel/env"

// writeEnv makes path hold exactly env: an identity's Env is the sandbox's whole environment (the host resolves a
// fork's inheritance before it sends one), so an empty one leaves none, not what the disk had from its source.
func writeEnv(path string, env map[string]string) {
	if len(env) == 0 {
		_ = os.Remove(path)
		return
	}
	var b strings.Builder
	for k, v := range env {
		fmt.Fprintf(&b, "%s=%s\n", k, strconv.Quote(v))
	}
	_ = os.WriteFile(path, []byte(b.String()), 0o644)
}

func (s *Server) commandEnv(req *ExecRequest, home string, username string) []string {
	env := map[string]string{
		"PATH":  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME":  home,
		"USER":  username,
		"LANG":  "C.UTF-8",
		"TERM":  "xterm-256color",
		"SHELL": "/bin/bash",
	}
	if raw, err := os.ReadFile("/etc/kantel/proxy.env"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if k, v, ok := strings.Cut(line, "="); ok && k != "" {
				env[k] = v
			}
		}
	}
	if raw, err := os.ReadFile(envFile); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if k, v, ok := strings.Cut(line, "="); ok && k != "" {
				if unq, err := strconv.Unquote(v); err == nil {
					v = unq
				}
				env[k] = v
			}
		}
	}
	if req.ProxyUser != "" {
		for _, k := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
			if v, ok := env[k]; ok {
				if i := strings.Index(v, "://"); i >= 0 {
					rest := v[i+3:]
					if at := strings.LastIndex(rest, "@"); at >= 0 {
						rest = rest[at+1:]
					}
					env[k] = v[:i+3] + req.ProxyUser + "@" + rest
				}
			}
		}
	}
	for k, v := range req.Env {
		env[k] = v
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

func (s *Server) buildCommand(ctx context.Context, req *ExecRequest) (*exec.Cmd, error) {
	username := req.User
	if username == "" {
		username = "user"
	}
	u, err := user.Lookup(username)
	if err != nil {
		return nil, err
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	var cmd *exec.Cmd
	if len(req.Argv) > 0 {
		cmd = exec.CommandContext(ctx, req.Argv[0], req.Argv[1:]...)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/bash", "-lc", req.Command)
	}
	cmd.Env = s.commandEnv(req, u.HomeDir, username)
	cmd.Dir = req.Cwd
	if cmd.Dir == "" {
		cmd.Dir = u.HomeDir
	}
	attr := &syscall.SysProcAttr{Setpgid: true}
	if uid != 0 {
		groups := []uint32{}
		if ids, err := u.GroupIds(); err == nil {
			for _, g := range ids {
				if n, err := strconv.Atoi(g); err == nil {
					groups = append(groups, uint32(n))
				}
			}
		}
		attr.Credential = &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: groups}
	}
	cmd.SysProcAttr = attr
	// Kill the whole process group on timeout, not just bash.
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	if req.Stdin != "" {
		raw, err := base64.StdEncoding.DecodeString(req.Stdin)
		if err != nil {
			return nil, fmt.Errorf("stdin: %w", err)
		}
		cmd.Stdin = strings.NewReader(string(raw))
	}
	return cmd, nil
}

type cappedBuffer struct {
	mu        sync.Mutex
	buf       []byte
	max       int
	truncated bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	room := b.max - len(b.buf)
	if room <= 0 {
		b.truncated = true
		return len(p), nil
	}
	if len(p) > room {
		b.buf = append(b.buf, p[:room]...)
		b.truncated = true
		return len(p), nil
	}
	b.buf = append(b.buf, p...)
	return len(p), nil
}

func (s *Server) exec(w http.ResponseWriter, r *http.Request) {
	var req ExecRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	if req.Command == "" && len(req.Argv) == 0 {
		fail(w, 400, errors.New("command or argv is required"))
		return
	}
	started := time.Now()
	if req.Detached {
		cmd, err := s.buildCommand(context.Background(), &req)
		if err != nil {
			fail(w, 400, err)
			return
		}
		logPath := fmt.Sprintf("/tmp/kantel-detached-%d.log", time.Now().UnixNano())
		if f, err := os.Create(logPath); err == nil {
			cmd.Stdout, cmd.Stderr = f, f
			_ = os.Chown(logPath, 1000, 1000)
		}
		cmd.Cancel = nil
		if err := cmd.Start(); err != nil {
			fail(w, 500, err)
			return
		}
		go func() { _ = cmd.Wait() }()
		writeJSON(w, 200, ExecResult{Pid: cmd.Process.Pid, Stdout: logPath})
		return
	}
	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	cmd, err := s.buildCommand(ctx, &req)
	if err != nil {
		fail(w, 400, err)
		return
	}
	if req.Stream {
		s.execStream(ctx, w, cmd)
		return
	}
	max := req.MaxOutputBytes
	if max <= 0 {
		max = 1 << 20
	}
	stdout, stderr := &cappedBuffer{max: max}, &cappedBuffer{max: max}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err = cmd.Run()
	result := ExecResult{Stdout: string(stdout.buf), Stderr: string(stderr.buf), Truncated: stdout.truncated || stderr.truncated, DurationMs: time.Since(started).Milliseconds()}
	result.ExitCode = exitCode(err)
	if ctx.Err() == context.DeadlineExceeded {
		result.TimedOut = true
		result.ExitCode = 124
	} else if err != nil && result.ExitCode == -1 {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, result)
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal())
		}
		return exitErr.ExitCode()
	}
	return -1
}

type eventWriter struct {
	mu     sync.Mutex
	w      http.ResponseWriter
	flush  http.Flusher
	stderr bool
}

func (e *eventWriter) emit(event ExecEvent) {
	e.mu.Lock()
	defer e.mu.Unlock()
	raw, _ := json.Marshal(event)
	_, _ = e.w.Write(append(raw, '\n'))
	if e.flush != nil {
		e.flush.Flush()
	}
}

type streamPipe struct {
	events *eventWriter
	stderr bool
}

func (p *streamPipe) Write(b []byte) (int, error) {
	encoded := base64.StdEncoding.EncodeToString(b)
	if p.stderr {
		p.events.emit(ExecEvent{Stderr: encoded})
	} else {
		p.events.emit(ExecEvent{Stdout: encoded})
	}
	return len(b), nil
}

func (s *Server) execStream(ctx context.Context, w http.ResponseWriter, cmd *exec.Cmd) {
	w.Header().Set("content-type", "application/x-ndjson")
	w.WriteHeader(200)
	flusher, _ := w.(http.Flusher)
	events := &eventWriter{w: w, flush: flusher}
	cmd.Stdout = &streamPipe{events: events}
	cmd.Stderr = &streamPipe{events: events, stderr: true}
	err := cmd.Run()
	code := exitCode(err)
	if ctx.Err() == context.DeadlineExceeded {
		code = 124
		events.emit(ExecEvent{Exit: &code, TimedOut: true})
		return
	}
	if code == -1 && err != nil {
		events.emit(ExecEvent{Error: err.Error()})
		return
	}
	events.emit(ExecEvent{Exit: &code})
}

func cleanPath(raw string) (string, error) {
	if raw == "" {
		return "", errors.New("path is required")
	}
	if !strings.HasPrefix(raw, "/") {
		raw = "/home/user/" + raw
	}
	return filepath.Clean(raw), nil
}

func (s *Server) readFile(w http.ResponseWriter, r *http.Request) {
	path, err := cleanPath(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, 400, err)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		status := 500
		if errors.Is(err, fs.ErrNotExist) {
			status = 404
		}
		fail(w, status, err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		fail(w, 400, fmt.Errorf("%s is a directory", path))
		return
	}
	w.Header().Set("content-type", "application/octet-stream")
	w.Header().Set("x-file-mode", strconv.FormatUint(uint64(info.Mode().Perm()), 8))
	// A ranged read (?offset=&length=): at most length bytes from offset, with the whole file's size in x-file-size,
	// which also tells the host this agent reads ranges (an older one sends the whole file and no x-file-size).
	offset, length, err := fileRange(r.URL.Query())
	if err != nil {
		fail(w, 400, err)
		return
	}
	if length == 0 {
		w.Header().Set("content-length", strconv.FormatInt(info.Size(), 10))
		_, _ = io.Copy(w, f)
		return
	}
	size := info.Size()
	offset = min(offset, size)
	n := min(length, size-offset)
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		fail(w, 500, err)
		return
	}
	w.Header().Set("x-file-size", strconv.FormatInt(size, 10))
	w.Header().Set("content-length", strconv.FormatInt(n, 10))
	_, _ = io.CopyN(w, f, n)
}

// fileRange is a read's offset and length; a length of 0 is the whole file.
func fileRange(q url.Values) (offset, length int64, err error) {
	parse := func(name string) (int64, error) {
		raw := q.Get(name)
		if raw == "" {
			return 0, nil
		}
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("%s must be a whole number of bytes, not %q", name, raw)
		}
		return n, nil
	}
	if offset, err = parse("offset"); err != nil {
		return 0, 0, err
	}
	length, err = parse("length")
	return offset, length, err
}

func (s *Server) writeFile(w http.ResponseWriter, r *http.Request) {
	path, err := cleanPath(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, 400, err)
		return
	}
	mode := os.FileMode(0o644)
	if raw := r.URL.Query().Get("mode"); raw != "" {
		if n, err := strconv.ParseUint(raw, 8, 32); err == nil {
			mode = os.FileMode(n)
		}
	}
	owner := 1000
	if r.URL.Query().Get("user") == "root" {
		owner = 0
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		fail(w, 500, err)
		return
	}
	// Its own file beside the destination, so writes at once (a long streamed one, a short one) never share one: only
	// a write that got all of its body moves its file into place, and nothing still writing has it open.
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".kantel-*")
	if err != nil {
		fail(w, 500, err)
		return
	}
	tmp := f.Name()
	n, err := io.Copy(f, r.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		_ = os.Chmod(tmp, mode)
		_ = os.Chown(tmp, owner, owner)
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"path": path, "size": n})
}

func (s *Server) deleteFile(w http.ResponseWriter, r *http.Request) {
	path, err := cleanPath(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, 400, err)
		return
	}
	if path == "/" {
		fail(w, 400, errors.New("refusing to delete /"))
		return
	}
	if r.URL.Query().Get("recursive") == "true" {
		err = os.RemoveAll(path)
	} else {
		err = os.Remove(path)
	}
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func entryFor(path string, info fs.FileInfo) FileEntry {
	entry := FileEntry{Name: info.Name(), Path: path, Size: info.Size(), Mode: uint32(info.Mode().Perm()), ModTime: info.ModTime().UnixMilli()}
	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		entry.Type = "symlink"
		entry.Target, _ = os.Readlink(path)
	case info.IsDir():
		entry.Type = "dir"
	case info.Mode().IsRegular():
		entry.Type = "file"
	default:
		entry.Type = "other"
	}
	return entry
}

func (s *Server) listFiles(w http.ResponseWriter, r *http.Request) {
	path, err := cleanPath(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, 400, err)
		return
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		status := 500
		if errors.Is(err, fs.ErrNotExist) {
			status = 404
		}
		fail(w, status, err)
		return
	}
	out := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, entryFor(filepath.Join(path, e.Name()), info))
	}
	writeJSON(w, 200, map[string]any{"path": path, "entries": out})
}

// port upgrades the request to a byte stream to a TCP port on the guest's loopback (SSH, VNC, DevTools, an app).
func (s *Server) port(w http.ResponseWriter, r *http.Request) {
	port, err := strconv.Atoi(r.PathValue("port"))
	if err != nil || port <= 0 || port > 65535 {
		fail(w, 400, errors.New("bad port"))
		return
	}
	if !strings.EqualFold(r.Header.Get("upgrade"), PortUpgrade) {
		fail(w, 400, errors.New("expected Upgrade: "+PortUpgrade))
		return
	}
	target, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 5*time.Second)
	if err != nil {
		fail(w, 502, err)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		target.Close()
		fail(w, 500, errors.New("cannot hijack"))
		return
	}
	conn, buffered, err := hijacker.Hijack()
	if err != nil {
		target.Close()
		return
	}
	_, _ = conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: " + PortUpgrade + "\r\n\r\n"))
	Pipe(conn, buffered, target)
}

// Pipe copies both ways until either side ends, then closes both.
func Pipe(a net.Conn, aReader *bufio.ReadWriter, b net.Conn) {
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			a.Close()
			b.Close()
		})
	}
	go func() {
		var src io.Reader = a
		if aReader != nil {
			src = aReader
		}
		_, _ = io.Copy(b, src)
		closeBoth()
	}()
	_, _ = io.Copy(a, b)
	closeBoth()
}
