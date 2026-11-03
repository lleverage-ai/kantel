// Package proto is the protocol between kantel-host and Kantel's control plane. The TypeScript side is
// packages/hosts/src/protocol.ts; keep the two in step.
//
// A host registers once (POST /v1/hosts/register with a one-time registration token, kth_…) and gets a host
// credential (khc_…), stored hashed by Kantel. It then keeps one WebSocket open to GET /v1/hosts/connect with
// `Authorization: Bearer khc_…`, dialling out, so a host needs no inbound port.
//
// Text frames are JSON messages (Message). Binary frames carry port streams: 4 bytes of stream ID (big-endian), then
// the payload; an empty payload closes that direction.
package proto

import "encoding/json"

// ProtocolVersion is bumped on any incompatible change; Kantel refuses a host whose version it doesn't speak.
const ProtocolVersion = 1

// Message is any text frame. Type says which fields are set.
type Message struct {
	Type string `json:"type"`

	// hello (host → Kantel), first frame on every connection.
	Hello *Hello `json:"hello,omitempty"`
	// welcome (Kantel → host), the answer to hello.
	Welcome *Welcome `json:"welcome,omitempty"`
	// heartbeat (host → Kantel) every HeartbeatSeconds.
	Heartbeat *Heartbeat `json:"heartbeat,omitempty"`

	// call (Kantel → host) and result (host → Kantel), matched by ID.
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`

	// event (host → Kantel): a sandbox changed state, or a call's progress (Call set).
	Event *Event `json:"event,omitempty"`
	// Call, on an event, is the call it is progress of (a streamed command's output).
	Call string `json:"call,omitempty"`

	// stream.close (either way): a port stream ended; Reason says why.
	Stream uint32 `json:"stream,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// Error codes a call can fail with.
const (
	ErrNotFound    = "not_found"
	ErrInvalid     = "invalid"
	ErrConflict    = "conflict"
	ErrCapacity    = "capacity"
	ErrUnavailable = "unavailable"
	ErrInternal    = "internal"
	ErrUnsupported = "unsupported"
	ErrTimeout     = "timeout"
)

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Facts are what a host is: they change only with its hardware or software.
type Facts struct {
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Kernel   string `json:"kernel"`
	Hostname string `json:"hostname"`
	CPUs     int    `json:"cpus"`
	// MemoryMiB and DiskGiB are what the host offers sandboxes, not the whole machine.
	MemoryMiB int64 `json:"memoryMiB"`
	DiskGiB   int64 `json:"diskGiB"`
	KVM       bool  `json:"kvm"`
	// Nested says whether sandboxes get /dev/kvm (the host CPU's nested virtualisation is on).
	Nested bool `json:"nested"`
	// Tiers it runs: "microvm", "isolate".
	Tiers []string `json:"tiers"`
	// Sizes it can make, by name.
	Sizes  []Size            `json:"sizes"`
	Labels map[string]string `json:"labels,omitempty"`
	// Egress is how sandboxes reach the internet: "open" (NAT), "proxy" (only through the egress proxy) or "none".
	Egress string `json:"egress"`
}

// Size is a sandbox shape.
type Size struct {
	Name      string `json:"name"`
	VCPUs     int    `json:"vcpus"`
	MemoryMiB int    `json:"memoryMiB"`
	DiskGiB   int    `json:"diskGiB"`
}

type Hello struct {
	HostID string `json:"hostId"`
	Facts  Facts  `json:"facts"`
	// Sandboxes the host holds, so Kantel can reconcile after a reconnect.
	Sandboxes []SandboxInfo `json:"sandboxes"`
	Capacity  Capacity      `json:"capacity"`
}

type Welcome struct {
	HostID           string `json:"hostId"`
	HeartbeatSeconds int    `json:"heartbeatSeconds"`
	// DesiredVersion, when set and different from the host's, is the version Kantel wants it on; a host with
	// automatic updates on fetches it from UpdateURL (with {version}, {os} and {arch} filled in).
	DesiredVersion string `json:"desiredVersion,omitempty"`
	UpdateURL      string `json:"updateUrl,omitempty"`
	// Pools are the pre-warmed sandboxes Kantel wants per tier and size, such as {"microvm/default": 2}.
	Pools map[string]int `json:"pools,omitempty"`
	// Draining hosts take no new sandboxes.
	Draining bool `json:"draining,omitempty"`
}

// Capacity is what is free now.
type Capacity struct {
	FreeMemoryMiB int64          `json:"freeMemoryMiB"`
	FreeDiskGiB   int64          `json:"freeDiskGiB"`
	Running       int            `json:"running"`
	Stopped       int            `json:"stopped"`
	Load1         float64        `json:"load1"`
	Warm          map[string]int `json:"warm"`
}

type Heartbeat struct {
	Capacity Capacity `json:"capacity"`
}

// Sandbox states.
const (
	StateStarting = "starting"
	StateRunning  = "running"
	StateStopping = "stopping"
	StateStopped  = "stopped"
	StateError    = "error"
	StateDeleted  = "deleted"
)

// SandboxInfo is a sandbox as its host sees it.
type SandboxInfo struct {
	ID    string `json:"id"`
	Tier  string `json:"tier"`
	Size  string `json:"size"`
	State string `json:"state"`
	// Address is the sandbox's private address on the host (for diagnostics; nothing outside the host reaches it).
	Address string `json:"address,omitempty"`
	// Memory says a stopped sandbox kept its memory, so a resume continues its processes.
	Memory    bool   `json:"memory,omitempty"`
	Error     string `json:"error,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	// Timings of the operation that answered with this, in milliseconds, by step.
	Timings map[string]float64 `json:"timings,omitempty"`
	// Source says how a create was served: "pool" (a pre-warmed sandbox), "snapshot" (restored from a snapshot) or
	// "boot" (a cold boot).
	Source string `json:"source,omitempty"`
}

// SnapshotInfo is one snapshot of a sandbox's disk (and, for a stop that kept it, its memory).
type SnapshotInfo struct {
	ID        string `json:"id"`
	SandboxID string `json:"sandboxId"`
	// Kind is "auto" (taken at a stop; the newest few are kept) or "saved" (kept until deleted).
	Kind      string `json:"kind"`
	Name      string `json:"name,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	SizeBytes int64  `json:"sizeBytes"`
	Memory    bool   `json:"memory"`
	Tier      string `json:"tier"`
}

// Egress is a sandbox's way out, sent with create, resume and fork.
type Egress struct {
	// Mode: "open", "proxy" or "none". Empty is the host's default.
	Mode string `json:"mode,omitempty"`
	// Upstream is the proxy the host's egress proxy chains to (Kantel's vault proxy, or another such as Mehen),
	// such as http://vault-proxy:3128. Empty: the host's proxy goes direct.
	Upstream string `json:"upstream,omitempty"`
	// Token is this sandbox's credential at the upstream, sent as Proxy-Authorization (Basic, user "sbx"). The host
	// holds it; the sandbox never sees it.
	Token string `json:"token,omitempty"`
	// CACert is the upstream's CA when it terminates TLS, installed in the sandbox.
	CACert string `json:"caCert,omitempty"`
	// AttributionKey signs the Kantel-Sandbox and Kantel-Account headers the host adds (Kantel-Signature); empty
	// sends them unsigned.
	AttributionKey string `json:"attributionKey,omitempty"`
	// Headers go on every request the host passes to the upstream (an account's upstream settings, such as a
	// Mehen's key). The host holds them; the sandbox never sees them. Kantel-* names are the host's own and ignored.
	Headers map[string]string `json:"headers,omitempty"`
	// Allow and Deny are host patterns (`example.com`, `*.example.com`); deny wins. DefaultDeny refuses a host no
	// rule names. They apply on the host's proxy, so to "proxy" sandboxes (an "open" one has its own way out).
	Allow       []string `json:"allow,omitempty"`
	Deny        []string `json:"deny,omitempty"`
	DefaultDeny bool     `json:"defaultDeny,omitempty"`
}

// CreateParams is sandbox.create.
type CreateParams struct {
	SandboxID string `json:"sandboxId"`
	Tier      string `json:"tier"`
	Size      string `json:"size"`
	// From is a snapshot (of any sandbox on this host) to start from; empty is the tier's base image.
	From              string            `json:"from,omitempty"`
	Env               map[string]string `json:"env,omitempty"`
	SSHAuthorizedKeys []string          `json:"sshAuthorizedKeys,omitempty"`
	Egress            *Egress           `json:"egress,omitempty"`
	// Owner is the organisation or account the sandbox belongs to; the isolate tier keeps each owner's sandboxes in
	// their own VM.
	Owner string `json:"owner,omitempty"`
}

type SandboxRef struct {
	SandboxID string `json:"sandboxId"`
}

// StopParams is sandbox.stop.
type StopParams struct {
	SandboxID string `json:"sandboxId"`
	// SnapshotID names the automatic snapshot the stop takes.
	SnapshotID string `json:"snapshotId"`
	// Memory keeps the memory too, so a resume continues running processes (default true).
	Memory *bool `json:"memory,omitempty"`
}

// ResumeParams is sandbox.resume and sandbox.start.
type ResumeParams struct {
	SandboxID string  `json:"sandboxId"`
	Egress    *Egress `json:"egress,omitempty"`
}

// ForkParams is sandbox.fork: a new sandbox from the source's current state (running: a live snapshot; stopped: its
// newest snapshot).
type ForkParams struct {
	SandboxID string  `json:"sandboxId"`
	NewID     string  `json:"newId"`
	Egress    *Egress `json:"egress,omitempty"`
	// SnapshotID names the snapshot a running source's fork takes (kept as an automatic snapshot of the source).
	SnapshotID string `json:"snapshotId,omitempty"`
}

// ExecParams is sandbox.exec. With Stream, output comes as events on the call before its result.
type ExecParams struct {
	SandboxID string            `json:"sandboxId"`
	Command   string            `json:"command,omitempty"`
	Argv      []string          `json:"argv,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	User      string            `json:"user,omitempty"`
	TimeoutMs int64             `json:"timeoutMs,omitempty"`
	Stdin     string            `json:"stdin,omitempty"`
	Stream    bool              `json:"stream,omitempty"`
	Detached  bool              `json:"detached,omitempty"`
	// Attribution names the command at the egress proxy (such as an agent's tool call ID).
	Attribution string `json:"attribution,omitempty"`
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

// FileParams is sandbox.files.read/write/delete/list. Data is base64.
type FileParams struct {
	SandboxID string `json:"sandboxId"`
	Path      string `json:"path"`
	Data      string `json:"data,omitempty"`
	Mode      uint32 `json:"mode,omitempty"`
	Recursive bool   `json:"recursive,omitempty"`
}

type FileEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	ModTime int64  `json:"modTimeMs,omitempty"`
	Target  string `json:"target,omitempty"`
}

// SnapshotParams is snapshot.save / snapshot.delete / snapshot.tree / snapshot.read.
type SnapshotParams struct {
	SandboxID  string `json:"sandboxId,omitempty"`
	SnapshotID string `json:"snapshotId"`
	Name       string `json:"name,omitempty"`
	Path       string `json:"path,omitempty"`
}

// PortParams is port.open: binary frames on Stream carry the bytes both ways.
type PortParams struct {
	SandboxID string `json:"sandboxId"`
	Port      int    `json:"port"`
	Stream    uint32 `json:"stream"`
}

// UpdateParams is host.update.
type UpdateParams struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256,omitempty"`
}

// Event is a sandbox's change of state, or a streamed command's output.
type Event struct {
	Kind    string       `json:"kind"`
	Sandbox *SandboxInfo `json:"sandbox,omitempty"`
	// Stdout/Stderr (base64) and Exit, for "exec.output" events.
	Stdout string `json:"stdout,omitempty"`
	Stderr string `json:"stderr,omitempty"`
	At     int64  `json:"at"`
}

// Methods.
const (
	MethodCreate       = "sandbox.create"
	MethodStop         = "sandbox.stop"
	MethodResume       = "sandbox.resume"
	MethodStart        = "sandbox.start"
	MethodFork         = "sandbox.fork"
	MethodDelete       = "sandbox.delete"
	MethodGet          = "sandbox.get"
	MethodList         = "sandbox.list"
	MethodExec         = "sandbox.exec"
	MethodFileRead     = "sandbox.files.read"
	MethodFileWrite    = "sandbox.files.write"
	MethodFileDelete   = "sandbox.files.delete"
	MethodFileList     = "sandbox.files.list"
	MethodSnapshotList = "snapshot.list"
	MethodSnapshotSave = "snapshot.save"
	MethodSnapshotDel  = "snapshot.delete"
	MethodSnapshotTree = "snapshot.tree"
	MethodSnapshotRead = "snapshot.read"
	MethodPortOpen     = "port.open"
	MethodHostUpdate   = "host.update"
	MethodHostPools    = "host.pools"
	// MethodEgress replaces a sandbox's egress (ResumeParams: sandboxId, egress; null egress is the host's default).
	MethodEgress = "sandbox.egress"
)
