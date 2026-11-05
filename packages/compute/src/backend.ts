/**
 * The seam between the control plane and the machines: what the API asks of wherever sandboxes really run. The host
 * scheduler (lane 2, not built yet) implements it by placing sandboxes on the hosts that dialled in and relaying each
 * call to the host agent; until then `createStubBackend` (`stub-backend.ts`) implements it in memory, with a real
 * just-bash shell per sandbox.
 *
 * The control plane owns every record (sandboxes, snapshots, commands, ports); the backend owns only machines and the
 * bytes of their disks. A snapshot is named to the backend by an opaque `ref` it answered, so the control plane never
 * sees a host's address or a provider's ID. Every method rejects with a `KantelError`: `not_found` for a path or a
 * machine it doesn't have, `not_supported` for what the sandbox's type can't do (SSH on an isolate), `unavailable` when
 * no host can take the work.
 */
import type { computeSchema } from "@kantel/api";
import type { BackendUsageReport } from "./usage-series.ts";

/** A sandbox's vCPUs (0 for an isolate, which shares its account's VM's CPU) and memory, as asked for. */
export interface BackendShape {
	readonly vcpus: number;
	readonly memoryMb: number;
}

/** A host feature: it makes microVMs of any shape, not only its named sizes (`@kantel/hosts`'s `custom-shapes`). */
export const CUSTOM_SHAPES_FEATURE = "custom-shapes";

/** A size a deployment offers for microVMs, and the resources it stands for. */
export interface BackendSize {
	readonly name: computeSchema.SandboxSizeName;
	readonly vcpus: number;
	readonly memoryMb: number;
	readonly diskGb: number;
}

/** A host as the backend reports it, before the super-admin's name, labels and drain are applied. */
export interface BackendHost {
	readonly id: string;
	readonly name: string;
	readonly version?: string;
	readonly os?: string;
	readonly arch?: "x86_64" | "aarch64";
	readonly tiers: readonly computeSchema.SandboxType[];
	readonly kvm: boolean;
	readonly nestedVirtualisation: boolean;
	/**
	 * What it does beyond what every host does; `egress-policy`: it enforces egress grants and protected variables;
	 * `usage`: it sends its own usage ticks, so none is read by running a command in a sandbox. Absent: what the backend's
	 * sandboxes get is enforced however they run (the stub).
	 */
	readonly features?: readonly string[];
	readonly capacity: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb: number };
	/** Its named microVM sizes (the presets). Absent: the deployment's `sizes`. */
	readonly sizes?: readonly BackendSize[];
	readonly labels: { readonly [key: string]: string };
	/** Whether it is connected now; absent, it always is (the stub). A host that isn't is `unreachable`. */
	readonly connected?: boolean;
	/** The account it was added to as one of its own hosts, which alone may use it; absent for a shared host. */
	readonly accountId?: string;
	readonly lastSeenAt?: number;
}

/** What the deployment can run now. */
export interface BackendCapabilities {
	readonly types: readonly computeSchema.SandboxType[];
	readonly sizes: readonly BackendSize[];
	readonly defaultImage?: string;
	readonly hosts: readonly BackendHost[];
}

/** A machine to make. */
export interface SandboxSpec {
	readonly sandboxId: string;
	readonly accountId: string;
	readonly type: computeSchema.SandboxType;
	/** Its name under the sandbox domain, which its port URLs start with. */
	readonly subdomain: string;
	readonly size?: computeSchema.SandboxSizeName;
	/**
	 * What it asked for: a microVM's vCPUs and memory (`size` is then the preset it matches, if any), or an isolate's
	 * memory (`vcpus` 0). Absent: `size`, or the default.
	 */
	readonly shape?: BackendShape;
	readonly image?: string;
	/** Environment variables every command sees. */
	readonly env: { readonly [name: string]: string };
	/** The hosts it may be placed on: online, not draining, with the asked-for labels and type. */
	readonly eligibleHosts: readonly string[];
	/** Start from this snapshot's disk (a `ref` the backend answered); absent, from an empty disk. */
	readonly fromSnapshot?: string;
	/** The account's egress proxy settings when they're on; a backend that can't enforce them ignores them. */
	readonly egress?: BackendEgress;
	/** Made from a template (microVMs only): from its built snapshot, or by booting its base image fresh. */
	readonly template?: SandboxTemplateBoot;
	/**
	 * Read-only mounts (experimental, `KANTEL_MOUNTS`): microVMs only. A backend answers each one's status in
	 * `Placement.mounts`; one it doesn't answer is marked `failed` by the service, so a backend that predates mounts
	 * never leaves one looking mounted.
	 */
	readonly mounts?: readonly BackendMount[];
}

