/**
 * The protocol between Kantel and `kantel-host`, the agent on a machine that runs sandboxes. The Go side is
 * apps/host/internal/proto/proto.go; keep the two in step.
 *
 * A host registers once (`POST /v1/hosts/register` with a one-time join token, `kth_…`) and gets a host credential
 * (`khc_…`), stored hashed. It then keeps one WebSocket open to `GET /v1/hosts/connect` with
 * `Authorization: Bearer khc_…`, dialling out, so a host needs no inbound port.
 *
 * Text frames are JSON `HostMessage`s. Binary frames carry port streams: 4 bytes of stream ID (big-endian), then the
 * payload; an empty payload closes that direction.
 *
 * Calls go both ways. Kantel calls the host (`HostMethods`); the host calls Kantel only for `secrets.fetch`, with IDs
 * starting `h` so they never clash with Kantel's, and Kantel answers for a sandbox on that host alone. Every addition
 * since version 1 is optional, so the version stays 1.
 */

/** Bumped on any incompatible change; Kantel refuses a host whose version it doesn't speak. */
export const HOST_PROTOCOL_VERSION = 1;

/** The host's credential was revoked or is unknown: the host stops, and doesn't reconnect. */
export const HOST_CLOSE_REVOKED = 4003;
/** A newer connection for the same host took over. */
export const HOST_CLOSE_REPLACED = 4008;
/** The host spoke out of turn, or a version Kantel doesn't speak. */
export const HOST_CLOSE_PROTOCOL = 4002;

export const HOST_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export type HostErrorCode =
	| "not_found"
	| "invalid"
	| "conflict"
	| "capacity"
	| "unavailable"
	| "internal"
	| "unsupported"
	| "timeout";

export interface HostError {
	readonly code: HostErrorCode | string;
	readonly message: string;
}

export type SandboxTier = "microvm" | "isolate";

export interface HostSize {
	readonly name: string;
	readonly vcpus: number;
	readonly memoryMiB: number;
	readonly diskGiB: number;
}

/** What a host is: it changes only with its hardware or software. */
export interface HostFacts {
	readonly version: string;
	readonly protocol: number;
	readonly os: string;
	readonly arch: string;
	readonly kernel: string;
	readonly hostname: string;
	readonly cpus: number;
	/** What the host offers sandboxes, not the whole machine. */
	readonly memoryMiB: number;
	readonly diskGiB: number;
	readonly kvm: boolean;
	/** Whether sandboxes get /dev/kvm. */
	readonly nested: boolean;
	readonly tiers: readonly SandboxTier[];
	readonly sizes: readonly HostSize[];
	readonly labels?: { readonly [key: string]: string };
	/** `open` (NAT), `proxy` (only through the host's egress proxy) or `none`. */
	readonly egress: string;
	/**
	 * What the host can do beyond protocol 1 as first released (`HOST_FEATURES`). An addition a host must enforce, not
	 * merely accept, is gated on one: a host that predates it would ignore the field and report success.
	 */
	readonly features?: readonly string[];
	/** What the host boots new sandboxes on, and its image settings; present with `image-patching`. */
	readonly images?: HostImages;
}

/** A host's images: the version new sandboxes start on, and how it takes new ones. */
export interface HostImages {
	/** The host images version new sandboxes boot on; empty when the images aren't versioned yet. */
	readonly version: string;
	/** The Firecracker version the host runs, such as `v1.17.0`. */
	readonly firecracker: string;
	/** Whether the host follows the welcome's `images`. */
	readonly autoUpdate: boolean;
	/** Its signature policy: `require`, `warn` or `off`. */
	readonly signatures: string;
	/** Asked about a sandbox (`host.images` with `sandboxId`): its state on the host, such as `running`. */
	readonly state?: string;
}

/** The host images Kantel wants hosts on (a welcome's `images`). */
export interface HostImageChannel {
	/** Such as `stable`. */
	readonly channel: string;
	/** The release, such as `host-images-20261103`. */
	readonly version: string;
	/** The release's download base: it holds `manifest.json` and `manifest.json.sigstore.json` (a cosign bundle). */
	readonly url: string;
}

