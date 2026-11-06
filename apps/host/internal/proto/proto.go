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

	// usage (host → Kantel): one tick of the host's and its sandboxes' readings. Its answer, on a connection whose
	// welcome had UsageAcks, is a usage.ack (Kantel → host) whose Acked is the Seq of the newest tick Kantel has taken,
	// covering every earlier one (FeatureUsageAcks).
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
	Sizes []Size `json:"sizes"`
	// Disk is the disk a custom shape may have, with the microVM tier (FeatureCustomShapes); absent from a host from
	// before it said, which took 1 to 4096 GiB.
	Disk   *DiskLimits       `json:"disk,omitempty"`
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

// FeatureUsageAcks: each usage tick carries Run and Seq, and on a connection whose welcome has UsageAcks the host keeps
// a tick until a usage.ack covers it, sending again on its next connection what none did, so a tick written into a
// connection that then dies isn't lost. Without UsageAcks (an older control plane) a tick is done with once written.
const FeatureUsageAcks = "usage-acks"

// FeatureExecControl: sandbox.exec takes a CommandID, and with Detached runs the command in the background past any
// call's end (sandbox.exec.get answers it), and sandbox.exec.kill stops a command by its ID, its whole process group.
// Without it a control plane can't stop a host's command, and a detached one runs as a foreground one does. A
// foreground command with a CommandID runs on past its connection to the control plane going too, to its own limit,
// and its result is then kept for sandbox.exec.get (a host from before ended it with the connection).
const FeatureExecControl = "exec-control"

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

// FeatureBucketMounts (HOST_FEATURES.mountsBucket): the host mounts CreateParams' bucket Mounts read-only in microVM
// sandboxes (a lazy FUSE view over a host-wide read cache), fetches each bucket source's location and credentials with
// bucket.fetch, answers each mount's status in SandboxInfo.Mounts (and later changes as a sandbox.mounts event), and
// answers sandbox.mounts.refresh. Experimental: the control plane sends mounts only behind its switch.
const FeatureBucketMounts = "mounts-bucket"

// FeatureTemplateImageBuild: the host builds templates' custom images (a Dockerfile, or an image reference) in a build
// microVM whose only network is the sandbox egress proxy, and boots them through Kantel's initramfs (the injected
// guest agent). Reported only when its settings switch the builder on (templateBuilder) and it injects the agent. A
// host without it is never sent a TemplateImage, in a build or a boot.
const FeatureTemplateImageBuild = "template-image-build"

// Template image kinds besides a Kantel base (the default, which has no TemplateImage).
const (
	TemplateImageDockerfile = "dockerfile"
	TemplateImageRef        = "image"
)

// TemplateImage is a template's custom image: a Dockerfile built with no build context, or an image reference pulled,
// in a build microVM. Scope names the build the image belongs to (the template, its version and its rebuild), so a
// rebuild builds or pulls it again, and no other account's or template's build shares it.
type TemplateImage struct {
	Kind       string `json:"kind"`
	Dockerfile string `json:"dockerfile,omitempty"`
	Ref        string `json:"ref,omitempty"`
	Scope      string `json:"scope"`
}

// FeatureBundleMounts (HOST_FEATURES.mountsBundle): the host mounts CreateParams' bundle Mounts read-only in microVM
// sandboxes. It fetches a bundle's tar from the control plane (GET /v1/hosts/bundles/{digest}?sandboxId=, with its
// credential) the first time any sandbox on the host mounts it, checks it against the digest, makes it an erofs image
// kept on the host under that digest, and attaches that one image as a read-only drive to every sandbox that mounts
// it. It answers each mount's status in SandboxInfo.Mounts, and a later change as an EventMounts. Experimental: the
// control plane sends mounts only behind its switch.
const FeatureBundleMounts = "mounts-bundle"

