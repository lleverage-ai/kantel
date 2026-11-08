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
	/**
	 * Kantel's own mark, never the host's: the call was sent and no answer came (its link dropped, it timed out or was
	 * aborted, the replica holding the host lost it), so whether the host carried it out is unknown. Absent, the host
	 * answered, or the call never left.
	 */
	readonly unanswered?: boolean;
}

export type SandboxTier = "microvm" | "isolate";

export interface HostSize {
	readonly name: string;
	readonly vcpus: number;
	readonly memoryMiB: number;
	readonly diskGiB: number;
}

/**
 * The disk a host gives a microVM off its named sizes (a custom shape), whatever its vCPUs and memory: at least
 * `minGiB`, at most `maxGiB`. Whether it has that much free now is admission's to say.
 */
export interface HostDiskLimits {
	readonly minGiB: number;
	readonly maxGiB: number;
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
	/** The disk a custom shape may have, with the microVM tier. Absent from a host from before it said (1 to 4096 GiB). */
	readonly disk?: HostDiskLimits;
	readonly labels?: { readonly [key: string]: string };
	/** `open` (NAT), `proxy` (only through the host's egress proxy) or `none`. */
	readonly egress: string;
	/**
	 * What the host can do beyond protocol 1 as first released (`HOST_FEATURES`). An addition a host must enforce, not
	 * merely accept, is gated on one: a host that predates it would ignore the field and report success.
	 */
	readonly features?: readonly string[];
	/**
	 * The microVM tier's Firecracker (`v1.17.0`) and guest kernel (its version and a SHA-256 prefix of the file,
	 * `6.1.102+0123456789ab`): a template snapshot restores only onto the same two. Absent on a host without the tier, or
	 * one from before templates.
	 */
	readonly firecracker?: string;
	readonly guestKernel?: string;
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
	/**
	 * Templates: `template.build` and `template.delete`, and `sandbox.create`'s `template` (a template snapshot restored,
	 * or the template's base image booted fresh with its setup run). Reported only by a host that can make a template's
	 * root filesystem from an image (Docker there, which pulls and exports it). A host without it is never sent a template: one that predates them would drop `template` and boot the
	 * default image as if it had made the sandbox from it.
	 */
	templates: "template-build",
	/**
	 * Acknowledged usage ticks: each tick carries `run` and `seq` (`HostUsageReport`), and on a connection whose welcome
	 * has `usageAcks` the host keeps every tick until a `usage.ack` covers it, sending again on its next connection what
	 * wasn't, so a tick written into a connection that then dies isn't lost. Without the welcome's `usageAcks` (an older
	 * Kantel), a tick is done with once written, as before.
	 */
	usageAcks: "usage-acks",
	/**
	 * Templates' custom images: a `HostTemplateImage` (a Dockerfile, or an image reference) built or pulled in a build
	 * microVM whose only network is the host's egress proxy, never on the host's Docker, and booted through the injected
	 * guest agent. Reported beside `templates` by a host whose settings switch its template builder on. A host without
	 * it is never sent a `HostTemplateImage`, in a build or a create.
	 */
	templateImages: "template-image-build",
	/**
	 * Commands by Kantel's ID (`HostExecParams.commandId`): `sandbox.exec.kill` stops one that is running, with its whole
	 * process group, and a `detached` one is answered at once and runs past any call (and the host's connection),
	 * with no limit but its own `timeoutMs`, its result kept for `sandbox.exec.get`. A later kantel-host also keeps a
	 * foreground one running when its connection goes, to its own limit, with its result for `sandbox.exec.get` (an
	 * earlier one ends it with the connection, and then doesn't know it), and answers a running one's get with its output
	 * so far where its sandbox keeps it (`HostExecStatus.stdout`). Without it Kantel can't stop a
	 * host's command, and a detached one runs as a foreground one, to the guest's default limit (120 s; an isolate's
	 * 30 s).
	 */
	execControl: "exec-control",
	/**
	 * `sandbox.processes` (`HostProcessesParams`): a running microVM's busiest processes, from its guest agent, answered
	 * `HostProcessList`. An isolate's, and a sandbox's whose guest agent is from before it could, are `unsupported`.
	 * Without it Kantel asks no host for processes.
	 */
	processes: "processes",
	/**
	 * `snapshot.keep` (`HostSnapshotKeep`): a saved snapshot made of an existing one (a stop's automatic snapshot, which
	 * the host prunes and removes with its sandbox) without taking it again, answered as `snapshot.save` is. Without it
	 * a save of a stopped sandbox, or of a history entry, shares the automatic snapshot's bytes, which the host may prune.
	 */
	snapshotKeep: "snapshot-keep",
	/**
	 * `snapshot.list` answers each snapshot as it is on the host's disk now, not as it was made: `sizeBytes` all its files
	 * take (allocated blocks, no memory still in RAM), `uniqueBytes` what of that no other snapshot shares, and beside the
	 * list, `shared` (`HostSharedBytes`): the files several hold, by set of holders. Kantel counts each group once, for the
	 * holder its own records say keeps it, reading the list once a connection and every `SNAPSHOT_SIZES_REFRESH_MS`; a
	 * keep's answer carries the same. Without it, a snapshot keeps the size it was made with.
	 */
	snapshotSizes: "snapshot-sizes",
	/**
	 * Guest health: the host asks each running microVM's guest agent for its health, and reports one that stops answering
	 * (`HostSandbox.health` `unresponsive`, with `healthReason`) in a `sandbox` event and its hello, and again once it
	 * answers. A stop doesn't wait on a guest that doesn't answer; a start or resume of a sandbox it has running whose agent
	 * doesn't answer, and a `sandbox.start` with `reset` (a recovery), end its VM (its disk kept, its memory lost) and boot
	 * it cold from its disk rather than answer it as running; a stop of a sandbox it has stopped answers a snapshot of its
	 * disk. Without it a recovery of a sandbox the host has running changes nothing there.
	 */
	guestHealth: "guest-health",
} as const;