/** Features a host may report in its facts. */
export const HOST_FEATURES = {
	/**
	 * Egress `grants` and `protected` variables: the proxy enforces the grants (methods and paths too), swaps placeholders
	 * only where bound, refuses older `revision`s, and a fork takes its `env`.
	 */
	egressPolicy: "egress-policy",
	/**
	 * Image patching (experimental): the host keeps its host images by version, follows the welcome's `images`, reports
	 * each sandbox's and snapshot's `base`, and restarts a sandbox on its current images when `sandbox.start` has
	 * `rebase`.
	 */
	imagePatching: "image-patching",
	/**
	 * Bundle mounts (`HostMount` of kind `bundle` in a create, start, resume, fork or recover): the host fetches the
	 * bundle's tar (`GET /v1/hosts/bundles/{digest}`), mounts it read-only, and answers each mount's status in the
	 * sandbox it returns (`HostSandbox.mounts`). Without it, Kantel sends no mounts and marks them `failed`.
	 */
	mountsBundle: "mounts-bundle",
	/**
	 * Bucket mounts (`HostMount` of kind `bucket`): the host fetches the bucket source with `bucket.fetch`, mounts the
	 * prefix read-only, and answers its status as for bundles.
	 */
	mountsBucket: "mounts-bucket",
	/** `sandbox.files.open`: a file's bytes streamed both ways on a port stream (signed file URLs, archives). */
	fileStreams: "file-streams",
	/**
	 * `sandbox.files.extract`: a tar in the sandbox extracted by the host's own code, never the sandbox's `tar` or shell
	 * (archives).
	 */
	filesExtract: "files-extract",
	/**
	 * `sandbox.create` takes `vcpus`, `memoryMiB` and `diskGiB` for a microVM off the host's named sizes (it boots from
	 * scratch), and an isolate's `memoryMiB` (recorded, not enforced).
	 */
	customShapes: "custom-shapes",
	/**
	 * The host sends a `usage` message every tick (`HostUsageReport`). Kantel then never reads a sandbox's usage by
	 * running a command in it, which it still does for a host without it.
	 */
	usage: "usage",
} as const;

/**
 * How far either end of a file stream may get ahead of the other's `stream.ack`: a write's sender (Kantel) of what
 * the sandbox has taken, a read's sender (the host) of what Kantel's reader has taken. The host's
 * `proto.FileStreamWindowBytes`.
 */
export const FILE_STREAM_WINDOW_BYTES = 4 * 1024 * 1024;
/** How often a file stream's receiver acknowledges what it has taken: each this many bytes. */
export const FILE_STREAM_ACK_BYTES = 1024 * 1024;
/**
 * The largest frame of a file a read's host sends (the host's are 32 KiB, `sendFile`'s buffer). With the window, what
 * Kantel holds of a read for its reader is bounded however the host behaves: a host is an account's own machine, so a
 * frame past this, or one sent once `FILE_STREAM_WINDOW_BYTES` are unacked, ends the read rather than being kept.
 */
export const FILE_STREAM_FRAME_MAX_BYTES = 1024 * 1024;

/** The largest message a host reads from Kantel (`ws.SetReadLimit` in the host's `conn.go`): it drops the link past it. */
export const HOST_MESSAGE_LIMIT_BYTES = 64 * 1024 * 1024;
/**
 * The largest file `sandbox.files.write` takes, whose bytes go in its message as base64 (four bytes for each three):
 * what fits HOST_MESSAGE_LIMIT_BYTES with a mebibyte to spare for the rest of the message. A larger one needs the host
 * to stream files (`file-streams`).
 */
export const HOST_WRITE_FILE_MAX_BYTES = Math.floor(((HOST_MESSAGE_LIMIT_BYTES - 1024 * 1024) * 3) / 4);

/**
 * A read-only mount, as a create (and every boot after it) carries it in `mounts`. Never a credential: a bucket's
 * settings and credentials are fetched with `bucket.fetch`, and a bundle's tar over HTTP, by the host that needs them.
 */
export type HostMount =
	| { readonly path: string; readonly kind: "bundle"; readonly digest: string }
	| {
			readonly path: string;
			readonly kind: "bucket";
			readonly bucketSourceId: string;
			readonly prefix: string;
			readonly refreshTtlSeconds?: number;
	  };

