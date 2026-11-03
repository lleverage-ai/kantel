/**
 * The compute plane's handlers: one per route of `@kantel/api`'s `computeRoutes`, over a `ComputeStore` and a
 * `SandboxBackend`. The service keeps every record (accounts, sandboxes and their lifecycle, commands, snapshots, keys,
 * webhooks, telemetry, hosts) and asks the backend only for machines and bytes.
 *
 * A sandbox moves `starting` → `running` → `stopping` → `stopped` or `paused`, into `error` when the backend fails, and
 * through `deleting` to `deleted`. A lifecycle call puts the sandbox in its passing state and answers at once, leaving
 * the backend's work running in the background, or answers when it is done with `wait`; calls on one sandbox run one
 * after another. Every change is an event (`EVENT_TYPES`), stored, queued for the account's webhooks and exported as an
 * OpenTelemetry log record.
 *
 * Cost uses a per-type and per-size rate table; the default, `PLACEHOLDER_RATES`, is a placeholder until real pricing
 * exists. CPU seconds are estimated from the usage readings taken while a sandbox runs.
 */
import { type ComputeRoutes, computeSchema, type RouteHandlers } from "@kantel/api";
import { KantelError } from "@kantel/contracts";
import {
	type Acting,
	accountById,
	actingAccount,
	memberId,
	newApiKeySecret,
	type Principal,
	requireGrantable,
	requirePerson,
	requireScope,
	roleIn,
} from "./auth.ts";
import type { BackendFileEntry, Placement, SandboxBackend } from "./backend.ts";
import type {
	ComputeStore,
	RunPeriod,
	StoredAccount,
	StoredApiKey,
	StoredCommand,
	StoredHost,
	StoredInvite,
	StoredProxy,
	StoredSandbox,
	StoredSnapshot,
	StoredTelemetry,
	StoredWebhook,
} from "./store.ts";
import type { TelemetryExporter, TelemetryUsageSample } from "./telemetry.ts";
import {
	base64ToBytes,
	bytesToBase64,
	HOME,
	paginate,
	randomId,
	randomSecret,
	randomSlug,
	resolvePath,
	sha256Hex,
} from "./util.ts";
import { deliveryView, newWebhookSecret, type WebhookDispatcher } from "./webhooks.ts";

type Sandbox = computeSchema.Sandbox;
type SandboxState = computeSchema.SandboxState;
type SandboxType = computeSchema.SandboxType;
type MemberRole = computeSchema.MemberRole;
type EventType = computeSchema.EventType;
type EventData = computeSchema.Event["data"];

/** What an hour of running costs, per type and microVM size. */
export interface RateTable {
	/** ISO 4217. */
	readonly currency: string;
	readonly isolate: number;
	readonly microvm: { readonly [size in computeSchema.SandboxSizeName]: number };
}

/** A placeholder until real pricing exists: rough figures so the console has something to show. */
export const PLACEHOLDER_RATES: RateTable = {
	currency: "USD",
	isolate: 0.01,
	microvm: { small: 0.03, default: 0.06, large: 0.12, xlarge: 0.24 },
};

/** Limits on every account, where the deployment sets any. */
export interface ComputeLimits {
	readonly concurrentSandboxes?: number;
	/** Reported only; not enforced yet. */
	readonly startsPerMinute?: number;
	readonly savedSnapshots?: number;
}

export interface ComputeServiceOptions {
	readonly store: ComputeStore;
	readonly backend: SandboxBackend;
	readonly dispatcher: WebhookDispatcher;
	readonly exporter: TelemetryExporter;
	readonly now: () => number;
	/** The control plane's public URL, for host join commands. Default the request's origin. */
	readonly publicUrl?: string;
	/** Default `selfhosted`. */
	readonly mode?: "selfhosted" | "hosted";
	/** The join command shown with a host join token, with `{url}` and `{token}`. Default the npm package's. */
	readonly hostJoinCommand?: string;
	/** Default `PLACEHOLDER_RATES`. */
	readonly rates?: RateTable;
	readonly limits?: ComputeLimits;
}

export interface ComputeService {
	/** A handler for every compute route, given the signed-in caller. */
	readonly handlers: RouteHandlers<ComputeRoutes, Principal>;
	/** Stops every running sandbox whose `stopsAt` has passed. */
	sweep(): Promise<void>;
	/** Reads every running sandbox's usage, keeps it, and answers it for the metrics export. */
	sampleUsage(): Promise<TelemetryUsageSample[]>;
	/** Resolves once every lifecycle operation and detached command started so far has ended. */
	idle(): Promise<void>;
	/** Kills the detached commands and waits for the work under way. */
	close(): Promise<void>;
}

/** The largest file the files routes read or write. */
/** The join command shown with a host join token: kantel-host from npm (`apps/host/npm`). */
export const DEFAULT_HOST_JOIN_COMMAND = "sudo npx -y @kantel/host@latest install --url {url} --token {token}";

export const MAX_FILE_BYTES = 1024 * 1024;
/** The most output a command keeps per stream. */
export const MAX_OUTPUT_CHARS = 1024 * 1024;
/** A command's default time limit. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** How long an automatic snapshot is kept. */
export const AUTOMATIC_SNAPSHOT_TTL_MS = 7 * 24 * 3_600_000;
/** The usage readings kept per sandbox: a day at one every 5 minutes. */
export const MAX_SAMPLES = 288;
const DEFAULT_AUTO_STOP_MINUTES = 60;
const DAY_MS = 24 * 3_600_000;

const ISOLATE_CAPABILITIES: computeSchema.SandboxCapabilities = {
	exec: true,
	files: true,
	ssh: false,
	desktop: false,
	browser: false,
	ports: true,
	docker: false,
	kvm: false,
	pause: false,
};
const MICROVM_CAPABILITIES: computeSchema.SandboxCapabilities = {
	exec: true,
	files: true,
	ssh: true,
	desktop: true,
	browser: true,
	ports: true,
	docker: true,
	kvm: true,
	pause: true,
};

const ADJECTIVES = ["brave", "calm", "eager", "fond", "gentle", "keen", "lucky", "merry", "quick", "quiet", "swift"];
const ANIMALS = ["otter", "heron", "badger", "lynx", "marten", "puffin", "wren", "hare", "stoat", "newt", "plover"];
const pick = (items: readonly string[]): string => items[Math.floor(Math.random() * items.length)] ?? "sandbox";
const generatedName = () => `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const notFound = (what: string) => new KantelError("not_found", `No such ${what}`);
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/**
 * The sandbox limit a key made or rotated by `principal` may carry: a limited key grants only sandboxes in its own list,
 * and a key it makes with none named gets its list.
 */
function grantableSandboxes(principal: Principal, wanted: readonly string[] | undefined): string[] | undefined {
	if (principal.kind !== "key" || principal.limits.sandboxIds === undefined) {
		return wanted === undefined ? undefined : [...wanted];
	}
	const allowed = principal.limits.sandboxIds;
	if (wanted === undefined) return [...allowed];
	if (!wanted.every((id) => allowed.includes(id))) {
		throw new KantelError("forbidden", "A limited key can't grant sandboxes beyond its own");
	}
	return [...wanted];
}
const newestFirst = <T extends { readonly createdAt: number }>(items: readonly T[]): T[] =>
	[...items].sort((a, b) => b.createdAt - a.createdAt);

/** The milliseconds of `runs` inside `[from, to)`. */
function runningMs(runs: readonly RunPeriod[], from: number, to: number): number {
	let total = 0;
	for (const run of runs) {
		const start = Math.max(run.from, from);
		const end = Math.min(run.to ?? to, to);
		if (end > start) total += end - start;
	}
	return total;
}

function subdomainFor(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${slug === "" ? "sandbox" : slug}-${randomSlug(6)}`;
}

function checkUrl(url: string, what: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new KantelError("invalid", `${what} is not a URL`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new KantelError("invalid", `${what} must be an HTTPS (or, self-hosted, HTTP) URL`);
	}
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new KantelError("invalid", `${path} is not UTF-8 text; read it with encoding base64`);
	}
}

const truncate = (text: string): { text: string; truncated: boolean } =>
	text.length > MAX_OUTPUT_CHARS
		? { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true }
		: { text, truncated: false };

