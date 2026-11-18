package kantel

// SSH through Kantel's relay, for `kantel ssh` on a control plane whose sandboxes run on its own hosts. A sandbox has
// no address anyone can dial: the answer to `POST /v1/sandboxes/{id}/ssh` carries `proxyUrl`, a short-lived WebSocket
// URL whose binary frames are the sandbox's sshd's bytes, relayed by the gateway over the connection the sandbox's
// host keeps open. `ssh` reaches it through `-o ProxyCommand=…`, which runs `kantel ssh-proxy`: that pipes its stdin
// and stdout through the WebSocket, and nothing more. SSH's own encryption and host key check run end to end inside it.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync/atomic"

	"github.com/coder/websocket"
)

// SSHURLEnv is where `kantel ssh` hands the URL to the ProxyCommand it starts, so the URL isn't in ssh's arguments.
const SSHURLEnv = "KANTEL_SSH_URL"

// tunnelAccess is what a relayed SSH access needs: the user and the relay's URL.
type tunnelAccess struct{ User, ProxyURL string }

// tunnelOptions are how ssh reaches a sandbox through the relay.
type tunnelOptions struct {
	// Self is the command that runs this CLI, such as its executable's path.
	Self []string
	// SandboxID is ssh's name for the sandbox, and the name its host key is kept under.
	SandboxID string
	// KnownHosts is the known_hosts file the CLI keeps sandboxes' host keys in.
	KnownHosts string
	// IdentityFile is a private key Kantel made for this access, if it made one.
	IdentityFile string
}

// tunnelSSHArgs is ssh's arguments for access through the relay: ProxyCommand runs `kantel ssh-proxy`, which takes the
// URL from SSHURLEnv (set it in ssh's environment). Host keys are kept under the sandbox's ID, in the CLI's own file,
// and learnt the first time: the relay is reached over TLS with a URL the API signed for this sandbox alone.
func tunnelSSHArgs(access tunnelAccess, o tunnelOptions) []string {
	words := make([]string, 0, len(o.Self)+1)
	for _, w := range append(append([]string{}, o.Self...), "ssh-proxy") {
		words = append(words, ShellQuote(w))
	}
	// ssh expands %-tokens in a ProxyCommand: a literal % is %%.
	proxy := strings.ReplaceAll(strings.Join(words, " "), "%", "%%")
	var args []string
	if o.IdentityFile != "" {
		args = append(args, "-i", o.IdentityFile, "-o", "IdentitiesOnly=yes")
	}
	return append(args,
		"-o", "ProxyCommand="+proxy,
		"-o", "HostKeyAlias="+o.SandboxID,
		"-o", "UserKnownHostsFile="+o.KnownHosts,
		"-o", "StrictHostKeyChecking=accept-new",
		access.User+"@"+o.SandboxID,
	)
}

// tunnelSSHCommand is a command line to print: the same, with the URL on ssh-proxy's command line rather than in the
// environment.
func tunnelSSHCommand(access tunnelAccess, o tunnelOptions) string {
	args := tunnelSSHArgs(access, o)
	for i, a := range args {
		if strings.HasPrefix(a, "ProxyCommand=") {
			args[i] = a + " --url " + ShellQuote(access.ProxyURL)
			break
		}
	}
	quoted := []string{"ssh"}
	for _, a := range args {
		quoted = append(quoted, ShellQuote(a))
	}
	return strings.Join(quoted, " ")
}

var wsURL = regexp.MustCompile(`^wss?://`)

// proxyURLOf is the URL ssh-proxy was given, from --url or the environment kantel ssh set.
func proxyURLOf(flag string, given bool, env map[string]string) (string, error) {
	url := flag
	if !given {
		url = env[SSHURLEnv]
	}
	if url == "" {
		return "", errors.New("kantel ssh-proxy needs --url or " + SSHURLEnv + ": run it as ssh's ProxyCommand from kantel ssh")
	}
	if !wsURL.MatchString(url) {
		return "", errors.New("kantel ssh-proxy's URL is a ws:// or wss:// URL")
	}
	return url, nil
}

// pipeTunnel is `kantel ssh-proxy`: it pipes stdin into the WebSocket at url as binary frames and its frames to
// stdout, until either side ends. It answers the exit code: 0 when the sandbox's side closed normally, 255 (ssh's own
// code for a failed connection) when the URL is refused, wrong or expired, or the tunnel drops.
func pipeTunnel(ctx context.Context, url string, stdin io.Reader, stdout, stderr io.Writer) int {
	fail := func(message string) int {
		fmt.Fprintf(stderr, "kantel ssh-proxy: %s\n", message)
		return 255
	}
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return fail("couldn't open the tunnel: check the URL hasn't expired, and ask again")
	}
	defer conn.CloseNow()
	// The relay's frames are as big as sshd's writes; ssh's own framing bounds them, not this.
	conn.SetReadLimit(-1)

	var closedByUs atomic.Bool
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := stdin.Read(buf)
			if n > 0 {
				if conn.Write(ctx, websocket.MessageBinary, buf[:n]) != nil {
					return
				}
			}
			if err != nil {
				// ssh closed its side (or stdin closed under us: ssh has gone).
				closedByUs.Store(true)
				_ = conn.Close(websocket.StatusNormalClosure, "ssh closed its side")
				return
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			code := websocket.CloseStatus(err)
			if closedByUs.Load() || code == websocket.StatusNormalClosure || code == websocket.StatusNoStatusRcvd {
				return 0
			}
			reason := ""
			var closeErr websocket.CloseError
			if errors.As(err, &closeErr) {
				reason = closeErr.Reason
			}
			if code == -1 {
				// No close frame: the connection dropped, as a browser's WebSocket reports it.
				code = websocket.StatusAbnormalClosure
			}
			if reason == "" {
				reason = fmt.Sprintf("code %d", int(code))
			}
			// Most often Kantel restarting (a deploy closes every tunnel), which ends the SSH session and what it started.
			return fail("the tunnel closed: " + reason + ". A command that must outlive the connection " +
				"is safer as kantel exec <id> --detach -- <command>, then kantel attach <id> <command>")
		}
		if _, err := stdout.Write(data); err != nil {
			// ssh has gone: nothing is left to read what the sandbox sends.
			closedByUs.Store(true)
			_ = conn.Close(websocket.StatusNormalClosure, "ssh closed its side")
			return 0
		}
	}
}
