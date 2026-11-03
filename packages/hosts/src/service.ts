/**
 * The host registry and the compute plane's dispatch: join tokens, registration, the hosts' connections (through the
 * hub), the operator's view and changes, and sandboxes placed on hosts and reached through them.
 *
 * The public sandbox API (docs/site/src/content/docs/api/reference/sandboxes.md) is built over `sandboxes` here; this
 * package doesn't decide who may use which sandbox, only where it runs and how it is reached.
 */
import { type Clock, KantelError, systemClock } from "@kantel/contracts";
import type { HostCluster } from "./cluster.ts";
import { type CallOptions, createHostHub, HostCallError, type HostHub, type PortSink, type PortStream } from "./hub.ts";
import {
	HOST_CLOSE_REVOKED,
	type HostEgress,
	type HostFacts,
	type HostHello,
	HostMethods,
	type HostSandbox,
	type HostSize,
	type HostWelcome,
	type SandboxTier,
} from "./protocol.ts";
import { type Candidate, isRefusal, place, sizeOn } from "./scheduler.ts";
import type { HostRecord, HostStore, PlacementRecord } from "./store.ts";

export const JOIN_TOKEN_PREFIX = "kth_";
export const HOST_CREDENTIAL_PREFIX = "khc_";

/** A host as the operator sees it (the API contract's `Host`). */
export interface HostView {
	readonly id: string;
	readonly name: string;
	readonly state: "online" | "unreachable" | "draining" | "revoked";
	readonly version?: string;
	readonly latestVersion?: string;
	readonly os?: string;
	readonly arch?: "x86_64" | "aarch64";
	readonly tiers: readonly SandboxTier[];
	/** The microVM sizes it offers. */
	readonly sizes: readonly HostSize[];
	readonly kvm: boolean;
	readonly nestedVirtualisation: boolean;
	readonly capacity: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb: number };
	readonly allocated: {
		readonly sandboxes: number;
		readonly vcpus: number;
		readonly memoryMb: number;
		readonly diskGb: number;
	};
	readonly labels: { readonly [key: string]: string };
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
	/** Default `default` (microVMs); isolates have one size. */
	readonly size?: string;
	/** The organisation or account; isolates of one owner share a VM. */
	readonly owner?: string;
	readonly labels?: { readonly [key: string]: string };
	readonly env?: { readonly [key: string]: string };
	readonly sshAuthorizedKeys?: readonly string[];
	readonly egress?: HostEgress;
	/** Only these hosts may take it (the control plane's eligible hosts: online, not draining, labelled). */
	readonly hostIds?: readonly string[];
	/** Start from this snapshot, which is on the one host `hostIds` names. */
	readonly from?: string;
}

/** Join tokens kept elsewhere, such as by the compute API, which mints them (`createHostJoinToken`). */
export interface ExternalJoinTokens {
	/** Spends the token with this SHA-256 hex once: its name and labels, or undefined if unknown, used or expired. */
	spendJoinToken(
		hash: string,
		hostId: string,
		now: number,
	): Promise<
		{ readonly id: string; readonly name?: string; readonly labels: { readonly [key: string]: string } } | undefined
	>;
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
	/** Warm sandboxes wanted on every host, by `<tier>/<size>`. Default `{"microvm/default": 1}`. */
	readonly pools?: { readonly [pool: string]: number };
	/** The version hosts should run, and where they get it (`{version}`, `{os}`, `{arch}`). */
	readonly desiredVersion?: string;
	readonly updateUrl?: string;
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
}