// FeatureProcesses (HOST_FEATURES.processes): the host serves sandbox.processes (ProcessesParams) for the sandboxes of
// a tier that lists its processes (the microVM tier, from its guest agent's GET /processes). A sandbox whose guest
// agent is from before it could, and an isolate, answer ErrUnsupported.
const FeatureProcesses = "processes"

// FeatureSnapshotKeep (HOST_FEATURES.snapshotKeep): the host serves snapshot.keep, which makes a saved snapshot of an
// existing one (an automatic one, which the host prunes and removes with its sandbox) without taking it again, so a
// stopped sandbox's state, or a snapshot from its history, can be saved and outlast both.
const FeatureSnapshotKeep = "snapshot-keep"

// FeatureSnapshotSizes (HOST_FEATURES.snapshotSizes): snapshot.list answers each snapshot as it is on the host's disk
// now, not at the time it was made: SizeBytes all its files take (allocated blocks, no memory still spooled to RAM and
// no bundle images), UniqueBytes what of that no other snapshot shares, and beside the list, shared: the bytes of files
// several snapshots hold, by set of holders. The control plane counts each shared group once, for the holder its own
// records say keeps it, and reads the list now and then to keep its snapshots' sizes up to date. snapshot.keep's answer
// carries its UniqueBytes and Shared alike.
const FeatureSnapshotSizes = "snapshot-sizes"

