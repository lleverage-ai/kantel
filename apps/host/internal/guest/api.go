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
	Address string `json:"address"`
	// MAC is eth0's address. A restore keeps the snapshot's, the same in every clone of a template, so it is set here.
	// (An agent from before it ignores it.)
	MAC     string   `json:"mac,omitempty"`
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
	// ID names the command (Kantel's command ID): while it runs, POST /exec/{id}/kill stops it and its process group.
	// POST /exec/start needs one, and keeps its result for GET /exec/{id} once it ends. A guest from before IDs
	// ignores it.
	ID string `json:"id,omitempty"`
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

// InjectedBin is where kantel-guest init puts the agent in an image it boots (a tmpfs, so the image's own files and
// the sandbox's disk are untouched): kantel-guest, and kantel-doctor and kantel-connect beside it.
const InjectedBin = "/.kantel/bin"

// HostKeyPath is the sandbox's SSH host key, which a fresh identity makes (sshd's, or the injected agent's server).
const HostKeyPath = "/etc/ssh/ssh_host_ed25519_key"

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

// MountPort is the host's vsock port for a sandbox's read-only mounts: the guest agent's FUSE file systems fetch
// their manifests and bytes there (HTTP/1.1, the paths below), from the host's read cache. Firecracker hands the
// guest's connection to the Unix socket <uds>_1027 in the VM's directory, so the host knows which sandbox asks.
//
//	GET /mounts/{index}/manifest[?have=<version>]  the Manifest, or 304 when the guest has that version
//	GET /mounts/{index}/object?path=<path>&tag=<tag> (Range: bytes=a-b)  an object's bytes
//	POST /mounts/{index}/refresh  list the prefix again now; answers the Manifest
const MountPort = 1027

// MountSpec is one read-only mount the host asks the guest for (POST /mounts, all of a sandbox's mounts at once:
// a mount at a path the list doesn't name is unmounted).
type MountSpec struct {
	// Index is the mount's place in the sandbox's list, its name on MountPort.
	Index int    `json:"index"`
	Path  string `json:"path"`
	// Key says what is mounted (the host's digest of the source and prefix): a mount already at Path with the same
	// Key is kept, with another it is replaced.
	Key string `json:"key"`
	// TTLSeconds is how often, while the sandbox uses the mount, the guest asks whether the manifest changed.
	TTLSeconds int `json:"ttlSeconds"`
}

// MountResult is how the guest's mount of one MountSpec went.
type MountResult struct {
	Path  string `json:"path"`
	Error string `json:"error,omitempty"`
	// Version is the manifest version the guest now shows.
	Version int64 `json:"version,omitempty"`
	// Current says the kernel already forgot the names that changed with Version, so the next lookup in the sandbox
	// sees it rather than one cached for up to the mount's entry timeout. An older guest agent never says, and a host
	// that needs that waits the timeout out instead (CacheTimeout).
	Current bool `json:"current,omitempty"`
}

// Manifest is a bucket mount's whole tree: every directory and object under the prefix, by path relative to it.
// The guest answers lookups, listings and stat from it alone.
type Manifest struct {
	// Version changes whenever the tree does.
	Version int64           `json:"version"`
	Entries []ManifestEntry `json:"entries"`
}

// ManifestEntry is one directory or object. Names are short: a manifest can list many thousands.
type ManifestEntry struct {
	// Path is relative to the mount, with no leading slash ("reports/2026/q3.csv").
	Path string `json:"p"`
	Dir  bool   `json:"d,omitempty"`
	Size int64  `json:"s,omitempty"`
	// MTimeMs is the object's last-modified time.
	MTimeMs int64 `json:"m,omitempty"`
	// Tag is the object's version (its generation or ETag): bytes are fetched by path and tag, so a changed object is
	// a new file to the guest's page cache.
	Tag string `json:"t,omitempty"`
	// Proof is the host's signature of this version (with what it needs to read it): sent back with a read, it lets
	// the host serve a version no longer in its newest manifest, to a file opened before a refresh, however many
	// refreshes later, without keeping every old listing.
	Proof string `json:"k,omitempty"`
}

// RefreshXattr is an extended attribute on a bucket mount's root: reading it (getfattr -n user.kantel.refresh
// <mount>) lists the prefix again now and answers the new manifest version.
const RefreshXattr = "user.kantel.refresh"

// BundleMount is one bundle the host has the guest mount (POST /bundles, all of a sandbox's at once: a bundle mount
// the list doesn't name is unmounted). The host has already attached the bundle's erofs image to the drive.
type BundleMount struct {
	Path string `json:"path"`
	// Drive is the bundle drive's index: drive 0 is /dev/vdc, after the root image (vda) and the sandbox's disk (vdb).
	Drive int `json:"drive"`
	// Digest names the bundle: a mount already at Path with the same digest is kept.
	Digest string `json:"digest"`
	// Bytes is the image's size: the guest waits for the device to be that size (the host has just pointed the drive
	// at it) before it mounts.
	Bytes int64 `json:"bytes"`
}

// BundleResult is how mounting one BundleMount went: an empty Error is mounted.
type BundleResult struct {
	Path  string `json:"path"`
	Error string `json:"error,omitempty"`
}

// BundlesAnswer is the guest's answer to POST /bundles.
type BundlesAnswer struct {
	Mounts []BundleResult `json:"mounts"`
	// Held are the bundle drives a file system is still mounted from after the call (a bundle that something in the
	// sandbox still uses can't be unmounted): their images must not change. Nil from a guest agent that predates it,
	// which unmounted lazily: then no drive is known to be free.
	Held *[]int `json:"held,omitempty"`
	// Unmounts are the bundles it couldn't unmount, by path, and why.
	Unmounts map[string]string `json:"unmounts,omitempty"`
}

// BundleDevice is the guest's device for bundle drive i.
func BundleDevice(i int) string { return "/dev/vd" + string(rune('c'+i)) }

// StickyLabel is the ext4 label of every sticky disk the host makes: the guest mounts a sticky drive only when the file
// system on it has it, so a drive that isn't the disk it was told of is never mounted read-write.
const StickyLabel = "kantel-sticky"

// StickyMount is one sticky disk the host has the guest mount read-write (POST /sticky). The host has already pointed
// the drive at the sandbox's clone of the disk. A mount already at Path from the same drive is kept, so the host sends
// the sandbox's sticky disks again after every start and resume.
type StickyMount struct {
	Path string `json:"path"`
	// Drive is the drive's index as BundleDevice counts it: the sticky drives come after the bundle drives.
	Drive int `json:"drive"`
	// Bytes is the disk's size: the guest waits for the device to be that size before it mounts.
	Bytes int64 `json:"bytes"`
}

// StickyResult is how mounting one StickyMount went: an empty Error is mounted.
type StickyResult struct {
	Path  string `json:"path"`
	Error string `json:"error,omitempty"`
}
