// The compute console's source over Kantel's public compute API (`@kantel/api`'s generated SDK, `/v1/whoami`,
// `/v1/sandboxes` and the rest), for when the console talks to a real compute plane rather than `@kantel/ui`'s
// fixtures. Same-origin under /v1, like the Environments page: behind Cloudflare Access the browser's cookie signs each
// call in; signed in another way, `headers` adds the bearer.
//
// A gateway that doesn't serve the routes (an older one, or one built without compute) answers 404 to the first call,
// and `apiCompute` throws. The UI's records are shaped for its pages, not the API, so each source maps the API's records
// field by field. Where the UI has a field the API lacks, a neutral value stands in, with a comment saying so; where
// the UI asks for something no route does, the call rejects with a sentence saying Kantel's API can't do it yet.
// Timestamps need no conversion: both sides use epoch milliseconds, except the base image fields (a sandbox's and a
// saved snapshot's `base`, and the admin images overview), whose times are ISO strings and are parsed here. Those and
// Restart on latest base are newer than the generated SDK, so they are read and called as raw routes with local types
// (`ApiSandboxBase` and the rest). The account goes in the query of a read and in the body of a write, as the
// contract's `account` field says.

import {
	type Account,
	type DestinationBinding as ApiBinding,
	type BucketSource as ApiBucketSource,
	type Bundle as ApiBundle,
	type ApiCall,
	type EgressEntry as ApiEgressEntry,
	type Environment as ApiEnvironment,
	type EgressGrant as ApiGrant,
	type ApiKey,
	type MountSource as ApiMountSource,
	type EnvironmentRepo as ApiRepo,
	type SandboxEgress as ApiSandboxEgress,
	type SandboxMount as ApiSandboxMount,
	type SandboxProcess as ApiSandboxProcess,
	type SandboxShapes as ApiSandboxShapes,
	type Template as ApiTemplate,
	type TemplateSnapshot as ApiTemplateSnapshot,
	type TemplateSpec as ApiTemplateSpec,
	type EnvironmentVariable as ApiVariable,
	type Caller,
	type Command,
	type CreatedBy,
	createKantelClient,
	type DeviceLoginRequest,
	type EgressGrantInput,
	type ExposedPort,
	type FileEntry,
	type Host,
	type Invite,
	KantelApiError,
	type KantelClient,
	type KantelClientOptions,
	type Member,
	type ProxySettings,
	type PublicUrl,
	type PutProxySettingsBody,
	type PutTelemetryBody,
	type Sandbox,
	type SandboxSizeName,
	type SandboxState,
	type Snapshot,
	send,
	type TelemetryExport,
	type Webhook,
	type WebhookDelivery,
	type WebhookLastDelivery,
} from "@kantel/api/sdk";
import type {
	AccountsSource,
	ApiKeysSource,
	BaseImagesSource,
	ComputeAccount,
	ComputeSource,
	ComputeViewer,
	DeviceLogin,
	DeviceLoginsSource,
	EgressSource,
	EnvironmentsSource,
	FilePart,
	FileRange,
	HostChoice,
	HostingMode,
	HostsSource,
	ProxySource,
	SandboxesSource,
	SnapshotsSource,
	TelemetrySource,
	TemplatesSource,
	DestinationBinding as UiBinding,
	EgressEntry as UiEgressEntry,
	Environment as UiEnvironment,
	EgressGrant as UiGrant,
	SandboxEgress as UiSandboxEgress,
	SandboxImage as UiSandboxImage,
	SandboxProcess as UiSandboxProcess,
	SandboxShapes as UiSandboxShapes,
	Template as UiTemplate,
	TemplateSnapshot as UiTemplateSnapshot,
	TemplateSpec as UiTemplateSpec,
	EnvironmentVariable as UiVariable,
	WebhooksSource,
} from "@kantel/ui";
import {
	cliLoginCommand,
	cliSshCommand,
	DEFAULT_SANDBOX_SHAPES,
	FilesRefusedError,
	FileTooLargeError,
	sameProxySettings,
	sshWithoutCliCommand,
} from "@kantel/ui";
import { type LiveSandboxes, liveSandboxes } from "./live-sandboxes.ts";
import { liveUsage, withUsage } from "./live-usage.ts";

// `@kantel/ui` exports the sources but not every record they carry, so the records are read off the sources' methods.
type UiMember = Awaited<ReturnType<AccountsSource["members"]>>[number];
type UiInvite = Awaited<ReturnType<AccountsSource["invites"]>>[number];
type UiSandbox = Awaited<ReturnType<SandboxesSource["list"]>>[number];
type UiSandboxSize = UiSandbox["size"];
type UiSandboxState = UiSandbox["state"];
type UiCommand = Awaited<ReturnType<SandboxesSource["history"]>>[number];
type UiPort = Awaited<ReturnType<NonNullable<SandboxesSource["ports"]>>>[number];
type UiSandboxSnapshot = Awaited<ReturnType<SnapshotsSource["history"]>>[number];
type UiSnapshotReason = UiSandboxSnapshot["reason"];
type UiSavedSnapshot = Awaited<ReturnType<SnapshotsSource["saved"]>>[number];
type UiSnapshotEntry = Awaited<ReturnType<SnapshotsSource["list"]>>[number];
type UiApiKey = Awaited<ReturnType<ApiKeysSource["list"]>>[number];
type UiProxySettings = Awaited<ReturnType<ProxySource["get"]>>;
type UiProxyChange = Parameters<ProxySource["update"]>[1];
type UiEgressPolicy = UiProxySettings["policy"];
type UiWebhook = Awaited<ReturnType<WebhooksSource["list"]>>[number];
type UiWebhookDelivery = Awaited<ReturnType<WebhooksSource["test"]>>;
type UiTelemetrySettings = Awaited<ReturnType<TelemetrySource["get"]>>;
type UiHost = Awaited<ReturnType<HostsSource["list"]>>[number];
type UiHostState = UiHost["state"];
type UiPublicUrl = Awaited<ReturnType<NonNullable<HostsSource["publicUrl"]>["get"]>>;
type UiEnvironmentFile = UiEnvironment["files"][number];
type UiRepo = UiEnvironment["repos"][number];
type UiMethod = UiBinding["methods"][number];
type UiSandboxBase = NonNullable<UiSandbox["base"]>;
type UiImagesOverview = Awaited<ReturnType<BaseImagesSource["overview"]>>;
type UiBaseImage = UiImagesOverview["images"][number];
type UiBaseImageVersion = UiBaseImage["versions"][number];
type UiTemplateBase = UiImagesOverview["templates"][number];

// The base image fields and the images overview, as the API sends them (times ISO), until the generated SDK has them.
interface ApiSandboxBase {
	readonly image: string;
	readonly version?: string;
	readonly outdated: boolean;
	readonly latest?: { readonly version: string; readonly builtAt: string };
	readonly behind?: { readonly days: number; readonly versions: number };
	readonly security?: boolean;
}

interface ApiImageScan {
	readonly scanner: string;
	readonly scannedAt: string;
	readonly counts: {
		readonly critical: number;
		readonly high: number;
		readonly medium: number;
		readonly low: number;
		readonly unknown: number;
	};
	readonly fixable: { readonly critical: number; readonly high: number };
	readonly findings: NonNullable<UiBaseImageVersion["scan"]>["findings"];
}

interface ApiBaseImageVersion {
	readonly version: string;
	readonly digest: string;
	readonly builtAt: string;
	readonly signed: boolean;
	readonly reason?: UiBaseImageVersion["reason"];
	readonly scan?: ApiImageScan;
}

interface ApiBaseImage {
	readonly name: string;
	readonly repository: string;
	readonly channel: "stable";
	readonly latest?: ApiBaseImageVersion;
	readonly versions: readonly ApiBaseImageVersion[];
}

interface ApiTemplateBase {
	readonly id: string;
	readonly name: string;
	readonly image: string;
	readonly channel?: string;
	readonly pinned?: string;
	readonly base: ApiSandboxBase;
	readonly rebuilding: boolean;
}

interface ApiImagesOverview {
	readonly images: readonly ApiBaseImage[];
	readonly templates: readonly ApiTemplateBase[];
	readonly indexUrl: string;
	readonly generatedAt?: string;
	readonly error?: string;
}
type UiMounts = NonNullable<ComputeSource["mounts"]>;
type UiBundle = Awaited<ReturnType<UiMounts["bundles"]>>[number];
type UiBucketSource = Awaited<ReturnType<UiMounts["bucketSources"]>>[number];
type UiSandboxMount = NonNullable<UiSandbox["mounts"]>[number];

export interface ComputeApiOptions {
	/** Default `/v1`, on this origin. */
	readonly baseUrl?: string;
	/** Credentials for every call, such as `Authorization`; none behind Access. */
	readonly headers?: KantelClientOptions["headers"];
	readonly fetch?: typeof fetch;
	/** A 401 from any call: the sign-in has ended. */
	readonly onUnauthenticated?: () => void;
	/** Default `self-hosted`. */
	readonly hosting?: HostingMode;
}

/** What every source shares: the client, how the console runs, and the domain sandbox addresses are under. */
interface Context {
	readonly api: KantelClient;
	readonly hosting: HostingMode;
	readonly domain: () => string;
	/** Records the SSH gateway's host name, the one hostname the API answers. */
	readonly learnHost: (host: string) => void;
	/** The person signed in, as the probe found them: whom `leave` removes. */
	readonly caller: Caller;
	/**
	 * Environments' names by ID, as last read: a sandbox names only its environment's ID, and the UI shows the name.
	 * Every environment the console reads goes in.
	 */
	readonly environmentNames: Map<string, string>;
	/** One raw call with the client's options, for a route the generated SDK doesn't have yet. */
	readonly call: <T>(call: ApiCall) => Promise<T>;
	/**
	 * Bucket sources' names and buckets by ID, as last read: a sandbox's bucket mount names only its source's ID, and the
	 * UI shows the name and the bucket where it knows them. Every bucket source the console reads goes in.
	 */
	readonly bucketSources: Map<string, { readonly name: string; readonly bucket: string }>;
	/** The sandboxes' live changes, one stream per account (live-sandboxes.ts). */
	readonly live: LiveSandboxes;
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared

/** The most pages a list follows before it stops: 20 of the API's default 50 is 1000 records. */
const MAX_PAGES = 20;

/** Every page of a list, following `nextCursor` up to `MAX_PAGES` pages. */
async function allPages<T>(
	read: (cursor: string | undefined) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string }>,
): Promise<T[]> {
	return (await firstPages(read)).items;
}

/** As `allPages`, saying whether the list went on past `MAX_PAGES`, for a view that should say it's cut off. */
async function firstPages<T>(
	read: (cursor: string | undefined) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string }>,
): Promise<{ items: T[]; more: boolean }> {
	const items: T[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const answer = await read(cursor);
		items.push(...answer.items);
		if (answer.nextCursor === undefined) return { items, more: false };
		cursor = answer.nextCursor;
	}
	return { items, more: true };
}