/** A mount's status as the host reports it, by path. */
export interface HostMountStatus {
	readonly path: string;
	readonly status: "pending" | "ready" | "failed";
	readonly error?: string;
}

/** The answer to a host's `bucket.fetch` `{ sandboxId, bucketSourceId }`: what reads the bucket, in host memory only. */
export interface HostBucketSource {
	readonly id: string;
	readonly provider: "s3" | "gcs";
	readonly bucket: string;
	readonly endpoint?: string;
	readonly region?: string;
	readonly credentials?:
		| { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }
		| { readonly serviceAccountKey: string };
}

/**
 * `sandbox.files.open`'s params: a file of a sandbox on a port stream (`HOST_FEATURES.fileStreams`). `read`: the host
 * answers `{ size }`, sends the file's bytes on the stream and closes it. `write`: Kantel sends the bytes, then an
 * empty frame for the end; the host writes them beside the file, moves them over it once all have arrived, and closes
 * the stream with a reason of `ok <size>`, or `error <code>: <message>` (nothing is moved then).
 *
 * Both ways the receiver sends `stream.ack`s of how much it has taken, and the sender stays within
 * `FILE_STREAM_WINDOW_BYTES` of them, so neither end buffers a file whatever the other's speed.
 */
export interface HostFileOpen {
	readonly sandboxId: string;
	readonly stream: number;
	readonly path: string;
	readonly op: "read" | "write";
	/** For a write: the file's permissions, such as 0o644 (the default). */
	readonly mode?: number;
	/**
	 * For a read: Kantel acks what its reader takes (`stream.ack`), so the host stays within `FILE_STREAM_WINDOW_BYTES`
	 * of it. Absent (an older Kantel), the host sends as fast as it can.
	 */
	readonly acks?: boolean;
}

/** Whether an egress needs the `egress-policy` feature to be enforced: it has grants or protected variables. */
export function needsEgressPolicy(egress: HostEgress | null | undefined): boolean {
	return (
		egress !== undefined && egress !== null && (egress.protected !== undefined || (egress.grants?.length ?? 0) > 0)
	);
}

/** What is free on a host now. */
export interface HostCapacity {
	readonly freeMemoryMiB: number;
	readonly freeDiskGiB: number;
	readonly running: number;
	readonly stopped: number;
	readonly load1: number;
}

export type SandboxState = "starting" | "running" | "stopping" | "stopped" | "error" | "deleted";

/** A sandbox as its host sees it. */
export interface HostSandbox {
	readonly id: string;
	readonly tier: SandboxTier;
	readonly size: string;
	readonly state: SandboxState;
	readonly address?: string;
	/** A stopped sandbox kept its memory, so a resume continues its processes. */
	readonly memory?: boolean;
	readonly error?: string;
	readonly createdAt: number;
	/** The operation's timings in milliseconds, by step. */
	readonly timings?: { readonly [step: string]: number };
	/**
	 * How a create was served: `snapshot` or `boot`; for an isolate, `pool` (one its account's VM had pre-loaded) or
	 * `account` (its account's VM already ran).
	 */
	readonly source?: string;
	/**
	 * The host images version its root file system is; absent when unknown (images not versioned). One older than the
	 * host's `images.version` is outdated until restarted with `rebase`.
	 */
	readonly base?: string;
	/**
	 * When it was put on `base` (unix milliseconds, the host's clock: a create, a rebase or its first pinning), with
	 * `base` only. Reports of a sandbox's base are ordered by it.
	 */
	readonly baseAt?: number;
	/** Its mounts' statuses, from a host with a mounts feature. */
	readonly mounts?: readonly HostMountStatus[];
	/** What a microVM's image has, as its guest agent found it; absent from a host too old to say. */
	readonly guest?: HostGuest;
}

/** One thing a microVM's image has or lacks. */
export interface HostGuestFeature {
	readonly available: boolean;
	readonly detail?: string;
	readonly reason?: string;
}

/** A guest agent's report of its image (`GuestCapabilities` in proto.go), passed to the API as it is. */
export interface HostGuest {
	readonly reportedAt: number;
	readonly agent: { readonly version: string; readonly injected: boolean };
	readonly os: { readonly id: string; readonly name: string; readonly version?: string };
	readonly arch: string;
	readonly libc: "glibc" | "musl" | "none";
	readonly shell?: string;
	readonly init: "systemd" | "kantel";
	readonly desktop: HostGuestFeature;
	readonly browser: HostGuestFeature;
	readonly docker: HostGuestFeature & { readonly kvm: boolean };
}

