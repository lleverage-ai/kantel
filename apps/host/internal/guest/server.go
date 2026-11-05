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
	// Injected: Kantel put this agent into the image at boot (kantel-guest init), so the image may be any Linux root
	// filesystem: the agent configures the network itself, serves SSH itself (port 22's stream is its own SSH server,
	// whatever the image has), and runs commands as root where the image has no `user`.
	Injected bool
	// Init is PID 1: "systemd" (the image's) or "kantel" (kantel-guest init's own, for an image without systemd).
	Init string
	// Mounts are the sandbox's read-only bucket mounts (POST /mounts); nil refuses them.
	Mounts *Mounts

	sshOnce    sync.Once
	ssh        *SSHServer
	expectOnce sync.Once
	expect     []string
	demandOnce sync.Once
	demand     *onDemand

	mu       sync.Mutex
	identity *Identity
	// upstream is the host proxy LocalProxyAddr forwards to (a string, host:port or "").
	upstream atomic.Value
	// commands are those run with an ID (commands.go).
	commands commands
}

func (s *Server) Handler() http.Handler {
	// Read at start, so a service left running with nothing connected (by an agent before this one) is stopped too.
	s.onDemand()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /capabilities", s.capabilities)
	mux.HandleFunc("GET /stats", s.stats)
	mux.HandleFunc("POST /identity", s.setIdentity)
	mux.HandleFunc("POST /exec", s.exec)
	mux.HandleFunc("POST /exec/start", s.startCommand)
	mux.HandleFunc("GET /exec/{id}", s.commandStatus)
	mux.HandleFunc("POST /exec/{id}/kill", s.killCommand)
	mux.HandleFunc("POST /sync", s.sync)
	mux.HandleFunc("POST /disk/grow", s.growDisk)
	mux.HandleFunc("GET /files", s.readFile)
	mux.HandleFunc("PUT /files", s.writeFile)
	mux.HandleFunc("DELETE /files", s.deleteFile)
	mux.HandleFunc("GET /files/list", s.listFiles)
	mux.HandleFunc("POST /files/extract", s.extractArchive)
	mux.HandleFunc("GET /ports/{port}", s.port)
	mux.HandleFunc("POST /mounts", s.mounts)
	mux.HandleFunc("POST /bundles", s.mountBundles)
	return mux
}

// mounts makes the guest's read-only mounts the ones asked for ([]MountSpec), answering []MountResult.
func (s *Server) mounts(w http.ResponseWriter, r *http.Request) {
	if s.Mounts == nil {
		fail(w, http.StatusNotImplemented, errors.New("this guest agent has no mounts"))
		return
	}
	var specs []MountSpec
	if err := json.NewDecoder(r.Body).Decode(&specs); err != nil {
		fail(w, 400, err)
		return
	}
	writeJSON(w, 200, s.Mounts.Apply(r.Context(), specs))
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
	if s.Injected && !slicesContains(ready, "ssh") {
		// The agent's own SSH server answers port 22's stream (sshServer).
		ready = append(ready, "ssh")
	}
	sort.Strings(ready)
	raw, _ := os.ReadFile(ReadyFile)
	expect := parseReady(string(raw))
	if len(expect) == 0 && s.Injected {
		expect = s.expected()
	}
	s.mu.Lock()
	id := ""
	if s.identity != nil {
		id = s.identity.SandboxID
	}
	s.mu.Unlock()
	writeJSON(w, 200, Health{OK: true, BootID: strings.TrimSpace(string(boot)), Uptime: uptime, Identity: id, Version: s.Version, Ready: ready, Expect: expect})
}