/**
 * `snapshot.keep`'s params (`HOST_FEATURES.snapshotKeep`): `snapshotId` made a saved snapshot of what `from` holds, which
 * stays as it was. Its memory comes along while `from` still has it; the answer's `memory` says.
 */
export interface HostSnapshotKeep {
	readonly snapshotId: string;
	readonly from: string;
	readonly name?: string;
}

/** `sandbox.processes`' params: at most `limit` processes (the host's default 10 without one, at most 50). */
export interface HostProcessesParams {
	readonly limit?: number;
}

/** One of a sandbox's processes, as its guest measured it over a short sample (the Go side's `Process`). */
export interface HostProcess {
	readonly pid: number;
	/** Its command line (at most 1 KiB of it), or `[name]` where it has none (a kernel thread). */
	readonly command: string;
	/** Its CPU over the sample, as a share of one vCPU in percent: 150 is one and a half. */
	readonly cpuPercent: number;
	/** Its resident memory. */
	readonly memoryBytes: number;
}

/**
 * `sandbox.processes`' answer: the busiest processes by CPU, then memory, most first; `total` how many the sandbox has,
 * and `sampleMs` how long the CPU was measured over.
 */
export interface HostProcessList {
	readonly processes: readonly HostProcess[] | null;
	readonly total: number;
	readonly sampleMs: number;
}

/**
 * `sandbox.exec`'s params (the Go side's `ExecParams`). The host fills in `sandboxId`; `stdin` is base64. With no
 * `timeoutMs` a foreground command has the tier's default limit (the guest's 120 s, an isolate's 30 s).
 */
export interface HostExecParams {
	readonly command: string;
	readonly cwd?: string;
	readonly env?: { readonly [name: string]: string };
	readonly stdin?: string;
	readonly timeoutMs?: number;
	/** Kantel's command ID (`execControl`): what `sandbox.exec.kill` and `sandbox.exec.get` name it by. */
	readonly commandId?: string;
	/**
	 * With `commandId` (`execControl`): answered at once with a `HostExecStatus` (`running`); the command runs with no
	 * limit but `timeoutMs` (an isolate's has its default), and its result is `sandbox.exec.get`'s once it ends.
	 */
	readonly detached?: boolean;
}

