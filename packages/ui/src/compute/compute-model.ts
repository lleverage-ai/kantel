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
	/** The join code (`kji_…`), only on the invite just made: Kantel shows it once and sends no email. */
	readonly code?: string;
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
	/** Renames an organisation; needs admin. Absent where the source can't. */
	rename?(accountId: string, name: string): Promise<ComputeAccount>;
	/** Changes a member's role; needs admin, and only an owner makes or unmakes an owner. Absent where it can't. */
	setRole?(accountId: string, memberId: string, role: AccountRole): Promise<OrganisationMember>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sandboxes

/**
 * Where a sandbox runs. `isolate`: a V8 isolate on workerd, a shell and JavaScript, up in milliseconds. `microvm`: a
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
		readonly presets: readonly ShapePreset[];
		/**
		 * Whether some host makes a shape off the presets. False (every host is an older kantel-host): only the presets
		 * may be chosen. Absent: true.
		 */
		readonly custom?: boolean;
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

/** Whether New sandbox may ask for a microVM of `shape`: a preset, or (where hosts make them) one in the ranges. */
export function shapeAllowed(shapes: SandboxShapes, shape: SandboxShape): boolean {
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

/** The preset a microVM shape is, if it is one. */
export function presetOf(shapes: SandboxShapes, shape: SandboxShape): ShapePreset | undefined {
	return shapes.microvm.presets.find((preset) => preset.vcpus === shape.vcpus && preset.memoryMb === shape.memoryMb);
}

/** Whether New sandbox offers any vCPUs and memory, or only the presets (no host makes custom shapes; maybe none). */
export const customShapes = (shapes: SandboxShapes): boolean => shapes.microvm.custom !== false;

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
	readonly takenAt: number;
}

export interface Sandbox {
	readonly id: string;
	/** The name people gave it, also its subdomain. */
	readonly name: string;
	/** Its address, for its public URLs: `<name>.<account>.<domain>`. */
	readonly hostname: string;
	readonly accountId: string;
	readonly kind: SandboxKind;
	readonly size: SandboxSize;
	/** What its host gave it, where that's known: the page shows this rather than its size's usual figures. */
	readonly resources?: { readonly vcpus: number; readonly memoryGb: number; readonly diskGb: number };
	readonly state: SandboxState;
	readonly createdAt: number;
	/** Who made it. */
	readonly createdBy: string;
	/** When auto-stop stops it; absent when it's always on or not running. */
	readonly stopsAt?: number;
	readonly snapshot?: SnapshotRef;
	/** Hosted only: what it has cost this billing period, in US cents. */
	readonly costCents?: number;
	/** CPU use over the last hour, 0 to 1, oldest first: the row's sparkline. */
	readonly usage: readonly number[];
	/** The host it runs on, for a super-admin. */
	readonly hostId?: string;
	/** What went wrong, when it's in `error`. */
	readonly error?: string;
	/** Shared with the organisation it belongs to (an organisation's sandboxes are shared unless made private). */
	readonly shared?: boolean;
	/** The sandbox it was forked from. */
	readonly forkedFrom?: string;
	/** The environment it was made from. */
	readonly environment?: { readonly id: string; readonly name: string };
	/** What a microVM's image has, as its guest agent found it; absent until one has said (an older host or image). */
	readonly image?: SandboxImage;
}

