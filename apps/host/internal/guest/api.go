// Package guest is the protocol between kantel-host and the agent inside each microVM (kantel-guest): HTTP/1.1 over
// vsock port 1024. The types here are shared by both ends.
package guest

// Identity is what makes a sandbox itself after a cold boot, a restore from the pool's snapshot or a fork: every
// clone of a snapshot starts with the same memory, so the host sends each one its own name, address, keys and
// entropy.
type Identity struct {
	SandboxID string `json:"sandboxId"`
	Hostname  string `json:"hostname"`
	// Address is the guest's IPv4 address with its prefix, such as 10.231.0.6/30.
	Address string   `json:"address"`
	Gateway string   `json:"gateway"`
	DNS     []string `json:"dns,omitempty"`
	// ProxyEnv is written to /etc/kantel/proxy.env (HTTP_PROXY, HTTPS_PROXY, NO_PROXY and their lower-case forms),
	// which login shells, commands run through the agent, Docker and the desktop read. Empty removes it.
	ProxyEnv map[string]string `json:"proxyEnv,omitempty"`
	// CACert is a PEM certificate to trust (a TLS-terminating egress proxy's CA); empty trusts only the system's.
	CACert string `json:"caCert,omitempty"`
	// Entropy, base64, is mixed into the guest's random pool so clones don't share RNG state.
	Entropy string `json:"entropy"`
	// UnixTimeMs sets the clock.
	UnixTimeMs int64 `json:"unixTimeMs"`
	// Fresh regenerates machine-id and SSH host keys: true on create and fork, false on resume of the same sandbox.
	Fresh bool `json:"fresh"`
	// SSHAuthorizedKeys replaces user's authorized_keys when not nil.
	SSHAuthorizedKeys []string `json:"sshAuthorizedKeys,omitempty"`
	// Env is extra environment for every command run through the agent (the sandbox's own variables).
	Env map[string]string `json:"env,omitempty"`
}

// ExecRequest runs one command. Either Command (run by `bash -lc`) or Argv.
type ExecRequest struct {
	Command string            `json:"command,omitempty"`
	Argv    []string          `json:"argv,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	// User is "user" (the default) or "root".
	User      string `json:"user,omitempty"`
	TimeoutMs int64  `json:"timeoutMs,omitempty"`
	// Stdin, base64.
	Stdin string `json:"stdin,omitempty"`
	// Stream answers with NDJSON ExecEvents as output arrives instead of one ExecResult.
	Stream bool `json:"stream,omitempty"`
	// Detached starts the command in the background and answers at once with its pid.
	Detached bool `json:"detached,omitempty"`
	// MaxOutputBytes caps each of stdout and stderr in a non-streamed answer. Default 1 MiB.
	MaxOutputBytes int `json:"maxOutputBytes,omitempty"`
	// ProxyUser, when set, replaces the user name in the proxy URLs of this command's environment, so the egress
	// proxy can tell this command's requests from the rest of the sandbox's (advisory; see the proxy notes).
	ProxyUser string `json:"proxyUser,omitempty"`
}

type ExecResult struct {
	ExitCode   int    `json:"exitCode"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	Truncated  bool   `json:"truncated,omitempty"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Pid        int    `json:"pid,omitempty"`
}

// ExecEvent is one line of a streamed command: output (base64) as it comes, then exit.
type ExecEvent struct {
	Stdout   string `json:"stdout,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
	Exit     *int   `json:"exit,omitempty"`
	TimedOut bool   `json:"timedOut,omitempty"`
	Error    string `json:"error,omitempty"`
}

// FileEntry is one entry of a directory listing.
type FileEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// Type is file, dir, symlink or other.
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	ModTime int64  `json:"modTimeMs"`
	Target  string `json:"target,omitempty"`
}

type Health struct {
	OK       bool    `json:"ok"`
	BootID   string  `json:"bootId"`
	Uptime   float64 `json:"uptimeSeconds"`
	Identity string  `json:"sandboxId,omitempty"`
	Version  string  `json:"version"`
	// Ready lists the services that are up: ssh, docker, desktop (VNC), browser (CDP), stream (the desktop's web
	// stream), isolate.
	Ready []string `json:"ready"`
	// Expect lists the services the image says it runs (ReadyFile), which a template waits for before its
	// snapshot; empty when the image doesn't say.
	Expect []string `json:"expect,omitempty"`
}

// ReadyFile, in an image, lists the services (one per line, from Ready's names) its template waits for before the
// host snapshots it. A custom image with no desktop leaves desktop, browser and stream out, so its template doesn't
// wait for them.
const ReadyFile = "/etc/kantel/ready"

// Service ports on the guest's loopback, which the host reaches over vsock (GET /ports/{port}).
const (
	PortSSH     = 22
	PortDesktop = 5901 // VNC (RFB) on display :1
	PortBrowser = 9222 // Chromium's DevTools (CDP)
	PortStream  = 6080 // the desktop in a browser: Selkies' web client and its WebSocket stream
	PortIsolate = 8080
)

// PortUpgrade is the Upgrade token for GET /ports/{port}: after 101 the connection is a byte stream to that port
// on the guest's loopback.
const PortUpgrade = "kantel-tcp"
