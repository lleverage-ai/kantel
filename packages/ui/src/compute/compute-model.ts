// The compute console's model (experimental): what its pages show about accounts, sandboxes, snapshots, API keys, the
// egress proxy, webhooks, OpenTelemetry export, hosts and the plan, and the calls they make. These are the pages'
// own records, shaped for what they show; the console maps the public compute API's records onto them, and stories
// and the console's sample data serve them from `./fixtures.ts`. A page takes only the part of `ComputeSource` it
// calls, so a host can bind one page at a time as the API grows.

import { DAY, duration, HOUR, MINUTE } from "../primitives/format.ts";
import type { Status } from "../tokens/tokens.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Where the console runs

/**
 * How this Kantel is run. `self-hosted`: an operator runs the control plane and adds their own hosts; there's no
 * plan or bill, and the super-admin manages hosts. `hosted`: Kantel runs it as a paid service, with plans, limits and
 * a cost per sandbox (a demo: no payment is taken).
 */
export type HostingMode = "self-hosted" | "hosted";

// ---------------------------------------------------------------------------------------------------------------------
// Accounts and organisations

export type AccountKind = "personal" | "organisation";
export type AccountRole = "owner" | "admin" | "member";

/** An account sandboxes belong to: the person's own, or an organisation they're in, where sandboxes are shared. */
export interface ComputeAccount {
	readonly id: string;
	readonly kind: AccountKind;
	readonly name: string;
	/**
	 * The account's short name, in sandbox addresses: `<sandbox>.<slug>.<domain>`. Absent where addresses don't carry
	 * the account, as with the compute API, which names a sandbox `<subdomain>.<domain>`.
	 */
	readonly slug?: string;
	readonly role: AccountRole;
	/** People in an organisation; 1 for a personal account. */
	readonly members: number;
	/** The plan's id on a hosted Kantel. */
	readonly planId?: string;
	/** An organisation's: `blocked` when members' personal access tokens can't act in it. Absent is allowed. */
	readonly personalTokens?: "allowed" | "blocked";
}

/** The person signed in. */
export interface ComputeViewer {
	readonly id: string;
	readonly name: string;
	readonly email: string;
	/** Can manage the hosts and every account: the operator of a self-hosted Kantel, or Kantel's staff when hosted. */
	readonly superAdmin: boolean;
}

export interface OrganisationMember {
	readonly id: string;
	readonly name: string;
	readonly email: string;
	readonly role: AccountRole;
	readonly joinedAt: number;
}

export interface OrganisationInvite {
	readonly id: string;
	readonly email: string;
	readonly role: AccountRole;
	readonly sentAt: number;
	/** The join code (`kji_…`), only on the invite just made: Kantel shows it once. */
	readonly code?: string;
	/** Only on the invite just made: whether Kantel emailed it with a link to join. */
	readonly emailed?: boolean;
}

