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
	type ApiKey,
	type Caller,
	type Command,
	type CreatedBy,
	createKantelClient,
	type DeviceLoginRequest,
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
	HostingMode,
	HostsSource,
	ProxySource,
	SandboxesSource,
	SnapshotsSource,
	TelemetrySource,
	WebhooksSource,
} from "@kantel/ui";

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
	const view = (sandbox: Sandbox) => sandboxOf(sandbox, context);
	return {
		// The backend decides what each size is, and the API doesn't list them.
		sizeFigures: false,
		list: async (accountId) =>
			(await allPages((cursor) => api.listSandboxes({ account: accountId, all: true, ...after(cursor) }))).map(view),
		create: async (input) =>
			view(
				await api.createSandbox({
					account: input.accountId,
					type: input.kind,
					// Isolates have no size: the API refuses one.
					...(input.kind === "microvm" ? { size: API_SIZES[input.size] } : {}),
					...(input.name === undefined || input.name === "" ? {} : { name: input.name }),
					...(input.fromSnapshot === undefined ? {} : { from: input.fromSnapshot }),
					// The UI's absent auto-stop is always on, the API's `null`.
					autoStopMinutes: input.autoStopMinutes ?? null,
				}),
			),
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
			const [ssh, desktop, browser] = await Promise.all([api.openSsh(id), api.openDesktop(id), api.openBrowser(id)]);
			context.learnHost(ssh.host);
			return { ssh: ssh.command, desktopUrl: desktop.url, browserUrl: browser.url };
		},
		history: async (id) => (await allPages((cursor) => api.listCommands(id, after(cursor)))).map(commandOf),
	};
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
	const context: Context = {
		api,
		hosting: options.hosting ?? "self-hosted",
		domain: () => learned ?? fallback,
		learnHost: (host) => {
			learned = host.replace(/^ssh\./, "");
		},
		caller,
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
		webhooks: webhooksSource(context),
		telemetry: telemetrySource(context),
		...(caller.superAdmin ? { hosts: hostsSource(context) } : {}),
		// Only a person approves a device; a console signed in with a key has nothing to approve with.
		...(caller.apiKey === undefined ? { devices: devicesSource(context) } : {}),
	};
}