export interface HostSnapshot {
	readonly id: string;
	readonly sandboxId: string;
	readonly kind: "auto" | "saved";
	readonly name?: string;
	readonly createdAt: number;
	readonly sizeBytes: number;
	readonly memory: boolean;
	readonly tier: SandboxTier;
	/** The host images version its root file system is; absent when unknown (images not versioned). */
	readonly base?: string;
}

/** A sandbox's way out, sent with create, resume and fork. The host holds the token; the sandbox never sees it. */
export interface HostEgress {
	readonly mode?: "open" | "proxy" | "none";
	/** The proxy the host's egress proxy chains to, such as Kantel's vault proxy. */
	readonly upstream?: string;
	readonly token?: string;
	readonly caCert?: string;
	readonly attributionKey?: string;
	/** Headers for the upstream on every request (an account's upstream settings). Kantel-* ones are the host's. */
	readonly headers?: { readonly [name: string]: string };
	readonly allow?: readonly string[];
	readonly deny?: readonly string[];
	readonly defaultDeny?: boolean;
	/**
	 * Present only when the sandbox has protected variables: the hosts their bindings name (patterns, never a value),
	 * which the host intercepts with a CA of the sandbox's own, and the version of its protected values, which the host
	 * fetches with `secrets.fetch`.
	 */
	readonly protected?: HostEgressProtected;
	/** The environment's grants, then the sandbox's own, on top of `allow` and `deny`; deny wins. */
	readonly grants?: readonly HostEgressGrant[];
	/**
	 * Orders the control plane's egress for a sandbox (its `egressRevision`): the host ignores a `sandbox.egress` older
	 * than the egress it has, which was read before a later change. Absent: unordered, always taken.
	 */
	readonly revision?: number;
}

export interface HostEgressProtected {
	readonly version: number;
	readonly intercept: readonly string[];
}

/** An egress grant; one naming methods or paths makes its host intercepted. */
export interface HostEgressGrant {
	readonly action: "allow" | "deny";
	readonly host: string;
	readonly methods?: readonly string[];
	/** Glob patterns: `*` one segment, `**` the rest. */
	readonly paths?: readonly string[];
	/** The rule as the egress log names it, such as `deny DELETE api.github.com /repos/*`. */
	readonly rule: string;
}

/** Where a protected value may go: port 443 of `host`, under these path prefixes, by these methods (empty: any). */
export interface HostSecretBinding {
	readonly host: string;
	readonly pathPrefixes?: readonly string[];
	readonly methods?: readonly string[];
}

export interface HostSecretEntry {
	readonly placeholder: string;
	readonly name: string;
	readonly value: string;
	readonly bindings: readonly HostSecretBinding[];
}

/** The result of a host's `secrets.fetch` `{ sandboxId }`: the sandbox's protected values, in host memory only. */
export interface HostSecrets {
	readonly version: number;
	readonly entries: readonly HostSecretEntry[];
}

/** One request or connection a host's egress proxy handled, in an `egress` event. Never a value or a query string. */
export interface HostEgressRecord {
	/** Milliseconds since the epoch. */
	readonly at: number;
	readonly sandboxId: string;
	/** `CONNECT` for a tunnel the proxy didn't look inside. */
	readonly method: string;
	readonly host: string;
	readonly port: number;
	readonly path?: string;
	readonly allowed: boolean;
	readonly reason?: string;
	readonly rule?: string;
	/** The `X-Kantel-Proxy-Error` code of a refusal. */
	readonly code?: string;
	/** The protected variables swapped in, by name. */
	readonly swapped: readonly string[];
	readonly inspected: boolean;
	readonly status?: number;
	readonly bytesUp: number;
	readonly bytesDown: number;
}