/** What a command ended with: `sandbox.exec`'s answer, and an ended `HostExecStatus`'s `result`. */
export interface HostExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly truncated?: boolean;
	readonly timedOut?: boolean;
	readonly durationMs?: number;
}

/** `sandbox.exec.get`'s and `sandbox.exec.kill`'s params: a command by Kantel's ID. */
export interface HostExecRef {
	readonly commandId: string;
	/** For a get: hold the answer up to this long (at most `HOST_EXEC_MAX_WAIT_MS`) for a running command to end. */
	readonly waitMs?: number;
}

/** The longest a host holds a `sandbox.exec.get` for its command to end (the Go side's `ExecMaxWaitMs`). */
export const HOST_EXEC_MAX_WAIT_MS = 60_000;

/** A command by its ID: a detached `sandbox.exec`'s answer, and `sandbox.exec.get`'s. */
export interface HostExecStatus {
	readonly commandId: string;
	readonly state: "running" | "exited";
	readonly pid?: number;
	/** Once it has ended. */
	readonly result?: HostExecResult;
	/**
	 * While it runs, from a host whose sandbox keeps it (the guest's start of each stream, to its cap): its output so far.
	 * Only ever more of the same. Absent from an older host, or one that keeps no output until a command ends.
	 */
	readonly stdout?: string;
	readonly stderr?: string;
	/** With `stdout`: the cap cut a stream. */
	readonly truncated?: boolean;
	/**
	 * On a detached start: the sandbox didn't answer it, so whether the command started is unknown. Kantel follows it by
	 * its ID as any; `sandbox.exec.get`'s `not_found` then means it never started.
	 */
	readonly unconfirmed?: boolean;
}

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
	/**
	 * The template builds (their snapshot IDs) the host has admitted and not yet ended, whose machines' memory and disk
	 * `freeMemoryMiB` and `freeDiskGiB` already leave out. Absent from a host from before it named them.
	 */
	readonly builds?: readonly string[];
	/** What takes the space on its disk, measured every few minutes. Absent until it first is, and from an older host. */
	readonly disk?: HostDiskUsage;
	/** Its memory: what sandboxes were given, use and may soon use, and what the machine has left. Absent from an older host. */
	readonly memory?: HostMemoryReport;
}

/**
 * How a host admits sandboxes' memory: by what they were given (`reserved`, against `maxRatio` times its capacity), or,
 * with memory over-commit on (experimental), by what they use (`used`).
 */
export type HostMemoryMode = "reserved" | "used";

/** How short of memory a host is: `tight` reclaims page cache, `refusing` refuses creates, `critical` ends processes. */
export type HostMemoryState = "ok" | "tight" | "refusing" | "critical";

/**
 * A host's memory, in MiB (apps/host/internal/memplan). `committedMiB` counts each microVM as its recent peak plus
 * headroom, at most its size; `reservedMiB` as its size.
 */
export interface HostMemoryReport {
	readonly mode: HostMemoryMode;
	/** The machine's memory (or kantel-host's control group's limit), what is kept for the host, and the rest. */
	readonly totalMiB: number;
	readonly reserveMiB: number;
	readonly capacityMiB: number;
	readonly reservedMiB: number;
	readonly committedMiB: number;
	/** What the microVMs' guests use, and what their processes hold of the host's memory (page cache too). */
	readonly guestUsedMiB: number;
	readonly residentMiB: number;
	readonly availableMiB: number;
	readonly swapUsedMiB: number;
	/** Memory pressure (PSI avg10), in percent. */
	readonly pressureSome: number;
	readonly pressureFull: number;
	readonly maxRatio: number;
	readonly state: HostMemoryState;
	/** When the machine's figures were read (epoch milliseconds); absent before they first were. */
	readonly measuredAt?: number;
	/**
	 * With `mode` `used`: what it admits against. `freeMemoryMiB` is then the largest single microVM it would admit, which
	 * isn't additive, so what is placed on it before its next report is counted against this (`freeMemoryOn`). Absent
	 * from a host that predates it.
	 */
	readonly admission?: HostMemoryAdmission;
}

