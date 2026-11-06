package guest

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSHServer is an injected agent's own SSH server, for images with no sshd (or one Kantel doesn't configure): it
// serves the connections the host passes it on port 22's stream, authenticating against the login user's
// ~/.ssh/authorized_keys as sshd would. Shells (with a terminal or without), commands, OpenSSH's sftp-server where
// the image has it, and local port forwarding (-L, -D) work; X11 and agent forwarding don't.
type SSHServer struct {
	Server *Server
	// HostKey is the private key's path (a fresh identity makes it; NewHostKey when there is none yet).
	HostKey string
}

// sftpServers are where distributions put OpenSSH's sftp-server.
var sftpServers = []string{"/usr/lib/openssh/sftp-server", "/usr/lib/ssh/sftp-server", "/usr/libexec/openssh/sftp-server", "/usr/libexec/sftp-server", "/usr/lib/sftp-server"}

func (s *SSHServer) config() (*ssh.ServerConfig, error) {
	raw, err := os.ReadFile(s.HostKey)
	if errors.Is(err, os.ErrNotExist) {
		hostname, _ := os.Hostname()
		_ = os.MkdirAll(filepath.Dir(s.HostKey), 0o755)
		if err := writeHostKey(s.HostKey, hostname); err != nil {
			return nil, err
		}
		raw, err = os.ReadFile(s.HostKey)
	}
	if err != nil {
		return nil, err
	}
	signer, err := ssh.ParsePrivateKey(raw)
	if err != nil {
		return nil, fmt.Errorf("host key: %w", err)
	}
	cfg := &ssh.ServerConfig{
		ServerVersion: "SSH-2.0-kantel-guest",
		PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			u, err := LoginUser(meta.User())
			if err != nil {
				return nil, fmt.Errorf("no user %s", meta.User())
			}
			if !authorized(filepath.Join(u.HomeDir, ".ssh", "authorized_keys"), key) {
				return nil, errors.New("key not authorised")
			}
			return &ssh.Permissions{Extensions: map[string]string{"user": u.Username}}, nil
		},
	}
	cfg.AddHostKey(signer)
	return cfg, nil
}

// authorized reports whether key is a line of an authorized_keys file with no options: an entry with options is
// refused, since this server enforces none of them.
func authorized(path string, key ssh.PublicKey) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	want := key.Marshal()
	for len(raw) > 0 {
		pub, _, options, rest, err := ssh.ParseAuthorizedKey(raw)
		if err != nil {
			return false
		}
		// An entry with options (command=, restrict, from=, expiry-time=…) limits what its key may do, and this server
		// enforces none of them: such an entry lets nothing in, rather than everything.
		if len(options) == 0 && bytes.Equal(pub.Marshal(), want) {
			return true
		}
		raw = rest
	}
	return false
}

// ServeConn runs one SSH connection to its end.
func (s *SSHServer) ServeConn(conn net.Conn) {
	defer conn.Close()
	cfg, err := s.config()
	if err != nil {
		log.Printf("ssh: %v", err)
		return
	}
	sc, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	username := sc.Permissions.Extensions["user"]
	for nc := range chans {
		switch nc.ChannelType() {
		case "session":
			ch, chReqs, err := nc.Accept()
			if err != nil {
				continue
			}
			go s.session(username, ch, chReqs)
		case "direct-tcpip":
			go directTCPIP(nc)
		default:
			_ = nc.Reject(ssh.UnknownChannelType, "not supported")
		}
	}
}

func directTCPIP(nc ssh.NewChannel) {
	var target struct {
		Host       string
		Port       uint32
		OriginHost string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(nc.ExtraData(), &target); err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, "bad request")
		return
	}
	up, err := net.Dial("tcp", net.JoinHostPort(target.Host, strconv.Itoa(int(target.Port))))
	if err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	ch, reqs, err := nc.Accept()
	if err != nil {
		up.Close()
		return
	}
	go ssh.DiscardRequests(reqs)
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(ch, up); _ = ch.CloseWrite(); done <- struct{}{} }()
	go func() { _, _ = io.Copy(up, ch); closeWrite(up); done <- struct{}{} }()
	<-done
	<-done
	ch.Close()
	up.Close()
}

func closeWrite(c net.Conn) {
	if tcp, ok := c.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
}

type ptyRequest struct {
	Term          string
	Columns, Rows uint32
	Width, Height uint32
	Modes         string
}

type session struct {
	mu   sync.Mutex
	env  map[string]string
	pty  *ptyRequest
	tty  *os.File // the terminal's controlling side, once a shell or command runs with one
	cmd  *exec.Cmd
	done bool
}