// expected is what an injected agent's image runs, from what it has, so a template of a plain image (no ReadyFile)
// doesn't wait for a desktop it will never have. Always ssh: the agent's own, so never empty (which would mean "the
// host's defaults").
func (s *Server) expected() []string {
	s.expectOnce.Do(func() {
		c := Detect("/", s.Version, s.Init, true)
		s.expect = []string{"ssh"}
		if c.Desktop.Available {
			s.expect = append(s.expect, "desktop", "stream")
		}
		if c.Browser.Available {
			s.expect = append(s.expect, "browser")
		}
		if c.Docker.Available {
			s.expect = append(s.expect, "docker")
		}
	})
	return s.expect
}

func slicesContains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// capabilities reports what the image has (Detect), for the host to pass on as the sandbox's capabilities.guest.
func (s *Server) capabilities(w http.ResponseWriter, _ *http.Request) {
	pid1 := s.Init
	if pid1 == "" {
		pid1 = "systemd"
	}
	writeJSON(w, 200, Detect("/", s.Version, pid1, s.Injected))
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
	steps := map[string]float64{}
	if err := s.applyIdentity(&id, steps); err != nil {
		fail(w, 500, err)
		return
	}
	s.mu.Lock()
	s.identity = &id
	s.mu.Unlock()
	s.upstream.Store(proxyUpstream(id.ProxyEnv))
	writeJSON(w, 200, map[string]any{"ok": true, "stepsMs": steps})
}