/**
 * What a host admitting by use has left, in its admission units (apps/host/internal/memplan): `reservableMiB` of sizes
 * before its cap, and `committableMiB` of committed memory. A new microVM of size S costs S of the first and
 * min(S, startMiB + headroom(S)) of the second, headroom(S) = min(S, max(headroomMiB, S × headroomPercent / 100)); a
 * template build costs S of both.
 */
export interface HostMemoryAdmission {
	readonly reservableMiB: number;
	readonly committableMiB: number;
	readonly startMiB: number;
	readonly headroomMiB: number;
	readonly headroomPercent: number;
}

/**
 * What takes the space on the filesystem holding a host's files, in bytes, counting only files on that filesystem. Each
 * file counts once, in the first of these it is in: bundle images, base images, templates, sandboxes, snapshots (memory
 * a stop's snapshot shares with its sandbox counts for the sandbox). Which snapshots are saved isn't the host's to say:
 * the compute plane splits `snapshotsBytes` by its own records. `otherBytes` is the rest of the used space: the
 * operating system, logs, other programs.
 */
export interface HostDiskUsage {
	readonly totalBytes: number;
	readonly usedBytes: number;
	readonly snapshotsBytes: number;
	/**
	 * `snapshotsBytes` by snapshot, the same files: each one's that no other holds, by its ID, and those several hold, by
	 * their holders (`HostSharedBytes`). The compute plane counts for saved what its saved snapshots hold, each group
	 * once.
	 */
	readonly snapshotOwnBytes?: { readonly [snapshotId: string]: number };
	readonly snapshotShared?: readonly { readonly snapshots: readonly string[]; readonly bytes: number }[];
	readonly sandboxesBytes: number;
	readonly imagesBytes: number;
	readonly templatesBytes: number;
	readonly bundlesBytes: number;
	readonly otherBytes: number;
	/** When it was measured (epoch milliseconds). */
	readonly measuredAt: number;
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
	/**
	 * With `mounts`: when the host last set them (unix milliseconds, the host's clock, later each time). Reports of a
	 * sandbox's mounts (a call's answer, a `sandbox.mounts` event, the replay after a reconnect) are ordered by it.
	 */
	readonly mountsAt?: number;
	/** What a microVM's image has, as its guest agent found it; absent from a host too old to say. */
	readonly guest?: HostGuest;
	/**
	 * `unresponsive` while a running microVM's guest agent doesn't answer (`HOST_FEATURES.guestHealth`), with
	 * `healthReason` saying why in words; absent while it answers, and from a host without the feature.
	 */
	readonly health?: string;
	readonly healthReason?: string;
	/** When its `health` last changed (the host's clock, ms), which orders reports of it; absent: it never has. */
	readonly healthAt?: number;
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
	/** The browser alone, on a display of its own with a stream of it; absent from an agent too old to say. */
	readonly browserSurface?: HostGuestFeature;
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
	/** What of `sizeBytes` is in files no other snapshot has (`HOST_FEATURES.snapshotSizes`). */
	readonly uniqueBytes?: number;
	/** On `snapshot.keep`'s answer: the groups of files it shares with other snapshots (`HostSharedBytes`). */
	readonly shared?: readonly HostSharedBytes[] | null;
}

/**
 * The bytes of the files a set of a host's snapshots (`snapshots`, their IDs) all hold and no other does: files linked
 * into several (a kept copy and its source, say). On `snapshot.list`'s answer beside the snapshots
 * (`HOST_FEATURES.snapshotSizes`), one entry per set of holders. Kantel counts each once, for one holder.
 */