/** A page query's cursor, when there is one. */
const after = (cursor: string | undefined): { readonly cursor?: string } => (cursor === undefined ? {} : { cursor });

/** What the console says when it asks for something Kantel's API has no route for. */
const notYet = (sentence: string): Error => new Error(sentence);

const isCode = (error: unknown, code: string): boolean => error instanceof KantelApiError && error.code === code;

/** Who made something, by name where the API gives one. */
const actorName = (createdBy: CreatedBy): string => createdBy.name ?? createdBy.id;

// ---------------------------------------------------------------------------------------------------------------------
// Accounts

function viewerOf(caller: Caller): ComputeViewer {
	return {
		id: caller.user?.id ?? caller.apiKey?.id ?? "",
		name: caller.user?.name ?? caller.apiKey?.name ?? "",
		// The API has an email only for a person who signed in with one.
		email: caller.user?.email ?? "",
		superAdmin: caller.superAdmin,
	};
}

function accountOf(account: Account): ComputeAccount {
	return {
		id: account.id,
		kind: account.kind,
		name: account.name,
		// No slug: the API has none, and a sandbox's address doesn't carry its account.
		role: account.role,
		// The API doesn't count members on an account; the viewer is one.
		members: 1,
	};
}

function memberOf(member: Member): UiMember {
	return {
		id: member.userId,
		name: member.name,
		// The API has an email only for a person who signed in with one.
		email: member.email ?? "",
		role: member.role,
		joinedAt: member.joinedAt,
	};
}

function inviteOf(invite: Invite): UiInvite {
	return {
		id: invite.id,
		// An invite for anyone holding the code has no email.
		email: invite.email ?? "",
		role: invite.role,
		sentAt: invite.createdAt,
		// Only the invite just made has its code; the page shows it once.
		...(invite.code === undefined ? {} : { code: invite.code }),
		...(invite.emailed === undefined ? {} : { emailed: invite.emailed }),
	};
}

/** The viewer's personal account first, then their organisations by name. */
const byKindThenName = (a: ComputeAccount, b: ComputeAccount): number =>
	a.kind === b.kind ? a.name.localeCompare(b.name, "en-GB") : a.kind === "personal" ? -1 : 1;

