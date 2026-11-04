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

	// call and result, matched by ID. Calls go both ways: Kantel's to the host, and the host's to Kantel (such as
	// secrets.fetch), whose IDs start with "h" so they never clash with Kantel's.
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
	// stream.ack, on a file stream (FeatureFileStreams): the bytes of it its receiver has taken so far. Host → Kantel on
	// a write, the sandbox's, sent every FileStreamAckBytes or so; Kantel → host on a read, its reader's. The sender
	// keeps within FileStreamWindowBytes of it.
	Acked int64 `json:"acked,omitempty"`

	// usage (host → Kantel): one tick of the host's and its sandboxes' readings.
	Usage *UsageSample `json:"usage,omitempty"`
}

// FileStreamAckBytes is about how often a host sends a file write stream's stream.ack.
const FileStreamAckBytes = 512 << 10

// FileStreamWindowBytes is how far a file stream's sender may get ahead of its receiver's stream.ack: a read's host of
// what Kantel's reader has taken, so a slow download holds the host back rather than filling the gateway's memory.
const FileStreamWindowBytes = 4 << 20

// FileStreamFrameMaxBytes is the most of a file a read's host sends in one frame (Kantel's FILE_STREAM_FRAME_MAX_BYTES):
// Kantel ends a read whose host sends a larger frame, or any frame once FileStreamWindowBytes are unacked.
const FileStreamFrameMaxBytes = 1 << 20

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
	// Features are what the host does beyond protocol 1 as first released (FeatureEgressPolicy). The control plane
	// sends a sandbox a policy it must enforce only when its host reports the feature that enforces it.
	Features []string `json:"features,omitempty"`
	// Images is what the host boots new sandboxes on, and its image settings; present with FeatureImagePatching.
	Images *HostImages `json:"images,omitempty"`
	// Firecracker is the version of Firecracker the microVM tier runs (`v1.17.0`), and GuestKernel the guest kernel's
	// (its version and a SHA-256 prefix of the file, `6.1.102+0123456789ab`). A template snapshot restores only onto
	// the same two, so they are part of its cache key. Empty on a host without the microVM tier.
	Firecracker string `json:"firecracker,omitempty"`
	GuestKernel string `json:"guestKernel,omitempty"`
}

// FeatureEgressPolicy: the host enforces egress Grants (methods and paths too), swaps Protected placeholders only
// where they are bound, refuses an egress older than its Revision, and gives a fork the Env its ForkParams name.
const FeatureEgressPolicy = "egress-policy"

// FeatureFileStreams: the host serves sandbox.files.open (FileOpenParams), a file's bytes on a port stream, for the
// sandboxes of a tier that streams files (the microVM tier), and acks a write's bytes as the sandbox takes them
// (stream.ack).
const FeatureFileStreams = "file-streams"

// FeatureFilesExtract: the host serves sandbox.files.extract (FileExtractParams) for the sandboxes of a tier that
// extracts archives (the microVM tier), with its own code: never the sandbox's tar, shell or environment.
const FeatureFilesExtract = "files-extract"

// FeatureCustomShapes: sandbox.create takes vcpus, memoryMiB and diskGiB for a microVM shape off the named sizes,
// and memoryMiB for an isolate.
const FeatureCustomShapes = "custom-shapes"

// FeatureUsage: the host sends a "usage" message every tick (UsageSample) without being asked, so the control plane
// needn't run a command in a sandbox to read its usage.
const FeatureUsage = "usage"

// FeatureImagePatching (experimental): the host keeps its host images by version, follows Welcome.Images, reports
// each sandbox's and snapshot's Base, and restarts a sandbox on its current images when sandbox.start has Rebase.
const FeatureImagePatching = "image-patching"

// HostImages is a host's images: the version new sandboxes start on, and how it takes new ones.
type HostImages struct {
	// Version is the host images version new sandboxes boot on (empty when the images aren't versioned yet).
	Version string `json:"version"`
	// Firecracker is the Firecracker version the host runs, such as v1.17.0.
	Firecracker string `json:"firecracker"`
	// AutoUpdate says the host follows Welcome.Images.
	AutoUpdate bool `json:"autoUpdate"`
	// Signatures is the host's signature policy: "require", "warn" or "off".
	Signatures string `json:"signatures"`
	// State, when host.images is asked about a sandbox, is its state on this host (running, stopped, ...): a gateway
	// whose record of it is `error` learns whether its machine is still running before it restarts it on new images.
	State string `json:"state,omitempty"`
}