export interface HostSharedBytes {
	readonly snapshots: readonly string[];
	readonly bytes: number;
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
	/**
	 * From a host with `usage-acks`: the tick's place in its `run`, from 1 up by one per tick taken (a tick the host's
	 * bounded backlog dropped leaves a gap). Kantel acknowledges a tick by it (`usage.ack`), and takes a tick at most once
	 * by it: a tick sent again after a reconnect whose `seq` it has taken already is acknowledged and not taken again.
	 */
	readonly seq?: number;
	/**
	 * With `seq`: which run of the host's sampler it counts in, chosen when kantel-host starts, so a restarted host's
	 * `seq` starting again at 1 isn't taken for ticks Kantel has already had.
	 */
	readonly run?: string;
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
	 * As kantel-host measures it, with nothing run in the sandbox (`SandboxUsage` in apps/host/internal/proto/proto.go): a
	 * microVM's guest's own count of its used memory, MemTotal - MemAvailable as its balloon driver reports them to
	 * Firecracker (`memSource` `guest`: page cache not counted, and it falls when the guest frees memory); else, for a VM
	 * without those figures, its Firecracker process's resident memory (`rss`: the guest memory it has touched, page cache
	 * included, and the VMM's own; it never falls). An isolate's even share of its account's runtime's resident memory.
	 */
	readonly memUsedBytes: number;
	/** A microVM's size's memory; an isolate's even share of its account's runtime's memory limit. */
	readonly memLimitBytes: number;
	/**
	 * Where `memUsedBytes` came from: `guest` (the guest's own count) or `rss` (the host process's resident memory). A host
	 * that predates it sends none, and its figures are all `rss`.
	 */
	readonly memSource?: HostMemorySource;
	/**
	 * A microVM's own disk as its guest counts it (df's used and size), from its agent: both or neither. Neither for an
	 * isolate, or from a host or guest agent that predates them.
	 */
	readonly diskUsedBytes?: number;
	readonly diskTotalBytes?: number;
	/**
	 * The share of the interval, 0 to 1, in which at least one of a microVM's guest tasks waited on IO (its kernel's IO
	 * pressure, "some"). None from a guest without pressure figures (booted without psi=1) or for its first reading.
	 */
	readonly ioPressure?: number;
	/**
	 * How many processes a microVM's guest kernel has killed for memory since it booted (its `/proc/vmstat` `oom_kill`):
	 * a count that grows until the VM boots again. None from a guest agent that predates it or didn't answer in time.
	 */
	readonly oomKills?: number;
	/**
	 * A microVM's guest memory pressure, its kernel's ten-second averages as shares, 0 to 1: of the last ten seconds, how
	 * much at least one task (`some`), or every task that wanted to run (`full`), was stalled on memory. None from a
	 * guest without pressure figures, or one whose agent predates them or didn't answer in time.
	 */
	readonly memPressureSome?: number;
	readonly memPressureFull?: number;
}

/** `HostSandboxUsage.memSource`. */
export type HostMemorySource = "guest" | "rss";

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
	/**
	 * This Kantel acknowledges usage ticks (`HOST_FEATURES.usageAcks`): once the gateway holding the host's connection
	 * has taken a tick into its series it answers `{ "type": "usage.ack", "acked": seq }`, covering that tick and every
	 * earlier one. A connection's first welcome decides it for the connection.
	 */
	readonly usageAcks?: boolean;
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
		| "usage.ack"
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
	 * Kantel), Kantel's reader's of a read (Kantel → host). For `usage.ack` (Kantel → host): the `seq` of the newest
	 * usage tick taken, which covers every earlier one of the run.
	 */
	readonly acked?: number;
}

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
	/** `HostExecRef` (`execControl`): a command's `HostExecStatus`, or `not_found` once the host no longer knows it. */
	execGet: "sandbox.exec.get",
	/**
	 * `HostExecRef` (`execControl`): kills a running command and its process group; answered `{ killed }`, false for one
	 * that had already ended.
	 */
	execKill: "sandbox.exec.kill",
	fileRead: "sandbox.files.read",
	fileWrite: "sandbox.files.write",
	fileDelete: "sandbox.files.delete",
	fileList: "sandbox.files.list",
	/** `HostProcessesParams` (`HOST_FEATURES.processes`): a running sandbox's busiest processes, `HostProcessList`. */
	processes: "sandbox.processes",
	snapshotList: "snapshot.list",
	snapshotSave: "snapshot.save",
	/** `HostSnapshotKeep` (`HOST_FEATURES.snapshotKeep`): a saved snapshot of another, answered as `snapshot.save`. */
	snapshotKeep: "snapshot.keep",
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
	/** Builds a template snapshot: `HostTemplateBuild`, answered with `HostTemplateBuilt`. */
	templateBuild: "template.build",
	/** Deletes a template snapshot's directory, `{ snapshotId }`, and nothing else. Result `{ ok: true }`. */
	templateDelete: "template.delete",
} as const;