// applyIdentity makes the guest the identity's machine, recording in steps how long each part took (ms).
func (s *Server) applyIdentity(id *Identity, steps map[string]float64) error {
	last := time.Now()
	step := func(name string) {
		now := time.Now()
		steps[name] += float64(now.Sub(last).Microseconds()) / 1000
		last = now
	}
	defer step("rest")
	if s.Injected {
		ensureAPIHome()
	}
	if id.Entropy != "" {
		if raw, err := base64.StdEncoding.DecodeString(id.Entropy); err == nil {
			_ = addEntropy(raw)
		}
	}
	if id.UnixTimeMs > 0 {
		tv := syscall.NsecToTimeval(id.UnixTimeMs * int64(time.Millisecond))
		_ = syscall.Settimeofday(&tv)
	}
	step("entropy+clock")
	if id.Hostname != "" {
		_ = syscall.Sethostname([]byte(id.Hostname))
		_ = os.WriteFile("/etc/hostname", []byte(id.Hostname+"\n"), 0o644)
		_ = os.WriteFile("/etc/hosts", []byte(fmt.Sprintf("127.0.0.1 localhost\n127.0.1.1 %s\n::1 localhost ip6-localhost ip6-loopback\n", id.Hostname)), 0o644)
	}
	if id.MAC != "" {
		// A restore keeps its template's MAC address: every clone would share one. virtio-net takes a new one while
		// up (Firecracker's TAP doesn't filter on it).
		if err := SetMAC("eth0", id.MAC); err != nil {
			return fmt.Errorf("eth0: %w", err)
		}
	}
	if id.Address != "" {
		// Over rtnetlink in this process, for any image (debian:trixie and busybox have no ip(8)), and because an ip
		// process costs tens of milliseconds in a just-restored VM.
		if err := ConfigureInterface("eth0", id.Address, id.Gateway); err != nil {
			return fmt.Errorf("eth0: %w", err)
		}
		step("ip")
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
	writeAptProxy(aptProxyFile, len(id.ProxyEnv) > 0)
	if id.CACert != "" {
		_ = os.MkdirAll("/usr/local/share/ca-certificates", 0o755)
		_ = os.WriteFile("/usr/local/share/ca-certificates/kantel-egress.crt", []byte(id.CACert), 0o644)
		if err := run("update-ca-certificates"); err != nil && s.Injected {
			// An image without ca-certificates' tool (busybox): the bundle programs read, with the CA added once.
			trustCA(id.CACert)
		}
		step("ca")
	}
	if id.Fresh {
		machineID := make([]byte, 16)
		_, _ = rand.Read(machineID)
		_ = os.WriteFile("/etc/machine-id", []byte(hex.EncodeToString(machineID)+"\n"), 0o444)
		_ = os.MkdirAll("/etc/ssh", 0o755)
		for _, f := range []string{"/etc/ssh/ssh_host_ed25519_key", "/etc/ssh/ssh_host_ed25519_key.pub", "/etc/ssh/ssh_host_rsa_key", "/etc/ssh/ssh_host_rsa_key.pub", "/etc/ssh/ssh_host_ecdsa_key", "/etc/ssh/ssh_host_ecdsa_key.pub"} {
			_ = os.Remove(f)
		}
		if err := writeHostKey("/etc/ssh/ssh_host_ed25519_key", id.Hostname); err != nil {
			return err
		}
		step("hostkey")
		// sshd fails to start with no host keys (a template, a fresh clone), so restart rather than try-restart, which
		// leaves a failed unit alone. An injected agent is the SSH server, and reads the key per connection.
		if !s.Injected {
			if err := run("systemctl", "restart", "--no-block", "ssh.service"); err != nil {
				return err
			}
		}
		step("sshd")
	}
	if id.SSHAuthorizedKeys != nil {
		home, uid, gid := "/home/user", 1000, 1000
		if u, err := LoginUser(""); err == nil && s.Injected {
			home = u.HomeDir
			uid, _ = strconv.Atoi(u.Uid)
			gid, _ = strconv.Atoi(u.Gid)
		}
		dir := filepath.Join(home, ".ssh")
		if err := os.MkdirAll(dir, 0o700); err == nil {
			_ = os.WriteFile(filepath.Join(dir, "authorized_keys"), []byte(strings.Join(id.SSHAuthorizedKeys, "\n")+"\n"), 0o600)
			_ = os.Chown(dir, uid, gid)
			_ = os.Chown(filepath.Join(dir, "authorized_keys"), uid, gid)
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

// aptProxyFile points apt at the sandbox's egress proxy whatever environment it runs in. sudo resets the environment
// (env_reset drops HTTP_PROXY), and a sandbox has no way out but the proxy, so a plain `sudo apt-get update` would
// otherwise fail on every source with "Temporary failure resolving".
const aptProxyFile = "/etc/apt/apt.conf.d/90kantel-proxy"

// writeAptProxy writes path for an identity with a proxy (in an image with apt), through LocalProxyAddr so that it
// follows a fork's new proxy as dockerd does, and removes it for one without.
func writeAptProxy(path string, proxied bool) {
	if !proxied {
		_ = os.Remove(path)
		return
	}
	if info, err := os.Stat(filepath.Dir(path)); err != nil || !info.IsDir() {
		return
	}
	proxy := "http://" + LocalProxyAddr
	conf := "// Written by Kantel's guest agent at each start: apt goes through the sandbox's egress proxy, under sudo too.\n" +
		"Acquire::http::Proxy \"" + proxy + "\";\nAcquire::https::Proxy \"" + proxy + "\";\n"
	_ = os.WriteFile(path, []byte(conf), 0o644)
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

// trustCA adds a PEM certificate to the system bundle, where there's no update-ca-certificates to do it.
func trustCA(pemCert string) {
	const bundle = systemCABundle
	raw, _ := os.ReadFile(bundle)
	if strings.Contains(string(raw), strings.TrimSpace(pemCert)) {
		return
	}
	_ = os.MkdirAll(filepath.Dir(bundle), 0o755)
	f, err := os.OpenFile(bundle, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	if len(raw) > 0 && !strings.HasSuffix(string(raw), "\n") {
		_, _ = f.WriteString("\n")
	}
	_, _ = f.WriteString(strings.TrimSpace(pemCert) + "\n")
}

// systemCABundle is where Debian, Ubuntu and Alpine keep the trust store programs read.
const systemCABundle = "/etc/ssl/certs/ca-certificates.crt"

// owner is who a file written for name ("" or "user": the login account; "root") belongs to: Kantel's image's user
// (1000), or in an injected image the account LoginUser resolves name to, as commands and SSH run as.
func (s *Server) owner(name string) (uid, gid int) {
	if name == "root" {
		return 0, 0
	}
	if !s.Injected {
		return 1000, 1000
	}
	u, err := LoginUser(name)
	if err != nil {
		return 0, 0
	}
	uid, _ = strconv.Atoi(u.Uid)
	gid, _ = strconv.Atoi(u.Gid)
	return uid, gid
}

// APIHome is where Kantel's API starts a command and the console's file browser: Kantel's image's user's home.
const APIHome = "/home/user"

// ensureAPIHome makes APIHome in an image that lacks it (a stock image, whose account is root), owned by the account
// commands run as, so the API's commands and files work there as they do on Kantel's image.
func ensureAPIHome() {
	if _, err := os.Stat(APIHome); err == nil {
		return
	}
	if err := os.MkdirAll(APIHome, 0o755); err != nil {
		return
	}
	if u, err := LoginUser(""); err == nil {
		uid, _ := strconv.Atoi(u.Uid)
		gid, _ := strconv.Atoi(u.Gid)
		_ = os.Chown(APIHome, uid, gid)
	}
}

// LoginUser is the account a command or SSH session runs as: name, or `user` when name is empty; and where an image
// has no `user` (a stock image), root.
func LoginUser(name string) (*user.User, error) {
	if name == "" {
		name = "user"
	}
	u, err := user.Lookup(name)
	if err != nil && (name == "user" || name == "root") {
		if root, rootErr := user.Lookup("root"); rootErr == nil {
			return root, nil
		}
		// An image with no /etc/passwd at all (a scratch image with a static binary or two).
		return &user.User{Uid: "0", Gid: "0", Username: "root", HomeDir: "/root"}, nil
	}
	return u, err
}

func (s *Server) commandEnv(req *ExecRequest, home string, username string) []string {
	shell := Shell("/")
	if shell == "" {
		shell = "/bin/sh"
	}
	env := map[string]string{
		"PATH":  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME":  home,
		"USER":  username,
		"LANG":  "C.UTF-8",
		"TERM":  "xterm-256color",
		"SHELL": shell,
	}
	if s.Injected {
		env["PATH"] += ":" + InjectedBin
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
	u, err := LoginUser(req.User)
	if err != nil {
		return nil, err
	}
	username := u.Username
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	var cmd *exec.Cmd
	if len(req.Argv) > 0 {
		cmd = exec.CommandContext(ctx, req.Argv[0], req.Argv[1:]...)
	} else if shell := Shell("/"); shell != "" {
		cmd = exec.CommandContext(ctx, shell, "-lc", req.Command)
	} else {
		return nil, errors.New("this image has no shell (/bin/sh): run the command as argv")
	}
	cmd.Env = s.commandEnv(req, u.HomeDir, username)
	cmd.Dir = req.Cwd
	if cmd.Dir != "" {
		// Said here, as otherwise the failed chdir reads as the shell missing ("fork/exec /bin/sh: no such file").
		if info, err := os.Stat(cmd.Dir); err != nil || !info.IsDir() {
			return nil, fmt.Errorf("no directory %s in the sandbox", cmd.Dir)
		}
	} else {
		cmd.Dir = u.HomeDir
		if _, err := os.Stat(cmd.Dir); err != nil {
			// A stock image's account whose home was never made.
			cmd.Dir = "/"
		}
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
	// Kill the whole process group on timeout or a kill, not just bash.
	cmd.Cancel = func() error { return killGroup(cmd.Process.Pid) }
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

func (b *cappedBuffer) bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf
}

func (b *cappedBuffer) cut() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.truncated
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
			uid, gid := s.owner(req.User)
			_ = os.Chown(logPath, uid, gid)
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
	// The rest of the body read, so the server notices the host closing the request (its context ends, and with it
	// the command): a host stops a command of an older guest, which has no kill route, that way.
	_, _ = io.Copy(io.Discard, r.Body)
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	cmd, err := s.buildCommand(ctx, &req)
	if err != nil {
		fail(w, 400, err)
		return
	}
	max := req.MaxOutputBytes
	if max <= 0 {
		max = 1 << 20
	}
	stdout, stderr := &cappedBuffer{max: max}, &cappedBuffer{max: max}
	// With an ID it can be killed (POST /exec/{id}/kill) while it runs, and its status (GET /exec/{id}) has its output
	// so far, as a detached one's has: what attach shows of a command whose call outlived its host's connection.
	var run *command
	if req.ID != "" {
		if !validCommandID(req.ID) {
			fail(w, 400, errors.New("a command's id is letters, digits, _, - and ."))
			return
		}
		run = &command{cancel: cancel, done: make(chan struct{})}
		if !req.Stream {
			run.stdout, run.stderr = stdout, stderr
		}
		if !s.commands.add(req.ID, run) {
			fail(w, 409, errors.New("a command with this id is already known"))
			return
		}
		defer func() {
			if run != nil {
				s.commands.end(req.ID, run, ExecResult{})
			}
		}()
	}
	killed := func() bool {
		if run == nil {
			return false
		}
		s.commands.mu.Lock()
		defer s.commands.mu.Unlock()
		return run.killed
	}
	if req.Stream {
		s.execStream(ctx, w, cmd, killed)
		return
	}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err = cmd.Run()
	result := ExecResult{Stdout: string(stdout.buf), Stderr: string(stderr.buf), Truncated: stdout.truncated || stderr.truncated, DurationMs: time.Since(started).Milliseconds()}
	result.ExitCode = exitCode(err)
	if killed() {
		result.ExitCode = 137
	} else if ctx.Err() == context.DeadlineExceeded {
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

func (s *Server) execStream(ctx context.Context, w http.ResponseWriter, cmd *exec.Cmd, killed func() bool) {
	w.Header().Set("content-type", "application/x-ndjson")
	w.WriteHeader(200)
	flusher, _ := w.(http.Flusher)
	events := &eventWriter{w: w, flush: flusher}
	cmd.Stdout = &streamPipe{events: events}
	cmd.Stderr = &streamPipe{events: events, stderr: true}
	err := cmd.Run()
	code := exitCode(err)
	if killed() {
		code = 137
		events.emit(ExecEvent{Exit: &code})
		return
	}
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
	uid, gid := s.owner(r.URL.Query().Get("user"))
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
		_ = os.Chown(tmp, uid, gid)
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
	if port == PortSSH && s.Injected {
		// Kantel's SSH is the agent's own server, the same in every image, sshd or none.
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			fail(w, 500, errors.New("cannot hijack"))
			return
		}
		conn, buffered, err := hijacker.Hijack()
		if err != nil {
			return
		}
		_, _ = conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: " + PortUpgrade + "\r\n\r\n"))
		s.sshServer().ServeConn(&bufferedConn{Conn: conn, r: buffered.Reader})
		return
	}
	// An on-demand port's service (the browser's stream) is started for its first connection (OnDemandFile).
	target, done, err := s.onDemand().dial(r.Context(), port, func() (net.Conn, error) {
		return net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 5*time.Second)
	})
	if err != nil {
		fail(w, 502, err)
		return
	}
	defer done()
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

// onDemand is the image's on-demand services (OnDemandFile), read once.
func (s *Server) onDemand() *onDemand {
	s.demandOnce.Do(func() { s.demand = loadOnDemand() })
	return s.demand
}

// bufferedConn reads what the HTTP server had already buffered before the rest of the connection.
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func (s *Server) sshServer() *SSHServer {
	s.sshOnce.Do(func() { s.ssh = &SSHServer{Server: s, HostKey: HostKeyPath} })
	return s.ssh
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