/** One thing an image has or lacks: what the guest agent found, or why it isn't there. */
export interface SandboxFeature {
	readonly available: boolean;
	/** What was found, such as "Xtigervnc, xfce4-session, Selkies". */
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

export interface CreateSandboxInput {
	readonly accountId: string;
	readonly name?: string;
	readonly kind: SandboxKind;
	/**
	 * What it gets: vCPUs and memory for a microVM, memory alone for an isolate (it shares its account's VM's CPU).
	 * Absent: the deployment's default.
	 */
	readonly shape?: SandboxShape;
	/** A saved snapshot to start from. */
	readonly fromSnapshot?: string;
	/** Minutes until auto-stop; undefined is always on. */
	readonly autoStopMinutes?: number;
	/** The environment it starts with. */
	readonly environmentId?: string;
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
	 * The Kantel CLI's command that SSHes in: `kantel ssh <id>`, which lets a key of its own in and needs nothing else,
	 * or `kantel e2e ssh <id>` end to end. It has no token, so it works whenever it's run.
	 */
	readonly ssh: string;
	/**
	 * Signs the CLI in to the Kantel this console belongs to, once, before `ssh` works: `kantel login --url <gateway>`.
	 * Absent where the CLI already is (`kantel console` serves the page).
	 */
	readonly cliLogin?: string;
	/**
	 * Whether plain `ssh` can get in without the CLI, through `SandboxesSource.sshKey`: not end to end, where the host
	 * refuses the gateway's SSH. Absent: no.
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

/** Signs the CLI in to the Kantel at `url` (its gateway's public origin, such as https://app.kantel.dev). */
export function cliLoginCommand(url: string): string {
	return `kantel login --url ${url}`;
}

/** The CLI's command that SSHes into a sandbox. */
export const cliSshCommand = (sandboxId: string, endToEnd = false): string =>
	`kantel ${endToEnd ? "e2e ssh" : "ssh"} ${sandboxId}`;

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
	/** A host's disk in use; a sandbox's points leave it out. */
	readonly diskUsedBytes?: number;
}

/** Usage points at a steady interval, oldest first, with what they're measured against. */
export interface UsageSeries {
	readonly intervalMs: number;
	/** The most memory there is: a sandbox's limit, a host's total. */
	readonly memLimitBytes?: number;
	/** A host's disk. */
	readonly diskTotalBytes?: number;
	readonly points: readonly UsagePoint[];
}

/**
 * Reads the points newer than `since` (ms since the epoch). The live graphs call it every few seconds with the newest
 * point they have, so an answer is only what's new.
 */
export type UsageRead = (id: string, since: number) => Promise<UsageSeries>;

export interface SandboxesSource {
	/**
	 * What New sandbox's sliders may choose, from the hosts the account may use, and what each costs. Absent:
	 * `DEFAULT_SANDBOX_SHAPES`.
	 */
	shapes?(accountId: string): Promise<SandboxShapes>;
	list(accountId: string): Promise<readonly Sandbox[]>;
	create(input: CreateSandboxInput): Promise<Sandbox>;
	stop(id: string): Promise<Sandbox>;
	resume(id: string): Promise<Sandbox>;
	/** A new sandbox from this one's latest snapshot. */
	fork(id: string): Promise<Sandbox>;
	/** Restarts a sandbox's machine that doesn't answer; the disk is kept. */
	recover(id: string): Promise<Sandbox>;
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
	/** Minutes until auto-stop stops it, from now; undefined keeps it always on. */
	setAutoStop?(id: string, minutes: number | undefined): Promise<Sandbox>;
	/** What a running sandbox is using now. Absent: its page shows CPU only. */
	usageNow?(id: string): Promise<SandboxUsageNow>;
	/** Its CPU and memory every few seconds, for the live graphs. Absent: they draw `usage` and don't move. */
	readonly usageSeries?: UsageRead;
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
	/**
	 * Where Browser and Desktop open: on the sandbox's page ("console", when left out), or each in a tab of its own
	 * ("tab") where the page can't frame them, as `kantel console`'s page can't.
	 */
	readonly screens?: "console" | "tab";
	/**
	 * True for a sandbox this console can't yet read files or command output from end to end: its Files tab and a failed
	 * command say so, and its files aren't read until this answers. False, or absent, for the rest.
	 */
	endToEnd?(id: string): Promise<boolean>;
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
	readonly createdAt: number;
	readonly createdBy: string;
	readonly sizeBytes: number;
	/** Sandboxes started from it. */
	readonly uses: number;
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
 * A read that needs this browser set up as a device first: an end-to-end space's files are read only over a session
 * of its own, and the gateway, which only relays it, can't. The message says how, in a line.
 */
export class DeviceSetupError extends Error {
	override readonly name = "DeviceSetupError";
}

/**
 * A folder or file the sandbox won't read: outside what it has (an isolate has only /workspace), or not there. Trying
 * again won't change it, so the browser says so in a line, never as an error to try again.
 */
export class FilesRefusedError extends Error {
	override readonly name = "FilesRefusedError";
}

export interface SnapshotsSource {
	saved(accountId: string): Promise<readonly SavedSnapshot[]>;
	/** Each sandbox's history, newest first. */
	history(sandboxId: string): Promise<readonly SandboxSnapshot[]>;
	save(sandboxId: string, name: string): Promise<SavedSnapshot>;
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
 * A variable every new sandbox made from the environment starts with. A plain one is its value in the sandbox. A
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
	/** How many sandboxes were made from it and still exist. */
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
	list(accountId: string): Promise<readonly Environment[]>;
	get(id: string): Promise<Environment>;
	create(input: { accountId: string; name: string; description?: string }): Promise<Environment>;
	update(id: string, change: { name?: string; description?: string }): Promise<Environment>;
	/** Deletes it. Sandboxes made from it keep what they started with; their protected variables stop resolving. */
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
}

/** A sandbox's egress: what it was made with, its own grants and its log. */
export interface SandboxEgress {
	readonly sandboxId: string;
	readonly sandboxName: string;
	/** The account the sandbox is in. */
	readonly accountId: string;
	readonly environment?: { readonly id: string; readonly name: string };
	readonly protectedVariables: readonly SandboxProtectedVariable[];
	/** The environment's grants, which this sandbox has too. */
	readonly environmentGrants: readonly EgressGrant[];
	/** This sandbox's own grants, on top of its environment's. */
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
	/** A newer version is out. */
	readonly updateAvailable?: string;
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
	join(input: { readonly name?: string; readonly labels?: Readonly<Record<string, string>> }): Promise<HostJoin>;
	/** Stops new sandboxes landing on it; running ones keep running. */
	drain(id: string): Promise<Host>;
	undrain(id: string): Promise<Host>;
	/** Revokes its credential: it's cut off at once, and its sandboxes can't be reached until it joins again. */
	remove(id: string): Promise<void>;
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
	readonly state: DeviceLoginState;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface DeviceLoginsSource {
	/** The sign-in with this code; rejects when no sign-in has it. */
	get(userCode: string): Promise<DeviceLogin>;
	/** Makes the device a key in the account, which its next poll collects. */
	approve(userCode: string, input: { readonly accountId: string }): Promise<DeviceLogin>;
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
	readonly proxy: ProxySource;
	readonly environments: EnvironmentsSource;
	readonly egress: EgressSource;
	readonly webhooks: WebhooksSource;
	readonly telemetry: TelemetrySource;
	/** The deployment's hosts: only for a super-admin. */
	readonly hosts?: HostsSource;
	/**
	 * An account's own hosts, which run only its sandboxes: for everyone else, where the deployment lets accounts add
	 * machines of their own (experimental). Absent, it doesn't.
	 */
	readonly ownHosts?: (accountId: string) => HostsSource;
	/** Only when hosted. */
	readonly billing?: BillingSource;
	/** Approving a command line's sign-in, at `/device`. Absent where nothing can sign in that way. */
	readonly devices?: DeviceLoginsSource;
	/** Where this console's code came from, and each account's end-to-end encryption. Absent, nothing is said. */
	readonly e2e?: E2ESource;
}

/** An account's end-to-end encryption, as its signed chain says: off, on, or strict (no hosted console at all). */
export type E2EMode = "off" | "on" | "strict";

/**
 * What end-to-end encryption means for the console's pages. `local`: `kantel console` serves it from the CLI's own
 * files, and its sandboxes' commands, files and history go to their host over sessions with the CLI's device key.
 * `gateway`: the gateway serves it, so in an end-to-end encrypted account it shows none of that unless this browser
 * is a device in the account's chain (`browser`).
 */
export interface E2ESource {
	readonly served: "local" | "gateway";
	/** This device's label in the chain, when local. */
	readonly device?: string;
	mode(accountId: string): Promise<E2EMode>;
	/** This browser as a device of its own (a `web` device in the chain), when the gateway serves the console. */
	readonly browser?: BrowserDeviceSource;
}

/**
 * Where this browser stands in an account's chain. `unpinned`: it trusts no chain there yet, so it needs the genesis an
 * admin gives out of band. `pending`: it trusts the chain but isn't in it; an admin adds it with `command` after
 * checking `fingerprint` with its person. `ready`: it is in, as `label`. `refused`: it can't be (the space is strict,
 * its person isn't a member, or the gateway's chain goes back on one it verified), for `reason`.
 */
export type BrowserStanding =
	| { readonly kind: "unpinned" }
	| { readonly kind: "pending"; readonly command: string; readonly fingerprint: string }
	| { readonly kind: "ready"; readonly label: string }
	| { readonly kind: "refused"; readonly reason: string };

export interface BrowserDeviceSource {
	standing(accountId: string): Promise<BrowserStanding>;
	/** Trusts the chain from `genesis` (what `kantel e2e status` prints), making this browser's keys if it has none. */
	trust(accountId: string, genesis: string): Promise<void>;
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

/** The status colour each state shows in. */
export const SANDBOX_STATE_STATUS: Readonly<Record<SandboxState, Status>> = {
	starting: "working",
	running: "done",
	paused: "waiting",
	stopping: "working",
	stopped: "idle",
	error: "error",
};

export const SANDBOX_KIND_LABELS: Readonly<Record<SandboxKind, string>> = {
	isolate: "Isolate",
	microvm: "MicroVM",
};

export const sizeSpec = (size: SandboxSize): SandboxSizeSpec =>
	SANDBOX_SIZES.find((spec) => spec.size === size) ?? (SANDBOX_SIZES[1] as SandboxSizeSpec);

/** "4 vCPU, 8 GB" ("Shared CPU, 256 MB" for an isolate): a size, or what a sandbox was given, in a line. */
export const sizeText = (size: SandboxSize | { readonly vcpus: number; readonly memoryGb: number }): string => {
	const spec = typeof size === "string" ? sizeSpec(size) : size;
	const memory = memoryText(Math.round(spec.memoryGb * 1024));
	return spec.vcpus === 0 ? `Shared CPU, ${memory}` : `${spec.vcpus} vCPU, ${memory}`;
};

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

/** What a state lets a person do, in the order the actions menu lists them. */
export function sandboxActions(state: SandboxState): {
	readonly connect: boolean;
	readonly stop: boolean;
	readonly resume: boolean;
	readonly fork: boolean;
	readonly recover: boolean;
} {
	return {
		connect: state === "running",
		stop: state === "running" || state === "paused",
		resume: state === "stopped" || state === "paused" || state === "error",
		fork: state === "running" || state === "stopped" || state === "paused",
		recover: state === "error",
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