/**
 * A mount as the backend is given it. A bundle's bytes are fetched by digest (`ComputeService.bundleForHost`, or over
 * HTTP at `GET /v1/hosts/bundles/{digest}?sandboxId=` with the host's credential); a bucket source's settings and
 * opened credentials by ID (`ComputeService.bucketSourceForHost`, `bucket.fetch` over the host's link). Neither is
 * sent with the spec, so no credential rides a create.
 */
export interface BackendMount {
	readonly path: string;
	readonly source: computeSchema.MountSource;
}

/** A mount's status as the backend reports it, by path. */
export interface BackendMountStatus {
	readonly path: string;
	readonly status: computeSchema.MountStatus;
	readonly error?: string;
	/**
	 * The backend answered this one itself: its host can't do that kind of mount, so was never sent it and will never
	 * report it. Kept however the host's own statuses are ordered (`mountsAfter`).
	 */
	readonly unsent?: true;
}

/**
 * A template's custom image as a backend builds it (`TemplateBuildSpec.image`) or boots it (`SandboxTemplateBoot.image`):
 * a Dockerfile, or an image reference, built or pulled only in an isolated build microVM whose sole way out is the
 * sandbox egress proxy, never on a host's Docker. `scope` is the template, its version and its rebuild
 * (`<templateId>@<version>#<epoch>`): a rebuild builds or pulls it again.
 */
export type BackendTemplateImage =
	| { readonly kind: "dockerfile"; readonly dockerfile: string; readonly scope: string }
	| { readonly kind: "image"; readonly ref: string; readonly scope: string };

/**
 * How a sandbox made from a template boots, as its spec's `shape` either way: a snapshot is picked only when it was
 * built with those vCPUs and memory, so a restore and a fresh boot get the same machine.
 */
export interface SandboxTemplateBoot {
	/**
	 * Its custom image, which only a host that built it boots: a fresh boot boots the root filesystem `rootfsKey` names on
	 * its host, which a build there made (`BuiltTemplate.rootfsKey`), and never builds one. The spec's eligible hosts are
	 * only hosts holding it.
	 */
	readonly image?: BackendTemplateImage;
	readonly rootfsKey?: string;
	/** The custom image's digest (`BuiltTemplate.imageDigest`): what the sandbox records it boots. */
	readonly imageDigest?: string;
	/** The base image's name, such as `kantel/sandbox`, which a host pulls from its operator's registry by digest. */
	readonly baseImage: string;
	/** Empty while the default base's channel has no published digest: each host's own sandbox image. */
	readonly baseDigest: string;
	readonly setup?: string;
	/**
	 * A template snapshot's `ref` (`BuiltTemplate.ref`) to start from, on the host that built it, which must be one of
	 * the spec's eligible hosts. Absent: a fresh boot, which boots the template's base image and runs its setup in the
	 * new machine. A backend that no longer holds the snapshot boots fresh too, and one whose host has no room for the
	 * machine boots it fresh on another eligible host, either way saying so (`Placement.bootedFresh`): the snapshot only
	 * speeds a create up.
	 */
	readonly snapshot?: string;
}

/** A machine's vCPUs, memory and disk, as its host gave them. */
export interface MachineResources {
	readonly vcpus: number;
	readonly memoryMb: number;
	readonly diskGb: number;
}

/** A host's runtime, which a template snapshot is only good for: the guest kernel and Firecracker it runs. */
export interface TemplateRuntime {
	readonly hostId: string;
	readonly kernel: string;
	readonly firecracker: string;
	/** It builds templates' custom images, in a build microVM; only such a host is given one to build or boot. */
	readonly customImages?: boolean;
}