func (s *SSHServer) session(username string, ch ssh.Channel, reqs <-chan *ssh.Request) {
	sess := &session{env: map[string]string{}}
	defer func() {
		ch.Close()
		sess.hangUp()
	}()
	for req := range reqs {
		ok := false
		switch req.Type {
		case "pty-req":
			var p ptyRequest
			if ssh.Unmarshal(req.Payload, &p) == nil {
				sess.mu.Lock()
				sess.pty = &p
				sess.mu.Unlock()
				ok = true
			}
		case "window-change":
			var size struct{ Columns, Rows, Width, Height uint32 }
			if ssh.Unmarshal(req.Payload, &size) == nil {
				sess.mu.Lock()
				if sess.pty != nil {
					sess.pty.Columns, sess.pty.Rows = size.Columns, size.Rows
				}
				if sess.tty != nil {
					setWinsize(sess.tty, size.Columns, size.Rows)
				}
				sess.mu.Unlock()
			}
			ok = true
		case "env":
			var kv struct{ Name, Value string }
			if ssh.Unmarshal(req.Payload, &kv) == nil {
				sess.mu.Lock()
				sess.env[kv.Name] = kv.Value
				sess.mu.Unlock()
				ok = true
			}
		case "shell", "exec", "subsystem":
			var argv []string
			var command string
			if req.Type == "exec" {
				var p struct{ Command string }
				if ssh.Unmarshal(req.Payload, &p) != nil {
					break
				}
				command = p.Command
			} else if req.Type == "subsystem" {
				var p struct{ Name string }
				if ssh.Unmarshal(req.Payload, &p) != nil || p.Name != "sftp" {
					break
				}
				for _, path := range sftpServers {
					if executable("/", path) {
						argv = []string{path}
						break
					}
				}
				if argv == nil {
					break
				}
			}
			sess.mu.Lock()
			started := sess.cmd != nil
			sess.mu.Unlock()
			if started {
				break
			}
			if err := s.start(sess, username, ch, argv, command, req.Type == "shell"); err != nil {
				fmt.Fprintf(ch.Stderr(), "kantel: %v\r\n", err)
				break
			}
			ok = true
		case "signal":
			ok = true
		}
		if req.WantReply {
			_ = req.Reply(ok, nil)
		}
	}
}

// start runs the session's shell, command or subsystem, and closes the channel with its exit status when it ends.
func (s *SSHServer) start(sess *session, username string, ch ssh.Channel, argv []string, command string, shell bool) error {
	u, err := LoginUser(username)
	if err != nil {
		return err
	}
	sh, denied := loginShell(u)
	if denied && argv == nil {
		// As sshd: an account whose shell is nologin or false gets no shell and runs no command.
		return fmt.Errorf("%s may not log in", u.Username)
	}
	if sh == "" && argv == nil {
		return errors.New("this image has no shell (/bin/sh)")
	}
	req := &ExecRequest{User: u.Username}
	switch {
	case argv != nil:
		req.Argv = argv
	case shell:
		req.Argv = []string{sh, "-l"}
	default:
		req.Argv = []string{sh, "-lc", command}
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	req.Env = map[string]string{}
	for k, v := range sess.env {
		req.Env[k] = v
	}
	req.Env["SHELL"] = sh
	if sess.pty != nil && sess.pty.Term != "" {
		req.Env["TERM"] = sess.pty.Term
	}
	cmd, err := s.Server.buildCommand(context.Background(), req)
	if err != nil {
		return err
	}
	cmd.Cancel = nil
	cmd.WaitDelay = 0
	if shell && argv == nil {
		// A login shell, as sshd starts one: argv[0] "-sh".
		setArgv0(cmd, "-"+filepath.Base(sh))
	}
	if sess.pty != nil {
		ptmx, pts, err := openPTY()
		if err != nil {
			return err
		}
		uid, _ := strconv.Atoi(u.Uid)
		gid, _ := strconv.Atoi(u.Gid)
		_ = pts.Chown(uid, gid)
		setWinsize(ptmx, sess.pty.Columns, sess.pty.Rows)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = pts, pts, pts
		cmd.SysProcAttr.Setpgid = false
		cmd.SysProcAttr.Setsid = true
		cmd.SysProcAttr.Setctty = true
		cmd.SysProcAttr.Ctty = 0
		if err := cmd.Start(); err != nil {
			ptmx.Close()
			pts.Close()
			return err
		}
		pts.Close()
		sess.tty, sess.cmd = ptmx, cmd
		go func() { _, _ = io.Copy(ptmx, ch) }()
		go func() {
			_, _ = io.Copy(ch, ptmx) // until the terminal's last holder closes it (EIO), or hangUp closes it
			code := wait(cmd)
			sess.finished()
			ptmx.Close()
			exit(ch, code)
		}()
		return nil
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	cmd.Stdout, cmd.Stderr = ch, ch.Stderr()
	if err := cmd.Start(); err != nil {
		return err
	}
	sess.cmd = cmd
	go func() { _, _ = io.Copy(stdin, ch); stdin.Close() }()
	go func() {
		code := wait(cmd)
		sess.finished()
		exit(ch, code)
	}()
	return nil
}

func (sess *session) finished() {
	sess.mu.Lock()
	sess.done = true
	sess.mu.Unlock()
}

// hangUp ends what a session started when its channel ends before it did (a closed terminal window, a lost
// connection). Its process groups are the command's own (Setsid with a terminal, Setpgid without) and, with a
// terminal, the terminal's foreground job, which a shell's job control puts in a group of its own. It closes the
// terminal, which hangs it up, sends both groups SIGHUP, and SIGKILL to whatever of them is left after three seconds,
// the shell's exit notwithstanding (a job can ignore SIGHUP). Background jobs and processes a command put in a
// session of their own (setsid, a daemon) are left running, as sshd leaves them.
func (sess *session) hangUp() {
	sess.mu.Lock()
	cmd, tty, done := sess.cmd, sess.tty, sess.done
	sess.mu.Unlock()
	if cmd == nil || cmd.Process == nil || done {
		return
	}
	groups := []int{cmd.Process.Pid}
	if tty != nil {
		if fg := foreground(tty); fg > 0 && fg != groups[0] {
			groups = append(groups, fg)
		}
		_ = tty.Close()
	}
	for _, g := range groups {
		_ = syscall.Kill(-g, syscall.SIGHUP)
	}
	go func() {
		for range 30 {
			time.Sleep(100 * time.Millisecond)
			left := false
			for _, g := range groups {
				if syscall.Kill(-g, 0) == nil {
					left = true
				}
			}
			if !left {
				return
			}
		}
		for _, g := range groups {
			_ = syscall.Kill(-g, syscall.SIGKILL)
		}
	}()
}

func wait(cmd *exec.Cmd) int {
	err := cmd.Wait()
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
	return 255
}

func exit(ch ssh.Channel, code int) {
	_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{uint32(code)}))
	_ = ch.CloseWrite()
	ch.Close()
}

