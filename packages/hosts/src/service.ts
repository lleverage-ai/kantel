/**
 * The host registry and the compute plane's dispatch: join tokens, registration, the hosts' connections (through the
 * hub), the operator's view and changes, and sandboxes placed on hosts and reached through them.
 *
 * The public sandbox API (docs/site/src/content/docs/api/reference/sandboxes.md) is built over `sandboxes` here; this
 * package doesn't decide who may use which sandbox, only where it runs and how it is reached.
 */
import {
	type TarEntry,
	UPGRADE_MOVE_LIMITS,
	UPGRADE_WORKSPACE,
	upgradeOutcomeUnknown,
	writeTar,
} from "@kantel/compute";
import { type Clock, isKantelError, KantelError, placementError, systemClock } from "@kantel/contracts";
import type { HostCluster } from "./cluster.ts";
import {
	cpuFingerprintText,
	parseHostCapacity,
	parseHostFacts,
	parseHostUsage,
	parseMountStatuses,
	storedCapacity,
	storedFacts,
	withoutAdmission,
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
import { meshAddressFor, meshPeerChanged, meshPeersAmong, meshPrefix, runsMesh } from "./mesh.ts";
import {
	HOST_CLOSE_REVOKED,
	HOST_FEATURES,
	type HostBucketSource,
	type HostCapacity,
	type HostDiskFetchParams,
	type HostDiskLimits,
	type HostDiskLocateParams,
	type HostDiskLocateResult,
	type HostDiskUsage,
	type HostEgress,
	type HostEgressRecord,
	type HostEnvAnswer,
	type HostExecResult,
	type HostFacts,
	type HostGrantKey,
	type HostHello,
	type HostImageChannel,
	type HostIsolateRuntime,
	type HostMemoryReport,
	type HostMeshHealth,
	type HostMeshPeer,
	HostMethods,
	type HostMount,
	type HostMountStatus,
	type HostSandbox,
	type HostSandboxUsage,
	type HostSecrets,
	type HostSize,
	type HostStickyDisk,
	type HostStickyHolding,
	type HostTemplateBoot,
	type HostTemplateBuild,
	type HostTemplateBuilt,
	type HostUsageReport,
	type HostWelcome,
	type HostWelcomeMesh,
	needsEgressPolicy,
	type SandboxTier,
} from "./protocol.ts";
import {
	DEFAULT_HOST_UPDATE_URL,
	type HostReleases,
	needsUpdate,
	plainVersion,
	type ReleaseCheck,
} from "./releases.ts";
import {
	buildFitsOn,
	type Candidate,
	type HeldMemory,
	hostSizeNamed,
	isRefusal,
	makesCustomShapes,
	place,
	type Shape,
	shapeOn,
	sizeOn,
} from "./scheduler.ts";
import { admits, type HostRecord, type HostStore, isLeftover, type PlacementRecord } from "./store.ts";

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
	/** The disk it gives a microVM off its sizes, where it says. */
	readonly disk?: HostDiskLimits;
	readonly kvm: boolean;
	readonly nestedVirtualisation: boolean;
	/** What it does beyond protocol 1 as first released (`HOST_FEATURES`). */
	readonly features: readonly string[];
	/** What its isolate runtime can do, as it last said (its hello's facts); absent until it has said. */
	readonly isolate?: HostIsolateRuntime;
	/** Its CPU fingerprint as text (`cpuFingerprintText`), from its facts; absent until it has said. */
	readonly cpuFingerprint?: string;
	/** Its microVM runtime fingerprints (`HostRuntime.runtime`), from its facts; absent until it has said. */
	readonly runtimeFingerprints?: readonly string[];
	readonly capacity: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb: number };
	/**
	 * The disk it had free when it last reported (its hello or a heartbeat), what placement admits a create against;
	 * `capacity.diskGb` is the same, else what it had free when it started. Absent until it has reported.
	 */
	readonly freeDiskGb?: number;
	/** What takes the space on its disk, from its latest heartbeat that measured it (`HostDiskUsage`). */
	readonly diskUsage?: HostDiskUsage;
	/** Its memory, from its latest report. */
	readonly memory?: Omit<HostMemoryReport, "admission">;
	/**
	 * How it reaches its mesh peers, from its latest report, while it is connected: a report from before it dropped
	 * says nothing about now. Absent from a host without a mesh (its pool's sync off, or an older host agent).
	 */
	readonly mesh?: HostMeshHealth;
	readonly allocated: {
		readonly sandboxes: number;
		readonly vcpus: number;
		readonly memoryMb: number;
		readonly diskGb: number;
	};
	readonly labels: { readonly [key: string]: string };
	/** The account whose own host it is, which alone may use it; absent for a shared host. */
	readonly accountId?: string;
	/** The pool it is in (`HostRecord.poolId`); absent until the compute plane has said. */
	readonly poolId?: string;
	/**
	 * Its address in its pool's mesh (`HostRecord.mesh`): only for a host that runs the mesh, given in the pool it is in
	 * now. Whether the pool has sync on, so the address is up, is the compute plane's to say.
	 */
	readonly meshAddress?: string;
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
	 * A microVM's vCPUs and memory, and its disk where one is chosen, or an isolate's memory (`vcpus` 0). A shape off the
	 * host's named sizes boots from scratch; an isolate's memory is recorded on its host, not enforced.
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
	/**
	 * The pool `hostIds` were chosen in: a host in another as it admits it (moved since) refuses it. Absent, or where the
	 * registry doesn't know the host's pool yet, any.
	 */
	readonly poolId?: string;
	/** Start from this snapshot, which is on the one host `hostIds` names. */
	readonly from?: string;
	/** Read-only mounts: those the chosen host can do are sent, the others answered `failed` (`mountHandoff`). */
	readonly mounts?: readonly HostMount[];
	/** Sticky disks (microVMs only): it goes only on a host that runs them (`HOST_FEATURES.stickyDisks`). */
	readonly stickyDisks?: readonly HostStickyDisk[];
	/**
	 * Made from a template (microVMs only); one with a `snapshot` goes on the one host `hostIds` names, which holds it,
	 * and restores it only when it was built as the create's size or shape.
	 */
	readonly template?: HostTemplateBoot;
}

/** A microVM to make from an isolate (`sandboxes.upgrade`): a microVM create's input, without a template or snapshot. */
export type UpgradeSandboxInput = Omit<CreateSandboxInput, "sandboxId" | "tier" | "from" | "mounts" | "template">;

/** An upgrade's microVM: its placement, and whether its own host (`host`) or Kantel (`control-plane`) moved its files. */
export interface UpgradedSandbox extends SandboxPlacement {
	readonly path: "host" | "control-plane";
	readonly files: number;
	readonly bytes: number;
}

/** Where an upgrade's tar is put in the microVM before its host extracts it (and deletes it). */
const UPGRADE_STAGING = "/tmp/.kantel-upgrade.tar";
/** Makes `/workspace` a link to the upgraded files, as root: an empty directory there is replaced. */
const UPGRADE_LINK = `set -e\nif [ -d /workspace ] && [ ! -L /workspace ]; then rmdir /workspace; fi\nln -sfn ${UPGRADE_WORKSPACE} /workspace`;
/** How long an isolate's host may take to hold it still for an upgrade: its wait for a command under way, and more. */
const FREEZE_TIMEOUT_MS = 3 * 60_000;
/** How much of a file one read from an isolate's host takes, as Kantel moves its files to another host. */
const UPGRADE_READ_BYTES = 8 * 1024 * 1024;
/** The most of the tar one write carries to the microVM's host: a bigger one goes in parts, joined there. */
const UPGRADE_WRITE_BYTES = 24 * 1024 * 1024;

/** How many of an isolate's files are read at once as Kantel moves them to another host. */
const UPGRADE_READS = 16;

/** An entry of an isolate's `/workspace` as an upgrade to another host lists it, before its files are read. */
type WorkspaceEntry =
	| { readonly kind: "directory"; readonly name: string }
	| { readonly kind: "symlink"; readonly name: string; readonly target: string }
	| {
			readonly kind: "file";
			readonly name: string;
			readonly path: string;
			readonly size: number;
			readonly mode: number;
	  };

/**
 * The target a link at `name` (relative to `/workspace`) gets in an upgrade's tar, as kantel-host's own upgrade makes
 * it (`workspaceLink` in apps/host/internal/isolate/upgrade.go): one to `/workspace` or a path under it, which the
 * isolate resolves in its workspace, made relative to the link's directory (the rest of the path as it was, `..` and
 * all), so it points at the same file in the microVM and the host's extractor, which refuses an absolute link, takes
 * it. Any other is left as it was: one out of the workspace is refused there.
 */
const workspaceLink = (name: string, target: string): string => {
	const top = "/workspace";
	if (target !== top && !target.startsWith(`${top}/`)) return target;
	const rest = target.slice(top.length).replace(/^\/+/, "");
	const up = "../".repeat(name.split("/").length - 1);
	if (rest === "") return up === "" ? "." : up.slice(0, -1);
	return up + rest;
};

/**
 * Whether `target`, read as text from a link at `name` (relative to `/workspace`), stays in the workspace: the microVM's
 * extractor's test (`linkInside` in apps/host/internal/guest/extract.go), which never reads through the links it names.
 */
const linkStaysInside = (name: string, target: string): boolean => {
	if (target === "" || target.startsWith("/")) return false;
	let depth = name.split("/").length - 1;
	for (const part of target.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (depth === 0) return false;
			depth--;
		} else depth++;
	}
	return true;
};

/** Bounds on `resolveInWorkspace`'s work, which reads targets the guest wrote (as in kantel-host's). */
const MAX_LINK_TARGET = 4096;
const MAX_LINK_STEPS = 4096;
const MAX_LINK_HOPS = 40;

/** A listed entry, as `resolveInWorkspace` needs it: a directory, a file, or a link and its target. */
type ListedKind = { readonly kind: "directory" | "file" } | { readonly kind: "symlink"; readonly target: string };

/**
 * Walks `target` (relative, or absolute in `/workspace`) from `dir` as the isolate does, following the links it passes
 * through (not a last one, which is what the link names), at most `MAX_LINK_HOPS`. Every component it passes through
 * must be a directory or a link in `listed`, as the isolate needs it to be (a missing one, or a file, is ENOENT or
 * ENOTDIR there): one that isn't, a walk out of the workspace, a loop or too much work answers undefined. Else the path
 * in the workspace ("" for its top) it ends at. As `resolveInWorkspace` in apps/host/internal/isolate/upgrade.go.
 */
const resolveInWorkspace = (
	listed: ReadonlyMap<string, ListedKind>,
	dir: string,
	target: string,
): string | undefined => {
	const cur: string[] = target.startsWith("/") || dir === "" ? [] : dir.split("/");
	// What is left to walk, last component first, so each step takes one off the end.
	const pending: string[] = [];
	const push = (to: string): boolean => {
		if (to.length > MAX_LINK_TARGET) return false;
		let rest = to;
		if (to.startsWith("/")) {
			if (to !== "/workspace" && !to.startsWith("/workspace/")) return false;
			cur.length = 0;
			rest = to.slice("/workspace".length);
		}
		// "." stays, as a trailing "/" does (as "."): what comes before either must be a directory, as in the isolate.
		const parts = rest.split("/");
		if (rest.endsWith("/") && parts.length > 1) parts[parts.length - 1] = ".";
		for (let index = parts.length - 1; index >= 0; index--) {
			const part = parts[index];
			if (part !== undefined && part !== "") pending.push(part);
		}
		return true;
	};
	if (!push(target)) return undefined;
	let hops = 0;
	let steps = 0;
	for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
		if (++steps > MAX_LINK_STEPS) return undefined;
		if (part === ".") continue;
		if (part === "..") {
			if (cur.length === 0) return undefined;
			cur.pop();
			continue;
		}
		cur.push(part);
		// The last component: what the link names, there or not.
		if (pending.length === 0) break;
		const entry = listed.get(cur.join("/"));
		if (entry?.kind === "directory") continue;
		if (entry?.kind !== "symlink") return undefined;
		if (++hops > MAX_LINK_HOPS) return undefined;
		cur.pop();
		if (!push(entry.target)) return undefined;
	}
	return cur.join("/");
};

/**
 * The target a link at `name` gets in an upgrade's tar, as kantel-host's own upgrade makes it (`exportLink` in
 * apps/host/internal/isolate/upgrade.go): `workspaceLink`'s, where that stays in the workspace as text; else, where the
 * isolate resolves it in the workspace through a link it names (`jump -> deep/sub`, then `jump/../../file`), the path to
 * that file relative to the link's directory. Any other is left as it was: the extractor refuses it.
 */
