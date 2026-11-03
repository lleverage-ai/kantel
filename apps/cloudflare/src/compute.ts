/**
 * The compute API on the Worker: `@kantel/compute`'s routes under `/v1` (accounts and organisations, sandboxes,
 * commands and files, snapshots, scoped `ksk_` keys, the egress proxy, webhooks, OpenTelemetry and hosts), served by
 * the stack object beside identity and audit, so the console this Worker serves works against it as a self-hosted
 * install's does.
 *
 * - **Records:** the compute store contract (`ComputeStore`) over SQL, `@kantel/compute/sql`, the same store the
 *   self-hosted gateway keeps in Postgres. Here it is the stack object's own SQLite (`objectSqlDriver`): one object
 *   answers every request, so there is one writer, and the records outlast a restart or a deploy.
 * - **Sandboxes:** the stub backend (`@kantel/compute/stub`), a just-bash shell over files in the object's memory, as a
 *   self-hosted gateway runs with no hosts. The object's memory goes when Cloudflare evicts it or a deploy replaces
 *   it, while the records stay: `revivingStub` then gives a sandbox the records still have a fresh, empty machine on
 *   its next call, rather than failing every call on it.
 * - **Kantel Connect** (experimental, `connect`, off by default): an account's own machines. A person enrols one
 *   (`POST /v1/connect/enrolments`); it registers at `POST /v1/hosts/register` with no sign-in, dials out to
 *   `GET /v1/hosts/connect` and keeps that WebSocket open to the stack object (`src/stack-object.ts`), which holds the
 *   one hub (`@kantel/hosts`), as a self-hosted gateway does. The registry of hosts and placements is in the object's
 *   SQLite. Sandboxes of an account with a host of its own go there (`createRoutedBackend`); everyone else's stay on
 *   the stub. SSH to those sandboxes is served (`GET /v1/hosts/tunnel/{ticket}`, over the host's connection); their
 *   desktops, browsers' CDP and exposed ports aren't yet.
 * - **People:** whoever the stack's authenticator signs in (Cloudflare Access, or an email code on the public origin)
 *   is a compute person under their user ID, and an admin of the deployment's own organisation (the bootstrap's) is the
 *   compute plane's super-admin, as self-hosted. With open sign-up everyone administers a personal space of their own;
 *   that makes nobody a super-admin. An identity
 *   `ktk_` key is not a compute caller; the compute API's own `ksk_` keys are.
 *
 * Its timers (webhook deliveries every second, the OpenTelemetry export every minute) run only while requests keep
 * coming (`IDLE_MS`), so they never keep the object awake on their own; each request's sweep and a delivery's next
 * attempt catch up when the next one comes.
 *
 * Portable: no Cloudflare APIs, so the tests run it in Node over `node:sqlite`.
 */
import {
	type Collection,
	type ComputeApi,
	type ComputeStore,
	createComputeApi,
	createMemoryStore,
	createRoutedBackend,
	joinTokenSpender,
	type PersonIdentity,
	type SandboxBackend,
	type StoredSandbox,
} from "@kantel/compute";
import { createSqlComputeStore, migrateComputeStore } from "@kantel/compute/sql";
import { createStubBackend, STUB_HOST_ID } from "@kantel/compute/stub";
import {
	type Authenticator,
	callContextFor,
	type IdentityDirectory,
	isKantelError,
	KantelError,
} from "@kantel/contracts";
import { createHostBackend } from "@kantel/hosts/backend";
import {
	createHostsApi,
	DEFAULT_HOST_IMAGES,
	HOSTS_CONNECT_PATH,
	HOSTS_IMAGES_PATH,
	HOSTS_REGISTER_PATH,
} from "@kantel/hosts/http";
import type { AcceptedHost, HostSocket } from "@kantel/hosts/hub";
import { HOST_CLOSE_REVOKED } from "@kantel/hosts/protocol";
import { createRelayAccess, RELAY_CLOSE_REVOKED, RELAY_REVOKED_REASON } from "@kantel/hosts/relay-access";
import { createMemoryRelayStore, createSqlRelayStore, migrateRelay } from "@kantel/hosts/relay-store";
import { createHostsService, type HostsService } from "@kantel/hosts/service";
import { createMemoryHostStore, createSqlHostStore, migrateHosts } from "@kantel/hosts/store";
import { createTunnelTickets, HOSTS_TUNNEL_PATH, type TunnelTickets } from "@kantel/hosts/tunnel";
import type { SqlDriver } from "@kantel/sql";
import { HOSTED_PORTS_DOMAIN } from "./config.ts";
import { buffered } from "./route.ts";

