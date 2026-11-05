/**
 * The host registry and the compute plane's dispatch: join tokens, registration, the hosts' connections (through the
 * hub), the operator's view and changes, and sandboxes placed on hosts and reached through them.
 *
 * The public sandbox API (docs/site/src/content/docs/api/reference/sandboxes.md) is built over `sandboxes` here; this
 * package doesn't decide who may use which sandbox, only where it runs and how it is reached.
 */
import { type Clock, KantelError, placementError, systemClock } from "@kantel/contracts";
import type { HostCluster } from "./cluster.ts";
import {
	parseHostCapacity,
	parseHostFacts,
	parseHostUsage,
	parseMountStatuses,
	storedCapacity,
	storedFacts,
} from "./facts.ts";
import {
	type CallOptions,
	createHostHub,
	type FileOpenParams,
	HostCallError,
	type HostHub,
	type OpenedFile,
	type PortSink,
	type PortStream,
} from "./hub.ts";
import {
	HOST_CLOSE_REVOKED,
	HOST_E2E_PORT,
	HOST_FEATURES,
	type HostBucketSource,
	type HostEgress,
	type HostEgressRecord,
	type HostFacts,
	type HostHello,
	type HostImageChannel,
	HostMethods,
	type HostMount,
	type HostMountStatus,
	type HostSandbox,
	type HostSandboxUsage,
	type HostSecrets,
	type HostSize,
	type HostTemplateBoot,
	type HostTemplateBuild,
	type HostTemplateBuilt,
	type HostUsageReport,
	type HostWelcome,
	needsEgressPolicy,
	type SandboxTier,
} from "./protocol.ts";
import { DEFAULT_HOST_UPDATE_URL, type HostReleases, needsUpdate, plainVersion } from "./releases.ts";
import {
	type Candidate,
	hostSizeNamed,
	isRefusal,
	makesCustomShapes,
	place,
	type Shape,
	shapeOn,
	sizeOn,
} from "./scheduler.ts";
import type { HostRecord, HostStore, PlacementRecord } from "./store.ts";

/** Whether a host reports enforcing egress grants and protected variables. */
export const enforcesPolicy = (host: HostRecord): boolean =>
	storedFacts(host.facts)?.features?.includes(HOST_FEATURES.egressPolicy) === true;

/** The feature a host needs to mount each kind of source, and what a mount it can't do says. */
const MOUNT_KINDS = {
	bundle: { feature: HOST_FEATURES.mountsBundle, refusal: "This host can't mount bundles yet" },
	bucket: { feature: HOST_FEATURES.mountsBucket, refusal: "This host can't mount buckets yet" },
} as const;

/** A boot's mounts as a host with some features takes them. */
export interface MountHandoff {
	/** The mounts the host can do, for the call's `mounts` (sent only when there are some). */
	readonly send: readonly HostMount[];
	/**
	 * Every mount's status once the host answered with `sandbox`, in the order given: `failed` (and `unsent`) for one it
	 * can't do, else what it reported for that path, or `pending`. Undefined when there were no mounts.
	 */
	status(sandbox: HostSandbox | undefined): HandoffMountStatus[] | undefined;
}

/**
 * A mount's status after a hand-off. `unsent`: the host was never sent it (it can't do that kind), so this `failed` is
 * the only word it will get, whatever the order of the host's own reports.
 */
export type HandoffMountStatus = HostMountStatus & { readonly unsent?: true };

/**
 * Splits `mounts` by what a host with `features` can mount. A host that predates mounts would ignore the field and
 * answer as if it had mounted them, so it is sent only those it reports doing, and the others are `failed` at once.
 */
export function mountHandoff(
	features: readonly string[] | undefined,
	mounts: readonly HostMount[] | undefined,
): MountHandoff {
	const all = mounts ?? [];
	const can = (mount: HostMount) => features?.includes(MOUNT_KINDS[mount.kind].feature) === true;
	return {
		send: all.filter(can),
		status(sandbox) {
			if (all.length === 0) return undefined;
			const reported = new Map((parseMountStatuses(sandbox?.mounts) ?? []).map((status) => [status.path, status]));
			return all.map((mount): HandoffMountStatus => {
				if (!can(mount)) {
					return { path: mount.path, status: "failed", error: MOUNT_KINDS[mount.kind].refusal, unsent: true };
				}
				return reported.get(mount.path) ?? { path: mount.path, status: "pending" };
			});
		},
	};
}

/** `mounts` for a call's params: present only when there are some. */
const mountsParam = (handoff: MountHandoff) => (handoff.send.length === 0 ? {} : { mounts: handoff.send });

/** A bundle's tar as the compute plane answers it for a host. */
export interface HostBundle {
	readonly sizeBytes: number;
	readonly body: ReadableStream<Uint8Array>;
}
/** Whether a host reports templates (`HOST_FEATURES.templates`): only such a host is sent a build or a template create. */
export const runsTemplates = (host: HostRecord): boolean =>
	storedFacts(host.facts)?.features?.includes(HOST_FEATURES.templates) === true;
/**
 * Whether a host builds templates' custom images in a build microVM (`HOST_FEATURES.templateImages`, beside
 * `templates`): only such a host is sent a custom image's build or create.
 */
export const buildsTemplateImages = (host: HostRecord): boolean =>
	runsTemplates(host) && storedFacts(host.facts)?.features?.includes(HOST_FEATURES.templateImages) === true;

export const JOIN_TOKEN_PREFIX = "kth_";
export const HOST_CREDENTIAL_PREFIX = "khc_";

/** A host as the operator sees it (the API contract's `Host`). */
export interface HostView {
	readonly id: string;
	readonly name: string;
	readonly state: "online" | "unreachable" | "draining" | "revoked";
	readonly version?: string;
	/** The version hosts should run: the operator's (`desiredVersion`), else Kantel's latest release, once read. */
	readonly latestVersion?: string;
	/** It runs an older version than `latestVersion` (any other, when the operator set it), so it can be updated. */
	readonly updateAvailable?: boolean;
	readonly os?: string;
	readonly arch?: "x86_64" | "aarch64";
	readonly tiers: readonly SandboxTier[];
	/** The microVM sizes it offers. */
	readonly sizes: readonly HostSize[];
	readonly kvm: boolean;
	readonly nestedVirtualisation: boolean;
	/** What it does beyond protocol 1 as first released (`HOST_FEATURES`). */
	readonly features: readonly string[];
	readonly capacity: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb: number };
	readonly allocated: {
		readonly sandboxes: number;
		readonly vcpus: number;
		readonly memoryMb: number;
		readonly diskGb: number;
	};
	readonly labels: { readonly [key: string]: string };
	/** The account whose own host it is, which alone may use it; absent for a shared host. */
	readonly accountId?: string;
	readonly joinedAt: number;
	readonly lastSeenAt?: number;
}

export interface JoinTokenView {
	readonly id: string;
	/** Shown once. */
	readonly token: string;
	readonly command: string;
	readonly expiresAt: number;
}

export interface CreateSandboxInput {
	readonly sandboxId?: string;
	readonly tier: SandboxTier;
	/** A microVM's named size, as asked for before shapes. Default `default`; `shape` wins. */
	readonly size?: string;
	/**
	 * A microVM's vCPUs and memory, or an isolate's memory (`vcpus` 0). A shape off the host's named sizes boots from
	 * scratch; an isolate's memory is recorded on its host, not enforced.
	 */
	readonly shape?: Shape;
	/**
	 * The organisation or account; isolates of one owner share a VM. An account's own host takes only that
	 * owner's sandboxes, so a sandbox with no owner never goes on one.
	 */
	readonly owner?: string;
	readonly labels?: { readonly [key: string]: string };
	readonly env?: { readonly [key: string]: string };
	readonly sshAuthorizedKeys?: readonly string[];
	readonly egress?: HostEgress;
	/** Only these hosts may take it (the control plane's eligible hosts: online, not draining, labelled). */
	readonly hostIds?: readonly string[];
	/** Start from this snapshot, which is on the one host `hostIds` names. */
	readonly from?: string;
	/** Read-only mounts: those the chosen host can do are sent, the others answered `failed` (`mountHandoff`). */
	readonly mounts?: readonly HostMount[];
	/**
	 * Made from a template (microVMs only); one with a `snapshot` goes on the one host `hostIds` names, which holds it,
	 * and restores it only when it was built as the create's size or shape.
	 */
	readonly template?: HostTemplateBoot;
}

/** A template build as the compute plane asks for it: the host gives the disk, as it would for a create of the shape. */
export type TemplateBuildInput = Omit<HostTemplateBuild, "diskGiB">;

/** A microVM host's runtime, from its facts: what a template snapshot made there restores onto. */
export interface HostTemplateRuntime {
	readonly hostId: string;
	/** Absent for a host from before templates. */
	readonly guestKernel?: string;
	readonly firecracker?: string;
	/** It builds templates' custom images in a build microVM (`HOST_FEATURES.templateImages`). */
	readonly customImages?: boolean;
}

/**
 * How long a template build may take: its base image pulled, a boot, and its setup (which the host bounds at 30
 * minutes). A create from a template is given as long: booting fresh, it pulls the image and runs the setup too.
 */
