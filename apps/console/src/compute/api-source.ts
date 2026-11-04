// The compute console's source over Kantel's public compute API (`@kantel/api`'s generated SDK, `/v1/whoami`,
// `/v1/sandboxes` and the rest), for when the console talks to a real compute plane rather than `@kantel/ui`'s
// fixtures. Same-origin under /v1, like the Environments page: behind Cloudflare Access the browser's cookie signs each
// call in; signed in another way, `headers` adds the bearer.
//
// A gateway that doesn't serve the routes (an older one, or one built without compute) answers 404 to the first call,
// and `apiCompute` throws. The UI's records are shaped for its pages, not the API, so each source maps the API's records
// field by field. Where the UI has a field the API lacks, a neutral value stands in, with a comment saying so; where
// the UI asks for something no route does, the call rejects with a sentence saying Kantel's API can't do it yet.
// Timestamps need no conversion: both sides use epoch milliseconds. The account goes in the query of a read and in
// the body of a write, as the contract's `account` field says.

import {
	type Account,
	type DestinationBinding as ApiBinding,
	type EgressEntry as ApiEgressEntry,
	type Environment as ApiEnvironment,
	type EgressGrant as ApiGrant,
	type ApiKey,
	type EnvironmentRepo as ApiRepo,
	type SandboxEgress as ApiSandboxEgress,
	type EnvironmentVariable as ApiVariable,
	type Caller,
	type Command,
	type CreatedBy,
	createKantelClient,
	type DeviceLoginRequest,
	type EgressGrantInput,
	type FileEntry,
	type Host,
	type Invite,
	KantelApiError,
	type KantelClient,
	type KantelClientOptions,
	type Member,
	type ProxySettings,
	type PutProxySettingsBody,
	type PutTelemetryBody,
	type Sandbox,
	type SandboxSizeName,
	type SandboxState,
	type Snapshot,
	type TelemetryExport,
	type Webhook,
	type WebhookDelivery,
	type WebhookLastDelivery,
} from "@kantel/api/sdk";
import type {
	AccountsSource,
	ApiKeysSource,
	ComputeAccount,
	ComputeSource,
	ComputeViewer,
	DeviceLogin,
	DeviceLoginsSource,
	E2EMode,
	EgressSource,
	EnvironmentsSource,
	HostingMode,
	HostsSource,
	ProxySource,
	SandboxesSource,
	SnapshotsSource,
	TelemetrySource,
	DestinationBinding as UiBinding,
	EgressEntry as UiEgressEntry,
	Environment as UiEnvironment,
	EgressGrant as UiGrant,
	SandboxEgress as UiSandboxEgress,
	EnvironmentVariable as UiVariable,
	WebhooksSource,
} from "@kantel/ui";
import { type BrowserDevice, type BrowserDeviceOptions, browserDevice } from "./browser-device.ts";
import type { HostCommand, HostCommandPage, LocalBridge } from "./local.ts";