function accountsSource({ api, caller }: Context): AccountsSource {
	return {
		viewer: async () => viewerOf(await api.getCaller()),
		list: async () => (await api.listAccounts()).items.map(accountOf).sort(byKindThenName),
		// The API takes no slug: an organisation is named by its ID.
		createOrganisation: async (input) => accountOf(await api.createOrganisation({ name: input.name })),
		join: async (code) => accountOf(await api.joinOrganisation({ code })),
		members: async (accountId) => (await api.listMembers(accountId)).items.map(memberOf),
		invites: async (accountId) => (await api.listInvites(accountId)).items.map(inviteOf),
		invite: async (accountId, input) =>
			inviteOf(await api.createInvite(accountId, { email: input.email, role: input.role })),
		revokeInvite: (accountId, inviteId) => api.revokeInvite(accountId, inviteId),
		removeMember: (accountId, memberId) => api.removeMember(accountId, memberId),
		leave: async (accountId) => {
			const userId = caller.user?.id;
			if (userId === undefined) throw notYet("An API key belongs to its account and can't leave it.");
			await api.removeMember(accountId, userId);
		},
		...(caller.user === undefined || caller.apiKey !== undefined ? {} : { deleteAccount: () => api.deleteCaller() }),
		rename: async (accountId, name) => accountOf(await api.updateAccount(accountId, { name })),
		setRole: async (accountId, memberId, role) => memberOf(await api.updateMember(accountId, memberId, { role })),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Sandboxes

const UI_SIZES: Readonly<Record<SandboxSizeName, UiSandboxSize>> = {
	small: "small",
	default: "medium",
	large: "large",
	xlarge: "xlarge",
};

const UI_STATES: Readonly<Record<SandboxState, UiSandboxState>> = {
	starting: "starting",
	running: "running",
	stopping: "stopping",
	stopped: "stopped",
	paused: "paused",
	error: "error",
	// The UI has no deleting or deleted: one being erased is on its way out, and a deleted one is gone.
	deleting: "stopping",
	deleted: "stopped",
};

/** The environment a sandbox was made from, when its name is known: none for one deleted since. */
function environmentRefOf(
	sandbox: Sandbox,
	context: Context,
): { readonly environment?: { readonly id: string; readonly name: string } } {
	if (sandbox.environmentId === undefined) return {};
	const name = context.environmentNames.get(sandbox.environmentId);
	return name === undefined ? {} : { environment: { id: sandbox.environmentId, name } };
}

/**
 * Reads the account's environments' names when a sandbox names an environment the console hasn't read. The names are
 * only shown: a caller that can't list environments (a key without `account:read`) still gets its sandboxes.
 */
async function learnEnvironmentNames(
	context: Context,
	accountId: string,
	sandboxes: readonly Sandbox[],
): Promise<void> {
	const unknown = sandboxes.some(
		(sandbox) => sandbox.environmentId !== undefined && !context.environmentNames.has(sandbox.environmentId),
	);
	if (!unknown) return;
	try {
		for (const environment of (await context.api.listEnvironments({ account: accountId })).items) {
			context.environmentNames.set(environment.id, environment.name);
		}
	} catch {
		// Shown without their environment's name.
	}
}

/** An ISO time as epoch milliseconds; `fallback` (default 0) for one that doesn't parse. */
const msOf = (iso: string, fallback = 0): number => {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? fallback : ms;
};

function baseOf(base: ApiSandboxBase): UiSandboxBase {
	return {
		image: base.image,
		...(base.version === undefined ? {} : { version: base.version }),
		outdated: base.outdated,
		...(base.latest === undefined
			? {}
			: { latest: { version: base.latest.version, builtAt: msOf(base.latest.builtAt) } }),
		...(base.behind === undefined ? {} : { behind: { days: base.behind.days, versions: base.behind.versions } }),
		...(base.security === undefined ? {} : { security: base.security }),
	};
}

/** A sandbox's or a snapshot's `base`, which the generated SDK's records don't have yet. */
function baseFieldOf(record: object): { readonly base?: UiSandboxBase } {
	const { base } = record as { readonly base?: ApiSandboxBase | null };
	return base === undefined || base === null ? {} : { base: baseOf(base) };
}

/**
 * Reads the account's bucket sources' names when a sandbox mounts a bucket source the console hasn't read. Like an
 * environment's name, only shown: a caller that can't list them (a key without `account:read`) still gets its sandboxes,
 * their bucket mounts named by ID.
 */
async function learnBucketSources(context: Context, accountId: string, sandboxes: readonly Sandbox[]): Promise<void> {
	const unknown = sandboxes.some((sandbox) =>
		(sandbox.mounts ?? []).some(
			(mount) => mount.source.kind === "bucket" && !context.bucketSources.has(mount.source.bucketSourceId),
		),
	);
	if (!unknown) return;
	try {
		for (const source of (await context.api.listBucketSources({ account: accountId })).items) {
			context.bucketSources.set(source.id, { name: source.name, bucket: source.bucket });
		}
	} catch {
		// Shown by their bucket source's ID.
	}
}

/** What a mount's files come from; a bucket source's name and bucket where the console has read them. */
function mountSourceOf(source: ApiMountSource, context: Context): UiSandboxMount["source"] {
	if (source.kind === "bundle") return { kind: "bundle", digest: source.digest };
	const known = context.bucketSources.get(source.bucketSourceId);
	return {
		kind: "bucket",
		bucketSourceId: source.bucketSourceId,
		prefix: source.prefix,
		...(source.refreshTtlSeconds === undefined ? {} : { refreshTtlSeconds: source.refreshTtlSeconds }),
		...(known === undefined ? {} : { bucketSourceName: known.name, bucket: known.bucket }),
	};
}

function mountOf(mount: ApiSandboxMount, context: Context): UiSandboxMount {
	return {
		path: mount.path,
		source: mountSourceOf(mount.source, context),
		status: mount.status,
		...(mount.error === undefined ? {} : { error: mount.error }),
	};
}

/** A sandbox's read-only mounts (experimental); none where it has none, or the deployment has mounts off. */
function mountsOf(sandbox: Sandbox, context: Context): { readonly mounts?: readonly UiSandboxMount[] } {
	if (sandbox.mounts === undefined || sandbox.mounts.length === 0) return {};
	return { mounts: sandbox.mounts.map((mount) => mountOf(mount, context)) };
}

/**
 * What New sandbox's sliders may choose, as the API says. With no host for microVMs, the sample's microVM ranges stand
 * in, marked unavailable, so the page offers no microVM; the API's rates are a currency's units an hour, the page's
 * US cents.
 */
export function shapesOf(shapes: ApiSandboxShapes): UiSandboxShapes {
	const microvm = shapes.microvm;
	return {
		isolate: { memoryMb: { ...shapes.isolate.memoryMb } },
		microvm:
			microvm === undefined
				? { ...DEFAULT_SANDBOX_SHAPES.microvm, available: false }
				: {
						vcpus: { ...microvm.vcpus },
						memoryMb: { ...microvm.memoryMb },
						memoryMbPerVcpu: { ...microvm.memoryMbPerVcpu },
						// Absent where no host takes a disk off its presets: then no disk may be chosen.
						...(microvm.diskGb === undefined ? {} : { diskGb: { ...microvm.diskGb } }),
						presets: microvm.presets.map((preset) => ({ ...preset })),
						// Older hosts only: then just the presets may be chosen.
						custom: microvm.custom,
					},
		...(shapes.rates === undefined
			? {}
			: {
					rates: {
						microvmCentsPerVcpuHour: shapes.rates.microvmPerVcpuHour * 100,
						microvmCentsPerGbHour: shapes.rates.microvmPerGbHour * 100,
						isolateCentsPerGbHour: shapes.rates.isolatePerGbHour * 100,
					},
				}),
	};
}

/** What the guest agent found in a microVM's image, where it has said (a newer host and agent). */
function imageOf(sandbox: Sandbox): { image?: UiSandboxImage } {
	const guest = sandbox.capabilities.guest;
	if (guest === undefined) return {};
	const feature = (found: { available: boolean; detail?: string; reason?: string }) => ({
		available: found.available,
		...(found.detail === undefined ? {} : { detail: found.detail }),
		...(found.reason === undefined ? {} : { reason: found.reason }),
	});
	return {
		image: {
			os: guest.os.name,
			osId: guest.os.id,
			arch: guest.arch,
			libc: guest.libc,
			...(guest.shell === undefined ? {} : { shell: guest.shell }),
			init: guest.init,
			injected: guest.agent.injected,
			agentVersion: guest.agent.version,
			desktop: feature(guest.desktop),
			browser: feature(guest.browser),
			docker: feature(guest.docker),
			// The sandbox's own `kvm` is the host's nesting and the image's /dev/kvm together.
			kvm: sandbox.capabilities.kvm && guest.docker.kvm,
		},
	};
}

function sandboxOf(sandbox: Sandbox, context: Context): UiSandbox {
	return {
		id: sandbox.id,
		name: sandbox.name,
		hostname: `${sandbox.subdomain}.${context.domain()}`,
		accountId: sandbox.accountId,
		kind: sandbox.type,
		// Isolates and shapes no size names have none: nothing stands in, since the page shows only the figures below.
		...(sandbox.size === undefined ? {} : { size: UI_SIZES[sandbox.size] }),
		// What it asked for, so one that is starting (a custom shape, or a fork) shows that rather than nothing.
		...(sandbox.shape === undefined
			? {}
			: { shape: { vcpus: sandbox.shape.vcpus, memoryGb: sandbox.shape.memoryMb / 1024 } }),
		// What the host gave it, which the backend decides: the page shows this first.
		...(sandbox.resources === undefined
			? {}
			: {
					resources: {
						vcpus: sandbox.resources.vcpus,
						// Unrounded: an isolate's 384 MB is 0.375 GB, which the page shows as MB.
						memoryGb: sandbox.resources.memoryMb / 1024,
						diskGb: sandbox.resources.diskGb,
					},
				}),
		state: UI_STATES[sandbox.state],
		...(sandbox.state === "deleted" ? { deleted: true } : {}),
		createdAt: sandbox.createdAt,
		createdBy: actorName(sandbox.createdBy),
		creator: { kind: sandbox.createdBy.kind, id: sandbox.createdBy.id },
		...(sandbox.stopsAt === undefined ? {} : { stopsAt: sandbox.stopsAt }),
		...(sandbox.idleStopMinutes === undefined || sandbox.idleStopMinutes === null
			? {}
			: { idleStopMinutes: sandbox.idleStopMinutes }),
		...(sandbox.idleStopsAt === undefined ? {} : { idleStopsAt: sandbox.idleStopsAt }),
		...((sandbox.state === "stopped" || sandbox.state === "paused") && sandbox.reason !== undefined
			? { stopReason: sandbox.reason }
			: {}),
		...(sandbox.latestSnapshotId === undefined
			? {}
			: {
					snapshot: {
						id: sandbox.latestSnapshotId,
						// When the snapshot itself was taken, not a guess from its starts and stops (a running sandbox's can be new).
						...(sandbox.latestSnapshotAt === undefined ? {} : { takenAt: sandbox.latestSnapshotAt }),
					},
				}),
		// Hosted only: the API's cost is in its currency's units, the UI's in cents.
		...(context.hosting === "hosted" ? { costCents: Math.round(sandbox.cost.total * 100) } : {}),
		usage: sandbox.usage.recentCpu,
		...(sandbox.hostId === undefined ? {} : { hostId: sandbox.hostId }),
		...(sandbox.hostName === undefined ? {} : { hostName: sandbox.hostName }),
		...(sandbox.state === "error" && sandbox.reason !== undefined ? { error: sandbox.reason } : {}),
		shared: sandbox.visibility === "organisation",
		...(sandbox.source?.sandboxId === undefined ? {} : { forkedFrom: sandbox.source.sandboxId }),
		...environmentRefOf(sandbox, context),
		...baseFieldOf(sandbox),
		...mountsOf(sandbox, context),
		...imageOf(sandbox),
		...(sandbox.template === undefined
			? {}
			: {
					template: {
						id: sandbox.template.id,
						name: sandbox.template.name,
						version: sandbox.template.version,
						start: sandbox.template.start,
					},
				}),
	};
}

/** How many lines of a failed command's output the Logs tab shows: its end, where the error usually is. */
const OUTPUT_LINES = 40;

/** The end of what a failed command printed, stdout then stderr; none for one that succeeded or printed nothing. */
function outputOf(command: Command): { readonly output?: string } {
	if (command.exitCode === undefined || command.exitCode === 0) return {};
	const printed = [command.stdout, command.stderr]
		.map((text) => text.replace(/\s+$/, ""))
		.filter((text) => text !== "")
		.join("\n");
	if (printed === "") return {};
	return { output: printed.split("\n").slice(-OUTPUT_LINES).join("\n") };
}

function commandOf(command: Command): UiCommand {
	return {
		id: command.id,
		command: command.command,
		startedAt: command.startedAt,
		...(command.durationMs === undefined ? {} : { durationMs: command.durationMs }),
		...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
		// The API doesn't say who ran a command.
		by: "",
		...outputOf(command),
	};
}

function portOf(port: ExposedPort): UiPort {
	return { port: port.port, url: port.url, public: port.public, createdAt: port.createdAt };
}

function sandboxesSource(context: Context): SandboxesSource {
	const { api } = context;
	const view = (sandbox: Sandbox) => sandboxOf(sandbox, context);
	return {
		watch: (accountId, changed) => context.live.watch(accountId, changed),
		list: async (accountId) => {
			const sandboxes = await allPages((cursor) =>
				api.listSandboxes({ account: accountId, all: true, ...after(cursor) }),
			);
			await Promise.all([
				learnEnvironmentNames(context, accountId, sandboxes),
				learnBucketSources(context, accountId, sandboxes),
			]);
			return sandboxes.map(view);
		},
		shapes: async (accountId, hostId) =>
			shapesOf(await api.getSandboxShapes({ account: accountId, ...(hostId === undefined ? {} : { host: hostId }) })),
		hosts: (accountId) => hostChoices(context, accountId),
		create: async (input) => {
			const made = await api.createSandbox({
				account: input.accountId,
				type: input.kind,
				// An isolate asks for memory alone: it shares its account's VM's CPU. A microVM asks for a disk only where one
				// was chosen, and never from a snapshot, which keeps its own.
				...(input.shape === undefined
					? {}
					: {
							resources:
								input.kind === "isolate"
									? { memoryMb: input.shape.memoryMb }
									: {
											vcpus: input.shape.vcpus,
											memoryMb: input.shape.memoryMb,
											...(input.shape.diskGb === undefined || input.fromSnapshot !== undefined
												? {}
												: { diskGb: input.shape.diskGb }),
										},
						}),
				...(input.name === undefined || input.name === "" ? {} : { name: input.name }),
				...(input.fromSnapshot === undefined ? {} : { from: input.fromSnapshot }),
				// The API takes an environment's ID or its name; the UI picks by ID.
				...(input.environmentId === undefined || input.environmentId === ""
					? {}
					: { environment: input.environmentId }),
				// The API takes a template's ID or its name; the UI picks by ID.
				...(input.templateId === undefined || input.templateId === "" ? {} : { template: input.templateId }),
				// The UI's absent auto-stop is always on, the API's `null`.
				autoStopMinutes: input.autoStopMinutes ?? null,
				...(input.idleStopMinutes === undefined ? {} : { idleStopMinutes: input.idleStopMinutes }),
				...(input.hostId === undefined ? {} : { host: input.hostId }),
			});
			await learnEnvironmentNames(context, made.accountId, [made]);
			return view(made);
		},
		stop: async (id) => view(await api.stopSandbox(id, {})),
		resume: async (id) => view(await api.resumeSandbox(id, {})),
		fork: async (id) => {
			const [fork] = (await api.forkSandbox(id, {})).items;
			if (fork === undefined) throw new Error("Kantel made no fork of that sandbox.");
			return view(fork);
		},
		recover: async (id) => view(await api.recoverSandbox(id)),
		// Not in the generated SDK yet: the raw route, as `recoverSandbox` calls its own.
		restartOnLatest: async (id) =>
			view(
				await context.call<Sandbox>({
					method: "POST",
					path: `/sandboxes/${encodeURIComponent(id)}/restart-on-latest`,
				}),
			),
		remove: async (id) => {
			await api.deleteSandbox(id);
		},
		access: async (id) => {
			// microVMs only: an isolate's `not_supported` rejects the lot. SSH is the CLI's `kantel ssh`, which lets a key of
			// its own in when it's run, so nothing is asked for it here: a key for plain ssh is `sshKey`'s, made only when
			// someone asks. The browser is driven where it runs, on the desktop, so its page is a desktop page too; while
			// Chromium is still starting, the API refuses it and the desktop's stands in.
			//
			// Desktop and Browser that can't open are said so rather than opened onto an error page: where the gateway
			// refuses them (`not_supported`: a deployment that doesn't serve this sandbox's desktop).
			const screen = async <T>(open: () => Promise<T>): Promise<Opened<T>> => {
				try {
					return { value: await open() };
				} catch (error) {
					if (isCode(error, "not_supported")) return { refused: SCREENS_NOT_SERVED };
					throw error;
				}
			};
			const [desktop, watch, browser] = await Promise.all([
				screen(() => api.openDesktop(id)),
				screen(() => api.openDesktop(id, { viewOnly: true })),
				screen(() =>
					api.openBrowser(id).catch((error: unknown) => {
						if (isCode(error, "unavailable")) return undefined;
						throw error;
					}),
				),
			]);
			const desktopRefused = desktop.refused ?? watch.refused;
			const desktopUrl = desktopRefused === undefined ? desktop.value?.url : undefined;
			// While Chromium starts, the desktop's page stands in for the browser's, and its reason when it has one.
			const browserUrl = browser.value?.url ?? desktopUrl;
			const browserRefused = browser.refused ?? (browserUrl === undefined ? desktopRefused : undefined);
			const unavailable = {
				...(desktopRefused === undefined ? {} : { desktop: desktopRefused }),
				...(browserRefused === undefined ? {} : { browser: browserRefused }),
			};
			return {
				ssh: cliSshCommand(id),
				// The CLI signs in to the gateway that serves this page, under /v1 on its origin.
				...(globalThis.location?.origin !== undefined ? { cliLogin: cliLoginCommand(globalThis.location.origin) } : {}),
				sshWithoutCli: true,
				// What can't open has no address: nothing links or frames it.
				desktopUrl: desktopUrl ?? "",
				desktopViewUrl: (desktopRefused === undefined ? watch.value?.url : undefined) ?? "",
				browserUrl: browserUrl ?? "",
				// The browser's page is a desktop page, which a frame can show as it is.
				embed: {
					desktop: (desktopRefused === undefined ? desktop.value?.embedUrl : undefined) ?? "",
					watch: (desktopRefused === undefined ? watch.value?.embedUrl : undefined) ?? "",
					browser: browserUrl ?? "",
				},
				...(Object.keys(unavailable).length === 0 ? {} : { unavailable }),
			};
		},
		sshKey: async (id, publicKey) => {
			const grant = await api.openSsh(id, publicKey === undefined ? {} : { publicKey });
			context.learnHost(grant.host);
			const target = { sandboxId: id, user: grant.user, host: grant.host, port: grant.port };
			const routed = grant.proxyUrl === undefined ? target : { ...target, proxyUrl: grant.proxyUrl };
			const privateKey = grant.privateKey?.trim();
			const shown = {
				...(grant.hostKeyFingerprint === undefined ? {} : { hostKeyFingerprint: grant.hostKeyFingerprint }),
				expiresAt: grant.expiresAt,
			};
			if (privateKey === undefined || privateKey === "") return { command: sshWithoutCliCommand(routed), ...shown };
			// The key Kantel made downloads under the sandbox's name, where a browser saves it by default.
			const keyFile = { name: `kantel-${id}`, path: `~/Downloads/kantel-${id}` };
			return {
				command: sshWithoutCliCommand(routed, keyFile.path),
				privateKey: `${privateKey}\n`,
				keyFile,
				...shown,
			};
		},
		history: async (id) => (await allPages((cursor) => api.listCommands(id, after(cursor)))).map(commandOf),
		get: async (id) => {
			const sandbox = await api.getSandbox(id);
			await Promise.all([
				learnEnvironmentNames(context, sandbox.accountId, [sandbox]),
				learnBucketSources(context, sandbox.accountId, [sandbox]),
			]);
			return view(sandbox);
		},
		// The API's `null` is always on.
		setAutoStop: async (id, minutes) => view(await api.updateSandbox(id, { autoStopMinutes: minutes ?? null })),
		setIdleStop: async (id, minutes) => view(await api.updateSandbox(id, { idleStopMinutes: minutes ?? null })),
		usageNow: async (id) => {
			// The latest point's memory, and its disk where its host sends it (a microVM's guest).
			const latest = (await api.getSandboxUsage(id)).points.at(-1);
			if (latest === undefined) return {};
			const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
			return {
				memoryGb: Math.round((latest.memoryMb / 1024) * 10) / 10,
				...(latest.diskUsedBytes === undefined ? {} : { diskGb: gb(latest.diskUsedBytes) }),
			};
		},
		// A microVM's busiest processes, which its guest agent reads when asked.
		processes: async (id) => {
			try {
				return (await api.listSandboxProcesses(id)).items.map(processOf);
			} catch (error) {
				if (unlistedProcesses(error)) return undefined;
				throw error;
			}
		},
		rename: async (id, name) => view(await api.updateSandbox(id, { name })),
		ports: async (id) => (await api.listPorts(id)).items.map(portOf),
		exposePort: async (id, port, isPublic) => portOf(await api.exposePort(id, { port, public: isPublic })),
		hidePort: (id, port) => api.hidePort(id, String(port)),
		// Read on demand, a folder or a part of a file at a time, and kept nowhere: not here, nor by the gateway. The
		// gateway's API reads them from the host.
		files: {
			list: (id, path) =>
				refusing(async () => {
					const { items, more } = await firstPages((cursor) =>
						api.listFiles(id, { path: absolute(path), ...after(cursor) }),
					);
					return { entries: items.map(entryOf).sort(foldersFirst), more };
				}),
			read: (id, path, range) => refusing(() => readSandboxFile(context, id, path, range)),
		},
	};
}

/** A process as the API answers it. */
const processOf = (process: ApiSandboxProcess): UiSandboxProcess => ({
	pid: process.pid,
	command: process.command,
	cpuPercent: process.cpuPercent,
	memoryBytes: process.memoryBytes,
});

/**
 * Whether a read of a sandbox's processes says they can't be listed, rather than failing: its host, guest agent or tier
 * can't (`not_supported`), or the gateway is from before the route (404). The dialog then says its host can't list
 * them yet.
 */
export const unlistedProcesses = (error: unknown): boolean =>
	error instanceof KantelApiError && (error.code === "not_supported" || error.status === 404);

/** A part of a running sandbox's file, through the API. */
async function readSandboxFile(context: Context, id: string, path: string, range: FileRange): Promise<FilePart> {
	// Base64, so a binary's first bytes come back as they are and the UI decides what it can show.
	const file = await context.api.readFile(id, {
		path: absolute(path),
		encoding: "base64",
		offset: range.offset,
		length: Math.min(range.length, MAX_READ_BYTES),
	});
	return { bytes: contentBytes(file), size: file.size };
}

/**
 * A read whose refusal (a path outside what the sandbox has, such as anything but an isolate's /workspace, or one that
 * isn't there) is the UI's refusal, which it shows as a line and never offers to try again. Anything else (the host
 * unreachable) is as it was, for Try again.
 */
async function refusing<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (refusedPath(error)) throw new FilesRefusedError(error.message);
		throw error;
	}
}