// DiskLimits are the disk a host gives a microVM off its named sizes (a custom shape): at least MinGiB, at most
// MaxGiB, whatever its vCPUs and memory. Whether it has that much free now is admission's to say.
type DiskLimits struct {
	MinGiB int `json:"minGiB"`
	MaxGiB int `json:"maxGiB"`
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
	// Draining hosts take no new sandboxes.
	Draining bool `json:"draining,omitempty"`
	// Images are the host images Kantel wants hosts on: a host with image patching and automatic image updates on
	// fetches them, checks their signature, and starts new sandboxes on them. Running and stopped sandboxes stay on
	// theirs until a sandbox.start with Rebase.
	Images *ImageChannel `json:"images,omitempty"`
	// UsageAcks says Kantel acknowledges usage ticks on this connection (usage.ack, FeatureUsageAcks). The connection's
	// first welcome decides it; a later one doesn't change it.
	UsageAcks bool `json:"usageAcks,omitempty"`
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
	// Owner is the account the sandbox belongs to (its create's Owner).
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
	// Mounts are the sandbox's read-only mounts and how each is doing (FeatureBucketMounts, FeatureBundleMounts).
	Mounts []MountStatus `json:"mounts,omitempty"`
	// MountsAt, with Mounts, is when the host last set them (unix milliseconds, the host's clock, and always later
	// than the sandbox's last MountsAt): reports of a sandbox's mounts, from a call's answer, an EventMounts or the
	// replay after a reconnect, are ordered by it, so one read earlier never replaces a later one.
	MountsAt int64 `json:"mountsAt,omitempty"`
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
	// BrowserSurface: the browser alone, on a display of its own with a stream of just that display, apart from the
	// desktop (absent from an agent too old to say: no such surface).
	BrowserSurface GuestFeature `json:"browserSurface"`
	Docker         GuestDocker  `json:"docker"`
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

// Mount kinds.
const (
	MountBundle = "bundle"
	MountBucket = "bucket"
)

// Mount is one read-only mount a sandbox is created with (HostMount): the sandbox sees it at Path and can't write to
// it (EROFS). A bundle mount is a tar the account uploaded, named by its digest: the host makes it an erofs image
// once and attaches it as a read-only drive. A bucket mount is a prefix of an account's bucket source. The host lists
// it once when it mounts (the manifest: every object's path, size, mtime and ETag), so listing and stat in the sandbox
// are local, and fetches an object's bytes only when the sandbox reads them, through the host's read cache.
type Mount struct {
	// Path is where it appears in the sandbox: absolute, and not one of the system's own directories.
	Path string `json:"path"`
	// Kind is "bundle" or "bucket".
	Kind string `json:"kind"`
	// Digest is a bundle's (kind "bundle"): sha256:<64 hex digits>.
	Digest string `json:"digest,omitempty"`
	// BucketSourceID is the account's bucket source: the host asks Kantel for its location and credentials
	// (bucket.fetch) and keeps them in memory only. They never reach the sandbox.
	BucketSourceID string `json:"bucketSourceId,omitempty"`
	// Prefix is the part of the bucket mounted ("" the whole bucket); "reports" and "reports/" are the same.
	Prefix string `json:"prefix,omitempty"`
	// RefreshTTLSeconds is how old the manifest may be when the sandbox looks at the mount before the host lists the
	// prefix again, in the background. Nil: the host's default (60); 0: never again (sandbox.mounts.refresh still does).
	RefreshTTLSeconds *int `json:"refreshTtlSeconds,omitempty"`
}

// Mount states.
const (
	MountReady   = "ready"
	MountPending = "pending"
	MountFailed  = "failed"
)

// MountStatus is how one of a sandbox's mounts is doing (HostMountStatus, with a bucket manifest's figures besides).
type MountStatus struct {
	Path  string `json:"path"`
	Kind  string `json:"kind,omitempty"`
	State string `json:"status"`
	// Error says why a failed mount failed (never a credential).
	Error string `json:"error,omitempty"`
	// Objects and Bytes are what the manifest holds; RefreshedAt (ms) is when the prefix was last listed.
	Objects     int   `json:"objects,omitempty"`
	Bytes       int64 `json:"bytes,omitempty"`
	RefreshedAt int64 `json:"refreshedAt,omitempty"`
	// ListCalls is how many list requests (pages) the host has made for this mount since it was mounted.
	ListCalls int64 `json:"listCalls,omitempty"`
}

// MountsRefreshParams is sandbox.mounts.refresh: list the sandbox's bucket mounts again now (Path empty: all of
// them), and retry a failed one. The result is the sandbox's []MountStatus.
type MountsRefreshParams struct {
	SandboxID string `json:"sandboxId"`
	Path      string `json:"path,omitempty"`
}

// BucketResolveParams is bucket.fetch (host → Kantel): a bucket source a sandbox on this host mounts.
type BucketResolveParams struct {
	SandboxID string `json:"sandboxId"`
	SourceID  string `json:"bucketSourceId"`
}

// BucketSource is bucket.fetch's answer (HostBucketSource). Its credentials live only in the host's memory: never in
// meta.json, a log, an error or anything the sandbox is sent.
type BucketSource struct {
	ID string `json:"id,omitempty"`
	// Provider is "s3" (any S3-compatible store) or "gcs" (Google Cloud Storage: its XML API, with an HMAC key or a
	// service account's key).
	Provider string `json:"provider"`
	Bucket   string `json:"bucket"`
	// Endpoint is the store's origin, such as http://minio:9000; empty is the provider's own (AWS S3 in Region, or
	// https://storage.googleapis.com).
	Endpoint string `json:"endpoint,omitempty"`
	Region   string `json:"region,omitempty"`
	// Credentials: nil for a public bucket.
	Credentials *BucketCredentials `json:"credentials,omitempty"`
}

// BucketCredentials is an access key (an S3 key or a GCS HMAC key), or a GCS service account's JSON key.
type BucketCredentials struct {
	AccessKeyID       string `json:"accessKeyId,omitempty"`
	SecretAccessKey   string `json:"secretAccessKey,omitempty"`
	SessionToken      string `json:"sessionToken,omitempty"`
	ServiceAccountKey string `json:"serviceAccountKey,omitempty"`
}

// EventMounts is the event a host sends when a sandbox's mounts change status after its create answered
// (HOST_EVENT_MOUNTS); the event's Sandbox carries them.
const EventMounts = "sandbox.mounts"

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
	// TakenAt is when the state it holds was taken, where that is before CreatedAt: a kept snapshot's (snapshot.keep)
	// is its source's. 0: CreatedAt.
	TakenAt int64 `json:"takenAt,omitempty"`
	// UniqueBytes, from a host with FeatureSnapshotSizes: what of SizeBytes is in files no other snapshot has. The rest
	// is in SharedBytes groups (snapshot.list's shared, or Shared on a keep's answer).
	UniqueBytes int64 `json:"uniqueBytes,omitempty"`
	// Shared, on snapshot.keep's answer only: the groups of files the new snapshot shares with others.
	Shared []SharedBytes `json:"shared,omitempty"`
}