/** Where Cloudflare Access puts the signed-in person's token on each request it lets through. */
const ACCESS_ASSERTION = "cf-access-jwt-assertion";

/**
 * The request with Access's token as its bearer too, when it has an Access token and no `Authorization`. The console
 * sends no credential of its own behind Access (the edge signs the browser in with its cookie), and the compute API
 * asks every call for a bearer before it signs a person in. Nothing else changes: the stack's authenticator still reads
 * the person from `Cf-Access-Jwt-Assertion` (a bearer that is neither an API key nor a Kantel session never outranks
 * it), so the identity and audit routes answer as before.
 */
export function withAccessBearer(request: Request): Request {
	if (request.headers.has("authorization")) return request;
	const token = request.headers.get(ACCESS_ASSERTION)?.trim() ?? "";
	if (token === "" || /\s/.test(token)) return request;
	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${token}`);
	return new Request(request, { headers });
}

/** How often webhook deliveries that are due are sent, while requests come. */
const WEBHOOK_INTERVAL_MS = 1000;
/** How often telemetry is exported, while requests come. */
const TELEMETRY_INTERVAL_MS = 60_000;
/** How long after the last compute request the timers stop. */
export const IDLE_MS = 5 * 60_000;

export interface StackCompute {
	/** Answers a compute route, or resolves `undefined` for any other request. */
	fetch(request: Request): Promise<Response | undefined>;
	readonly api: ComputeApi;
	/** What `GET /v1/deployment`-style logs say about it. */
	readonly binding: string;
	/** Kantel Connect's host side, when it is on. */
	readonly hosts?: StackHosts;
	close(): Promise<void>;
}

/** What a host reaches with no sign-in, with Kantel Connect on. */
export interface StackHosts {
	readonly service: HostsService;
	/** Registration (`POST /v1/hosts/register`) and the images `kantel-host install` fetches; undefined for others. */
	fetch(request: Request): Promise<Response | undefined>;
	/**
	 * A host's connection (`GET /v1/hosts/connect`), once the server has accepted its WebSocket: checks the credential
	 * and hands the socket to the hub, or closes it with 4003 (kantel-host's "stop, don't retry") for a wrong or revoked
	 * one. Undefined when it was refused.
	 */
	connect(credential: string | undefined, socket: HostSocket): Promise<AcceptedHost | undefined>;
	/**
	 * A raw tunnel (`GET /v1/hosts/tunnel/{ticket}`: a sandbox's port as binary WebSocket frames, for SSH's
	 * ProxyCommand), once the server has accepted the client's WebSocket. Checks the ticket and that its grantee may still
	 * open the sandbox, then opens the port over the host's connection; the session is closed with 4003 once they lose
	 * access. Undefined, with the socket closed, when it was refused.
	 */
	tunnel(ticket: string, client: TunnelClient): Promise<{ write(bytes: Uint8Array): void; close(): void } | undefined>;
}

/** The client's side of a raw tunnel. */
export interface TunnelClient {
	send(bytes: Uint8Array): void;
	close(code: number, reason: string): void;
}

/** What `onMessages` needs of an accepted WebSocket. */
/** What a tunnel's client may send before its port is open (SSH sends a line and its key exchange: a few KiB). */
export const TUNNEL_PENDING_LIMIT = 256 * 1024;
/** And at most this many messages (an empty one is still an entry to keep). */
export const TUNNEL_PENDING_MESSAGES = 256;

/**
 * What a tunnel's client sends before the host has opened its port, held to be written once it has. The one stack
 * object holds every tunnel, so it holds at most `limit` bytes in at most `messages` messages: `hold` answers false
 * (and lets go of everything) past either, and the tunnel is closed rather than kept in memory while its host never
 * answers. `clear` lets go of it when the tunnel ends any other way; nothing is held after either.
 */
export function preOpenBuffer(limit = TUNNEL_PENDING_LIMIT, messages = TUNNEL_PENDING_MESSAGES) {
	let chunks: Uint8Array[] = [];
	let bytes = 0;
	let open = true;
	const clear = () => {
		open = false;
		chunks = [];
	};
	return {
		hold(chunk: Uint8Array): boolean {
			if (!open) return false;
			bytes += chunk.byteLength;
			if (bytes > limit || chunks.length >= messages) {
				clear();
				return false;
			}
			chunks.push(chunk);
			return true;
		},
		/** Everything held, in order; nothing is held after. */
		take(): Uint8Array[] {
			const out = chunks;
			clear();
			return out;
		},
		clear,
		/** What it holds now, for tests. */
		held: () => ({ messages: chunks.length, bytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) }),
	};
}

export interface MessageSocket {
	binaryType?: string;
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

/**
 * Hands an accepted socket's messages to `handle` in order, binary ones as bytes. Workers deliver binary messages as a
 * `Blob` unless asked for an `ArrayBuffer` (and the hub drops anything else), so the socket is asked; a `Blob` that
 * comes anyway is read without letting a later message overtake it. A frame whose handling fails is logged and
 * skipped, so one bad frame never leaves a host's connection open but deaf.
 */
export function onMessages(
	socket: MessageSocket,
	handle: (frame: string | Uint8Array) => void,
	log: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): void {
	try {
		socket.binaryType = "arraybuffer";
	} catch {
		// A runtime that won't: Blobs, read below.
	}
	let queue: Promise<void> = Promise.resolve();
	const failed = (error: unknown) => log("kantel: a WebSocket frame could not be handled", error);
	socket.addEventListener("message", (event) => {
		const data = event.data;
		if (typeof data === "string" || data instanceof ArrayBuffer) {
			const frame = typeof data === "string" ? data : new Uint8Array(data);
			queue = queue.then(() => handle(frame)).catch(failed);
		} else if (data instanceof Blob) {
			const read = data.arrayBuffer();
			// Read now, handled in turn; a read that fails is caught there, not left unhandled meanwhile.
			read.catch(() => undefined);
			queue = queue.then(async () => handle(new Uint8Array(await read))).catch(failed);
		}
	});
}

/** `/v1/hosts/tunnel/{ticket}`'s ticket, or undefined for any other path (a path after it is not served here). */
export function tunnelTicket(path: string): string | undefined {
	return new RegExp(`^${HOSTS_TUNNEL_PATH}/([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)$`).exec(path)?.[1];
}

/** The host credential on a host's connection request, if it carries one. */
export function hostCredential(request: Request): string | undefined {
	return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
}

export { HOSTS_CONNECT_PATH };

export interface StackComputeOptions {
	readonly authenticator: Authenticator;
	/** Who holds which role: an organisation admin who signs in is the compute plane's super-admin. */
	readonly identity: Pick<IdentityDirectory, "authorize">;
	/**
	 * The deployment's own organisation: only its admins are super-admins, and only its members may use compute here.
	 * Absent, any organisation's admin is a super-admin and anyone signed in may use it (tests with one organisation).
	 */
	readonly adminOrganisationId?: string;
	/** Where the records are: the stack object's SQLite. Absent, in memory (tests). */
	readonly sql?: SqlDriver;
	readonly now?: () => number;
	/** For webhook deliveries and telemetry exports. Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/**
	 * The domain port URLs are under, `{port}-{subdomain}.{domain}`. Default `HOSTED_PORTS_DOMAIN` (`ports.kantel.dev`).
	 * The stub backend only names the URLs; Connect hosts' public ports aren't served here yet either.
	 */
	readonly portsDomain?: string;
	/** Kantel Connect (KANTEL_CONNECT=experimental): where hosts reach this Worker. Absent, off. */
	readonly connect?: { readonly publicUrl: string };
}

/** What someone outside the deployment's organisation is told: compute here is the stub's memory, not a host of theirs. */
export const COMPUTE_MEMBERS_ONLY =
	"Sandboxes here are for the deployment's own organisation until hosts you add can run them";

/**
 * The person a sign-in is, or undefined for a key or no sign-in. As the self-hosted gateway does
 * (`apps/selfhosted/src/gateway/compute.ts`): a person's sign-in carries no role of its own, so `identity` says
 * whether they administer the organisation.
 *
 * Someone acting in another organisation (anyone who signed up on the public origin) is refused: the stub backend
 * keeps files and snapshots in this object's memory, which a stranger mustn't be able to fill. Refusing the person
 * refuses every way in, a compute key or a device sign-in included, since only a person can make either.
 */
async function personOf(
	authenticator: Authenticator,
	identity: Pick<IdentityDirectory, "authorize">,
	request: Request,
	adminOrganisationId: string | undefined,
): Promise<PersonIdentity | undefined> {
	let caller: Awaited<ReturnType<Authenticator["authenticate"]>>;
	try {
		caller = await authenticator.authenticate(request);
	} catch {
		return undefined;
	}
	if (caller.actor.kind !== "human") return undefined;
	if (adminOrganisationId !== undefined && caller.organisationId !== adminOrganisationId) {
		throw new KantelError("forbidden", COMPUTE_MEMBERS_ONLY);
	}
	// Only an admin of the deployment's organisation, never one of a personal space.
	const superAdmin = await identity.authorize(callContextFor(caller), "admin").then(
		() => true,
		() => false,
	);
	return { userId: caller.actor.userId, name: caller.actor.userId, superAdmin };
}

/** The compute API over the stub backend, its records in `sql` (or memory), signed in with `authenticator`. */
export async function createStackCompute(options: StackComputeOptions): Promise<StackCompute> {
	let store: ComputeStore;
	if (options.sql === undefined) store = createMemoryStore();
	else {
		await migrateComputeStore(options.sql);
		store = createSqlComputeStore(options.sql);
	}
	const now = options.now ?? Date.now;
	const stub = revivingStub(
		createStubBackend({ sandboxDomain: options.portsDomain ?? HOSTED_PORTS_DOMAIN }),
		store.sandboxes,
	);
	const connect = options.connect === undefined ? undefined : await connectHosts(options.connect, options.sql, now);
	const api = createComputeApi({
		store,
		backend:
			connect === undefined
				? stub
				: createRoutedBackend({
						primary: connect.backend,
						fallback: stub,
						holds: async (sandboxId) => (await connect.service.sandboxes.placement(sandboxId)) !== undefined,
						holdsSnapshot: isHostSnapshotRef,
					}),
		authenticatePerson: (request) =>
			personOf(options.authenticator, options.identity, request, options.adminOrganisationId),
		mode: "hosted",
		now,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		// Enrolment commands name the address hosts dial, as tunnel URLs do, not the caller's origin.
		...(connect === undefined ? {} : { connect: true, publicUrl: connect.publicUrl }),
	});
	connect?.service.useJoinTokens(joinTokenSpender(store));
	connect?.bind((grantee, sandboxId) => api.service.stillAllowed(grantee, sandboxId));
	const timers = whileBusy(api, now);
	const records = options.sql === undefined ? "memory" : "the stack object's SQLite";
	return {
		api,
		binding: `${records}, stub backend${connect === undefined ? "" : " and Kantel Connect hosts"} (experimental)`,
		...(connect === undefined ? {} : { hosts: connect.hosts }),
		async fetch(request) {
			const answer = await api.fetch(request);
			if (answer !== undefined) timers.touch();
			return answer;
		},
		async close() {
			timers.stop();
			connect?.access.stop();
			connect?.service.close();
			await api.close();
		},
	};
}

/**
 * Kantel Connect's host side: the registry (in `sql`, else memory), the backend over it, and what hosts and tunnel
 * clients reach. Of the tunnels the backend issues tickets for, raw ones (SSH) are served; desktops, a browser's CDP
 * and exposed ports aren't yet.
 */
async function connectHosts(
	config: { readonly publicUrl: string },
	sql: SqlDriver | undefined,
	now: () => number,
): Promise<{
	service: HostsService;
	backend: SandboxBackend;
	publicUrl: string;
	hosts: StackHosts;
	access: ReturnType<typeof createRelayAccess>;
	bind(stillAllowed: (grantee: string | undefined, sandboxId: string) => Promise<boolean>): void;
}> {
	if (sql !== undefined) {
		await migrateHosts(sql);
		await migrateRelay(sql);
	}
	const service = createHostsService({
		store: sql === undefined ? createMemoryHostStore() : createSqlHostStore(sql),
		publicUrl: config.publicUrl,
	});
	const tickets = sweptAsUsed(
		createTunnelTickets(sql === undefined ? createMemoryRelayStore() : createSqlRelayStore(sql), now),
		now,
	);
	const backend = createHostBackend({ hosts: service, publicUrl: config.publicUrl, tickets, now });
	let check: ((grantee: string | undefined, sandboxId: string) => Promise<boolean>) | undefined;
	// Its timer runs only while a session is held, so it never keeps the object awake on its own.
	const access = createRelayAccess({
		stillAllowed: (grantee, sandboxId) => check?.(grantee, sandboxId) ?? Promise.resolve(false),
		now,
	});
	// Registration only: the compute API serves hosts' management, so the registry's own admin routes refuse everyone.
	const register = createHostsApi({
		hosts: service,
		authorizeAdmin: () => Promise.reject(new KantelError("not_found", "Not found")),
	});
	return {
		service,
		backend,
		access,
		publicUrl: config.publicUrl,
		bind(stillAllowed) {
			check = stillAllowed;
		},
		hosts: {
			service,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === HOSTS_REGISTER_PATH) {
					// Any other method has no body to bound: the handler answers it 405.
					if (request.method !== "POST") return register.fetch(request);
					// Anyone can reach it (past Access), so its body is counted as it comes, before any of it is parsed.
					const bounded = await buffered(request, HOST_REGISTER_BODY_LIMIT);
					return bounded instanceof Response ? bounded : register.fetch(bounded);
				}
				if (path.startsWith(`${HOSTS_IMAGES_PATH}/`)) return hostImage(request, path);
				return undefined;
			},
			async connect(credential, socket) {
				const host = credential === undefined ? undefined : await service.authenticate(credential);
				if (host === undefined) {
					socket.close(HOST_CLOSE_REVOKED, "The host credential is unknown or revoked");
					return undefined;
				}
				return service.hub.accept(host.id, socket);
			},
			async tunnel(ticket, client) {
				const grant = await tickets.verify(ticket, now());
				// A desktop's ticket opens only the desktop's route, which isn't served here.
				if (grant === undefined || grant.desktop !== undefined) {
					client.close(HOST_CLOSE_REVOKED, "The tunnel URL is wrong or has expired");
					return undefined;
				}
				if (!(await access.allowed(grant.grantee, grant.sandboxId))) {
					client.close(RELAY_CLOSE_REVOKED, RELAY_REVOKED_REASON);
					return undefined;
				}
				let stream: { write(bytes: Uint8Array): void; close(): void } | undefined;
				const release = access.track({
					sandboxId: grant.sandboxId,
					kind: grant.port === 22 ? "ssh" : `tunnel ${grant.port}`,
					...(grant.grantee === undefined ? {} : { grantee: grant.grantee }),
					end: (reason) => {
						client.close(RELAY_CLOSE_REVOKED, reason);
						stream?.close();
					},
				});
				access.start();
				const done = () => {
					release();
					if (access.size === 0) access.stop();
				};
				try {
					stream = await service.sandboxes.openPort(grant.sandboxId, grant.port, {
						// Never throws into the host's connection: a client that can't take bytes is closed instead.
						data: (bytes) => {
							try {
								client.send(bytes);
							} catch {
								client.close(1011, "The tunnel's client is gone");
								stream?.close();
							}
						},
						end: (reason) => {
							done();
							client.close(1000, reason.slice(0, 120));
						},
					});
				} catch (error) {
					done();
					client.close(1011, (error instanceof Error ? error.message : String(error)).slice(0, 120));
					return undefined;
				}
				const opened = stream;
				return {
					write: (bytes) => opened.write(bytes),
					close() {
						done();
						opened.close();
					},
				};
			},
		},
	};
}

/** How often issuing a ticket also forgets long-expired ones. */
const TICKET_SWEEP_MS = 10 * 60_000;

/**
 * Tickets that forget long-expired ones as new ones are issued, at most every `TICKET_SWEEP_MS`. A self-hosted gateway
 * sweeps on a timer; here a timer would keep the object awake, so the sweep rides on use instead.
 */
export function sweptAsUsed(tickets: TunnelTickets, now: () => number): TunnelTickets {
	let last = Number.NEGATIVE_INFINITY;
	return {
		issue(grant) {
			const at = now();
			if (at - last >= TICKET_SWEEP_MS) {
				last = at;
				void tickets.sweep(at).catch((error: unknown) => console.error("kantel: sweeping tunnel tickets", error));
			}
			return tickets.issue(grant);
		},
		verify: (ticket, at) => tickets.verify(ticket, at),
		sweep: (at) => tickets.sweep(at),
	};
}

/** A registration is a token, a name, labels and facts: a few kilobytes. */
export const HOST_REGISTER_BODY_LIMIT = 64 * 1024;

/** `GET /v1/hosts/images/{file}`: Kantel's published images, as a self-hosted gateway serves them by default. */
function hostImage(request: Request, path: string): Response {
	const name = path.slice(HOSTS_IMAGES_PATH.length + 1);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return new Response("Not found", { status: 404 });
	if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
	return new Response(null, { status: 302, headers: { location: `${DEFAULT_HOST_IMAGES}/${name}` } });
}

/** Runs the API's timers from a request until `IDLE_MS` after the last one, then sends what telemetry is queued. */
function whileBusy(api: ComputeApi, now: () => number): { touch(): void; stop(): void } {
	let last = 0;
	let check: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		if (check === undefined) return;
		clearTimeout(check);
		check = undefined;
		api.dispatcher.stop();
		api.exporter.stop();
	};
	const watch = () => {
		check = setTimeout(() => {
			if (now() - last < IDLE_MS) return watch();
			stop();
			api.exporter.flush().catch(() => undefined);
		}, IDLE_MS / 5);
	};
	return {
		touch() {
			last = now();
			if (check !== undefined) return;
			api.dispatcher.start(WEBHOOK_INTERVAL_MS);
			api.exporter.start(TELEMETRY_INTERVAL_MS);
			watch();
		},
		stop,
	};
}

/** A Connect host's snapshot reference is `{hostId}/{snapshotId}`; the stub's are `ref_…`. */
export const isHostSnapshotRef = (ref: string): boolean => ref.startsWith("host_") && ref.includes("/");

const lost = (error: unknown, prefix: string): error is KantelError =>
	isKantelError(error) && error.code === "not_found" && error.message.startsWith(prefix);
/** The stub's refusal for a sandbox it has no machine for (`stub-backend.ts`). */
const NO_MACHINE = "The stub has no machine for ";
/** The stub's refusal for a snapshot it doesn't hold. */
const NO_SNAPSHOT = "The stub has no snapshot ";

/**
 * The stub, for a stub whose memory can go while the records stay. A call for a sandbox it has no machine for gives that
 * sandbox a fresh machine (an empty disk, its type, size and environment from the record) and is made again; a boot
 * from a snapshot it no longer holds boots from an empty disk. Anything else, and a sandbox the records don't have,
 * fails as the stub does.
 */
export function revivingStub(stub: SandboxBackend, sandboxes: Collection<StoredSandbox>): SandboxBackend {
	/**
	 * A sandbox or snapshot a Connect host holds is never the stub's to revive: with Connect off (or its host's placement
	 * gone) it's refused, so its disk and its host stay as they are for when the host is back.
	 */
	const onHost = () =>
		new KantelError("unavailable", "It is on a Kantel Connect host, which this deployment can't reach now");
	const hostBacked = async (sandboxId: string) => {
		const hostId = (await sandboxes.get(sandboxId))?.hostId;
		return hostId !== undefined && hostId !== STUB_HOST_ID;
	};
	const refuseHostSnapshot = (ref: string | undefined) => {
		if (ref !== undefined && isHostSnapshotRef(ref)) throw onHost();
	};
	const revive = async (sandboxId: string, cause: KantelError): Promise<void> => {
		const record = await sandboxes.get(sandboxId);
		if (record === undefined || record.state === "deleted") throw cause;
		if (record.hostId !== undefined && record.hostId !== STUB_HOST_ID) throw onHost();
		const made = stub.create({
			sandboxId,
			accountId: record.accountId,
			type: record.type,
			subdomain: record.subdomain,
			...(record.size === undefined ? {} : { size: record.size }),
			...(record.image === undefined ? {} : { image: record.image }),
			env: record.env,
			eligibleHosts: [STUB_HOST_ID],
		});
		// Another call revived it first.
		await made.catch((error: unknown) => {
			if (!isKantelError(error) || error.code !== "conflict") throw error;
		});
	};
	const onMachine = async <T>(sandboxId: string, call: () => Promise<T>): Promise<T> => {
		try {
			return await call();
		} catch (error) {
			if (!lost(error, NO_MACHINE)) throw error;
			await revive(sandboxId, error);
			return call();
		}
	};
	/** `call` with `options`, or without its snapshot when the stub no longer holds it. */
	const fromAny = async <O extends { readonly fromSnapshot?: string }, T>(
		options: O,
		call: (options: O) => Promise<T>,
	): Promise<T> => {
		refuseHostSnapshot(options.fromSnapshot);
		try {
			return await call(options);
		} catch (error) {
			if (!lost(error, NO_SNAPSHOT) || options.fromSnapshot === undefined) throw error;
			const { fromSnapshot: _gone, ...rest } = options;
			return call(rest as O);
		}
	};
	return {
		...stub,
		create: (spec) => fromAny(spec, (given) => stub.create(given)),
		start: (id, options) => onMachine(id, () => fromAny(options, (given) => stub.start(id, given))),
		stop: (id, options) => onMachine(id, () => stub.stop(id, options)),
		resume: (id, options) => onMachine(id, () => fromAny(options, (given) => stub.resume(id, given))),
		recover: (id, options) => onMachine(id, () => fromAny(options, (given) => stub.recover(id, given))),
		fork: async (source, targets) => {
			refuseHostSnapshot(source.snapshot);
			return source.snapshot === undefined
				? onMachine(source.sandboxId, () => stub.fork(source, targets))
				: stub.fork(source, targets);
		},
		async destroy(id) {
			// The stub would answer that it has nothing to delete, and the host's machine would be left running.
			if (await hostBacked(id)) throw onHost();
			return stub.destroy(id);
		},
		listSnapshotFiles: async (ref, path) => {
			refuseHostSnapshot(ref);
			return stub.listSnapshotFiles(ref, path);
		},
		readSnapshotFile: async (ref, path) => {
			refuseHostSnapshot(ref);
			return stub.readSnapshotFile(ref, path);
		},
		deleteSnapshot: async (ref) => {
			refuseHostSnapshot(ref);
			return stub.deleteSnapshot(ref);
		},
		exec: (id, request) => onMachine(id, () => stub.exec(id, request)),
		readFile: (id, path, range) => onMachine(id, () => stub.readFile(id, path, range)),
		writeFile: (id, path, content, mode) => onMachine(id, () => stub.writeFile(id, path, content, mode)),
		deleteFile: (id, path) => onMachine(id, () => stub.deleteFile(id, path)),
		listFiles: (id, path) => onMachine(id, () => stub.listFiles(id, path)),
		takeSnapshot: (id) => onMachine(id, () => stub.takeSnapshot(id)),
		exposePort: (id, port, options) => onMachine(id, () => stub.exposePort(id, port, options)),
		openSsh: (id, options) => onMachine(id, () => stub.openSsh(id, options)),
		openDesktop: (id, options) => onMachine(id, () => stub.openDesktop(id, options)),
		openBrowser: (id, options) => onMachine(id, () => stub.openBrowser(id, options)),
		usage: (id) => onMachine(id, () => stub.usage(id)),
	};
}