/** The API's codes for a path a sandbox won't read: `invalid` outside it, `not_found` absent. */
const refusedPath = (error: unknown): error is KantelApiError =>
	error instanceof KantelApiError && (error.code === "invalid" || error.code === "not_found");

/** Desktop and Browser where the gateway refuses them: this deployment doesn't serve the sandbox's screens yet. */
export const SCREENS_NOT_SERVED = "Not available here yet";

/** A screen's access, or why it can't open. */
type Opened<T> =
	| { readonly value: T; readonly refused?: undefined }
	| { readonly refused: string; readonly value?: undefined };

/** The API reads at most this much of a file at a time. */
const MAX_READ_BYTES = 1024 * 1024;

/** Standard base64 (the API's `content`) as bytes. */
function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at);
	return out;
}

/** A file's content as the API answered it, as bytes. */
function contentBytes(file: { readonly encoding: "utf8" | "base64"; readonly content: string }): Uint8Array {
	return file.encoding === "base64" ? fromBase64(file.content) : new TextEncoder().encode(file.content);
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshots

/** Why a snapshot was taken: the API's manual and save triggers aren't the UI's, and it has no fork trigger. */
function reasonOf(trigger: Snapshot["trigger"]): UiSnapshotReason {
	return trigger === "stop" ? "stop" : "periodic";
}

function sandboxSnapshotOf(snapshot: Snapshot, sandboxId: string): UiSandboxSnapshot {
	return {
		id: snapshot.id,
		sandboxId: snapshot.sandboxId ?? sandboxId,
		takenAt: snapshot.createdAt,
		reason: reasonOf(snapshot.trigger),
		// The API leaves the size out while it is unknown.
		sizeBytes: snapshot.sizeBytes ?? 0,
		// An automatic snapshot always has an expiry; without one, it shows as due now.
		expiresAt: snapshot.expiresAt ?? snapshot.createdAt,
	};
}

function savedSnapshotOf(snapshot: Snapshot, sandboxName: string): UiSavedSnapshot {
	return {
		id: snapshot.id,
		// A saved snapshot always has a name; the ID stands in otherwise.
		name: snapshot.name ?? snapshot.id,
		accountId: snapshot.accountId,
		...(snapshot.sandboxId === undefined ? {} : { sandboxId: snapshot.sandboxId }),
		sandboxName,
		kind: snapshot.sandboxType,
		...(snapshot.description === undefined ? {} : { description: snapshot.description }),
		...(snapshot.labels === undefined ? {} : { labels: snapshot.labels }),
		createdAt: snapshot.createdAt,
		// One saved before the API kept who saved it doesn't say.
		...(snapshot.createdBy === undefined ? {} : { createdBy: actorName(snapshot.createdBy) }),
		// The API leaves the size out while it is unknown.
		sizeBytes: snapshot.sizeBytes ?? 0,
		// The sandboxes made from it; a gateway from before it counted them doesn't say.
		uses: snapshot.uses ?? 0,
		...baseFieldOf(snapshot),
		memory: snapshot.memory,
		...(snapshot.resources === undefined
			? {}
			: { machine: { vcpus: snapshot.resources.vcpus, memoryMb: snapshot.resources.memoryMb } }),
	};
}

function entryOf(entry: FileEntry): UiSnapshotEntry {
	return {
		name: entry.name,
		// The API's paths are absolute; the UI's start at the root with no slash.
		path: entry.path.replace(/^\/+/, ""),
		// The UI has no symlinks: one shows as a file.
		kind: entry.kind === "directory" ? "folder" : "file",
		...(entry.kind === "directory" ? {} : { sizeBytes: entry.size }),
		...(entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt }),
	};
}

/** Folders first, then files, by name. */
const foldersFirst = (a: UiSnapshotEntry, b: UiSnapshotEntry): number =>
	a.kind === b.kind ? a.name.localeCompare(b.name, "en-GB") : a.kind === "folder" ? -1 : 1;

/** A UI path (from the root, no leading slash) as the API's absolute one. */
const absolute = (path: string): string => `/${path.replace(/^\/+/, "")}`;

function snapshotsSource({ api }: Context): SnapshotsSource {
	return {
		saved: async (accountId) => {
			// The API names a snapshot's sandbox by ID; the account's sandboxes give the names.
			const [snapshots, sandboxes] = await Promise.all([
				allPages((cursor) => api.listSnapshots({ account: accountId, kind: "saved", ...after(cursor) })),
				allPages((cursor) => api.listSandboxes({ account: accountId, all: true, ...after(cursor) })),
			]);
			const names = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox.name]));
			return snapshots.map((snapshot) =>
				savedSnapshotOf(snapshot, snapshot.sandboxId === undefined ? "" : (names.get(snapshot.sandboxId) ?? "")),
			);
		},
		history: async (sandboxId) => {
			// A list defaults to the person's own account, so it names the sandbox's.
			const sandbox = await api.getSandbox(sandboxId);
			const snapshots = await allPages((cursor) =>
				api.listSnapshots({ account: sandbox.accountId, sandboxId, kind: "automatic", ...after(cursor) }),
			);
			return snapshots.map((snapshot) => sandboxSnapshotOf(snapshot, sandboxId));
		},
		save: async (sandboxId, name, options) => {
			const [snapshot, sandbox] = await Promise.all([
				api.saveSnapshot({ name, sandboxId, ...(options?.memory === true ? { memory: true } : {}) }),
				api.getSandbox(sandboxId),
			]);
			return savedSnapshotOf(snapshot, sandbox.name);
		},
		removeSaved: (id) => api.deleteSnapshot(id),
		removeSnapshot: (id) => api.deleteSnapshot(id),
		list: (snapshotId, path) =>
			refusing(async () =>
				(await allPages((cursor) => api.listSnapshotFiles(snapshotId, { path: absolute(path), ...after(cursor) })))
					.map(entryOf)
					.sort(foldersFirst),
			),
		// A snapshot's file comes whole, up to the API's 1 MiB, however little the preview asks for; a larger one is
		// `invalid`, and shows with its name and size only. Nothing is kept: a second look reads it again.
		read: async (snapshotId, path) => {
			try {
				const file = await api.readSnapshotFile(snapshotId, { path: absolute(path), encoding: "base64" });
				return { bytes: contentBytes(file), size: file.size };
			} catch (error) {
				if (isCode(error, "invalid")) throw new FileTooLargeError();
				// One that isn't there (any more) is a refusal, not worth trying again.
				if (refusedPath(error)) throw new FilesRefusedError(error.message);
				throw error;
			}
		},
		// The API has no download route, and a link can't carry the bearer a read needs: no Download.
		downloadUrl: () => undefined,
		// Where a link to a snapshot's files doesn't say, the API does: an isolate's start at /workspace.
		kindOf: async (snapshotId) => (await api.getSnapshot(snapshotId)).sandboxType,
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// API keys