// TakenAtOrCreated is when the state a snapshot holds was taken: TakenAt, or CreatedAt where it has none.
func (s SnapshotInfo) TakenAtOrCreated() int64 {
	if s.TakenAt != 0 {
		return s.TakenAt
	}
	return s.CreatedAt
}

// SharedBytes is the bytes of the files a set of snapshots (Snapshots, their IDs, sorted) all hold and no other does:
// files linked into several snapshots, such as a kept copy and its source. The control plane counts them once.
type SharedBytes struct {
	Snapshots []string `json:"snapshots"`
	Bytes     int64    `json:"bytes"`
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
	// PublicOnly is the host's own, never sent or kept (a template's build microVM): its proxy connections reach
	// public addresses only, whatever private ranges egressAllowCIDRs opens to ordinary sandboxes.
	PublicOnly bool `json:"-"`
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
	// Mounts are read-only mounts (FeatureBucketMounts, FeatureBundleMounts), kept for as long as the sandbox exists:
	// its starts, resumes and forks mount them again. A tier that has none refuses them as unsupported.
	Mounts []Mount `json:"mounts,omitempty"`
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
	// Image is the template's custom image (FeatureTemplateImageBuild); nil for a Kantel base. A fresh boot of one
	// boots the root filesystem RootfsKey names, which a build on this host made; it is never built in a create.
	Image *TemplateImage `json:"image,omitempty"`
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
	BaseImage  string `json:"baseImage"`
	BaseDigest string `json:"baseDigest,omitempty"`
	// Image is the template's custom image (FeatureTemplateImageBuild): built or pulled in a build microVM, under
	// Egress with the operator's registries, then booted as the snapshot's root filesystem. Nil: the Kantel base.
	Image     *TemplateImage    `json:"image,omitempty"`
	Setup     string            `json:"setup,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	VCPUs     int               `json:"vcpus"`
	MemoryMiB int               `json:"memoryMiB"`
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
	// ImageDigest is the pulled base's image ID, as Docker answers it; empty for the host's own image. For a custom
	// image, the digest the build microVM reported: an image reference's resolved digest, a Dockerfile's built image ID.
	ImageDigest string `json:"imageDigest,omitempty"`
	// RootfsKey names a custom image's root filesystem on this host (images/templates/<key>.ext4), which a create's
	// fresh boot of the template names (TemplateBoot.RootfsKey). Empty for a Kantel base.
	RootfsKey string `json:"rootfsKey,omitempty"`
	// Source is the custom image's kind, and DockerfileDigest (sha256: of the Dockerfile built) or ImageRef (the
	// reference pulled) what it was: the build's provenance. Empty for a Kantel base.
	Source           string             `json:"source,omitempty"`
	DockerfileDigest string             `json:"dockerfileDigest,omitempty"`
	ImageRef         string             `json:"imageRef,omitempty"`
	SizeBytes        int64              `json:"sizeBytes"`
	Timings          map[string]float64 `json:"timings,omitempty"`
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
	// Detached, without a CommandID, starts the command in the background and answers its pid and the log its output
	// goes to. With a CommandID (FeatureExecControl), see CommandID.
	Detached bool `json:"detached,omitempty"`
	// Attribution names the command at the egress proxy (such as an agent's tool call ID).
	Attribution string `json:"attribution,omitempty"`
	// CommandID is Kantel's ID for the command (FeatureExecControl): while it runs, sandbox.exec.kill stops it. With
	// Detached the call is answered at once (ExecStatus, running), the command runs with no limit but its TimeoutMs (an
	// isolate's has its default), and its exit code and output, bounded as a foreground answer's, are
	// sandbox.exec.get's once it ends, for as long as the host keeps them (the newest few dozen of a sandbox's).
	CommandID string `json:"commandId,omitempty"`
}

// ExecRef is sandbox.exec.get's and sandbox.exec.kill's params: a command by its CommandID. WaitMs, for a get, holds
// the answer up to that long (at most ExecMaxWaitMs) for a running command to end.
type ExecRef struct {
	SandboxID string `json:"sandboxId"`
	CommandID string `json:"commandId"`
	WaitMs    int64  `json:"waitMs,omitempty"`
}

// ExecMaxWaitMs is the longest a sandbox.exec.get waits for a command to end.
const ExecMaxWaitMs = 60_000

// ExecStatus is a command by its CommandID: a detached sandbox.exec's answer, and sandbox.exec.get's. State is
// ExecRunning or ExecEnded; an ended command has its Result.
type ExecStatus struct {
	CommandID string      `json:"commandId"`
	State     string      `json:"state"`
	Pid       int         `json:"pid,omitempty"`
	Result    *ExecResult `json:"result,omitempty"`
	// Stdout, Stderr and Truncated, while it runs in a sandbox that keeps it (the guest's commands with an ID, detached
	// or foreground): its output so far, the start of each stream to its cap, only ever more of the same. Left out where
	// the host has none.
	Stdout    string `json:"stdout,omitempty"`
	Stderr    string `json:"stderr,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	// Unconfirmed, on a detached start: the sandbox didn't answer it, so whether the command started is unknown.
	// Kantel follows it by its ID as any; sandbox.exec.get's not_found then means it never started.
	Unconfirmed bool `json:"unconfirmed,omitempty"`
}