/** A template snapshot to build: the template's base image booted once, its setup run, then snapshotted. */
export interface TemplateBuildSpec {
	/** The template snapshot's ID, `tsn_…`, which names its bytes on the host. */
	readonly snapshotId: string;
	readonly accountId: string;
	readonly templateId: string;
	readonly version: number;
	/** As `SandboxTemplateBoot.baseImage`. */
	readonly baseImage: string;
	/** As `SandboxTemplateBoot.baseDigest`. */
	readonly baseDigest: string;
	/**
	 * The template's vCPUs and memory to build it as, which its sandboxes ask for too: its host gives the disk it would
	 * give a create of that shape, so a restore of it is the machine a fresh boot would be.
	 */
	readonly shape: BackendShape;
	readonly env: { readonly [name: string]: string };
	readonly setup?: string;
	/**
	 * Its custom image, built or pulled in a build microVM under `egress` (and the registries the host's operator allows)
	 * before the boot; absent, the base. Only a runtime with `customImages` is given one.
	 */
	readonly image?: BackendTemplateImage;
	/** The template's grants (and the account's proxy settings), for the build's boot, and a custom image's build. */
	readonly egress?: BackendEgress;
	readonly keyHash: string;
	/** The host to build on: the one whose runtime the key names. */
	readonly hostId: string;
}

/**
 * A template snapshot's bytes to delete: by `ref` once its build answered, else by its ID on the host it was built on,
 * which may have made them although its build's answer never came (it timed out, say).
 */
export interface TemplateSnapshotBytes {
	readonly snapshotId: string;
	readonly hostId: string;
	readonly ref?: string;
}

/** A template snapshot built: its opaque reference, the host holding it, and its size. */
export interface BuiltTemplate {
	readonly ref: string;
	readonly hostId: string;
	/** The image booted: a pulled base's ID, or a custom image's digest (a reference's resolved one, a build's image ID). */
	readonly imageDigest?: string;
	readonly sizeBytes: number;
	/** A custom image's root filesystem on its host, which a fresh boot there names (`SandboxTemplateBoot.rootfsKey`). */
	readonly rootfsKey?: string;
}

/**
 * Where a sandbox's outbound traffic may go, from its account's proxy settings and its environment's and its own grants,
 * as the backend applies them when it boots the machine (create, start, resume, fork), and on `updateEgress`.
 */
export interface BackendEgress {
	readonly defaultAction: "allow" | "deny";
	readonly allow: readonly string[];
	readonly deny: readonly string[];
	/** Another proxy allowed requests go on to, with the headers (secret values) it's sent. */
	readonly upstream?: { readonly url: string; readonly headers: { readonly [name: string]: string } };
	/** Tell the upstream which sandbox and account each request came from, signed. */
	readonly attribution: boolean;
	/**
	 * Present only when the sandbox has protected variables: the hosts their bindings name (patterns, never a value),
	 * which the host's proxy intercepts with a CA of the sandbox's own, and the version of the sandbox's protected values,
	 * which the host fetches over its link to Kantel (`secrets.fetch`).
	 */
	readonly protected?: { readonly version: number; readonly intercept: readonly string[] };
	/** The environment's grants, then the sandbox's own, on top of `allow` and `deny`; deny wins. */
	readonly grants?: readonly BackendEgressGrant[];
	/**
	 * The sandbox's `egressRevision` when this was read: a backend that orders updates ignores one older than the egress
	 * the sandbox has.
	 */
	readonly revision?: number;
}

/** An egress grant as the host's proxy applies it; one with methods or paths makes its host intercepted too. */
export interface BackendEgressGrant {
	readonly action: "allow" | "deny";
	readonly host: string;
	readonly methods?: readonly string[];
	readonly paths?: readonly string[];
	/** The rule as the egress log names it, such as `deny DELETE api.github.com /repos/*`. */
	readonly rule: string;
}