export interface AccountsSource {
	viewer(): Promise<ComputeViewer>;
	/** The viewer's personal account first, then their organisations by name. */
	list(): Promise<readonly ComputeAccount[]>;
	createOrganisation(input: { readonly name: string; readonly slug: string }): Promise<ComputeAccount>;
	/** Joins with the code from an invite. */
	join(code: string): Promise<ComputeAccount>;
	members(accountId: string): Promise<readonly OrganisationMember[]>;
	invites(accountId: string): Promise<readonly OrganisationInvite[]>;
	invite(accountId: string, input: { readonly email: string; readonly role: AccountRole }): Promise<OrganisationInvite>;
	revokeInvite(accountId: string, inviteId: string): Promise<void>;
	removeMember(accountId: string, memberId: string): Promise<void>;
	leave(accountId: string): Promise<void>;
	/**
	 * Deletes the signed-in person's account (`DELETE /v1/whoami`): their personal account, keys and memberships, and
	 * their sign-in. Absent where the source can't, as for an API key.
	 */
	deleteAccount?(): Promise<void>;
	/** Renames an organisation; needs admin. Absent where the source can't. */
	rename?(accountId: string, name: string): Promise<ComputeAccount>;
	/** Allows or blocks members' personal access tokens in an organisation; needs admin. Absent where it can't. */
	setPersonalTokens?(accountId: string, policy: "allowed" | "blocked"): Promise<ComputeAccount>;
	/** Changes a member's role; needs admin, and only an owner makes or unmakes an owner. Absent where it can't. */
	setRole?(accountId: string, memberId: string, role: AccountRole): Promise<OrganisationMember>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sandboxes

/**
 * Where a sandbox runs. `isolate`: a V8 isolate (kantel-isolate) running a bash written in TypeScript over its /workspace, up in milliseconds. `microvm`: a
 * Firecracker microVM with its own kernel, root, Docker and /dev/kvm inside.
 */
export type SandboxKind = "isolate" | "microvm";

/** A sandbox's state. A stop keeps the disk as a snapshot; `paused` keeps memory too (microVMs only). */
export type SandboxState = "starting" | "running" | "paused" | "stopping" | "stopped" | "error";

export type SandboxSize = "small" | "medium" | "large" | "xlarge";

export interface SandboxSizeSpec {
	readonly size: SandboxSize;
	readonly label: string;
	readonly vcpus: number;
	readonly memoryGb: number;
	readonly diskGb: number;
	/** Hosted only: US cents an hour while it runs. */
	readonly centsPerHour?: number;
}

export const SANDBOX_SIZES: readonly SandboxSizeSpec[] = [
	{ size: "small", label: "Small", vcpus: 2, memoryGb: 4, diskGb: 40, centsPerHour: 2 },
	{ size: "medium", label: "Medium", vcpus: 4, memoryGb: 8, diskGb: 60, centsPerHour: 4 },
	{ size: "large", label: "Large", vcpus: 8, memoryGb: 16, diskGb: 120, centsPerHour: 8 },
	{ size: "xlarge", label: "Extra large", vcpus: 16, memoryGb: 32, diskGb: 240, centsPerHour: 20 },
];

/** What a new sandbox gets. An isolate's `vcpus` is 0: it shares its account's VM's CPU. */
export interface SandboxShape {
	readonly vcpus: number;
	readonly memoryMb: number;
	/** A microVM's disk in GB, chosen apart from its vCPUs and memory. Absent: the disk its host gives the shape. */
	readonly diskGb?: number;
}

/** A slider's range: its ends, its step and where it starts. */
export interface ShapeRange {
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly default: number;
}

/** A shape the hosts offer by name. */
export interface ShapePreset extends SandboxShape {
	readonly name: string;
	readonly diskGb: number;
}

/** What New sandbox's sliders may choose. */
export interface SandboxShapes {
	readonly isolate: { readonly memoryMb: ShapeRange };
	readonly microvm: {
		readonly vcpus: ShapeRange;
		readonly memoryMb: ShapeRange;
		/** Memory follows vCPUs: each vCPU has at least `min` and at most `max` MB. */
		readonly memoryMbPerVcpu: { readonly min: number; readonly max: number };
		/**
		 * The disk a microVM may ask for in GB, whatever its vCPUs and memory, its default the default preset's. Absent
		 * where no host takes a disk off its presets (older hosts), or none has the free disk for its least: each host gives
		 * the disk its shape has. A sandbox made
		 * from a snapshot keeps the snapshot's disk.
		 */
		readonly diskGb?: ShapeRange;
		readonly presets: readonly ShapePreset[];
		/**
		 * Whether some host makes a shape off the presets. False (every host is an older kantel-host): only the presets
		 * may be chosen. Absent: true.
		 */
		readonly custom?: boolean;
		/**
		 * False: no host the account may use runs microVMs, so none can be made (the ranges above are placeholders).
		 * Absent: true.
		 */
		readonly available?: boolean;
	};
	/** Hosted only: US cents an hour while it runs, per vCPU and per GB of memory. */
	readonly rates?: {
		readonly microvmCentsPerVcpuHour: number;
		readonly microvmCentsPerGbHour: number;
		readonly isolateCentsPerGbHour: number;
	};
}

/** Isolates: 128 to 512 MB in 64 MB steps, 256 by default. */
export const ISOLATE_MEMORY: ShapeRange = { min: 128, max: 512, step: 64, default: 256 };

/** The sample data's shapes: its sizes as presets. */
export const DEFAULT_SANDBOX_SHAPES: SandboxShapes = {
	isolate: { memoryMb: ISOLATE_MEMORY },
	microvm: {
		vcpus: { min: 1, max: 16, step: 1, default: 4 },
		memoryMb: { min: 512, max: 32768, step: 512, default: 8192 },
		memoryMbPerVcpu: { min: 512, max: 8192 },
		// The default (4 vCPU, 8 GB) is the medium preset: its disk is the default.
		diskGb: { min: 20, max: 500, step: 1, default: 60 },
		presets: [
			{ name: "small", vcpus: 2, memoryMb: 4096, diskGb: 40 },
			{ name: "medium", vcpus: 4, memoryMb: 8192, diskGb: 60 },
			{ name: "large", vcpus: 8, memoryMb: 16384, diskGb: 120 },
			{ name: "xlarge", vcpus: 16, memoryMb: 32768, diskGb: 240 },
		],
	},
	rates: { microvmCentsPerVcpuHour: 0.75, microvmCentsPerGbHour: 0.125, isolateCentsPerGbHour: 2 },
};

/**
 * `value` on `range`'s grid (whole steps, as the API counts them) and within its ends, as its slider shows it: what
 * New sandbox keeps is what its controls show, and what it sends. Where the range is empty, its top, never past it.
 */
export function onGrid(range: Pick<ShapeRange, "min" | "max" | "step">, value: number): number {
	const stepped = Math.round(value / range.step) * range.step;
	return Math.min(range.max, Math.max(range.min, stepped));
}

/**
 * The vCPUs a microVM may have: the range, cut to the most that some memory on the grid fits (32 vCPUs at 512 MB each
 * need 16 GB, so hosts with 8 GB stop at 16).
 */
export function vcpuRangeFor(shapes: SandboxShapes): ShapeRange {
	const { vcpus } = shapes.microvm;
	const fits = (count: number) => {
		const memory = memoryRangeFor(shapes, count);
		return memory.min <= memory.max;
	};
	let max = vcpus.max;
	while (max > vcpus.min && !fits(max)) max -= vcpus.step;
	const range = { ...vcpus, max };
	return { ...range, default: onGrid(range, vcpus.default) };
}

/**
 * The memory a microVM of `vcpus` may have: the range, narrowed to what that many vCPUs may hold, with both ends on
 * the step grid and never past the memory's top. Empty (`min` above `max`) where that many vCPUs can't be had at all.
 */
export function memoryRangeFor(shapes: SandboxShapes, vcpus: number): ShapeRange {
	const { memoryMb, memoryMbPerVcpu } = shapes.microvm;
	const step = memoryMb.step;
	const min = Math.ceil(Math.max(memoryMb.min, vcpus * memoryMbPerVcpu.min) / step) * step;
	const max = Math.floor(Math.min(memoryMb.max, vcpus * memoryMbPerVcpu.max) / step) * step;
	return { min, max, step, default: onGrid({ min, max, step }, memoryMb.default) };
}

/**
 * The disk New sandbox may ask for a microVM: undefined where none may be chosen, as no host takes a disk off its
 * presets or has the free disk for its least, or only the presets may be chosen (then each host gives its preset's disk).
 */
export function diskRangeFor(shapes: SandboxShapes): ShapeRange | undefined {
	return customShapes(shapes) ? shapes.microvm.diskGb : undefined;
}

/**
 * `diskGb` on the disk slider's grid and within its ends, as it shows it; the range's default where none is given.
 * Undefined where no disk may be chosen.
 */
export function fitDisk(shapes: SandboxShapes, diskGb?: number): number | undefined {
	const range = diskRangeFor(shapes);
	return range === undefined ? undefined : onGrid(range, diskGb ?? range.default);
}

/**
 * Whether New sandbox may ask for a microVM of `shape`: a preset, or (where hosts make them) one in the ranges. A disk,
 * where it names one, must be in the disk's range, and there must be one.
 */
export function shapeAllowed(shapes: SandboxShapes, shape: SandboxShape): boolean {
	if (shape.diskGb !== undefined) {
		const disk = diskRangeFor(shapes);
		if (disk === undefined || disk.min > disk.max || shape.diskGb < disk.min || shape.diskGb > disk.max) return false;
	}
	if (presetOf(shapes, shape) !== undefined) return true;
	if (!customShapes(shapes)) return false;
	const cpus = vcpuRangeFor(shapes);
	const memory = memoryRangeFor(shapes, shape.vcpus);
	return (
		shape.vcpus >= cpus.min &&
		shape.vcpus <= cpus.max &&
		memory.min <= memory.max &&
		shape.memoryMb >= memory.min &&
		shape.memoryMb <= memory.max
	);
}

/**
 * `memoryMb` moved onto the grid and into what `vcpus` may hold, as the memory slider shows it when the vCPU slider
 * moves. Never past the memory's top: where `vcpus` can't be had at all, below its least, and not allowed.
 */
export function fitMemory(shapes: SandboxShapes, vcpus: number, memoryMb: number): number {
	return onGrid(memoryRangeFor(shapes, vcpus), memoryMb);
}

/** The preset a microVM shape is, if it is one: by its vCPUs and memory, whatever disk it asks for. */
export function presetOf(shapes: SandboxShapes, shape: SandboxShape): ShapePreset | undefined {
	return shapes.microvm.presets.find((preset) => preset.vcpus === shape.vcpus && preset.memoryMb === shape.memoryMb);
}

/** Whether New sandbox offers any vCPUs and memory, or only the presets (no host makes custom shapes; maybe none). */
export const customShapes = (shapes: SandboxShapes): boolean => shapes.microvm.custom !== false;

/** Whether a microVM can be made at all: some host the account may use runs them. */
export const microvmsAvailable = (shapes: SandboxShapes): boolean => shapes.microvm.available !== false;

/** Whether New sandbox may ask for this: an isolate, or a microVM some host makes (a preset, or within the bounds). */
export const shapeCreatable = (shapes: SandboxShapes, kind: SandboxKind, shape: SandboxShape): boolean =>
	kind === "isolate" || (microvmsAvailable(shapes) && shapeAllowed(shapes, shape));

/** US cents an hour for a sandbox of `shape`, at the shapes' rates; undefined where there are none (self-hosted). */
export function shapeCentsPerHour(shapes: SandboxShapes, kind: SandboxKind, shape: SandboxShape): number | undefined {
	const rates = shapes.rates;
	if (rates === undefined) return undefined;
	const gb = shape.memoryMb / 1024;
	return kind === "isolate"
		? gb * rates.isolateCentsPerGbHour
		: shape.vcpus * rates.microvmCentsPerVcpuHour + gb * rates.microvmCentsPerGbHour;
}

/** "512 MB", "2 GB", "1.5 GB": memory in the unit that reads best. */
export function memoryText(memoryMb: number): string {
	if (memoryMb < 1024) return `${memoryMb} MB`;
	const gb = memoryMb / 1024;
	return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** The latest snapshot a sandbox has: what a resume or fork starts from. */
export interface SnapshotRef {
	readonly id: string;
	/** When it was taken; absent where the source doesn't say (its record gone), never a guess. */
	readonly takenAt?: number;
}

/** Who made a sandbox: a person's ID, or an API key's. */
export interface SandboxCreator {
	readonly kind: "user" | "api_key";
	readonly id: string;
}

export interface Sandbox {
	readonly id: string;
	/** The name people gave it, also its subdomain. */
	readonly name: string;
	/** Its address, for its public URLs: `<name>.<account>.<domain>`. */
	readonly hostname: string;
	readonly accountId: string;
	readonly kind: SandboxKind;
	/** The size it was made as, by name. Absent: a shape no size names, or an isolate. Never what the page shows. */
	readonly size?: SandboxSize;
	/**
	 * The vCPUs and memory it asked for (a fork, its source's), known from the moment it's made: the page shows this until
	 * its host says what it got (`resources`).
	 */
	readonly shape?: { readonly vcpus: number; readonly memoryGb: number };
	/** What its host gave it, where that's known: the page shows this first. */
	readonly resources?: { readonly vcpus: number; readonly memoryGb: number; readonly diskGb: number };
	readonly state: SandboxState;
	/**
	 * It was deleted: the API keeps its record a while, and a read of it says so (its `state` is then `stopped`). A
	 * sandbox's page shows it as deleted, however it learnt of it.
	 */
	readonly deleted?: boolean;
	readonly createdAt: number;
	/** Who made it, by name. */
	readonly createdBy: string;
	/**
	 * Who made it, by ID: a person, or an API key. With the viewer's ID the list says which are theirs and filters by who
	 * made them. Absent where the source doesn't say.
	 */
	readonly creator?: SandboxCreator;
	/** When auto-stop stops it; absent when it's always on or not running. */
	readonly stopsAt?: number;
	/**
	 * How long it may go unused before its idle stop stops it, in minutes: no command, SSH, desktop, browser or port
	 * traffic. Absent: no idle stop.
	 */
	readonly idleStopMinutes?: number;
	/** When its idle stop stops it if nobody uses it first; absent with none, or when it isn't running. */
	readonly idleStopsAt?: number;
	/**
	 * Why Kantel stopped or paused it, while it is: `auto-stop` (its time came), `idle-stop` (it went unused), or a
	 * rule's reason. Absent: someone stopped it.
	 */
	readonly stopReason?: string;
	readonly snapshot?: SnapshotRef;
	/** Hosted only: what it has cost this billing period, in US cents. */
	readonly costCents?: number;
	/** CPU use over the last hour, 0 to 1, oldest first: the row's sparkline. */
	readonly usage: readonly number[];
	/**
	 * The host it runs on (or last ran on), where the viewer may know it: a super-admin any host, anyone else one of the
	 * account's own hosts.
	 */
	readonly hostId?: string;
	/** That host's name, with `hostId`. */
	readonly hostName?: string;
	/** What went wrong, when it's in `error`. */
	readonly error?: string;
	/**
	 * Why its guest agent isn't answering (out of memory, say), while it runs but doesn't: its calls are refused, and
	 * Recover (a restart that keeps its disk) is offered. Absent while it answers.
	 */
	readonly unresponsive?: string;
	/**
	 * Its host isn't connected to Kantel: nothing reaches its machine, and `state` is only what it was last known to be.
	 * Nothing that needs the machine is offered; a stop is, and waits for the host. Absent while its host is connected.
	 */
	readonly hostUnreachable?: boolean;
	/** Shared with the organisation it belongs to (an organisation's sandboxes are shared unless made private). */
	readonly shared?: boolean;
	/** The sandbox it was forked from. */
	readonly forkedFrom?: string;
	/**
	 * Its environments, in order: where two set the same variable, secret file or repository path, the later one wins.
	 * Absent or empty: none.
	 */
	readonly environments?: readonly EnvironmentRef[];
	/**
	 * The base image it runs on, and how far that is behind the latest on its channel. Kantel never patches a running
	 * sandbox: it moves to the latest base when it restarts on it. Absent where Kantel doesn't say (an isolate).
	 */
	readonly base?: SandboxBase;
	/** Its read-only mounts (experimental), each with whether its files are in place. Absent: none. */
	readonly mounts?: readonly SandboxMount[];
	/** What a microVM's image has, as its guest agent found it; absent until one has said (an older host or image). */
	readonly image?: SandboxImage;
	/** The template it was made from, and whether it started from the template's snapshot or booted fresh. */
	readonly template?: {
		readonly id: string;
		readonly name: string;
		readonly version: number;
		readonly start: "snapshot" | "boot";
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Base images

/** A sandbox's, a saved snapshot's or a template's base image, against the latest version on its channel. */
export interface SandboxBase {
	/** The image's name: `sandbox`, `browser`. */
	readonly image: string;
	/** The version it is on, where Kantel knows it: `2026.11.03.811`. */
	readonly version?: string;
	/** A newer version is on its channel. */
	readonly outdated: boolean;
	/** The latest version on its channel, and when it was built. */
	readonly latest?: { readonly version: string; readonly builtAt: number };
	/** How far behind the latest it is, when outdated. */
	readonly behind?: { readonly days: number; readonly versions: number };
	/** The newer versions carry security fixes. */
	readonly security?: boolean;
}

/** How bad a vulnerability a scan found is. */
export type ImageSeverity = "critical" | "high" | "medium" | "low" | "unknown";

/** One vulnerability a scan found in a base image's package. */
export interface ImageFinding {
	/** `CVE-2026-31789`, or the scanner's own ID. */
	readonly id: string;
	readonly severity: ImageSeverity;
	readonly package: string;
	/** The version in the image. */
	readonly installed: string;
	/** The version that fixes it; absent while there is no fix. */
	readonly fixed?: string;
	readonly title?: string;
}

/** What a vulnerability scan of one version of a base image found. */
export interface ImageScan {
	/** The scanner and its version: `trivy 0.67.2`. */
	readonly scanner: string;
	readonly scannedAt: number;
	readonly counts: Readonly<Record<ImageSeverity, number>>;
	/** Critical and high findings with a fix out: what makes Kantel rebuild the image. */
	readonly fixable: { readonly critical: number; readonly high: number };
	readonly findings: readonly ImageFinding[];
}

/** Why a version was built: the daily rebuild, a fixable vulnerability, by hand, or a change pushed to its recipe. */
export type ImageBuildReason = "daily" | "cve" | "manual" | "push";

export interface BaseImageVersion {
	readonly version: string;
	/** Its content digest: `sha256:` and 64 hex digits. */
	readonly digest: string;
	readonly builtAt: number;
	/** Its signature checks out. */
	readonly signed: boolean;
	readonly reason?: ImageBuildReason;
	/** Its latest scan; absent before the first. */
	readonly scan?: ImageScan;
}

/** A base image Kantel builds sandboxes from, and its versions on the stable channel. */
export interface BaseImage {
	readonly name: string;
	/** Where it's published: `ghcr.io/lleverage-ai/kantel-sandbox`. */
	readonly repository: string;
	readonly channel: "stable";
	readonly latest?: BaseImageVersion;
	/** Newest first. */
	readonly versions: readonly BaseImageVersion[];
}

/** A template, a base image with a setup on top, and how far its base is behind. */
export interface BaseImageTemplate {
	readonly id: string;
	readonly name: string;
	/** The base image it's built on. */
	readonly image: string;
	/** The channel it follows, when it follows one. */
	readonly channel?: string;
	/** The digest it's pinned to, when it's pinned rather than following a channel. */
	readonly pinned?: string;
	readonly base: SandboxBase;
	/** Kantel is building it again on the latest base now. */
	readonly rebuilding: boolean;
}

/** The deployment's base images and templates, as its image index says. */
export interface BaseImagesOverview {
	readonly images: readonly BaseImage[];
	readonly templates: readonly BaseImageTemplate[];
	/** Where the image index is. */
	readonly indexUrl: string;
	/** When the index was made. */
	readonly generatedAt?: number;
	/** Why Kantel couldn't read the index, in words; what it has may then be old or empty. */
	readonly error?: string;
}

export interface BaseImagesSource {
	overview(): Promise<BaseImagesOverview>;
}

// Read-only mounts (experimental: a deployment shows them only with `KANTEL_MOUNTS=experimental`)

/** `pending`: its host is still putting it in place. `ready`: its files are there. `failed`: they aren't. */
export type MountStatus = "pending" | "ready" | "failed";

/** What a mount's files come from: a bundle by digest, or a prefix of a bucket source. */
export type MountSource =
	| { readonly kind: "bundle"; readonly digest: string }
	| {
			readonly kind: "bucket";
			readonly bucketSourceId: string;
			readonly prefix: string;
			readonly refreshTtlSeconds?: number;
			/** The bucket source's name and bucket, where the console knows them. */
			readonly bucketSourceName?: string;
			readonly bucket?: string;
	  };

export interface SandboxMount {
	/** Where it appears in the sandbox, absolute. */
	readonly path: string;
	readonly source: MountSource;
	readonly status: MountStatus;
	/** Why it is `failed`. */
	readonly error?: string;
}

/** A tar of files uploaded to an account once, named by its digest, which sandboxes mount read-only. */
export interface Bundle {
	/** `sha256:` and 64 hex digits: its name and its ID. */
	readonly digest: string;
	readonly accountId: string;
	readonly sizeBytes: number;
	/** How many of the account's sandboxes that still exist mount it: it can't be deleted while any do. */
	readonly mountedBy: number;
	readonly createdAt: number;
}

export type BucketProvider = "s3" | "gcs";

/** A bucket an account's sandboxes may mount prefixes of. Its credentials are write-only: never shown. */
export interface BucketSource {
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly provider: BucketProvider;
	readonly bucket: string;
	readonly endpoint?: string;
	readonly region?: string;
	/** Whether it was given credentials. */
	readonly hasCredentials: boolean;
	/** How many of the account's sandboxes that still exist mount it: it can't be deleted while any do. */
	readonly mountedBy: number;
	readonly createdAt: number;
}

export interface MountsSource {
	bundles(accountId: string): Promise<readonly Bundle[]>;
	/** Refused (`conflict`) while a sandbox that still exists mounts it. */
	removeBundle(accountId: string, digest: string): Promise<void>;
	bucketSources(accountId: string): Promise<readonly BucketSource[]>;
	/** Refused (`conflict`) while a sandbox that still exists mounts it. */
	removeBucketSource(id: string): Promise<void>;
}

/** One thing an image has or lacks: what the guest agent found, or why it isn't there. */
export interface SandboxFeature {
	readonly available: boolean;
	/** What was found, such as "Xtigervnc, Openbox, Selkies". */
	readonly detail?: string;
	/** Why not, in a few words, such as "No desktop in this image". */
	readonly reason?: string;
}

/**
 * What a microVM's image has, as the guest agent Kantel runs in it found it when it last started: any Linux image runs,
 * and what it lacks (a desktop, a browser, Docker) is shown as missing rather than offered.
 */
export interface SandboxImage {
	/** Its OS's name, such as "Debian GNU/Linux 13 (trixie)". */
	readonly os: string;
	/** `/etc/os-release`'s ID, such as `alpine`. */
	readonly osId: string;
	/** `x86_64` or `aarch64`. */
	readonly arch: string;
	readonly libc: "glibc" | "musl" | "none";
	/** The shell commands run in; absent, there is none (argv only). */
	readonly shell?: string;
	/** PID 1: the image's systemd, or Kantel's own init. */
	readonly init: "systemd" | "kantel";
	/** Kantel put its agent into the image at boot rather than the image shipping it. */
	readonly injected: boolean;
	readonly agentVersion: string;
	readonly desktop: SandboxFeature;
	readonly browser: SandboxFeature;
	readonly docker: SandboxFeature;
	/** `/dev/kvm` opens inside, for nested VMs. */
	readonly kvm: boolean;
}

/** What the console says for each feature an image lacks when the agent gives no reason of its own. */
export const IMAGE_LACKS: Readonly<Record<"desktop" | "browser" | "docker", string>> = {
	desktop: "No desktop in this image",
	browser: "No browser in this image",
	docker: "No Docker in this image",
};

/** Why the sandbox's image lacks a feature, in a few words; undefined when it has it or nothing is known yet. */
export function imageLacks(
	sandbox: Pick<Sandbox, "image">,
	feature: "desktop" | "browser" | "docker",
): string | undefined {
	const found = sandbox.image?.[feature];
	if (found === undefined || found.available) return undefined;
	return found.reason ?? IMAGE_LACKS[feature];
}

/**
 * The one screen a sandbox offers: its desktop, where its image has one, since its browser runs on that desktop and
 * shows the same picture; otherwise its browser, where it has one; undefined for neither. Unknown counts as there.
 */
export function sandboxScreen(sandbox: Pick<Sandbox, "image">): "desktop" | "browser" | undefined {
	if (imageLacks(sandbox, "desktop") === undefined) return "desktop";
	if (imageLacks(sandbox, "browser") === undefined) return "browser";
	return undefined;
}

export interface CreateSandboxInput {
	readonly accountId: string;
	readonly name?: string;
	readonly kind: SandboxKind;
	/**
	 * What it gets: vCPUs and memory for a microVM, and a disk where one was chosen; memory alone for an isolate (it
	 * shares its account's VM's CPU). Absent: the deployment's default.
	 */
	readonly shape?: SandboxShape;
	/** A saved snapshot to start from. */
	readonly fromSnapshot?: string;
	/** Minutes until auto-stop; undefined is always on. */
	readonly autoStopMinutes?: number;
	/** Minutes unused before its idle stop; undefined is none. */
	readonly idleStopMinutes?: number;
	/** The environments it starts with, by ID, in order: the later one wins where two set the same thing. */
	readonly environmentIds?: readonly string[];
	/** The template it is made from (experimental): its newest built snapshot, or a fresh boot of its image. */
	readonly templateId?: string;
	/** The host it goes on, which it then stays on. Absent: Kantel picks. */
	readonly hostId?: string;
}

/** A host New sandbox may put a sandbox on: one of the account's own, or for a super-admin a shared one. */
export interface HostChoice {
	readonly id: string;
	readonly name: string;
	readonly state: HostState;
	/** The sandbox types it runs. */
	readonly kinds: readonly SandboxKind[];
	/** One of the deployment's shared hosts, rather than the account's own. */
	readonly shared: boolean;
}

/** A command that ran in a sandbox, for its history. */
export interface SandboxCommand {
	readonly id: string;
	readonly command: string;
	readonly startedAt: number;
	readonly durationMs?: number;
	readonly exitCode?: number;
	/** Who or what ran it: a person, an API key's name. */
	readonly by: string;
	/** The end of what it printed, stdout then stderr, for a command that failed. */
	readonly output?: string;
}

/** How to reach a sandbox, made when asked for: tokens in it are short-lived. */
export interface SandboxAccess {
	/**
	 * The Kantel CLI's command that SSHes in: `kantel ssh <id>`, which lets a key of its own in and needs nothing else.
	 * It has no token, so it works whenever it's run.
	 */
	readonly ssh: string;
	/**
	 * Signs the CLI in to the Kantel this console belongs to, once, before `ssh` works: `kantel login --url <gateway>`.
	 * Absent where there's no gateway to name (the sample data, or a page with no origin).
	 */
	readonly cliLogin?: string;
	/**
	 * Whether plain `ssh` can get in without the CLI, through `SandboxesSource.sshKey`. Absent: no.
	 */
	readonly sshWithoutCli?: boolean;
	/** Its desktop in the browser. */
	readonly desktopUrl: string;
	/** The same desktop to watch only: Kantel drops the viewer's keyboard and mouse. */
	readonly desktopViewUrl: string;
	/** Only its browser, without the desktop. */
	readonly browserUrl: string;
	/**
	 * The same three for a frame in the console. Absent where there's nothing real to show (the sample data): the
	 * console draws a stand-in.
	 */
	readonly embed?: { readonly desktop: string; readonly watch: string; readonly browser: string };
	/**
	 * Why Desktop or Browser can't open for this sandbox yet, in a few words ("Not available here yet"). Absent, it can.
	 * One that can't is shown disabled with its reason, never opened onto an error page; its URLs are then unused.
	 */
	readonly unavailable?: { readonly desktop?: string; readonly browser?: string };
}

/** The one line that installs the Kantel CLI (`kantel`), from kantel.dev: it pastes the same into bash, zsh and fish. */
export const CLI_INSTALL_COMMAND = "curl -fsSL https://kantel.dev/cli.sh | sh";

/** The hosted gateway, where `kantel login` signs in when it isn't given `--url`. */
const HOSTED_ORIGIN = "https://app.kantel.dev";

/** Signs the CLI in to the Kantel at `url` (its gateway's public origin), with no `--url` for the hosted one. */
export function cliLoginCommand(url: string): string {
	return url.replace(/\/+$/, "") === HOSTED_ORIGIN ? "kantel login" : `kantel login --url ${url}`;
}

/** The CLI's command that SSHes into a sandbox. */
export const cliSshCommand = (sandboxId: string): string => `kantel ssh ${sandboxId}`;

/** SSH without the CLI: a key let in for a while, and the plain `ssh` command that connects with it. */
export interface SandboxSshKey {
	/** The command that connects, with the key's file in it when Kantel made the key. */
	readonly command: string;
	/** The private half of a key pair Kantel made, shown once: absent when a public key was given. */
	readonly privateKey?: string;
	/** Where the command expects the private key, and the name it downloads as. */
	readonly keyFile?: { readonly name: string; readonly path: string };
	/** The sandbox's SSH host key, as ssh shows it the first time (`SHA256:…`). */
	readonly hostKeyFingerprint?: string;
	/** The time a connection must start by; one started stays open. */
	readonly expiresAt?: number;
}

/** Where `sshWithoutCliCommand` connects: the API's answer to `POST /v1/sandboxes/{id}/ssh`. */
export interface SshTarget {
	readonly sandboxId: string;
	readonly user: string;
	/** The relay's WebSocket URL, when there's no SSH gateway to dial. */
	readonly proxyUrl?: string;
	readonly host: string;
	readonly port: number;
}

/** A word as a POSIX shell (and fish) reads it back unchanged. */
const shellWord = (word: string): string =>
	/^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The plain `ssh` command for a sandbox, for someone without the CLI: through the relay with websocat as its
 * ProxyCommand (any WebSocket client that pipes stdin and stdout as binary frames does), or to the SSH gateway. With
 * `identityFile`, ssh offers that key only; a downloaded key is readable by others, which ssh refuses, so its mode is
 * set first. It reads the same in bash, zsh and fish.
 */
export function sshWithoutCliCommand(target: SshTarget, identityFile?: string): string {
	const key = identityFile === undefined ? [] : ["-i", identityFile, "-o", "IdentitiesOnly=yes"];
	const ssh =
		target.proxyUrl === undefined
			? ["ssh", ...key, "-p", String(target.port), `${target.user}@${target.host}`]
			: [
					"ssh",
					...key,
					"-o",
					// ssh expands %-tokens in a ProxyCommand: a literal % is %%.
					`ProxyCommand=websocat --binary ${target.proxyUrl.replaceAll("%", "%%")}`,
					`${target.user}@${target.sandboxId}`,
				];
	const line = ssh.map(shellWord).join(" ");
	return identityFile === undefined ? line : `chmod 600 ${shellWord(identityFile)} && ${line}`;
}

/** Why a screen can't open, from its access: the desktop's reason for Watch too. Undefined when it can. */
export const screenUnavailable = (access: SandboxAccess, view: "desktop" | "watch" | "browser"): string | undefined =>
	access.unavailable?.[view === "browser" ? "browser" : "desktop"];

/** A port in a sandbox with an HTTPS URL of its own. */
export interface SandboxPort {
	readonly port: number;
	/** Its URL, without the token a private one's link carries when it's first exposed. */
	readonly url: string;
	/** Anyone with the URL may open it. Private: only with the token from when it was exposed. */
	readonly public: boolean;
	readonly createdAt: number;
}

/** A file or folder in a running sandbox, as a snapshot's are: its path from the root, with no leading slash. */
export type SandboxEntry = SnapshotEntry;

/** A running sandbox's folder: what Kantel read of it, and whether it has more than that (a very big folder). */
export interface SandboxFolder {
	readonly entries: readonly SandboxEntry[];
	readonly more: boolean;
}

/** What a running sandbox is using now, where its host says. */
export interface SandboxUsageNow {
	/** Memory in use, in GB. */
	readonly memoryGb?: number;
	/** Disk in use, in GB. */
	readonly diskGb?: number;
}

/** What a sandbox or a host used over one interval. */
export interface UsagePoint {
	/** When the reading was taken, at the end of its interval, in ms since the epoch. */
	readonly at: number;
	/** CPU use over it, 0 to 1 of what it has: a sandbox's vCPUs, a host's. The unit of `Sandbox.usage`. */
	readonly cpu: number;
	readonly memUsedBytes: number;
	/**
	 * Where the point is a mean over its interval (a day's or a week's): the highest CPU and memory reading in it, which
	 * can be twice the mean or more. Absent on a reading as it came, which is its own highest.
	 */
	readonly cpuMax?: number;
	readonly memMaxBytes?: number;
	/** Its disk in use, where its host says: a host's always, a sandbox's where its host reads its filesystem. */
	readonly diskUsedBytes?: number;
	/**
	 * How much of the interval its work waited on disk IO, 0 to 1 (Linux's IO pressure, `some`): a sandbox's where its
	 * host reads it. Absent: not measured, not none.
	 */
	readonly ioPressure?: number;
}

/** Usage points at a steady interval, oldest first, with what they're measured against. */
export interface UsageSeries {
	readonly intervalMs: number;
	/** The most memory there is: a sandbox's limit, a host's total. */
	readonly memLimitBytes?: number;
	/** Its disk: a host's, or a sandbox's where its host reads its filesystem. */
	readonly diskTotalBytes?: number;
	readonly points: readonly UsagePoint[];
}

/** How far back a sandbox's metrics look: the last hour, day or week. */
export type UsageRange = "1h" | "24h" | "1w";

/** One of the busiest processes in a running sandbox, as `ps` says. */
export interface SandboxProcess {
	readonly pid: number;
	/** Its command line, whole. */
	readonly command: string;
	/** Its CPU, as a share of one vCPU in percent: 150 is one and a half. */
	readonly cpuPercent: number;
	/** Its resident memory, in bytes. */
	readonly memoryBytes: number;
}

/**
 * Reads the points newer than `since` (ms since the epoch). The live graphs call it every few seconds with the newest
 * point they have, so an answer is only what's new.
 */
export type UsageRead = (id: string, since: number) => Promise<UsageSeries>;

export interface SandboxesSource {
	/**
	 * What New sandbox's sliders may choose, from the hosts the account may use (or with `hostId` that one host), and
	 * what each costs. Absent:
	 * `DEFAULT_SANDBOX_SHAPES`.
	 */
	shapes?(accountId: string, hostId?: string): Promise<SandboxShapes>;
	/**
	 * The hosts New sandbox may put a sandbox on, for its host picker: the account's own, and for a super-admin the
	 * shared ones. Absent, or none: no picker, and Kantel picks.
	 */
	hosts?(accountId: string): Promise<readonly HostChoice[]>;
	list(accountId: string): Promise<readonly Sandbox[]>;
	/**
	 * Follows the account's sandboxes live: `changed` with a sandbox's ID each time one changes state, whoever changed it
	 * (the CLI, the API, an auto-stop), and `deleted` when it was deleted; with none each time the feed connects or
	 * reconnects, when anything may have changed meanwhile. The pages read again on each. Answers a function that stops.
	 * Absent: the pages read again only after their own changes and while a sandbox starts or stops.
	 */
	watch?(accountId: string, changed: (sandboxId?: string, deleted?: boolean) => void): () => void;
	create(input: CreateSandboxInput): Promise<Sandbox>;
	stop(id: string): Promise<Sandbox>;
	resume(id: string): Promise<Sandbox>;
	/** A new sandbox from this one's latest snapshot. */
	fork(id: string): Promise<Sandbox>;
	/** Restarts a sandbox's machine that doesn't answer; the disk is kept. */
	recover(id: string): Promise<Sandbox>;
	/**
	 * Makes an isolate a microVM with the same ID, its files (in `/home/user/workspace`, with `/workspace` linked there),
	 * env, environments and grants, and answers it once it runs; a stopped one comes back running. A failure leaves the
	 * isolate as it was. Absent: the console doesn't offer it.
	 */
	upgrade?(id: string): Promise<Sandbox>;
	/**
	 * Restarts a sandbox on the latest version of its base image: Kantel saves its disk, stops it and starts it again,
	 * so running processes and memory are lost and its files stay. Absent: the console doesn't offer it.
	 */
	restartOnLatest?(id: string): Promise<Sandbox>;
	/** Deletes the sandbox and every snapshot of it, for good. */
	remove(id: string): Promise<void>;
	access(id: string): Promise<SandboxAccess>;
	/**
	 * SSH without the CLI: lets `publicKey` (one OpenSSH public key) in, or, without one, a key pair Kantel makes and
	 * answers once. Absent: the page offers the CLI's command only.
	 */
	sshKey?(id: string, publicKey?: string): Promise<SandboxSshKey>;
	history(id: string): Promise<readonly SandboxCommand[]>;
	/** One sandbox, for its page. */
	get(id: string): Promise<Sandbox>;
	/** Its environments, with what each loses to a later one, and attaching and detaching them. Absent: none offered. */
	readonly environments?: SandboxEnvironmentsSource;
	/** Minutes until auto-stop stops it, from now; undefined keeps it always on. */
	setAutoStop?(id: string, minutes: number | undefined): Promise<Sandbox>;
	/**
	 * Minutes unused before its idle stop stops it, counting from now; undefined turns it off. Absent: the console
	 * offers no idle stop.
	 */
	setIdleStop?(id: string, minutes: number | undefined): Promise<Sandbox>;
	/** What a running sandbox is using now. Absent: its page shows CPU only. */
	usageNow?(id: string): Promise<SandboxUsageNow>;
	/** Its CPU and memory every few seconds, for the live graphs. Absent: they draw `usage` and don't move. */
	readonly usageSeries?: UsageRead;
	/**
	 * Its metrics over the last hour, day or week, for its metrics dialog: points at an interval that suits the range.
	 * Absent: the dialog draws what the live read has.
	 */
	usageHistory?(id: string, range: UsageRange): Promise<UsageSeries>;
	/**
	 * A running microVM's busiest processes, by CPU, most first; undefined where its host or guest agent is from before
	 * they could be listed. Absent, or undefined: the dialog says its host can't list them yet. An isolate's aren't asked
	 * for.
	 */
	processes?(id: string): Promise<readonly SandboxProcess[] | undefined>;
	/** Gives it a new name; its address (subdomain) stays as it was. Absent: the list offers no rename. */
	rename?(id: string, name: string): Promise<Sandbox>;
	/** Its ports with a URL. Absent where the host can't list them: the page has no Ports. */
	ports?(id: string): Promise<readonly SandboxPort[]>;
	/** Gives a port a URL, or changes whether it's public. A private port's answer has its token in the URL, once. */
	exposePort?(id: string, port: number, isPublic: boolean): Promise<SandboxPort>;
	/** Its URL stops working at once. */
	hidePort?(id: string, port: number): Promise<void>;
	/**
	 * A running sandbox's files, read from its host on demand: one folder's entries at a time (folders first, then files,
	 * by name), and one part of a file at a time. Absent: the Files tab shows its latest snapshot.
	 */
	files?: {
		list(id: string, path: string): Promise<SandboxFolder>;
		read(id: string, path: string, range: FileRange): Promise<FilePart>;
	};
}

/** At most this many environments on one sandbox, as the API allows. */
export const MAX_SANDBOX_ENVIRONMENTS = 10;

/** An environment as a sandbox or its egress names it. */
export interface EnvironmentRef {
	readonly id: string;
	readonly name: string;
}

/** What of one of a sandbox's environments it doesn't take, because a later one (or its own env) sets it instead. */
export interface SandboxEnvironmentShadowed {
	/** Its variables a later environment, or the sandbox's own env, sets instead. */
	readonly variables: readonly string[];
	/** Its secret files' paths a later environment writes instead. */
	readonly files: readonly string[];
	/** Its repositories' paths a later environment clones into instead. */
	readonly repos: readonly string[];
}

/** One of a sandbox's environments, in its place in their order. */
export interface SandboxEnvironment extends EnvironmentRef {
	readonly shadowed: SandboxEnvironmentShadowed;
	/** Its secret files and repositories are set up when the sandbox next starts (it was attached while stopped). */
	readonly pending: boolean;
}

/**
 * A sandbox's environments. An attach puts one last (so it wins) unless `position` says otherwise; attaching one it
 * has moves it. Its variables reach new commands at once, its grants and protected values apply at once, and a running
 * sandbox gets its files and repositories now, a stopped one when it next starts. A detach takes its variables and
 * grants away and stops its protected values resolving at once; files written and repositories cloned stay. Running
 * processes keep the env they started with either way.
 */
export interface SandboxEnvironmentsSource {
	list(sandboxId: string): Promise<readonly SandboxEnvironment[]>;
	attach(sandboxId: string, environmentId: string, position?: number): Promise<readonly SandboxEnvironment[]>;
	detach(sandboxId: string, environmentId: string): Promise<readonly SandboxEnvironment[]>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshots

/** Why a snapshot was taken: on a stop, on the regular save while running, or before a fork. */
export type SnapshotReason = "stop" | "periodic" | "fork";

/** A snapshot in a sandbox's own history, kept for a while then dropped. */
export interface SandboxSnapshot {
	readonly id: string;
	readonly sandboxId: string;
	readonly takenAt: number;
	readonly reason: SnapshotReason;
	readonly sizeBytes: number;
	/** When it is dropped. */
	readonly expiresAt: number;
}

/** A snapshot saved under a name: kept until deleted, and new sandboxes start from it. */
export interface SavedSnapshot {
	readonly id: string;
	readonly name: string;
	readonly accountId: string;
	/** The sandbox it was saved from, if it still exists. */
	readonly sandboxId?: string;
	readonly sandboxName: string;
	readonly kind: SandboxKind;
	/** What it holds, in its saver's words. */
	readonly description?: string;
	/** Its saver's own labels, such as `git.base` for the commit a checkout in it is at. */
	readonly labels?: { readonly [key: string]: string };
	readonly createdAt: number;
	/** Who saved it: unknown for one saved before Kantel kept that. */
	readonly createdBy?: string;
	readonly sizeBytes: number;
	/** Sandboxes started from it. */
	readonly uses: number;
	/**
	 * The base image it was saved on. Sandboxes started from an outdated one start on the old base; a snapshot saved
	 * from a sandbox restarted on the latest refreshes it.
	 */
	readonly base?: SandboxBase;
	/**
	 * Whether it holds its sandbox's memory as well as its disk. A sandbox made from one that does is the machine it was
	 * saved from, whatever New sandbox's sliders say.
	 */
	readonly memory?: boolean;
	/** The vCPUs and memory of the microVM it was saved from, where the source says. */
	readonly machine?: { readonly vcpus: number; readonly memoryMb: number };
}

/** A file or folder in a snapshot. */
export interface SnapshotEntry {
	readonly name: string;
	/** From the snapshot's root, with no leading slash: `home/user/app/package.json`. */
	readonly path: string;
	readonly kind: "file" | "folder";
	readonly sizeBytes?: number;
	readonly modifiedAt?: number;
}

/** Where a part of a file starts, and the most it holds, in bytes. */
export interface FileRange {
	readonly offset: number;
	readonly length: number;
}

/**
 * A part of a file as read: its bytes from the range's offset, and the whole file's size. It may hold more than the
 * range asked for where the file can only be read whole (a snapshot's, up to 1 MiB).
 */
export interface FilePart {
	readonly bytes: Uint8Array;
	readonly size: number;
}

/** A file the source won't read for a preview (a snapshot's over the API's 1 MiB): its name and size, no contents. */
export class FileTooLargeError extends Error {
	override readonly name = "FileTooLargeError";
	constructor(readonly size?: number) {
		super("This file is too big to show here.");
	}
}

/**
 * A folder or file the sandbox won't read: outside what it has (an isolate has only /workspace), or not there. Trying
 * again won't change it, so the browser says so in a line, never as an error to try again.
 */
export class FilesRefusedError extends Error {
	override readonly name = "FilesRefusedError";
}

/** How a running sandbox is saved. */
export interface SaveSnapshotOptions {
	/**
	 * Keep its memory as well as its disk: a sandbox made from it carries on where it was, but only on the same machine.
	 * Absent: the disk alone.
	 */
	readonly memory?: boolean;
}

export interface SnapshotsSource {
	saved(accountId: string): Promise<readonly SavedSnapshot[]>;
	/** Each sandbox's history, newest first. */
	history(sandboxId: string): Promise<readonly SandboxSnapshot[]>;
	save(sandboxId: string, name: string, options?: SaveSnapshotOptions): Promise<SavedSnapshot>;
	removeSaved(id: string): Promise<void>;
	removeSnapshot(id: string): Promise<void>;
	/** A folder in a snapshot, saved or historical: folders first, then files, by name. */
	list(snapshotId: string, path: string): Promise<readonly SnapshotEntry[]>;
	/** A part of a file, read when it's opened. */
	read(snapshotId: string, path: string, range: FileRange): Promise<FilePart>;
	/** A link to download a file or folder (as a tarball), or undefined where there is none: no Download then. */
	downloadUrl(snapshotId: string, path: string): string | undefined;
	/**
	 * The kind of sandbox a snapshot is of, which says where its files start (an isolate's at /workspace), for a link to
	 * its files that doesn't say. Absent: such a link shows the whole of the snapshot from its root.
	 */
	kindOf?(snapshotId: string): Promise<SandboxKind>;
}

// ---------------------------------------------------------------------------------------------------------------------
// API keys

/** What a key may do: the public API's `ApiKeyScope` (the compute API contract, #541). */
export type ApiScope =
	| "sandboxes:read"
	| "sandboxes:write"
	| "sandboxes:delete"
	| "exec"
	| "files"
	| "access"
	| "snapshots:read"
	| "snapshots:write"
	| "account:read"
	| "account:admin"
	| "hosts:admin";

export const API_SCOPES: readonly { readonly scope: ApiScope; readonly label: string; readonly help: string }[] = [
	{ scope: "sandboxes:read", label: "Read sandboxes", help: "List sandboxes and read their state and usage." },
	{ scope: "sandboxes:write", label: "Manage sandboxes", help: "Create, stop, resume and fork sandboxes." },
	{ scope: "sandboxes:delete", label: "Delete sandboxes", help: "Delete sandboxes for good." },
	{ scope: "exec", label: "Run commands", help: "Run commands in sandboxes." },
	{ scope: "files", label: "Files", help: "Read and write files in sandboxes." },
	{ scope: "access", label: "Access", help: "Open ports, SSH, desktops and browsers." },
	{ scope: "snapshots:read", label: "Read snapshots", help: "List snapshots and read their files." },
	{ scope: "snapshots:write", label: "Manage snapshots", help: "Save and delete snapshots." },
	{ scope: "account:read", label: "Read the account", help: "Read members, usage and settings." },
	{
		scope: "account:admin",
		label: "Manage the account",
		help: "Change members, keys, the proxy, webhooks and telemetry.",
	},
	{ scope: "hosts:admin", label: "Manage hosts", help: "Add, drain and remove hosts. Super-admins only." },
];

/** Ready-made sets of scopes: the public API's `API_KEY_PRESETS`. */
export const SCOPE_PRESETS: readonly {
	readonly id: string;
	readonly label: string;
	readonly scopes: readonly ApiScope[];
}[] = [
	{
		id: "agent",
		label: "Agent",
		scopes: [
			"sandboxes:read",
			"sandboxes:write",
			"exec",
			"files",
			"access",
			"snapshots:read",
			"snapshots:write",
			"account:read",
		],
	},
	{
		id: "ci",
		label: "CI",
		scopes: [
			"sandboxes:read",
			"sandboxes:write",
			"sandboxes:delete",
			"exec",
			"files",
			"access",
			"snapshots:read",
			"snapshots:write",
			"account:read",
		],
	},
	{ id: "read-only", label: "Read only", scopes: ["sandboxes:read", "snapshots:read", "account:read"] },
	{
		id: "admin",
		label: "Admin",
		scopes: API_SCOPES.map((entry) => entry.scope).filter((scope) => scope !== "hosts:admin"),
	},
];

export interface ApiKey {
	readonly id: string;
	readonly name: string;
	/** The first characters of the secret, to tell keys apart: `kt_live_4f8a`. */
	readonly prefix: string;
	readonly accountId: string;
	readonly scopes: readonly ApiScope[];
	readonly createdAt: number;
	readonly createdBy: string;
	readonly lastUsedAt?: number;
	readonly expiresAt?: number;
	readonly revokedAt?: number;
}

/** A key just made: its secret is here once, never again. */
export interface CreatedApiKey {
	readonly key: ApiKey;
	readonly secret: string;
}

export interface ApiKeysSource {
	list(accountId: string): Promise<readonly ApiKey[]>;
	create(input: {
		readonly accountId: string;
		readonly name: string;
		readonly scopes: readonly ApiScope[];
		/** Days until it expires; undefined never expires. */
		readonly expiresInDays?: number;
	}): Promise<CreatedApiKey>;
	revoke(id: string): Promise<ApiKey>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Personal access tokens

/** A personal access token (`kpt_…`): it acts as its person, in all their accounts or the ones it names. */
export interface PersonalToken {
	readonly id: string;
	readonly name: string;
	/** `kpt_5n2p`. */
	readonly prefix: string;
	/** At most these, on top of the person's role; undefined: whatever their role allows. */
	readonly scopes?: readonly ApiScope[];
	/** Only these accounts' IDs; undefined: every account of theirs. */
	readonly accounts?: readonly string[];
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly lastUsedAt?: number;
	readonly revokedAt?: number;
}

/** A token just made: its secret is here once, never again. */
export interface CreatedPersonalToken {
	readonly token: PersonalToken;
	readonly secret: string;
}

export interface PersonalTokensSource {
	/** The person's own tokens, revoked ones included. */
	list(): Promise<readonly PersonalToken[]>;
	create(input: {
		readonly name: string;
		readonly scopes?: readonly ApiScope[];
		readonly accounts?: readonly string[];
		readonly expiresInDays: number;
	}): Promise<CreatedPersonalToken>;
	revoke(id: string): Promise<PersonalToken>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Egress proxy

/** What sandboxes may reach: anything, the allowed hosts, or nothing. */
export type EgressPolicy = "open" | "allowlist" | "closed";

/**
 * An account's egress proxy. HTTPS inspection has no setting: the proxy looks inside the HTTPS of the hosts protected
 * variables are bound to and rules name methods or paths for, which swaps and path rules need. Credentials go on a
 * request as protected variables, bound to hosts, not as headers the proxy adds.
 */
export interface ProxySettings {
	readonly accountId: string;
	readonly enabled: boolean;
	readonly policy: EgressPolicy;
	/** Hosts sandboxes may reach with `allowlist`, one per entry: `api.github.com`, `*.npmjs.org`. */
	readonly allow: readonly string[];
	/** Hosts never reachable, whatever the policy. */
	readonly deny: readonly string[];
	/** An upstream proxy every request goes through, such as a credential-injecting gateway. */
	readonly upstream?: { readonly url: string; readonly authSet: boolean };
	/**
	 * Keep a log of every request: host, method, status and bytes. Absent where the log is always kept and has no
	 * switch, as with Kantel's API, which keeps each sandbox's newest requests.
	 */
	readonly logRequests?: boolean;
}

export type ProxySettingsChange = Partial<
	Omit<ProxySettings, "accountId" | "upstream"> & {
		readonly upstream: { readonly url: string; readonly auth?: string } | null;
		/**
		 * The settings as read, which the change was made from. Given, the change is refused with `conflict` if they have
		 * changed since, for the caller to make again on a fresh read. Left out, the change is made on the settings as
		 * they are when it is written.
		 */
		readonly expected: ProxySettings;
	}
>;

/** Whether two reads of an account's proxy settings are the same: for a change's `expected`. */
export const sameProxySettings = (a: ProxySettings, b: ProxySettings): boolean => {
	const key = (settings: ProxySettings) =>
		JSON.stringify([
			settings.accountId,
			settings.enabled,
			settings.policy,
			settings.allow,
			settings.deny,
			settings.upstream === undefined ? null : [settings.upstream.url, settings.upstream.authSet],
			settings.logRequests ?? null,
		]);
	return key(a) === key(b);
};

/** An account's proxy settings. Its log is each sandbox's (`EgressSource`), read together on the Egress page. */
export interface ProxySource {
	get(accountId: string): Promise<ProxySettings>;
	update(accountId: string, change: ProxySettingsChange): Promise<ProxySettings>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Environments

/** The HTTP methods a binding or a grant can name. */
export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Where a protected variable's value may go: a host (`api.github.com`, `*.example.com`), and optionally only paths
 * under these prefixes and only these methods. The host's egress proxy swaps the sandbox's placeholder for the value
 * only on a request that matches.
 */
export interface DestinationBinding {
	readonly host: string;
	/** Empty: any path. */
	readonly pathPrefixes: readonly string[];
	/** Empty: any method. */
	readonly methods: readonly HttpMethod[];
}

/**
 * A variable every sandbox using the environment has. A plain one is its value in the sandbox. A
 * protected one is a `kph_` placeholder in the sandbox, its own per sandbox, that the host's egress proxy swaps for the
 * value on requests to its bindings: the value never enters the sandbox.
 */
export interface EnvironmentVariable {
	readonly name: string;
	readonly protected: boolean;
	/** A plain variable's value. Absent for a protected one: its value is write-only. */
	readonly value?: string;
	/** A protected variable's destinations, at least one. Empty for a plain one. */
	readonly bindings: readonly DestinationBinding[];
	readonly updatedAt: number;
}

/** A file every new sandbox starts with, written to its disk. Its contents are write-only. */
export interface EnvironmentFile {
	/** Absolute: `/home/user/.npmrc`. */
	readonly path: string;
	/** Its permissions, such as `0o600`. */
	readonly mode: number;
	readonly sizeBytes: number;
	readonly updatedAt: number;
}

/** A repository every new sandbox starts with, cloned through the egress proxy. */
export interface EnvironmentRepo {
	/** `https://github.com/lleverage-ai/kantel`. */
	readonly url: string;
	/** Where it's cloned; default `~/<name>`. */
	readonly path?: string;
	/** A branch, tag or commit; default the repository's default branch. */
	readonly ref?: string;
}

/**
 * An egress rule: let a sandbox reach a host, or refuse it, with no one asked. Deny wins. A rule that names methods
 * or paths makes the proxy look inside that host's HTTPS, as it does for a protected variable's host.
 */
export interface EgressGrant {
	readonly id: string;
	readonly action: "allow" | "deny";
	readonly host: string;
	/** Empty: every method. */
	readonly methods: readonly HttpMethod[];
	/** Path patterns (`/repos/lleverage-ai/*`). Empty: every path. */
	readonly paths: readonly string[];
}

/** What a sandbox starts with: variables, secret files and repositories, and its egress grants. */
export interface Environment {
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly description?: string;
	readonly variables: readonly EnvironmentVariable[];
	readonly files: readonly EnvironmentFile[];
	readonly repos: readonly EnvironmentRepo[];
	readonly grants: readonly EgressGrant[];
	/** How many sandboxes use it now. */
	readonly sandboxCount: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Add or change a variable. */
export interface VariableInput {
	readonly name: string;
	readonly protected: boolean;
	/** The value. Absent on an edit of a protected variable: it keeps its value (a rotation sends one). */
	readonly value?: string;
	readonly bindings: readonly DestinationBinding[];
}

/** Add or replace a secret file. */
export interface FileInput {
	readonly path: string;
	readonly mode: number;
	/** Absent on an edit: the file keeps its contents. */
	readonly content?: string;
}

export interface EnvironmentsSource {
	/**
	 * `false`: the deployment keeps no protected variables or secret files (it has no secrets key), so the pages say so and
	 * offer neither. Absent or `true`: they are offered.
	 */
	readonly protectedValues?: boolean;
	list(accountId: string): Promise<readonly Environment[]>;
	get(id: string): Promise<Environment>;
	create(input: { accountId: string; name: string; description?: string }): Promise<Environment>;
	update(id: string, change: { name?: string; description?: string }): Promise<Environment>;
	/**
	 * Deletes it, and takes it off every sandbox that uses it: they keep the files and repositories it gave them, and its
	 * protected variables stop resolving.
	 */
	remove(id: string): Promise<void>;
	/** Adds or changes a variable by name. A new value for a protected one reaches its running sandboxes at once. */
	setVariable(id: string, input: VariableInput): Promise<Environment>;
	removeVariable(id: string, name: string): Promise<Environment>;
	setFile(id: string, input: FileInput): Promise<Environment>;
	removeFile(id: string, path: string): Promise<Environment>;
	setRepos(id: string, repos: readonly EnvironmentRepo[]): Promise<Environment>;
	/** Replaces its grants. With `expected`, refused with `conflict` if they are no longer those. */
	setGrants(id: string, grants: readonly EgressGrant[], expected?: readonly EgressGrant[]): Promise<Environment>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Templates (experimental)

/**
 * What a template's machines boot: Kantel's base image, customised by the setup script; a Dockerfile (no build context,
 * `FROM $KANTEL_BASE` for the base); or an image reference. A Dockerfile or reference is built or pulled in an isolated
 * build microVM whose only way out is the template's egress grants, and only on hosts that build custom images.
 */
export type TemplateImage =
	| { readonly kind: "kantel-base" }
	| { readonly kind: "dockerfile"; readonly dockerfile: string }
	| { readonly kind: "image"; readonly ref: string };

/**
 * The Kantel base image it boots, as the deployment publishes it: a channel it follows (rebuilt when it publishes), or
 * an exact digest, one of that image's channels published, it is pinned to.
 */
export type TemplateBase =
	| { readonly image: string; readonly channel: string; readonly digest?: undefined }
	| { readonly image: string; readonly digest: string; readonly channel?: undefined };

/** One digest a base channel published. */
export interface TemplateBaseRelease {
	readonly digest: string;
	readonly publishedAt: number;
}

/** A base image's channel, as the deployment's super-admin published it, and the digests it has published. */
export interface TemplateBaseChannel {
	/** Such as `kantel/sandbox`. */
	readonly image: string;
	/** Such as `stable`. */
	readonly channel: string;
	/** The digest it publishes now. */
	readonly digest: string;
	readonly publishedAt: number;
	/** Every digest it has published, newest first. */
	readonly history: readonly TemplateBaseRelease[];
}

/** A template version's definition. Never changed once made: a new one is the next version. */
export interface TemplateSpec {
	readonly image: TemplateImage;
	readonly base: TemplateBase;
	readonly vcpus: number;
	readonly memoryMb: number;
	/** Plain variables, not secrets. */
	readonly env: Readonly<Record<string, string>>;
	/** A shell script run once as root when the snapshot is built, or at a fresh boot. */
	readonly setup?: string;
	/** Egress grants for its sandboxes and its build. */
	readonly grants: readonly EgressGrant[];
}

/**
 * A built template's state. `stale`: built for a key no longer wanted (an older version, base, kernel or Firecracker),
 * still used until its replacement is ready. `discarded`: thrown away.
 */
export type TemplateSnapshotState = "queued" | "building" | "ready" | "stale" | "failed" | "discarded";

/** One entry in a template's snapshot cache: its image booted once, its setup run, then snapshotted. */
export interface TemplateSnapshot {
	readonly id: string;
	readonly version: number;
	readonly state: TemplateSnapshotState;
	/** What it is for: a change to any part builds another. */
	readonly key: {
		readonly templateVersion: string;
		readonly baseDigest: string;
		/** A custom image's source: `dockerfile:sha256:…` or `image:<ref>`. */
		readonly source?: string;
		/** A custom image's digest, once its build made or resolved it. */
		readonly imageDigest?: string;
		readonly kernel: string;
		readonly firecracker: string;
		readonly vcpus: number;
	};
	readonly keyHash: string;
	/** The host that built it and holds it. */
	readonly hostId?: string;
	readonly builtFrom: {
		readonly baseImage: string;
		readonly channel?: string;
		readonly baseDigest: string;
		readonly pinned: boolean;
		readonly imageDigest?: string;
		/** The image's kind it was built from; absent, `kantel-base`. */
		readonly source?: "kantel-base" | "dockerfile" | "image";
		readonly dockerfileDigest?: string;
		readonly imageRef?: string;
	};
	readonly startedAt: number;
	readonly readyAt?: number;
	readonly error?: string;
	readonly sizeBytes?: number;
}

/** A template's build: its newest usable snapshot, and the build under way. */
export interface TemplateBuild {
	/**
	 * `none`: nothing built yet, sandboxes boot fresh. `stale`: what is built is for an older key, used until rebuilt if
	 * it's of the template's current version (`startingSnapshot`).
	 */
	readonly state: "none" | "building" | "ready" | "stale" | "failed";
	/** The newest ready (or stale) snapshot, of any version: new sandboxes start from it only per `startingSnapshot`. */
	readonly ready?: TemplateSnapshot;
	readonly building?: TemplateSnapshot;
	readonly error?: string;
	/** How far a pinned base is behind its channel. */
	readonly behind?: { readonly releases: number; readonly since: number; readonly latestDigest: string };
}

/** A microVM profile: image, base, resources, variables, setup and egress, versioned. */
export interface Template {
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly description?: string;
	readonly version: number;
	readonly spec: TemplateSpec;
	readonly build: TemplateBuild;
	readonly sandboxCount: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/**
 * Whether a template's new sandboxes, at its own vCPUs and memory, may start from a cache entry: a ready one, or a stale
 * one still used until its replacement is ready, of the template's current version. Kantel restores no other, so one
 * of an older version stays in the cache but starts nothing.
 */
export function startsNewSandboxes(template: Pick<Template, "version">, entry: TemplateSnapshot): boolean {
	return (entry.state === "ready" || entry.state === "stale") && entry.version === template.version;
}

/**
 * The snapshot a template's new sandboxes start from: its build's ready (or stale) one when `startsNewSandboxes`, else
 * none, and they boot the image fresh and run its setup.
 */
export function startingSnapshot(template: Pick<Template, "version" | "build">): TemplateSnapshot | undefined {
	const ready = template.build.ready;
	return ready !== undefined && startsNewSandboxes(template, ready) ? ready : undefined;
}

export interface TemplateVersion {
	readonly version: number;
	readonly spec: TemplateSpec;
	readonly createdAt: number;
	/** Who made it: a person's name, or an API key's. */
	readonly by?: string;
}

/** A change to a template: only what's given changes. An empty description clears it. */
export interface TemplateChange {
	readonly name?: string;
	readonly description?: string;
	readonly spec?: TemplateSpec;
}

export interface TemplatesSource {
	list(accountId: string): Promise<readonly Template[]>;
	get(id: string): Promise<Template>;
	create(input: { accountId: string; name: string; description?: string; spec: TemplateSpec }): Promise<Template>;
	/** A `spec` that differs from the current one makes the next version, which builds in the background. */
	update(id: string, change: TemplateChange): Promise<Template>;
	/** Deletes it, its versions and its built snapshots. Sandboxes made from it keep running. */
	remove(id: string): Promise<void>;
	/** Newest first. */
	versions(id: string): Promise<readonly TemplateVersion[]>;
	/** Its snapshot cache, newest first. */
	snapshots(id: string): Promise<readonly TemplateSnapshot[]>;
	/** The base images' channels templates may follow or pin a digest from. */
	bases(): Promise<readonly TemplateBaseChannel[]>;
	/**
	 * Builds its snapshot again. A ready one of its current version goes on serving, stale, until the rebuild's is ready,
	 * and after a rebuild that failed; with none, sandboxes boot fresh until it's ready.
	 */
	rebuild(id: string): Promise<Template>;
}

// ---------------------------------------------------------------------------------------------------------------------
// A sandbox's egress

/** One request or connection a sandbox made through its host's egress proxy. Never a credential's value. */
export interface EgressEntry {
	readonly id: string;
	readonly at: number;
	/** `CONNECT` for a tunnel the proxy didn't look inside. */
	readonly method: string;
	readonly host: string;
	readonly port: number;
	/** The path, when the proxy saw it (plain HTTP, or HTTPS it inspected); never the query. */
	readonly path?: string;
	readonly decision: "allowed" | "denied";
	/** Why it was denied, or what failed, in words. */
	readonly reason?: string;
	/** The rule that decided it, such as `deny *.example-tracker.io`. */
	readonly rule?: string;
	/** A refusal's code, such as `placeholder-unbound`: a protected variable's placeholder sent to another host. */
	readonly code?: string;
	/** The protected variables whose values the proxy put in, by name. Empty: none. */
	readonly swapped: readonly string[];
	/** Whether the proxy looked inside the HTTPS (a protected variable's host or a method or path grant). */
	readonly inspected: boolean;
	/** The answer's status, when the proxy saw one. */
	readonly status?: number;
	readonly bytesUp: number;
	readonly bytesDown: number;
}

/** A protected variable as one sandbox has it: the placeholder it sees, never the value. */
export interface SandboxProtectedVariable {
	readonly name: string;
	/** The first characters of its placeholder, `kph_7Qx2`, to tell it apart in a log or a command's output. */
	readonly placeholderPrefix: string;
	readonly bindings: readonly DestinationBinding[];
	/** The environment whose value it takes: the last of the sandbox's that has it. */
	readonly environmentId?: string;
}

/** A sandbox's egress: what it was made with, its own grants and its log. */
export interface SandboxEgress {
	readonly sandboxId: string;
	readonly sandboxName: string;
	/** The account the sandbox is in. */
	readonly accountId: string;
	/** Its environments, in order. */
	readonly environments: readonly EnvironmentRef[];
	readonly protectedVariables: readonly SandboxProtectedVariable[];
	/** Its environments' grants, which this sandbox has too: they add up. */
	readonly environmentGrants: readonly EgressGrant[];
	/** This sandbox's own grants, on top of its environments'. */
	readonly grants: readonly EgressGrant[];
	/** Newest first. */
	readonly entries: readonly EgressEntry[];
}

export interface EgressSource {
	get(sandboxId: string): Promise<SandboxEgress>;
	/** Replaces the sandbox's own grants; they apply to its next request. With `expected`, as for an environment's. */
	setGrants(
		sandboxId: string,
		grants: readonly EgressGrant[],
		expected?: readonly EgressGrant[],
	): Promise<SandboxEgress>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Webhooks and OpenTelemetry

/** The public API's `EventType` (#541). */
export type WebhookEvent =
	| "sandbox.created"
	| "sandbox.running"
	| "sandbox.stopped"
	| "sandbox.paused"
	| "sandbox.error"
	| "sandbox.degraded"
	| "sandbox.recovered"
	| "sandbox.environments_changed"
	| "sandbox.oom_kill"
	| "sandbox.upgraded"
	| "sandbox.deleted"
	| "snapshot.saved"
	| "snapshot.deleted";

export const WEBHOOK_EVENTS: readonly { readonly event: WebhookEvent; readonly label: string }[] = [
	{ event: "sandbox.created", label: "A sandbox was created" },
	{ event: "sandbox.running", label: "A sandbox is running" },
	{ event: "sandbox.stopped", label: "A sandbox stopped" },
	{ event: "sandbox.paused", label: "A sandbox paused" },
	{ event: "sandbox.error", label: "A sandbox failed" },
	{ event: "sandbox.degraded", label: "A sandbox is degraded" },
	{ event: "sandbox.recovered", label: "A sandbox recovered" },
	{ event: "sandbox.environments_changed", label: "A sandbox's environments changed" },
	{ event: "sandbox.oom_kill", label: "A sandbox ran out of memory" },
	{ event: "sandbox.upgraded", label: "An isolate was upgraded to a microVM" },
	{ event: "sandbox.deleted", label: "A sandbox was deleted" },
	{ event: "snapshot.saved", label: "A snapshot was saved" },
	{ event: "snapshot.deleted", label: "A snapshot was deleted" },
];

export interface WebhookDelivery {
	readonly id: string;
	readonly event: WebhookEvent;
	readonly at: number;
	/** The endpoint's HTTP status; absent when it couldn't be reached. */
	readonly status?: number;
	readonly durationMs: number;
	readonly attempt: number;
	readonly ok: boolean;
}

export interface Webhook {
	readonly id: string;
	readonly accountId: string;
	readonly url: string;
	readonly description?: string;
	readonly events: readonly WebhookEvent[];
	readonly enabled: boolean;
	readonly createdAt: number;
	/** The start of the signing secret: `whsec_9c1e`. */
	readonly secretPrefix: string;
	readonly lastDelivery?: WebhookDelivery;
}

export interface CreatedWebhook {
	readonly webhook: Webhook;
	/** The signing secret, shown once. */
	readonly secret: string;
}

export interface WebhooksSource {
	list(accountId: string): Promise<readonly Webhook[]>;
	create(input: {
		readonly accountId: string;
		readonly url: string;
		readonly description?: string;
		readonly events: readonly WebhookEvent[];
	}): Promise<CreatedWebhook>;
	update(id: string, change: Partial<Pick<Webhook, "url" | "description" | "events" | "enabled">>): Promise<Webhook>;
	remove(id: string): Promise<void>;
	deliveries(id: string): Promise<readonly WebhookDelivery[]>;
	/** Sends a test event now. */
	test(id: string): Promise<WebhookDelivery>;
}

export type TelemetryProtocol = "http/protobuf" | "grpc";

export interface TelemetrySettings {
	readonly accountId: string;
	readonly enabled: boolean;
	/** The OTLP endpoint: `https://otlp-gateway-prod-eu-west-2.grafana.net/otlp`. */
	readonly endpoint: string;
	readonly protocol: TelemetryProtocol;
	/** Header names whose values are set (an API key's); the values never come back. */
	readonly headers: readonly string[];
	readonly metrics: boolean;
	readonly events: boolean;
	/** Extra resource attributes on everything sent: `deployment.environment=prod`. */
	readonly attributes: Readonly<Record<string, string>>;
	readonly lastExport?: { readonly at: number; readonly ok: boolean; readonly message?: string };
}

export type TelemetryChange = Partial<Omit<TelemetrySettings, "accountId" | "headers" | "lastExport">> & {
	/** Header values to set, by name; `null` removes one. */
	readonly headers?: Readonly<Record<string, string | null>>;
};

export interface TelemetrySource {
	/** The protocols this Kantel exports over; both when left out. With one, the page offers no choice. */
	readonly protocols?: readonly TelemetryProtocol[];
	/** False where exports can't carry extra resource attributes: the page leaves that section out. */
	readonly attributes?: boolean;
	get(accountId: string): Promise<TelemetrySettings>;
	update(accountId: string, change: TelemetryChange): Promise<TelemetrySettings>;
	/** Sends one test metric and event, and says how it went. */
	test(accountId: string): Promise<{ readonly ok: boolean; readonly message: string }>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hosts (super-admin)

export type HostState = "online" | "draining" | "offline" | "joining";

export interface Host {
	readonly id: string;
	readonly name: string;
	readonly state: HostState;
	readonly arch: "x86_64" | "aarch64";
	readonly os: string;
	/** The host agent's version. */
	readonly version: string;
	/** The version it should be on, when it runs an older one: it's out of date. */
	readonly updateAvailable?: string;
	/** An update asked for that it hasn't come back on yet: the version, and when it was asked for. */
	readonly updating?: { readonly version: string; readonly since: number };
	readonly vcpus: number;
	readonly memoryGb: number;
	readonly diskGb: number;
	/** What's in use now. */
	readonly used: { readonly vcpus: number; readonly memoryGb: number; readonly diskGb: number };
	readonly sandboxes: { readonly isolates: number; readonly microvms: number };
	/** Can run microVMs: /dev/kvm is there. */
	readonly kvm: boolean;
	/** MicroVMs on it get /dev/kvm of their own. */
	readonly nestedVirtualisation: boolean;
	readonly labels: Readonly<Record<string, string>>;
	readonly lastSeenAt: number;
	readonly joinedAt: number;
	/** What takes the space on its disk, as it last measured it. Absent until it has. */
	readonly disk?: HostDisk;
	/** Its memory, as it last reported it. Absent from an older host agent, or one not connected. */
	readonly memory?: HostMemory;
	/** The most bytes of saved snapshots each account may keep on it. Absent: no limit. */
	readonly savedSnapshotLimitBytes?: number;
	/** The pool it is in (`Pool`). Absent from a host the control plane hasn't put in one yet: its owner's default. */
	readonly poolId?: string;
	/**
	 * The account whose own host it is, which runs only that account's sandboxes and is in that account's pools. Absent
	 * from a deployment's shared host.
	 */
	readonly accountId?: string;
}

/**
 * A set of an account's hosts (or of the deployment's shared hosts), each host in exactly one. Every account starts
 * with one named `default`. New hosts join the default pool unless their join names another.
 */
export interface Pool {
	readonly id: string;
	/** Lower-case letters, digits and dashes, unique among its owner's pools. */
	readonly name: string;
	/** Its owner's default pool: where a host joins, and a sandbox goes, naming no pool. */
	readonly default: boolean;
	/** How many hosts are in it. */
	readonly hosts: number;
	readonly createdAt: number;
}

/** A pool's name as the API takes it: lower-case letters, digits and dashes, starting and ending with a letter or digit. */
export const POOL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Reads and changes the pools hosts are in. */
export interface PoolsSource {
	/** Every pool, the default among them. */
	list(): Promise<readonly Pool[]>;
	/** An empty pool; refused when the name is taken. */
	create(name: string): Promise<Pool>;
	rename(id: string, name: string): Promise<Pool>;
	/** Makes it the default, in place of the one that was. */
	makeDefault(id: string): Promise<Pool>;
	/** Only an empty pool that isn't the default: refused otherwise, with the reason. */
	remove(id: string): Promise<void>;
}

/**
 * A host's memory, in MiB. `reserved`: what its sandboxes were given; `committed`: what its microVMs count for when it
 * admits by use (each its recent peak plus headroom); `guestUsed`: what their guests use; `resident`: what they hold of
 * the machine, page cache included. `mode` says which it admits by, `state` how short of memory it is.
 */
export interface HostMemory {
	readonly mode: "reserved" | "used";
	readonly state: "ok" | "tight" | "refusing" | "critical";
	readonly totalMiB: number;
	readonly reserveMiB: number;
	readonly capacityMiB: number;
	readonly reservedMiB: number;
	readonly committedMiB: number;
	readonly guestUsedMiB: number;
	readonly residentMiB: number;
	readonly availableMiB: number;
	readonly swapUsedMiB: number;
	readonly pressureSome: number;
	readonly pressureFull: number;
	readonly maxRatio: number;
}

/**
 * What takes the space on a host's disk, in bytes, each file counted once: memory a stop's snapshot shares with its
 * sandbox counts for the sandbox. `other` is the rest of what's used: the operating system, logs, other programs.
 */
export interface HostDisk {
	readonly totalBytes: number;
	readonly usedBytes: number;
	readonly savedSnapshots: number;
	readonly automaticSnapshots: number;
	readonly sandboxes: number;
	readonly images: number;
	readonly templates: number;
	readonly bundles: number;
	readonly other: number;
	readonly measuredAt: number;
}

/** A one-time join token, with the command that uses it. */
export interface HostJoin {
	readonly token: string;
	readonly expiresAt: number;
	/** The one-line command to run on the new host. */
	readonly command: string;
}

/** Where hosts reach the control plane: the address in every join command. */
export interface PublicUrl {
	readonly publicUrl: string;
	/** A super-admin set it in the console, ahead of the deployment's own. */
	readonly setHere: boolean;
	/** The deployment's own, which clearing the console's goes back to. */
	readonly deploymentUrl: string;
	/** Only a host on the same machine can reach it: `127.0.0.1`, `localhost`. */
	readonly loopback: boolean;
}

/** Reads and sets where hosts reach the control plane: a super-admin's. */
export interface PublicUrlSource {
	get(): Promise<PublicUrl>;
	/** An http(s) origin, or null for the deployment's own. */
	set(url: string | null): Promise<PublicUrl>;
}

export interface HostsSource {
	list(): Promise<readonly Host[]>;
	/** A host's CPU, memory and disk every few seconds, for the live graphs. Absent: a row shows what's allocated. */
	readonly usage?: UsageRead;
	/** Where hosts reach the control plane, when this person may change it: the deployment's hosts, a super-admin's. */
	readonly publicUrl?: PublicUrlSource;
	/** A join token for a new host, and the command with it in. */
	join(input: {
		readonly name?: string;
		readonly labels?: Readonly<Record<string, string>>;
		/** The pool's ID. Absent: the default pool. */
		readonly pool?: string;
	}): Promise<HostJoin>;
	/** Stops new sandboxes landing on it; running ones keep running. */
	drain(id: string): Promise<Host>;
	undrain(id: string): Promise<Host>;
	/** Revokes its credential: it's cut off at once, and its sandboxes can't be reached until it joins again. */
	remove(id: string): Promise<void>;
	/**
	 * Updates its host agent to `updateAvailable`: it fetches the release, checks it and restarts, its sandboxes running
	 * on. Answers the host with `updating` set. Absent: hosts aren't updated from the console.
	 */
	update?(id: string): Promise<Host>;
	/**
	 * Reads Kantel's latest kantel-host release again now, rather than within the hour, so hosts behind a release just
	 * published show Update at once: the deployment's hosts, a super-admin's. Answers the latest version it knows.
	 * Absent: no Check for updates.
	 */
	checkForUpdates?(): Promise<{ readonly checked: boolean; readonly latestVersion?: string }>;
	/**
	 * Sets the most bytes of saved snapshots each account may keep on the host, or `null` for no limit: a save past it is
	 * refused. Absent: the limit isn't set from the console.
	 */
	setSnapshotLimit?(id: string, bytes: number | null): Promise<Host>;
	/** The pools the hosts are in. Absent: the page lists the hosts without them. */
	readonly pools?: PoolsSource;
	/**
	 * Moves a host to another pool. Only a draining host with no sandboxes moves; any other is refused with the reason.
	 * It stays draining: undrain it once it should take sandboxes. Absent: hosts aren't moved from the console.
	 */
	move?(id: string, poolId: string): Promise<Host>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Device sign-ins (`kantel login` in a browser)

export type DeviceLoginState = "pending" | "approved" | "denied" | "expired";

/** A command line waiting for a person to approve the code it showed. */
export interface DeviceLogin {
	/** `BCDF-GHJK`. */
	readonly userCode: string;
	/** What is signing in, as it named itself: `kantel on build-01`. */
	readonly clientName: string;
	/** It asks for a personal access token, which acts as you in your accounts, not an API key in one. */
	readonly personal?: boolean;
	readonly state: DeviceLoginState;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface DeviceLoginsSource {
	/** The sign-in with this code; rejects when no sign-in has it. */
	get(userCode: string): Promise<DeviceLogin>;
	/**
	 * Makes the device a key in the account, or for a personal sign-in a personal token (in `accounts` only, when given),
	 * which its next poll collects.
	 */
	approve(
		userCode: string,
		input: {
			readonly accountId: string;
			/** The sign-in asked for a personal token, and the page showed the person what it gets. */
			readonly personal?: boolean;
			readonly accounts?: readonly string[];
		},
	): Promise<DeviceLogin>;
	deny(userCode: string): Promise<DeviceLogin>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Plans and usage (hosted)

export interface Plan {
	readonly id: string;
	readonly name: string;
	/** US cents a month. */
	readonly priceCents: number;
	readonly concurrent: number;
	readonly startsPerMinute: number;
	/** Sandbox time the price includes, in US cents at the sizes' rates. */
	readonly includedCents: number;
	readonly savedSnapshots: number;
	readonly sizes: readonly SandboxSize[];
}

export interface BillingSummary {
	readonly accountId: string;
	readonly plan: Plan;
	readonly periodStart: number;
	readonly periodEnd: number;
	/** Sandbox time used this period, in US cents. */
	readonly usedCents: number;
	readonly running: number;
	readonly savedSnapshots: number;
	/** Daily spend this period, oldest first, in US cents. */
	readonly daily: readonly number[];
}

export interface BillingSource {
	plans(): Promise<readonly Plan[]>;
	summary(accountId: string): Promise<BillingSummary>;
	/** A demo: changes the plan without taking a payment. */
	changePlan(accountId: string, planId: string): Promise<BillingSummary>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Everything

export interface ComputeSource {
	readonly hosting: HostingMode;
	/** The domain sandbox addresses are under: `kantel.example.com`. */
	readonly domain: string;
	readonly accounts: AccountsSource;
	readonly sandboxes: SandboxesSource;
	readonly snapshots: SnapshotsSource;
	readonly keys: ApiKeysSource;
	/** The person's own personal access tokens; absent when signed in with a key, or on a gateway without them. */
	readonly personalTokens?: PersonalTokensSource;
	readonly proxy: ProxySource;
	readonly environments: EnvironmentsSource;
	/** Templates: only where the deployment has turned them on (experimental, `KANTEL_TEMPLATES`). */
	readonly templates?: TemplatesSource;
	readonly egress: EgressSource;
	readonly webhooks: WebhooksSource;
	readonly telemetry: TelemetrySource;
	/** The deployment's hosts: only for a super-admin. */
	readonly hosts?: HostsSource;
	/** The deployment's base images, their scans, and its templates: only for a super-admin. */
	readonly images?: BaseImagesSource;
	/**
	 * An account's own hosts, which run only its sandboxes: for everyone else, where the deployment lets accounts add
	 * machines of their own (experimental). Absent, it doesn't.
	 */
	readonly ownHosts?: (accountId: string) => HostsSource;
	/** Read-only mounts' bundles and bucket sources (experimental). Absent, the deployment hasn't turned mounts on. */
	readonly mounts?: MountsSource;
	/** Only when hosted. */
	readonly billing?: BillingSource;
	/** Approving a command line's sign-in, at `/device`. Absent where nothing can sign in that way. */
	readonly devices?: DeviceLoginsSource;
}

// ---------------------------------------------------------------------------------------------------------------------
// Words

export const SANDBOX_STATE_LABELS: Readonly<Record<SandboxState, string>> = {
	starting: "Starting",
	running: "Running",
	paused: "Paused",
	stopping: "Stopping",
	stopped: "Stopped",
	error: "Error",
};

/**
 * A sandbox's environments' names in their order, for a line of text: "backend-dev", "backend-dev and evals",
 * "a, b and c". Undefined for none.
 */
export function environmentNamesText(environments: readonly EnvironmentRef[] | undefined): string | undefined {
	const names = (environments ?? []).map((env) => env.name);
	if (names.length === 0) return undefined;
	if (names.length === 1) return names[0];
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What a running sandbox whose guest agent doesn't answer shows for its state, in the error colour. */
export const UNRESPONSIVE_LABEL = "Unresponsive";

/** What a sandbox whose host isn't connected shows for its state, in the warning colour: its real state is unknown. */
export const HOST_UNREACHABLE_LABEL = "Host unreachable";
export const HOST_UNREACHABLE_STATUS: Status = "approval";
/**
 * How often a page reads again while a sandbox it shows runs, or has its host away: the live feed says when a host goes
 * or comes back, and this is the backstop for when it can't (the gateway that held the host's connection went with it,
 * or a gateway read the sandbox before it had seen the change), so a wrong `hostUnreachable` lasts 15 seconds at most.
 */
export const HOST_CHECK_POLL_MS = 15_000;

/**
 * How long a page showing `sandboxes` waits before it reads them again: `movingMs` while any is between states, else
 * `HOST_CHECK_POLL_MS` while any runs or has its host away (not for a page frozen at one time, `frozen`, a story's),
 * else never: the live feed says what changes.
 */
export function sandboxesPollMs(
	sandboxes: readonly Pick<Sandbox, "state" | "hostUnreachable">[],
	movingMs: number,
	frozen = false,
): number | undefined {
	if (sandboxes.some((box) => sandboxMoving(box.state))) return movingMs;
	if (frozen) return undefined;
	return sandboxes.some((box) => box.state === "running" || box.hostUnreachable === true)
		? HOST_CHECK_POLL_MS
		: undefined;
}

/** What the sandbox's page says of a sandbox whose host isn't connected. */
export const HOST_UNREACHABLE_NOTICE =
	"Its host isn't connected to Kantel, so the sandbox can't be reached and its real state can't be confirmed. " +
	"It shows what it was last known to be until the host reconnects.";

/**
 * Whether a sandbox shows "Host unreachable" in place of its state: one with a machine that may be up (starting,
 * running, stopping, paused) whose host isn't connected. A stopped one, or one in error, keeps its state, which nothing
 * on the host can change.
 */
export const showsHostUnreachable = (sandbox: Pick<Sandbox, "state" | "hostUnreachable">): boolean =>
	sandbox.hostUnreachable === true && sandbox.state !== "stopped" && sandbox.state !== "error";

/** The status colour each state shows in. */
export const SANDBOX_STATE_STATUS: Readonly<Record<SandboxState, Status>> = {
	starting: "working",
	running: "done",
	paused: "waiting",
	stopping: "working",
	stopped: "idle",
	error: "error",
};

/**
 * Every state but an error keeps its words quiet beside the coloured dot (a change under way has the dot's pulse), so
 * colour in words means one thing: something failed.
 */
export const quietState = (state: SandboxState): boolean => state !== "error";

export const SANDBOX_KIND_LABELS: Readonly<Record<SandboxKind, string>> = {
	isolate: "Isolate",
	microvm: "MicroVM",
};

export const sizeSpec = (size: SandboxSize): SandboxSizeSpec =>
	SANDBOX_SIZES.find((spec) => spec.size === size) ?? (SANDBOX_SIZES[1] as SandboxSizeSpec);

/** A sandbox's machine as the page shows it. No `diskGb`: its host hasn't said yet (a disk is the host's to give). */
export interface SandboxSpecFigures {
	readonly vcpus: number;
	readonly memoryGb: number;
	readonly diskGb?: number;
}

/**
 * What a sandbox was given: what its host said, else the shape it asked for (no disk yet). An isolate made before shapes
 * says nothing, so it counts as the default isolate (shared CPU, 256 MB, no disk), as Kantel bills it. Undefined for a
 * microVM that says neither, such as one made by a named size that hasn't started yet: never `SANDBOX_SIZES`' sample
 * figures, which are no host's, so the page shows its size as unknown until its host says.
 */
export const sandboxSpec = (sandbox: Pick<Sandbox, "kind" | "shape" | "resources">): SandboxSpecFigures | undefined => {
	if (sandbox.resources !== undefined) return sandbox.resources;
	if (sandbox.kind === "isolate") {
		return sandbox.shape === undefined
			? { vcpus: 0, memoryGb: ISOLATE_MEMORY.default / 1024, diskGb: 0 }
			: { vcpus: 0, memoryGb: sandbox.shape.memoryGb, diskGb: 0 };
	}
	return sandbox.shape === undefined ? undefined : { vcpus: sandbox.shape.vcpus, memoryGb: sandbox.shape.memoryGb };
};

/**
 * "4 vCPU, 8 GB" ("Shared CPU, 256 MB" for an isolate): a size, or what a sandbox was given, in a line. "–" where it isn't
 * known yet (`sandboxSpec` undefined).
 */
export const sizeText = (
	size: SandboxSize | { readonly vcpus: number; readonly memoryGb: number } | undefined,
): string => {
	if (size === undefined) return "–";
	const spec = typeof size === "string" ? sizeSpec(size) : size;
	const memory = memoryText(Math.round(spec.memoryGb * 1024));
	return spec.vcpus === 0 ? `Shared CPU, ${memory}` : `${spec.vcpus} vCPU, ${memory}`;
};

/** "MicroVM, 4 vCPU, 16 GB": a sandbox's type and machine, as its row in the list says them ("MicroVM, –" until known). */
export const sandboxMachineText = (sandbox: Pick<Sandbox, "kind" | "shape" | "resources">): string =>
	`${SANDBOX_KIND_LABELS[sandbox.kind]}, ${sizeText(sandboxSpec(sandbox))}`;

/** A sandbox is between states, so the page reads it again soon. */
export const sandboxMoving = (state: SandboxState): boolean => state === "starting" || state === "stopping";

/** "52m", "6h 10m", "Always on", or a dash when it isn't running. */
export function stopsInText(sandbox: Pick<Sandbox, "state" | "stopsAt">, now: number): string {
	if (sandbox.state !== "running" && sandbox.state !== "starting") return "–";
	if (sandbox.stopsAt === undefined) return "Always on";
	const left = sandbox.stopsAt - now;
	if (left <= 0) return "Now";
	// Whole minutes: a countdown in seconds would change the row every second.
	return duration(Math.ceil(left / MINUTE) * MINUTE);
}

/**
 * Its idle stop, for its page: "Idle stop in 28m" while it runs, "Idle stop now" once due; undefined without one or
 * when it isn't running.
 */
export function idleStopText(
	sandbox: Pick<Sandbox, "state" | "idleStopMinutes" | "idleStopsAt">,
	now: number,
): string | undefined {
	if (sandbox.idleStopMinutes === undefined || sandbox.state !== "running") return undefined;
	if (sandbox.idleStopsAt === undefined) return `Idle stop after ${duration(sandbox.idleStopMinutes * MINUTE)}`;
	const left = sandbox.idleStopsAt - now;
	if (left <= 0) return "Idle stop now";
	return `Idle stop in ${duration(Math.ceil(left / MINUTE) * MINUTE)}`;
}

/** Why a stopped or paused sandbox stopped, in words, where Kantel stopped it: "Stopped by its idle stop". */
export function stoppedByText(sandbox: Pick<Sandbox, "state" | "stopReason" | "idleStopMinutes">): string | undefined {
	if ((sandbox.state !== "stopped" && sandbox.state !== "paused") || sandbox.stopReason === undefined) return undefined;
	const verb = sandbox.state === "paused" ? "Paused" : "Stopped";
	if (sandbox.stopReason === "idle-stop") {
		return sandbox.idleStopMinutes === undefined
			? `${verb} by its idle stop`
			: `${verb} after ${duration(sandbox.idleStopMinutes * MINUTE)} unused`;
	}
	if (sandbox.stopReason === "auto-stop") return `${verb} by its auto-stop`;
	return `${verb}: ${sandbox.stopReason}`;
}

/** "$0.42", "$12.08", "<$0.01" for a cost above zero that rounds to nothing. */
export function costText(cents: number): string {
	if (cents > 0 && cents < 1) return "<$0.01";
	return `$${(cents / 100).toFixed(2)}`;
}

/** "$20", "$100": a plan's price, with no pence. */
export const priceText = (cents: number): string => (cents % 100 === 0 ? `$${cents / 100}` : costText(cents));

export { bytesText } from "../primitives/format.ts";

/** "Expires in 3 days", "Expires in 5h", "Expired". */
export function expiresText(expiresAt: number, now: number): string {
	const left = untilText(expiresAt, now);
	return left === undefined ? "Expired" : `Expires ${left}`;
}

/** "in 69 days", "in 5h", "in 3m": how long until `at`, or undefined once it has passed. */
export function untilText(at: number, now: number): string | undefined {
	const left = at - now;
	if (left <= 0) return undefined;
	if (left >= 2 * DAY) return `in ${Math.floor(left / DAY)} days`;
	if (left >= HOUR) return `in ${Math.floor(left / HOUR)}h`;
	return `in ${Math.max(1, Math.floor(left / MINUTE))}m`;
}

/** The ssh command for a sandbox, by its id, through the account's gateway. */
export const sshCommand = (sandbox: Pick<Sandbox, "id">, domain: string): string => `ssh ${sandbox.id}@ssh.${domain}`;

/** A sandbox's id, shortened for a table: the prefix and its first characters. */
export const shortId = (id: string): string => {
	const at = id.indexOf("_");
	return at === -1 ? id.slice(0, 10) : id.slice(0, at + 9);
};

/**
 * What a state lets a person do, in the order the actions menu lists them. A running sandbox whose guest agent doesn't
 * answer (`unresponsive`) can't be connected to or forked, only stopped or recovered. One whose host isn't connected
 * (`hostUnreachable`) can only be stopped: everything else needs its host, and a stop waits for it.
 */
export function sandboxActions(
	state: SandboxState,
	unresponsive = false,
	hostUnreachable = false,
): {
	readonly connect: boolean;
	readonly stop: boolean;
	readonly resume: boolean;
	readonly fork: boolean;
	readonly recover: boolean;
} {
	const stop = state === "running" || state === "paused";
	if (hostUnreachable) return { connect: false, stop, resume: false, fork: false, recover: false };
	const answering = state === "running" && !unresponsive;
	return {
		connect: answering,
		stop,
		resume: state === "stopped" || state === "paused" || state === "error",
		fork: answering || state === "stopped" || state === "paused",
		recover: state === "error" || (state === "running" && unresponsive),
	};
}

export const HOST_STATE_STATUS: Readonly<Record<HostState, Status>> = {
	online: "done",
	draining: "waiting",
	offline: "error",
	joining: "working",
};

export const HOST_STATE_LABELS: Readonly<Record<HostState, string>> = {
	online: "Online",
	draining: "Draining",
	offline: "Offline",
	joining: "Joining",
};

/** The part of a capacity in use, 0 to 1. */
export const usedShare = (used: number, total: number): number => (total <= 0 ? 0 : Math.min(1, used / total));