// loginShell is the user's shell from /etc/passwd where the image has it, else the image's shell. denied is an
// account whose shell says it may not log in (nologin, false).
func loginShell(u *user.User) (sh string, denied bool) {
	return loginShellIn("/", u.Username)
}

func loginShellIn(root, username string) (string, bool) {
	if raw, err := os.ReadFile(filepath.Join(root, "/etc/passwd")); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Split(line, ":")
			if len(fields) >= 7 && fields[0] == username {
				sh := fields[6]
				if base := filepath.Base(sh); base == "nologin" || base == "false" {
					return "", true
				}
				if sh != "" && executable(root, sh) {
					return sh, false
				}
			}
		}
	}
	return Shell(root), false
}

// EnsureHostKey makes the SSH host key when the image has none yet (a fresh identity replaces it).
func EnsureHostKey() error {
	if _, err := os.Stat(HostKeyPath); err == nil {
		return nil
	}
	hostname, _ := os.Hostname()
	if err := os.MkdirAll(filepath.Dir(HostKeyPath), 0o755); err != nil {
		return err
	}
	return writeHostKey(HostKeyPath, hostname)
}

// SSHAccess lets a key in for the user running it, as the host's SSH access script does with ssh-keygen in an image
// that has it: publicKey when given (once), else a new ed25519 pair whose private key it returns. fingerprint is the
// host key's SHA256.
func SSHAccess(publicKey string) (privateKey, fingerprint string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	dir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	line := strings.TrimSpace(publicKey)
	if line == "" {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return "", "", err
		}
		block, err := ssh.MarshalPrivateKey(priv, "kantel-access")
		if err != nil {
			return "", "", err
		}
		sshPub, err := ssh.NewPublicKey(pub)
		if err != nil {
			return "", "", err
		}
		privateKey = string(pem.EncodeToMemory(block))
		line = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sshPub))) + " kantel-access"
	}
	path := filepath.Join(dir, "authorized_keys")
	raw, _ := os.ReadFile(path)
	if !slicesContains(strings.Split(string(raw), "\n"), line) {
		f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return "", "", err
		}
		if len(raw) > 0 && !strings.HasSuffix(string(raw), "\n") {
			_, _ = f.WriteString("\n")
		}
		_, err = f.WriteString(line + "\n")
		f.Close()
		if err != nil {
			return "", "", err
		}
	}
	pubRaw, err := os.ReadFile(HostKeyPath + ".pub")
	if err != nil {
		return privateKey, "", nil
	}
	hostKey, _, _, _, err := ssh.ParseAuthorizedKey(pubRaw)
	if err != nil {
		return privateKey, "", nil
	}
	return privateKey, ssh.FingerprintSHA256(hostKey), nil
}