/** An event a host sends when a sandbox's mounts change status after its create answered: `HostSandbox.mounts`. */
export const HOST_EVENT_MOUNTS = "sandbox.mounts";

export type HostMethod = (typeof HostMethods)[keyof typeof HostMethods];

/**
 * A template's image: a Kantel base image, which the host pulls by digest from its operator's registry
 * (`templateRegistry`), never building one.
 */
interface HostTemplateBase {
	/** The base image's name, such as `kantel/sandbox`: a repository path, with no registry, tag or digest. */
	readonly baseImage: string;
	/** Absent while the default base's channel has no published digest: the host's own sandbox image. */
	readonly baseDigest?: string;
}

/**
 * A template's custom image, built or pulled in a build microVM (`HOST_FEATURES.templateImages`). `scope` is the
 * template, its version and its rebuild (`<templateId>@<version>#<epoch>`): a rebuild builds or pulls it again.
 */
export type HostTemplateImage =
	| { readonly kind: "dockerfile"; readonly dockerfile: string; readonly scope: string }
	| { readonly kind: "image"; readonly ref: string; readonly scope: string };

/** How a sandbox made from a template boots, on `sandbox.create` (microVMs only). */
export interface HostTemplateBoot extends HostTemplateBase {
	/**
	 * Its custom image; a fresh boot boots the root filesystem `rootfsKey` names, which a build on the host made (a
	 * create never builds one).
	 */
	readonly image?: HostTemplateImage;
	/** The image's root filesystem on the host (`images/templates/<key>.ext4`); absent, the host works it out. */
	readonly rootfsKey?: string;
	/** Run as root in a sandbox booted fresh (no `snapshot`), once it has its identity. */
	readonly setup?: string;
	/**
	 * A template snapshot on that host (`template.build`'s `ref`) to restore, only when it was built with the create's
	 * vCPUs and memory (its `size`'s, or its custom shape's); absent, or built as another machine, the image boots fresh.
	 */
	readonly snapshot?: string;
}

/**
 * `template.build`: the base image booted once, its setup run as root, snapshotted as `snapshotId`. The host admits it
 * against its memory budget and free disk, refusing it (`capacity`) while its sandboxes and other builds leave too
 * little, and counts it in its reports' free memory and disk, naming it (`HostCapacity.builds`), until its machine has
 * gone.
 */
export interface HostTemplateBuild extends HostTemplateBase {
	readonly snapshotId: string;
	/** Its custom image, built in a build microVM under `egress` and the operator's registries; absent, the base. */
	readonly image?: HostTemplateImage;
	readonly setup?: string;
	readonly env?: { readonly [name: string]: string };
	readonly vcpus: number;
	readonly memoryMiB: number;
	/** The disk a create of the vCPUs and memory gets on the host: its named size's, or its custom shape's (`diskFor`). */
	readonly diskGiB: number;
	readonly keyHash: string;
	/** The build's way out while its setup runs: the template's grants. */
	readonly egress?: HostEgress;
	/** The account the template is of. */
	readonly owner?: string;
}

/** `template.build`'s answer: `ref` names the snapshot on its host. */
export interface HostTemplateBuilt {
	readonly ref: string;
	/** The pulled base's image ID; for a custom image, its resolved digest (a reference's) or built image ID. */
	readonly imageDigest?: string;
	/** A custom image's root filesystem on the host, which a create's fresh boot names (`HostTemplateBoot.rootfsKey`). */
	readonly rootfsKey?: string;
	/** A custom image's provenance: its kind, and the Dockerfile's digest or the reference pulled. */
	readonly source?: "dockerfile" | "image";
	readonly dockerfileDigest?: string;
	readonly imageRef?: string;
	readonly sizeBytes: number;
	readonly timings?: { readonly [step: string]: number };
}

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