/** Where a machine was placed, and what it can do. */
export interface Placement {
	readonly hostId: string;
	readonly resources?: MachineResources;
	readonly capabilities: computeSchema.SandboxCapabilities;
	/**
	 * The base image version its root file system is: a host images version (`host-images-20261104.812`) for a sandbox
	 * on a host with image patching, or a container image's `sha256:` digest. Absent where the backend doesn't know (the
	 * stub, a host whose images aren't versioned), and the sandbox's record keeps what it had.
	 */
	readonly base?: string;
	/**
	 * With `base`: when the machine was put on it, by the backend's own clock (a host's root filesystem link time).
	 * The record keeps it, and a later report of the base replaces it only when it says a later time.
	 */
	readonly baseAt?: number;
	/**
	 * The status of each of the spec's or boot's mounts the backend handled, by path. A mount it doesn't answer for is
	 * `failed` ("this host can't mount …"). A later change (`pending` to `ready`) comes through
	 * `ComputeService.reportMounts`.
	 */
	readonly mounts?: readonly BackendMountStatus[];
	/**
	 * A create from a template snapshot that booted the template fresh instead, running its setup: its host no longer
	 * held the snapshot (or couldn't restore it), or had no room and another host booted it.
	 */
	readonly bootedFresh?: boolean;
	/**
	 * With `mounts`: when the backend set them (its own clock, later with each change), which orders them against its
	 * later reports (`ComputeService.reportMounts`). Absent where the backend doesn't say.
	 */
	readonly mountsAt?: number;
}

/** How to boot a machine for a sandbox that has none. */
export interface BootOptions {
	/** The disk to boot from: the sandbox's newest snapshot. Absent, an empty disk. */
	readonly fromSnapshot?: string;
	readonly size?: computeSchema.SandboxSizeName;
	/**
	 * A microVM's vCPUs and memory as it now is: kept on a restart, absent once a restart names another size (then it is
	 * that size). A backend that can change a stopped machine's shape boots it as this.
	 */
	readonly shape?: BackendShape;
	readonly env: { readonly [name: string]: string };
	readonly eligibleHosts: readonly string[];
	readonly egress?: BackendEgress;
	/** The sandbox's mounts, mounted again on the new machine. */
	readonly mounts?: readonly BackendMount[];
	/**
	 * The revision of the sandbox's egress the boot carries, with no egress too: the boot states its egress (none is the
	 * host's default), and an update read before it is refused as older.
	 */
	readonly egressRevision?: number;
	/**
	 * On `start` only (a cold boot): move the sandbox onto its host's current base images first, keeping its own disk
	 * and dropping any memory it kept (image patching, `restartSandboxOnLatest`). A backend with no versioned images (the
	 * stub) ignores it, and so does a host without the `image-patching` feature.
	 */
	readonly rebase?: boolean;
	/**
	 * With `rebase`: the base version the rebase is to land on (the index's `stable`), which the machine refuses to boot
	 * onto any other. Absent, the host's current one.
	 */
	readonly rebaseTo?: string;
}

/** A snapshot the backend took: its opaque reference and how large it is. */
export interface TakenSnapshot {
	readonly ref: string;
	readonly sizeBytes: number;
	/** The base image version its root file system is, as `Placement.base`; absent where the backend doesn't know. */
	readonly base?: string;
}

export interface ExecRequest {
	readonly command: string;
	/** Absolute. Default the sandbox user's home. */
	readonly cwd?: string;
	readonly env?: { readonly [name: string]: string };
	readonly stdin?: string;
	/** Kill it after this long; absent, no limit. */
	readonly timeoutMs?: number;
	/**
	 * Stops waiting for it when aborted. Whether the command itself stops too is the backend's: `killCommand` is what
	 * stops it, and a backend with one may leave a detached command running.
	 */
	readonly signal?: AbortSignal;
	/** The compute API's ID for it, which `killCommand` and `commandResult` name it by. */
	readonly commandId?: string;
	/**
	 * Started to run in the background, so its end, not one call, is what `exec` waits for: it runs with no limit but
	 * `timeoutMs`, and `commandResult` can fetch its result later, from any gateway, where the backend keeps it.
	 */
	readonly detached?: boolean;
}

/**
 * What a backend's `exec` of a detached command rejects with when its `signal` ended the wait while the command runs
 * on where `commandResult` can fetch it: the compute API then leaves it `running`, for `getCommand` to fetch its end,
 * rather than recording a failure. Any other rejection is the command's end.
 */
export class DetachedWaitEnded extends Error {
	constructor() {
		super("Kantel stopped waiting for the command; it runs on, and its end can be fetched");
		this.name = "DetachedWaitEnded";
	}
}