export interface HostsService {
	readonly hub: HostHub;
	/** Registration spends join tokens from here from now on, not the registry's own. */
	useJoinTokens(tokens: ExternalJoinTokens): void;
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
	readonly sandboxes: {
		create(input: CreateSandboxInput): Promise<SandboxPlacement>;
		fork(
			sandboxId: string,
			input?: { readonly newId?: string; readonly egress?: HostEgress },
		): Promise<SandboxPlacement>;
		/** Any other method of a sandbox, on its host: stop, resume, exec, files, snapshots. */
		call<T = unknown>(sandboxId: string, method: string, params?: object, options?: CallOptions): Promise<T>;
		delete(sandboxId: string): Promise<void>;
		placement(sandboxId: string): Promise<PlacementRecord | undefined>;
		openPort(sandboxId: string, port: number, sink: PortSink): Promise<PortStream>;
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

/** A host's error as Kantel's: the codes line up where they can. */
export function kantelErrorFromHost(error: unknown): unknown {
	if (!(error instanceof HostCallError)) return error;
	const code =
		error.code === "not_found" || error.code === "invalid" || error.code === "conflict"
			? error.code
			: error.code === "capacity"
				? "exhausted"
				: error.code === "unsupported"
					? "not_supported"
					: "unavailable";
	return new KantelError(code, error.message);
}

export function createHostsService(options: HostsServiceOptions): HostsService {
	const { store } = options;
	const clock = options.clock ?? systemClock;
	const log = options.log ?? ((message: string) => console.error(message));
	const pools = options.pools ?? { "microvm/default": 1 };
	let joinTokens: ExternalJoinTokens = store;
	/**
	 * What this replica placed on each host, each stamped with when, until the host's next report. A report clears it here
	 * when it comes in on this replica's connection; for a host whose connection another replica holds, a placement
	 * counts only while it is newer than the host's `lastSeenAt` in the shared registry, which that replica writes on
	 * every hello and heartbeat. So no replica goes on seeing a host as full after the host has reported again.
	 */
	const reserved = new Map<string, { at: number; memoryMiB: number; diskGiB: number }[]>();
	/** What this replica placed on `host` since its last report. */
	const reservedOn = (host: HostRecord) => {
		const since = host.lastSeenAt ?? Number.NEGATIVE_INFINITY;
		const live = (reserved.get(host.id) ?? []).filter((entry) => entry.at > since);
		if (live.length === 0) reserved.delete(host.id);
		else reserved.set(host.id, live);
		return {
			memoryMiB: live.reduce((sum, entry) => sum + entry.memoryMiB, 0),
			diskGiB: live.reduce((sum, entry) => sum + entry.diskGiB, 0),
		};
	};
	const report = (work: Promise<unknown>) => {
		void work.catch((error) => log(`[hosts] ${error instanceof Error ? error.message : String(error)}`));
	};

	const welcomeFor = (host: HostRecord): HostWelcome => ({
		hostId: host.id,
		heartbeatSeconds: options.heartbeatSeconds ?? 15,
		pools: host.draining ? {} : pools,
		...(host.draining ? { draining: true } : {}),
		...(options.desiredVersion === undefined ? {} : { desiredVersion: options.desiredVersion }),
		...(options.updateUrl === undefined ? {} : { updateUrl: options.updateUrl }),
	});

	const hello = async (hostId: string, message: HostHello): Promise<HostWelcome> => {
		const host = await store.getHost(hostId);
		if (host === undefined || host.revoked) throw new Error("This host is revoked");
		const now = clock.now();
		await store.putHost({ ...host, facts: message.facts, capacity: message.capacity, lastSeenAt: now });
		reserved.delete(hostId);
		// Reconcile: what the host holds is the truth about state; a placement the host no longer has is lost.
		// Go marshals an empty list as null (kantel-host 0.1.0-dev on a host with no sandboxes).
		const sandboxes = message.sandboxes ?? [];
		const held = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
		for (const placement of await store.placementsOn(hostId)) {
			const sandbox = held.get(placement.sandboxId);
			const state = sandbox?.state ?? "lost";
			if (state !== placement.state) await store.putPlacement({ ...placement, state, updatedAt: now });
			held.delete(placement.sandboxId);
		}
		if (held.size > 0) {
			log(`[hosts] host ${hostId} holds sandboxes Kantel didn't place: ${[...held.keys()].slice(0, 10).join(", ")}`);
		}
		log(`[hosts] host ${hostId} connected (${message.facts.version}, ${sandboxes.length} sandboxes)`);
		return welcomeFor({ ...host, facts: message.facts });
	};

	const cluster = options.cluster;
	const local = createHostHub({
		async onHello(hostId, message) {
			const welcome = await hello(hostId, message);
			// Recorded before the welcome, so no replica routes elsewhere once the host takes calls here.
			await cluster?.claim(hostId);
			return welcome;
		},
		onHeartbeat(hostId, capacity) {
			reserved.delete(hostId);
			report(
				(async () => {
					const host = await store.getHost(hostId);
					if (host !== undefined) await store.putHost({ ...host, capacity, lastSeenAt: clock.now() });
				})(),
			);
		},
		onEvent(hostId, event) {
			const sandbox = event.sandbox;
			if (sandbox === undefined) return;
			report(
				(async () => {
					const placement = await store.getPlacement(sandbox.id);
					if (placement === undefined || placement.hostId !== hostId) return;
					if (sandbox.state === "deleted") await store.removePlacement(sandbox.id);
					else await store.putPlacement({ ...placement, state: sandbox.state, updatedAt: clock.now() });
				})(),
			);
		},
		onDisconnected(hostId) {
			log(`[hosts] host ${hostId} disconnected`);
			cluster?.release(hostId);
			report(
				(async () => {
					const host = await store.getHost(hostId);
					if (host !== undefined) await store.putHost({ ...host, lastSeenAt: clock.now() });
				})(),
			);
		},
		...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
	});
	const hub = cluster === undefined ? local : cluster.route(local);

	const view = async (host: HostRecord, allocations = true): Promise<HostView> => {
		const placements = allocations ? await store.placementsOn(host.id) : [];
		const live = placements.filter((placement) => LIVE.has(placement.state));
		const facts = host.facts;
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
		return {
			id: host.id,
			name: host.name,
			state,
			...(facts === undefined ? {} : { version: facts.version, os: facts.os }),
			...(options.desiredVersion === undefined ? {} : { latestVersion: options.desiredVersion }),
			...(arch === undefined ? {} : { arch }),
			tiers: facts?.tiers ?? [],
			sizes: facts?.sizes ?? [],
			kvm: facts?.kvm ?? false,
			nestedVirtualisation: facts?.nested ?? false,
			capacity: { vcpus: facts?.cpus ?? 0, memoryMb: facts?.memoryMiB ?? 0, diskGb: facts?.diskGiB ?? 0 },
			allocated: {
				sandboxes: placements.filter((placement) => placement.state !== "lost").length,
				vcpus: live.reduce((sum, placement) => sum + placement.vcpus, 0),
				memoryMb: live.reduce((sum, placement) => sum + placement.memoryMiB, 0),
				diskGb: placements.reduce((sum, placement) => sum + placement.diskGiB, 0),
			},
			labels: { ...facts?.labels, ...host.labels },
			joinedAt: host.joinedAt,
			...(host.lastSeenAt === undefined ? {} : { lastSeenAt: host.lastSeenAt }),
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

	const onHost = async <T>(hostId: string, method: string, params: object, callOptions?: CallOptions): Promise<T> => {
		try {
			return await hub.call<T>(hostId, method, params, callOptions);
		} catch (error) {
			throw kantelErrorFromHost(error);
		}
	};

	const settle = async (placement: PlacementRecord, sandbox: HostSandbox): Promise<PlacementRecord> => {
		const settled = { ...placement, state: sandbox.state, updatedAt: clock.now() };
		await store.putPlacement(settled);
		return settled;
	};

	const reserve = (hostId: string, memoryMiB: number, diskGiB: number) => {
		reserved.set(hostId, [...(reserved.get(hostId) ?? []), { at: clock.now(), memoryMiB, diskGiB }]);
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
		async register(input) {
			if (typeof input.token !== "string" || !input.token.startsWith(JOIN_TOKEN_PREFIX)) {
				throw new KantelError("forbidden", "That isn't a host join token");
			}
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
				joinedAt: now,
				...(input.facts === undefined ? {} : { facts: input.facts }),
			});
			log(`[hosts] host ${hostId} (${name}) joined with token ${token.id}`);
			return { hostId, credential };
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
			const next: HostRecord = {
				...host,
				...(change.name === undefined ? {} : { name: change.name }),
				...(change.labels === undefined ? {} : { labels: labelsOf(change.labels) }),
				...(change.draining === undefined ? {} : { draining: change.draining === true }),
			};
			await store.putHost(next);
			if (change.draining !== undefined && change.draining !== host.draining) hub.rewelcome(hostId, welcomeFor(next));
			return view(next);
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
				const sizeName = tier === "isolate" ? "isolate" : (input.size ?? "default");
				const only = input.hostIds === undefined ? undefined : new Set(input.hostIds);
				if (input.from !== undefined && only?.size !== 1) {
					throw new KantelError("invalid", "A sandbox made from a snapshot goes on the snapshot's host");
				}
				// Two reads that don't depend on each other: one round trip.
				const [existing, listed] = await Promise.all([store.getPlacement(sandboxId), store.listHosts()]);
				if (existing !== undefined) throw new KantelError("conflict", "A sandbox with that ID exists");
				const hosts = listed.filter((host) => only === undefined || only.has(host.id));
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
				const chosen = place(
					{
						tier,
						size: sizeName,
						...(input.owner === undefined ? {} : { owner: input.owner }),
						...(input.labels === undefined ? {} : { labels: input.labels }),
					},
					candidates,
				);
				if (isRefusal(chosen)) throw new KantelError("exhausted", chosen.reason);
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
				try {
					const sandbox = await onHost<HostSandbox>(chosen.host.id, HostMethods.create, {
						sandboxId,
						tier,
						size: tier === "isolate" ? "" : chosen.size.name,
						...(input.from === undefined ? {} : { from: input.from }),
						...(input.owner === undefined ? {} : { owner: input.owner }),
						...(input.env === undefined ? {} : { env: input.env }),
						...(input.sshAuthorizedKeys === undefined ? {} : { sshAuthorizedKeys: input.sshAuthorizedKeys }),
						...(input.egress === undefined ? {} : { egress: input.egress }),
					});
					const settled = await settle(placement, sandbox);
					return {
						sandbox,
						hostId: chosen.host.id,
						placement: settled,
						nestedVirtualisation: chosen.host.facts?.nested ?? false,
					};
				} catch (error) {
					await store.removePlacement(sandboxId);
					throw error;
				}
			},
			async fork(sandboxId, input = {}) {
				const source = await placementOf(sandboxId);
				const newId = input.newId ?? shortId("sbx");
				if (!SANDBOX_ID.test(newId)) throw new KantelError("invalid", "Not a valid sandbox ID");
				if ((await store.getPlacement(newId)) !== undefined) {
					throw new KantelError("conflict", "A sandbox with that ID exists");
				}
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
					const sandbox = await onHost<HostSandbox>(source.hostId, HostMethods.fork, {
						sandboxId,
						newId,
						snapshotId: shortId("snap"),
						...(input.egress === undefined ? {} : { egress: input.egress }),
					});
					return { sandbox, hostId: source.hostId, placement: await settle(placement, sandbox) };
				} catch (error) {
					await store.removePlacement(newId);
					throw error;
				}
			},
			async call<T>(sandboxId: string, method: string, params: object = {}, callOptions?: CallOptions) {
				if (method === HostMethods.create || method === HostMethods.fork || method === HostMethods.portOpen) {
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
					await store.putPlacement({ ...placement, state, updatedAt: clock.now() });
				}
				return result;
			},
			async delete(sandboxId) {
				const placement = await placementOf(sandboxId);
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
				if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new KantelError("invalid", "Not a port");
				const placement = await placementOf(sandboxId);
				try {
					return await hub.openPort(placement.hostId, sandboxId, port, sink);
				} catch (error) {
					throw kantelErrorFromHost(error);
				}
			},
		},
		close() {
			hub.closeAll(1001, "The control plane is stopping");
		},
	};
}

export { sizeOn };