const exportLink = (listed: ReadonlyMap<string, ListedKind>, name: string, target: string): string => {
	const text = workspaceLink(name, target);
	if (linkStaysInside(name, text)) return text;
	const at = name.lastIndexOf("/");
	const resolved = resolveInWorkspace(listed, at < 0 ? "" : name.slice(0, at), text);
	if (resolved === undefined) return text;
	const up = "../".repeat(name.split("/").length - 1);
	if (resolved === "") return up === "" ? "." : up.slice(0, -1);
	return up + resolved;
};

/** A file of a sandbox, as `sandbox.files.list` answers it. */
interface ListedFile {
	readonly path: string;
	readonly type: string;
	readonly size: number;
	readonly mode?: number;
	readonly target?: string;
}

function base64Of(bytes: Uint8Array): string {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(binary);
}

function bytesOf(base64: string): Uint8Array {
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
	return out;
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
/**
 * How long a fork, or a create from a sandbox's snapshot, may take: the host writes the machine's memory and copies its
 * disk, gigabytes each, which on a busy disk took 150-300 s for a 4 vCPU / 16 GB microVM with 16 GB on its disk. Past
 * the default call timeout the sandbox was put in `error` while its host went on and started it.
 */
export const DISK_COPY_TIMEOUT_MS = 30 * 60_000;

/** Join tokens kept elsewhere, such as by the compute API, which mints them (`createHostJoinToken`). */
export interface ExternalJoinTokens {
	/**
	 * Whether an account still takes hosts. Asked once a host joined with an account's token is stored: one whose account
	 * closed meanwhile (its person deleted their account) is revoked before its credential is handed back.
	 */
	accountOpen?(accountId: string): Promise<boolean>;
	/**
	 * Spends the token with this SHA-256 hex once: its name and labels, the account an account's join token joins the
	 * host to, and the pool; or undefined if unknown, used or expired.
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
				readonly poolId?: string;
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
	/** A sandbox's env as the compute plane has it now, or `undefined` unless the sandbox is on `hostId`. */
	env?(hostId: string, sandboxId: string): Promise<HostEnvAnswer | undefined>;
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
	 * Updates the sizes of a host's snapshots to what they take on its disk now (`HOST_FEATURES.snapshotSizes`), from its
	 * snapshot list, read once a connection and every `SNAPSHOT_SIZES_REFRESH_MS`: each snapshot's bytes and what of them
	 * are its own, and the files several share, by their refs. A snapshot is named by its ref, `<hostId>/<id>`
	 * (`ComputeService.recordSnapshotSizes`).
	 */
	recordSnapshotSizes?(
		hostId: string,
		sizes: readonly { readonly ref: string; readonly sizeBytes: number; readonly uniqueBytes?: number }[],
		shared?: readonly { readonly refs: readonly string[]; readonly bytes: number }[],
	): Promise<void>;
	/**
	 * A host's `bucket.fetch`: the bucket source with its credentials opened, or `undefined` unless the sandbox is on
	 * `hostId` and mounts it (`ComputeService.bucketSourceForHost`).
	 */
	bucketSource?(hostId: string, sandboxId: string, bucketSourceId: string): Promise<HostBucketSource | undefined>;
	/**
	 * A host's sticky disk holdings, from each hello and heartbeat that says what it holds, received at `at`: the
	 * catalogue's copies on that host are made what it reports (`ComputeService.recordStickyHoldings`). Called by the
	 * gateway holding the connection alone.
	 */
	recordStickyHoldings?(hostId: string, at: number, holdings: readonly HostStickyHolding[]): Promise<void>;
	/** A host's `disk.locate` (`ComputeService.locateDisk`). */
	locateDisk?(hostId: string, params: HostDiskLocateParams): Promise<HostDiskLocateResult>;
	/**
	 * The grant keys hosts accept fetch grants from, for their welcomes (`ComputeService.grantKeys`): the one that signs
	 * first, then those rotated out. Undefined while there are none. A failure is logged and the welcome goes without, so
	 * a host still connects (and keeps the keys it has).
	 */
	grantKeys?(): Promise<readonly HostGrantKey[] | undefined>;
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
	 * A host's word on whether a running microVM's guest agent answers (`HOST_FEATURES.guestHealth`): `health`
	 * `unresponsive` with its `reason` while it doesn't, absent once it does (`ComputeService.reportHealth`), `healthAt`
	 * ordering them. Only for a sandbox whose placement is on that host.
	 */
	reportHealth?(
		hostId: string,
		sandboxId: string,
		health: string | undefined,
		reason: string | undefined,
		healthAt?: number,
	): Promise<void>;
	/**
	 * A host's word that a sandbox's machine there ended without Kantel asking: it reports the sandbox `stopped` (or
	 * `error`) with an `error` saying why, in an event when the VM exits (its memory guard, the kernel's OOM killer at
	 * its limit, a crash) or in its hello after a restart (`ComputeService.reportExit`). A stop Kantel asks for leaves
	 * no error, so it is never sent for one; the compute plane takes it only for a sandbox it has `running` there, and
	 * only for the machine its run booted: `healthAt` is the host's last health stamp for the machine that ended
	 * (absent from a host that predates sending it with a stopped sandbox).
	 */
	reportExit?(hostId: string, sandboxId: string, error: string, healthAt?: number): Promise<void>;
	/**
	 * A host connected here (its hello welcomed) or its connection here ended: whether its sandboxes can be reached
	 * changed (`ComputeService.reportHostConnection`). Called by the gateway holding the connection alone.
	 */
	hostConnection?(hostId: string, connected: boolean): Promise<void>;
	/**
	 * Whether a pool has sync on (`ComputeService.poolSync`): only its hosts that run the mesh get their place in it
	 * (`HostWelcome.mesh`) and their peers (`mesh.peers`). Absent, no pool has.
	 */
	poolSync?(poolId: string): Promise<boolean>;
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
	/**
	 * The host images Kantel wants hosts on, for their welcome (image patching, experimental): from the base image index's
	 * `host` entry, its `stable` version. Absent (the feature off), or undefined (no such version), the welcome has none
	 * and hosts keep the images they have. A failure is logged and the welcome goes without, so a host still connects.
	 */
	images?(): Promise<HostImageChannel | undefined>;
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
	/** How long an upgrade's call to its isolate's host waits for its answer (default `DISK_COPY_TIMEOUT_MS`). */
	readonly upgradeTimeoutMs?: number;
	/** What an upgrade moves between hosts at most (default `UPGRADE_MOVE_LIMITS`). */
	readonly upgradeMoveLimits?: { readonly files: number; readonly bytes: number };
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
	/**
	 * The pool its host was in as it admitted it (`admits`), which the sandbox is in: the one asked for, where it was kept
	 * to one, or for one that wasn't, where it landed. Absent where the registry doesn't know the host's pool yet.
	 */
	readonly poolId?: string;
}

/** A connected host's last capacity report's sticky disk holdings (`HostCapacity.stickyDisks`). */
export interface HostStickyReport {
	readonly hostId: string;
	/** When Kantel received the report: the host measured it a moment before. */
	readonly at: number;
	/** The versions it holds. Absent: it doesn't say (a host without sticky disks, or from before them), not none. */
	readonly stickyDisks?: readonly HostStickyHolding[];
}

export interface HostsService {
	readonly hub: HostHub;
	/** Deletes a sticky disk's version (or all its versions) from a host that runs sticky disks; `unavailable` if away. */
	stickyDelete(hostId: string, diskId: string, version?: string): Promise<void>;
	/** What each host connected here last reported holding of sticky disks, and when that report arrived. */
	stickyReports(): Promise<HostStickyReport[]>;
	/**
	 * Has a host fetch a disk version from its peers (`disk.fetch`, `HOST_FEATURES.diskSync`), resolving once the fetch
	 * has started; `unavailable` if away.
	 */
	diskFetch(hostId: string, params: HostDiskFetchParams): Promise<void>;
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
			/** The drain's or undrain's place in the compute plane's order: taken only over an older one. */
			readonly drainEpoch?: number;
			/** The pool the compute plane put it in: a move, once it has drained. */
			readonly poolId?: string;
		},
	): Promise<HostView>;
	revoke(hostId: string): Promise<HostView>;
	/**
	 * A pool's settings changed (its sync, as `HostComputeLink.poolSync` reads it now): each of its hosts that runs the
	 * mesh is sent its peers (none, with sync off) and its welcome again, which brings its mesh up or takes it down.
	 */
	poolChanged(poolId: string): Promise<void>;
	/**
	 * The control plane's grant keys changed (`ComputeHooks.grantKeys`): every host, wherever it is connected, is sent its
	 * welcome again, which carries them. A host missed is told on a heartbeat within `GRANT_KEYS_REFRESH_MS`.
	 */
	grantKeysChanged(): Promise<void>;
	/**
	 * Whether a sandbox is placed on the host, one being made there included (a lost one not), an upgrade under way
	 * makes its microVM there, or an upgraded isolate there is still to be deleted.
	 */
	holds(hostId: string): Promise<boolean>;
	/**
	 * Asks a connected host to update its kantel-host to `latestVersion`: it fetches the binary, checks it against the
	 * release's SHA256SUMS and restarts into it, its sandboxes running on. Answers once the binary is in place, with the
	 * version it is moving to; the host connects again on it a few seconds later. `conflict` when it's revoked or already
	 * on that version (or a newer one), `unavailable` when it isn't connected or no version is known, and `not_supported`
	 * when the host refuses.
	 */
	updateAgent(hostId: string): Promise<{ readonly version: string }>;
	/**
	 * Reads Kantel's latest kantel-host release again now (`HostReleases.check`), rather than on its hourly schedule, so
	 * hosts behind a release just published show as out of date at once: on every replica sharing the store. Done at most
	 * every `CHECK_GAP_MS`; within it, `checked` is false and nothing is read. `not_supported` when this control plane
	 * reads no release (the operator set the version, or KANTEL_HOST_RELEASES is `off`), `unavailable` when it can't be
	 * read.
	 */
	checkForUpdates(): Promise<ReleaseCheck>;
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
				/** The pool it is kept to, as a create's (`CreateSandboxInput.poolId`): its source's host must be in it. */
				readonly poolId?: string;
			},
		): Promise<SandboxPlacement>;
		/**
		 * Makes an isolate a microVM with the same ID and its files: on its own host where that host does it
		 * (`HOST_FEATURES.isolateUpgrade`, with room), else on another that may take it, the files moved by Kantel (up to
		 * `UPGRADE_MOVE_LIMITS`), the isolate deleted from its host once the microVM runs with them. A failure leaves the
		 * isolate as it was, placed where it was. Answers the microVM's placement, how its files went and how many.
		 */
		upgrade(sandboxId: string, input: UpgradeSandboxInput & { readonly operationId: string }): Promise<UpgradedSandbox>;
		/**
		 * Upgrade `operationId`'s outcome, for one whose answer or gateway was lost: done (the microVM, placed), or failed
		 * and rolled back. Rejects while a host it needs can't be reached.
		 */
		settleUpgrade(
			sandboxId: string,
			operationId: string,
		): Promise<
			| { readonly state: "done"; readonly upgraded: UpgradedSandbox }
			| { readonly state: "failed"; readonly reason?: string }
		>;
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

/**
 * How often a connected host that runs the mesh has what it was last told of its pool's mesh checked against what it
 * should have now, on a heartbeat: a telling missed (a read that failed, a replica that couldn't be reached, a change
 * whose telling failed after it was written) is made good within this.
 */
export const MESH_REFRESH_MS = 60 * 1000;

/**
 * How often a connected host has the grant keys it was last told checked against the control plane's, on a heartbeat:
 * a rotation's telling missed, or one done on another replica's store write alone, is made good within this.
 */
export const GRANT_KEYS_REFRESH_MS = 60 * 1000;

/** How often a connected host's snapshot list is read again for their sizes (`HOST_FEATURES.snapshotSizes`). */
export const SNAPSHOT_SIZES_REFRESH_MS = 10 * 60 * 1000;

/** The most groups of shared files a host's snapshot list may name (`HostSharedBytes`). */
export const MAX_SHARED_GROUPS = 10_000;

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