export const TEMPLATE_BUILD_TIMEOUT_MS = 50 * 60_000;
/** How long a custom image's template build may take: its build microVM (which the host bounds at 45 minutes) too. */
export const TEMPLATE_IMAGE_BUILD_TIMEOUT_MS = 100 * 60_000;

/** Join tokens kept elsewhere, such as by the compute API, which mints them (`createHostJoinToken`). */
export interface ExternalJoinTokens {
	/**
	 * Spends the token with this SHA-256 hex once: its name and labels, and the account an account's join token joins
	 * the host to; or undefined if unknown, used or expired.
	 */
	spendJoinToken(
		hash: string,
		hostId: string,
		now: number,
	): Promise<
		| {
				readonly id: string;
				readonly name?: string;
				readonly labels: { readonly [key: string]: string };
				readonly accountId?: string;
		  }
		| undefined
	>;
}

/**
 * What hosts ask of the compute plane over their link, which owns the sandboxes' records: their protected values, and
 * keeping their egress logs. Each is given the host the connection was checked against.
 */
export interface HostComputeLink {
	/** A sandbox's protected values, or `undefined` unless the sandbox is on `hostId`. */
	secrets(hostId: string, sandboxId: string): Promise<HostSecrets | undefined>;
	recordEgress(hostId: string, records: readonly HostEgressRecord[]): Promise<void>;
	/**
	 * Fills in the bases a host reports for its own sandboxes (`HostSandbox.base`, image patching: its hello and events)
	 * and snapshots (its snapshot list, read once a connection), so what was made before it versioned its images shows
	 * its base without another boot (`ComputeService.recordBases`). A snapshot is named by its ref, `<hostId>/<id>`.
	 */
	recordBases?(
		hostId: string,
		reports: {
			readonly sandboxes?: readonly { readonly sandboxId: string; readonly base: string; readonly baseAt?: number }[];
			readonly snapshots?: readonly { readonly ref: string; readonly base: string }[];
		},
	): Promise<void>;
	/**
	 * A host's `bucket.fetch`: the bucket source with its credentials opened, or `undefined` unless the sandbox is on
	 * `hostId` and mounts it (`ComputeService.bucketSourceForHost`).
	 */
	bucketSource?(hostId: string, sandboxId: string, bucketSourceId: string): Promise<HostBucketSource | undefined>;
	/**
	 * A host's later word on a sandbox's mounts, a `sandbox.mounts` event (`ComputeService.reportMounts`): only for a
	 * sandbox whose placement is on that host. `mountsAt` is when the host set them (absent from an older host).
	 */
	reportMounts?(
		hostId: string,
		sandboxId: string,
		mounts: readonly HostMountStatus[],
		mountsAt?: number,
	): Promise<void>;
	/**
	 * A bundle's tar for a host, or `undefined` unless the sandbox is on `hostId` and mounts it
	 * (`ComputeService.bundleForHost`).
	 */
	bundle?(hostId: string, sandboxId: string, digest: string): Promise<HostBundle | undefined>;
	/**
	 * A use of a sandbox through the relay (`ComputeService.noteActivity`, for its idle stop): a port stream opened to it
	 * (`sandboxes.openPort`: SSH, the desktop or browser, a hosted port's request or WebSocket), and each frame either
	 * way. Called for every frame, so it must be cheap. Absent: nothing counts.
	 */
	activity?(sandboxId: string): void;
	/**
	 * Keeps a host's usage tick, checked (`parseHostUsage`). `shared`: it came from the replica holding the host's
	 * connection, not from the host (`recordSharedUsage`). Absent: ticks are dropped.
	 */
	recordUsage?(
		hostId: string,
		usage: HostUsageReport & { readonly sandboxes: readonly HostSandboxUsage[] },
		options?: { readonly shared?: boolean },
	): Promise<void>;
	/** An organisation's E2E chain for the host (`ComputeService.hostE2EChain`), and the host's own entries to it. */
	readonly e2eChain?: {
		read(hostId: string, space: string): Promise<readonly E2EChainEntry[]>;
		append(
			hostId: string,
			space: string,
			from: number,
			entries: readonly E2EChainEntry[],
		): Promise<readonly E2EChainEntry[]>;
	};
	/**
	 * The host images Kantel wants hosts on, for their welcome (image patching, experimental): from the base image index's
	 * `host` entry, its `stable` version. Absent (the feature off), or undefined (no such version), the welcome has none
	 * and hosts keep the images they have. A failure is logged and the welcome goes without, so a host still connects.
	 */
	images?(): Promise<HostImageChannel | undefined>;
}

/** A chain entry as the gateway passes it on: opaque to it, verified by hosts and devices (`@kantel/e2e`). */
export interface E2EChainEntry {
	readonly payload: string;
	readonly sig: string;
}

export interface HostsServiceOptions {
	readonly store: HostStore;
	readonly clock?: Clock;
	/** Where hosts reach this deployment, for the join command: `https://kantel.example.com`. */
	readonly publicUrl: string;
	/**
	 * The join command, with `{url}` and `{token}`. Default: the host installer from Kantel's latest GitHub Release,
	 * `curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url {url} --token {token}`.
	 */
	readonly joinCommand?: string;
	/**
	 * The version hosts should run, and where they get it (`{version}`, `{os}`, `{arch}`; default
	 * `DEFAULT_HOST_UPDATE_URL`). With `desiredVersion`, every connected host is told to move to it.
	 */
	readonly desiredVersion?: string;
	readonly updateUrl?: string;
	/**
	 * Kantel's latest release, without `desiredVersion`: hosts older than it are said to be out of date
	 * (`HostView.updateAvailable`), and `updateAgent` moves one to it. Nothing moves a host on its own.
	 */
	readonly releases?: HostReleases;
	readonly heartbeatSeconds?: number;
	readonly callTimeoutMs?: number;
	readonly log?: (message: string) => void;
	/**
	 * With several gateway replicas: records the hosts connected here, and sends calls for hosts connected to another
	 * replica there (`cluster.ts`).
	 */
	readonly cluster?: HostCluster;
}

export interface SandboxPlacement {
	readonly sandbox: HostSandbox;
	readonly hostId: string;
	/** The placement as written once the host answered, so the caller needn't read it back. */
	readonly placement?: PlacementRecord;
	/** Whether the host offers nested virtualisation, so the caller needn't read the host for it. */
	readonly nestedVirtualisation?: boolean;
	/** Each of the input's mounts' status (`MountHandoff.status`); absent when it named none. */
	readonly mounts?: readonly HostMountStatus[];
}