export function isDetachedWaitEnded(error: unknown): boolean {
	return error instanceof Error && error.name === "DetachedWaitEnded";
}

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

/**
 * A running command's output so far, as its backend keeps it: `commandResult`'s answer while it runs, from a backend
 * that keeps it. Only ever more of the same output: what it keeps is the start of each stream, up to its cap.
 */
export interface CommandProgress {
	readonly running: true;
	readonly stdout: string;
	readonly stderr: string;
	/** The backend's cap cut a stream. */
	readonly truncated?: boolean;
}

export function isCommandProgress(answer: ExecResult | CommandProgress): answer is CommandProgress {
	return (answer as CommandProgress).running === true;
}

/** A file being read as a stream: its size, when known up front, and its bytes. */
export interface FileStream {
	readonly size?: number;
	readonly body: ReadableStream<Uint8Array>;
}

/** The largest body the service collects to write with `writeFile`, for a backend without `writeFileStream`. */
export const MAX_UNSTREAMED_WRITE_BYTES = 64 * 1024 * 1024;

/** A part of a file: at most `length` bytes from `offset`. */
export interface FileRange {
	readonly offset: number;
	readonly length: number;
}

/** What a read answers: the bytes read, and the whole file's size. */
export interface FileRead {
	readonly bytes: Uint8Array;
	readonly size: number;
}

/** One entry of a directory. */
export interface BackendFileEntry {
	readonly name: string;
	/** Absolute. */
	readonly path: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly size: number;
	readonly modifiedAt?: number;
}

export interface SshGrant {
	readonly host: string;
	readonly port: number;
	readonly user: string;
	readonly privateKey?: string;
	readonly hostKeyFingerprint?: string;
	/** The command that connects, when it isn't `ssh -p {port} {user}@{host}` (a ProxyCommand through a tunnel). */
	readonly command?: string;
	/** A WebSocket URL carrying the sandbox's sshd as binary frames, when SSH goes through a tunnel, not a gateway. */
	readonly proxyUrl?: string;
}

export type { BackendUsageReport };

/** A CPU and memory reading of one running sandbox. */
export interface UsageSample {
	/** CPU utilisation, 0 to 1. */
	readonly cpu: number;
	readonly memoryBytes: number;
}

/**
 * Where sandboxes run. Lane 2's host scheduler implements it over the hosts that joined; `createStubBackend` implements
 * it in memory. Paths are absolute (the control plane resolves relative ones against the user's home).
 */