/** The compute plane's handlers over a store and a backend. */
export function createComputeService(options: ComputeServiceOptions): ComputeService {
	const { store, backend, dispatcher, exporter, now } = options;
	const rates = options.rates ?? PLACEHOLDER_RATES;
	const limits = options.limits ?? {};
	const mode = options.mode ?? "selfhosted";

	/** Each sandbox's queue of lifecycle work; settled promises, so a failure doesn't stop the next. */
	const pending = new Map<string, Promise<void>>();
	/** Detached commands and their kill switches. */
	const runningCommands = new Map<string, AbortController>();
	const background = new Set<Promise<unknown>>();
	const inflight = new Map<string, Promise<unknown>>();

	const keepGoing = (work: Promise<unknown>) => {
		const tracked: Promise<unknown> = work.catch(() => undefined).finally(() => background.delete(tracked));
		background.add(tracked);
	};

	/** Runs `work` after every operation already queued on the sandboxes, and answers its promise. */
	function track(ids: readonly string[], work: () => Promise<void>): Promise<void> {
		const previous = Promise.all(ids.map((id) => pending.get(id) ?? Promise.resolve()));
		const next = previous.then(work);
		const settled: Promise<void> = next
			.catch(() => undefined)
			.finally(() => {
				for (const id of ids) if (pending.get(id) === settled) pending.delete(id);
			});
		for (const id of ids) pending.set(id, settled);
		return next;
	}
	const settledOn = async (id: string) => {
		await pending.get(id);
	};

	// Hosts: the backend's, refreshed whenever they are needed (hosts join, connect and drop off at any time). The
	// super-admin's name, labels, drain and revocation are kept; what the host is and whether it's connected follow it.
	let hostsReady: Promise<void> | undefined;
	const ensureHosts = (): Promise<void> => {
		hostsReady ??= (async () => {
			const capabilities = await backend.capabilities();
			for (const host of capabilities.hosts) {
				const known = await store.hosts.get(host.id);
				const reachable = host.connected !== false;
				if (known !== undefined) {
					const held = known.state === "revoked" || known.state === "draining";
					await store.hosts.put({
						...known,
						state: held ? known.state : reachable ? "online" : "unreachable",
						version: host.version,
						os: host.os,
						arch: host.arch,
						tiers: [...host.tiers],
						kvm: host.kvm,
						nestedVirtualisation: host.nestedVirtualisation,
						capacity: { ...host.capacity },
						lastSeenAt: host.lastSeenAt ?? (reachable ? now() : known.lastSeenAt),
					});
					continue;
				}
				await store.hosts.put({
					id: host.id,
					name: host.name,
					state: reachable ? "online" : "unreachable",
					version: host.version,
					latestVersion: host.version,
					os: host.os,
					arch: host.arch,
					tiers: [...host.tiers],
					kvm: host.kvm,
					nestedVirtualisation: host.nestedVirtualisation,
					capacity: { ...host.capacity },
					allocated: { sandboxes: 0, vcpus: 0, memoryMb: 0, diskGb: 0 },
					labels: { ...host.labels },
					joinedAt: now(),
					lastSeenAt: now(),
				});
			}
		})().finally(() => {
			hostsReady = undefined;
		});
		return hostsReady;
	};

	async function eligibleHosts(type: SandboxType, labels: { readonly [key: string]: string }): Promise<string[]> {
		await ensureHosts();
		const hosts = await store.hosts.list({ state: "online" });
		return hosts
			.filter((host) => host.tiers.includes(type))
			.filter((host) => Object.entries(labels).every(([key, value]) => host.labels[key] === value))
			.map((host) => host.id);
	}

	async function requireHosts(type: SandboxType, labels: { readonly [key: string]: string }): Promise<string[]> {
		const hosts = await eligibleHosts(type, labels);
		if (hosts.length === 0) throw new KantelError("unavailable", `No host can run a ${type} sandbox now`);
		return hosts;
	}

	// Views: what the API answers for a record.

	const rateOf = (sandbox: StoredSandbox) =>
		sandbox.type === "isolate" ? rates.isolate : rates.microvm[sandbox.size ?? "default"];

	const meanCpu = (sandbox: StoredSandbox) =>
		sandbox.samples.length === 0
			? 0
			: sandbox.samples.reduce((total, sample) => total + sample.cpu, 0) / sandbox.samples.length;

	function sandboxView(sandbox: StoredSandbox, principal: Principal): Sandbox {
		const seconds = runningMs(sandbox.runs, 0, now()) / 1000;
		const rate = rateOf(sandbox);
		return {
			id: sandbox.id,
			accountId: sandbox.accountId,
			name: sandbox.name,
			subdomain: sandbox.subdomain,
			type: sandbox.type,
			size: sandbox.size,
			resources: sandbox.resources,
			image: sandbox.image,
			state: sandbox.state,
			health: sandbox.health,
			reason: sandbox.reason,
			visibility: sandbox.visibility,
			capabilities: sandbox.capabilities,
			labels: sandbox.labels,
			autoStopMinutes: sandbox.autoStopMinutes,
			stopsAt: sandbox.state === "running" ? sandbox.stopsAt : undefined,
			latestSnapshotId: sandbox.latestSnapshotId,
			source: sandbox.source,
			createdBy: sandbox.createdBy,
			createdAt: sandbox.createdAt,
			startedAt: sandbox.startedAt,
			stoppedAt: sandbox.stoppedAt,
			cost: { currency: rates.currency, total: round((seconds / 3600) * rate), ratePerHour: rate },
			usage: {
				runningSeconds: round(seconds),
				cpuSeconds: round(seconds * meanCpu(sandbox)),
				recentCpu: sandbox.samples.slice(-24).map((sample) => sample.cpu),
			},
			hostId: principal.superAdmin ? sandbox.hostId : undefined,
		};
	}

	const snapshotView = (snapshot: StoredSnapshot): computeSchema.Snapshot => ({
		id: snapshot.id,
		accountId: snapshot.accountId,
		kind: snapshot.kind,
		name: snapshot.name,
		description: snapshot.description,
		sandboxId: snapshot.sandboxId,
		sandboxType: snapshot.sandboxType,
		state: snapshot.state,
		trigger: snapshot.trigger,
		memory: snapshot.memory,
		sizeBytes: snapshot.sizeBytes,
		createdAt: snapshot.createdAt,
		expiresAt: snapshot.expiresAt,
	});

	const commandView = (command: StoredCommand): computeSchema.Command => ({
		id: command.id,
		sandboxId: command.sandboxId,
		command: command.command,
		cwd: command.cwd,
		state: command.state,
		exitCode: command.exitCode,
		stdout: command.stdout,
		stderr: command.stderr,
		truncated: command.truncated,
		startedAt: command.startedAt,
		endedAt: command.endedAt,
		durationMs: command.durationMs,
	});

	const apiKeyView = (key: StoredApiKey): computeSchema.ApiKey => ({
		id: key.id,
		accountId: key.accountId,
		name: key.name,
		prefix: key.prefix,
		scopes: [...key.scopes],
		sandboxIds: key.sandboxIds === undefined ? undefined : [...key.sandboxIds],
		createdBy: key.createdBy,
		createdAt: key.createdAt,
		expiresAt: key.expiresAt,
		lastUsedAt: key.lastUsedAt,
		revokedAt: key.revokedAt,
	});

	const webhookView = (webhook: StoredWebhook): computeSchema.Webhook => ({
		id: webhook.id,
		accountId: webhook.accountId,
		name: webhook.name,
		url: webhook.url,
		events: [...webhook.events],
		enabled: webhook.enabled,
		createdAt: webhook.createdAt,
		lastDelivery: webhook.lastDelivery,
	});

	const telemetryView = (telemetry: StoredTelemetry): computeSchema.TelemetryExport => ({
		accountId: telemetry.accountId,
		endpoint: telemetry.endpoint,
		headerNames: Object.keys(telemetry.headers),
		signals: [...telemetry.signals],
		lastExport: telemetry.lastExport,
		updatedAt: telemetry.updatedAt,
	});

	const proxyView = (proxy: StoredProxy): computeSchema.ProxySettings => ({
		accountId: proxy.accountId,
		enabled: proxy.enabled,
		defaultAction: proxy.defaultAction,
		allow: [...proxy.allow],
		deny: [...proxy.deny],
		upstream:
			proxy.upstream === undefined
				? undefined
				: { url: proxy.upstream.url, headerNames: Object.keys(proxy.upstreamHeaders ?? {}) },
		attribution: proxy.attribution,
		updatedAt: proxy.updatedAt,
	});

	const inviteView = (invite: StoredInvite, code?: string): computeSchema.Invite => ({
		id: invite.id,
		accountId: invite.accountId,
		role: invite.role,
		email: invite.email,
		code,
		expiresAt: invite.expiresAt,
		createdAt: invite.createdAt,
	});

	const accountView = (account: StoredAccount, role: MemberRole): computeSchema.Account => ({
		id: account.id,
		kind: account.kind,
		name: account.name,
		role,
		defaultVisibility: account.defaultVisibility,
		createdAt: account.createdAt,
	});

	async function hostView(host: StoredHost): Promise<computeSchema.Host> {
		const placed = (await store.sandboxes.list({ hostId: host.id })).filter(
			(sandbox) => sandbox.state === "running" || sandbox.state === "starting" || sandbox.state === "paused",
		);
		const sum = (pickOf: (sandbox: StoredSandbox) => number) =>
			placed.reduce((total, sandbox) => total + pickOf(sandbox), 0);
		return {
			...host,
			allocated: {
				sandboxes: placed.length,
				vcpus: sum((sandbox) => sandbox.resources?.vcpus ?? 0),
				memoryMb: sum((sandbox) => sandbox.resources?.memoryMb ?? 0),
				diskGb: sum((sandbox) => sandbox.resources?.diskGb ?? 0),
			},
		};
	}

	const fileEntry = (entry: BackendFileEntry): computeSchema.FileEntry => ({
		name: entry.name,
		path: entry.path,
		kind: entry.kind,
		size: entry.size,
		modifiedAt: entry.modifiedAt,
	});

	const actorOf = (principal: Principal): Sandbox["createdBy"] =>
		principal.kind === "key"
			? { kind: "api_key", id: principal.keyId, name: principal.keyName }
			: { kind: "user", id: principal.userId, name: principal.name };

	// Events.

	async function emit(
		type: EventType,
		accountId: string,
		fields: { sandbox?: StoredSandbox; snapshotId?: string; data?: EventData },
	): Promise<void> {
		const { sandbox } = fields;
		const event: computeSchema.Event = {
			id: randomId("evt"),
			type,
			accountId,
			createdAt: now(),
			sandboxId: sandbox?.id,
			snapshotId: fields.snapshotId,
			data: {
				...(sandbox === undefined ? {} : { name: sandbox.name, state: sandbox.state }),
				...fields.data,
			},
		};
		await store.events.put(event);
		await dispatcher.enqueue(event).catch(() => undefined);
		exporter.record({ event, sandboxType: sandbox?.type });
	}

	// Sandbox records.

	async function mustGetSandbox(id: string): Promise<StoredSandbox> {
		const sandbox = await store.sandboxes.get(id);
		if (sandbox === undefined) throw notFound("sandbox");
		return sandbox;
	}

	/** The sandbox in a new state, with its run periods, stop time and timestamps kept in step. */
	function withState(sandbox: StoredSandbox, state: SandboxState, extra: Partial<StoredSandbox> = {}): StoredSandbox {
		const at = now();
		const wasRunning = sandbox.state === "running";
		const running = state === "running";
		let runs = sandbox.runs;
		if (wasRunning && !running) runs = runs.map((run) => (run.to === undefined ? { ...run, to: at } : run));
		if (!wasRunning && running) runs = [...runs, { from: at }];
		const autoStop = extra.autoStopMinutes === undefined ? sandbox.autoStopMinutes : extra.autoStopMinutes;
		return {
			...sandbox,
			...extra,
			state,
			runs,
			stopsAt: !running
				? undefined
				: wasRunning
					? sandbox.stopsAt
					: autoStop === null
						? undefined
						: at + autoStop * 60_000,
			startedAt: running && !wasRunning ? at : sandbox.startedAt,
			stoppedAt: state === "stopped" || state === "paused" ? at : sandbox.stoppedAt,
			reason: extra.reason,
		};
	}

	/** Whether the caller may see a sandbox in an account where they have `role`. */
	async function canSee(principal: Principal, sandbox: StoredSandbox, role: MemberRole): Promise<boolean> {
		if (principal.kind === "key" && principal.limits.sandboxIds !== undefined) {
			const madeByKey = sandbox.createdBy.kind === "api_key" && sandbox.createdBy.id === principal.keyId;
			if (!principal.limits.sandboxIds.includes(sandbox.id) && !madeByKey) return false;
		}
		if (sandbox.visibility === "organisation" || sandbox.ownerUserId === principal.userId) return true;
		// A private sandbox whose person has left its organisation is left for an admin to delete or share.
		if (role === "member") return false;
		return (await store.members.get(memberId(sandbox.accountId, sandbox.ownerUserId))) === undefined;
	}

	/** A sandbox the caller may see, checked for `scope`; `not_found` when it is deleted, unless `deleted` allows it. */
	async function sandboxFor(
		principal: Principal,
		sandboxId: string,
		scope: computeSchema.ApiKeyScope,
		deleted = false,
	): Promise<{ sandbox: StoredSandbox; role: MemberRole }> {
		const sandbox = await store.sandboxes.get(sandboxId);
		if (sandbox === undefined || (!deleted && sandbox.state === "deleted")) throw notFound("sandbox");
		const role = await roleIn(store, principal, sandbox.accountId);
		if (role === undefined || !(await canSee(principal, sandbox, role))) throw notFound("sandbox");
		requireScope(principal, scope, role);
		return { sandbox, role };
	}

	/** The sandbox once its queued operations end, refused with `conflict` unless it is running. */
	async function requireRunning(sandboxId: string): Promise<StoredSandbox> {
		await settledOn(sandboxId);
		const sandbox = await mustGetSandbox(sandboxId);
		if (sandbox.state !== "running") {
			throw new KantelError("conflict", `The sandbox is ${sandbox.state}; it must be running (resume it first)`);
		}
		return sandbox;
	}

	async function requireCapacity(accountId: string, adding: number): Promise<void> {
		if (limits.concurrentSandboxes === undefined) return;
		const active = (await store.sandboxes.list({ accountId })).filter(
			(sandbox) => sandbox.state === "starting" || sandbox.state === "running" || sandbox.state === "stopping",
		).length;
		if (active + adding > limits.concurrentSandboxes) {
			throw new KantelError("exhausted", `The account may run ${limits.concurrentSandboxes} sandboxes at once`);
		}
	}

	async function latestRef(sandbox: StoredSandbox): Promise<string | undefined> {
		if (sandbox.latestSnapshotId === undefined) return undefined;
		return (await store.snapshots.get(sandbox.latestSnapshotId))?.ref;
	}

	/** Lets the backend drop a snapshot's bytes once no snapshot record shares them. */
	async function releaseRef(ref: string | undefined): Promise<void> {
		if (ref === undefined) return;
		if ((await store.snapshots.list({ ref })).length > 0) return;
		await backend.deleteSnapshot(ref).catch(() => undefined);
	}

	/** Marks a sandbox's running commands killed, and kills the detached ones. */
	async function killCommandsOf(sandboxId: string): Promise<void> {
		for (const command of await store.commands.list({ sandboxId, state: "running" })) {
			runningCommands.get(command.id)?.abort();
			runningCommands.delete(command.id);
			const at = now();
			await store.commands.put({ ...command, state: "killed", endedAt: at, durationMs: at - command.startedAt });
		}
	}

	/** Boots a sandbox in `starting` with `run`, and records `running`, or `error` when it fails. */
	async function boot(sandboxId: string, run: () => Promise<Placement>): Promise<void> {
		let placement: Placement;
		try {
			placement = await run();
		} catch (error) {
			await fail(sandboxId, error);
			return;
		}
		const sandbox = await mustGetSandbox(sandboxId);
		if (sandbox.state === "deleting" || sandbox.state === "deleted") return;
		const next = withState(sandbox, "running", {
			hostId: placement.hostId,
			resources: placement.resources ?? sandbox.resources,
			capabilities: placement.capabilities,
			health: "ok",
		});
		await store.sandboxes.put(next);
		await emit("sandbox.running", next.accountId, { sandbox: next, data: { previousState: sandbox.state } });
	}

	async function fail(sandboxId: string, error: unknown): Promise<void> {
		const sandbox = await mustGetSandbox(sandboxId);
		const next = withState(sandbox, "error", { reason: messageOf(error) });
		await store.sandboxes.put(next);
		await emit("sandbox.error", next.accountId, {
			sandbox: next,
			data: { previousState: sandbox.state, reason: next.reason },
		});
	}

	/**
	 * Puts a running (or paused) sandbox in `stopping` and stops or pauses it in the background; answers once it is
	 * `stopping`, with the work (wrapped, so awaiting the answer doesn't await the work).
	 */
	async function beginStop(
		sandbox: StoredSandbox,
		keepMemory: boolean,
		reason: string | undefined,
		actor: Principal | undefined,
	): Promise<{ readonly work: Promise<void> }> {
		const stopping = withState(sandbox, "stopping");
		await store.sandboxes.put(stopping);
		const work = track([sandbox.id], async () => {
			try {
				await killCommandsOf(sandbox.id);
				const taken = await backend.stop(sandbox.id, { keepMemory });
				const at = now();
				const snapshot: StoredSnapshot = {
					id: randomId("snap"),
					accountId: sandbox.accountId,
					kind: "automatic",
					sandboxId: sandbox.id,
					sandboxType: sandbox.type,
					state: "ready",
					trigger: "stop",
					memory: keepMemory,
					sizeBytes: taken.sizeBytes,
					createdAt: at,
					expiresAt: at + AUTOMATIC_SNAPSHOT_TTL_MS,
					ref: taken.ref,
				};
				await store.snapshots.put(snapshot);
				const current = await mustGetSandbox(sandbox.id);
				const next = withState(current, keepMemory ? "paused" : "stopped", {
					latestSnapshotId: snapshot.id,
					ports: [],
					pausedSnapshotId: keepMemory ? snapshot.id : undefined,
				});
				await store.sandboxes.put(next);
				await emit(keepMemory ? "sandbox.paused" : "sandbox.stopped", next.accountId, {
					sandbox: next,
					data: {
						previousState: sandbox.state,
						...(reason === undefined ? {} : { reason }),
						...(actor === undefined ? {} : { actor: actorOf(actor) }),
					},
				});
			} catch (error) {
				await fail(sandbox.id, error);
				throw error;
			}
		});
		return { work };
	}

	/** The snapshot `from` names in an account: a snapshot's ID, or a saved snapshot's name. */
	async function snapshotFrom(principal: Principal, accountId: string, from: string): Promise<StoredSnapshot> {
		const byId = await store.snapshots.get(from);
		if (byId !== undefined && byId.accountId === accountId && (await canSeeSnapshot(principal, byId))) {
			if (byId.state !== "ready" || byId.ref === undefined)
				throw new KantelError("conflict", "The snapshot isn't ready");
			return byId;
		}
		const [byName] = await store.snapshots.list({ accountId, kind: "saved", name: from });
		if (byName === undefined || byName.ref === undefined) throw notFound(`snapshot named ${from}`);
		return byName;
	}

	async function canSeeSnapshot(principal: Principal, snapshot: StoredSnapshot): Promise<boolean> {
		const role = await roleIn(store, principal, snapshot.accountId);
		if (role === undefined) return false;
		if (snapshot.kind === "saved" || snapshot.sandboxId === undefined) return true;
		const sandbox = await store.sandboxes.get(snapshot.sandboxId);
		return sandbox === undefined || (await canSee(principal, sandbox, role));
	}

	async function snapshotFor(
		principal: Principal,
		snapshotId: string,
		scope: computeSchema.ApiKeyScope,
	): Promise<StoredSnapshot> {
		const snapshot = await store.snapshots.get(snapshotId);
		if (snapshot === undefined || !(await canSeeSnapshot(principal, snapshot))) throw notFound("snapshot");
		requireScope(principal, scope, (await roleIn(store, principal, snapshot.accountId)) ?? "member");
		return snapshot;
	}

	const readyRef = (snapshot: StoredSnapshot): string => {
		if (snapshot.state !== "ready" || snapshot.ref === undefined) {
			throw new KantelError("conflict", "The snapshot isn't ready");
		}
		return snapshot.ref;
	};

	async function apiKeyFor(principal: Principal, apiKeyId: string, scope: computeSchema.ApiKeyScope) {
		const key = await store.apiKeys.get(apiKeyId);
		const role = key === undefined ? undefined : await roleIn(store, principal, key.accountId);
		if (key === undefined || role === undefined) throw notFound("API key");
		requireScope(principal, scope, role);
		return key;
	}

	async function webhookFor(principal: Principal, webhookId: string): Promise<StoredWebhook> {
		const webhook = await store.webhooks.get(webhookId);
		const role = webhook === undefined ? undefined : await roleIn(store, principal, webhook.accountId);
		if (webhook === undefined || role === undefined) throw notFound("webhook");
		requireScope(principal, "account:admin", role);
		return webhook;
	}

	async function hostFor(principal: Principal, hostId: string): Promise<StoredHost> {
		requireScope(principal, "hosts:admin");
		await ensureHosts();
		const host = await store.hosts.get(hostId);
		if (host === undefined) throw notFound("host");
		return host;
	}

	/** Answers an idempotent call's first answer again for the same caller, operation and key. */
	async function once<T>(
		principal: Principal,
		operation: string,
		key: string | undefined,
		work: () => Promise<T>,
	): Promise<T> {
		if (key === undefined) return work();
		const caller = principal.kind === "key" ? `key:${principal.keyId}` : `user:${principal.userId}`;
		const id = `${caller}:${operation}:${key}`;
		const stored = await store.idempotency.get(id);
		if (stored !== undefined) return JSON.parse(stored.body) as T;
		const running = inflight.get(id);
		if (running !== undefined) return running as Promise<T>;
		const promise = (async () => {
			const answer = await work();
			await store.idempotency.put({ id, body: JSON.stringify(answer), createdAt: now() });
			return answer;
		})();
		inflight.set(id, promise);
		try {
			return await promise;
		} finally {
			inflight.delete(id);
		}
	}

	async function recordSample(sandboxId: string): Promise<TelemetryUsageSample | undefined> {
		const sandbox = await store.sandboxes.get(sandboxId);
		if (sandbox === undefined || sandbox.state !== "running") return undefined;
		const reading = await backend.usage(sandboxId).catch(() => undefined);
		if (reading === undefined) return undefined;
		const at = now();
		const latest = (await store.sandboxes.get(sandboxId)) ?? sandbox;
		await store.sandboxes.put({
			...latest,
			samples: [...latest.samples, { at, cpu: reading.cpu, memoryMb: reading.memoryBytes / (1024 * 1024) }].slice(
				-MAX_SAMPLES,
			),
		});
		return {
			accountId: sandbox.accountId,
			sandboxId,
			sandboxType: sandbox.type,
			cpu: reading.cpu,
			memoryBytes: reading.memoryBytes,
			runningSeconds: runningMs(sandbox.runs, 0, at) / 1000,
			at,
			startedAt: sandbox.startedAt,
		};
	}

	/** The cost and running time of an account's sandboxes since `since`. */
	async function accountUsage(account: StoredAccount, since: number) {
		const sandboxes = await store.sandboxes.list({ accountId: account.id });
		const at = now();
		let seconds = 0;
		let total = 0;
		for (const sandbox of sandboxes) {
			const ran = runningMs(sandbox.runs, since, at) / 1000;
			seconds += ran;
			total += (ran / 3600) * rateOf(sandbox);
		}
		const hasLimits =
			limits.concurrentSandboxes !== undefined ||
			limits.startsPerMinute !== undefined ||
			limits.savedSnapshots !== undefined;
		return {
			accountId: account.id,
			since,
			running: sandboxes.filter((sandbox) => sandbox.state === "running").length,
			runningSeconds: round(seconds),
			cost: { currency: rates.currency, total: round(total), ratePerHour: 0 },
			limits: hasLimits ? { ...limits } : undefined,
		};
	}

	async function membersView(accountId: string): Promise<computeSchema.Member[]> {
		const members: computeSchema.Member[] = [];
		for (const member of await store.members.list({ accountId })) {
			const user = await store.users.get(member.userId);
			members.push({
				userId: member.userId,
				name: user?.name ?? member.userId,
				email: user?.email,
				role: member.role,
				joinedAt: member.joinedAt,
			});
		}
		return members;
	}

	async function accountsOf(principal: Principal): Promise<computeSchema.Account[]> {
		if (principal.kind === "key") {
			const account = await store.accounts.get(principal.accountId);
			const role = await roleIn(store, principal, principal.accountId);
			return account === undefined || role === undefined ? [] : [accountView(account, role)];
		}
		const accounts: computeSchema.Account[] = [];
		for (const member of await store.members.list({ userId: principal.userId })) {
			const account = await store.accounts.get(member.accountId);
			if (account !== undefined) accounts.push(accountView(account, member.role));
		}
		return accounts.sort((a, b) =>
			a.id === principal.personalAccountId ? -1 : b.id === principal.personalAccountId ? 1 : a.createdAt - b.createdAt,
		);
	}

	const requireOrganisation = (acting: Acting) => {
		if (acting.account.kind !== "organisation") {
			throw new KantelError("invalid", "A personal account has no other members");
		}
	};

	const ownerCount = async (accountId: string) => (await store.members.list({ accountId, role: "owner" })).length;

	const handlers: RouteHandlers<ComputeRoutes, Principal> = {
		// Who is calling, accounts and organisations.

		getCaller: async (principal) => {
			const accounts = await accountsOf(principal);
			if (principal.kind === "key") {
				const key = await store.apiKeys.get(principal.keyId);
				return {
					apiKey: { id: principal.keyId, name: principal.keyName, scopes: [...principal.scopes] },
					user: key === undefined ? undefined : await personSummary(key.ownerUserId),
					accountId: principal.accountId,
					accounts,
					superAdmin: principal.superAdmin,
					mode,
				};
			}
			return {
				user: { id: principal.userId, name: principal.name, email: principal.email },
				accountId: principal.personalAccountId,
				accounts,
				superAdmin: principal.superAdmin,
				mode,
			};
		},

		listAccounts: async (principal) => {
			requireScope(principal, "account:read");
			return { items: await accountsOf(principal) };
		},

		createOrganisation: async (principal, { body }) => {
			const person = requirePerson(principal);
			const account: StoredAccount = {
				id: randomId("acc"),
				kind: "organisation",
				name: body.name,
				defaultVisibility: body.defaultVisibility ?? "organisation",
				createdAt: now(),
			};
			await store.accounts.put(account);
			await store.members.put({
				id: memberId(account.id, person.userId),
				accountId: account.id,
				userId: person.userId,
				role: "owner",
				joinedAt: now(),
			});
			return accountView(account, "owner");
		},

		joinOrganisation: async (principal, { body }) => {
			const person = requirePerson(principal);
			const [invite] = await store.invites.list({ codeHash: await sha256Hex(body.code) });
			if (invite === undefined) throw notFound("invite");
			if (invite.revokedAt !== undefined || invite.usedAt !== undefined || invite.expiresAt <= now()) {
				throw new KantelError("expired", "The invite has expired or been used");
			}
			if (invite.email !== undefined && invite.email.toLowerCase() !== (person.email ?? "").toLowerCase()) {
				throw new KantelError("forbidden", "The invite is for someone else");
			}
			const account = await store.accounts.get(invite.accountId);
			if (account === undefined) throw notFound("organisation");
			if ((await store.members.get(memberId(account.id, person.userId))) !== undefined) {
				throw new KantelError("conflict", "You are already a member");
			}
			await store.members.put({
				id: memberId(account.id, person.userId),
				accountId: account.id,
				userId: person.userId,
				role: invite.role,
				joinedAt: now(),
			});
			await store.invites.put({ ...invite, usedAt: now(), usedBy: person.userId });
			return accountView(account, invite.role);
		},

		getAccount: async (principal, { params }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:read", role);
			return accountView(account, role);
		},

		updateAccount: async (principal, { params, body }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", role);
			if (account.kind === "personal" && body.defaultVisibility === "organisation") {
				throw new KantelError("invalid", "A personal account's sandboxes are always private");
			}
			const updated: StoredAccount = {
				...account,
				name: body.name ?? account.name,
				defaultVisibility: body.defaultVisibility ?? account.defaultVisibility,
			};
			await store.accounts.put(updated);
			return accountView(updated, role);
		},

		deleteOrganisation: async (principal, { params }) => {
			requirePerson(principal);
			const acting = await accountById(store, principal, params.accountId);
			const { account, role } = acting;
			if (account.kind === "personal") throw new KantelError("invalid", "A personal account can't be deleted here");
			if (role !== "owner") throw new KantelError("forbidden", "Only an owner deletes an organisation");
			const sandboxes = (await store.sandboxes.list({ accountId: account.id })).filter(
				(sandbox) => sandbox.state !== "deleted",
			);
			const saved = await store.snapshots.list({ accountId: account.id, kind: "saved" });
			if (sandboxes.length > 0 || saved.length > 0) {
				throw new KantelError("conflict", "Delete the organisation's sandboxes and saved snapshots first");
			}
			for (const member of await store.members.list({ accountId: account.id })) await store.members.delete(member.id);
			for (const invite of await store.invites.list({ accountId: account.id })) await store.invites.delete(invite.id);
			for (const key of await store.apiKeys.list({ accountId: account.id })) {
				if (key.revokedAt === undefined) await store.apiKeys.put({ ...key, revokedAt: now() });
			}
			for (const webhook of await store.webhooks.list({ accountId: account.id })) {
				await store.webhooks.delete(webhook.id);
			}
			await store.telemetry.delete(account.id);
			await store.proxies.delete(account.id);
			await store.accounts.delete(account.id);
			return undefined;
		},

		getAccountUsage: async (principal, { params, query }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:read", role);
			return accountUsage(account, query.since ?? now() - DAY_MS);
		},

		listMembers: async (principal, { params }) => {
			const { account, role } = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:read", role);
			return { items: await membersView(account.id) };
		},

		updateMember: async (principal, { params, body }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", acting.role);
			requireOrganisation(acting);
			const target = await store.members.get(memberId(params.accountId, params.userId));
			if (target === undefined) throw notFound("member");
			if ((body.role === "owner" || target.role === "owner") && acting.role !== "owner") {
				throw new KantelError("forbidden", "Only an owner makes or unmakes an owner");
			}
			if (target.role === "owner" && body.role !== "owner" && (await ownerCount(params.accountId)) <= 1) {
				throw new KantelError("conflict", "The last owner stays an owner");
			}
			await store.members.put({ ...target, role: body.role });
			const [member] = (await membersView(params.accountId)).filter((entry) => entry.userId === params.userId);
			if (member === undefined) throw notFound("member");
			return member;
		},

		removeMember: async (principal, { params }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireOrganisation(acting);
			const leaving = principal.kind === "person" && params.userId === principal.userId;
			if (!leaving) requireScope(principal, "account:admin", acting.role);
			const target = await store.members.get(memberId(params.accountId, params.userId));
			if (target === undefined) throw notFound("member");
			if (!leaving && target.role === "owner" && acting.role !== "owner") {
				throw new KantelError("forbidden", "Only an owner removes an owner");
			}
			if (target.role === "owner" && (await ownerCount(params.accountId)) <= 1) {
				throw new KantelError("conflict", "The last owner can't leave");
			}
			await store.members.delete(target.id);
			// Their private sandboxes stay, stopped; their keys in the organisation stop working.
			for (const sandbox of await store.sandboxes.list({ accountId: params.accountId, ownerUserId: params.userId })) {
				if (sandbox.visibility === "private" && sandbox.state === "running") {
					keepGoing((await beginStop(sandbox, false, "Its person left the organisation", principal)).work);
				}
			}
			for (const key of await store.apiKeys.list({ accountId: params.accountId, ownerUserId: params.userId })) {
				if (key.revokedAt === undefined) await store.apiKeys.put({ ...key, revokedAt: now() });
			}
			return undefined;
		},

		listInvites: async (principal, { params }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", acting.role);
			const open = (await store.invites.list({ accountId: params.accountId })).filter(
				(invite) => invite.revokedAt === undefined && invite.usedAt === undefined && invite.expiresAt > now(),
			);
			return { items: newestFirst(open).map((invite) => inviteView(invite)) };
		},

		createInvite: async (principal, { params, body }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", acting.role);
			requireOrganisation(acting);
			const role = body.role ?? "member";
			if (role === "owner" && acting.role !== "owner") {
				throw new KantelError("forbidden", "Only an owner invites an owner");
			}
			const code = randomSecret("kji_", 32);
			const invite: StoredInvite = {
				id: randomId("inv"),
				accountId: params.accountId,
				role,
				email: body.email,
				codeHash: await sha256Hex(code),
				expiresAt: now() + (body.expiresInHours ?? 168) * 3_600_000,
				createdAt: now(),
			};
			await store.invites.put(invite);
			return inviteView(invite, code);
		},

		revokeInvite: async (principal, { params }) => {
			const acting = await accountById(store, principal, params.accountId);
			requireScope(principal, "account:admin", acting.role);
			const invite = await store.invites.get(params.inviteId);
			if (invite === undefined || invite.accountId !== params.accountId) throw notFound("invite");
			if (invite.revokedAt === undefined) await store.invites.put({ ...invite, revokedAt: now() });
			return undefined;
		},

		// Sandboxes.

		listSandboxes: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "sandboxes:read", role);
			const active: readonly SandboxState[] = ["starting", "running", "stopping"];
			const visible: StoredSandbox[] = [];
			for (const sandbox of await store.sandboxes.list({ accountId: account.id })) {
				if (sandbox.state === "deleted") continue;
				const wanted =
					query.state !== undefined
						? sandbox.state === query.state
						: query.all === true || active.includes(sandbox.state);
				if (!wanted) continue;
				const labels = query.label ?? {};
				if (!Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value)) continue;
				if (await canSee(principal, sandbox, role)) visible.push(sandbox);
			}
			const page = paginate(newestFirst(visible), query.limit, query.cursor);
			return { items: page.items.map((sandbox) => sandboxView(sandbox, principal)), nextCursor: page.nextCursor };
		},

		createSandbox: async (principal, { body, idempotencyKey }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "sandboxes:write", role);
			return once(principal, "createSandbox", idempotencyKey, async () => {
				const from = body.from === undefined ? undefined : await snapshotFrom(principal, account.id, body.from);
				const type = body.type ?? from?.sandboxType ?? "isolate";
				const capabilities = await backend.capabilities();
				if (!capabilities.types.includes(type)) throw new KantelError("unavailable", `No host runs ${type} sandboxes`);
				if (type === "isolate" && body.size !== undefined) throw new KantelError("invalid", "Isolates have no size");
				if (body.size !== undefined && !capabilities.sizes.some((size) => size.name === body.size)) {
					throw new KantelError("not_supported", `This deployment doesn't offer the size ${body.size}`);
				}
				if (account.kind === "personal" && body.visibility === "organisation") {
					throw new KantelError("invalid", "A personal account's sandboxes are always private");
				}
				await requireCapacity(account.id, 1);
				const hostLabels = { ...body.hostLabels };
				const hosts = await requireHosts(type, hostLabels);
				const name = body.name ?? generatedName();
				const sandbox: StoredSandbox = {
					id: randomId("sbx"),
					accountId: account.id,
					name,
					subdomain: subdomainFor(name),
					type,
					size: type === "microvm" ? (body.size ?? "default") : undefined,
					image: type === "microvm" ? (body.image ?? capabilities.defaultImage) : undefined,
					state: "starting",
					visibility: account.kind === "personal" ? "private" : (body.visibility ?? account.defaultVisibility),
					capabilities: type === "microvm" ? MICROVM_CAPABILITIES : ISOLATE_CAPABILITIES,
					labels: { ...body.labels },
					autoStopMinutes: body.autoStopMinutes === undefined ? DEFAULT_AUTO_STOP_MINUTES : body.autoStopMinutes,
					source: from === undefined ? undefined : { snapshotId: from.id },
					createdBy: actorOf(principal),
					createdAt: now(),
					ownerUserId: principal.userId,
					env: { ...body.env },
					hostLabels,
					runs: [],
					samples: [],
					ports: [],
				};
				await store.sandboxes.put(sandbox);
				await emit("sandbox.created", account.id, { sandbox, data: { actor: actorOf(principal) } });
				const work = track([sandbox.id], () =>
					boot(sandbox.id, () =>
						backend.create({
							sandboxId: sandbox.id,
							accountId: account.id,
							type,
							subdomain: sandbox.subdomain,
							size: sandbox.size,
							image: sandbox.image,
							env: sandbox.env,
							eligibleHosts: hosts,
							fromSnapshot: from?.ref,
						}),
					),
				);
				if (body.wait === true) await work;
				else keepGoing(work);
				return sandboxView(await mustGetSandbox(sandbox.id), principal);
			});
		},

		getSandbox: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:read", true);
			return sandboxView(sandbox, principal);
		},

		updateSandbox: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			await settledOn(sandbox.id);
			const current = await mustGetSandbox(sandbox.id);
			const account = await store.accounts.get(current.accountId);
			if (body.visibility === "organisation" && account?.kind === "personal") {
				throw new KantelError("invalid", "A personal account's sandboxes are always private");
			}
			let stopsAt = current.stopsAt;
			if (body.autoStopMinutes !== undefined && current.state === "running") {
				stopsAt = body.autoStopMinutes === null ? undefined : now() + body.autoStopMinutes * 60_000;
			}
			if (body.extendMinutes !== undefined) {
				if (current.state !== "running") throw new KantelError("conflict", "Only a running sandbox has a stop time");
				stopsAt = now() + body.extendMinutes * 60_000;
			}
			const updated: StoredSandbox = {
				...current,
				name: body.name ?? current.name,
				autoStopMinutes: body.autoStopMinutes === undefined ? current.autoStopMinutes : body.autoStopMinutes,
				visibility: body.visibility ?? current.visibility,
				labels: body.labels === undefined ? current.labels : { ...body.labels },
				stopsAt,
			};
			await store.sandboxes.put(updated);
			return sandboxView(updated, principal);
		},

		startSandbox: async (principal, { params, body }) => restart(principal, params.sandboxId, body, "start"),

		stopSandbox: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			await settledOn(sandbox.id);
			const current = await mustGetSandbox(sandbox.id);
			const keepMemory = body.keepMemory === true;
			if (keepMemory && !current.capabilities.pause) {
				throw new KantelError("not_supported", "Pausing with memory needs a microVM; stop an isolate instead");
			}
			if ((current.state === "stopped" && !keepMemory) || (current.state === "paused" && keepMemory)) {
				return sandboxView(current, principal);
			}
			if (current.state !== "running" && !(current.state === "paused" && !keepMemory)) {
				throw new KantelError("conflict", `The sandbox is ${current.state}`);
			}
			const { work } = await beginStop(current, keepMemory, undefined, principal);
			if (body.wait === true) await work;
			else keepGoing(work);
			return sandboxView(await mustGetSandbox(sandbox.id), principal);
		},

		resumeSandbox: async (principal, { params, body }) => restart(principal, params.sandboxId, body, "resume"),

		forkSandbox: async (principal, { params, body, idempotencyKey }) => {
			const { sandbox: source } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			return once(principal, "forkSandbox", idempotencyKey, async () => {
				await settledOn(source.id);
				const current = await mustGetSandbox(source.id);
				const count = body.count ?? 1;
				let snapshot: StoredSnapshot | undefined;
				if (body.snapshotId !== undefined) {
					snapshot = await store.snapshots.get(body.snapshotId);
					if (snapshot === undefined || snapshot.sandboxId !== current.id) throw notFound("snapshot of this sandbox");
				} else if (current.state !== "running") {
					snapshot =
						current.latestSnapshotId === undefined ? undefined : await store.snapshots.get(current.latestSnapshotId);
					if (snapshot === undefined) throw new KantelError("conflict", "The sandbox has no snapshot to fork from");
				}
				const ref = snapshot === undefined ? undefined : readyRef(snapshot);
				if (current.type === "isolate" && body.size !== undefined) {
					throw new KantelError("invalid", "Isolates have no size");
				}
				const account = await store.accounts.get(current.accountId);
				if (account?.kind === "personal" && body.visibility === "organisation") {
					throw new KantelError("invalid", "A personal account's sandboxes are always private");
				}
				await requireCapacity(current.accountId, count);
				const hosts = await requireHosts(current.type, current.hostLabels);
				const forks: StoredSandbox[] = [];
				for (let index = 0; index < count; index++) {
					const name =
						body.name === undefined
							? `${current.name}-fork-${randomSlug(4)}`
							: count === 1
								? body.name
								: `${body.name}-${index + 1}`;
					forks.push({
						id: randomId("sbx"),
						accountId: current.accountId,
						name,
						subdomain: subdomainFor(name),
						type: current.type,
						size: current.type === "microvm" ? (body.size ?? current.size) : undefined,
						image: current.image,
						state: "starting",
						visibility: account?.kind === "personal" ? "private" : (body.visibility ?? current.visibility),
						capabilities: current.capabilities,
						labels: body.labels === undefined ? { ...current.labels } : { ...body.labels },
						autoStopMinutes: current.autoStopMinutes,
						source: { sandboxId: current.id, snapshotId: snapshot?.id },
						createdBy: actorOf(principal),
						createdAt: now(),
						ownerUserId: principal.userId,
						env: { ...current.env },
						hostLabels: { ...current.hostLabels },
						runs: [],
						samples: [],
						ports: [],
					});
				}
				for (const fork of forks) {
					await store.sandboxes.put(fork);
					await emit("sandbox.created", fork.accountId, { sandbox: fork, data: { actor: actorOf(principal) } });
				}
				// Queued behind the source too, so it isn't stopped while its live disk is copied.
				const work = track([current.id, ...forks.map((fork) => fork.id)], async () => {
					let placements: Placement[];
					try {
						placements = await backend.fork(
							{ sandboxId: current.id, ...(ref === undefined ? {} : { snapshot: ref }) },
							forks.map((fork) => ({
								sandboxId: fork.id,
								accountId: fork.accountId,
								type: fork.type,
								subdomain: fork.subdomain,
								size: fork.size,
								image: fork.image,
								env: fork.env,
								eligibleHosts: hosts,
							})),
						);
					} catch (error) {
						for (const fork of forks) await fail(fork.id, error);
						return;
					}
					for (const [index, fork] of forks.entries()) {
						const placement = placements[index];
						await boot(fork.id, async () => {
							if (placement === undefined) throw new KantelError("unavailable", "The fork was not placed");
							return placement;
						});
					}
				});
				if (body.wait === true) await work;
				else keepGoing(work);
				const items: Sandbox[] = [];
				for (const fork of forks) items.push(sandboxView(await mustGetSandbox(fork.id), principal));
				return { items };
			});
		},

		recoverSandbox: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:write");
			await settledOn(sandbox.id);
			const current = await mustGetSandbox(sandbox.id);
			if (current.state !== "running" && current.state !== "error") {
				throw new KantelError("conflict", `A ${current.state} sandbox is started or resumed, not recovered`);
			}
			const hosts = await requireHosts(current.type, current.hostLabels);
			const fromSnapshot = await latestRef(current);
			const starting = withState(current, "starting", { ports: [] });
			await store.sandboxes.put(starting);
			keepGoing(
				track([current.id], () =>
					boot(current.id, () =>
						backend.recover(current.id, { fromSnapshot, env: current.env, eligibleHosts: hosts, size: current.size }),
					),
				),
			);
			return sandboxView(starting, principal);
		},

		deleteSandbox: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:delete");
			await settledOn(sandbox.id);
			const current = await mustGetSandbox(sandbox.id);
			if (current.state === "deleted") return sandboxView(current, principal);
			const deleting = withState(current, "deleting");
			await store.sandboxes.put(deleting);
			await track([current.id], async () => {
				try {
					await killCommandsOf(current.id);
					await backend.destroy(current.id);
					for (const snapshot of await store.snapshots.list({ sandboxId: current.id })) {
						if (snapshot.kind === "automatic") {
							await store.snapshots.delete(snapshot.id);
							await releaseRef(snapshot.ref);
						} else {
							await store.snapshots.put({ ...snapshot, sandboxId: undefined });
						}
					}
					const latest = await mustGetSandbox(current.id);
					const deleted = withState(latest, "deleted", {
						ports: [],
						latestSnapshotId: undefined,
						pausedSnapshotId: undefined,
					});
					await store.sandboxes.put(deleted);
					await emit("sandbox.deleted", deleted.accountId, {
						sandbox: deleted,
						data: { previousState: current.state, actor: actorOf(principal) },
					});
				} catch (error) {
					await fail(current.id, error);
					throw error;
				}
			});
			return sandboxView(await mustGetSandbox(current.id), principal);
		},

		getSandboxUsage: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "sandboxes:read", true);
			if (sandbox.state === "running") await recordSample(sandbox.id);
			const current = await mustGetSandbox(sandbox.id);
			const at = now();
			const intervalMs = (query.intervalSeconds ?? 300) * 1000;
			const since = Math.max(query.since ?? at - DAY_MS, current.createdAt - intervalMs);
			const rate = rateOf(current);
			const start = Math.max(since, at - 1000 * intervalMs);
			const points: { at: number; cpu: number; memoryMb: number; runningSeconds: number; cost: number }[] = [];
			for (let from = start; from < at; from += intervalMs) {
				const to = Math.min(from + intervalMs, at);
				const seconds = runningMs(current.runs, from, to) / 1000;
				const samples = current.samples.filter((sample) => sample.at >= from && sample.at < to);
				const mean = (values: readonly number[]) =>
					values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
				points.push({
					at: from,
					cpu: Math.min(1, mean(samples.map((sample) => sample.cpu))),
					memoryMb: round(mean(samples.map((sample) => sample.memoryMb))),
					runningSeconds: round(seconds),
					cost: round((seconds / 3600) * rate),
				});
			}
			const seconds = runningMs(current.runs, since, at) / 1000;
			return {
				sandboxId: current.id,
				intervalSeconds: intervalMs / 1000,
				points,
				totals: {
					runningSeconds: round(seconds),
					cpuSeconds: round(seconds * meanCpu(current)),
					cost: { currency: rates.currency, total: round((seconds / 3600) * rate), ratePerHour: rate },
				},
			};
		},

		// Commands and files.

		runCommand: async (principal, { params, body, idempotencyKey }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			return once(principal, "runCommand", idempotencyKey, async () => {
				const current = await requireRunning(sandbox.id);
				if (!current.capabilities.exec) throw new KantelError("not_supported", "This sandbox runs no commands");
				const detached = body.detached === true;
				const command: StoredCommand = {
					id: randomId("cmd"),
					sandboxId: current.id,
					accountId: current.accountId,
					command: body.command,
					cwd: resolvePath(body.cwd ?? HOME),
					state: "running",
					stdout: "",
					stderr: "",
					truncated: false,
					startedAt: now(),
				};
				await store.commands.put(command);
				const controller = new AbortController();
				runningCommands.set(command.id, controller);
				const finish = async (result: {
					exitCode: number;
					stdout: string;
					stderr: string;
					timedOut: boolean;
				}): Promise<StoredCommand> => {
					runningCommands.delete(command.id);
					const latest = (await store.commands.get(command.id)) ?? command;
					if (latest.state !== "running") return latest;
					const stdout = truncate(result.stdout);
					const stderr = truncate(result.stderr);
					const at = now();
					const ended: StoredCommand = {
						...latest,
						state: result.timedOut ? "timed_out" : "exited",
						exitCode: result.exitCode,
						stdout: stdout.text,
						stderr: stderr.text,
						truncated: stdout.truncated || stderr.truncated,
						endedAt: at,
						durationMs: at - latest.startedAt,
					};
					await store.commands.put(ended);
					return ended;
				};
				const failed = (error: unknown) =>
					finish({ exitCode: 1, stdout: "", stderr: `${messageOf(error)}\n`, timedOut: false });
				const run = backend.exec(current.id, {
					command: body.command,
					cwd: command.cwd,
					env: { ...current.env, ...body.env },
					stdin: body.stdin,
					timeoutMs: detached ? undefined : (body.timeoutMs ?? DEFAULT_TIMEOUT_MS),
					signal: controller.signal,
				});
				if (detached) {
					keepGoing(run.then(finish, failed));
					return commandView(command);
				}
				return commandView(await run.then(finish, failed));
			});
		},

		listCommands: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			const page = paginate(
				newestFirst(
					(await store.commands.list({ sandboxId: sandbox.id })).map((command) => ({
						...command,
						createdAt: command.startedAt,
					})),
				),
				query.limit,
				query.cursor,
			);
			return { items: page.items.map(commandView), nextCursor: page.nextCursor };
		},

		getCommand: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			const command = await store.commands.get(params.commandId);
			if (command === undefined || command.sandboxId !== sandbox.id) throw notFound("command");
			return commandView(command);
		},

		killCommand: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "exec");
			const command = await store.commands.get(params.commandId);
			if (command === undefined || command.sandboxId !== sandbox.id) throw notFound("command");
			if (command.state !== "running") return commandView(command);
			runningCommands.get(command.id)?.abort();
			runningCommands.delete(command.id);
			const at = now();
			const killed: StoredCommand = {
				...command,
				state: "killed",
				exitCode: 137,
				endedAt: at,
				durationMs: at - command.startedAt,
			};
			await store.commands.put(killed);
			return commandView(killed);
		},

		readFile: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "files");
			await requireRunning(sandbox.id);
			const path = resolvePath(query.path);
			const bytes = await backend.readFile(sandbox.id, path);
			if (bytes.byteLength > MAX_FILE_BYTES) {
				throw new KantelError("invalid", `${path} is larger than 1 MiB; read it with a command or SSH`);
			}
			const encoding = query.encoding ?? "utf8";
			return {
				path,
				encoding,
				content: encoding === "base64" ? bytesToBase64(bytes) : decodeUtf8(bytes, path),
				size: bytes.byteLength,
			};
		},

		writeFile: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "files");
			await requireRunning(sandbox.id);
			const path = resolvePath(body.path);
			const bytes = body.encoding === "base64" ? base64ToBytes(body.content) : new TextEncoder().encode(body.content);
			if (bytes.byteLength > MAX_FILE_BYTES) throw new KantelError("invalid", "A file written here is at most 1 MiB");
			let mode: number | undefined;
			if (body.mode !== undefined) {
				if (!/^0?[0-7]{3,4}$/.test(body.mode)) throw new KantelError("invalid", "mode must be octal, such as 0755");
				mode = Number.parseInt(body.mode, 8);
			}
			return fileEntry(await backend.writeFile(sandbox.id, path, bytes, mode));
		},

		deleteFile: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "files");
			await requireRunning(sandbox.id);
			await backend.deleteFile(sandbox.id, resolvePath(query.path));
			return undefined;
		},

		listFiles: async (principal, { params, query }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "files");
			await requireRunning(sandbox.id);
			const path = resolvePath(query.path ?? HOME);
			const page = paginate(await backend.listFiles(sandbox.id, path), query.limit, query.cursor);
			return { path, items: page.items.map(fileEntry), nextCursor: page.nextCursor };
		},

		// Ports, desktop, browser and SSH.

		listPorts: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			return { items: [...sandbox.ports] };
		},

		exposePort: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			if (!sandbox.capabilities.ports) throw new KantelError("not_supported", "This sandbox can't expose ports");
			const current = await requireRunning(sandbox.id);
			const isPublic = body.public === true;
			const existing = current.ports.find((entry) => entry.port === body.port);
			if (existing !== undefined && existing.public === isPublic) return existing;
			const { url } = await backend.exposePort(current.id, body.port, {
				public: isPublic,
				subdomain: current.subdomain,
			});
			const exposed: computeSchema.ExposedPort = {
				port: body.port,
				url,
				public: isPublic,
				createdAt: existing?.createdAt ?? now(),
			};
			await store.sandboxes.put({
				...current,
				ports: [...current.ports.filter((entry) => entry.port !== body.port), exposed],
			});
			return exposed;
		},

		hidePort: async (principal, { params }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			await settledOn(sandbox.id);
			const current = await mustGetSandbox(sandbox.id);
			const port = Number(params.port);
			if (!current.ports.some((entry) => entry.port === port)) throw notFound("exposed port");
			await backend.hidePort(current.id, port);
			await store.sandboxes.put({ ...current, ports: current.ports.filter((entry) => entry.port !== port) });
			return undefined;
		},

		openSsh: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			if (!sandbox.capabilities.ssh) throw new KantelError("not_supported", "SSH needs a microVM; this is an isolate");
			const current = await requireRunning(sandbox.id);
			const ttlMinutes = body.ttlMinutes ?? 60;
			const grant = await backend.openSsh(current.id, {
				ttlMinutes,
				...(body.publicKey === undefined ? {} : { publicKey: body.publicKey }),
			});
			return {
				host: grant.host,
				port: grant.port,
				user: grant.user,
				command: grant.command ?? `ssh -p ${grant.port} ${grant.user}@${grant.host}`,
				privateKey: grant.privateKey,
				hostKeyFingerprint: grant.hostKeyFingerprint,
				expiresAt: now() + ttlMinutes * 60_000,
			};
		},

		openDesktop: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			if (!sandbox.capabilities.desktop) {
				throw new KantelError("not_supported", "The desktop needs a microVM; this is an isolate");
			}
			const current = await requireRunning(sandbox.id);
			const ttlMinutes = body.ttlMinutes ?? 60;
			const viewOnly = body.viewOnly === true;
			const access = await backend.openDesktop(current.id, { viewOnly, ttlMinutes });
			return { url: access.url, embedUrl: access.embedUrl, viewOnly, expiresAt: now() + ttlMinutes * 60_000 };
		},

		openBrowser: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "access");
			if (!sandbox.capabilities.browser) {
				throw new KantelError("not_supported", "The browser needs a microVM; this is an isolate");
			}
			const current = await requireRunning(sandbox.id);
			const ttlMinutes = body.ttlMinutes ?? 60;
			const viewOnly = body.viewOnly === true;
			const access = await backend.openBrowser(current.id, { viewOnly, ttlMinutes });
			return { url: access.url, cdpUrl: access.cdpUrl, viewOnly, expiresAt: now() + ttlMinutes * 60_000 };
		},

		// Snapshots.

		listSnapshots: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "snapshots:read", role);
			const visible: StoredSnapshot[] = [];
			for (const snapshot of await store.snapshots.list({ accountId: account.id })) {
				if (query.kind !== undefined && snapshot.kind !== query.kind) continue;
				if (query.sandboxId !== undefined && snapshot.sandboxId !== query.sandboxId) continue;
				if (snapshot.state === "deleting") continue;
				if (await canSeeSnapshot(principal, snapshot)) visible.push(snapshot);
			}
			const page = paginate(newestFirst(visible), query.limit, query.cursor);
			return { items: page.items.map(snapshotView), nextCursor: page.nextCursor };
		},

		takeSnapshot: async (principal, { params, body }) => {
			const { sandbox } = await sandboxFor(principal, params.sandboxId, "snapshots:write");
			const current = await requireRunning(sandbox.id);
			const taken = await backend.takeSnapshot(current.id);
			const at = now();
			const snapshot: StoredSnapshot = {
				id: randomId("snap"),
				accountId: current.accountId,
				kind: "automatic",
				description: body.description,
				sandboxId: current.id,
				sandboxType: current.type,
				state: "ready",
				trigger: "manual",
				memory: false,
				sizeBytes: taken.sizeBytes,
				createdAt: at,
				expiresAt: at + AUTOMATIC_SNAPSHOT_TTL_MS,
				ref: taken.ref,
			};
			await store.snapshots.put(snapshot);
			const latest = await mustGetSandbox(current.id);
			await store.sandboxes.put({ ...latest, latestSnapshotId: snapshot.id });
			return snapshotView(snapshot);
		},

		saveSnapshot: async (principal, { body }) => {
			const { sandbox } = await sandboxFor(principal, body.sandboxId, "snapshots:write");
			await settledOn(sandbox.id);
			const current = await mustGetSandbox(sandbox.id);
			const [existing] = await store.snapshots.list({ accountId: current.accountId, kind: "saved", name: body.name });
			if (existing !== undefined && body.replace !== true) {
				throw new KantelError("conflict", `A saved snapshot is already named ${body.name}`);
			}
			if (existing === undefined && limits.savedSnapshots !== undefined) {
				const saved = await store.snapshots.list({ accountId: current.accountId, kind: "saved" });
				if (saved.length >= limits.savedSnapshots) {
					throw new KantelError("exhausted", `The account may keep ${limits.savedSnapshots} saved snapshots`);
				}
			}
			let ref: string;
			let sizeBytes: number | undefined;
			if (body.snapshotId !== undefined) {
				const source = await store.snapshots.get(body.snapshotId);
				if (source === undefined || source.sandboxId !== current.id) throw notFound("snapshot of this sandbox");
				ref = readyRef(source);
				sizeBytes = source.sizeBytes;
			} else if (current.state === "running") {
				const taken = await backend.takeSnapshot(current.id);
				ref = taken.ref;
				sizeBytes = taken.sizeBytes;
			} else {
				const latest =
					current.latestSnapshotId === undefined ? undefined : await store.snapshots.get(current.latestSnapshotId);
				if (latest === undefined) throw new KantelError("conflict", "The sandbox has no state to save yet");
				ref = readyRef(latest);
				sizeBytes = latest.sizeBytes;
			}
			const snapshot: StoredSnapshot = {
				id: randomId("snap"),
				accountId: current.accountId,
				kind: "saved",
				name: body.name,
				description: body.description,
				sandboxId: current.id,
				sandboxType: current.type,
				state: "ready",
				trigger: "save",
				memory: false,
				sizeBytes,
				createdAt: now(),
				ref,
			};
			await store.snapshots.put(snapshot);
			if (existing !== undefined) {
				await store.snapshots.delete(existing.id);
				await releaseRef(existing.ref);
				await emit("snapshot.deleted", existing.accountId, {
					snapshotId: existing.id,
					data: { name: existing.name, actor: actorOf(principal) },
				});
			}
			await emit("snapshot.saved", snapshot.accountId, {
				snapshotId: snapshot.id,
				data: { name: snapshot.name, actor: actorOf(principal) },
			});
			return snapshotView(snapshot);
		},

		getSnapshot: async (principal, { params }) =>
			snapshotView(await snapshotFor(principal, params.snapshotId, "snapshots:read")),

		listSnapshotFiles: async (principal, { params, query }) => {
			const snapshot = await snapshotFor(principal, params.snapshotId, "snapshots:read");
			const path = resolvePath(query.path ?? HOME);
			const page = paginate(await backend.listSnapshotFiles(readyRef(snapshot), path), query.limit, query.cursor);
			return { path, items: page.items.map(fileEntry), nextCursor: page.nextCursor };
		},

		readSnapshotFile: async (principal, { params, query }) => {
			const snapshot = await snapshotFor(principal, params.snapshotId, "snapshots:read");
			const path = resolvePath(query.path);
			const bytes = await backend.readSnapshotFile(readyRef(snapshot), path);
			if (bytes.byteLength > MAX_FILE_BYTES) throw new KantelError("invalid", `${path} is larger than 1 MiB`);
			const encoding = query.encoding ?? "utf8";
			return {
				path,
				encoding,
				content: encoding === "base64" ? bytesToBase64(bytes) : decodeUtf8(bytes, path),
				size: bytes.byteLength,
			};
		},

		deleteSnapshot: async (principal, { params }) => {
			const snapshot = await snapshotFor(principal, params.snapshotId, "snapshots:write");
			const sandbox = snapshot.sandboxId === undefined ? undefined : await store.sandboxes.get(snapshot.sandboxId);
			if (sandbox !== undefined) await settledOn(sandbox.id);
			const current = sandbox === undefined ? undefined : await mustGetSandbox(sandbox.id);
			if (current !== undefined && current.latestSnapshotId === snapshot.id) {
				if (current.state === "stopped" || current.state === "paused" || current.state === "error") {
					throw new KantelError("conflict", "A stopped sandbox's newest snapshot is what it resumes from");
				}
			}
			await store.snapshots.delete(snapshot.id);
			await releaseRef(snapshot.ref);
			if (current !== undefined && current.latestSnapshotId === snapshot.id) {
				const [newest] = newestFirst(
					(await store.snapshots.list({ sandboxId: current.id, kind: "automatic" })).filter(
						(entry) => entry.state === "ready",
					),
				);
				await store.sandboxes.put({ ...current, latestSnapshotId: newest?.id });
			}
			if (snapshot.kind === "saved") {
				await emit("snapshot.deleted", snapshot.accountId, {
					snapshotId: snapshot.id,
					data: { name: snapshot.name, actor: actorOf(principal) },
				});
			}
			return undefined;
		},

		// API keys.

		listApiKeys: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:read", role);
			return { items: newestFirst(await store.apiKeys.list({ accountId: account.id })).map(apiKeyView) };
		},

		createApiKey: async (principal, { body }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			const scopes = unique([
				...(body.scopes ?? []),
				...(body.preset === undefined ? [] : computeSchema.API_KEY_PRESETS[body.preset]),
			]);
			if (scopes.length === 0) throw new KantelError("invalid", "Give scopes or a preset");
			requireGrantable(principal, scopes);
			const sandboxIds = grantableSandboxes(principal, body.sandboxIds);
			const { secret, prefix, hash } = await newApiKeySecret();
			const key: StoredApiKey = {
				id: randomId("key"),
				accountId: account.id,
				name: body.name,
				prefix,
				scopes,
				sandboxIds,
				createdBy: actorOf(principal),
				createdAt: now(),
				expiresAt: body.expiresInDays === undefined ? undefined : now() + body.expiresInDays * DAY_MS,
				secretHash: hash,
				ownerUserId: principal.userId,
			};
			await store.apiKeys.put(key);
			return { key: apiKeyView(key), secret };
		},

		getApiKey: async (principal, { params }) => apiKeyView(await apiKeyFor(principal, params.apiKeyId, "account:read")),

		rotateApiKey: async (principal, { params }) => {
			const key = await apiKeyFor(principal, params.apiKeyId, "account:admin");
			if (key.revokedAt !== undefined) throw new KantelError("conflict", "The key is revoked");
			// Rotating answers the key's new secret, so it is as much as making the key: the caller must be able to grant
			// everything it holds.
			requireGrantable(principal, key.scopes);
			grantableSandboxes(principal, key.sandboxIds);
			if (principal.kind === "key" && principal.limits.sandboxIds !== undefined && key.sandboxIds === undefined) {
				throw new KantelError("forbidden", "A limited key can't rotate a key without limits");
			}
			const { secret, prefix, hash } = await newApiKeySecret();
			const rotated = await store.apiKeys.update(key.id, (current) =>
				current.revokedAt === undefined ? { ...current, prefix, secretHash: hash } : undefined,
			);
			if (rotated === undefined) throw new KantelError("conflict", "The key is revoked");
			return { key: apiKeyView(rotated), secret };
		},

		revokeApiKey: async (principal, { params }) => {
			const key = await apiKeyFor(principal, params.apiKeyId, "account:admin");
			const revoked: StoredApiKey = key.revokedAt === undefined ? { ...key, revokedAt: now() } : key;
			await store.apiKeys.put(revoked);
			return apiKeyView(revoked);
		},

		// The proxy.

		getProxySettings: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:read", role);
			const stored = await store.proxies.get(account.id);
			return proxyView(
				stored ?? {
					id: account.id,
					accountId: account.id,
					enabled: false,
					defaultAction: "allow",
					allow: [],
					deny: [],
					attribution: false,
					updatedAt: account.createdAt,
				},
			);
		},

		putProxySettings: async (principal, { body }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			const existing = await store.proxies.get(account.id);
			let upstream: StoredProxy["upstream"];
			let upstreamHeaders: StoredProxy["upstreamHeaders"];
			if (body.upstream !== undefined && body.upstream !== null) {
				checkUrl(body.upstream.url, "The upstream");
				upstreamHeaders =
					body.upstream.headers === undefined ? (existing?.upstreamHeaders ?? {}) : { ...body.upstream.headers };
				upstream = { url: body.upstream.url, headerNames: Object.keys(upstreamHeaders) };
			}
			const settings: StoredProxy = {
				id: account.id,
				accountId: account.id,
				enabled: body.enabled,
				defaultAction: body.defaultAction ?? "allow",
				allow: [...(body.allow ?? [])],
				deny: [...(body.deny ?? [])],
				upstream,
				upstreamHeaders,
				attribution: body.attribution === true,
				updatedAt: now(),
			};
			await store.proxies.put(settings);
			return proxyView(settings);
		},

		// Events, webhooks and telemetry.

		listEvents: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "sandboxes:read", role);
			const matching = (await store.events.list({ accountId: account.id })).filter(
				(event) =>
					(query.sandboxId === undefined || event.sandboxId === query.sandboxId) &&
					(query.type === undefined || event.type === query.type) &&
					(query.since === undefined || event.createdAt >= query.since),
			);
			// A sandbox's events are seen only by who may see the sandbox (a private one, a limited key's list); one whose
			// sandbox is gone stays with the account's admins and unlimited keys.
			const seen = new Map<string, boolean>();
			const events = [];
			for (const event of matching) {
				if (event.sandboxId === undefined) {
					events.push(event);
					continue;
				}
				let visible = seen.get(event.sandboxId);
				if (visible === undefined) {
					const sandbox = await store.sandboxes.get(event.sandboxId);
					const limited = principal.kind === "key" && principal.limits.sandboxIds !== undefined;
					visible =
						sandbox === undefined
							? !limited && (role === "owner" || role === "admin")
							: await canSee(principal, sandbox, role);
					seen.set(event.sandboxId, visible);
				}
				if (visible) events.push(event);
			}
			const page = paginate([...events].reverse(), query.limit, query.cursor);
			return { items: page.items, nextCursor: page.nextCursor };
		},

		listWebhooks: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:admin", role);
			return { items: (await store.webhooks.list({ accountId: account.id })).map(webhookView) };
		},

		createWebhook: async (principal, { body }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			checkUrl(body.url, "The webhook's URL");
			const webhook: StoredWebhook = {
				id: randomId("whk"),
				accountId: account.id,
				name: body.name,
				url: body.url,
				events: unique(body.events),
				enabled: true,
				createdAt: now(),
				secret: newWebhookSecret(),
				consecutiveFailures: 0,
			};
			await store.webhooks.put(webhook);
			return { webhook: webhookView(webhook), secret: webhook.secret };
		},

		getWebhook: async (principal, { params }) => webhookView(await webhookFor(principal, params.webhookId)),

		updateWebhook: async (principal, { params, body }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			if (body.url !== undefined) checkUrl(body.url, "The webhook's URL");
			const updated: StoredWebhook = {
				...webhook,
				name: body.name ?? webhook.name,
				url: body.url ?? webhook.url,
				events: body.events === undefined ? webhook.events : unique(body.events),
				enabled: body.enabled ?? webhook.enabled,
				consecutiveFailures: body.enabled === true ? 0 : webhook.consecutiveFailures,
			};
			await store.webhooks.put(updated);
			return webhookView(updated);
		},

		deleteWebhook: async (principal, { params }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			for (const delivery of await store.deliveries.list({ webhookId: webhook.id })) {
				await store.deliveries.delete(delivery.id);
			}
			await store.webhooks.delete(webhook.id);
			return undefined;
		},

		rotateWebhookSecret: async (principal, { params }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			const rotated: StoredWebhook = { ...webhook, secret: newWebhookSecret() };
			await store.webhooks.put(rotated);
			return { webhook: webhookView(rotated), secret: rotated.secret };
		},

		testWebhook: async (principal, { params }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			return deliveryView(await dispatcher.test(webhook.id));
		},

		listWebhookDeliveries: async (principal, { params, query }) => {
			const webhook = await webhookFor(principal, params.webhookId);
			const recent = (await store.deliveries.list({ webhookId: webhook.id })).filter(
				(delivery) => delivery.createdAt >= now() - 30 * DAY_MS,
			);
			const page = paginate(newestFirst(recent), query.limit, query.cursor);
			return { items: page.items.map(deliveryView), nextCursor: page.nextCursor };
		},

		getTelemetry: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:admin", role);
			const telemetry = await store.telemetry.get(account.id);
			if (telemetry === undefined) throw notFound("telemetry export");
			return telemetryView(telemetry);
		},

		putTelemetry: async (principal, { body }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			checkUrl(body.endpoint, "The endpoint");
			const existing = await store.telemetry.get(account.id);
			const signals: readonly ("metrics" | "logs")[] = body.signals ?? ["metrics", "logs"];
			const configured: StoredTelemetry = {
				id: account.id,
				accountId: account.id,
				endpoint: body.endpoint,
				headerNames: [],
				headers: body.headers === undefined ? (existing?.headers ?? {}) : { ...body.headers },
				signals: unique(signals),
				updatedAt: now(),
			};
			const test = await exporter.test(configured);
			const saved: StoredTelemetry = {
				...configured,
				headerNames: Object.keys(configured.headers),
				lastExport: { at: now(), ok: test.ok, status: test.status, error: test.error },
			};
			await store.telemetry.put(saved);
			return { telemetry: telemetryView(saved), test: { ok: test.ok, status: test.status, error: test.error } };
		},

		deleteTelemetry: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:admin", role);
			await store.telemetry.delete(account.id);
			return undefined;
		},

		// Hosts.

		listHosts: async (principal) => {
			requireScope(principal, "hosts:admin");
			await ensureHosts();
			const items: computeSchema.Host[] = [];
			for (const host of await store.hosts.list()) items.push(await hostView(host));
			return { items };
		},

		createHostJoinToken: async (principal, { body }, request) => {
			requireScope(principal, "hosts:admin");
			const token = randomSecret("kth_", 32);
			const expiresAt = now() + (body.expiresInMinutes ?? 60) * 60_000;
			const id = randomId("hjt");
			await store.joinTokens.put({
				id,
				tokenHash: await sha256Hex(token),
				name: body.name,
				labels: { ...body.labels },
				expiresAt,
				createdAt: now(),
			});
			const publicUrl = (options.publicUrl ?? new URL(request.url).origin).replace(/\/+$/, "");
			return {
				id,
				token,
				command: (options.hostJoinCommand ?? DEFAULT_HOST_JOIN_COMMAND)
					.replaceAll("{url}", publicUrl)
					.replaceAll("{token}", token),
				expiresAt,
			};
		},

		getHost: async (principal, { params }) => hostView(await hostFor(principal, params.hostId)),

		updateHost: async (principal, { params, body }) => {
			const host = await hostFor(principal, params.hostId);
			if (host.state === "revoked") throw new KantelError("conflict", "The host is revoked");
			let state = host.state;
			if (body.draining === true) state = "draining";
			if (body.draining === false && host.state === "draining") state = "online";
			const updated: StoredHost = {
				...host,
				name: body.name ?? host.name,
				labels: body.labels === undefined ? host.labels : { ...body.labels },
				state,
			};
			await backend.updateHost?.(host.id, {
				...(body.name === undefined ? {} : { name: body.name }),
				...(body.labels === undefined ? {} : { labels: { ...body.labels } }),
				...(body.draining === undefined ? {} : { draining: body.draining }),
			});
			await store.hosts.put(updated);
			return hostView(updated);
		},

		revokeHost: async (principal, { params }) => {
			const host = await hostFor(principal, params.hostId);
			await backend.revokeHost?.(host.id);
			const revoked: StoredHost = { ...host, state: "revoked" };
			await store.hosts.put(revoked);
			return hostView(revoked);
		},
	};

	async function idle(): Promise<void> {
		for (;;) {
			const waiting = [...pending.values(), ...background];
			if (waiting.length === 0) return;
			await Promise.all(waiting);
		}
	}

	async function personSummary(userId: string) {
		const user = await store.users.get(userId);
		return user === undefined ? undefined : { id: user.id, name: user.name, email: user.email };
	}

	/** Starts (fresh from the newest snapshot) or resumes (from memory when paused) a sandbox. */
	async function restart(
		principal: Principal,
		sandboxId: string,
		body: { readonly size?: computeSchema.SandboxSizeName; readonly wait?: boolean },
		how: "start" | "resume",
	): Promise<Sandbox> {
		const { sandbox } = await sandboxFor(principal, sandboxId, "sandboxes:write");
		await settledOn(sandbox.id);
		const current = await mustGetSandbox(sandbox.id);
		if (current.state === "running") return sandboxView(current, principal);
		if (current.state !== "stopped" && current.state !== "paused" && current.state !== "error") {
			throw new KantelError("conflict", `The sandbox is ${current.state}`);
		}
		if (current.type === "isolate" && body.size !== undefined)
			throw new KantelError("invalid", "Isolates have no size");
		await requireCapacity(current.accountId, 1);
		const hosts = await requireHosts(current.type, current.hostLabels);
		const fromSnapshot = await latestRef(current);
		const starting = withState(current, "starting", {
			size: body.size ?? current.size,
			pausedSnapshotId: how === "resume" ? current.pausedSnapshotId : undefined,
		});
		await store.sandboxes.put(starting);
		const bootOptions = { fromSnapshot, size: starting.size, env: current.env, eligibleHosts: hosts };
		const work = track([current.id], () =>
			boot(current.id, () =>
				how === "start" ? backend.start(current.id, bootOptions) : backend.resume(current.id, bootOptions),
			),
		);
		if (body.wait === true) await work;
		else keepGoing(work);
		return sandboxView(await mustGetSandbox(current.id), principal);
	}

	return {
		handlers,

		async sweep() {
			const at = now();
			for (const sandbox of await store.sandboxes.list({ state: "running" })) {
				if (sandbox.stopsAt === undefined || sandbox.stopsAt > at || pending.has(sandbox.id)) continue;
				keepGoing((await beginStop(sandbox, false, "auto-stop", undefined)).work);
			}
		},

		async sampleUsage() {
			const samples: TelemetryUsageSample[] = [];
			for (const sandbox of await store.sandboxes.list({ state: "running" })) {
				const sample = await recordSample(sandbox.id);
				if (sample !== undefined) samples.push(sample);
			}
			return samples;
		},

		async close() {
			for (const controller of runningCommands.values()) controller.abort();
			await idle();
		},

		idle,
	};
}