/**
 * One tick of a host's usage: `{ "type": "usage", "usage": HostUsageReport }`, sent every `intervalMs` (5000) once
 * welcomed. A control plane that predates it ignores the message.
 *
 * `cpu` is utilisation over the interval that ended at `at`, 0 to 1 (as the API's `recentCpu`): a sandbox's of its own
 * vCPUs (a microVM's vCPU time over vcpus × interval; an isolate's process CPU time over the interval, of one CPU), the
 * host's of all its CPUs. Above 1 is taken as 1.
 */
export interface HostUsageReport {
	/** When the readings were taken, epoch milliseconds. */
	readonly at: number;
	/** The tick, 1000 to 300000; 5000 by default. */
	readonly intervalMs: number;
	readonly host: HostUsageTotals;
	/** Every sandbox running at the tick. Go's nil slice (`null`) is none. */
	readonly sandboxes: readonly HostSandboxUsage[] | null;
}

export interface HostUsageTotals {
	readonly cpu: number;
	readonly memUsedBytes: number;
	readonly memTotalBytes: number;
	/** The filesystem sandboxes' disks and snapshots are on. */
	readonly diskUsedBytes: number;
	readonly diskTotalBytes: number;
}

export interface HostSandboxUsage {
	readonly id: string;
	readonly kind: SandboxTier;
	readonly cpu: number;
	/**
	 * As kantel-host measures it from the host's side (`SandboxUsage` in apps/host/internal/proto/proto.go): a microVM's
	 * Firecracker process's resident memory (the guest memory it has touched, page cache included, and the VMM's own); an
	 * isolate's even share of its account's runtime's resident memory.
	 */
	readonly memUsedBytes: number;
	/** A microVM's size's memory; an isolate's even share of its account's runtime's memory limit. */
	readonly memLimitBytes: number;
}

export interface HostHello {
	readonly hostId: string;
	readonly facts: HostFacts;
	readonly sandboxes: readonly HostSandbox[];
	readonly capacity: HostCapacity;
}

export interface HostWelcome {
	readonly hostId: string;
	readonly heartbeatSeconds: number;
	readonly desiredVersion?: string;
	/** With `{version}`, `{os}` and `{arch}` for the host to fill in. */
	readonly updateUrl?: string;
	/**
	 * Always empty: hosts keep no warm pools. Sent so a host from before they were removed ends any it still keeps
	 * (it reads `pools` as the warm machines wanted); a current host ignores it.
	 */
	readonly pools?: { readonly [pool: string]: never };
	readonly draining?: boolean;
	/**
	 * The host images Kantel wants hosts on (image patching): a host with automatic image updates on fetches them, checks
	 * their signature, and starts new sandboxes on them. Running and stopped sandboxes stay on theirs until a
	 * `sandbox.start` with `rebase`.
	 */
	readonly images?: HostImageChannel;
}

/**
 * `sandbox.start` and `sandbox.resume`'s params, past the sandbox's ID (the Go side's `ResumeParams`).
 */
export interface HostResumeParams {
	readonly egress?: HostEgress;
	/** Orders the boot's egress (its `egressRevision`); with one, no `egress` is the host's default, a clear. */
	readonly revision?: number;
	/**
	 * On `sandbox.start` (a cold boot): first move the sandbox onto the host's current images. Its own disk stays, its
	 * memory snapshot is dropped. `sandbox.resume` ignores it.
	 */
	readonly rebase?: boolean;
}

export interface HostEvent {
	readonly kind: string;
	readonly sandbox?: HostSandbox;
	/** Base64, for `exec.output`. */
	readonly stdout?: string;
	readonly stderr?: string;
	readonly at: number;
	/** For `egress`: a batch, at most 100 records or 2 seconds' worth. */
	readonly egress?: readonly HostEgressRecord[];
	/** For `sandbox.mounts` (`HOST_EVENT_MOUNTS`): the sandbox, and its mounts' statuses now. */
	readonly sandboxId?: string;
	readonly mounts?: readonly HostMountStatus[];
}

export interface HostMessage {
	readonly type:
		| "hello"
		| "welcome"
		| "heartbeat"
		| "usage"
		| "call"
		| "result"
		| "event"
		| "stream.close"
		| "stream.ack"
		| string;
	readonly hello?: HostHello;
	readonly welcome?: HostWelcome;
	readonly heartbeat?: { readonly capacity: HostCapacity };
	/** For `usage`: one tick of the host's readings. */
	readonly usage?: HostUsageReport;
	readonly id?: string;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: HostError;
	readonly event?: HostEvent;
	/** On an event: the call it is progress of. */
	readonly call?: string;
	readonly stream?: number;
	readonly reason?: string;
	/**
	 * For `stream.ack`: the bytes of a file stream its receiver has taken so far, the sandbox's of a write (host →
	 * Kantel), Kantel's reader's of a read (Kantel → host).
	 */
	readonly acked?: number;
}

