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
	 * What it does beyond what every host does; `egress-policy`: it enforces egress grants and protected variables.
	 * Absent: what the backend's sandboxes get is enforced however they run (the stub).
	 */
	readonly features?: readonly string[];
	readonly capacity: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb: number };
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
	readonly image?: string;
	/** Environment variables every command sees. */
	readonly env: { readonly [name: string]: string };
	/** The hosts it may be placed on: online, not draining, with the asked-for labels and type. */
	readonly eligibleHosts: readonly string[];
	/** Start from this snapshot's disk (a `ref` the backend answered); absent, from an empty disk. */
	readonly fromSnapshot?: string;
	/** The account's egress proxy settings when they're on; a backend that can't enforce them ignores them. */
	readonly egress?: BackendEgress;
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
	readonly resources?: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb: number };
	readonly capabilities: computeSchema.SandboxCapabilities;
	/**
	 * The base image version its root file system is: a host images version (`host-images-20261104.812`) for a sandbox
	 * on a host with image patching, or a container image's `sha256:` digest. Absent where the backend doesn't know (the
	 * stub, a host whose images aren't versioned), and the sandbox's record keeps what it had.
	 */
	readonly base?: string;
}

/** How to boot a machine for a sandbox that has none. */
export interface BootOptions {
	/** The disk to boot from: the sandbox's newest snapshot. Absent, an empty disk. */
	readonly fromSnapshot?: string;
	readonly size?: computeSchema.SandboxSizeName;
	readonly env: { readonly [name: string]: string };
	readonly eligibleHosts: readonly string[];
	readonly egress?: BackendEgress;
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
	/** Kills it when aborted. */
	readonly signal?: AbortSignal;
}

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

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
	/** Runs a command line and answers when it ends, or at its timeout. */
	exec(sandboxId: string, request: ExecRequest): Promise<ExecResult>;
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
	openBrowser(
		sandboxId: string,
		options: { readonly viewOnly: boolean; readonly ttlMinutes: number; readonly grantee?: string },
	): Promise<{ readonly url: string; readonly cdpUrl: string }>;
	/**
	 * A tunnel to the host's E2E responder for the sandbox (`@kantel/e2e`), whose bytes the relay passes on unread, and
	 * the host's ID. Absent when sandboxes aren't on hosts (the stub).
	 */
	openE2E?(
		sandboxId: string,
		options: { readonly ttlMinutes: number; readonly grantee?: string },
	): Promise<{ readonly url: string; readonly hostId: string }>;
	/** A CPU and memory reading of a running sandbox. */
	usage(sandboxId: string): Promise<UsageSample>;
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