// `@kantel/ui` exports the sources but not every record they carry, so the records are read off the sources' methods.
type UiMember = Awaited<ReturnType<AccountsSource["members"]>>[number];
type UiInvite = Awaited<ReturnType<AccountsSource["invites"]>>[number];
type UiSandbox = Awaited<ReturnType<SandboxesSource["list"]>>[number];
type UiSandboxSize = UiSandbox["size"];
type UiSandboxState = UiSandbox["state"];
type UiCommand = Awaited<ReturnType<SandboxesSource["history"]>>[number];
type UiSandboxSnapshot = Awaited<ReturnType<SnapshotsSource["history"]>>[number];
type UiSnapshotReason = UiSandboxSnapshot["reason"];
type UiSavedSnapshot = Awaited<ReturnType<SnapshotsSource["saved"]>>[number];
type UiSnapshotEntry = Awaited<ReturnType<SnapshotsSource["list"]>>[number];
type UiApiKey = Awaited<ReturnType<ApiKeysSource["list"]>>[number];
type UiProxySettings = Awaited<ReturnType<ProxySource["get"]>>;
type UiEgressPolicy = UiProxySettings["policy"];
type UiWebhook = Awaited<ReturnType<WebhooksSource["list"]>>[number];
type UiWebhookDelivery = Awaited<ReturnType<WebhooksSource["test"]>>;
type UiTelemetrySettings = Awaited<ReturnType<TelemetrySource["get"]>>;
type UiHost = Awaited<ReturnType<HostsSource["list"]>>[number];
type UiHostState = UiHost["state"];
type UiEnvironmentFile = UiEnvironment["files"][number];
type UiRepo = UiEnvironment["repos"][number];
type UiMethod = UiBinding["methods"][number];

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
	/** `kantel console`'s bridge, when it serves this page (local.ts). */
	readonly local?: LocalBridge;
	/** Where this browser keeps its device keys when the gateway serves the page (default IndexedDB), for tests. */
	readonly browser?: Omit<BrowserDeviceOptions, "gateway" | "user">;
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
	/** Sandboxes' accounts by ID, as last read: which one's chain decides where its commands are read from. */
	readonly sandboxAccounts: Map<string, string>;
	readonly local?: LocalBridge;
	/** This browser as a device of its own, when the gateway serves the page to a person (browser-device.ts). */
	readonly browser?: BrowserDevice;
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared

/** The most pages a list follows before it stops: 20 of the API's default 50 is 1000 records. */
const MAX_PAGES = 20;

/** Every page of a list, following `nextCursor` up to `MAX_PAGES` pages. */
async function allPages<T>(
	read: (cursor: string | undefined) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string }>,
): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const answer = await read(cursor);
		items.push(...answer.items);
		if (answer.nextCursor === undefined) break;
		cursor = answer.nextCursor;
	}
	return items;
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
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Sandboxes

const API_SIZES: Readonly<Record<UiSandboxSize, SandboxSizeName>> = {
	small: "small",
	medium: "default",
	large: "large",
	xlarge: "xlarge",
};

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

function sandboxOf(sandbox: Sandbox, context: Context): UiSandbox {
	return {
		id: sandbox.id,
		name: sandbox.name,
		hostname: `${sandbox.subdomain}.${context.domain()}`,
		accountId: sandbox.accountId,
		kind: sandbox.type,
		// Isolates have no size in the API; the smallest stands in.
		size: sandbox.size === undefined ? "small" : UI_SIZES[sandbox.size],
		// What the host gave it, which the backend decides: the page shows this rather than the sample's figures.
		...(sandbox.resources === undefined
			? {}
			: {
					resources: {
						vcpus: sandbox.resources.vcpus,
						memoryGb: Math.round(sandbox.resources.memoryMb / 1024),
						diskGb: sandbox.resources.diskGb,
					},
				}),
		state: UI_STATES[sandbox.state],
		createdAt: sandbox.createdAt,
		createdBy: actorName(sandbox.createdBy),
		...(sandbox.stopsAt === undefined ? {} : { stopsAt: sandbox.stopsAt }),
		...(sandbox.latestSnapshotId === undefined
			? {}
			: {
					snapshot: {
						id: sandbox.latestSnapshotId,
						// The API names the snapshot but not when it was taken; a stop takes one, so the stop is nearest.
						takenAt: sandbox.stoppedAt ?? sandbox.startedAt ?? sandbox.createdAt,
					},
				}),
		// Hosted only: the API's cost is in its currency's units, the UI's in cents.
		...(context.hosting === "hosted" ? { costCents: Math.round(sandbox.cost.total * 100) } : {}),
		usage: sandbox.usage.recentCpu,
		...(sandbox.hostId === undefined ? {} : { hostId: sandbox.hostId }),
		...(sandbox.state === "error" && sandbox.reason !== undefined ? { error: sandbox.reason } : {}),
		shared: sandbox.visibility === "organisation",
		...(sandbox.source?.sandboxId === undefined ? {} : { forkedFrom: sandbox.source.sandboxId }),
		...environmentRefOf(sandbox, context),
	};
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
	};
}