// ImageChannel is the host images Kantel wants hosts on.
type ImageChannel struct {
	// Channel names the channel, such as "stable".
	Channel string `json:"channel"`
	// Version is the release, such as host-images-20261103.
	Version string `json:"version"`
	// URL is the release's download base: it holds manifest.json and manifest.json.sigstore.json (a cosign bundle).
	URL string `json:"url"`
}

// FeatureTemplateBuild: the host can build templates (template.build) now: it runs the microVM tier, and Docker is
// installed on it and its daemon answers. Without it, template.build answers ErrUnsupported; restoring or booting a
// template already built doesn't need it.
const FeatureTemplateBuild = "template-build"

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
	// Draining hosts take no new sandboxes.
	Draining bool `json:"draining,omitempty"`
	// Images are the host images Kantel wants hosts on: a host with image patching and automatic image updates on
	// fetches them, checks their signature, and starts new sandboxes on them. Running and stopped sandboxes stay on
	// theirs until a sandbox.start with Rebase.
	Images *ImageChannel `json:"images,omitempty"`
}

// Capacity is what is free now.
type Capacity struct {
	FreeMemoryMiB int64   `json:"freeMemoryMiB"`
	FreeDiskGiB   int64   `json:"freeDiskGiB"`
	Running       int     `json:"running"`
	Stopped       int     `json:"stopped"`
	Load1         float64 `json:"load1"`
	// Warm is always empty: hosts keep no warm pools. It is sent for control planes from before they were removed,
	// which refuse a capacity without it.
	Warm map[string]int `json:"warm"`
	// Builds are the template builds (their snapshot IDs) the host has admitted and not yet ended, whose machines'
	// memory and disk FreeMemoryMiB and FreeDiskGiB already leave out: a control plane holding room for one of them
	// stops holding it once a report names it, so it is counted once.
	Builds []string `json:"builds,omitempty"`
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
	// Source says how a create was served: "snapshot" (restored from a snapshot), "boot" (a cold boot), or for an
	// isolate "pool" (an isolate its account's VM had pre-loaded) or "account" (its account's VM already ran).
	Source string `json:"source,omitempty"`
	// Owner is the account the sandbox belongs to (its create's Owner): the space whose E2E chain covers it.
	Owner string `json:"owner,omitempty"`
	// Base is the host images version the sandbox's root filesystem is (empty when unknown: images not versioned).
	// One older than the host's HostImages.Version is outdated until restarted with Rebase.
	Base string `json:"base,omitempty"`
	// BaseAt is when the sandbox was put on Base (unix milliseconds: its root filesystem link's time, set by a create,
	// a rebase or the first pinning); with Base only. Reports of one sandbox's base are ordered by it, so one read
	// before a rebase never replaces what the rebase reported.
	BaseAt int64 `json:"baseAt,omitempty"`
	// Guest is what the microVM's image has, as its guest agent found it (absent from an agent too old to say).
	Guest *GuestCapabilities `json:"guest,omitempty"`
}

// GuestCapabilities is a guest agent's report on its image: what it is, and whether it has a desktop, a browser and
// Docker that Kantel can open. The compute API passes it on as a sandbox's capabilities.guest.
type GuestCapabilities struct {
	ReportedAt int64 `json:"reportedAt"`
	Agent      struct {
		Version string `json:"version"`
		// Injected: Kantel put the agent in at boot (any Linux image), rather than the image shipping it.
		Injected bool `json:"injected"`
	} `json:"agent"`
	OS struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Version string `json:"version,omitempty"`
	} `json:"os"`
	// Arch is uname -m's: x86_64 or aarch64.
	Arch string `json:"arch"`
	// Libc is "glibc", "musl" or "none".
	Libc string `json:"libc"`
	// Shell runs a command's string; empty: argv only.
	Shell string `json:"shell,omitempty"`
	// Init is PID 1: "systemd" (the image's) or "kantel" (the agent's own, for an image without systemd).
	Init    string       `json:"init"`
	Desktop GuestFeature `json:"desktop"`
	Browser GuestFeature `json:"browser"`
	Docker  GuestDocker  `json:"docker"`
}