function apiKeyOf(key: ApiKey): UiApiKey {
	return {
		id: key.id,
		name: key.name,
		prefix: key.prefix,
		accountId: key.accountId,
		scopes: key.scopes,
		createdAt: key.createdAt,
		createdBy: actorName(key.createdBy),
		...(key.lastUsedAt === undefined ? {} : { lastUsedAt: key.lastUsedAt }),
		...(key.expiresAt === undefined ? {} : { expiresAt: key.expiresAt }),
		...(key.revokedAt === undefined ? {} : { revokedAt: key.revokedAt }),
	};
}

function keysSource({ api }: Context): ApiKeysSource {
	return {
		list: async (accountId) => (await api.listApiKeys({ account: accountId })).items.map(apiKeyOf),
		create: async (input) => {
			const issued = await api.createApiKey({
				account: input.accountId,
				name: input.name,
				scopes: input.scopes,
				...(input.expiresInDays === undefined ? {} : { expiresInDays: input.expiresInDays }),
			});
			return { key: apiKeyOf(issued.key), secret: issued.secret };
		},
		revoke: async (id) => apiKeyOf(await api.revokeApiKey(id)),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Device sign-ins

const deviceLoginOf = (login: DeviceLoginRequest): DeviceLogin => ({
	userCode: login.userCode,
	clientName: login.clientName,
	state: login.state,
	createdAt: login.createdAt,
	expiresAt: login.expiresAt,
});

function devicesSource({ api }: Context): DeviceLoginsSource {
	return {
		get: async (userCode) => deviceLoginOf(await api.getDeviceLogin(userCode)),
		approve: async (userCode, input) =>
			deviceLoginOf(await api.approveDeviceLogin(userCode, { account: input.accountId })),
		deny: async (userCode) => deviceLoginOf(await api.denyDeviceLogin(userCode)),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Egress proxy

/** The API's default action and allow list as the UI's policy: deny with nothing allowed is closed. */
function policyOf(settings: ProxySettings): UiEgressPolicy {
	if (settings.defaultAction === "allow") return "open";
	return settings.allow.length === 0 ? "closed" : "allowlist";
}

function proxyOf(settings: ProxySettings): UiProxySettings {
	return {
		accountId: settings.accountId,
		enabled: settings.enabled,
		policy: policyOf(settings),
		allow: settings.allow,
		deny: settings.deny,
		...(settings.upstream === undefined
			? {}
			: { upstream: { url: settings.upstream.url, authSet: settings.upstream.headerNames.length > 0 } }),
		// No `logRequests`: the API keeps each sandbox's newest requests, with no switch.
	};
}

/**
 * The UI's upstream credentials as the header the API sends the upstream: `user:password` as Basic, anything else as
 * a bearer token.
 */
function proxyAuthorisation(auth: string): string {
	if (!auth.includes(":")) return `Bearer ${auth}`;
	const bytes = new TextEncoder().encode(auth);
	return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** How many times a change is made on a fresh read when Kantel says the settings changed since it read them. */
const PROXY_ATTEMPTS = 3;

/**
 * A PUT replaces the settings, so what a change leaves out is sent as it is now: as read just before, and sent with
 * that read as the API's `expected`, so a change someone made in between is never undone. Kantel refuses such a write
 * with `conflict`, and a change with no `expected` of its own is made again on a fresh read. One made from the caller's
 * own read (`change.expected`) is refused when the settings no longer are that read, for the caller to redo.
 */
function proxySource({ api }: Context): ProxySource {
	return {
		get: async (accountId) => proxyOf(await api.getProxySettings({ account: accountId })),
		update: async (accountId, change) => {
			if (change.logRequests === false) throw notYet("Kantel's API always keeps each sandbox's newest requests.");
			for (let attempt = 1; ; attempt++) {
				const current = await api.getProxySettings({ account: accountId });
				if (change.expected !== undefined && !sameProxySettings(change.expected, proxyOf(current))) {
					throw new KantelApiError(
						409,
						"conflict",
						"The proxy settings changed since you read them; read them again and redo the change",
					);
				}
				try {
					return proxyOf(await api.putProxySettings(proxyBody(accountId, change, current)));
				} catch (error) {
					if (change.expected !== undefined || attempt >= PROXY_ATTEMPTS || !isCode(error, "conflict")) throw error;
				}
			}
		},
	};
}

/** The PUT that makes `change` of `current`, the settings as read, with them as its `expected`. */
function proxyBody(accountId: string, change: UiProxyChange, current: ProxySettings): PutProxySettingsBody {
	const policy = change.policy ?? policyOf(current);
	let upstream: PutProxySettingsBody["upstream"];
	if (change.upstream === null) upstream = null;
	else if (change.upstream !== undefined) {
		const { url, auth } = change.upstream;
		// No `auth` keeps the upstream's credentials; an empty one removes them.
		upstream =
			auth === undefined
				? { url }
				: { url, headers: auth === "" ? {} : { "Proxy-Authorization": proxyAuthorisation(auth) } };
	} else if (current.upstream !== undefined) upstream = { url: current.upstream.url };
	return {
		account: accountId,
		enabled: change.enabled ?? current.enabled,
		defaultAction: policy === "open" ? "allow" : "deny",
		// Closed is deny with nothing allowed.
		allow: policy === "closed" ? [] : (change.allow ?? current.allow),
		deny: change.deny ?? current.deny,
		...(upstream === undefined ? {} : { upstream }),
		// The UI has no attribution switch: it stays as it is.
		attribution: current.attribution,
		expected: current,
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Webhooks

/** The API's name is the UI's description; a webhook made with none is named by its URL. */
const descriptionOf = (webhook: Webhook): string | undefined =>
	webhook.name === webhook.url ? undefined : webhook.name;

function lastDeliveryOf(delivery: WebhookLastDelivery): UiWebhookDelivery {
	return {
		// The API's last delivery has no ID, event, duration or attempt; the page shows none of them for it.
		id: "",
		event: "sandbox.created",
		at: delivery.at,
		...(delivery.status === undefined ? {} : { status: delivery.status }),
		durationMs: 0,
		attempt: 1,
		ok: delivery.ok,
	};
}

function webhookOf(webhook: Webhook, secretPrefix = ""): UiWebhook {
	const description = descriptionOf(webhook);
	return {
		id: webhook.id,
		accountId: webhook.accountId,
		url: webhook.url,
		...(description === undefined ? {} : { description }),
		events: webhook.events,
		enabled: webhook.enabled,
		createdAt: webhook.createdAt,
		// The API shows the signing secret once, when it is made; after that its start isn't known.
		secretPrefix,
		...(webhook.lastDelivery === undefined ? {} : { lastDelivery: lastDeliveryOf(webhook.lastDelivery) }),
	};
}

function deliveryOf(delivery: WebhookDelivery): UiWebhookDelivery {
	return {
		id: delivery.id,
		event: delivery.eventType,
		at: delivery.deliveredAt ?? delivery.createdAt,
		...(delivery.lastStatus === undefined ? {} : { status: delivery.lastStatus }),
		// The API doesn't time a delivery.
		durationMs: 0,
		attempt: delivery.attempts,
		ok: delivery.state === "delivered",
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Environments and a sandbox's egress (TASK-4826). The API leaves an empty list out of a binding or a grant (any path,
// any method); the UI keeps it as `[]`. A protected variable's value is write-only on both sides: the API never
// answers one, and the UI sends one only when it is new or rotated.

/**
 * The UI's methods are the common seven; the API takes any method in capitals. One outside the seven, set through the
 * API, is kept as it is rather than dropped: dropping the only method of a binding or a grant would widen it to every
 * method, and a save from the page would send it back so.
 */
const uiMethods = (methods: readonly string[] | undefined): readonly UiMethod[] =>
	(methods ?? []) as readonly UiMethod[];

const bindingOf = (binding: ApiBinding): UiBinding => ({
	host: binding.host,
	pathPrefixes: binding.pathPrefixes ?? [],
	methods: uiMethods(binding.methods),
});

const apiBinding = (binding: UiBinding): ApiBinding => ({
	host: binding.host,
	...(binding.pathPrefixes.length === 0 ? {} : { pathPrefixes: binding.pathPrefixes }),
	...(binding.methods.length === 0 ? {} : { methods: binding.methods }),
});

const variableOf = (variable: ApiVariable): UiVariable => ({
	name: variable.name,
	protected: variable.protected,
	// The API answers a plain variable's value only.
	...(variable.value === undefined ? {} : { value: variable.value }),
	bindings: variable.bindings.map(bindingOf),
	updatedAt: variable.updatedAt,
});

const fileOf = (file: ApiEnvironment["files"][number]): UiEnvironmentFile => ({
	path: file.path,
	mode: file.mode,
	sizeBytes: file.sizeBytes,
	updatedAt: file.updatedAt,
});

const repoOf = (repo: ApiRepo): UiRepo => ({
	url: repo.url,
	...(repo.path === undefined ? {} : { path: repo.path }),
	...(repo.ref === undefined ? {} : { ref: repo.ref }),
});

// The UI's repository has the API's fields; a ref that is a commit, which the UI's hint allows, the API refuses: it
// clones a branch or a tag.
const apiRepo = (repo: UiRepo): ApiRepo => ({
	url: repo.url,
	...(repo.path === undefined || repo.path === "" ? {} : { path: repo.path }),
	...(repo.ref === undefined || repo.ref === "" ? {} : { ref: repo.ref }),
});

const grantOf = (grant: ApiGrant): UiGrant => ({
	id: grant.id,
	action: grant.action,
	host: grant.host,
	methods: uiMethods(grant.methods),
	paths: grant.paths ?? [],
});

/** A grant the page has just added has an ID of the page's making (`grt_new_1`): the API gives it its own. */
const NEW_GRANT = /^grt_new_/;

const grantInput = (grant: UiGrant): EgressGrantInput => ({
	...(NEW_GRANT.test(grant.id) ? {} : { id: grant.id }),
	action: grant.action,
	host: grant.host,
	...(grant.methods.length === 0 ? {} : { methods: grant.methods }),
	...(grant.paths.length === 0 ? {} : { paths: grant.paths }),
});

/** A grant write's `expected`: the grants as read, so Kantel refuses the write if they have changed since. */
const expectedOf = (expected: readonly UiGrant[] | undefined): { expected?: EgressGrantInput[] } =>
	expected === undefined ? {} : { expected: expected.map(grantInput) };

const environmentOf = (environment: ApiEnvironment): UiEnvironment => ({
	id: environment.id,
	accountId: environment.accountId,
	name: environment.name,
	...(environment.description === undefined ? {} : { description: environment.description }),
	variables: environment.variables.map(variableOf),
	files: environment.files.map(fileOf),
	repos: environment.repos.map(repoOf),
	grants: environment.grants.map(grantOf),
	sandboxCount: environment.sandboxCount,
	createdAt: environment.createdAt,
	updatedAt: environment.updatedAt,
});

const egressEntryOf = (entry: ApiEgressEntry): UiEgressEntry => {
	// A refusal's `X-Kantel-Proxy-Error` code says why when the proxy gave no reason in words.
	const reason = entry.reason ?? entry.code;
	return {
		id: entry.id,
		at: entry.at,
		method: entry.method,
		host: entry.host,
		port: entry.port,
		...(entry.path === undefined ? {} : { path: entry.path }),
		decision: entry.decision,
		...(reason === undefined ? {} : { reason }),
		...(entry.rule === undefined ? {} : { rule: entry.rule }),
		...(entry.code === undefined ? {} : { code: entry.code }),
		swapped: entry.swapped,
		inspected: entry.inspected,
		...(entry.status === undefined ? {} : { status: entry.status }),
		bytesUp: entry.bytesUp,
		bytesDown: entry.bytesDown,
	};
};

const sandboxEgressOf = (egress: ApiSandboxEgress): UiSandboxEgress => ({
	sandboxId: egress.sandboxId,
	sandboxName: egress.sandboxName,
	accountId: egress.accountId,
	...(egress.environment === undefined
		? {}
		: { environment: { id: egress.environment.id, name: egress.environment.name } }),
	protectedVariables: egress.protectedVariables.map((variable) => ({
		name: variable.name,
		placeholderPrefix: variable.placeholderPrefix,
		bindings: variable.bindings.map(bindingOf),
	})),
	environmentGrants: egress.environmentGrants.map(grantOf),
	grants: egress.grants.map(grantOf),
	// The API's newest 100 (its default), newest first; the page has no paging.
	entries: egress.entries.map(egressEntryOf),
});

function environmentsSource(context: Context): EnvironmentsSource {
	const { api } = context;
	const view = (environment: ApiEnvironment): UiEnvironment => {
		context.environmentNames.set(environment.id, environment.name);
		return environmentOf(environment);
	};
	return {
		// As the deployment says on the caller: one with no secrets key refuses protected values, so the page offers none.
		...(context.caller.protectedValues === false ? { protectedValues: false } : {}),
		list: async (accountId) => (await api.listEnvironments({ account: accountId })).items.map(view),
		get: async (id) => view(await api.getEnvironment(id)),
		create: async (input) =>
			view(
				await api.createEnvironment({
					account: input.accountId,
					name: input.name,
					...(input.description === undefined || input.description === "" ? {} : { description: input.description }),
				}),
			),
		// An empty description clears it, as the API's does.
		update: async (id, change) =>
			view(
				await api.updateEnvironment(id, {
					...(change.name === undefined ? {} : { name: change.name }),
					...(change.description === undefined ? {} : { description: change.description }),
				}),
			),
		remove: async (id) => {
			await api.deleteEnvironment(id);
			context.environmentNames.delete(id);
		},
		setVariable: async (id, input) =>
			view(
				await api.setEnvironmentVariable(id, input.name, {
					protected: input.protected,
					// Left out on a protected variable, it keeps its value: a change of its bindings alone.
					...(input.value === undefined ? {} : { value: input.value }),
					// Only a protected variable has bindings: the API refuses them on a plain one.
					...(input.protected ? { bindings: input.bindings.map(apiBinding) } : {}),
				}),
			),
		removeVariable: async (id, name) => view(await api.deleteEnvironmentVariable(id, name)),
		// The page's contents are text, sent as UTF-8.
		setFile: async (id, input) =>
			view(
				await api.setEnvironmentFile(id, {
					path: input.path,
					mode: input.mode,
					...(input.content === undefined ? {} : { content: input.content, encoding: "utf8" as const }),
				}),
			),
		removeFile: async (id, path) => view(await api.deleteEnvironmentFile(id, { path })),
		setRepos: async (id, repos) => view(await api.putEnvironmentRepos(id, { repos: repos.map(apiRepo) })),
		setGrants: async (id, grants, expected) =>
			view(await api.putEnvironmentGrants(id, { grants: grants.map(grantInput), ...expectedOf(expected) })),
	};
}

function egressSource(context: Context): EgressSource {
	const { api } = context;
	const view = (egress: ApiSandboxEgress): UiSandboxEgress => {
		if (egress.environment !== undefined) context.environmentNames.set(egress.environment.id, egress.environment.name);
		return sandboxEgressOf(egress);
	};
	return {
		get: async (sandboxId) => view(await api.getSandboxEgress(sandboxId)),
		setGrants: async (sandboxId, grants, expected) =>
			view(await api.putSandboxGrants(sandboxId, { grants: grants.map(grantInput), ...expectedOf(expected) })),
	};
}

/** The start of a signing secret, to tell webhooks apart: `whsec_9c1e`. */
const secretPrefixOf = (secret: string): string => secret.slice(0, "whsec_".length + 4);

function webhooksSource({ api }: Context): WebhooksSource {
	return {
		list: async (accountId) => (await api.listWebhooks({ account: accountId })).items.map((hook) => webhookOf(hook)),
		create: async (input) => {
			const description = input.description?.trim() ?? "";
			const made = await api.createWebhook({
				account: input.accountId,
				name: description === "" ? input.url : description,
				url: input.url,
				events: input.events,
			});
			return { webhook: webhookOf(made.webhook, secretPrefixOf(made.secret)), secret: made.secret };
		},
		update: async (id, change) => {
			let name: string | undefined;
			if (change.description !== undefined) {
				const description = change.description.trim();
				name = description !== "" ? description : (change.url ?? (await api.getWebhook(id)).url);
			}
			return webhookOf(
				await api.updateWebhook(id, {
					...(name === undefined ? {} : { name }),
					...(change.url === undefined ? {} : { url: change.url }),
					...(change.events === undefined ? {} : { events: change.events }),
					...(change.enabled === undefined ? {} : { enabled: change.enabled }),
				}),
			);
		},
		remove: (id) => api.deleteWebhook(id),
		deliveries: async (id) =>
			(await allPages((cursor) => api.listWebhookDeliveries(id, after(cursor)))).map(deliveryOf),
		test: async (id) => deliveryOf(await api.testWebhook(id)),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenTelemetry

/** The account's export, or undefined when it has none (the API's `not_found`). */
async function readTelemetry(api: KantelClient, accountId: string): Promise<TelemetryExport | undefined> {
	try {
		return await api.getTelemetry({ account: accountId });
	} catch (error) {
		if (isCode(error, "not_found")) return undefined;
		throw error;
	}
}

function telemetryOf(accountId: string, telemetry: TelemetryExport | undefined): UiTelemetrySettings {
	if (telemetry === undefined) {
		// No export: the API keeps nothing while it's off.
		return {
			accountId,
			enabled: false,
			endpoint: "",
			protocol: "http/protobuf",
			headers: [],
			metrics: true,
			events: true,
			attributes: {},
		};
	}
	return {
		accountId: telemetry.accountId,
		// The API has no off switch: an export that exists is on.
		enabled: true,
		endpoint: telemetry.endpoint,
		// The API exports over OTLP/HTTP only.
		protocol: "http/protobuf",
		headers: telemetry.headerNames,
		metrics: telemetry.signals.includes("metrics"),
		events: telemetry.signals.includes("logs"),
		// The API adds no resource attributes.
		attributes: {},
		...(telemetry.lastExport === undefined
			? {}
			: {
					lastExport: {
						at: telemetry.lastExport.at,
						ok: telemetry.lastExport.ok,
						...(telemetry.lastExport.error === undefined ? {} : { message: telemetry.lastExport.error }),
					},
				}),
	};
}

const signalsOf = (metrics: boolean, logs: boolean): ("metrics" | "logs")[] => [
	...(metrics ? (["metrics"] as const) : []),
	...(logs ? (["logs"] as const) : []),
];

function telemetrySource({ api }: Context): TelemetrySource {
	return {
		// The API exports over OTLP/HTTP and adds no resource attributes, so the page offers neither choice.
		protocols: ["http/protobuf"],
		attributes: false,
		get: async (accountId) => telemetryOf(accountId, await readTelemetry(api, accountId)),
		update: async (accountId, change) => {
			if (change.protocol === "grpc") throw notYet("Kantel's API exports over OTLP/HTTP only, not gRPC.");
			if (change.attributes !== undefined && Object.keys(change.attributes).length > 0) {
				throw notYet("Kantel's API can't add resource attributes to exports yet.");
			}
			// Turning export off removes it: the API has no switch, so the endpoint and headers go too.
			if (change.enabled === false || change.endpoint === "") {
				await api.deleteTelemetry({ account: accountId });
				return telemetryOf(accountId, undefined);
			}
			const current = await readTelemetry(api, accountId);
			const changes =
				change.endpoint !== undefined ||
				change.metrics !== undefined ||
				change.events !== undefined ||
				change.headers !== undefined;
			if (!changes) {
				if (change.enabled === true && current === undefined) {
					throw notYet("Save an endpoint first: Kantel's API turns export on by saving one.");
				}
				return telemetryOf(accountId, current);
			}
			const endpoint = change.endpoint ?? current?.endpoint;
			if (endpoint === undefined) throw notYet("Save an endpoint first.");
			const body: PutTelemetryBody = {
				account: accountId,
				endpoint,
				signals: signalsOf(
					change.metrics ?? current?.signals.includes("metrics") ?? true,
					change.events ?? current?.signals.includes("logs") ?? true,
				),
				...headersFor(change.headers, current?.headerNames ?? []),
			};
			return telemetryOf(accountId, (await api.putTelemetry(body)).telemetry);
		},
		test: async (accountId) => {
			// The API tests on save: saving the export as it is sends an empty export and answers what the collector said.
			const current = await readTelemetry(api, accountId);
			if (current === undefined) throw notYet("Save an endpoint first.");
			const { test } = await api.putTelemetry({
				account: accountId,
				endpoint: current.endpoint,
				signals: current.signals,
			});
			if (!test.ok) return { ok: false, message: test.error ?? "The collector didn't take the test export." };
			return {
				ok: true,
				message:
					test.status === undefined ? "The collector took the test export." : `The collector answered ${test.status}.`,
			};
		},
	};
}

/**
 * The headers a telemetry PUT sends. The API replaces every value or keeps them all, and never shows one, so a change
 * that sets or removes some while keeping others can't be sent.
 */
function headersFor(
	change: Readonly<Record<string, string | null>> | undefined,
	saved: readonly string[],
): { readonly headers?: { readonly [name: string]: string } } {
	if (change === undefined) return {};
	const kept = saved.filter((name) => !(name in change));
	if (kept.length > 0) {
		throw notYet("Kantel's API can't change one header and keep the others yet. Enter every header's value again.");
	}
	const headers: { [name: string]: string } = {};
	for (const [name, value] of Object.entries(change)) if (value !== null) headers[name] = value;
	return { headers };
}

// ---------------------------------------------------------------------------------------------------------------------
// Hosts

const UI_HOST_STATES: Readonly<Record<Host["state"], UiHostState>> = {
	online: "online",
	draining: "draining",
	// The UI has no unreachable or revoked: neither takes sandboxes, so both show as offline.
	unreachable: "offline",
	revoked: "offline",
};

/**
 * The hosts New sandbox may put an account's sandbox on: a super-admin's every host that is the account's own or shared,
 * anyone else's the account's own (none where the deployment has no account hosts, or they may not see them).
 */
async function hostChoices({ api, caller }: Context, accountId: string): Promise<readonly HostChoice[]> {
	let hosts: readonly Host[];
	try {
		hosts = caller.superAdmin
			? (await api.listHosts()).items.filter((host) => host.accountId === undefined || host.accountId === accountId)
			: (await api.listAccountHosts({ account: accountId })).items;
	} catch (caught) {
		if (caught instanceof KantelApiError && (caught.code === "not_supported" || caught.code === "forbidden")) return [];
		throw caught;
	}
	return hosts
		.filter((host) => host.state !== "revoked")
		.map((host) => ({
			id: host.id,
			name: host.name,
			state: UI_HOST_STATES[host.state],
			kinds: host.tiers,
			shared: host.accountId === undefined,
		}));
}

function hostOf(host: Host): UiHost {
	const total = host.allocated.sandboxes;
	const microvmsOnly = host.tiers.length === 1 && host.tiers[0] === "microvm";
	return {
		id: host.id,
		name: host.name,
		state: UI_HOST_STATES[host.state],
		// A host that hasn't reported its platform yet: the commonest stands in.
		arch: host.arch ?? "x86_64",
		os: host.os ?? "",
		version: host.version ?? "",
		// The control plane says which hosts are behind: a host on a newer build than the latest release isn't.
		...(host.updateAvailable === true && host.latestVersion !== undefined
			? { updateAvailable: host.latestVersion }
			: {}),
		...(host.updating === undefined
			? {}
			: { updating: { version: host.updating.version, since: host.updating.requestedAt } }),
		vcpus: host.capacity.vcpus,
		memoryGb: host.capacity.memoryMb / 1024,
		diskGb: host.capacity.diskGb,
		used: {
			vcpus: host.allocated.vcpus,
			memoryGb: host.allocated.memoryMb / 1024,
			diskGb: host.allocated.diskGb,
		},
		// The API counts a host's sandboxes but not by type: a host of one type has only that, else they show as isolates.
		sandboxes: microvmsOnly ? { isolates: 0, microvms: total } : { isolates: total, microvms: 0 },
		kvm: host.kvm,
		nestedVirtualisation: host.nestedVirtualisation,
		labels: host.labels,
		// A host not seen since it joined.
		lastSeenAt: host.lastSeenAt ?? host.joinedAt,
		joinedAt: host.joinedAt,
		...(host.diskUsage === undefined
			? {}
			: {
					disk: {
						totalBytes: host.diskUsage.totalBytes,
						usedBytes: host.diskUsage.usedBytes,
						savedSnapshots: host.diskUsage.savedSnapshotsBytes,
						automaticSnapshots: host.diskUsage.automaticSnapshotsBytes,
						sandboxes: host.diskUsage.sandboxesBytes,
						images: host.diskUsage.imagesBytes,
						templates: host.diskUsage.templatesBytes,
						bundles: host.diskUsage.bundlesBytes,
						other: host.diskUsage.otherBytes,
						measuredAt: host.diskUsage.measuredAt,
					},
				}),
		...(host.savedSnapshotBytesLimit === undefined ? {} : { savedSnapshotLimitBytes: host.savedSnapshotBytesLimit }),
	};
}

function hostsSource({ api }: Context): HostsSource {
	return {
		// Removing a host revokes it; the API still lists revoked hosts, the UI doesn't.
		list: async () => (await api.listHosts()).items.filter((host) => host.state !== "revoked").map(hostOf),
		join: async (input) => {
			const made = await api.createHostJoinToken({
				...(input.name === undefined || input.name === "" ? {} : { name: input.name }),
				...(input.labels === undefined ? {} : { labels: input.labels }),
			});
			return { token: made.token, expiresAt: made.expiresAt, command: made.command };
		},
		drain: async (id) => hostOf(await api.updateHost(id, { draining: true })),
		undrain: async (id) => hostOf(await api.updateHost(id, { draining: false })),
		remove: async (id) => {
			await api.revokeHost(id);
		},
		update: async (id) => hostOf(await api.updateHostAgent(id)),
		setSnapshotLimit: async (id, bytes) => hostOf(await api.updateHost(id, { savedSnapshotBytesLimit: bytes })),
		checkForUpdates: () => api.checkHostUpdates(),
		publicUrl: {
			get: async () => publicUrlOf(await api.getPublicUrl()),
			set: async (url) => publicUrlOf(await api.setPublicUrl({ publicUrl: url })),
		},
	};
}

function publicUrlOf(made: PublicUrl): UiPublicUrl {
	return {
		publicUrl: made.publicUrl,
		setHere: made.source === "console",
		deploymentUrl: made.deploymentUrl,
		loopback: made.loopback,
	};
}

function imageVersionOf(version: ApiBaseImageVersion): UiBaseImageVersion {
	const builtAt = msOf(version.builtAt);
	return {
		version: version.version,
		digest: version.digest,
		builtAt,
		signed: version.signed,
		...(version.reason === undefined ? {} : { reason: version.reason }),
		...(version.scan === undefined
			? {}
			: {
					scan: {
						scanner: version.scan.scanner,
						// A scan whose time doesn't parse shows as when the version was built.
						scannedAt: msOf(version.scan.scannedAt, builtAt),
						counts: version.scan.counts,
						fixable: version.scan.fixable,
						findings: version.scan.findings,
					},
				}),
	};
}

function baseImageOf(image: ApiBaseImage): UiBaseImage {
	return {
		name: image.name,
		repository: image.repository,
		channel: image.channel,
		...(image.latest === undefined ? {} : { latest: imageVersionOf(image.latest) }),
		versions: image.versions.map(imageVersionOf),
	};
}

function templateBaseOf(template: ApiTemplateBase): UiTemplateBase {
	return {
		id: template.id,
		name: template.name,
		image: template.image,
		...(template.channel === undefined ? {} : { channel: template.channel }),
		...(template.pinned === undefined ? {} : { pinned: template.pinned }),
		base: baseOf(template.base),
		rebuilding: template.rebuilding,
	};
}

/** The deployment's base images and templates (`/v1/admin/hosts/images`, super-admin, experimental). */
function imagesSource({ call }: Context): BaseImagesSource {
	return {
		overview: async () => {
			const overview = await call<ApiImagesOverview>({ method: "GET", path: "/admin/hosts/images" });
			return {
				images: overview.images.map(baseImageOf),
				templates: overview.templates.map(templateBaseOf),
				indexUrl: overview.indexUrl,
				...(overview.generatedAt === undefined ? {} : { generatedAt: msOf(overview.generatedAt) }),
				...(overview.error === undefined ? {} : { error: overview.error }),
			};
		},
	};
}

/** An account's own hosts (`/v1/hosts`, experimental): the same page, scoped to the account. */
function ownHostsSource({ api }: Context, accountId: string): HostsSource {
	return {
		list: async () =>
			(await api.listAccountHosts({ account: accountId })).items.filter((host) => host.state !== "revoked").map(hostOf),
		join: async (input) => {
			const made = await api.createAccountJoinToken({
				account: accountId,
				...(input.name === undefined || input.name === "" ? {} : { name: input.name }),
				...(input.labels === undefined ? {} : { labels: input.labels }),
			});
			return { token: made.token, expiresAt: made.expiresAt, command: made.command };
		},
		drain: async (id) => hostOf(await api.updateAccountHost(id, { draining: true })),
		undrain: async (id) => hostOf(await api.updateAccountHost(id, { draining: false })),
		remove: async (id) => {
			await api.removeAccountHost(id);
		},
		update: async (id) => hostOf(await api.updateAccountHostAgent(id)),
		setSnapshotLimit: async (id, bytes) => hostOf(await api.updateAccountHost(id, { savedSnapshotBytesLimit: bytes })),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Templates (experimental)

/** The API answers a spec with every default filled in; these stand in should one be missing. */
const DEFAULT_BASE = { image: "kantel/sandbox", channel: "stable" } as const;
const KANTEL_BASE = { kind: "kantel-base" } as const;

const templateSpecOf = (spec: ApiTemplateSpec): UiTemplateSpec => {
	const base = spec.base ?? DEFAULT_BASE;
	return {
		image: spec.image ?? KANTEL_BASE,
		base: "digest" in base ? { image: base.image, digest: base.digest } : { image: base.image, channel: base.channel },
		vcpus: spec.resources?.vcpus ?? 2,
		memoryMb: spec.resources?.memoryMb ?? 4096,
		env: spec.env ?? {},
		...(spec.setup === undefined || spec.setup === "" ? {} : { setup: spec.setup }),
		// A template's grants are inputs: one without an ID gets one of the page's making, which grantInput drops again.
		grants: (spec.network?.grants ?? []).map((grant, at) => ({
			id: grant.id ?? `grt_new_tpl_${at}`,
			action: grant.action,
			host: grant.host,
			methods: uiMethods(grant.methods),
			paths: grant.paths ?? [],
		})),
	};
};

const apiTemplateSpec = (spec: UiTemplateSpec): ApiTemplateSpec => ({
	image: spec.image,
	base:
		spec.base.digest !== undefined
			? { image: spec.base.image, digest: spec.base.digest }
			: { image: spec.base.image, channel: spec.base.channel },
	resources: { vcpus: spec.vcpus, memoryMb: spec.memoryMb },
	env: { ...spec.env },
	...(spec.setup === undefined ? {} : { setup: spec.setup }),
	network: { grants: spec.grants.map(grantInput) },
});

const templateSnapshotOf = (entry: ApiTemplateSnapshot): UiTemplateSnapshot => ({
	id: entry.id,
	version: entry.version,
	state: entry.state,
	key: entry.key,
	keyHash: entry.keyHash,
	...(entry.hostId === undefined ? {} : { hostId: entry.hostId }),
	builtFrom: {
		baseImage: entry.builtFrom.baseImage,
		...(entry.builtFrom.channel === undefined ? {} : { channel: entry.builtFrom.channel }),
		baseDigest: entry.builtFrom.baseDigest,
		pinned: entry.builtFrom.pinned,
		...(entry.builtFrom.imageDigest === undefined ? {} : { imageDigest: entry.builtFrom.imageDigest }),
		...(entry.builtFrom.source === undefined ? {} : { source: entry.builtFrom.source }),
		...(entry.builtFrom.dockerfileDigest === undefined ? {} : { dockerfileDigest: entry.builtFrom.dockerfileDigest }),
		...(entry.builtFrom.imageRef === undefined ? {} : { imageRef: entry.builtFrom.imageRef }),
	},
	startedAt: entry.startedAt,
	...(entry.readyAt === undefined ? {} : { readyAt: entry.readyAt }),
	...(entry.error === undefined ? {} : { error: entry.error }),
	...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
});

const templateOf = (template: ApiTemplate): UiTemplate => ({
	id: template.id,
	accountId: template.accountId,
	name: template.name,
	...(template.description === undefined || template.description === "" ? {} : { description: template.description }),
	version: template.version,
	spec: templateSpecOf(template.spec),
	build: {
		state: template.build.state,
		...(template.build.ready === undefined ? {} : { ready: templateSnapshotOf(template.build.ready) }),
		...(template.build.building === undefined ? {} : { building: templateSnapshotOf(template.build.building) }),
		...(template.build.error === undefined ? {} : { error: template.build.error }),
		...(template.build.behind === undefined ? {} : { behind: template.build.behind }),
	},
	sandboxCount: template.sandboxCount,
	createdAt: template.createdAt,
	updatedAt: template.updatedAt,
});

function templatesSource({ api }: Context): TemplatesSource {
	return {
		list: async (accountId) => (await api.listTemplates({ account: accountId })).items.map(templateOf),
		get: async (id) => templateOf(await api.getTemplate(id)),
		create: async (input) =>
			templateOf(
				await api.createTemplate({
					account: input.accountId,
					name: input.name,
					...(input.description === undefined || input.description === "" ? {} : { description: input.description }),
					spec: apiTemplateSpec(input.spec),
				}),
			),
		// An empty description clears it, as the API's does; a spec that differs makes the next version.
		update: async (id, change) =>
			templateOf(
				await api.updateTemplate(id, {
					...(change.name === undefined ? {} : { name: change.name }),
					...(change.description === undefined ? {} : { description: change.description }),
					...(change.spec === undefined ? {} : { spec: apiTemplateSpec(change.spec) }),
				}),
			),
		remove: async (id) => {
			await api.deleteTemplate(id);
		},
		versions: async (id) =>
			(await api.listTemplateVersions(id)).items.map((entry) => ({
				version: entry.version,
				spec: templateSpecOf(entry.spec),
				createdAt: entry.createdAt,
				by: actorName(entry.createdBy),
			})),
		snapshots: async (id) => (await api.listTemplateSnapshots(id)).items.map(templateSnapshotOf),
		bases: async () =>
			(await api.listTemplateBases()).items.map((entry) => ({
				image: entry.image,
				channel: entry.channel,
				digest: entry.digest,
				publishedAt: entry.publishedAt,
				history: entry.history.map((release) => ({ digest: release.digest, publishedAt: release.publishedAt })),
			})),
		rebuild: async (id) => templateOf(await api.rebuildTemplate(id)),
	};
}

/** Whether the deployment has templates turned on (experimental): it answers `not_supported` when it hasn't. */
async function offersTemplates({ api }: Context): Promise<boolean> {
	try {
		await api.listTemplates({});
		return true;
	} catch (caught) {
		return !(caught instanceof KantelApiError && caught.code === "not_supported");
	}
}

/** Whether the deployment lets accounts add hosts of their own: it answers `not_supported` when it doesn't. */
/**
 * Whether the gateway has image patching on (KANTEL_IMAGE_PATCHING), so Admin > Images has something to show: off, its
 * overview answers `not_supported`. An index the gateway can't read still opens the page, which says so.
 */
async function offersImages({ call }: Context): Promise<boolean> {
	try {
		await call<ApiImagesOverview>({ method: "GET", path: "/admin/hosts/images" });
		return true;
	} catch (caught) {
		return !(caught instanceof KantelApiError && caught.code === "not_supported");
	}
}

async function offersOwnHosts({ api }: Context): Promise<boolean> {
	try {
		await api.listAccountHosts({});
		return true;
	} catch (caught) {
		return !(caught instanceof KantelApiError && caught.code === "not_supported");
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Read-only mounts (experimental): bundles and bucket sources. Both are made with the API; the console lists and
// deletes them. A digest names a bundle only within its account, so a bundle's delete names the account too.

const bundleOf = (bundle: ApiBundle): UiBundle => ({
	digest: bundle.digest,
	accountId: bundle.accountId,
	sizeBytes: bundle.sizeBytes,
	mountedBy: bundle.mountedBy,
	createdAt: bundle.createdAt,
});

const bucketSourceOf = (source: ApiBucketSource): UiBucketSource => ({
	id: source.id,
	accountId: source.accountId,
	name: source.name,
	provider: source.provider,
	bucket: source.bucket,
	...(source.endpoint === undefined ? {} : { endpoint: source.endpoint }),
	...(source.region === undefined ? {} : { region: source.region }),
	// Whether it has credentials, never what they are: the API never answers them.
	hasCredentials: source.hasCredentials,
	mountedBy: source.mountedBy,
	createdAt: source.createdAt,
});

function mountsSource(context: Context): UiMounts {
	const { api } = context;
	return {
		bundles: async (accountId) => (await api.listBundles({ account: accountId })).items.map(bundleOf),
		removeBundle: (accountId, digest) => api.deleteBundle(digest, { account: accountId }),
		bucketSources: async (accountId) =>
			(await api.listBucketSources({ account: accountId })).items.map((source) => {
				context.bucketSources.set(source.id, { name: source.name, bucket: source.bucket });
				return bucketSourceOf(source);
			}),
		removeBucketSource: async (id) => {
			await api.deleteBucketSource(id);
			context.bucketSources.delete(id);
		},
	};
}

/**
 * Whether the deployment has turned mounts on: it answers `not_supported` when it hasn't, and a gateway from before
 * mounts answers 404. Any other answer (a key that can't read sandboxes) leaves them on, as with account hosts.
 */
async function offersMounts({ api }: Context): Promise<boolean> {
	try {
		await api.listBundles({});
		return true;
	} catch (caught) {
		return !(caught instanceof KantelApiError && (caught.code === "not_supported" || caught.status === 404));
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Everything

/** The page's own host, outside a browser none. */
const pageHost = (): string | undefined => {
	const host = (globalThis as { location?: { host?: string } }).location?.host;
	return host === undefined || host === "" ? undefined : host;
};

/**
 * The compute console on the gateway this console is served by. Asks who is calling first: a gateway that doesn't
 * serve the compute routes answers 404, this throws, and the console shows no compute pages. The
 * hosts and images sources are there only for a deployment super-admin; billing isn't, as the API has no plans.
 */
export async function apiCompute(options: ComputeApiOptions = {}): Promise<ComputeSource> {
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	const watched: typeof fetch = async (input, init) => {
		const response = await doFetch(input, init);
		if (response.status === 401) options.onUnauthenticated?.();
		return response;
	};
	const clientOptions: KantelClientOptions = {
		baseUrl: options.baseUrl ?? "/v1",
		...(options.headers === undefined ? {} : { headers: options.headers }),
		fetch: watched,
	};
	const api = createKantelClient(clientOptions);
	// The probe: the routes are served, and who is calling.
	const caller = await api.getCaller();

	// The domain sandbox addresses are under. A deployment that has one names it on the caller (`sandboxDomain`): the
	// hosted service's is kantel.run, a domain apart from the console's, so the page's own host is never it. One that
	// names none answers only its subdomain. The one hostname it does answer is its SSH gateway's, `ssh.<domain>` as
	// the UI's `sshCommand` writes it, so once an access call has given one the domain comes from that. Until then the
	// page's own host is the nearest guess (a self-hosted install serves the console and its sandboxes under one name),
	// and outside a browser, as in tests, "localhost".
	const named = caller.sandboxDomain?.trim().toLowerCase() || undefined;
	let learned: string | undefined;
	const fallback = pageHost() ?? "localhost";
	const context: Context = {
		api,
		hosting: options.hosting ?? "self-hosted",
		domain: () => named ?? learned ?? fallback,
		learnHost: (host) => {
			learned = host.replace(/^ssh\./, "");
		},
		caller,
		environmentNames: new Map(),
		call: <T>(call: ApiCall) => send<T>(clientOptions, call),
		bucketSources: new Map(),
		live: liveSandboxes(api),
	};
	// What the deployment offers beyond the core, each asked once: an account's own hosts, for anyone but a super-admin,
	// and read-only mounts.
	const [ownHostsOffered, mountsOffered] = await Promise.all([
		caller.superAdmin ? false : offersOwnHosts(context),
		offersMounts(context),
	]);
	// The live graphs' reads, all in live-usage.ts.
	const usage = liveUsage(api);

	return {
		hosting: context.hosting,
		get domain() {
			return context.domain();
		},
		accounts: accountsSource(context),
		sandboxes: { ...withUsage(sandboxesSource(context), "usageSeries", usage.sandbox), usageHistory: usage.history },
		snapshots: snapshotsSource(context),
		keys: keysSource(context),
		proxy: proxySource(context),
		environments: environmentsSource(context),
		...((await offersTemplates(context)) ? { templates: templatesSource(context) } : {}),
		egress: egressSource(context),
		webhooks: webhooksSource(context),
		telemetry: telemetrySource(context),
		...(caller.superAdmin ? { hosts: withUsage(hostsSource(context), "usage", usage.host) } : {}),
		...(caller.superAdmin && (await offersImages(context)) ? { images: imagesSource(context) } : {}),
		// Anyone else manages their accounts' own hosts, where the deployment allows it.
		...(ownHostsOffered
			? {
					ownHosts: (accountId: string) =>
						withUsage(ownHostsSource(context, accountId), "usage", usage.ownHost(accountId)),
				}
			: {}),
		// Bundles and bucket sources, where the deployment has turned mounts on; absent, nothing about mounts is shown.
		...(mountsOffered ? { mounts: mountsSource(context) } : {}),
		// Only a person approves a device; a console signed in with a key has nothing to approve with.
		...(caller.apiKey === undefined ? { devices: devicesSource(context) } : {}),
	};
}