export interface SandboxBackend {
	/** The types, sizes and hosts available now. */
	capabilities(): Promise<BackendCapabilities>;
	/** Places and boots a new machine. */
	create(spec: SandboxSpec): Promise<Placement>;
	/** Boots a stopped, paused or errored sandbox fresh from a disk snapshot; a paused one's memory is let go. */
	start(sandboxId: string, options: BootOptions): Promise<Placement>;
	/**
	 * Image patching: whether a `start` with `rebase` (and `rebaseTo`) can land now, checked before a running sandbox is
	 * stopped for it. Rejects when it can't: the machine its disk is on isn't among `eligibleHosts`, doesn't patch
	 * images (`not_supported`), or isn't on `rebaseTo` yet (`unavailable`). Absent where a backend has no versioned
	 * images (a rebase there is a plain start). Answers whether the machine is running there, where its host says: a
	 * sandbox recorded as `error` may still be, and is stopped before the rebase's cold boot.
	 */
	prepareRebase?(
		sandboxId: string,
		options: { readonly eligibleHosts: readonly string[]; readonly rebaseTo?: string },
	): Promise<{ readonly running?: boolean } | undefined>;
	/**
	 * Saves the disk as a snapshot and lets the machine go, or with `keepMemory` pauses it, keeping its memory too
	 * (`not_supported` where the type can't pause). Answers the disk snapshot taken.
	 */
	stop(sandboxId: string, options: { readonly keepMemory: boolean }): Promise<TakenSnapshot>;
	/** Carries a paused sandbox on from its memory, or boots a stopped one from `fromSnapshot`. */
	resume(sandboxId: string, options: BootOptions): Promise<Placement>;
	/**
	 * Makes one new machine per target, each a copy of the source's snapshot `snapshot`, or of its live disk when absent
	 * (the source must be running then).
	 */
	fork(
		source: { readonly sandboxId: string; readonly snapshot?: string },
		targets: readonly SandboxSpec[],
	): Promise<Placement[]>;
	/** Restarts a sandbox's machine on its disk as it is (or on `fromSnapshot` when the disk is gone); memory is lost. */
	recover(sandboxId: string, options: BootOptions): Promise<Placement>;
	/** Lets the machine go for good; its snapshots are deleted separately. */
	destroy(sandboxId: string): Promise<void>;
	/**
	 * Streams a file out of a running sandbox, whatever its size (signed download URLs). Absent, or refusing with
	 * `not_supported` (the sandbox's host can't), the service reads it with `readFile` a part at a time.
	 */
	readFileStream?(sandboxId: string, path: string): Promise<FileStream>;
	/**
	 * Streams `body` into a file, making its directories, replacing what was there only once the whole body has arrived
	 * (signed upload URLs, archives). Absent, or refusing with `not_supported` before it reads any of `body`, the service
	 * collects the body (up to `MAX_UNSTREAMED_WRITE_BYTES`) and uses `writeFile`.
	 */
	writeFileStream?(
		sandboxId: string,
		path: string,
		body: ReadableStream<Uint8Array>,
		mode?: number,
	): Promise<{ readonly size: number }>;
	/**
	 * Extracts the tar at `archive` (already checked: see `TarCheck`) into the directory `target`, making it, then
	 * deletes the tar. The sandbox's own programs, shell and environment have no part in it, so a caller with only
	 * `files` runs nothing in the sandbox (`PUT /sandboxes/{id}/files/archive`). Absent, or `not_supported`, archives
	 * aren't extracted there.
	 */
	extractArchive?(sandboxId: string, archive: string, target: string): Promise<void>;
	/**
	 * The host a sandbox is placed on now, as the backend's scheduler recorded it, even while it is being booted there:
	 * what a host's fetch of a starting sandbox's mounts' sources is checked against. Absent, a starting sandbox's
	 * sources go to no host until it is placed.
	 */
	placedOn?(sandboxId: string): Promise<string | undefined>;
	/** Runs a command line and answers when it ends, or at its timeout. */
	exec(sandboxId: string, request: ExecRequest): Promise<ExecResult>;
	/**
	 * Kills a running command by its `ExecRequest.commandId`, and what it started. It throws `not_supported` where the
	 * sandbox can't stop a command (a host too old). Absent, a command is stopped only by its `signal`.
	 */
	killCommand?(sandboxId: string, commandId: string): Promise<void>;
	/**
	 * A detached command's result once it has ended; while it runs, its output so far (`CommandProgress`) where the
	 * backend keeps it, else `undefined`; `not_found` once the backend no longer knows it. Absent, or `not_supported`, a
	 * detached command's result is only what its `exec` answers.
	 */
	commandResult?(sandboxId: string, commandId: string): Promise<ExecResult | CommandProgress | undefined>;
	/** Reads a file, or with a range, at most `range.length` bytes of it from `range.offset`. */
	readFile(sandboxId: string, path: string, range?: FileRange): Promise<FileRead>;
	/** Writes a file, making its directories, replacing what was there. */
	writeFile(sandboxId: string, path: string, content: Uint8Array, mode?: number): Promise<BackendFileEntry>;
	/** Deletes a file, or a directory and everything in it. */
	deleteFile(sandboxId: string, path: string): Promise<void>;
	listFiles(sandboxId: string, path: string): Promise<BackendFileEntry[]>;
	/** Takes a snapshot of a running sandbox's disk without stopping it. */
	takeSnapshot(sandboxId: string): Promise<TakenSnapshot>;
	listSnapshotFiles(ref: string, path: string): Promise<BackendFileEntry[]>;
	readSnapshotFile(ref: string, path: string): Promise<Uint8Array>;
	deleteSnapshot(ref: string): Promise<void>;
	/**
	 * Gives a port its URL through the host's tunnel. Unless public, the URL carries a token, shown only in this answer.
	 * `grantee` (in this and the `open*` calls) names who asked, as `encodeGrantee` writes it, so a relay can end the
	 * access once theirs ends (`ComputeService.stillAllowed`).
	 */
	exposePort(
		sandboxId: string,
		port: number,
		options: { readonly public: boolean; readonly subdomain: string; readonly grantee?: string },
	): Promise<{ readonly url: string }>;
	hidePort(sandboxId: string, port: number): Promise<void>;
	openSsh(
		sandboxId: string,
		options: { readonly publicKey?: string; readonly ttlMinutes: number; readonly grantee?: string },
	): Promise<SshGrant>;
	openDesktop(
		sandboxId: string,
		options: { readonly viewOnly: boolean; readonly ttlMinutes: number; readonly grantee?: string },
	): Promise<{ readonly url: string; readonly embedUrl: string }>;
	/**
	 * The browser's live view and CDP URLs. `url` shows the browser alone, apart from the desktop, where the sandbox's
	 * machine runs it on a surface of its own, as the backend finds it on that machine now (a report kept from another
	 * boot of its image can be stale); else the desktop it runs on. The answer's `surface` says which (absent: `desktop`).
	 */
	openBrowser(
		sandboxId: string,
		options: { readonly viewOnly: boolean; readonly ttlMinutes: number; readonly grantee?: string },
	): Promise<{ readonly url: string; readonly cdpUrl: string; readonly surface?: "browser" | "desktop" }>;
	/**
	 * A tunnel to the host's E2E responder for the sandbox (`@kantel/e2e`), whose bytes the relay passes on unread, and
	 * the host's ID. Absent when sandboxes aren't on hosts (the stub).
	 */
	openE2E?(
		sandboxId: string,
		options: { readonly ttlMinutes: number; readonly grantee?: string },
	): Promise<{ readonly url: string; readonly hostId: string }>;
	/**
	 * A CPU and memory reading of a running sandbox, read when asked: the fallback for a host that doesn't send its
	 * readings (`ComputeService.recordUsage`) yet.
	 */
	usage(sandboxId: string): Promise<UsageSample>;
	/**
	 * The ticks a backend with no host to send them makes itself (the stub): one report per host for each tick after
	 * `since` up to `until`, oldest first, as a host would have sent them. Absent: its hosts send their own.
	 */
	usageReports?(since: number, until: number): Promise<BackendUsageReport[]>;
	/**
	 * The account's proxy settings changed: apply them to this running sandbox (undefined when they were turned off).
	 * Absent, sandboxes get them when they next boot.
	 */
	updateEgress?(sandboxId: string, egress: BackendEgress | undefined, revision?: number): Promise<void>;
	/**
	 * The sandbox's protected values changed (a rotation, a binding edit, a variable added or removed): the host drops
	 * what it holds of them, and fetches them again on the sandbox's next request. Absent, nothing holds them.
	 */
	updateSecrets?(sandboxId: string, version: number): Promise<void>;
	/**
	 * The runtime of each host that can build and boot template snapshots, one entry a host. Absent (with `buildTemplate`
	 * and `deleteTemplateSnapshot`), the backend has no templates, and their routes answer `not_supported`.
	 */
	templateRuntimes?(): Promise<TemplateRuntime[]>;
	/**
	 * Builds a template snapshot on `spec.hostId`; rejects with why when the build or its setup fails, and `exhausted`
	 * when the host has no room for the build now (it is tried again later).
	 */
	buildTemplate?(spec: TemplateBuildSpec): Promise<BuiltTemplate>;
	/**
	 * Deletes a template snapshot's bytes from its host, resolving once they are gone, or were never there. Never a user
	 * snapshot's (`deleteSnapshot`).
	 */
	deleteTemplateSnapshot?(bytes: TemplateSnapshotBytes): Promise<void>;
	/** The super-admin revoked a host: refuse its credential and drop its connection. Absent, nothing to do. */
	revokeHost?(hostId: string): Promise<void>;
	/** The super-admin renamed, relabelled or drained a host. Absent, nothing to do. */
	updateHost?(
		hostId: string,
		change: {
			readonly name?: string;
			readonly labels?: { readonly [key: string]: string };
			readonly draining?: boolean;
		},
	): Promise<void>;
}