/**
 * `port.open`'s port for an E2E session with the host about a sandbox (the host's `proto.PortE2E`): its bytes are a
 * Noise session (`@kantel/e2e`) the gateway relays and can't read.
 */
export const HOST_E2E_PORT = 0;

export const HostMethods = {
	create: "sandbox.create",
	stop: "sandbox.stop",
	resume: "sandbox.resume",
	start: "sandbox.start",
	fork: "sandbox.fork",
	/** Replaces a sandbox's egress: `{ sandboxId, egress }` (null for the host's default). */
	egress: "sandbox.egress",
	delete: "sandbox.delete",
	get: "sandbox.get",
	list: "sandbox.list",
	exec: "sandbox.exec",
	fileRead: "sandbox.files.read",
	fileWrite: "sandbox.files.write",
	fileDelete: "sandbox.files.delete",
	fileList: "sandbox.files.list",
	snapshotList: "snapshot.list",
	snapshotSave: "snapshot.save",
	snapshotDelete: "snapshot.delete",
	snapshotTree: "snapshot.tree",
	snapshotRead: "snapshot.read",
	portOpen: "port.open",
	hostUpdate: "host.update",
	/**
	 * Kantel to host (image patching): `{ sandboxId? }`, answered with the host's `HostImages` as they are now, and with
	 * a `sandboxId` that sandbox's `state` on the host.
	 */
	hostImages: "host.images",
	/**
	 * Kantel to a host from before warm pools were removed, which still reports warm machines: `{}`, the pools it should
	 * keep (none). A current host has no such method.
	 */
	legacyPools: "host.pools",
	/** Kantel to host: a sandbox's protected values changed, `{ sandboxId, version }`; it drops its copy. Result `{}`. */
	secrets: "sandbox.secrets",
	/** Host to Kantel: `{ sandboxId }`, answered with `HostSecrets`, or `not_found` for a sandbox not on that host. */
	secretsFetch: "secrets.fetch",
	/** A file's bytes on a port stream, `HostFileOpen`; answered `{ size? }` once it is open. */
	fileOpen: "sandbox.files.open",
	/**
	 * `{ sandboxId, archive, target }` (`HOST_FEATURES.filesExtract`): the tar at `archive` extracted into the directory
	 * `target` by the host's own code, as the sandbox's root, files owned by its user, then deleted. Answered `{}`.
	 */
	fileExtract: "sandbox.files.extract",
	/**
	 * Host to Kantel: `{ sandboxId, bucketSourceId }`, answered with `HostBucketSource`, or `not_found` unless the
	 * sandbox is on that host and mounts that bucket source.
	 */
	bucketFetch: "bucket.fetch",
} as const;

/** An event a host sends when a sandbox's mounts change status after its create answered: `HostSandbox.mounts`. */
export const HOST_EVENT_MOUNTS = "sandbox.mounts";

export type HostMethod = (typeof HostMethods)[keyof typeof HostMethods];

/** A binary frame: the stream ID, then the payload. */
export function encodeStreamFrame(stream: number, payload: Uint8Array): Uint8Array {
	const frame = new Uint8Array(4 + payload.byteLength);
	new DataView(frame.buffer).setUint32(0, stream >>> 0, false);
	frame.set(payload, 4);
	return frame;
}

export function decodeStreamFrame(
	frame: Uint8Array,
): { readonly stream: number; readonly payload: Uint8Array } | undefined {
	if (frame.byteLength < 4) return undefined;
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	return { stream: view.getUint32(0, false), payload: frame.subarray(4) };
}

/** Whether a value read off the socket is a message at all; the fields are the sender's to get right. */
export function parseHostMessage(text: string): HostMessage | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string") {
			return undefined;
		}
		return value as HostMessage;
	} catch {
		return undefined;
	}
}