/** A shape as asked: whole vCPUs (0 for an isolate) and memory in MiB, at least 128, and a microVM's whole GiB of disk. */
function shapeIn(shape: Shape, tier: SandboxTier): Shape {
	const { vcpus, memoryMiB, diskGiB } = shape;
	if (!Number.isInteger(vcpus) || !Number.isInteger(memoryMiB) || memoryMiB < 128) {
		throw new KantelError("invalid", "A shape is whole vCPUs and at least 128 MiB of memory");
	}
	if (tier === "microvm" ? vcpus < 1 : vcpus !== 0) {
		throw new KantelError("invalid", tier === "microvm" ? "A microVM has at least 1 vCPU" : "An isolate has no vCPUs");
	}
	if (diskGiB === undefined) return { vcpus, memoryMiB };
	if (tier !== "microvm") throw new KantelError("invalid", "An isolate has no disk of its own");
	if (!Number.isInteger(diskGiB) || diskGiB < 1) throw new KantelError("invalid", "A disk is whole GiB, at least 1");
	return { vcpus, memoryMiB, diskGiB };
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

/** Kantel's errors for host calls whose host wasn't there to answer (`HostCallError.disconnected`). */
const awayErrors = new WeakSet<object>();

/**
 * Whether `error` is a host call whose host wasn't there, as this replica saw it: not connected, or gone while the call
 * waited. A peer replica's relay of the call doesn't carry it.
 */
export function hostWasAway(error: unknown): boolean {
	return typeof error === "object" && error !== null && awayErrors.has(error);
}

/** A host's error as Kantel's: the codes line up where they can. */
export function kantelErrorFromHost(error: unknown): unknown {
	if (!(error instanceof HostCallError)) return error;
	const mapped = kantelCodeError(error);
	if (error.unanswered) unansweredErrors.add(mapped);
	if (error.disconnected) awayErrors.add(mapped);
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
	const upgradeTimeoutMs = options.upgradeTimeoutMs ?? DISK_COPY_TIMEOUT_MS;
	/**
	 * How long a gateway's claim on rolling back an upgrade lasts (`upgrade.settling`): past its two calls' time and some,
	 * so a gateway still at it is never taken for gone.
	 */
	const settleLeaseMs = 2 * (options.callTimeoutMs ?? 120_000) + 60_000;
	const moveLimits = options.upgradeMoveLimits ?? UPGRADE_MOVE_LIMITS;
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
			// As the host counts them (`freeMemoryOn`): a build in full.
			memory: [
				...live.map((entry) => ({ memoryMiB: entry.memoryMiB })),
				...[...(builds?.values() ?? [])].map((entry) => ({ memoryMiB: entry.memoryMiB, build: true })),
			] satisfies HeldMemory[],
		};
	};
	/** The vCPUs of the live microVMs among `placements` (`LIVE`): what a host's CPUs are booked for. */
	const bookedVcpus = (placements: readonly PlacementRecord[]): number =>
		placements
			.filter((placement) => placement.tier === "microvm" && LIVE.has(placement.state))
			.reduce((sum, placement) => sum + placement.vcpus, 0);
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
	/**
	 * Whether a host may be in its pool's mesh as far as the host is concerned: it runs the mesh and is in a pool, with
	 * a compute plane linked that says which pools have sync on.
	 */
	const meshable = (host: HostRecord): host is HostRecord & { readonly poolId: string } =>
		runsMesh(host) && host.poolId !== undefined && compute?.poolSync !== undefined;

	/**
	 * The host as written with its mesh address in its pool: the one it has there, or a new one none of the pool's other
	 * hosts has (`mesh.ts`), written only while it is still in that pool without one. Unchanged for a host not meshable.
	 */
	const withMeshAddress = async (host: HostRecord): Promise<HostRecord> => {
		if (!meshable(host) || host.mesh?.poolId === host.poolId) return host;
		const poolId = host.poolId;
		const taken = new Set<string>();
		for (const other of await store.listHosts()) {
			if (other.id !== host.id && other.poolId === poolId && other.mesh?.poolId === poolId) {
				taken.add(other.mesh.address);
			}
		}
		const address = await meshAddressFor(poolId, host.id, taken);
		if (address === undefined) {
			log(`[hosts] no mesh address left for host ${host.id} in pool ${poolId}`);
			return host;
		}
		const written = await store.updateHost(host.id, (latest) =>
			latest.poolId !== poolId || latest.mesh?.poolId === poolId ? undefined : { ...latest, mesh: { poolId, address } },
		);
		return written ?? (await store.getHost(host.id)) ?? host;
	};

	/**
	 * The host's place in its pool's mesh, for its welcome: its address, the pool's prefix and its peers (every other
	 * host of the pool that runs the mesh, revoked ones not). Undefined for a host that doesn't run the mesh, isn't in a
	 * pool, or whose pool has sync off. Rejects when that can't be read: a welcome without the mesh takes the host's mesh
	 * down, so none is sent then (a hello is refused, and the host tries again; a rewelcome is skipped).
	 */
	const meshFor = async (
		host: HostRecord,
		/** The hosts to find its peers among: read now unless given. */
		hosts?: readonly HostRecord[],
	): Promise<HostWelcomeMesh | undefined> => {
		if (!meshable(host)) return undefined;
		if ((await compute?.poolSync?.(host.poolId)) !== true) return undefined;
		const addressed = await withMeshAddress(host);
		if (addressed.mesh === undefined || addressed.mesh.poolId !== host.poolId) return undefined;
		return {
			address: addressed.mesh.address,
			prefix: await meshPrefix(host.poolId),
			peers: meshPeersAmong(addressed, hosts ?? (await store.listHosts())),
		};
	};

	/**
	 * The host's mesh peers now, for `mesh.peers`: undefined for a host that doesn't run the mesh or isn't in a pool
	 * (nothing is sent), none while its pool has sync off.
	 */
	const meshPeersNow = async (hostId: string): Promise<HostMeshPeer[] | undefined> => {
		const host = await store.getHost(hostId);
		if (host === undefined || !meshable(host)) return undefined;
		const peers =
			(await compute?.poolSync?.(host.poolId)) === true ? meshPeersAmong(host, await store.listHosts()) : [];
		const told = meshTold.get(hostId);
		if (told !== undefined) meshTold.set(hostId, { ...told, peers: JSON.stringify(peers) });
		return peers;
	};

	/**
	 * What each host that runs the mesh, connected here, was last told of its pool's mesh: its address and prefix (none,
	 * its mesh down) by its last welcome, and its peers by that or a later `mesh.peers`.
	 */
	const meshTold = new Map<
		string,
		{ readonly mesh?: { readonly address: string; readonly prefix: string }; readonly peers?: string }
	>();
	/** When each host's mesh was last checked (`reconcileMesh`). */
	const meshCheckedAt = new Map<string, number>();
	/**
	 * Every host, as read for the checks of one `MESH_REFRESH_MS`: one read of the registry a pass for all the hosts
	 * connected here, not one each. A check that finds a difference has the hub read afresh what it sends, so a stale
	 * read sends nothing stale, and a difference it misses is found on the next pass.
	 */
	let meshHosts: { readonly at: number; readonly read: Promise<HostRecord[]> } | undefined;
	const meshHostsNow = (): Promise<HostRecord[]> => {
		const at = clock.now();
		if (meshHosts === undefined || at - meshHosts.at >= MESH_REFRESH_MS) {
			const read = store.listHosts();
			meshHosts = { at, read };
			read.catch(() => {
				if (meshHosts?.read === read) meshHosts = undefined;
			});
		}
		return meshHosts.read;
	};

	/**
	 * Tells a host connected here what it should have of its pool's mesh now, where that differs from what it was last
	 * told, every `MESH_REFRESH_MS` on its heartbeat: its welcome again when its mesh should come up, go down or move,
	 * else its peers when they differ. So a telling missed is made good: the tellings on a change are only the fast way.
	 * A read that fails is tried on a later heartbeat.
	 */
	const reconcileMesh = (hostId: string) => {
		const told = meshTold.get(hostId);
		if (told === undefined || compute?.poolSync === undefined) return;
		const at = clock.now();
		if (at - (meshCheckedAt.get(hostId) ?? Number.NEGATIVE_INFINITY) < MESH_REFRESH_MS) return;
		meshCheckedAt.set(hostId, at);
		report(
			(async () => {
				const hosts = await meshHostsNow();
				const host = hosts.find((each) => each.id === hostId);
				if (host === undefined || host.revoked) return;
				const wanted = await meshFor(host, hosts);
				if (wanted?.address !== told.mesh?.address || wanted?.prefix !== told.mesh?.prefix) {
					rewelcome(host);
				} else if (wanted !== undefined && JSON.stringify(wanted.peers) !== told.peers) {
					hub.remesh(hostId);
				}
			})(),
		);
	};

	/**
	 * The grant keys each host connected here was last told by a welcome, as their IDs in order ("" none), and when a key
	 * it was told of begins signing, if one does: its welcome is due again then, with that key first.
	 */
	const grantKeysTold = new Map<string, { readonly ids: string; readonly due?: number }>();
	/** When each host's grant keys were last checked (`reconcileGrantKeys`). */
	const grantKeysCheckedAt = new Map<string, number>();
	const grantKeyIds = (keys: readonly HostGrantKey[] | undefined) => (keys ?? []).map((key) => key.id).join(" ");
	/** The grant keys as read for the checks of one `GRANT_KEYS_REFRESH_MS`: one read a pass for every host here. */
	let grantKeysRead: { readonly at: number; readonly read: Promise<string> } | undefined;
	const grantKeysNow = (read: () => Promise<readonly HostGrantKey[] | undefined>): Promise<string> => {
		const at = clock.now();
		if (grantKeysRead === undefined || at - grantKeysRead.at >= GRANT_KEYS_REFRESH_MS) {
			const reading = read().then(grantKeyIds);
			grantKeysRead = { at, read: reading };
			reading.catch(() => {
				if (grantKeysRead?.read === reading) grantKeysRead = undefined;
			});
		}
		return grantKeysRead.read;
	};

	/**
	 * Sends a host connected here its welcome again when the grant keys it was last told aren't the control plane's now,
	 * every `GRANT_KEYS_REFRESH_MS` on its heartbeat, and on the first heartbeat after a key it was told of begins signing:
	 * a rotation's telling that missed it, a published key now signing, a rotated-out key whose time is up, or a welcome
	 * that went without them when they couldn't be read. A read that fails is tried on a later pass.
	 */
	const reconcileGrantKeys = (hostId: string) => {
		const told = grantKeysTold.get(hostId);
		const read = compute?.grantKeys;
		if (told === undefined || read === undefined) return;
		const at = clock.now();
		// A key it was told of begins signing: checked on this heartbeat, with a read of its own, so a host that holds one
		// key only (from before rotation) has the new one within seconds.
		const due = told.due !== undefined && told.due <= at;
		if (!due && at - (grantKeysCheckedAt.get(hostId) ?? Number.NEGATIVE_INFINITY) < GRANT_KEYS_REFRESH_MS) return;
		grantKeysCheckedAt.set(hostId, at);
		report(
			(async () => {
				if (!due && (await grantKeysNow(read)) === told.ids) return;
				// Read again before telling: the pass's read may be from before a change this host was told already.
				const latest = grantKeyIds(await read());
				const known = grantKeysTold.get(hostId);
				if (latest === known?.ids) {
					// Nothing new yet (the control plane's clock behind this one's): the regular check follows it from here.
					if (known?.due !== undefined) grantKeysTold.set(hostId, { ids: known.ids });
					return;
				}
				const host = await store.getHost(hostId);
				if (host !== undefined && !host.revoked) rewelcome(host);
			})(),
		);
	};

	/** Runs a telling of hosts on a change, logging rather than failing it: `reconcileMesh` makes good one that fails. */
	const tellMesh = async (work: Promise<void>) => {
		await work.catch((error: unknown) => {
			log(
				`[hosts] couldn't tell hosts of a mesh change (made good later): ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	};

	/**
	 * Sends every host of a pool that runs the mesh its peers again, but `except`: one of them joined, left, was revoked
	 * or has a new key, address or endpoints. Nothing while the pool has sync off: its hosts' meshes are down. Each is
	 * asked of the hub whether or not it looks connected here: the hub finds the replica holding it as it is now, and one
	 * still saying hello has its welcome read again once sent.
	 */
	const remeshPool = async (poolId: string | undefined, except?: string) => {
		if (poolId === undefined || (await compute?.poolSync?.(poolId)) !== true) return;
		for (const member of await store.listHosts()) {
			if (member.id === except || member.poolId !== poolId || !runsMesh(member)) continue;
			hub.remesh(member.id);
		}
	};

	/**
	 * Sends a host its welcome again. The hub reads it afresh (`welcomeNow`), here or on the replica holding the host, so
	 * the welcome handed over is never what is sent: the record's own fields will do, with no mesh to read.
	 */
	const rewelcome = (host: HostRecord) => hub.rewelcome(host.id, baseWelcome(host));

	/** What `read` answers, or undefined (logged) when it fails: the welcome goes without it. */
	const welcomePart = <T>(host: HostRecord, what: string, read: (() => Promise<T | undefined>) | undefined) =>
		read === undefined
			? undefined
			: read().catch((error: unknown) => {
					log(
						`[hosts] no ${what} in host ${host.id}'s welcome: ${error instanceof Error ? error.message : String(error)}`,
					);
					return undefined;
				});
	// With image patching, the grant key and the mesh all off the welcome is made at once, as before: no await between a
	// hello and its answer.
	const welcomeFor = (host: HostRecord): HostWelcome | Promise<HostWelcome> => {
		const base = baseWelcome(host);
		const images = welcomePart(host, "images", compute?.images);
		const grantKeys = welcomePart(host, "grant keys", compute?.grantKeys);
		// The mesh isn't left out when it can't be read, as the others are: a welcome without it takes the host's mesh down
		// (`meshFor`).
		const mesh = meshable(host) ? meshFor(host) : undefined;
		if (images === undefined && grantKeys === undefined && mesh === undefined) return base;
		return Promise.all([images, grantKeys, mesh]).then(([images, grantKeys, mesh]) => ({
			...base,
			...(images === undefined ? {} : { images }),
			// The key that signs as `grantKey` too, for hosts from before rotation.
			...(grantKeys?.[0] === undefined ? {} : { grantKey: grantKeys[0].publicKey, grantKeys }),
			...(mesh === undefined ? {} : { mesh }),
		}));
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
	/** A host sandbox's guest health (`HostSandbox.health`), when it says one. */
	const healthOf = (sandbox: { health?: unknown }): string | undefined =>
		typeof sandbox.health === "string" && sandbox.health !== "" ? sandbox.health.slice(0, 40) : undefined;
	/** Why, in words, at most 1,000 characters. */
	const healthReasonOf = (sandbox: { healthReason?: unknown }): string | undefined =>
		typeof sandbox.healthReason === "string" && sandbox.healthReason !== ""
			? sandbox.healthReason.slice(0, 1000)
			: undefined;
	/**
	 * Why a host's report says the sandbox's machine there ended without Kantel asking, in the host's words (at most
	 * 1,000 characters): it is `stopped` or `error` with an `error`. A stop Kantel asked for clears the error, so it has
	 * none; every exit the host didn't cause by a call (its memory guard, an OOM kill, a crash, its restart) has one.
	 */
	const exitOf = (sandbox: { state: string; error?: unknown }): string | undefined =>
		(sandbox.state === "stopped" || sandbox.state === "error") &&
		typeof sandbox.error === "string" &&
		sandbox.error.trim() !== ""
			? sandbox.error.slice(0, 1000)
			: undefined;
	/** Each host's events here whose exit report is still being taken (`onEvent`), which its next hello waits for. */
	const exitsReporting = new Map<string, Set<Promise<void>>>();
	/** When it last changed, when the host says. */
	const healthAtOf = (sandbox: { healthAt?: unknown }): number | undefined =>
		typeof sandbox.healthAt === "number" && Number.isSafeInteger(sandbox.healthAt) && sandbox.healthAt > 0
			? sandbox.healthAt
			: undefined;
	/** Hosts whose snapshot bases haven't been read on their connection yet (image patching hosts only). */
	const snapshotBasesDue = new Set<string>();
	/**
	 * When each connected host that measures its snapshots (`HOST_FEATURES.snapshotSizes`) last had its snapshot list
	 * read for their sizes: absent until its first heartbeat, when it is read.
	 */
	const snapshotSizesReadAt = new Map<string, number>();
	/** Hosts that measure their snapshots, from their hello. */
	const measuresSnapshots = new Set<string>();
	/**
	 * Reads a host's snapshots, once a connection and then every `SNAPSHOT_SIZES_REFRESH_MS`, and passes on what they
	 * report: their bases, once a connection (snapshots saved before the host versioned its images have none recorded,
	 * and the host pins them when image patching starts), and their sizes on the disk now, from a host that measures them.
	 */
	const readSnapshots = (hostId: string) => {
		const link = compute;
		const bases = snapshotBasesDue.delete(hostId) && link?.recordBases !== undefined;
		const at = clock.now();
		const sizes =
			link?.recordSnapshotSizes !== undefined &&
			measuresSnapshots.has(hostId) &&
			at - (snapshotSizesReadAt.get(hostId) ?? Number.NEGATIVE_INFINITY) >= SNAPSHOT_SIZES_REFRESH_MS;
		if (!bases && !sizes) return;
		if (sizes) snapshotSizesReadAt.set(hostId, at);
		report(
			(async () => {
				const listed = await hub.call<{
					snapshots?: readonly { id?: unknown; base?: unknown; sizeBytes?: unknown; uniqueBytes?: unknown }[] | null;
					shared?: readonly { snapshots?: unknown; bytes?: unknown }[] | null;
				}>(hostId, HostMethods.snapshotList, { sandboxId: "" });
				const bytes = (value: unknown): value is number =>
					typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
				const baseReports: { ref: string; base: string }[] = [];
				const sizeReports: { ref: string; sizeBytes: number; uniqueBytes?: number }[] = [];
				for (const snap of listed.snapshots ?? []) {
					if (typeof snap.id !== "string") continue;
					const ref = `${hostId}/${snap.id}`;
					if (typeof snap.base === "string" && snap.base !== "") baseReports.push({ ref, base: snap.base });
					if (bytes(snap.sizeBytes)) {
						sizeReports.push({
							ref,
							sizeBytes: snap.sizeBytes,
							...(bytes(snap.uniqueBytes) ? { uniqueBytes: snap.uniqueBytes } : {}),
						});
					}
				}
				// The files several snapshots share, by their holders: at most one group per set of holders, so as many as
				// the snapshots at most in practice; a list longer than that is a host's mistake, and is left out.
				const shared: { refs: string[]; bytes: number }[] = [];
				const groups = Array.isArray(listed.shared) ? listed.shared : [];
				if (groups.length <= MAX_SHARED_GROUPS) {
					for (const group of groups) {
						const ids = group.snapshots;
						if (!bytes(group.bytes) || !Array.isArray(ids) || ids.length < 2) continue;
						if (!ids.every((id): id is string => typeof id === "string")) continue;
						shared.push({ refs: ids.map((id) => `${hostId}/${id}`), bytes: group.bytes });
					}
				}
				if (bases && baseReports.length > 0) await link?.recordBases?.(hostId, { snapshots: baseReports });
				if (sizes && sizeReports.length > 0) await link?.recordSnapshotSizes?.(hostId, sizeReports, shared);
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

	/**
	 * Keeps a report's sticky disk holdings in the catalogue, received at `at`, in its own time and one at a time per
	 * host. The catalogue takes only a host's newest report, on any gateway (`DiskHolderWrites`), so one held up here
	 * never undoes a newer. Nothing from a report that doesn't say what it holds: absent isn't none.
	 */
	const holdingsRecorded = new Map<string, Promise<void>>();
	const recordHoldings = (hostId: string, at: number, capacity: HostCapacity) => {
		const link = compute;
		const holdings = capacity.stickyDisks;
		if (link?.recordStickyHoldings === undefined || holdings === undefined) return;
		const previous = holdingsRecorded.get(hostId) ?? Promise.resolve();
		const next = previous.then(() => link.recordStickyHoldings?.(hostId, at, holdings));
		const settled = next.catch(() => undefined);
		holdingsRecorded.set(hostId, settled);
		void settled.then(() => {
			if (holdingsRecorded.get(hostId) === settled) holdingsRecorded.delete(hostId);
		});
		report(next);
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
		const before = host;
		const reported = await store.updateHost(hostId, (latest) => ({
			...latest,
			facts: facts.value,
			capacity: capacity.value,
			capacityAt: now,
			lastSeenAt: now,
		}));
		if (reported === undefined || reported.revoked) throw new Error("This host is revoked");
		// Its place in its pool's mesh: its address given before its peers are told of it, and they are told when it is
		// new to them, or its key, address or endpoints changed (a reinstall makes a new key; a move of network, new
		// endpoints).
		const addressed = await withMeshAddress(reported).catch((error: unknown) => {
			log(`[hosts] no mesh address for host ${hostId}: ${error instanceof Error ? error.message : String(error)}`);
			return reported;
		});
		if (meshPeerChanged(before, addressed)) report(tellMesh(remeshPool(addressed.poolId, hostId)));
		meshCheckedAt.set(hostId, now);
		recordHoldings(hostId, now, capacity.value);
		reserved.delete(hostId);
		// Reconcile: what the host holds is the truth about state; a placement the host no longer has is lost.
		// Go marshals an empty list as null (kantel-host 0.1.0-dev on a host with no sandboxes).
		const sandboxes = message.sandboxes ?? [];
		const held = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
		const bases: { sandboxId: string; base: string; baseAt?: number }[] = [];
		// Its running sandboxes' guest health, where it watches it: one that went unresponsive, or answered again, while
		// it was away is caught up.
		const watchesHealth = facts.value.features?.includes(HOST_FEATURES.guestHealth) === true;
		const exits: { sandboxId: string; error: string; healthAt?: number }[] = [];
		// What is left here of sandboxes deleted since their upgrade, isolates still to delete (`forgetPlacement`): owed
		// this host, not reconciled as its sandboxes are, on any gateway, after any restart.
		const leftovers = new Set<string>();
		for (const placement of await store.placementsOn(hostId)) {
			if (isLeftover(placement)) {
				leftovers.add(placement.sandboxId);
				held.delete(placement.sandboxId);
				continue;
			}
			const sandbox = held.get(placement.sandboxId);
			const latest = asReported(placement, sandbox ?? { state: "lost" }, reported, now);
			if (latest !== placement) {
				await applyReport(
					placement.sandboxId,
					hostId,
					sandbox?.tier ?? placement.tier,
					sandbox ?? { state: "lost" },
					reported,
				);
			}
			// One whose machine ended while the host was away, or that the host's restart ended (`the host restarted while
			// it ran`), is caught up: the compute plane may still have it running.
			const exit = sandbox === undefined ? undefined : exitOf(sandbox);
			if (exit !== undefined && sandbox !== undefined) {
				exits.push({ sandboxId: placement.sandboxId, error: exit, healthAt: healthAtOf(sandbox) });
			}
			if (watchesHealth && sandbox?.state === "running" && compute?.reportHealth !== undefined) {
				report(
					compute.reportHealth(
						hostId,
						placement.sandboxId,
						healthOf(sandbox),
						healthReasonOf(sandbox),
						healthAtOf(sandbox),
					),
				);
			}
			// What its disk is on, where the host says (one without image patching doesn't, and nothing is erased).
			if (typeof sandbox?.base === "string" && sandbox.base !== "") {
				bases.push({ sandboxId: placement.sandboxId, base: sandbox.base, ...baseAtOf(sandbox) });
			}
			held.delete(placement.sandboxId);
		}
		if (bases.length > 0 && compute?.recordBases !== undefined) {
			report(compute.recordBases(hostId, { sandboxes: bases }));
		}
		// Taken before the host is welcomed, so no call reaches it until they are, after the exits its events here are still
		// reporting (from its last connection): one landing after a start of its sandbox would put the run that start
		// booted in error. Each is also fenced to the machine it names (`healthAt`), which a host that predates sending it
		// doesn't. One that fails is logged, and the host connects.
		await Promise.allSettled([...(exitsReporting.get(hostId) ?? [])]);
		for (const exit of exits) {
			await compute?.reportExit?.(hostId, exit.sandboxId, exit.error, exit.healthAt).catch((error: unknown) => {
				const why = error instanceof Error ? error.message : String(error);
				log(`[hosts] couldn't report sandbox ${exit.sandboxId}'s exit on host ${hostId}: ${why}`);
			});
		}
		// Its snapshots' bases, once it is welcomed (the hello doesn't carry them): on its first heartbeat.
		if (facts.value.features?.includes(HOST_FEATURES.imagePatching) === true) snapshotBasesDue.add(hostId);
		else snapshotBasesDue.delete(hostId);
		// Its snapshots' sizes, read on its first heartbeat and then every so often, where it measures them.
		snapshotSizesReadAt.delete(hostId);
		if (facts.value.features?.includes(HOST_FEATURES.snapshotSizes) === true) measuresSnapshots.add(hostId);
		else measuresSnapshots.delete(hostId);
		// Isolates upgrades left here, their microVMs placed elsewhere: deleted once it is welcomed. Those already owed it
		// stay owed (one deleted whose removal wasn't recorded, which it no longer names): each is checked when it is done.
		const owed = new Set<string>([...(cleanupsDue.get(hostId) ?? []), ...leftovers]);
		for (const sandboxId of held.keys()) {
			if ((await store.getPlacement(sandboxId))?.cleanup?.hostId === hostId) owed.add(sandboxId);
		}
		for (const sandboxId of owed) held.delete(sandboxId);
		if (owed.size > 0) cleanupsDue.set(hostId, owed);
		else cleanupsDue.delete(hostId);
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
		// What it is told of the mesh, for `reconcileMesh`: only a host that runs it. A welcome made at once is answered at
		// once, with no await more than before.
		const noted = (welcome: HostWelcome): HostWelcome => {
			const due = welcome.grantKeys?.find((key) => key.from !== undefined)?.from;
			grantKeysTold.set(hostId, { ids: grantKeyIds(welcome.grantKeys), ...(due === undefined ? {} : { due }) });
			const mesh = welcome.mesh;
			if (!runsMesh(latest)) meshTold.delete(hostId);
			else if (mesh === undefined) meshTold.set(hostId, {});
			else {
				meshTold.set(hostId, {
					mesh: { address: mesh.address, prefix: mesh.prefix },
					peers: JSON.stringify(mesh.peers),
				});
			}
			return welcome;
		};
		const welcome = welcomeFor(latest);
		return welcome instanceof Promise ? welcome.then(noted) : noted(welcome);
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
		meshPeersNow(hostId) {
			return meshPeersNow(hostId);
		},
		onHeartbeat(hostId, reported) {
			const receivedAt = clock.now();
			const parsed = parseHostCapacity(reported);
			if (!parsed.ok) {
				log(`[hosts] host ${hostId} sent a heartbeat that isn't valid (${parsed.reason}); ignored`);
				return;
			}
			endLegacyPools(hostId, reported);
			const capacity = parsed.value;
			reserved.delete(hostId);
			refreshImages(hostId);
			reconcileMesh(hostId);
			reconcileGrantKeys(hostId);
			readSnapshots(hostId);
			runCleanups(hostId);
			report(
				(async () => {
					await store.updateHost(hostId, (host) => ({
						...host,
						capacity,
						capacityAt: receivedAt,
						lastSeenAt: clock.now(),
					}));
				})(),
			);
			recordHoldings(hostId, receivedAt, capacity);
		},
		onEvent(hostId, event) {
			const sandbox = event.sandbox;
			if (typeof sandbox !== "object" || sandbox === null) return;
			if (typeof sandbox.id !== "string" || typeof sandbox.state !== "string") return;
			const work = (async () => {
				const placement = await store.getPlacement(sandbox.id);
				if (placement === undefined || placement.hostId !== hostId) return;
				const base = (sandbox as { base?: unknown }).base;
				if (typeof base === "string" && base !== "" && sandbox.state !== "deleted") {
					await compute?.recordBases?.(hostId, {
						sandboxes: [{ sandboxId: sandbox.id, base, ...baseAtOf(sandbox as { baseAt?: unknown }) }],
					});
				}
				// The call that caused the event usually recorded it already (a create's `running`). Applied to the placement
				// as it is now, still this host's and of the sandbox's tier: an upgrade's handover since stands.
				const tier = (sandbox as { tier?: unknown }).tier ?? placement.tier;
				if (sandbox.state === "deleted") {
					// What was left here of a sandbox deleted since its upgrade: its isolate is gone, as this host says.
					if (await store.removePlacementIf(sandbox.id, (latest) => isLeftover(latest) && latest.hostId === hostId)) {
						return;
					}
					await forgetPlacement(sandbox.id, (latest) => latest.hostId === hostId && latest.tier === tier);
					return;
				}
				await applyReport(sandbox.id, hostId, tier, sandbox, await store.getHost(hostId));
				// A running sandbox's guest health, which a host with `guestHealth` sends an event for each time it changes.
				if (sandbox.state === "running") {
					await compute?.reportHealth?.(
						hostId,
						sandbox.id,
						healthOf(sandbox),
						healthReasonOf(sandbox),
						healthAtOf(sandbox),
					);
				}
				// Its machine ended without Kantel asking (its memory guard, an OOM kill, a crash): the compute plane has it
				// running until told.
				const exit = exitOf(sandbox);
				if (exit !== undefined) await compute?.reportExit?.(hostId, sandbox.id, exit, healthAtOf(sandbox));
			})();
			// An exit's, until it is taken: the host's next hello here waits for it (`hello`).
			if (exitOf(sandbox) !== undefined) {
				const reporting = exitsReporting.get(hostId) ?? new Set<Promise<void>>();
				exitsReporting.set(hostId, reporting);
				reporting.add(work);
				void work
					.finally(() => {
						reporting.delete(work);
						if (reporting.size === 0 && exitsReporting.get(hostId) === reporting) exitsReporting.delete(hostId);
					})
					.catch(() => undefined);
			}
			report(work);
		},
		async secrets(hostId, sandboxId) {
			if (compute === undefined) throw new Error("The compute plane isn't linked yet");
			return compute.secrets(hostId, sandboxId);
		},
		async env(hostId, sandboxId) {
			if (compute?.env === undefined) throw new Error("The compute plane isn't linked yet");
			return compute.env(hostId, sandboxId);
		},
		onEgress(hostId, records) {
			if (compute !== undefined) report(compute.recordEgress(hostId, records));
		},
		async bucketSource(hostId, sandboxId, bucketSourceId) {
			if (compute?.bucketSource === undefined) throw new Error("The compute plane keeps no bucket sources here");
			return compute.bucketSource(hostId, sandboxId, bucketSourceId);
		},
		async diskLocate(hostId, params) {
			if (compute?.locateDisk === undefined) {
				throw new KantelError("not_supported", "The compute plane keeps no disk catalogue here");
			}
			return compute.locateDisk(hostId, params);
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
			snapshotSizesReadAt.delete(hostId);
			measuresSnapshots.delete(hostId);
			poolsEnded.delete(hostId);
			meshTold.delete(hostId);
			meshCheckedAt.delete(hostId);
			grantKeysTold.delete(hostId);
			grantKeysCheckedAt.delete(hostId);
			cluster?.release(hostId);
			report(
				(async () => {
					await store.updateHost(hostId, (host) => ({ ...host, lastSeenAt: clock.now() }));
				})(),
			);
			if (compute?.hostConnection !== undefined) report(compute.hostConnection(hostId, false));
		},
		onWelcomed(hostId) {
			if (compute?.hostConnection !== undefined) report(compute.hostConnection(hostId, true));
		},
		...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
	});
	const hub = cluster === undefined ? local : cluster.route(local);
	// A host another replica gained or lost: this one's answer for it changed only now, perhaps after a console here read
	// its sandboxes on the word of the replica that held it, so it's said again from here.
	cluster?.onRemoteChange((hostId) => compute?.hostConnection?.(hostId, hub.connected(hostId)));

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
			...(facts?.disk === undefined ? {} : { disk: { ...facts.disk } }),
			kvm: facts?.kvm ?? false,
			nestedVirtualisation: facts?.nested ?? false,
			features: [...(facts?.features ?? [])],
			...(facts?.isolate === undefined ? {} : { isolate: { ...facts.isolate } }),
			...(facts?.cpu === undefined ? {} : { cpuFingerprint: cpuFingerprintText(facts.cpu) }),
			...(facts?.runtimes === undefined ? {} : { runtimeFingerprints: facts.runtimes.map((each) => each.runtime) }),
			// Disk is free space, which changes as the host runs: the latest heartbeat's, else the hello's.
			capacity: {
				vcpus: facts?.cpus ?? 0,
				memoryMb: facts?.memoryMiB ?? 0,
				diskGb: reported?.freeDiskGiB ?? facts?.diskGiB ?? 0,
			},
			...(reported === undefined ? {} : { freeDiskGb: reported.freeDiskGiB }),
			...(reported?.disk === undefined ? {} : { diskUsage: { ...reported.disk } }),
			...(reported?.memory === undefined ? {} : { memory: withoutAdmission(reported.memory) }),
			...(reported?.mesh === undefined || state === "unreachable" || state === "revoked"
				? {}
				: { mesh: { address: reported.mesh.address, peers: reported.mesh.peers.map((peer) => ({ ...peer })) } }),
			allocated: {
				sandboxes: placements.filter((placement) => placement.state !== "lost").length,
				vcpus: live.reduce((sum, placement) => sum + placement.vcpus, 0),
				memoryMb: live.reduce((sum, placement) => sum + placement.memoryMiB, 0),
				diskGb: placements.reduce((sum, placement) => sum + placement.diskGiB, 0),
			},
			labels: { ...facts?.labels, ...host.labels },
			...(host.accountId === undefined ? {} : { accountId: host.accountId }),
			...(host.poolId === undefined ? {} : { poolId: host.poolId }),
			...(runsMesh(host) && host.mesh !== undefined && host.mesh.poolId === host.poolId
				? { meshAddress: host.mesh.address }
				: {}),
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

	/**
	 * A host's report of a sandbox (an event, its hello, a call's answer), applied to its placement as it is now, never to
	 * the one read before: only while that placement is still on `hostId`, and of the tier reported (`tier`, or the one
	 * read for a report that doesn't say), so a report read before an upgrade's handover can't write back the isolate,
	 * its host or its upgrade. Only its state and size change. Answers what was written, or undefined.
	 */
	const applyReport = (
		sandboxId: string,
		hostId: string,
		tier: unknown,
		reported: { readonly state: string; readonly size?: unknown },
		host: HostRecord | undefined,
	): Promise<PlacementRecord | undefined> =>
		store.updatePlacement(sandboxId, (latest) => {
			if (latest.hostId !== hostId || latest.tier !== tier) return undefined;
			const next = asReported(latest, reported, host, clock.now());
			return next === latest ? undefined : next;
		});

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
	 * Admits a new placement (a create, a snapshot's restore, a never-placed start, a fork) on its host: the one rule
	 * every one is put under (`admits`), in one write (`placeOnTakingHost`). Answers the pool its host was in as it took
	 * it, which the sandbox is in. `unavailable`, `host_unavailable`, writing nothing, while the host drains, once it is
	 * revoked, or once it is in another pool than `poolId`.
	 */
	const admit = async (
		placement: PlacementRecord,
		poolId: string | undefined,
		hostName: string,
	): Promise<{ readonly poolId?: string }> => {
		const admitted = await store.placeOnTakingHost(placement, poolId);
		if (admitted === undefined) {
			throw placementError(
				"unavailable",
				"host_unavailable",
				`The host ${hostName} is draining, or was moved to another pool`,
			);
		}
		return admitted;
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

	const tooMuchToMove = (what: string) =>
		new KantelError(
			"not_supported",
			`The isolate has ${what} to move to a microVM on another host (at most ${moveLimits.files} files and ${Math.round(moveLimits.bytes / (1024 * 1024))} MiB); upgrade it on a host that runs both isolates and microVMs`,
		);

	/**
	 * An isolate's `/workspace` as an upgrade to another host moves it, listed while it is held still (each directory in
	 * one call): refused here, before a microVM is made or a file read, when its listing is past `UPGRADE_MOVE_LIMITS`.
	 */
	const listWorkspace = async (sandboxId: string, fromHost: string): Promise<WorkspaceEntry[]> => {
		const entries: WorkspaceEntry[] = [];
		let listedBytes = 0;
		const queue = ["/workspace"];
		for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
			const { entries: listed } = await onHost<{ entries: ListedFile[] | null }>(fromHost, HostMethods.fileList, {
				sandboxId,
				path: dir,
			});
			for (const entry of listed ?? []) {
				if (!entry.path.startsWith("/workspace/")) continue;
				const name = entry.path.slice("/workspace/".length);
				if (name === "" || name.split("/").includes("..")) continue;
				if (entries.length >= moveLimits.files) throw tooMuchToMove("too many files");
				if (entry.type === "dir" || entry.type === "directory") {
					entries.push({ kind: "directory", name });
					queue.push(entry.path);
				} else if (entry.type === "symlink") {
					entries.push({ kind: "symlink", name, target: entry.target ?? "" });
				} else {
					listedBytes += entry.size;
					if (listedBytes > moveLimits.bytes) throw tooMuchToMove("too many bytes");
					entries.push({ kind: "file", name, path: entry.path, size: entry.size, mode: entry.mode ?? 0 });
				}
			}
		}
		// Each link's target as the microVM takes it (`exportLink`), read against everything listed.
		const listed = new Map<string, ListedKind>();
		for (const entry of entries) {
			listed.set(
				entry.name,
				entry.kind === "symlink" ? { kind: "symlink", target: entry.target } : { kind: entry.kind },
			);
		}
		return entries.map((entry) =>
			entry.kind === "symlink" ? { ...entry, target: exportLink(listed, entry.name, entry.target) } : entry,
		);
	};

	/**
	 * Moves an isolate's `/workspace` (`listWorkspace`) from its host to a new microVM of the same ID on another (an
	 * upgrade its own host can't make), while the isolate is held still (`sandbox.upgrade.freeze`), so what is read is
	 * one version: each file read a part at a time, `UPGRADE_READS` at once, all of it as one tar held here (at most
	 * `UPGRADE_MOVE_LIMITS`, counted again as read), written into the microVM, in parts where it is big, and extracted at
	 * `UPGRADE_WORKSPACE` by the microVM's host with its own code, as an archive upload is.
	 */
	const moveFiles = async (
		sandboxId: string,
		listing: readonly WorkspaceEntry[],
		fromHost: string,
		toHost: string,
	): Promise<{ readonly files: number; readonly bytes: number }> => {
		const entries: TarEntry[] = new Array(listing.length);
		let bytes = 0;
		const readFile = async (entry: Extract<WorkspaceEntry, { kind: "file" }>): Promise<Uint8Array> => {
			const parts: Uint8Array[] = [];
			let size = entry.size;
			for (let offset = 0; offset === 0 || offset < size; ) {
				const read = await onHost<{ data: string; fileSize?: number }>(fromHost, HostMethods.fileRead, {
					sandboxId,
					path: entry.path,
					offset,
					length: UPGRADE_READ_BYTES,
				});
				const part = bytesOf(read.data);
				// Counted as read, not as listed: what is copied is what the limit holds to.
				bytes += part.length;
				if (bytes > moveLimits.bytes) throw tooMuchToMove("too many bytes");
				parts.push(part);
				size = read.fileSize ?? part.length;
				offset += part.length;
				if (part.length === 0) break;
			}
			const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
			let at = 0;
			for (const part of parts) {
				whole.set(part, at);
				at += part.length;
			}
			return whole;
		};
		// Each read is a round trip to the isolate's host: a few at once, in the listing's order, the first failure
		// ending them all.
		let next = 0;
		let failed = false;
		const reader = async () => {
			while (!failed && next < listing.length) {
				const index = next++;
				const entry = listing[index];
				if (entry === undefined) continue;
				try {
					entries[index] =
						entry.kind === "file"
							? { kind: "file", name: entry.name, mode: entry.mode & 0o777 || 0o644, bytes: await readFile(entry) }
							: entry;
				} catch (error) {
					failed = true;
					throw error;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(UPGRADE_READS, Math.max(listing.length, 1)) }, reader));
		const tar = writeTar(entries);
		if (tar.length <= UPGRADE_WRITE_BYTES) {
			await onHost(toHost, HostMethods.fileWrite, {
				sandboxId,
				path: UPGRADE_STAGING,
				data: base64Of(tar),
				mode: 0o600,
			});
		} else {
			const names: string[] = [];
			for (let at = 0; at < tar.length; at += UPGRADE_WRITE_BYTES) {
				const name = `${UPGRADE_STAGING}.${String(names.length).padStart(6, "0")}`;
				await onHost(toHost, HostMethods.fileWrite, {
					sandboxId,
					path: name,
					data: base64Of(tar.subarray(at, at + UPGRADE_WRITE_BYTES)),
					mode: 0o600,
				});
				names.push(name);
			}
			const joined = await onHost<HostExecResult>(toHost, HostMethods.exec, {
				sandboxId,
				argv: ["sh", "-c", `cat ${names.join(" ")} > ${UPGRADE_STAGING} && rm -f ${names.join(" ")}`],
				user: "root",
				timeoutMs: 120_000,
			});
			if (joined.exitCode !== 0) {
				throw new KantelError(
					"unavailable",
					`The isolate's files couldn't be put together in the microVM: ${joined.stderr.trim()}`,
				);
			}
		}
		await onHost(
			toHost,
			HostMethods.fileExtract,
			{ sandboxId, archive: UPGRADE_STAGING, target: UPGRADE_WORKSPACE },
			{ timeoutMs: DISK_COPY_TIMEOUT_MS },
		);
		return { files: entries.length, bytes };
	};

	const reserve = (hostId: string, memoryMiB: number, diskGiB: number) => {
		reserved.set(hostId, [...(reserved.get(hostId) ?? []), { at: clock.now(), memoryMiB, diskGiB }]);
	};

	/** A microVM's placement as an upgrade makes it: its isolate's, on `host` at `size`. */
	const placementOn = (
		sandboxId: string,
		host: Pick<HostRecord, "id">,
		size: HostSize,
		source: PlacementRecord,
		owner: string | undefined,
	): PlacementRecord => ({
		sandboxId,
		hostId: host.id,
		tier: "microvm",
		size: size.name,
		...(owner === undefined ? (source.owner === undefined ? {} : { owner: source.owner }) : { owner }),
		vcpus: size.vcpus,
		memoryMiB: size.memoryMiB,
		diskGiB: size.diskGiB,
		state: "starting",
		createdAt: source.createdAt,
		updatedAt: clock.now(),
	});

	/** Commits an upgrade its own host did: the placement the microVM's, at `size`. */
	const commitOnHost = async (
		sandboxId: string,
		host: HostRecord,
		size: HostSize,
		sandbox: HostSandbox,
	): Promise<UpgradedSandbox> => {
		const source = await placementOf(sandboxId);
		return {
			sandbox,
			hostId: host.id,
			placement: await settle(placementOn(sandboxId, host, size, source, source.owner), sandbox, host),
			nestedVirtualisation: host.facts?.nested ?? false,
			path: "host",
			files: sandbox.moved?.files ?? 0,
			bytes: sandbox.moved?.bytes ?? 0,
			// Its own host's, which held the isolate all along, so stayed in its pool.
			...(host.poolId === undefined ? {} : { poolId: host.poolId }),
		};
	};

	/** Whether a placement is still the isolate upgrade `operationId` is under way on. */
	const upgradingBy = (placement: PlacementRecord | undefined, operationId: string): placement is PlacementRecord =>
		placement?.tier === "isolate" && placement.upgrade?.operationId === operationId;

	/**
	 * Clears upgrade `operationId` off its isolate's placement (`settling` by `token`, where given), as the placement is
	 * now: its host's reports since are kept, and a placement another gateway settled, or a later upgrade's, is left as
	 * it is. Whether it did.
	 */
	const clearUpgrade = async (sandboxId: string, operationId: string, token?: string): Promise<boolean> =>
		(await store.updatePlacement(sandboxId, (latest) => {
			if (!upgradingBy(latest, operationId)) return undefined;
			if (token !== undefined && latest.upgrade?.settling?.by !== token) return undefined;
			const { upgrade: _done, ...placed } = latest;
			return { ...placed, updatedAt: clock.now() };
		})) !== undefined;

	/**
	 * Rolls back an upgrade that copied files to another host: the microVM made there (or perhaps made: its create's
	 * answer may be lost) deleted, the isolate thawed, its placement as it was.
	 *
	 * Claimed first, in the store every gateway shares (`upgrade.settling`, for `settleLeaseMs`), so only one gateway
	 * sends the compensating calls at a time, and each is sent only while its claim and the upgrade still stand: a
	 * rollback that is late (its gateway slow, its claim lapsed and another's done since, a newer upgrade begun) never
	 * deletes the newer one's microVM or puts back a placement over it. `done` once rolled back; `unreachable` when a
	 * host couldn't be reached (the claim let go, the upgrade left on the placement to be settled later); `busy` while
	 * another gateway has it; `superseded` when it is no longer this rollback's (settled elsewhere).
	 */
	const rollBackCopy = async (
		sandboxId: string,
		sourceHostId: string,
		targetId: string,
		operationId: string,
	): Promise<"done" | "unreachable" | "busy" | "superseded"> => {
		const gone = (error: unknown) => isKantelError(error) && error.code === "not_found";
		const token = shortId("rbk");
		const claimed = await store.updatePlacement(sandboxId, (latest) => {
			if (!upgradingBy(latest, operationId) || latest.upgrade === undefined) return undefined;
			const held = latest.upgrade.settling;
			if (held !== undefined && held.until > clock.now()) return undefined;
			return {
				...latest,
				upgrade: { ...latest.upgrade, settling: { by: token, until: clock.now() + settleLeaseMs } },
			};
		});
		if (claimed === undefined) {
			return upgradingBy(await store.getPlacement(sandboxId), operationId) ? "busy" : "superseded";
		}
		const stillOurs = async () => {
			const read = await store.getPlacement(sandboxId);
			return upgradingBy(read, operationId) && read.upgrade?.settling?.by === token;
		};
		/** Lets the claim go, so the next attempt needn't wait for it to lapse. */
		const letGo = () =>
			store
				.updatePlacement(sandboxId, (latest) => {
					if (!upgradingBy(latest, operationId) || latest.upgrade?.settling?.by !== token) return undefined;
					const { settling: _gone, ...upgrade } = latest.upgrade;
					return { ...latest, upgrade };
				})
				.catch(() => undefined);
		for (const [hostId, method, params] of [
			[targetId, HostMethods.delete, { sandboxId }],
			[sourceHostId, HostMethods.upgradeThaw, { sandboxId, operationId }],
		] as const) {
			if (!(await stillOurs())) return "superseded";
			try {
				await onHost(hostId, method, params);
			} catch (error) {
				if (!gone(error)) {
					await letGo();
					return "unreachable";
				}
			}
		}
		return (await clearUpgrade(sandboxId, operationId, token)) ? "done" : "superseded";
	};

	/**
	 * An upgrade's outcome, settled: one committed (the placement a microVM's) is done; one its own host was doing is
	 * asked of that host, which answers it once ended or rolls back one it never finished; one copying files to another
	 * host is rolled back. Rejects while a host it needs can't be reached.
	 */
	const settleWith = async (
		sandboxId: string,
		operationId: string,
	): Promise<
		| { readonly state: "done"; readonly upgraded: UpgradedSandbox }
		| { readonly state: "failed"; readonly reason?: string }
	> => {
		const placement = await placementOf(sandboxId);
		if (placement.tier === "microvm") {
			const sandbox = await onHost<HostSandbox>(placement.hostId, HostMethods.get, { sandboxId });
			const host = await store.getHost(placement.hostId);
			return {
				state: "done",
				upgraded: {
					sandbox,
					hostId: placement.hostId,
					placement,
					nestedVirtualisation: host?.facts?.nested ?? false,
					path: placement.cleanup === undefined ? "host" : "control-plane",
					files: sandbox.moved?.files ?? 0,
					bytes: sandbox.moved?.bytes ?? 0,
					// The pool of the host it is placed on, which holds it, so can't have moved since it was admitted.
					...(host?.poolId === undefined ? {} : { poolId: host.poolId }),
				},
			};
		}
		const upgrade = placement.upgrade;
		if (upgrade?.operationId !== operationId) return { state: "failed", reason: "The upgrade never began" };
		if (upgrade.phase === "copy") {
			const rolled = await rollBackCopy(sandboxId, placement.hostId, upgrade.target, operationId);
			if (rolled === "unreachable") {
				throw new KantelError("unavailable", "A host the upgrade used can't be reached to roll it back yet");
			}
			// Another gateway's: asked again later, the placement then says what became of it.
			if (rolled !== "done") throw new KantelError("unavailable", "The upgrade is being settled by another gateway");
			return { state: "failed", reason: "The upgrade didn't finish, and was rolled back" };
		}
		const host = await store.getHost(upgrade.target);
		const outcome = await onHost<{ state: string; sandbox?: HostSandbox; error?: string }>(
			upgrade.target,
			HostMethods.upgradeSettle,
			{ sandboxId, operationId },
			// It waits for an upgrade under way there, however long that takes.
			{ timeoutMs: DISK_COPY_TIMEOUT_MS },
		);
		if (outcome.state === "done" && outcome.sandbox !== undefined && host !== undefined && upgrade.size !== undefined) {
			return { state: "done", upgraded: await commitOnHost(sandboxId, sane(host), upgrade.size, outcome.sandbox) };
		}
		// Its host undid it: the isolate's placement as it is now, only while this upgrade is still on it.
		await clearUpgrade(sandboxId, operationId);
		return { state: "failed", ...(outcome.error === undefined ? {} : { reason: outcome.error }) };
	};

	/**
	 * Removes the isolate an upgrade left on `hostId` once its microVM was placed elsewhere (`cleanup`), and clears what
	 * is owed: now, after the upgrade, and when that host is back (its hello names the isolate, its heartbeat sends the
	 * delete). Answers the placement as left, or undefined when the host couldn't do it now.
	 */
	const cleanUpSource = async (hostId: string, sandboxId: string): Promise<PlacementRecord | undefined> => {
		const placement = await store.getPlacement(sandboxId);
		if (placement?.cleanup?.hostId !== hostId) return placement;
		try {
			// Its snapshots kept: the sandbox lives on, and they stay its, an isolate's (a host from before
			// `keepSnapshots` deletes them as a delete does).
			await onHost(hostId, HostMethods.delete, { sandboxId, keepSnapshots: true });
		} catch (error) {
			if (!(isKantelError(error) && error.code === "not_found")) {
				const why = error instanceof Error ? error.message : String(error);
				log(
					`[hosts] the isolate ${sandboxId} left on ${hostId} by its upgrade wasn't deleted (${why}); again once it's back`,
				);
				cleanupsDue.set(hostId, new Set([...(cleanupsDue.get(hostId) ?? []), sandboxId]));
				return undefined;
			}
		}
		// The isolate is gone: what was left of a sandbox deleted since (`forgetPlacement`) goes with it, and a live
		// sandbox's placement no longer owes it. A delete that leaves the placement here meanwhile is caught by the second
		// removal.
		const leftoverHere = (latest: PlacementRecord) => isLeftover(latest) && latest.hostId === hostId;
		if (await store.removePlacementIf(sandboxId, leftoverHere)) return undefined;
		const cleaned = await store.updatePlacement(sandboxId, (latest) => {
			if (latest.cleanup?.hostId !== hostId || leftoverHere(latest)) return undefined;
			const { cleanup: _done, ...placed } = latest;
			return { ...placed, updatedAt: clock.now() };
		});
		if (cleaned === undefined && (await store.removePlacementIf(sandboxId, leftoverHere))) return undefined;
		return cleaned ?? (await store.getPlacement(sandboxId));
	};

	/**
	 * Removes a sandbox's placement (only while `should` says so), but not an isolate an upgrade left on another host
	 * still to be deleted (`cleanup`): that stays, as the isolate's own record on its host (its `hostId` the cleanup's),
	 * so the host is held (`holds`) and the isolate deleted when it is back, on any gateway, until `cleanUpSource` has
	 * done it. Whether it changed anything.
	 */
	const forgetPlacement = async (
		sandboxId: string,
		should: (placement: PlacementRecord) => boolean,
	): Promise<boolean> => {
		const left = await store.updatePlacement(sandboxId, (latest) => {
			const owed = latest.cleanup;
			if (!should(latest) || owed === undefined || owed.hostId === latest.hostId) return undefined;
			const { upgrade: _upgrade, ...rest } = latest;
			return { ...rest, hostId: owed.hostId, tier: "isolate", state: "deleting", updatedAt: clock.now() };
		});
		if (left !== undefined) {
			const owedHost = left.hostId;
			cleanupsDue.set(owedHost, new Set([...(cleanupsDue.get(owedHost) ?? []), sandboxId]));
			if (hub.connected(owedHost)) runCleanups(owedHost);
			return true;
		}
		// Never what is left: only `cleanUpSource`, once the isolate is gone, removes that.
		return store.removePlacementIf(sandboxId, (latest) => !isLeftover(latest) && should(latest));
	};

	/** The isolates upgrades left on each host, deleted on its next heartbeat (once it is welcomed). */
	const cleanupsDue = new Map<string, Set<string>>();
	const runCleanups = (hostId: string) => {
		const due = cleanupsDue.get(hostId);
		if (due === undefined) return;
		cleanupsDue.delete(hostId);
		for (const sandboxId of due) report(cleanUpSource(hostId, sandboxId).then(() => undefined));
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
			!buildFitsOn(capacity, held.memory, shape.memoryMiB) ||
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
		async stickyDelete(hostId, diskId, version) {
			// Routed as any call to a host: on this replica's connection or another's.
			await onHost(hostId, HostMethods.stickyDelete, { diskId, ...(version === undefined ? {} : { version }) });
		},
		async diskFetch(hostId, params) {
			// Routed as any call to a host: on this replica's connection or another's.
			await onHost(hostId, HostMethods.diskFetch, params);
		},
		async stickyReports() {
			// Only hosts connected here: one away (or on another replica) is left to whoever holds it now.
			const reports: HostStickyReport[] = [];
			for (const host of await store.listHosts()) {
				if (host.revoked || host.capacityAt === undefined || !hub.connected(host.id)) continue;
				const capacity = storedCapacity(host.capacity);
				if (capacity === undefined) continue;
				reports.push({
					hostId: host.id,
					at: host.capacityAt,
					...(capacity.stickyDisks === undefined ? {} : { stickyDisks: capacity.stickyDisks }),
				});
			}
			return reports;
		},
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
				...(token.poolId === undefined ? {} : { poolId: token.poolId }),
				joinedAt: now,
				...(facts === undefined ? {} : { facts }),
			});
			if (
				token.accountId !== undefined &&
				joinTokens.accountOpen !== undefined &&
				!(await joinTokens.accountOpen(token.accountId))
			) {
				await store.updateHost(hostId, (host) => ({ ...host, revoked: true }));
				throw new KantelError("forbidden", "The account this token joins is being deleted");
			}
			const into = token.accountId === undefined ? "" : ` into account ${token.accountId}`;
			log(`[hosts] host ${hostId} (${name}) joined with token ${token.id}${into}`);
			return { hostId, credential };
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
			if (change.poolId !== undefined && (typeof change.poolId !== "string" || change.poolId.length === 0)) {
				throw new KantelError("invalid", "A pool's ID is a non-empty string");
			}
			const labels = change.labels === undefined ? undefined : labelsOf(change.labels);
			// On the host as stored now, so a report that lands meanwhile neither undoes this nor is undone by it.
			const next = await store.updateHost(hostId, (latest) => {
				// A drain or undrain ordered before the latest one taken is passed over (its other changes stand).
				const ordered =
					change.draining !== undefined &&
					(change.drainEpoch === undefined || change.drainEpoch > (latest.drainEpoch ?? 0));
				return {
					...latest,
					...(change.name === undefined ? {} : { name: change.name }),
					...(labels === undefined ? {} : { labels }),
					...(ordered ? { draining: change.draining === true } : {}),
					...(ordered && change.drainEpoch !== undefined ? { drainEpoch: change.drainEpoch } : {}),
					...(change.poolId === undefined ? {} : { poolId: change.poolId }),
				};
			});
			if (next === undefined) throw new KantelError("not_found", "No such host");
			if (next.revoked) throw new KantelError("conflict", "The host is revoked");
			const redrained = next.draining !== host.draining;
			// Moved to another pool: it leaves the old pool's mesh at once and joins the new one's, with an address there
			// given before the new pool's hosts are told of it, and its own welcome says where it is now.
			const moved = next.poolId !== host.poolId;
			const settled = moved ? await withMeshAddress(next) : next;
			if (redrained || (moved && runsMesh(settled))) rewelcome(settled);
			if (moved && runsMesh(host)) {
				await tellMesh(remeshPool(host.poolId, hostId));
				await tellMesh(remeshPool(settled.poolId, hostId));
			}
			return view(settled);
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
		async checkForUpdates() {
			const check = options.releases?.check;
			// The operator's version is the one hosts run: the latest release isn't what they're compared with.
			if (check === undefined || options.desiredVersion !== undefined) {
				throw new KantelError("not_supported", "This control plane doesn't read Kantel's latest kantel-host release");
			}
			try {
				const found = await check.call(options.releases);
				if (found.checked) log(`[hosts] checked the latest kantel-host: ${found.latestVersion ?? "none"}`);
				return found;
			} catch (error) {
				throw new KantelError("unavailable", error instanceof Error ? error.message : String(error));
			}
		},
		async holds(hostId) {
			// In one read (`occupying`): an upgrade's handover moves its placement from one host to the other and records
			// the isolate to delete in one write, which one read sees before or after, on either host.
			return (await store.occupying(hostId)).length > 0;
		},
		async revoke(hostId) {
			const host = await hostOf(hostId);
			const next = { ...host, revoked: true };
			await store.putHost(next);
			hub.disconnect(hostId, HOST_CLOSE_REVOKED, "The host's credential was revoked");
			// Out of its pool's mesh at once: its peers are sent their list without it.
			if (runsMesh(host)) await tellMesh(remeshPool(host.poolId, hostId));
			return view(next);
		},
		async grantKeysChanged() {
			// Every host, as `poolChanged` asks each: the hub finds the replica holding it, and reads its welcome afresh there.
			grantKeysRead = undefined;
			for (const host of await store.listHosts()) {
				if (!host.revoked) rewelcome(host);
			}
		},
		async poolChanged(poolId) {
			if (compute?.poolSync === undefined) return;
			for (const member of await store.listHosts()) {
				if (member.poolId !== poolId || !runsMesh(member)) continue;
				// Its peers (none with sync off), then its welcome, which brings its mesh up with them or takes it down. Asked
				// of the hub whether or not it looks connected here, as `remeshPool` does.
				hub.remesh(member.id);
				rewelcome(member);
			}
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
				const enforcing = needsEgressPolicy(input.egress) ? templating.filter(enforcesPolicy) : templating;
				if (enforcing.length === 0 && templating.length > 0) {
					throw placementError(
						"not_supported",
						"no_host_enforces_egress",
						"No host that could take it enforces egress grants or protected variables; upgrade kantel-host",
					);
				}
				// Sticky disks go only where they can be attached.
				const sticky = (input.stickyDisks?.length ?? 0) > 0;
				if (sticky && tier !== "microvm") throw new KantelError("invalid", "Sticky disks are a microVM's");
				const hosts = sticky
					? enforcing.filter((host) => host.facts?.features?.includes(HOST_FEATURES.stickyDisks) === true)
					: enforcing;
				if (hosts.length === 0 && enforcing.length > 0) {
					throw placementError(
						"not_supported",
						"no_host_for_type",
						"No host that could take it runs sticky disks; upgrade kantel-host",
					);
				}
				// Every candidate's placements in one read: the owners' isolates there, and the vCPUs booked.
				const placed = await store.placementsOnHosts(hosts.map((host) => host.id));
				const candidates: Candidate[] = await Promise.all(
					hosts.map(async (host) => {
						const placements = placed.get(host.id) ?? [];
						const held = reservedOn(host);
						return {
							host,
							connected: hub.connected(host.id),
							reservedMemoryMiB: held.memoryMiB,
							reservedDiskGiB: held.diskGiB,
							heldMemory: held.memory,
							owners: new Set(
								placements
									.filter((placement) => placement.tier === "isolate" && placement.owner !== undefined)
									.map((placement) => placement.owner as string),
							),
							bookedVcpus: bookedVcpus(placements),
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
				// Only while its host still takes sandboxes in its pool: a drain or move since the hosts were read refuses it.
				const admitted = await admit(placement, input.poolId, chosen.host.name);
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
							...(sticky ? { stickyDisks: input.stickyDisks } : {}),
						},
						// From a template, as long as a build: a fresh boot pulls its base image and runs its setup. From a sandbox's
						// snapshot, as long as its disk takes to copy.
						template !== undefined
							? { timeoutMs: TEMPLATE_BUILD_TIMEOUT_MS }
							: input.from !== undefined
								? { timeoutMs: DISK_COPY_TIMEOUT_MS }
								: undefined,
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
						...admitted,
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
				// Admitted as a create is, on its source's host: refused while that host drains, or once it is in another pool.
				const admitted = await admit(placement, input.poolId, source.hostId);
				try {
					// The host is read only for a fork with mounts, to know which it can do.
					const features =
						(input.mounts?.length ?? 0) === 0
							? undefined
							: storedFacts((await store.getHost(source.hostId))?.facts)?.features;
					const mounts = mountHandoff(features, input.mounts);
					const sandbox = await onHost<HostSandbox>(
						source.hostId,
						HostMethods.fork,
						{
							sandboxId,
							newId,
							snapshotId: shortId("snap"),
							...(input.egress === undefined ? {} : { egress: input.egress }),
							...(input.env === undefined ? {} : { env: input.env }),
							...mountsParam(mounts),
						},
						{ timeoutMs: DISK_COPY_TIMEOUT_MS },
					);
					const statuses = mounts.status(sandbox);
					return {
						sandbox,
						hostId: source.hostId,
						placement: await settle(placement, sandbox),
						...(statuses === undefined ? {} : { mounts: statuses }),
						...admitted,
					};
				} catch (error) {
					throw await unplace(placement, await store.getHost(source.hostId), error);
				}
			},
			async upgrade(sandboxId, input) {
				const { operationId } = input;
				const source = await placementOf(sandboxId);
				if (source.tier !== "isolate") throw new KantelError("conflict", "The sandbox is a microVM already");
				if (source.upgrade !== undefined && source.upgrade.operationId !== operationId) {
					throw new KantelError("conflict", "Another upgrade of the sandbox is under way");
				}
				const shape = input.shape === undefined ? undefined : shapeIn(input.shape, "microvm");
				const only = input.hostIds === undefined ? undefined : new Set(input.hostIds);
				const listed = (await store.listHosts())
					.map(sane)
					.filter((host) => only === undefined || only.has(host.id))
					.filter((host) => host.accountId === undefined || host.accountId === input.owner)
					.filter((host) => !needsEgressPolicy(input.egress) || enforcesPolicy(host));
				const request = {
					tier: "microvm" as const,
					...(input.size === undefined ? {} : { size: input.size }),
					...(shape === undefined ? {} : { shape }),
					...(input.owner === undefined ? {} : { owner: input.owner }),
					...(input.labels === undefined ? {} : { labels: input.labels }),
				};
				const candidateOf = (host: HostRecord): Candidate => {
					const held = reservedOn(host);
					return {
						host,
						connected: hub.connected(host.id),
						reservedMemoryMiB: held.memoryMiB,
						reservedDiskGiB: held.diskGiB,
						heldMemory: held.memory,
						owners: new Set(),
					};
				};
				/** A create's params for the microVM, as `create` sends them for the size or shape placed. */
				const paramsFor = (chosen: { readonly size: HostSize; readonly custom: boolean }) => ({
					sandboxId,
					tier: "microvm",
					size: chosen.custom ? "" : chosen.size.name,
					...(chosen.custom
						? { vcpus: chosen.size.vcpus, memoryMiB: chosen.size.memoryMiB, diskGiB: chosen.size.diskGiB }
						: {}),
					...(input.owner === undefined ? {} : { owner: input.owner }),
					...(input.env === undefined ? {} : { env: input.env }),
					...(input.egress === undefined ? {} : { egress: input.egress }),
				});
				/**
				 * The upgrade, kept on the isolate's placement before anything is sent: where its microVM may be, so one whose
				 * gateway or answer is lost is settled (`settleUpgrade`) rather than guessed.
				 */
				const intend = async (target: HostRecord, size: HostSize, phase: "host" | "copy") => {
					// Only on the isolate it was read as, with no other upgrade on it: never over a newer placement.
					const written = await store.updatePlacement(sandboxId, (latest) =>
						latest.tier === "isolate" &&
						latest.hostId === source.hostId &&
						(latest.upgrade === undefined || latest.upgrade.operationId === operationId)
							? { ...latest, upgrade: { operationId, target: target.id, phase, size }, updatedAt: clock.now() }
							: undefined,
					);
					if (written === undefined) throw new KantelError("conflict", "Another upgrade of the sandbox is under way");
				};
				// Its own host, where it makes microVMs from its isolates: the files go from its blob store into the microVM
				// there, never through Kantel.
				const own = listed.find(
					(host) => host.id === source.hostId && host.facts?.features?.includes(HOST_FEATURES.isolateUpgrade) === true,
				);
				const here = own === undefined ? undefined : place(request, [candidateOf(own)]);
				if (own !== undefined && here !== undefined && !isRefusal(here)) {
					await intend(own, here.size, "host");
					reserve(own.id, here.size.memoryMiB, here.size.diskGiB);
					let made: HostSandbox | undefined;
					try {
						made = await onHost<HostSandbox>(
							own.id,
							HostMethods.upgrade,
							{ ...paramsFor(here), operationId },
							{ timeoutMs: upgradeTimeoutMs },
							own,
						);
					} catch (error) {
						if (unanswered(error)) {
							// Its host may have done it, whatever became of the answer: asked, never guessed.
							const outcome = await settleWith(sandboxId, operationId).catch(() => undefined);
							if (outcome === undefined) {
								throw upgradeOutcomeUnknown(
									`Host ${own.name} didn't answer the upgrade (${error instanceof Error ? error.message : String(error)}), and can't be asked yet what it did`,
								);
							}
							if (outcome.state === "done") return outcome.upgraded;
							throw new KantelError(
								"unavailable",
								`The upgrade didn't happen: ${outcome.reason ?? "its host rolled it back"}`,
							);
						}
						// The host refused it, and rolled back what it did: the isolate is as it was, placed as it was (as it is now,
						// and only while this upgrade is on it).
						await clearUpgrade(sandboxId, operationId);
						// No room there after all: another host, as when it had none to begin with. Any other failure stands.
						if (!isKantelError(error) || (error.code !== "exhausted" && error.code !== "not_supported")) throw error;
						log(`[hosts] host ${own.id} couldn't upgrade ${sandboxId} itself (${error.message}); moving it`);
					}
					if (made !== undefined) {
						// Its host has replaced the isolate: only recording that is left. A failure here is no refusal, and the
						// placement keeps the upgrade (or has the microVM, if the write landed), so it is settled by its ID.
						try {
							return await commitOnHost(sandboxId, own, here.size, made);
						} catch (error) {
							throw upgradeOutcomeUnknown(
								`Host ${own.name} made the microVM, but it couldn't be recorded yet (${error instanceof Error ? error.message : String(error)})`,
							);
						}
					}
				}
				// Another host makes the microVM, under the same ID while the isolate, held still on its own host
				// (`sandbox.upgrade.freeze`: what was under way ended, nothing written after), stays the placement until the
				// files are in; then the placement moves, and the isolate's removal is owed its host until it is done.
				const others = listed.filter(
					(host) => host.id !== source.hostId && host.facts?.features?.includes(HOST_FEATURES.filesExtract) === true,
				);
				const chosen = place(request, others.map(candidateOf));
				if (isRefusal(chosen)) {
					throw placementError(
						"exhausted",
						chosen.code,
						others.length === 0
							? "No host can make a microVM from this isolate: its own host doesn't run microVMs, and no other that may take it does"
							: chosen.reason,
					);
				}
				const sourceHost = sane((await store.getHost(source.hostId)) ?? ({ id: source.hostId } as HostRecord));
				if (sourceHost.facts?.features?.includes(HOST_FEATURES.isolateFreeze) !== true) {
					throw new KantelError(
						"not_supported",
						"The isolate's host can't hold it still for its files to move to another host; upgrade its kantel-host",
					);
				}
				const target = chosen.host;
				// Before the create is sent: a microVM may be there from then on, whatever becomes of its answer.
				await intend(target, chosen.size, "copy");
				// Kept before the host is read again, as a create's placement is kept only on a host taking sandboxes: a drain
				// written before this read refuses it (and its intent goes, nothing sent yet), and one written after finds the
				// intent, so a move of the drained host waits for it (`holds`).
				// (A retry of the same upgrade keeps the intent it may have acted on: its target is counted already.)
				const taking = source.upgrade === undefined ? await store.getHost(target.id) : target;
				if (!admits(taking, input.poolId)) {
					await store.updatePlacement(sandboxId, (latest) => {
						if (latest.upgrade?.operationId !== operationId || latest.upgrade.target !== target.id) return undefined;
						const { upgrade: _intent, ...rest } = latest;
						return rest;
					});
					throw placementError(
						"unavailable",
						"host_unavailable",
						`The host ${target.name} is draining, or was moved to another pool`,
					);
				}
				reserve(target.id, chosen.size.memoryMiB, chosen.size.diskGiB);
				/** Rolls the copy back: only before the placement is the microVM's, while the isolate is still there. */
				const rollBack = async (error: unknown): Promise<never> => {
					// Anything that stops the rollback short of done (its claim or a check of it failing in the store, as much as
					// a host not answering) leaves the outcome unknown, for the settle to finish: never a failure, which compute
					// would take as the isolate put back.
					const rolled = await rollBackCopy(sandboxId, source.hostId, target.id, operationId).catch(
						() => "unreachable" as const,
					);
					if (rolled === "done") throw error;
					throw upgradeOutcomeUnknown(
						rolled === "unreachable"
							? `The upgrade failed (${error instanceof Error ? error.message : String(error)}) and couldn't be rolled back yet: a host didn't answer`
							: `The upgrade failed (${error instanceof Error ? error.message : String(error)}), and another gateway is settling it`,
					);
				};
				let sandbox: HostSandbox;
				let moved: { readonly files: number; readonly bytes: number };
				try {
					await onHost(
						source.hostId,
						HostMethods.upgradeFreeze,
						{ sandboxId, operationId },
						{ timeoutMs: FREEZE_TIMEOUT_MS },
					);
					// Listed before the microVM is made: too much to move is refused without one.
					const listing = await listWorkspace(sandboxId, source.hostId);
					sandbox = await onHost<HostSandbox>(target.id, HostMethods.create, paramsFor(chosen), undefined, target);
					moved = await moveFiles(sandboxId, listing, source.hostId, target.id);
					const linked = await onHost<HostExecResult>(target.id, HostMethods.exec, {
						sandboxId,
						argv: ["sh", "-c", UPGRADE_LINK],
						user: "root",
						timeoutMs: 30_000,
					});
					if (linked.exitCode !== 0) {
						throw new KantelError(
							"unavailable",
							`/workspace couldn't be linked in the microVM: ${linked.stderr.trim()}`,
						);
					}
				} catch (error) {
					return rollBack(error);
				}
				// The microVM is the sandbox now, owing its isolate's host the isolate's removal. A write that fails may still
				// have landed: read back, the placement says which, and only one that never moved is rolled back.
				let placement: PlacementRecord;
				try {
					placement = await settle(
						{
							...placementOn(sandboxId, target, chosen.size, source, input.owner),
							cleanup: { hostId: source.hostId, operationId },
						},
						sandbox,
						target,
					);
				} catch (error) {
					const read = await store.getPlacement(sandboxId).catch(() => undefined);
					if (read?.tier === "microvm" && read.hostId === target.id) placement = read;
					else if (read?.tier === "isolate" && read.upgrade?.operationId === operationId) return rollBack(error);
					else {
						throw upgradeOutcomeUnknown(
							`The microVM's placement couldn't be recorded (${error instanceof Error ? error.message : String(error)}), nor read back yet`,
						);
					}
				}
				// From here the isolate may be deleted: nothing rolls back. A removal not done, or not recorded, stays owed
				// (`cleanup`), done once its host is back.
				const cleaned = await cleanUpSource(source.hostId, sandboxId).catch((error: unknown) => {
					const why = error instanceof Error ? error.message : String(error);
					log(
						`[hosts] the isolate ${sandboxId}'s removal from ${source.hostId} wasn't recorded (${why}); again once it's back`,
					);
					cleanupsDue.set(source.hostId, new Set([...(cleanupsDue.get(source.hostId) ?? []), sandboxId]));
					return undefined;
				});
				return {
					sandbox,
					hostId: target.id,
					placement: cleaned ?? placement,
					nestedVirtualisation: target.facts?.nested ?? false,
					path: "control-plane" as const,
					...moved,
					// The target's as it admitted it, once its intent was written.
					...(taking.poolId === undefined ? {} : { poolId: taking.poolId }),
				};
			},
			async settleUpgrade(sandboxId, operationId) {
				return settleWith(sandboxId, operationId);
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
					const tier = (result as { tier?: unknown } | undefined)?.tier ?? placement.tier;
					await applyReport(sandboxId, placement.hostId, tier, { state, size }, await store.getHost(placement.hostId));
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
					await forgetPlacement(sandboxId, (latest) => latest.hostId === placement.hostId);
					return;
				}
				try {
					await onHost(placement.hostId, HostMethods.delete, { sandboxId });
				} catch (error) {
					// Gone on the host already is gone.
					if (!(error instanceof KantelError && error.code === "not_found")) throw error;
				}
				// Only as placed where it was deleted: what a deleted event left of it elsewhere meanwhile stays.
				await forgetPlacement(sandboxId, (latest) => latest.hostId === placement.hostId);
			},
			placement(sandboxId) {
				return store.getPlacement(sandboxId);
			},
			async openPort(sandboxId, port, sink) {
				if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new KantelError("invalid", "Not a port");
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