// ExecStatus's states.
const (
	ExecRunning = "running"
	ExecEnded   = "exited"
)

// ExecKilled is sandbox.exec.kill's answer: whether the command was running (it has been killed, with its process
// group). A command that ended, or that the host never ran, is not killed.
type ExecKilled struct {
	Killed bool `json:"killed"`
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

// ProcessesParams is sandbox.processes' (FeatureProcesses): a running sandbox's busiest processes, at most Limit
// (DefaultProcesses when 0, at most MaxProcesses).
type ProcessesParams struct {
	SandboxID string `json:"sandboxId"`
	Limit     int    `json:"limit,omitempty"`
}

// DefaultProcesses and MaxProcesses are how many processes sandbox.processes answers without a limit, and at most.
const (
	DefaultProcesses = 10
	MaxProcesses     = 50
)

// Process is one of a sandbox's processes, as its guest measured it over a short sample.
type Process struct {
	PID int `json:"pid"`
	// Command is its command line (at most 1 KiB of it), or "[name]" where it has none (a kernel thread).
	Command string `json:"command"`
	// CPUPercent is its CPU as a share of one vCPU in percent: 150 is one and a half.
	CPUPercent float64 `json:"cpuPercent"`
	// MemoryBytes is its resident memory.
	MemoryBytes int64 `json:"memoryBytes"`
}

// ProcessList is sandbox.processes' answer: the busiest processes by CPU, then memory, most first; Total how many the
// sandbox has, and SampleMs how long the CPU was measured over.
type ProcessList struct {
	Processes []Process `json:"processes"`
	Total     int       `json:"total"`
	SampleMs  int64     `json:"sampleMs"`
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

// SnapshotParams is snapshot.save / snapshot.keep / snapshot.delete / snapshot.tree / snapshot.read.
type SnapshotParams struct {
	SandboxID  string `json:"sandboxId,omitempty"`
	SnapshotID string `json:"snapshotId"`
	Name       string `json:"name,omitempty"`
	Path       string `json:"path,omitempty"`
	// From is the snapshot snapshot.keep keeps: SnapshotID is made a saved snapshot of what it holds.
	From string `json:"from,omitempty"`
	// Memory (snapshot.save) keeps the sandbox's memory beside its disk, so a sandbox made from the snapshot resumes
	// where it was rather than booting, on the same machine size only. Without it a save keeps the disk alone. A host
	// from before it kept memory on every save of a running sandbox.
	Memory bool `json:"memory,omitempty"`
}

// PortParams is port.open: binary frames on Stream carry the bytes both ways.
type PortParams struct {
	SandboxID string `json:"sandboxId"`
	// Port is the sandbox's TCP port, 1 to 65535.
	Port   int    `json:"port"`
	Stream uint32 `json:"stream"`
}

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
	// Seq is the tick's place in Run, from 1 up by one per tick taken (FeatureUsageAcks); one the backlog dropped leaves
	// a gap. Run is chosen when the sampler starts, so a restarted host's Seq starting again isn't taken for ticks Kantel
	// has already had. Kantel takes a tick at most once by them, so one sent again after a reconnect isn't counted twice.
	Seq uint64 `json:"seq,omitempty"`
	Run string `json:"run,omitempty"`
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
	// DiskUsedBytes and DiskTotalBytes are a microVM's own disk as its guest counts it (df's used and size), from its
	// agent; both absent for an isolate, and for a guest whose agent predates them or didn't answer in time.
	DiskUsedBytes  int64 `json:"diskUsedBytes,omitempty"`
	DiskTotalBytes int64 `json:"diskTotalBytes,omitempty"`
	// IOPressure is the share of the interval, 0 to 1, in which at least one of the guest's tasks waited on IO (its
	// kernel's IO pressure, "some"). Absent when the guest has no pressure figures (a kernel booted without psi=1, an
	// agent that predates them) or for its first reading.
	IOPressure *float64 `json:"ioPressure,omitempty"`
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
	MethodCreate = "sandbox.create"
	MethodStop   = "sandbox.stop"
	MethodResume = "sandbox.resume"
	MethodStart  = "sandbox.start"
	MethodFork   = "sandbox.fork"
	MethodDelete = "sandbox.delete"
	MethodGet    = "sandbox.get"
	MethodList   = "sandbox.list"
	MethodExec   = "sandbox.exec"
	// MethodExecGet (Kantel → host, ExecRef; FeatureExecControl) answers a command's ExecStatus by its CommandID.
	MethodExecGet = "sandbox.exec.get"
	// MethodExecKill (Kantel → host, ExecRef; FeatureExecControl) kills a running command by its CommandID, and its
	// process group; answered ExecKilled.
	MethodExecKill   = "sandbox.exec.kill"
	MethodFileRead   = "sandbox.files.read"
	MethodFileWrite  = "sandbox.files.write"
	MethodFileDelete = "sandbox.files.delete"
	MethodFileList   = "sandbox.files.list"
	// MethodProcesses (Kantel → host, ProcessesParams; FeatureProcesses) answers a running sandbox's ProcessList.
	MethodProcesses    = "sandbox.processes"
	MethodSnapshotList = "snapshot.list"
	MethodSnapshotSave = "snapshot.save"
	// MethodSnapshotKeep (Kantel → host, SnapshotParams: snapshotId, from, name; FeatureSnapshotKeep) makes snapshotId
	// a saved snapshot of what snapshot from holds, which stays as it was; answered with the new SnapshotInfo.
	MethodSnapshotKeep = "snapshot.keep"
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
	// MethodMountsRefresh (Kantel → host, MountsRefreshParams) lists a sandbox's bucket mounts again now.
	MethodMountsRefresh = "sandbox.mounts.refresh"
	// MethodBucketResolve (host → Kantel, BucketResolveParams) answers a BucketSource (HostMethods.bucketFetch).
	MethodBucketResolve = "bucket.fetch"
)