// GuestFeature is one thing an image has or lacks: what was found, or why it isn't there.
type GuestFeature struct {
	Available bool   `json:"available"`
	Detail    string `json:"detail,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// GuestDocker is Docker's GuestFeature, with whether /dev/kvm opens inside (nested virtualisation for containers).
type GuestDocker struct {
	GuestFeature
	KVM bool `json:"kvm"`
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
	// Base is the host images version the snapshot's root filesystem is (empty when unknown: images not versioned).
	Base string `json:"base,omitempty"`
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
	// Protected is present when the sandbox has protected variables: the host mints a CA for the sandbox and
	// intercepts these hosts to swap placeholders for values. It holds no value.
	Protected *Protected `json:"protected,omitempty"`
	// Grants are the environment's then the sandbox's grants, applied on top of Allow and Deny (deny wins). A grant
	// with methods or paths makes its host intercepted too.
	Grants []Grant `json:"grants,omitempty"`
	// Revision orders the control plane's egress updates for a sandbox: one older than the egress the host holds is
	// stale (it was read before a later change) and is ignored. 0 is unordered and always taken.
	Revision int64 `json:"revision,omitempty"`
	// Allow and Deny are host patterns (`example.com`, `*.example.com`); deny wins. DefaultDeny refuses a host no
	// rule names. They apply on the host's proxy, so to "proxy" sandboxes (an "open" one has its own way out).
	Allow       []string `json:"allow,omitempty"`
	Deny        []string `json:"deny,omitempty"`
	DefaultDeny bool     `json:"defaultDeny,omitempty"`
}

// Protected is a sandbox's protected variables as the host's proxy needs to know them up front: no values.
type Protected struct {
	// Version is the control plane's version of the sandbox's table.
	Version int64 `json:"version"`
	// Intercept are the host patterns the variables are bound to (`api.github.com`, `*.example.com`).
	Intercept []string `json:"intercept"`
}

// Grant is one allow or deny rule. Paths are globs: `*` is one segment, `**` the rest.
type Grant struct {
	Action  string   `json:"action"`
	Host    string   `json:"host"`
	Methods []string `json:"methods,omitempty"`
	Paths   []string `json:"paths,omitempty"`
	// Rule is the grant as text, for the log and refusals: `deny DELETE api.github.com /repos/*`.
	Rule string `json:"rule"`
}

// DestinationBinding is one destination a protected variable may be sent to (always port 443).
type DestinationBinding struct {
	Host         string   `json:"host"`
	PathPrefixes []string `json:"pathPrefixes,omitempty"`
	Methods      []string `json:"methods,omitempty"`
}

// SecretEntry is one protected variable in a secrets.fetch answer. Value is the real value: it lives only in the
// host's memory, and never goes into a log, an error, meta.json or anything the sandbox is sent.
type SecretEntry struct {
	Placeholder string               `json:"placeholder"`
	Name        string               `json:"name"`
	Value       string               `json:"value"`
	Bindings    []DestinationBinding `json:"bindings"`
}

// SecretsTable is secrets.fetch's result (host → Kantel call, params SandboxRef).
type SecretsTable struct {
	Version int64         `json:"version"`
	Entries []SecretEntry `json:"entries"`
}

// SecretsParams is sandbox.secrets (Kantel → host): the sandbox's table changed, so the host drops its copy.
type SecretsParams struct {
	SandboxID string `json:"sandboxId"`
	Version   int64  `json:"version"`
}

// EgressRecord is one decision of the host's egress proxy, in an "egress" event. It never holds a value or a query
// string.
type EgressRecord struct {
	// At is in milliseconds.
	At        int64  `json:"at"`
	SandboxID string `json:"sandboxId"`
	// Method is "CONNECT" for a tunnel.
	Method  string `json:"method"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	Path    string `json:"path,omitempty"`
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
	Rule    string `json:"rule,omitempty"`
	// Code is the X-Kantel-Proxy-Error code of a refusal.
	Code string `json:"code,omitempty"`
	// Swapped are the names of the variables swapped in.
	Swapped []string `json:"swapped"`
	// Inspected says the proxy read the request (plain HTTP, proxy-form https or an intercepted host).
	Inspected bool  `json:"inspected"`
	Status    int   `json:"status,omitempty"`
	BytesUp   int64 `json:"bytesUp"`
	BytesDown int64 `json:"bytesDown"`
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
	// VCPUs, MemoryMiB and DiskGiB are, for a microVM, a shape off the host's named sizes (all three set, Size
	// empty), which cold-boots: no size template is kept for it (one made from a Template restores that template's
	// snapshot when it was built as this shape). For an isolate, MemoryMiB is the memory asked
	// for, recorded and passed to the runtime but not enforced per isolate (workerd has no per-isolate memory limit;
	// the account VM's memory is the bound).
	VCPUs     int `json:"vcpus,omitempty"`
	MemoryMiB int `json:"memoryMiB,omitempty"`
	DiskGiB   int `json:"diskGiB,omitempty"`
	// Template makes the sandbox from a template (microVMs only): from its template snapshot, or by booting its image
	// fresh and running its setup in the new sandbox.
	Template *TemplateBoot `json:"template,omitempty"`
}

// TemplateBoot is how a sandbox made from a template boots.
type TemplateBoot struct {
	// RootfsKey names the image's root filesystem (images/templates/<key>.ext4); empty, it is worked out from the base
	// image and its digest, as a template.build does.
	RootfsKey string `json:"rootfsKey,omitempty"`
	// BaseImage and BaseDigest are the template's Kantel base: an image name such as kantel/sandbox (no registry, tag
	// or digest) and the digest the host pulls it by from its templateRegistry. With no digest (the default base, while
	// its channel has none published), the template is the host's own sandbox image.
	BaseImage  string `json:"baseImage"`
	BaseDigest string `json:"baseDigest,omitempty"`
	// Setup is run as root in a sandbox that boots fresh (no Snapshot), once it has its identity.
	Setup string `json:"setup,omitempty"`
	// Snapshot is a template snapshot on this host (a template.build's Ref) to restore; empty: boot fresh. It is
	// restored only when it was built with the create's vCPUs and memory (its Size's, or its custom shape's); else the
	// template boots fresh.
	Snapshot string `json:"snapshot,omitempty"`
}

// TemplateBuildParams is template.build: take the image's root filesystem (the host's own image, or the base pulled by
// its digest and made into one, or that from the cache), boot it once as the machine asked (the named size with those
// vCPUs, memory and disk, else that custom shape), run Setup as root, and snapshot it as
// template-snapshots/<SnapshotID>. The host refuses it (ErrCapacity) while its budget hasn't the machine's memory and
// disk left beside its sandboxes and other builds, and counts it as used, naming it in Capacity.Builds, until its
// machine has gone; a machine beyond its custom shapes' limits is ErrInvalid. A base with a digest
// is ErrUnsupported on a host with no templateRegistry, and a bad base image name or digest ErrInvalid.
type TemplateBuildParams struct {
	SnapshotID string `json:"snapshotId"`
	// BaseImage and BaseDigest are the template's Kantel base, as TemplateBoot's.
	BaseImage  string            `json:"baseImage"`
	BaseDigest string            `json:"baseDigest,omitempty"`
	Setup      string            `json:"setup,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	VCPUs      int               `json:"vcpus"`
	MemoryMiB  int               `json:"memoryMiB"`
	// DiskGiB is the snapshot's disk: that of the named size with these vCPUs and memory, else the custom shape's
	// (the control plane's diskFor), so a create of the same shape gets the same disk.
	DiskGiB int    `json:"diskGiB"`
	KeyHash string `json:"keyHash"`
	// Egress is the build's way out while its setup runs (the template's grants); nil is the host's default.
	Egress *Egress `json:"egress,omitempty"`
	// Owner is the account the template is of, which the egress proxy names the build's requests after.
	Owner string `json:"owner,omitempty"`
}

// TemplateBuildResult is template.build's answer. Ref names the snapshot on this host (its ID).
type TemplateBuildResult struct {
	Ref string `json:"ref"`
	// ImageDigest is the pulled base's image ID, as Docker answers it; empty for the host's own image.
	ImageDigest string             `json:"imageDigest,omitempty"`
	SizeBytes   int64              `json:"sizeBytes"`
	Timings     map[string]float64 `json:"timings,omitempty"`
}

// TemplateDeleteParams is template.delete: the template snapshot's directory goes; nothing else does.
type TemplateDeleteParams struct {
	SnapshotID string `json:"snapshotId"`
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

// HostImagesParams is host.images's: with SandboxID, the answer's Version is where a rebase of that sandbox lands.
type HostImagesParams struct {
	SandboxID string `json:"sandboxId,omitempty"`
}

// ResumeParams is sandbox.resume and sandbox.start.
type ResumeParams struct {
	SandboxID string  `json:"sandboxId"`
	Egress    *Egress `json:"egress,omitempty"`
	// Revision orders the call's egress, as Egress.Revision does, null egress too: one older than the sandbox's is
	// ignored. A call with a Revision states the sandbox's egress: on sandbox.start and sandbox.resume, no Egress
	// with a Revision is the host's default (a clear), while no Egress without one keeps the egress it has.
	Revision int64 `json:"revision,omitempty"`
	// Rebase, on sandbox.start (a cold boot), first moves the sandbox onto the host's current images: its own disk
	// stays, its memory snapshot is dropped. sandbox.resume ignores it.
	Rebase bool `json:"rebase,omitempty"`
	// RebaseTo, with Rebase, is the host images version (HostImages.Version) the gateway expects the rebase to land on:
	// a host whose current images are another refuses the start before it changes anything, as it hasn't taken that
	// update. Empty: whatever is current.
	RebaseTo string `json:"rebaseTo,omitempty"`
}

// ForkParams is sandbox.fork: a new sandbox from the source's current state (running: a live snapshot; stopped: its
// newest snapshot).
type ForkParams struct {
	SandboxID string  `json:"sandboxId"`
	NewID     string  `json:"newId"`
	Egress    *Egress `json:"egress,omitempty"`
	// SnapshotID names the snapshot a running source's fork takes (kept as an automatic snapshot of the source).
	SnapshotID string `json:"snapshotId,omitempty"`
	// Env is the fork's own environment (its own protected placeholders); absent, it has its source's.
	Env map[string]string `json:"env,omitempty"`
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

// FileParams is sandbox.files.read/write/delete/list. Data is base64. A read with a Length reads at most that many
// bytes from Offset (a ranged read); its answer's fileSize is the whole file's size.
type FileParams struct {
	SandboxID string `json:"sandboxId"`
	Path      string `json:"path"`
	Data      string `json:"data,omitempty"`
	Mode      uint32 `json:"mode,omitempty"`
	Recursive bool   `json:"recursive,omitempty"`
	Offset    int64  `json:"offset,omitempty"`
	Length    int64  `json:"length,omitempty"`
}

// FileExtractParams is sandbox.files.extract's: the tar at Archive (absolute, already checked by Kantel) extracted
// into the directory Target (absolute, made if missing), its entries owned by the sandbox's user, then deleted.
type FileExtractParams struct {
	SandboxID string `json:"sandboxId"`
	Archive   string `json:"archive"`
	Target    string `json:"target"`
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
	// Port is the sandbox's TCP port, or PortE2E: the stream is an E2E session with the host (package e2e), which
	// names what it wants inside its encryption.
	Port   int    `json:"port"`
	Stream uint32 `json:"stream"`
}

// PortE2E is the port.open target that is an E2E session with the host rather than a sandbox port.
const PortE2E = 0

// FileOpenParams is sandbox.files.open: a file's bytes on Stream, in binary frames as port.open's.
//
// Op "read": the call is answered {"size": n}, the file's bytes follow on the stream, and a stream.close ends it with
// the reason "ok <size>", or "error <code>: <message>". Op "write": the call is answered {} once the host is ready;
// Kantel sends the bytes, then an empty frame for the end; the host writes them beside the file, moves them over it once
// all have arrived, and ends the stream with a stream.close as for a read. A stream.close from Kantel aborts either
// (for a write, nothing is moved into place).
type FileOpenParams struct {
	SandboxID string `json:"sandboxId"`
	Stream    uint32 `json:"stream"`
	Path      string `json:"path"`
	Op        string `json:"op"`
	// Mode is a write's permissions, such as 0o644 (the default).
	Mode uint32 `json:"mode,omitempty"`
	// Acks, on a read, is Kantel acking what its reader takes (stream.ack): the host keeps within FileStreamWindowBytes
	// of it. False (an older Kantel), the host sends as fast as it can.
	Acks bool `json:"acks,omitempty"`
}

// FileOpenParams' ops.
const (
	FileOpRead  = "read"
	FileOpWrite = "write"
)

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
	// Egress, for "egress" events: the proxy's decisions, at most 100 to an event.
	Egress []EgressRecord `json:"egress,omitempty"`
}

// UsageSample is a "usage" message's (host → Kantel, once welcomed, every UsageIntervalSeconds; FeatureUsage): the
// host's and its running sandboxes' CPU and memory over one interval, measured from the host's side, with no command
// run in a sandbox. packages/hosts/src/protocol.ts calls it HostUsageReport. A control plane that predates it ignores
// the message (its hub drops a type it doesn't know).
//
// CPU is utilisation over the interval that ended at At, 0 to 1, as the API's usage.recentCpu: the host's of all its
// CPUs; a microVM's of its vCPUs (its Firecracker process's CPU time over vCPUs × interval); an isolate's of one CPU
// (its JavaScript runs on one thread), as its share of its account's runtime's CPU time.
type UsageSample struct {
	// At is when it was taken, in milliseconds; IntervalMs is the span its CPU figures cover.
	At         int64          `json:"at"`
	IntervalMs int64          `json:"intervalMs"`
	Host       HostUsage      `json:"host"`
	Sandboxes  []SandboxUsage `json:"sandboxes"`
}

// HostUsage is the whole machine: CPU from /proc/stat, memory from /proc/meminfo (used is MemTotal - MemAvailable)
// and the disk holding the host's data directory.
type HostUsage struct {
	CPU            float64 `json:"cpu"`
	MemUsedBytes   int64   `json:"memUsedBytes"`
	MemTotalBytes  int64   `json:"memTotalBytes"`
	DiskUsedBytes  int64   `json:"diskUsedBytes"`
	DiskTotalBytes int64   `json:"diskTotalBytes"`
}

// SandboxUsage is one running sandbox. A sandbox appears from its second sample on (CPU needs two readings).
type SandboxUsage struct {
	ID string `json:"id"`
	// Kind is the tier: "microvm" or "isolate".
	Kind string  `json:"kind"`
	CPU  float64 `json:"cpu"`
	// MemUsedBytes, for a microVM, is what its guest counts as used, MemTotal - MemAvailable as its virtio_balloon
	// driver reports them to Firecracker (MemSource "guest"): so not its page cache, and it falls when the guest frees
	// memory. A VM without the balloon's statistics (one restored from a snapshot made before them, or a kernel
	// without the driver) gets its Firecracker process's resident memory instead (MemSource "rss"): the guest memory the
	// VM has touched, page cache included, which never falls, and the VMM's own. MemLimitBytes is its size's memory. An
	// isolate gets an even share of its account's runtime's resident memory and memory ("rss"; workerd says nothing of
	// an isolate's own).
	MemUsedBytes  int64 `json:"memUsedBytes"`
	MemLimitBytes int64 `json:"memLimitBytes"`
	// MemSource is where MemUsedBytes came from, MemSourceGuest or MemSourceRSS. A host that predates it sends none
	// (its figures are all "rss").
	MemSource string `json:"memSource,omitempty"`
}

// SandboxUsage.MemSource's values.
const (
	// MemSourceGuest is the guest's own count of its used memory (MemTotal - MemAvailable), read from outside it.
	MemSourceGuest = "guest"
	// MemSourceRSS is the resident memory of the host process that runs the sandbox (or the sandbox's share of it).
	MemSourceRSS = "rss"
)

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
	// MethodHostImages (Kantel → host, HostImagesParams; FeatureImagePatching) answers the host's HostImages as they
	// are now, which a hello's facts can be behind: a restart on latest asks it before stopping the sandbox.
	MethodHostImages = "host.images"
	// MethodEgress replaces a sandbox's egress (ResumeParams: sandboxId, egress; null egress is the host's default).
	MethodEgress = "sandbox.egress"
	// MethodSecrets (Kantel → host, SecretsParams) says a sandbox's protected variables changed; the result is {}.
	MethodSecrets = "sandbox.secrets"
	// MethodSecretsFetch (host → Kantel, SandboxRef) answers a SecretsTable.
	MethodSecretsFetch = "secrets.fetch"
	// MethodFileOpen (Kantel → host, FileOpenParams) streams a file's bytes on a port stream (FeatureFileStreams).
	MethodFileOpen = "sandbox.files.open"
	// MethodFileExtract (Kantel → host, FileExtractParams) extracts a tar in a sandbox into a directory with the host's
	// own code (FeatureFilesExtract); the result is {}.
	MethodFileExtract = "sandbox.files.extract"
	// MethodTemplateBuild (TemplateBuildParams) answers a TemplateBuildResult.
	MethodTemplateBuild = "template.build"
	// MethodTemplateDelete (TemplateDeleteParams) deletes a template snapshot; the result is {"ok": true}.
	MethodTemplateDelete = "template.delete"
)