export interface HostsService {
	readonly hub: HostHub;
	/** Registration spends join tokens from here from now on, not the registry's own. */
	useJoinTokens(tokens: ExternalJoinTokens): void;
	/**
	 * Hosts' `secrets.fetch` and egress reports go to the compute plane from now on: it is made after this service, over
	 * a backend made from it. Before, a fetch is answered `unavailable` and a report is dropped.
	 */
	useCompute(link: HostComputeLink): void;
	/**
	 * A usage tick another replica passed on, from a host connected to it (`HostCluster.shareUsage`): checked, and kept
	 * as `shared`. The caller has checked that the replica holds the host.
	 */
	recordSharedUsage(hostId: string, usage: unknown): Promise<void>;
	createJoinToken(input: {
		readonly name?: string;
		readonly labels?: { readonly [key: string]: string };
		readonly expiresInMinutes?: number;
	}): Promise<JoinTokenView>;
	/** Trades a join token for a host ID and its credential (shown once). */
	register(input: {
		readonly token: string;
		readonly name?: string;
		readonly labels?: { readonly [key: string]: string };
		readonly facts?: HostFacts;
	}): Promise<{ readonly hostId: string; readonly credential: string }>;
	/** The host a credential is for, unless it is unknown or revoked. */
	authenticate(credential: string): Promise<HostRecord | undefined>;
	/** A space's E2E chain, for a host (`HostComputeLink.e2eChain`); `unavailable` before the compute plane is linked. */
	e2eChain(hostId: string, space: string): Promise<readonly E2EChainEntry[]>;
	appendE2EChain(
		hostId: string,
		space: string,
		from: number,
		entries: readonly E2EChainEntry[],
	): Promise<readonly E2EChainEntry[]>;
	/**
	 * A bundle's tar, for a host (`GET /v1/hosts/bundles/{digest}`): `undefined` unless the sandbox is on `hostId` and
	 * mounts it; `unavailable` before the compute plane is linked.
	 */
	bundle(hostId: string, sandboxId: string, digest: string): Promise<HostBundle | undefined>;
	/**
	 * Every host. With `allocations: false` no placements are read and `allocated` is all zero: for a caller that needs
	 * only what the hosts are (the compute backend's capabilities), at one statement rather than one per host.
	 */
	list(options?: { readonly allocations?: boolean }): Promise<HostView[]>;
	get(hostId: string): Promise<HostView>;
	update(
		hostId: string,
		change: {
			readonly name?: string;
			readonly labels?: { readonly [key: string]: string };
			readonly draining?: boolean;
		},
	): Promise<HostView>;
	revoke(hostId: string): Promise<HostView>;
	/**
	 * Asks a connected host to update its kantel-host to `latestVersion`: it fetches the binary, checks it against the
	 * release's SHA256SUMS and restarts into it, its sandboxes running on. Answers once the binary is in place, with the
	 * version it is moving to; the host connects again on it a few seconds later. `conflict` when it's revoked or already
	 * on that version (or a newer one), `unavailable` when it isn't connected or no version is known, and `not_supported`
	 * when the host refuses (one in an E2E space is updated on the machine).
	 */
	updateAgent(hostId: string): Promise<{ readonly version: string }>;
	readonly sandboxes: {
		create(input: CreateSandboxInput): Promise<SandboxPlacement>;
		fork(
			sandboxId: string,
			input?: {
				readonly newId?: string;
				readonly egress?: HostEgress;
				/** The fork's own environment (its own protected placeholders); absent, its source's. */
				readonly env?: { readonly [key: string]: string };
				/** The fork's mounts, as for a create (`mountHandoff`, with its source's host). */
				readonly mounts?: readonly HostMount[];
			},
		): Promise<SandboxPlacement>;
		/** Any other method of a sandbox, on its host: stop, resume, exec, files, snapshots. */
		call<T = unknown>(sandboxId: string, method: string, params?: object, options?: CallOptions): Promise<T>;
		delete(sandboxId: string): Promise<void>;
		placement(sandboxId: string): Promise<PlacementRecord | undefined>;
		openPort(sandboxId: string, port: number, sink: PortSink): Promise<PortStream>;
		/**
		 * Opens a file of the sandbox as a stream on its host (`HostHub.openFile`). Not relayed between gateway replicas:
		 * `unavailable` when the host is connected to another one.
		 */
		openFile(sandboxId: string, params: Omit<FileOpenParams, "sandboxId">, sink: PortSink): Promise<OpenedFile>;
	};
	/** Template snapshots, which hosts build and keep apart from sandboxes' snapshots (microVMs only). */
	readonly templates: {
		/** The runtime of each connected microVM host that isn't draining and runs templates (`HOST_FEATURES.templates`). */
		runtimes(): Promise<HostTemplateRuntime[]>;
		/**
		 * Builds one on `hostId`, which must be one the build's owner may use, as a create's host must, and run templates.
		 * Admitted as a create is, it holds its machine's memory and disk until it ends: `exhausted` while the host has no
		 * room for them, whether this replica sees that or the host refuses it (`capacity`), having less room than its
		 * last report said (another replica's builds and creates since). Either is for trying again later.
		 */
		build(hostId: string, input: TemplateBuildInput): Promise<HostTemplateBuilt>;
		delete(hostId: string, snapshotId: string): Promise<void>;
	};
	close(): void;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const secret = (prefix: string) => `${prefix}${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
const shortId = (prefix: string) =>
	`${prefix}_${base64url(crypto.getRandomValues(new Uint8Array(9)))
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")}`;

/** A secret's SHA-256, hex: what the records keep. */
export async function hashSecret(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const DEFAULT_JOIN_COMMAND =
	"curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url {url} --token {token}";
const LABEL_KEY = /^[a-z0-9][a-z0-9._/-]{0,62}$/i;
/** States that hold the sandbox's vCPUs and memory on its host; a stopped one holds only its disk. */
const LIVE = new Set(["starting", "running", "stopping"]);
/** How long a host has to fetch and check a new kantel-host before an update is given up on: 5 minutes. */
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
/** How often a connected host is told again which images Kantel wants it on (image patching): 15 minutes. */
export const IMAGES_REFRESH_MS = 15 * 60 * 1000;

function labelsOf(value: unknown): { [key: string]: string } {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new KantelError("invalid", "Labels are an object of strings");
	}
	const out: { [key: string]: string } = {};
	for (const [key, label] of Object.entries(value)) {
		if (!LABEL_KEY.test(key) || typeof label !== "string" || label.length > 200) {
			throw new KantelError("invalid", `Label ${key} is not a valid label`);
		}
		out[key] = label;
	}
	return out;
}

const SANDBOX_ID = /^[a-z0-9][a-z0-9_-]{2,62}$/;
/** The calls that boot a sandbox on its host: its create, fork, start and resume. */
const BOOTS: ReadonlySet<string> = new Set([
	HostMethods.create,
	HostMethods.fork,
	HostMethods.start,
	HostMethods.resume,
]);

/** A shape as asked: whole vCPUs (0 for an isolate) and memory in MiB, at least 128. */
function shapeIn(shape: Shape, tier: SandboxTier): Shape {
	const { vcpus, memoryMiB } = shape;
	if (!Number.isInteger(vcpus) || !Number.isInteger(memoryMiB) || memoryMiB < 128) {
		throw new KantelError("invalid", "A shape is whole vCPUs and at least 128 MiB of memory");
	}
	if (tier === "microvm" ? vcpus < 1 : vcpus !== 0) {
		throw new KantelError("invalid", tier === "microvm" ? "A microVM has at least 1 vCPU" : "An isolate has no vCPUs");
	}
	return { vcpus, memoryMiB };
}

/** Kantel's errors for host calls that were sent and never answered (`HostCallError.unanswered`). */
const unansweredErrors = new WeakSet<object>();

/**
 * Whether `error` is a host call that was sent and never answered: its link dropped, it timed out or was aborted, or the
 * replica holding the host lost it. The host may have carried it out, so nothing it would have changed is undone.
 */
export function unanswered(error: unknown): boolean {
	return typeof error === "object" && error !== null && unansweredErrors.has(error);
}

/** A host's error as Kantel's: the codes line up where they can. */
export function kantelErrorFromHost(error: unknown): unknown {
	if (!(error instanceof HostCallError)) return error;
	const mapped = kantelCodeError(error);
	if (error.unanswered) unansweredErrors.add(mapped);
	return mapped;
}

function kantelCodeError(error: HostCallError): KantelError {
	const code =
		error.code === "not_found" || error.code === "invalid" || error.code === "conflict"
			? error.code
			: error.code === "capacity"
				? "exhausted"
				: error.code === "unsupported"
					? "not_supported"
					: "unavailable";
	return code === "exhausted"
		? placementError(code, "insufficient_capacity", error.message)
		: new KantelError(code, error.message);
}

export function createHostsService(options: HostsServiceOptions): HostsService {
	const { store } = options;
	const clock = options.clock ?? systemClock;
	const log = options.log ?? ((message: string) => console.error(message));
	let joinTokens: ExternalJoinTokens = store;
	let compute: HostComputeLink | undefined;
	/**
	 * What this replica placed on each host, each stamped with when, until the host's next report. A report clears it here
	 * when it comes in on this replica's connection; for a host whose connection another replica holds, a placement
	 * counts only while it is newer than the host's `lastSeenAt` in the shared registry, which that replica writes on
	 * every hello and heartbeat. So no replica goes on seeing a host as full after the host has reported again.
	 */
	const reserved = new Map<string, { at: number; memoryMiB: number; diskGiB: number }[]>();
	/**
	 * The template builds this replica started on each host and no report of the host has named yet, by snapshot ID:
	 * each holds its machine's memory and disk from before its call until a report names it (`HostCapacity.builds`, whose
	 * free memory and disk leave it out from then on) or the call ends, so it is counted once, and neither another build
	 * nor a create this replica places takes its room meanwhile. A fast check only: the host admits each build and create
	 * itself against everything it runs, every replica's included (`capacity` when it hasn't room), and counts a build in
	 * its reports until its machine has gone, however long after the call that is.
	 */
	const building = new Map<string, Map<string, { readonly memoryMiB: number; readonly diskGiB: number }>>();
	/**
	 * What this replica placed on `host` since its last report, and what its builds there hold that no report has named.
	 * A build a report names is let go here for good: the host counts it from then on, and a later report without it
	 * means it has ended.
	 */
	const reservedOn = (host: HostRecord) => {
		const since = host.lastSeenAt ?? Number.NEGATIVE_INFINITY;
		const live = (reserved.get(host.id) ?? []).filter((entry) => entry.at > since);
		if (live.length === 0) reserved.delete(host.id);
		else reserved.set(host.id, live);
		const builds = building.get(host.id);
		for (const snapshotId of host.capacity?.builds ?? []) builds?.delete(snapshotId);
		if (builds?.size === 0) building.delete(host.id);
		const held = [...live, ...(builds?.values() ?? [])];
		return {
			memoryMiB: held.reduce((sum, entry) => sum + entry.memoryMiB, 0),
			diskGiB: held.reduce((sum, entry) => sum + entry.diskGiB, 0),
		};
	};
	/** When each host's last invalid usage tick was logged. */
	const badUsageLogged = new Map<string, number>();
	const report = (work: Promise<unknown>) => {
		void work.catch((error) => log(`[hosts] ${error instanceof Error ? error.message : String(error)}`));
	};

	const baseWelcome = (host: HostRecord): HostWelcome => ({
		hostId: host.id,
		heartbeatSeconds: options.heartbeatSeconds ?? 15,
		// Hosts keep no warm pools; an older one that keeps some makes no more on this (see `endLegacyPools`).
		pools: {},
		...(host.draining ? { draining: true } : {}),
		...(options.desiredVersion === undefined ? {} : { desiredVersion: options.desiredVersion }),
		...(options.updateUrl === undefined ? {} : { updateUrl: options.updateUrl }),
		// Ticks are acknowledged once this gateway's compute plane has taken them (`onUsage`): with none linked, nothing
		// would be, so the host is told nothing and does as with an older Kantel.
		...(compute?.recordUsage === undefined ? {} : { usageAcks: true }),
	});
	// With image patching off the welcome is made at once, as before: no await between a hello and its answer.
	const welcomeFor = (host: HostRecord): HostWelcome | Promise<HostWelcome> => {
		const base = baseWelcome(host);
		if (compute?.images === undefined) return base;
		return compute.images().then(
			(images) => (images === undefined ? base : { ...base, images }),
			(error) => {
				log(
					`[hosts] no images in host ${host.id}'s welcome: ${error instanceof Error ? error.message : String(error)}`,
				);
				return base;
			},
		);
	};

	/**
	 * When each host connected here was last told the images Kantel wants it on (image patching). A host that stays
	 * connected is told again on a heartbeat once `IMAGES_REFRESH_MS` have passed: a release published since its hello
	 * reaches it, and one it failed to take is tried again, without waiting for it to reconnect.
	 */
	const imagesToldAt = new Map<string, number>();
	/** A host sandbox's `baseAt`, when it says one. */
	const baseAtOf = (sandbox: { baseAt?: unknown }): { baseAt?: number } =>
		typeof sandbox.baseAt === "number" && sandbox.baseAt > 0 ? { baseAt: sandbox.baseAt } : {};
	/** Hosts whose snapshot bases haven't been read on their connection yet (image patching hosts only). */
	const snapshotBasesDue = new Set<string>();
	/**
	 * Reads a host's snapshots once a connection and passes on the bases they report: snapshots saved before the host
	 * versioned its images have none recorded, and the host pins them when image patching starts.
	 */
	const readSnapshotBases = (hostId: string) => {
		if (!snapshotBasesDue.delete(hostId) || compute?.recordBases === undefined) return;
		const link = compute;
		report(
			(async () => {
				const listed = await hub.call<{ snapshots?: readonly { id?: unknown; base?: unknown }[] | null }>(
					hostId,
					HostMethods.snapshotList,
					{ sandboxId: "" },
				);
				const snapshots: { ref: string; base: string }[] = [];
				for (const snap of listed.snapshots ?? []) {
					if (typeof snap.id === "string" && typeof snap.base === "string" && snap.base !== "") {
						snapshots.push({ ref: `${hostId}/${snap.id}`, base: snap.base });
					}
				}
				if (snapshots.length > 0) await link.recordBases?.(hostId, { snapshots });
			})(),
		);
	};

	const refreshImages = (hostId: string) => {
		if (compute?.images === undefined) return;
		const now = clock.now();
		const told = imagesToldAt.get(hostId);
		if (told === undefined) {
			imagesToldAt.set(hostId, now);
			return;
		}
		if (now - told < IMAGES_REFRESH_MS) return;
		imagesToldAt.set(hostId, now);
		report(
			(async () => {
				const host = await store.getHost(hostId);
				if (host === undefined || host.revoked) return;
				const welcome = await welcomeFor(host);
				// No images (the index can't be read): nothing new to say, and the host keeps what it has.
				if (welcome.images !== undefined) hub.rewelcome(hostId, welcome);
			})(),
		);
	};

	const hello = async (hostId: string, message: HostHello): Promise<void> => {
		const host = await store.getHost(hostId);
		if (host === undefined || host.revoked) throw new Error("This host is revoked");
		const facts = parseHostFacts(message.facts);
		if (!facts.ok) throw new Error(`The hello's facts aren't valid: ${facts.reason}`);
		const capacity = parseHostCapacity(message.capacity);
		if (!capacity.ok) throw new Error(`The hello's capacity isn't valid: ${capacity.reason}`);
		if (message.sandboxes !== null && message.sandboxes !== undefined && !Array.isArray(message.sandboxes)) {
			throw new Error("The hello's sandboxes aren't a list");
		}
		const now = clock.now();
		// Only what the host reports: what an operator set meanwhile (its name, labels, drain) stands.
		const reported = await store.updateHost(hostId, (latest) => ({
			...latest,
			facts: facts.value,
			capacity: capacity.value,
			lastSeenAt: now,
		}));
		if (reported === undefined || reported.revoked) throw new Error("This host is revoked");
		reserved.delete(hostId);
		// Reconcile: what the host holds is the truth about state; a placement the host no longer has is lost.
		// Go marshals an empty list as null (kantel-host 0.1.0-dev on a host with no sandboxes).
		const sandboxes = message.sandboxes ?? [];
		const held = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
		const bases: { sandboxId: string; base: string; baseAt?: number }[] = [];
		for (const placement of await store.placementsOn(hostId)) {
			const sandbox = held.get(placement.sandboxId);
			const latest = asReported(placement, sandbox ?? { state: "lost" }, reported, now);
			if (latest !== placement) await store.putPlacement(latest);
			// What its disk is on, where the host says (one without image patching doesn't, and nothing is erased).
			if (typeof sandbox?.base === "string" && sandbox.base !== "") {
				bases.push({ sandboxId: placement.sandboxId, base: sandbox.base, ...baseAtOf(sandbox) });
			}
			held.delete(placement.sandboxId);
		}
		if (bases.length > 0 && compute?.recordBases !== undefined) {
			report(compute.recordBases(hostId, { sandboxes: bases }));
		}
		// Its snapshots' bases, once it is welcomed (the hello doesn't carry them): on its first heartbeat.
		if (facts.value.features?.includes(HOST_FEATURES.imagePatching) === true) snapshotBasesDue.add(hostId);
		else snapshotBasesDue.delete(hostId);
		if (held.size > 0) {
			log(`[hosts] host ${hostId} holds sandboxes Kantel didn't place: ${[...held.keys()].slice(0, 10).join(", ")}`);
		}
		log(`[hosts] host ${hostId} connected (${facts.value.version}, ${sandboxes.length} sandboxes)`);
	};

	/**
	 * A welcome is the host as written once it is claimed, with a drain an operator set while it reconciled; one set
	 * after this read reaches the hub's `rewelcome` (routed here, now it is claimed), which reads it again after this one.
	 */
	const welcomeNow = async (hostId: string): Promise<HostWelcome> => {
		const latest = await store.getHost(hostId);
		if (latest === undefined || latest.revoked) throw new Error("This host is revoked");
		return welcomeFor(latest);
	};

	/** When each host still reporting warm machines was last told to keep none. */
	const poolsEnded = new Map<string, number>();
	/**
	 * A host from before warm pools were removed that still reports warm machines is told to keep none, by the call it
	 * knows, not only by its welcome: its pools may come from a welcome sent before this control plane, on a connection
	 * still open. Once a minute at most, until it reports none. That kantel-host has no call that ends an idle warm VM:
	 * told this, it makes no more, its next create of that size takes the one it has, and its update (a version that
	 * clears its old pool directory on start) or restart ends the rest.
	 */
	const endLegacyPools = (hostId: string, reported: unknown) => {
		const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
		const warm = isRecord(reported) ? reported.warm : undefined;
		const keeps = isRecord(warm) && Object.values(warm).some((count) => typeof count === "number" && count > 0);
		if (!keeps) {
			poolsEnded.delete(hostId);
			return;
		}
		const at = clock.now();
		if (at - (poolsEnded.get(hostId) ?? Number.NEGATIVE_INFINITY) < 60_000) return;
		poolsEnded.set(hostId, at);
		log(`[hosts] host ${hostId} still keeps warm machines; telling it to keep none`);
		report(local.call(hostId, HostMethods.legacyPools, {}));
	};

	const cluster = options.cluster;
	const local = createHostHub({
		async onHello(hostId, message) {
			await hello(hostId, message);
			imagesToldAt.set(hostId, clock.now());
			// Recorded before the welcome, so no replica routes elsewhere once the host takes calls here.
			await cluster?.claim(hostId);
			return welcomeNow(hostId);
		},
		// A change of settings is sent as read afresh, so an older one never lands after a newer.
		welcomeNow(hostId) {
			return welcomeNow(hostId);
		},
		onHeartbeat(hostId, reported) {
			const parsed = parseHostCapacity(reported);
			if (!parsed.ok) {
				log(`[hosts] host ${hostId} sent a heartbeat that isn't valid (${parsed.reason}); ignored`);
				return;
			}
			endLegacyPools(hostId, reported);
			const capacity = parsed.value;
			reserved.delete(hostId);
			refreshImages(hostId);
			readSnapshotBases(hostId);
			report(
				(async () => {
					await store.updateHost(hostId, (host) => ({ ...host, capacity, lastSeenAt: clock.now() }));
				})(),
			);
		},
		onEvent(hostId, event) {
			const sandbox = event.sandbox;
			if (typeof sandbox !== "object" || sandbox === null) return;
			if (typeof sandbox.id !== "string" || typeof sandbox.state !== "string") return;
			report(
				(async () => {
					const placement = await store.getPlacement(sandbox.id);
					if (placement === undefined || placement.hostId !== hostId) return;
					const base = (sandbox as { base?: unknown }).base;
					if (typeof base === "string" && base !== "" && sandbox.state !== "deleted") {
						await compute?.recordBases?.(hostId, {
							sandboxes: [{ sandboxId: sandbox.id, base, ...baseAtOf(sandbox as { baseAt?: unknown }) }],
						});
					}
					// The call that caused the event usually recorded it already (a create's `running`).
					if (sandbox.state === "deleted") {
						await store.removePlacement(sandbox.id);
						return;
					}
					const latest = asReported(placement, sandbox, await store.getHost(hostId), clock.now());
					if (latest !== placement) await store.putPlacement(latest);
				})(),
			);
		},
		async secrets(hostId, sandboxId) {
			if (compute === undefined) throw new Error("The compute plane isn't linked yet");
			return compute.secrets(hostId, sandboxId);
		},
		onEgress(hostId, records) {
			if (compute !== undefined) report(compute.recordEgress(hostId, records));
		},
		async bucketSource(hostId, sandboxId, bucketSourceId) {
			if (compute?.bucketSource === undefined) throw new Error("The compute plane keeps no bucket sources here");
			return compute.bucketSource(hostId, sandboxId, bucketSourceId);
		},
		onMounts(hostId, sandboxId, mounts, mountsAt) {
			const link = compute;
			if (link?.reportMounts === undefined) return;
			// Only for a sandbox placed on this host, by its placement record, which is written before the host is asked
			// to boot it: a report can come before the compute plane has recorded the boot's host (a first create's, or a
			// restart's on another host), and that plane takes a starting sandbox's report from the host this names.
			report(
				(async () => {
					if ((await store.getPlacement(sandboxId))?.hostId !== hostId) return;
					await link.reportMounts?.(hostId, sandboxId, mounts, mountsAt);
				})(),
			);
		},
		onUsage(hostId, reported): Promise<void> | undefined {
			if (compute?.recordUsage === undefined && cluster === undefined) return undefined;
			const parsed = parseHostUsage(reported);
			if (!parsed.ok) {
				// A tick comes every few seconds: say so once an hour per host, not every time.
				const at = clock.now();
				if (at - (badUsageLogged.get(hostId) ?? Number.NEGATIVE_INFINITY) >= 3_600_000) {
					badUsageLogged.set(hostId, at);
					log(`[hosts] host ${hostId} sent a usage tick that isn't valid (${parsed.reason}); ignored`);
				}
				return undefined;
			}
			// Taken here, by the replica holding the host's connection, which exports it: what the hub acknowledges once
			// it resolves. Passing it on to the other replicas is for their graphs, and isn't waited for; it goes once the
			// tick is taken here (in the order taken), so a replica that has a tick passed on has it from one that took it.
			const taken = compute?.recordUsage?.(hostId, parsed.value);
			if (taken === undefined) {
				cluster?.shareUsage(hostId, parsed.value);
				return undefined;
			}
			report(taken);
			if (cluster !== undefined) {
				taken.then(
					() => cluster.shareUsage(hostId, parsed.value),
					() => undefined,
				);
			}
			return taken;
		},
		onDisconnected(hostId) {
			log(`[hosts] host ${hostId} disconnected`);
			imagesToldAt.delete(hostId);
			snapshotBasesDue.delete(hostId);
			poolsEnded.delete(hostId);
			cluster?.release(hostId);
			report(
				(async () => {
					await store.updateHost(hostId, (host) => ({ ...host, lastSeenAt: clock.now() }));
				})(),
			);
		},
		...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
	});
	const hub = cluster === undefined ? local : cluster.route(local);

	// Read the latest release now, so the first list after a start has it rather than starting the read itself.
	options.releases?.known();

	/** The version hosts should run now, and whether the operator set it; undefined until a release is known. */
	const target = (latest: string | undefined): { readonly version: string; readonly pinned: boolean } | undefined =>
		options.desiredVersion !== undefined
			? { version: options.desiredVersion, pinned: true }
			: latest === undefined
				? undefined
				: { version: latest, pinned: false };

	const view = async (host: HostRecord, allocations = true): Promise<HostView> => {
		const placements = allocations ? await store.placementsOn(host.id) : [];
		const live = placements.filter((placement) => LIVE.has(placement.state));
		const facts = storedFacts(host.facts);
		const reported = storedCapacity(host.capacity);
		const arch =
			facts?.arch === "amd64" || facts?.arch === "x86_64"
				? "x86_64"
				: facts?.arch === "arm64" || facts?.arch === "aarch64"
					? "aarch64"
					: undefined;
		const state = host.revoked
			? "revoked"
			: !hub.connected(host.id)
				? "unreachable"
				: host.draining
					? "draining"
					: "online";
		// What's kept: a list never waits on reading the release, which only starts here when it's stale.
		const versionView = (version: string | undefined) => {
			const wanted = target(options.releases?.known());
			if (wanted === undefined) return {};
			return {
				latestVersion: wanted.version,
				...(needsUpdate(version, wanted.version, wanted.pinned) ? { updateAvailable: true } : {}),
			};
		};
		return {
			id: host.id,
			name: host.name,
			state,
			...(facts === undefined ? {} : { version: facts.version, os: facts.os }),
			...versionView(facts?.version),
			...(arch === undefined ? {} : { arch }),
			tiers: facts?.tiers ?? [],
			sizes: facts?.sizes ?? [],
			kvm: facts?.kvm ?? false,
			nestedVirtualisation: facts?.nested ?? false,
			features: [...(facts?.features ?? [])],
			// Disk is free space, which changes as the host runs: the latest heartbeat's, else the hello's.
			capacity: {
				vcpus: facts?.cpus ?? 0,
				memoryMb: facts?.memoryMiB ?? 0,
				diskGb: reported?.freeDiskGiB ?? facts?.diskGiB ?? 0,
			},
			allocated: {
				sandboxes: placements.filter((placement) => placement.state !== "lost").length,
				vcpus: live.reduce((sum, placement) => sum + placement.vcpus, 0),
				memoryMb: live.reduce((sum, placement) => sum + placement.memoryMiB, 0),
				diskGb: placements.reduce((sum, placement) => sum + placement.diskGiB, 0),
			},
			labels: { ...facts?.labels, ...host.labels },
			...(host.accountId === undefined ? {} : { accountId: host.accountId }),
			joinedAt: host.joinedAt,
			...(host.lastSeenAt === undefined ? {} : { lastSeenAt: host.lastSeenAt }),
		};
	};

	/** A stored host with its reports checked: one that isn't shaped as a report counts as none, so it can't break placement. */
	const sane = (host: HostRecord): HostRecord => {
		const { facts: _facts, capacity: _capacity, ...rest } = host;
		const facts = storedFacts(host.facts);
		const capacity = storedCapacity(host.capacity);
		return {
			...rest,
			...(facts === undefined ? {} : { facts }),
			...(capacity === undefined ? {} : { capacity }),
		};
	};

	const hostOf = async (hostId: string): Promise<HostRecord> => {
		const host = await store.getHost(hostId);
		if (host === undefined) throw new KantelError("not_found", "No such host");
		return host;
	};

	const placementOf = async (sandboxId: string): Promise<PlacementRecord> => {
		const placement = await store.getPlacement(sandboxId);
		if (placement === undefined) throw new KantelError("not_found", "No such sandbox");
		return placement;
	};

	/**
	 * The deployment's attribution key signs headers any account's upstream trusts, so only the operator's own (shared)
	 * hosts get it. An account's own host is that account's machine: it gets the account's
	 * rules and upstream headers, unsigned. Every egress a host receives (create, fork, start, resume, a live update)
	 * passes here.
	 */
	const trusted = async (hostId: string, params: object, known?: HostRecord): Promise<object> => {
		const egress = (params as { egress?: HostEgress | null }).egress;
		if (egress === undefined || egress === null || egress.attributionKey === undefined) return params;
		const host = known ?? (await store.getHost(hostId));
		if (host !== undefined && host.accountId === undefined) return params;
		const { attributionKey: _, ...unsigned } = egress;
		return { ...params, egress: unsigned };
	};

	/**
	 * Refuses an egress with grants or protected variables for a host that doesn't report enforcing them: a host that
	 * predates them would drop the fields and answer as if it had applied them.
	 */
	const requireEnforced = async (hostId: string, params: object, known?: HostRecord, boot = false): Promise<void> => {
		if (!needsEgressPolicy((params as { egress?: HostEgress | null }).egress)) return;
		const host = known ?? (await store.getHost(hostId));
		if (host !== undefined && enforcesPolicy(host)) return;
		const message = `The host ${host?.name ?? hostId} doesn't enforce egress grants or protected variables; upgrade its kantel-host`;
		throw boot
			? placementError("not_supported", "no_host_enforces_egress", message)
			: new KantelError("not_supported", message);
	};

	const onHost = async <T>(
		hostId: string,
		method: string,
		params: object,
		callOptions?: CallOptions,
		known?: HostRecord,
	): Promise<T> => {
		// A boot puts a sandbox on a host: when that host can't take it, the error says why, as a placement's does.
		const boot = BOOTS.has(method);
		await requireEnforced(hostId, params, known, boot);
		try {
			return await hub.call<T>(hostId, method, await trusted(hostId, params, known), callOptions);
		} catch (error) {
			const converted = kantelErrorFromHost(error);
			// Only a boot that never reached its host is a placement refused (`host_unavailable`): one sent whose host went
			// while it waited may have been done there, which isn't known, so it isn't said to have failed (`unplace`).
			if (
				boot &&
				error instanceof HostCallError &&
				error.disconnected &&
				!error.unanswered &&
				converted instanceof KantelError
			) {
				throw placementError(converted.code, "host_unavailable", converted.message);
			}
			throw converted;
		}
	};

	/**
	 * A placement as its host reports it, however the report comes (a create's or fork's answer, an event, a hello, a
	 * call's result): its state, and the size the host made where that isn't the one placement chose (a memory snapshot
	 * restores as its own size, another name for the same vCPUs and memory, whose disk may differ), resolved by the
	 * host's own sizes or a custom size's name, so its resources are what the host made. The one place a report changes
	 * a placement.
	 */
	const asReported = (
		placement: PlacementRecord,
		report: { readonly state: string; readonly size?: unknown },
		host: HostRecord | undefined,
		now: number,
	): PlacementRecord => {
		const made =
			typeof report.size === "string" && report.size !== "" && report.size !== placement.size
				? hostSizeNamed(host, report.size)
				: undefined;
		if (made === undefined && report.state === placement.state) return placement;
		return {
			...placement,
			...(made === undefined
				? {}
				: { size: made.name, vcpus: made.vcpus, memoryMiB: made.memoryMiB, diskGiB: made.diskGiB }),
			state: report.state,
			updatedAt: now,
		};
	};

	const settle = async (
		placement: PlacementRecord,
		sandbox: HostSandbox,
		host?: HostRecord,
	): Promise<PlacementRecord> => {
		const settled = { ...asReported(placement, sandbox, host, clock.now()), updatedAt: clock.now() };
		await store.putPlacement(settled);
		return settled;
	};

	/**
	 * A create or fork that failed. What the host refused, or a call that never reached it, made nothing: its placement
	 * goes. One sent and never answered may have made the sandbox there, so its placement stays, `starting`, counted on
	 * that host, until the host says: its event once it is made, or its next hello (what it holds, or `lost`). Answers the
	 * error to throw, which says the outcome isn't known.
	 */
	const unplace = async (
		placement: PlacementRecord,
		host: HostRecord | undefined,
		error: unknown,
	): Promise<unknown> => {
		if (!unanswered(error)) {
			await store.removePlacement(placement.sandboxId);
			return error;
		}
		const name = host?.name ?? placement.hostId;
		log(`[hosts] host ${placement.hostId} didn't answer for sandbox ${placement.sandboxId}; kept as placed there`);
		const known = new KantelError(
			"unavailable",
			`Host ${name} didn't answer (${error instanceof Error ? error.message : String(error)}): whether it made the sandbox is known once it reconnects`,
		);
		unansweredErrors.add(known);
		return known;
	};

	/**
	 * Refuses a create or fork whose ID is placed already. One its host has since said it doesn't have (`lost`, by its
	 * hello) may be made again: the compute plane retries a create that went unanswered this way. One still `starting`
	 * from such a create isn't known either way yet; one its host has is there, for a delete to end.
	 */
	const refuseTaken = (existing: PlacementRecord | undefined) => {
		if (existing === undefined || existing.state === "lost") return;
		if (existing.state === "starting") {
			throw new KantelError(
				"conflict",
				"A sandbox with that ID is being made, or its host hasn't said yet whether it made it; try again once it has",
			);
		}
		throw new KantelError("conflict", "A sandbox with that ID exists");
	};

	const reserve = (hostId: string, memoryMiB: number, diskGiB: number) => {
		reserved.set(hostId, [...(reserved.get(hostId) ?? []), { at: clock.now(), memoryMiB, diskGiB }]);
	};

	/**
	 * The machine a template build boots on `host`: what the host would make for a create of the vCPUs and memory asked
	 * for (`shapeOn`: one of its named sizes, or a custom shape where it makes them), disk and all, so a sandbox of that
	 * shape restored from the build is the machine a fresh boot of it would be. `not_supported` where it can make neither.
	 */
	const buildShape = (host: HostRecord, input: TemplateBuildInput): HostSize => {
		const shaped = shapeOn(host, { tier: "microvm", shape: { vcpus: input.vcpus, memoryMiB: input.memoryMiB } });
		if (shaped === undefined) {
			throw new KantelError(
				"not_supported",
				`The host ${host.name} can't make a microVM of ${input.vcpus} vCPUs and ${input.memoryMiB} MiB to build the template in`,
			);
		}
		return shaped.size;
	};

	/**
	 * Admits a template build to `host` as placement admits a sandbox: refused (`exhausted`) unless the memory and disk
	 * its last report left free, less what this replica placed and is building there unreported, fit its machine.
	 * Admitted, it holds them (`building`) until a report names the build or the caller lets the hold go, when the call
	 * has ended. The host admits it again, and alone for certain (`build`).
	 */
	const admitBuild = (
		host: HostRecord,
		snapshotId: string,
		shape: { readonly memoryMiB: number; readonly diskGiB: number },
	) => {
		if (!hub.connected(host.id)) {
			throw placementError("unavailable", "host_unavailable", `The host ${host.name} isn't connected`);
		}
		if (host.draining) throw placementError("unavailable", "host_unavailable", `The host ${host.name} is draining`);
		const capacity = host.capacity;
		const held = reservedOn(host);
		if (
			capacity === undefined ||
			capacity.freeMemoryMiB - held.memoryMiB < shape.memoryMiB ||
			capacity.freeDiskGiB - held.diskGiB < shape.diskGiB
		) {
			throw placementError(
				"exhausted",
				"insufficient_capacity",
				`The host ${host.name} has no room to build the template now`,
			);
		}
		const hold = { memoryMiB: shape.memoryMiB, diskGiB: shape.diskGiB };
		const holds = building.get(host.id) ?? new Map();
		holds.set(snapshotId, hold);
		building.set(host.id, holds);
		return () => {
			const current = building.get(host.id);
			if (current?.get(snapshotId) === hold) current.delete(snapshotId);
			if (current?.size === 0) building.delete(host.id);
		};
	};

	return {
		hub,
		async createJoinToken(input) {
			const minutes = input.expiresInMinutes ?? 60;
			if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10_080) {
				throw new KantelError("invalid", "expiresInMinutes is between 5 and 10080");
			}
			if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 100)) {
				throw new KantelError("invalid", "A host's name is at most 100 characters");
			}
			const token = secret(JOIN_TOKEN_PREFIX);
			const now = clock.now();
			const record = {
				id: shortId("hjt"),
				hash: await hashSecret(token),
				...(input.name === undefined ? {} : { name: input.name }),
				labels: labelsOf(input.labels),
				createdAt: now,
				expiresAt: now + minutes * 60_000,
			};
			await store.insertJoinToken(record);
			const url = options.publicUrl.replace(/\/+$/, "");
			const command = (options.joinCommand ?? DEFAULT_JOIN_COMMAND)
				.replaceAll("{url}", url)
				.replaceAll("{token}", token);
			return { id: record.id, token, command, expiresAt: record.expiresAt };
		},
		useJoinTokens(tokens) {
			joinTokens = tokens;
		},
		useCompute(link) {
			compute = link;
		},
		async recordSharedUsage(hostId, usage) {
			if (compute?.recordUsage === undefined) return;
			const parsed = parseHostUsage(usage);
			if (!parsed.ok) throw new KantelError("invalid", `The usage tick isn't valid: ${parsed.reason}`);
			await compute.recordUsage(hostId, parsed.value, { shared: true });
		},
		async register(input) {
			if (typeof input.token !== "string" || !input.token.startsWith(JOIN_TOKEN_PREFIX)) {
				throw new KantelError("forbidden", "That isn't a host join token");
			}
			const reported = input.facts === undefined ? undefined : parseHostFacts(input.facts);
			if (reported?.ok === false) throw new KantelError("invalid", `facts aren't valid: ${reported.reason}`);
			const facts = reported?.value;
			const hostId = shortId("host");
			const now = clock.now();
			const token = await joinTokens.spendJoinToken(await hashSecret(input.token), hostId, now);
			if (token === undefined) throw new KantelError("forbidden", "The join token is unknown, used or expired");
			const credential = secret(HOST_CREDENTIAL_PREFIX);
			const name =
				token.name ?? (typeof input.name === "string" && input.name.length > 0 ? input.name.slice(0, 100) : hostId);
			await store.insertHost({
				id: hostId,
				name,
				labels: { ...labelsOf(input.labels), ...token.labels },
				credentialHash: await hashSecret(credential),
				revoked: false,
				draining: false,
				...(token.accountId === undefined ? {} : { accountId: token.accountId }),
				joinedAt: now,
				...(facts === undefined ? {} : { facts }),
			});
			const into = token.accountId === undefined ? "" : ` into account ${token.accountId}`;
			log(`[hosts] host ${hostId} (${name}) joined with token ${token.id}${into}`);
			return { hostId, credential };
		},
		async e2eChain(hostId, space) {
			if (compute?.e2eChain === undefined) throw new KantelError("unavailable", "This gateway keeps no E2E chains");
			return compute.e2eChain.read(hostId, space);
		},
		async appendE2EChain(hostId, space, from, entries) {
			if (compute?.e2eChain === undefined) throw new KantelError("unavailable", "This gateway keeps no E2E chains");
			return compute.e2eChain.append(hostId, space, from, entries);
		},
		async bundle(hostId, sandboxId, digest) {
			if (compute?.bundle === undefined) throw new KantelError("unavailable", "This gateway keeps no bundles");
			return compute.bundle(hostId, sandboxId, digest);
		},
		async authenticate(credential) {
			if (!credential.startsWith(HOST_CREDENTIAL_PREFIX)) return undefined;
			const host = await store.hostByCredential(await hashSecret(credential));
			return host === undefined || host.revoked ? undefined : host;
		},
		async list(listOptions) {
			const allocations = listOptions?.allocations !== false;
			return Promise.all((await store.listHosts()).map((host) => view(host, allocations)));
		},
		async get(hostId) {
			return view(await hostOf(hostId));
		},
		async update(hostId, change) {
			const host = await hostOf(hostId);
			if (host.revoked) throw new KantelError("conflict", "The host is revoked");
			if (
				change.name !== undefined &&
				(typeof change.name !== "string" || change.name.length < 1 || change.name.length > 100)
			) {
				throw new KantelError("invalid", "A host's name is 1 to 100 characters");
			}
			const labels = change.labels === undefined ? undefined : labelsOf(change.labels);
			// On the host as stored now, so a report that lands meanwhile neither undoes this nor is undone by it.
			const next = await store.updateHost(hostId, (latest) => ({
				...latest,
				...(change.name === undefined ? {} : { name: change.name }),
				...(labels === undefined ? {} : { labels }),
				...(change.draining === undefined ? {} : { draining: change.draining === true }),
			}));
			if (next === undefined) throw new KantelError("not_found", "No such host");
			if (next.revoked) throw new KantelError("conflict", "The host is revoked");
			const redrained = change.draining !== undefined && change.draining !== host.draining;
			if (redrained) hub.rewelcome(hostId, await welcomeFor(next));
			return view(next);
		},
		async updateAgent(hostId) {
			const host = await hostOf(hostId);
			if (host.revoked) throw new KantelError("conflict", "The host is revoked");
			if (!hub.connected(hostId)) {
				throw new KantelError("unavailable", `${host.name} isn't connected: it can be updated once it's back`);
			}
			const wanted = target(await options.releases?.latest());
			if (wanted === undefined) {
				throw options.releases === undefined
					? new KantelError("not_supported", "This control plane names no kantel-host version for hosts to run")
					: new KantelError("unavailable", "Kantel couldn't read the latest kantel-host release. Try again later");
			}
			const version = storedFacts(host.facts)?.version;
			if (!needsUpdate(version, wanted.version, wanted.pinned)) {
				throw new KantelError("conflict", `${host.name} already runs kantel-host ${version ?? wanted.version}`);
			}
			const to = plainVersion(wanted.version);
			try {
				// The host answers once it has the binary in place: a download of tens of MB, so longer than a call's wait.
				await hub.call(
					hostId,
					HostMethods.hostUpdate,
					{ version: to, url: options.updateUrl ?? DEFAULT_HOST_UPDATE_URL },
					{ timeoutMs: UPDATE_TIMEOUT_MS },
				);
			} catch (error) {
				const converted = kantelErrorFromHost(error);
				// Sent and never answered (it timed out, or its link dropped): the host may still finish the download and
				// restart, so it's taken to be updating rather than refused, and the caller's record of it lapses if it doesn't.
				if (!unanswered(converted)) throw converted;
				log(`[hosts] ${host.name} (${hostId}) didn't answer its update to ${to}; it may still be updating`);
				return { version: to };
			}
			log(`[hosts] ${host.name} (${hostId}) is updating kantel-host from ${version ?? "unknown"} to ${to}`);
			return { version: to };
		},
		async revoke(hostId) {
			const host = await hostOf(hostId);
			const next = { ...host, revoked: true };
			await store.putHost(next);
			hub.disconnect(hostId, HOST_CLOSE_REVOKED, "The host's credential was revoked");
			return view(next);
		},
		sandboxes: {
			async create(input) {
				const tier = input.tier;
				if (tier !== "microvm" && tier !== "isolate") throw new KantelError("invalid", "tier is microvm or isolate");
				const sandboxId = input.sandboxId ?? shortId("sbx");
				if (!SANDBOX_ID.test(sandboxId)) throw new KantelError("invalid", "Not a valid sandbox ID");
				const shape = input.shape === undefined ? undefined : shapeIn(input.shape, tier);
				const only = input.hostIds === undefined ? undefined : new Set(input.hostIds);
				if (input.from !== undefined && only?.size !== 1) {
					throw new KantelError("invalid", "A sandbox made from a snapshot goes on the snapshot's host");
				}
				if (input.template !== undefined && tier !== "microvm") {
					throw new KantelError("invalid", "A sandbox made from a template is a microVM");
				}
				if (input.template?.snapshot !== undefined && only?.size !== 1) {
					throw new KantelError("invalid", "A sandbox made from a template snapshot goes on the snapshot's host");
				}
				// Two reads that don't depend on each other: one round trip.
				const [existing, listed] = await Promise.all([store.getPlacement(sandboxId), store.listHosts()]);
				refuseTaken(existing);
				const usable = listed
					.map(sane)
					.filter((host) => only === undefined || only.has(host.id))
					// An account's own host takes only that account's sandboxes, whatever the caller named.
					.filter((host) => host.accountId === undefined || host.accountId === input.owner);
				// A template goes only to a host that runs templates; a custom image's only to one that builds them.
				const templating =
					input.template === undefined
						? usable
						: usable.filter(input.template.image === undefined ? runsTemplates : buildsTemplateImages);
				if (templating.length === 0 && usable.length > 0) {
					throw placementError(
						"not_supported",
						"no_host_for_template",
						"No host that could take it runs templates; upgrade kantel-host",
					);
				}
				// Grants and protected variables go only where they are enforced.
				const hosts = needsEgressPolicy(input.egress) ? templating.filter(enforcesPolicy) : templating;
				if (hosts.length === 0 && templating.length > 0) {
					throw placementError(
						"not_supported",
						"no_host_enforces_egress",
						"No host that could take it enforces egress grants or protected variables; upgrade kantel-host",
					);
				}
				const candidates: Candidate[] = await Promise.all(
					hosts.map(async (host) => {
						const placements = tier === "isolate" ? await store.placementsOn(host.id) : [];
						const held = reservedOn(host);
						return {
							host,
							connected: hub.connected(host.id),
							reservedMemoryMiB: held.memoryMiB,
							reservedDiskGiB: held.diskGiB,
							owners: new Set(
								placements
									.filter((placement) => placement.tier === "isolate" && placement.owner !== undefined)
									.map((placement) => placement.owner as string),
							),
						};
					}),
				);
				const template = input.template;
				const chosen = place(
					{
						tier,
						...(input.size === undefined ? {} : { size: input.size }),
						...(shape === undefined ? {} : { shape }),
						...(input.owner === undefined ? {} : { owner: input.owner }),
						...(input.labels === undefined ? {} : { labels: input.labels }),
					},
					candidates,
				);
				if (isRefusal(chosen)) {
					// From a snapshot it goes only on the snapshot's host: that host not being up is the reason, not a lack of hosts.
					const pinned = input.from !== undefined || input.template?.snapshot !== undefined;
					const reason = pinned && chosen.code === "no_host" ? "host_unavailable" : chosen.code;
					throw placementError("exhausted", reason, chosen.reason);
				}
				const now = clock.now();
				const placement: PlacementRecord = {
					sandboxId,
					hostId: chosen.host.id,
					tier,
					size: chosen.size.name,
					...(input.owner === undefined ? {} : { owner: input.owner }),
					vcpus: chosen.size.vcpus,
					memoryMiB: chosen.size.memoryMiB,
					diskGiB: chosen.size.diskGiB,
					state: "starting",
					createdAt: now,
					updatedAt: now,
				};
				await store.putPlacement(placement);
				reserve(chosen.host.id, chosen.size.memoryMiB, chosen.size.diskGiB);
				const mounts = mountHandoff(chosen.host.facts?.features, input.mounts);
				try {
					const sandbox = await onHost<HostSandbox>(
						chosen.host.id,
						HostMethods.create,
						{
							sandboxId,
							tier,
							// A custom shape goes as its numbers (the host names it); a named size by its name.
							size: tier === "isolate" || chosen.custom ? "" : chosen.size.name,
							...(chosen.custom
								? { vcpus: chosen.size.vcpus, memoryMiB: chosen.size.memoryMiB, diskGiB: chosen.size.diskGiB }
								: {}),
							// What an isolate asked for, recorded by a host that knows of it.
							...(tier === "isolate" && shape !== undefined && makesCustomShapes(chosen.host)
								? { memoryMiB: shape.memoryMiB }
								: {}),
							...(input.from === undefined ? {} : { from: input.from }),
							// Its template boots as the size or custom shape placed, restoring its snapshot only if built as that.
							...(template === undefined ? {} : { template }),
							...(input.owner === undefined ? {} : { owner: input.owner }),
							...(input.env === undefined ? {} : { env: input.env }),
							...(input.sshAuthorizedKeys === undefined ? {} : { sshAuthorizedKeys: input.sshAuthorizedKeys }),
							...(input.egress === undefined ? {} : { egress: input.egress }),
							...mountsParam(mounts),
						},
						// From a template, as long as a build: a fresh boot pulls its base image and runs its setup.
						template === undefined ? undefined : { timeoutMs: TEMPLATE_BUILD_TIMEOUT_MS },
						chosen.host,
					);
					const settled = await settle(placement, sandbox, chosen.host);
					const statuses = mounts.status(sandbox);
					return {
						sandbox,
						hostId: chosen.host.id,
						placement: settled,
						nestedVirtualisation: chosen.host.facts?.nested ?? false,
						...(statuses === undefined ? {} : { mounts: statuses }),
					};
				} catch (error) {
					throw await unplace(placement, chosen.host, error);
				}
			},
			async fork(sandboxId, input = {}) {
				const source = await placementOf(sandboxId);
				const newId = input.newId ?? shortId("sbx");
				if (!SANDBOX_ID.test(newId)) throw new KantelError("invalid", "Not a valid sandbox ID");
				refuseTaken(await store.getPlacement(newId));
				const now = clock.now();
				const placement: PlacementRecord = {
					...source,
					sandboxId: newId,
					state: "starting",
					createdAt: now,
					updatedAt: now,
				};
				await store.putPlacement(placement);
				try {
					// The host is read only for a fork with mounts, to know which it can do.
					const features =
						(input.mounts?.length ?? 0) === 0
							? undefined
							: storedFacts((await store.getHost(source.hostId))?.facts)?.features;
					const mounts = mountHandoff(features, input.mounts);
					const sandbox = await onHost<HostSandbox>(source.hostId, HostMethods.fork, {
						sandboxId,
						newId,
						snapshotId: shortId("snap"),
						...(input.egress === undefined ? {} : { egress: input.egress }),
						...(input.env === undefined ? {} : { env: input.env }),
						...mountsParam(mounts),
					});
					const statuses = mounts.status(sandbox);
					return {
						sandbox,
						hostId: source.hostId,
						placement: await settle(placement, sandbox),
						...(statuses === undefined ? {} : { mounts: statuses }),
					};
				} catch (error) {
					throw await unplace(placement, await store.getHost(source.hostId), error);
				}
			},
			async call<T>(sandboxId: string, method: string, params: object = {}, callOptions?: CallOptions) {
				if (
					method === HostMethods.create ||
					method === HostMethods.fork ||
					method === HostMethods.portOpen ||
					method === HostMethods.fileOpen
				) {
					throw new KantelError("invalid", `${method} has its own entry point`);
				}
				if (method.startsWith("host.")) throw new KantelError("forbidden", "Host methods aren't a sandbox's");
				const placement = await placementOf(sandboxId);
				const extra = method === HostMethods.stop && !("snapshotId" in params) ? { snapshotId: shortId("snap") } : {};
				const result = await onHost<T>(placement.hostId, method, { ...params, ...extra, sandboxId }, callOptions);
				const state = method === HostMethods.stop ? "stopped" : (result as { state?: unknown } | undefined)?.state;
				if (
					typeof state === "string" &&
					(method === HostMethods.stop || (result as { id?: unknown }).id === sandboxId)
				) {
					const size = (result as { size?: unknown } | undefined)?.size;
					await store.putPlacement({
						...asReported(placement, { state, size }, await store.getHost(placement.hostId), clock.now()),
						updatedAt: clock.now(),
					});
				}
				return result;
			},
			async delete(sandboxId) {
				const placement = await placementOf(sandboxId);
				const host = await store.getHost(placement.hostId);
				if (host === undefined || host.revoked) {
					// Its host was revoked (or removed) by an operator: it never connects again to say, so deleting the sandbox
					// writes off its placement. That is the operator's decision; nothing here claims the machine is gone.
					log(`[hosts] sandbox ${sandboxId} written off: its host ${placement.hostId} is revoked`);
					await store.removePlacement(sandboxId);
					return;
				}
				try {
					await onHost(placement.hostId, HostMethods.delete, { sandboxId });
				} catch (error) {
					// Gone on the host already is gone.
					if (!(error instanceof KantelError && error.code === "not_found")) throw error;
				}
				await store.removePlacement(sandboxId);
			},
			placement(sandboxId) {
				return store.getPlacement(sandboxId);
			},
			async openPort(sandboxId, port, sink) {
				// Port 0 is the host's E2E responder for the sandbox (`HOST_E2E_PORT`), which only the host can read.
				if (!Number.isInteger(port) || port < HOST_E2E_PORT || port > 65_535) {
					throw new KantelError("invalid", "Not a port");
				}
				const placement = await placementOf(sandboxId);
				// Every relayed stream is someone using the sandbox: its opening, and its bytes either way, count toward its
				// idle stop. An open stream that carries nothing (an SSH session left alone) doesn't.
				const used = () => compute?.activity?.(sandboxId);
				let stream: PortStream;
				try {
					stream = await hub.openPort(placement.hostId, sandboxId, port, {
						data(bytes) {
							used();
							sink.data(bytes);
						},
						end: (reason) => sink.end(reason),
					});
				} catch (error) {
					throw kantelErrorFromHost(error);
				}
				used();
				return {
					stream: stream.stream,
					write(bytes) {
						used();
						stream.write(bytes);
					},
					close: () => stream.close(),
				};
			},
			async openFile(sandboxId, params, sink) {
				if (params.op !== "read" && params.op !== "write") throw new KantelError("invalid", "op is read or write");
				const placement = await placementOf(sandboxId);
				// A file stream's bytes aren't relayed between replicas (`cluster.ts` relays calls and port streams only): the
				// compute service falls back to the file calls, which are.
				if (!local.connected(placement.hostId) && hub.connected(placement.hostId)) {
					throw new KantelError("not_supported", "File streams need the sandbox's host connected to this gateway");
				}
				try {
					return await hub.openFile(placement.hostId, { ...params, sandboxId }, sink);
				} catch (error) {
					throw kantelErrorFromHost(error);
				}
			},
		},
		templates: {
			async runtimes() {
				const out: HostTemplateRuntime[] = [];
				for (const host of (await store.listHosts()).map(sane)) {
					if (host.revoked || host.draining || !hub.connected(host.id) || !runsTemplates(host)) continue;
					const facts = host.facts;
					if (facts === undefined || !facts.tiers.includes("microvm")) continue;
					out.push({
						hostId: host.id,
						...(facts.guestKernel === undefined ? {} : { guestKernel: facts.guestKernel }),
						...(facts.firecracker === undefined ? {} : { firecracker: facts.firecracker }),
						...(buildsTemplateImages(host) ? { customImages: true } : {}),
					});
				}
				return out;
			},
			async build(hostId, input) {
				const host = sane(await hostOf(hostId));
				// An account's own host builds only that account's templates, as it takes only its sandboxes.
				if (host.revoked || (host.accountId !== undefined && host.accountId !== input.owner)) {
					throw new KantelError("unavailable", `The host ${host.name} can't build this template`);
				}
				if (host.facts?.tiers.includes("microvm") !== true) {
					throw new KantelError("not_supported", `The host ${host.name} doesn't run microVMs, which templates make`);
				}
				if (!runsTemplates(host)) {
					throw new KantelError(
						"not_supported",
						`The host ${host.name} doesn't run templates; upgrade its kantel-host`,
					);
				}
				// A custom image only to a host that builds it in a build microVM: an older one would drop `image` and build the
				// base instead.
				if (input.image !== undefined && !buildsTemplateImages(host)) {
					throw new KantelError(
						"not_supported",
						`The host ${host.name} doesn't build templates' custom images; switch its templateBuilder on`,
					);
				}
				const shape = buildShape(host, input);
				const params: HostTemplateBuild = {
					...input,
					vcpus: shape.vcpus,
					memoryMiB: shape.memoryMiB,
					diskGiB: shape.diskGiB,
				};
				// Its machine's memory and disk, held from before the call until a report counts the build or the call ends.
				const release = admitBuild(host, input.snapshotId, shape);
				try {
					return await onHost<HostTemplateBuilt>(
						hostId,
						HostMethods.templateBuild,
						params,
						{ timeoutMs: input.image === undefined ? TEMPLATE_BUILD_TIMEOUT_MS : TEMPLATE_IMAGE_BUILD_TIMEOUT_MS },
						host,
					);
				} finally {
					release();
				}
			},
			async delete(hostId, snapshotId) {
				await onHost(hostId, HostMethods.templateDelete, { snapshotId });
			},
		},
		close() {
			hub.closeAll(1001, "The control plane is stopping");
		},
	};
}

export { sizeOn };