function sandboxesSource(context: Context): SandboxesSource {
	const { api } = context;
	const view = (sandbox: Sandbox) => {
		context.sandboxAccounts.set(sandbox.id, sandbox.accountId);
		return sandboxOf(sandbox, context);
	};
	return {
		// The backend decides what each size is, and the API doesn't list them.
		sizeFigures: false,
		list: async (accountId) => {
			const sandboxes = await allPages((cursor) =>
				api.listSandboxes({ account: accountId, all: true, ...after(cursor) }),
			);
			await learnEnvironmentNames(context, accountId, sandboxes);
			return sandboxes.map(view);
		},
		create: async (input) => {
			const made = await api.createSandbox({
				account: input.accountId,
				type: input.kind,
				// Isolates have no size: the API refuses one.
				...(input.kind === "microvm" ? { size: API_SIZES[input.size] } : {}),
				...(input.name === undefined || input.name === "" ? {} : { name: input.name }),
				...(input.fromSnapshot === undefined ? {} : { from: input.fromSnapshot }),
				// The API takes an environment's ID or its name; the UI picks by ID.
				...(input.environmentId === undefined || input.environmentId === ""
					? {}
					: { environment: input.environmentId }),
				// The UI's absent auto-stop is always on, the API's `null`.
				autoStopMinutes: input.autoStopMinutes ?? null,
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
		remove: async (id) => {
			await api.deleteSandbox(id);
		},
		access: async (id) => {
			// microVMs only: an isolate's `not_supported` rejects the lot. SSH's private key, when Kantel makes one, has no
			// place in the UI's access and is dropped.
			const [ssh, desktop, watch, browser] = await Promise.all([
				api.openSsh(id),
				api.openDesktop(id),
				api.openDesktop(id, { viewOnly: true }),
				api.openBrowser(id),
			]);
			context.learnHost(ssh.host);
			return { ssh: ssh.command, desktopUrl: desktop.url, desktopViewUrl: watch.url, browserUrl: browser.url };
		},
		history: async (id) => {
			// End to end, the host keeps the history and the gateway has none of it: `kantel console` reads it there, or
			// this browser does over its own session once it is a device in the chain.
			const { local, browser } = context;
			const account = context.sandboxAccounts.get(id);
			if (local !== undefined && account !== undefined && local.mode(account) !== "off") {
				return hostHistory((params) => local.call<HostCommandPage>(id, "sandbox.history", params));
			}
			if (browser !== undefined && account !== undefined && (await chainMode(context, account)) !== "off") {
				return hostHistory((params) => browser.call<HostCommandPage>(id, "sandbox.history", params));
			}
			return (await allPages((cursor) => api.listCommands(id, after(cursor)))).map(commandOf);
		},
	};
}

/** Every page of a sandbox's history its host keeps, by its cursor; the list shows no output, so none is carried. */
async function hostHistory(read: (params: object) => Promise<HostCommandPage>): Promise<UiCommand[]> {
	const commands = await allPages(async (cursor) => {
		const page = await read({ limit: 100, output: false, ...(cursor === undefined ? {} : { before: cursor }) });
		return { items: page.items, ...(page.next === undefined || page.next === "" ? {} : { nextCursor: page.next }) };
	});
	return commands.map(hostCommandOf);
}

function hostCommandOf(command: HostCommand): UiCommand {
	return {
		id: command.id,
		command: command.command ?? (command.argv ?? []).join(" "),
		startedAt: command.startedAt,
		durationMs: Math.max(0, command.endedAt - command.startedAt),
		...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
		// The device that ran it, by its label in the chain.
		by: command.deviceLabel ?? command.device,
	};
}

/** An account's mode, for the strip over the page: from its chain's entries as the gateway has them, not verified. */
async function chainMode(context: Context, accountId: string): Promise<E2EMode> {
	const { entries } = await context.api.getE2EChain(accountId);
	let mode: E2EMode = "off";
	for (const entry of entries) {
		try {
			const payload = JSON.parse(new TextDecoder().decode(base64url(entry.payload))) as {
				readonly type?: string;
				readonly body?: { readonly mode?: string };
			};
			const named = payload.body?.mode;
			const sets = payload.type === "genesis" || payload.type === "mode";
			if (sets && (named === "on" || named === "strict" || named === "off")) mode = named;
		} catch {
			// An entry that doesn't read says nothing here; hosts and devices refuse the chain.
		}
	}
	return mode;
}

function base64url(text: string): Uint8Array {
	const padded = text
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(text.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
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
		createdAt: snapshot.createdAt,
		// The API doesn't say who saved a snapshot.
		createdBy: "",
		// The API leaves the size out while it is unknown.
		sizeBytes: snapshot.sizeBytes ?? 0,
		// The API doesn't count the sandboxes started from a snapshot.
		uses: 0,
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
		save: async (sandboxId, name) => {
			const [snapshot, sandbox] = await Promise.all([api.saveSnapshot({ name, sandboxId }), api.getSandbox(sandboxId)]);
			return savedSnapshotOf(snapshot, sandbox.name);
		},
		removeSaved: (id) => api.deleteSnapshot(id),
		removeSnapshot: (id) => api.deleteSnapshot(id),
		list: async (snapshotId, path) =>
			(await allPages((cursor) => api.listSnapshotFiles(snapshotId, { path: absolute(path), ...after(cursor) })))
				.map(entryOf)
				.sort(foldersFirst),
		read: async (snapshotId, path) => {
			try {
				const file = await api.readSnapshotFile(snapshotId, { path: absolute(path) });
				return file.encoding === "utf8" ? file.content : undefined;
			} catch (error) {
				// The API refuses a file that isn't UTF-8 text or is over 1 MiB as `invalid`: the UI's undefined.
				if (isCode(error, "invalid")) return undefined;
				throw error;
			}
		},
		// The API has no download route, and a link can't carry the bearer a read needs: no Download.
		downloadUrl: () => undefined,
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
		// The API doesn't inspect HTTPS.
		tlsInspection: false,
		// The API adds no headers to sandboxes' requests.
		headers: [],
		// The API keeps no request log.
		logRequests: false,
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

function proxySource({ api }: Context): ProxySource {
	return {
		get: async (accountId) => proxyOf(await api.getProxySettings({ account: accountId })),
		update: async (accountId, change) => {
			if (change.tlsInspection === true) throw notYet("Kantel's API can't inspect HTTPS requests yet.");
			if (change.headers !== undefined && change.headers.length > 0) {
				throw notYet("Kantel's API can't add headers to sandboxes' requests yet.");
			}
			if (change.logRequests === true) throw notYet("Kantel's API can't keep a log of proxy requests yet.");
			// A PUT replaces the settings, so what the change leaves out is sent as it is now.
			const current = await api.getProxySettings({ account: accountId });
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
			const body: PutProxySettingsBody = {
				account: accountId,
				enabled: change.enabled ?? current.enabled,
				defaultAction: policy === "open" ? "allow" : "deny",
				// Closed is deny with nothing allowed.
				allow: policy === "closed" ? [] : (change.allow ?? current.allow),
				deny: change.deny ?? current.deny,
				...(upstream === undefined ? {} : { upstream }),
				// The UI has no attribution switch: it stays as it is.
				attribution: current.attribution,
			};
			return proxyOf(await api.putProxySettings(body));
		},
		recent: async () => {
			throw notYet("Kantel's API doesn't keep a log of proxy requests yet.");
		},
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
	// The UI has no field for a refusal's `X-Kantel-Proxy-Error` code: it says why when the proxy gave no reason.
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
		setGrants: async (id, grants) => view(await api.putEnvironmentGrants(id, { grants: grants.map(grantInput) })),
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
		setGrants: async (sandboxId, grants) =>
			view(await api.putSandboxGrants(sandboxId, { grants: grants.map(grantInput) })),
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
		...(host.latestVersion !== undefined && host.latestVersion !== host.version
			? { updateAvailable: host.latestVersion }
			: {}),
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
	};
}

/** Whether the deployment lets accounts add hosts of their own: it answers `not_supported` when it doesn't. */
async function offersOwnHosts({ api }: Context): Promise<boolean> {
	try {
		await api.listAccountHosts({});
		return true;
	} catch (caught) {
		return !(caught instanceof KantelApiError && caught.code === "not_supported");
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
 * hosts source is there only for a deployment super-admin; billing isn't, as the API has no plans.
 */
export async function apiCompute(options: ComputeApiOptions = {}): Promise<ComputeSource> {
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	const watched: typeof fetch = async (input, init) => {
		const response = await doFetch(input, init);
		if (response.status === 401) options.onUnauthenticated?.();
		return response;
	};
	const api = createKantelClient({
		baseUrl: options.baseUrl ?? "/v1",
		...(options.headers === undefined ? {} : { headers: options.headers }),
		fetch: watched,
	});
	// The probe: the routes are served, and who is calling.
	const caller = await api.getCaller();

	// The domain sandbox addresses are under. The API names no deployment domain: the caller has none, and a sandbox
	// answers only its subdomain. The one hostname it does answer is its SSH gateway's, `ssh.<domain>` as the UI's
	// `sshCommand` writes it, so once an access call has given one the domain comes from that. Until then the page's own
	// host is the nearest guess (a self-hosted install serves the console and its sandboxes under one name), and outside
	// a browser, as in tests, "localhost".
	let learned: string | undefined;
	const fallback = pageHost() ?? "localhost";
	const { local } = options;
	// Only a person has a device of their own here; `kantel console` uses the CLI's instead.
	const person = caller.user?.id;
	const browser =
		local === undefined && person !== undefined
			? browserDevice({
					...options.browser,
					gateway: { openE2E: (id) => api.openE2E(id, {}), getE2EChain: (space) => api.getE2EChain(space) },
					user: async () => person,
				})
			: undefined;
	const context: Context = {
		api,
		hosting: options.hosting ?? "self-hosted",
		domain: () => learned ?? fallback,
		learnHost: (host) => {
			learned = host.replace(/^ssh\./, "");
		},
		caller,
		environmentNames: new Map(),
		sandboxAccounts: new Map(),
		...(local === undefined ? {} : { local }),
		...(browser === undefined ? {} : { browser }),
	};

	return {
		hosting: context.hosting,
		get domain() {
			return context.domain();
		},
		accounts: accountsSource(context),
		sandboxes: sandboxesSource(context),
		snapshots: snapshotsSource(context),
		keys: keysSource(context),
		proxy: proxySource(context),
		environments: environmentsSource(context),
		egress: egressSource(context),
		webhooks: webhooksSource(context),
		telemetry: telemetrySource(context),
		...(caller.superAdmin ? { hosts: hostsSource(context) } : {}),
		// Anyone else manages their accounts' own hosts, where the deployment allows it.
		...(!caller.superAdmin && (await offersOwnHosts(context))
			? { ownHosts: (accountId: string) => ownHostsSource(context, accountId) }
			: {}),
		// Only a person approves a device; a console signed in with a key has nothing to approve with.
		...(caller.apiKey === undefined ? { devices: devicesSource(context) } : {}),
		e2e:
			local === undefined
				? {
						served: "gateway",
						mode: (accountId) => chainMode(context, accountId),
						...(browser === undefined ? {} : { browser }),
					}
				: {
						served: "local",
						...(local.info.device === undefined ? {} : { device: local.info.device.label }),
						mode: async (accountId) => local.mode(accountId),
					},
	};
}
