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
 * - **Account hosts** (experimental, `accountHosts`, off by default): an account's own machines. A person adds one
 *   (`POST /v1/hosts/join-tokens`); it registers at `POST /v1/hosts/register` with no sign-in, dials out to
 *   `GET /v1/hosts/connect` and keeps that WebSocket open to the stack object (`src/stack-object.ts`), which holds the
 *   one hub (`@kantel/hosts`), as a self-hosted gateway does. The registry of hosts and placements is in the object's
 *   SQLite. Sandboxes of an account with a host of its own go there (`createRoutedBackend`); everyone else's stay on
 *   the stub. Their tunnels are served over the host's connection as the self-hosted gateway serves them: SSH
 *   (`GET /v1/hosts/tunnel/{ticket}`), a desktop's page and stream (`/v1/hosts/desktop/{ticket}/`, `@kantel/hosts/desktop`,
 *   a view-only ticket's messages filtered), a browser's CDP (`/v1/hosts/tunnel/{ticket}/{path}`), and their exposed
 *   ports at `https://{port}-{subdomain}.{portsDomain}`, pages (`src/port-serving.ts`) and WebSockets alike.
 * - **Image patching** (experimental, `imagePatching`, off by default): `KANTEL_IMAGE_PATCHING=experimental` reads
 *   the base image index CI publishes, from `KANTEL_BASE_IMAGE_INDEX` (default the `base-images` GitHub Release's
 *   index.json, `DEFAULT_BASE_IMAGE_INDEX`), at most every 5 minutes, a failure kept for a minute. Sandboxes and saved
 *   snapshots then say which base they are on and how far behind it is (`base`; the stub reports none), `POST
 *   /v1/sandboxes/{id}/restart-on-latest` moves one onto the newest, `GET /v1/admin/hosts/images` lists the images
 *   and their CVE scans, and account hosts are told the host images to fetch in their welcome. Off, there is no `base`
 *   and those routes answer 501 not_supported.
 * - **Protected values:** with `secretsKey` (the KANTEL_SECRETS_KEY Worker secret), environments' protected variables
 *   and secret files are sealed with it in the object's SQLite, by the same sealer as self-hosted
 *   (`@kantel/compute/secrets`), and an account host fetches its sandboxes' protected values over its connection for its
 *   egress proxy to swap in (`protectedTable`), as a self-hosted gateway's hosts do. Without it they are refused with
 *   `not_supported`, `GET /v1/whoami` says `protectedValues: false`, and the object logs why at start.
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
	baseImageIndexReader,
	type Collection,
	type ComputeApi,
	type ComputeStore,
	createComputeApi,
	createMemoryStore,
	createRoutedBackend,
	hostSnapshotLinks,
	type InviteMailing,
	joinTokenSpender,
	type PersonIdentity,
	personName,
	type SandboxBackend,
	type StoredSandbox,
	secretsKeyMissing,
} from "@kantel/compute";
import { createSqlComputeStore, migrateComputeStore } from "@kantel/compute/sql";
import { createStubBackend, STUB_HOST_ID } from "@kantel/compute/stub";
import {
	type Authenticator,
	callContextFor,
	type IdentityDirectory,
	isKantelError,
	KantelError,
	systemContext,
} from "@kantel/contracts";
import { BROWSER_PORT, createHostBackend, SSH_PORT } from "@kantel/hosts/backend";
import { createDesktopRoutes, HOSTS_DESKTOP_PATH } from "@kantel/hosts/desktop";
import {
	createHostsApi,
	DEFAULT_HOST_IMAGES,
	HOSTS_CONNECT_PATH,
	HOSTS_IMAGES_PATH,
	HOSTS_REGISTER_PATH,
	HOSTS_RELEASE_CHECK_PATH,
} from "@kantel/hosts/http";
import { type AcceptedHost, closeQuietly, type HostSocket } from "@kantel/hosts/hub";
import { openPortWebSocket, type PortWebSocket } from "@kantel/hosts/port-websocket";
import {
	createPortRouter,
	LEGACY_PORT_COOKIE,
	PORT_COOKIE,
	PORT_COOKIE_BASE,
	type PortRouter,
} from "@kantel/hosts/ports";
import { HOST_CLOSE_REVOKED } from "@kantel/hosts/protocol";
import { createRelayAccess, RELAY_CLOSE_REVOKED, RELAY_REVOKED_REASON } from "@kantel/hosts/relay-access";
import { createMemoryRelayStore, createSqlRelayStore, migrateRelay } from "@kantel/hosts/relay-store";
import { createHostReleases, createSqlHostReleasesStore } from "@kantel/hosts/releases";
import { createHostsService, type HostsService } from "@kantel/hosts/service";
import { createMemoryHostStore, createSqlHostStore, migrateHosts } from "@kantel/hosts/store";
import { createTunnelTickets, HOSTS_TUNNEL_PATH, type TunnelTickets } from "@kantel/hosts/tunnel";
import { hashSessionToken, isSessionToken } from "@kantel/identity/otp";
import type { SqlDriver } from "@kantel/sql";
import { HOSTED_PORTS_DOMAIN, isPortName } from "./config.ts";
import { createPortServing, type PortServingLimits } from "./port-serving.ts";
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
	/** Account hosts' host side, when it is on. */
	readonly hosts?: StackHosts;
	/** Whether a host name is an exposed port's (`{label}.{portsDomain}`): only `servePort` answers it, never the API. */
	isPortName(hostname: string): boolean;
	/**
	 * The answer on an exposed port's name: the sandbox's own page, relayed over its host's connection, with the port's
	 * token unless it was exposed public (`@kantel/hosts/ports`). A 404 for a name nobody exposed, and for every name
	 * while account hosts are off. A WebSocket there is the stack object's (`StackHosts.socketTarget`) with account
	 * hosts on; this answers one only with them off.
	 */
	servePort(request: Request): Promise<Response>;
	close(): Promise<void>;
}

/** What a host reaches with no sign-in, with account hosts on. */
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
	/** Exposed ports: their URLs, and the pages behind them. */
	readonly ports: PortRouter;
	/**
	 * A raw tunnel (`GET /v1/hosts/tunnel/{ticket}`: a sandbox's port as binary WebSocket frames, for SSH's
	 * ProxyCommand), once the server has accepted the client's WebSocket. Checks the ticket and that its grantee may still
	 * open the sandbox, then opens the port over the host's connection; the session is closed with 4003 once they lose
	 * access. Undefined, with the socket closed, when it was refused.
	 */
	tunnel(ticket: string, client: TunnelClient): Promise<{ write(bytes: Uint8Array): void; close(): void } | undefined>;
	/**
	 * Where a WebSocket upgrade goes, as the self-hosted gateway decides it (`withHostUpgrades`): a desktop's stream
	 * (`/v1/hosts/desktop/{ticket}/api/websockets`), a tunnel with a path (`/v1/hosts/tunnel/{ticket}/{path}`: Chromium's
	 * DevTools, for CDP clients), or an exposed port's name. A refusal says how to close the socket, or undefined for an
	 * upgrade that is none of these (SSH's raw tunnel and a host's connection have their own).
	 */
	socketTarget(request: Request): Promise<SocketTarget | SocketRefusal | undefined>;
	/**
	 * Opens `target`'s WebSocket on the sandbox's port, over its host's connection, offering the client's `protocols`,
	 * and passes messages both ways; held in the relay's access while open and closed with 4003 once its holder loses
	 * access to the sandbox. What the sandbox sends is held only within `RelayLimits` while it arrives.
	 */
	relay(target: SocketTarget, client: SocketClient, protocols?: readonly string[]): RelayedSocket;
}

/** The most of one message from a sandbox a relay holds while it arrives. */
export const RELAY_MESSAGE_LIMIT = 16 * 1024 * 1024;
/** The most every relay together holds of messages from sandboxes still arriving. */
export const RELAY_BUDGET = 32 * 1024 * 1024;
/** How long a sandbox's server has to answer a relayed WebSocket's handshake. */
export const RELAY_HANDSHAKE_MS = 15_000;

/**
 * Bounds on relayed WebSockets in the one stack object (which also holds every account's API and host connection):
 * a message from a sandbox past `messageBytes`, or one that would take every relay together past `budgetBytes`, closes
 * its socket (1009) before more of it is held.
 */
export interface RelayLimits {
	readonly messageBytes?: number;
	readonly budgetBytes?: number;
	readonly handshakeMs?: number;
}

/** A WebSocket to pass through to a sandbox's port. */
export interface SocketTarget {
	readonly sandboxId: string;
	readonly port: number;
	/** Path and query on the port. */
	readonly path: string;
	/** The Host it is opened with: an exposed port's public name; absent, `127.0.0.1:{port}` (DevTools wants that). */
	readonly host?: string;
	/** Whether a client message may pass (a view-only desktop's filter); absent, all do. */
	readonly accept?: (data: string | Uint8Array, binary: boolean) => boolean;
	/** What the relay's access log calls it: `desktop`, `cdp`, `port 3000`. */
	readonly kind: string;
	readonly grantee?: string;
	/**
	 * Headers for the sandbox's server: an exposed port's application cookies (Kantel's gate cookie taken out) and
	 * `Authorization`, as its pages get them. None for a desktop or CDP, which never get the console's credentials.
	 */
	readonly headers?: Readonly<Record<string, string>>;
}

/** A WebSocket upgrade refused: accepted, then closed with this, as self-hosted does. */
export interface SocketRefusal {
	readonly refused: { readonly code: number; readonly reason: string };
}

/** The client's side of a relayed WebSocket. */
export interface SocketClient {
	send(data: string | Uint8Array): void;
	close(code: number, reason: string): void;
}

/** What the client sends, to the sandbox. */
export interface RelayedSocket {
	/**
	 * Settles once the sandbox's server has answered the handshake, with the subprotocol it chose of those offered (the
	 * client's 101 must carry it), or undefined when it refused, failed or took too long (the client is closed then).
	 */
	readonly ready: Promise<{ readonly protocol?: string } | undefined>;
	send(data: string | Uint8Array): void;
	close(): void;
}

/** `/v1/hosts/tunnel/{ticket}[/{path}]`: a sandbox's port, as the ticket grants. */
const TUNNEL_PATH = new RegExp(`^${HOSTS_TUNNEL_PATH}/([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)(/.*)?$`);

/** The close code standing for an HTTP refusal of an upgrade, as self-hosted's (4000 plus the status). */
const refusalCode = (status: number) => 4000 + status;

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
	/**
	 * Who holds which role: an organisation admin who signs in is the compute plane's super-admin, and a member of the
	 * deployment's organisation may use the stub.
	 */
	/** With `roleOf`, deleting an account knows the deployment's admins whichever organisation a call names. */
	readonly identity: Pick<IdentityDirectory, "authorize" | "getUser"> & Partial<Pick<IdentityDirectory, "roleOf">>;
	/**
	 * The deployment's own organisation: only its admins are super-admins, and only its members may use the stub here.
	 * Others are refused, or with account hosts on, may use only hosts of their own. Absent, any organisation's admin
	 * is a super-admin and anyone signed in may use it (tests with one organisation).
	 */
	readonly adminOrganisationId?: string;
	/**
	 * Whether a Kantel session (its token's hash) is live: a tunnel given under one ends when it does. Absent (no email
	 * sign-in), sign-ins are taken to last; Access tokens carry no session to end.
	 */
	readonly sessionLive?: (session: string) => Promise<boolean>;
	/** Removes a person from sign-in once they delete their account (`ComputeServiceOptions.deletePerson`). */
	readonly deletePerson?: (userId: string) => Promise<void>;
	/** Wakes the stack object for the next account deletion pass (`ComputeServiceOptions.wakeAt`): its alarm. */
	readonly wakeAt?: (at: number) => Promise<void> | void;
	/** Where the records are: the stack object's SQLite. Absent, in memory (tests). */
	readonly sql?: SqlDriver;
	readonly now?: () => number;
	/** For webhook deliveries and telemetry exports. Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/**
	 * The domain port URLs are under, `{port}-{subdomain}.{domain}`. Default `HOSTED_PORTS_DOMAIN` (`kantel.run`). The
	 * stub backend only names the URLs; account hosts' microVMs' ports are served on them (`servePort`).
	 */
	readonly portsDomain?: string;
	/** Bounds on exposed ports' traffic in this object (`src/port-serving.ts`). Default its constants. */
	readonly portLimits?: PortServingLimits;
	/** Bounds on relayed WebSockets (desktops, CDP, exposed ports) in this object. Default `RELAY_*`. */
	readonly relayLimits?: RelayLimits;
	/**
	 * Account hosts (KANTEL_ACCOUNT_HOSTS=experimental): where hosts reach this Worker, and where the latest kantel-host
	 * release is read (`releasesUrl`; absent, it isn't, and no host is said to be out of date). Absent, off.
	 */
	readonly accountHosts?: {
		readonly publicUrl: string;
		readonly releasesUrl?: string;
		/** KANTEL_RELEASE_CHECK_TOKEN: the bearer `POST /v1/hosts/releases/check` takes. Absent, it refuses every call. */
		readonly releaseToken?: string;
	};
	/** Templates (KANTEL_TEMPLATES=experimental): versioned microVM profiles and their snapshot cache. Default off. */
	readonly templates?: boolean;
	/** Expiry of automatic snapshots (KANTEL_SNAPSHOT_EXPIRY=on). Default off. */
	readonly snapshotExpiry?: boolean;
	/**
	 * KANTEL_SECRETS_KEY: 32 bytes, base64, sealing environments' protected values and secret files. Absent, the stack
	 * object's SQLite store refuses them (`not_supported`); the memory store (tests) seals with a key of its own.
	 */
	readonly secretsKey?: string;
	/** With account hosts on, how often sandboxes past their auto-stop time are stopped. Default `HOST_SWEEP_MS`. */
	readonly hostSweepMs?: number;
	/** Image patching (KANTEL_IMAGE_PATCHING=experimental): where the base image index is read. Absent, off. */
	readonly imagePatching?: { readonly indexUrl: string };
	/** Emails an organisation's invites, with a link to join, where the deployment has mail. Absent, none. */
	readonly invites?: InviteMailing;
}

/**
 * With account hosts on, how often sandboxes past their auto-stop time are stopped, and due webhook deliveries sent,
 * compute requests or not: a sandbox on an account's host is a real machine of someone's, which may be used over SSH
 * alone. A connected host keeps the object up (its socket isn't hibernated), so this runs while there's a host to stop
 * anything on, and once more as each connects.
 */
export const HOST_SWEEP_MS = 30_000;
/** How long after a host connects its overdue sandboxes are swept: time for its hello to land. */
const SWEEP_AFTER_CONNECT_MS = 2000;

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
 * refuses every way in, a compute key or a device sign-in included, since only a person can make either. With account
 * hosts on (`accountHosts`) they are let in, never as a super-admin, to add and use hosts of their own: `sharedHosts`
 * (`membersOf`) keeps them, and their keys, off the stub, with account hosts on or off.
 *
 * Their name and email come from `identity` too (a sign-in carries neither): an invite made for an address is joined
 * by matching it, so without it no such invite could be, and the members list and "created by" name them so.
 */
async function personOf(
	authenticator: Authenticator,
	identity: Pick<IdentityDirectory, "authorize" | "getUser">,
	request: Request,
	adminOrganisationId: string | undefined,
	accountHosts: boolean,
): Promise<PersonIdentity | undefined> {
	let caller: Awaited<ReturnType<Authenticator["authenticate"]>>;
	try {
		caller = await authenticator.authenticate(request);
	} catch {
		return undefined;
	}
	if (caller.actor.kind !== "human") return undefined;
	const outside = adminOrganisationId !== undefined && caller.organisationId !== adminOrganisationId;
	if (outside && !accountHosts) throw new KantelError("forbidden", COMPUTE_MEMBERS_ONLY);
	const ctx = callContextFor(caller);
	const [superAdmin, user] = await Promise.all([
		// Only an admin of the deployment's organisation, never one of a personal space.
		!outside &&
			identity.authorize(ctx, "admin").then(
				() => true,
				() => false,
			),
		identity.getUser(ctx, caller.actor.userId).catch(() => undefined),
	]);
	const email = user?.email === undefined || user.email === "" ? undefined : user.email;
	// A Kantel session can be ended (signing out), so access given under it records which one, to end with it.
	const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
	const session = bearer !== undefined && isSessionToken(bearer) ? await hashSessionToken(bearer) : undefined;
	return {
		userId: caller.actor.userId,
		// As they are known everywhere else: their name, else their email, never their user ID while either is known.
		name: personName({ userId: caller.actor.userId, name: user?.name, email }),
		...(email === undefined ? {} : { email }),
		superAdmin,
		...(session === undefined ? {} : { session }),
	};
}

/** How long `membersOf` reuses an answer: a person who leaves the organisation loses the stub within this. */
export const MEMBERSHIP_CACHE_MS = 5000;

/**
 * Whether a user is a member of the deployment's organisation, who may use the stub: as sign-in has it (the
 * organisation they were created in, or any role there, a project's included), which `getUser` asked as Kantel
 * answers. Anything else, an error included, is no. Answers are reused for `MEMBERSHIP_CACHE_MS`, since every
 * sandbox call on the stub asks.
 */
function membersOf(
	identity: Pick<IdentityDirectory, "getUser">,
	organisationId: string,
	now: () => number,
): (userId: string) => Promise<boolean> {
	const answers = new Map<string, { at: number; member: boolean }>();
	return async (userId) => {
		const cached = answers.get(userId);
		if (cached !== undefined && now() - cached.at < MEMBERSHIP_CACHE_MS) return cached.member;
		const member = await identity.getUser({ ...systemContext("compute"), organisationId }, userId).then(
			() => true,
			() => false,
		);
		if (answers.size >= 1000) answers.clear();
		answers.set(userId, { at: now(), member });
		return member;
	};
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
	const portsDomain = options.portsDomain ?? HOSTED_PORTS_DOMAIN;
	const stub = revivingStub(createStubBackend({ sandboxDomain: portsDomain }), store.sandboxes);
	const own =
		options.accountHosts === undefined
			? undefined
			: await accountHostsSide(
					{
						...options.accountHosts,
						portsDomain,
						...(options.relayLimits === undefined ? {} : { relayLimits: options.relayLimits }),
						...(options.fetch === undefined ? {} : { fetch: options.fetch }),
					},
					options.sql,
					now,
				);
	const deploymentOrganisation = options.adminOrganisationId;
	// The deployment's admins, whichever organisation a call names: a person in their own space too isn't a super-admin
	// there, but still may not delete the account the deployment's administration rests on.
	const roleOf = options.identity.roleOf?.bind(options.identity);
	const deploymentAdmin =
		deploymentOrganisation === undefined || roleOf === undefined
			? undefined
			: async (userId: string) =>
					(await roleOf(systemContext("compute"), { kind: "human", userId }, deploymentOrganisation)) === "admin";
	// One cached read of the index for the API and the hosts' welcome alike; the object keeps it between requests.
	const baseImages =
		options.imagePatching === undefined
			? undefined
			: baseImageIndexReader({
					url: options.imagePatching.indexUrl,
					...(options.fetch === undefined ? {} : { fetch: options.fetch }),
					now,
				});
	const api = createComputeApi({
		store,
		backend:
			own === undefined
				? stub
				: createRoutedBackend({
						primary: own.backend,
						fallback: stub,
						holds: async (sandboxId) => (await own.service.sandboxes.placement(sandboxId)) !== undefined,
						// The stub's are those it placed. One no host holds and the stub never placed (its create on an account's
						// host failed) isn't revived on the stub: it is made again where its create would put it.
						fallbackHolds: async (sandboxId) => (await store.sandboxes.get(sandboxId))?.hostId === STUB_HOST_ID,
						holdsSnapshot: isHostSnapshotRef,
					}),
		authenticatePerson: (request) =>
			personOf(options.authenticator, options.identity, request, options.adminOrganisationId, own !== undefined),
		...(options.sessionLive === undefined ? {} : { sessionLive: options.sessionLive }),
		...(options.deletePerson === undefined ? {} : { deletePerson: options.deletePerson }),
		...(options.wakeAt === undefined ? {} : { wakeAt: options.wakeAt }),
		...(deploymentAdmin === undefined ? {} : { deploymentAdmin }),
		// The stub is its members', account hosts on or off: with them on, people outside get in for hosts of their own,
		// and a key one of them made then must stay off the stub once they are off.
		...(deploymentOrganisation === undefined
			? {}
			: { sharedHosts: membersOf(options.identity, deploymentOrganisation, now) }),
		mode: "hosted",
		// Sandboxes' addresses and ports are under the ports domain (kantel.run), never the console's own name: the console
		// names them from this, not from the page it is served on.
		sandboxDomain: portsDomain,
		now,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		// Join commands name the address hosts dial, as tunnel URLs do, not the caller's origin.
		...(own === undefined ? {} : { accountHosts: true, publicUrl: own.publicUrl }),
		...(baseImages === undefined ? {} : { baseImages }),
		...(options.invites === undefined ? {} : { invites: options.invites }),
		...(options.templates === true ? { templates: true } : {}),
		...(options.snapshotExpiry === true ? { snapshotExpiry: true } : {}),
		...(options.secretsKey === undefined ? {} : { secretsKey: options.secretsKey }),
	});
	// The operator's advice goes to the log, never to a user: they are told only that the deployment doesn't support it.
	if (options.secretsKey === undefined && store.persistent === true) {
		console.warn(secretsKeyMissing("Set it as a Worker secret: wrangler secret put KANTEL_SECRETS_KEY"));
	}
	if (own !== undefined) await grantPorts(store, await own.microvms());
	own?.service.useJoinTokens(joinTokenSpender(store));
	// Hosts fetch their sandboxes' protected values over their link, for their egress proxies to swap in, and report what
	// those proxies did: as the self-hosted gateway's hosts do. Without a secrets key no environment holds a protected
	// value, so a host asking is answered that there are none.
	own?.service.useCompute({
		secrets: (hostId, sandboxId) => api.service.protectedTable(hostId, sandboxId),
		recordEgress: (hostId, records) => api.service.recordEgress(hostId, records),
		// Relayed streams (SSH, the desktop and browser, hosted ports) are uses of their sandbox, for its idle stop.
		activity: (sandboxId) => api.service.noteActivity(sandboxId),
		// Whether a running microVM's guest agent answers, so one that doesn't refuses its calls rather than hanging them.
		reportHealth: (hostId, sandboxId, health, reason, healthAt) =>
			api.service.reportHealth(hostId, sandboxId, health, reason, healthAt),
		// A microVM its host ended (its memory guard, an OOM kill, a crash) is in error, not left running.
		reportExit: (...report) => api.service.reportExit(...report),
		recordUsage: (hostId, usage) => {
			timers.touchUsage();
			return api.service.recordUsage(hostId, usage);
		},
		// Snapshot sizes always; the images and bases only with image patching on.
		...hostSnapshotLinks(api.service, baseImages),
	});
	own?.bind(
		(grantee, sandboxId) => api.service.stillAllowed(grantee, sandboxId),
		(sandboxId) => api.service.portNotRunning(sandboxId),
	);
	const timers = whileBusy(api, now);
	// The dispatcher runs only while compute requests come (`whileBusy`), so the sweep sends what it queued itself: a
	// stop's `sandbox.stopped`, on the tick after, and any delivery whose retry has come due.
	const sweep = () => {
		void api.service.sweep().catch(() => undefined);
		void api.dispatcher.drain().catch(() => undefined);
	};
	const sweeper = own === undefined ? undefined : setInterval(sweep, options.hostSweepMs ?? HOST_SWEEP_MS);
	const afterConnect = new Set<ReturnType<typeof setTimeout>>();
	const hosts: StackHosts | undefined =
		own === undefined
			? undefined
			: {
					...own.hosts,
					async connect(credential, socket) {
						const held = await own.hosts.connect(credential, socket);
						if (held !== undefined) {
							const timer = setTimeout(() => {
								afterConnect.delete(timer);
								sweep();
							}, SWEEP_AFTER_CONNECT_MS);
							afterConnect.add(timer);
						}
						return held;
					},
				};
	const records = options.sql === undefined ? "memory" : "the stack object's SQLite";
	return {
		api,
		binding: `${records}, stub backend${own === undefined ? "" : " and account hosts"} (experimental)`,
		...(hosts === undefined ? {} : { hosts }),
		isPortName: (hostname) => isPortName(hostname, portsDomain),
		servePort: createPortServing(own?.hosts.ports, options.portLimits),
		async fetch(request) {
			const answer = await api.fetch(request);
			if (answer !== undefined) timers.touch();
			return answer;
		},
		async close() {
			timers.stop();
			if (sweeper !== undefined) clearInterval(sweeper);
			for (const timer of afterConnect) clearTimeout(timer);
			own?.access.stop();
			own?.service.close();
			await api.close();
		},
	};
}

/**
 * Account hosts' host side: the registry (in `sql`, else memory), the backend over it, and what hosts and tunnel
 * clients reach: every tunnel the backend issues tickets for (SSH, desktops, a browser's CDP), with the self-hosted
 * gateway's ticket and access checks, and exposed ports on `portsDomain`'s names, pages (`servePort`) and WebSockets.
 */
async function accountHostsSide(
	config: {
		readonly publicUrl: string;
		readonly portsDomain: string;
		readonly relayLimits?: RelayLimits;
		readonly releasesUrl?: string;
		readonly releaseToken?: string;
		readonly fetch?: typeof fetch;
	},
	sql: SqlDriver | undefined,
	now: () => number,
): Promise<{
	service: HostsService;
	backend: SandboxBackend;
	publicUrl: string;
	hosts: StackHosts;
	access: ReturnType<typeof createRelayAccess>;
	bind(
		stillAllowed: (grantee: string | undefined, sandboxId: string) => Promise<boolean>,
		notRunning?: (sandboxId: string) => Promise<string | undefined>,
	): void;
	/** The sandboxes placed on a host of the registry as microVMs, now. */
	microvms(): Promise<string[]>;
}> {
	if (sql !== undefined) {
		await migrateHosts(sql);
		await migrateRelay(sql);
	}
	const hostStore = sql === undefined ? createMemoryHostStore() : createSqlHostStore(sql);
	// Hosts aren't moved on their own here: the latest release only flags those behind it, for their people to update.
	const releases =
		config.releasesUrl === undefined
			? undefined
			: createHostReleases({
					url: config.releasesUrl,
					...(config.fetch === undefined ? {} : { fetch: config.fetch }),
					log: (message) => console.warn(message),
					// Every request is this one object's, so what it keeps in memory is already every reader's. Checks are recorded
					// in its SQLite as well, so the gap between them holds across the object being evicted or redeployed.
					...(sql === undefined ? {} : { store: createSqlHostReleasesStore(sql) }),
				});
	const service = createHostsService({
		store: hostStore,
		publicUrl: config.publicUrl,
		...(releases === undefined ? {} : { releases }),
	});
	const relay = sql === undefined ? createMemoryRelayStore() : createSqlRelayStore(sql);
	const tickets = sweptAsUsed(createTunnelTickets(relay, now), now);
	let check: ((grantee: string | undefined, sandboxId: string) => Promise<boolean>) | undefined;
	let stopped: ((sandboxId: string) => Promise<string | undefined>) | undefined;
	// Its timer runs only while a session is held, so it never keeps the object awake on its own.
	const access = createRelayAccess({
		stillAllowed: (grantee, sandboxId) => check?.(grantee, sandboxId) ?? Promise.resolve(false),
		now,
	});
	// Exposures are kept in the relay store beside the tickets, so a port's URL outlasts the object being evicted.
	const ports = createPortRouter({
		domain: config.portsDomain,
		scheme: "https",
		openPort: (sandboxId, port, sink) => service.sandboxes.openPort(sandboxId, port, sink),
		store: relay,
		// Whoever exposed a port must still be able to open its sandbox, asked as a tunnel's holder is.
		stillAllowed: (grantee, sandboxId) => access.allowed(grantee, sandboxId),
		// A stopped sandbox's port says so, and how it is resumed.
		notRunning: (sandboxId) => stopped?.(sandboxId) ?? Promise.resolve(undefined),
		now,
	});
	const backend = createHostBackend({ hosts: service, publicUrl: config.publicUrl, tickets, ports, now });
	// A desktop's page and Selkies' files (`openDesktop`'s URL), for a live desktop ticket whose holder still has access.
	const desktops = createDesktopRoutes({
		tickets,
		allowed: (grant) => access.allowed(grant.grantee, grant.sandboxId),
		openPort: (sandboxId, port, sink) => service.sandboxes.openPort(sandboxId, port, sink),
		now,
	});
	const refused = (code: number, reason: string): SocketRefusal => ({ refused: { code, reason } });
	const relayLimits = config.relayLimits ?? {};
	/** What every relay holds together of messages from sandboxes still arriving (`openPortWebSocket`'s budget). */
	const relayBudget = { limit: relayLimits.budgetBytes ?? RELAY_BUDGET, held: 0 };
	/** Holds a session in the relay's access while it is open; the answer lets go of it. */
	const held = (
		session: { sandboxId: string; kind: string; grantee?: string | undefined },
		end: (reason: string) => void,
	) => {
		const release = access.track({
			sandboxId: session.sandboxId,
			kind: session.kind,
			...(session.grantee === undefined ? {} : { grantee: session.grantee }),
			end,
		});
		access.start();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			release();
			if (access.size === 0) access.stop();
		};
	};
	// Registration only: the compute API serves hosts' management, so the registry's own admin
	// routes refuse everyone.
	const register = createHostsApi({
		hosts: service,
		authorizeAdmin: () => Promise.reject(new KantelError("not_found", "Not found")),
		...(config.releaseToken === undefined ? {} : { releaseToken: config.releaseToken }),
	});
	return {
		service,
		backend,
		access,
		publicUrl: config.publicUrl,
		bind(stillAllowed, notRunning) {
			check = stillAllowed;
			stopped = notRunning;
		},
		async microvms() {
			const placed = await Promise.all((await hostStore.listHosts()).map((host) => hostStore.placementsOn(host.id)));
			return placed.flat().flatMap((placement) => (placement.tier === "microvm" ? [placement.sandboxId] : []));
		},
		hosts: {
			service,
			ports,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === HOSTS_REGISTER_PATH) {
					// Any other method has no body to bound: the handler answers it 405.
					if (request.method !== "POST") return register.fetch(request);
					// Anyone can reach it (past Access), so its body is counted as it comes, before any of it is parsed.
					const bounded = await buffered(request, HOST_REGISTER_BODY_LIMIT);
					return bounded instanceof Response ? bounded : register.fetch(bounded);
				}
				// The release workflow's "a release is out", on the release token. It names no version, so its body (bounded, as
				// anyone can send one) is never read.
				if (path === HOSTS_RELEASE_CHECK_PATH) {
					if (request.method !== "POST") return register.fetch(request);
					const bounded = await buffered(request, HOST_RELEASE_CHECK_BODY_LIMIT);
					return bounded instanceof Response ? bounded : register.fetch(bounded);
				}
				if (path.startsWith(`${HOSTS_IMAGES_PATH}/`)) return hostImage(request, path);
				// A desktop's page, on its ticket: no sign-in, as the frame and a new tab open it alike.
				if (path.startsWith(`${HOSTS_DESKTOP_PATH}/`)) return desktops.fetch(request);
				return undefined;
			},
			async socketTarget(request) {
				const url = new URL(request.url);
				if (isPortName(url.hostname, config.portsDomain)) {
					// An exposed port's name (a dev server's hot reload, an app's own WebSocket): only with its token, as its
					// pages, and its cookie only from the port's own pages or the same sandbox's (by Origin).
					const origin = request.headers.get("origin");
					const cookie = request.headers.get("cookie");
					const port = await ports.upgrade(
						request.headers.get("host") ?? url.host,
						`${url.pathname}${url.search}`,
						cookie ?? undefined,
						{ origin: origin ?? undefined },
					);
					if (port === undefined) return refused(refusalCode(404), "No sandbox port is exposed here");
					if (!port.ok) return refused(refusalCode(port.status), port.reason);
					return {
						sandboxId: port.sandboxId,
						port: port.port,
						path: port.path,
						host: port.host,
						kind: `port ${port.port}`,
						...(port.grantee === undefined ? {} : { grantee: port.grantee }),
						headers: portSocketHeaders(request.headers, url),
					};
				}
				if (url.pathname.startsWith(`${HOSTS_DESKTOP_PATH}/`)) {
					const target = await desktops.socket(`${url.pathname}${url.search}`);
					// Refused too when the ticket's holder has lost access.
					if (target === undefined || target === "refused") {
						return refused(HOST_CLOSE_REVOKED, "The desktop URL is wrong or has expired");
					}
					return {
						sandboxId: target.sandboxId,
						port: target.port,
						path: target.path,
						...(target.accept === undefined ? {} : { accept: target.accept }),
						kind: target.surface,
						...(target.grant.grantee === undefined ? {} : { grantee: target.grant.grantee }),
					};
				}
				const tunnel = TUNNEL_PATH.exec(url.pathname);
				// A raw tunnel (no path) is `tunnel`'s.
				if (tunnel?.[1] === undefined || tunnel[2] === undefined) return undefined;
				const grant = await tickets.verify(tunnel[1], now());
				// A desktop's ticket opens only the desktop's route, where its mode is enforced.
				if (grant === undefined || grant.desktop !== undefined) {
					return refused(HOST_CLOSE_REVOKED, "The tunnel URL is wrong or has expired");
				}
				if (!(await access.allowed(grant.grantee, grant.sandboxId))) {
					return refused(RELAY_CLOSE_REVOKED, RELAY_REVOKED_REASON);
				}
				return {
					sandboxId: grant.sandboxId,
					port: grant.port,
					// A tunnel's path takes the request's query.
					path: `${tunnel[2]}${url.search}`,
					kind: sessionKind(grant.port, tunnel[2]),
					...(grant.grantee === undefined ? {} : { grantee: grant.grantee }),
				};
			},
			relay(target, client, protocols = []) {
				// What the client sends before the port's server has answered the handshake waits in `openPortWebSocket`;
				// the one stack object holds every relay, so that is bounded as a raw tunnel's is (`TUNNEL_PENDING_LIMIT`).
				let open = false;
				let waiting = 0;
				let waitingMessages = 0;
				let ended = false;
				const decoder = new TextDecoder();
				let inner: PortWebSocket | undefined;
				let settle: (answer: { protocol?: string } | undefined) => void = () => undefined;
				const ready = new Promise<{ protocol?: string } | undefined>((resolve) => {
					settle = resolve;
				});
				const release = held(target, (reason) => {
					// The client hears why first; closing the port's side then ends it there too.
					ended = true;
					closeQuietly(client, RELAY_CLOSE_REVOKED, reason);
					inner?.close();
				});
				const finish = () => {
					ended = true;
					clearTimeout(handshake);
					settle(undefined);
					release();
				};
				const handshake = setTimeout(() => {
					if (open || ended) return;
					finish();
					closeQuietly(client, 1011, "The sandbox's server didn't answer in time");
					inner?.close();
				}, relayLimits.handshakeMs ?? RELAY_HANDSHAKE_MS);
				inner = openPortWebSocket(
					(sink) => service.sandboxes.openPort(target.sandboxId, target.port, sink),
					target.port,
					target.path,
					{
						open: (protocol) => {
							open = true;
							clearTimeout(handshake);
							settle(protocol === undefined ? {} : { protocol });
						},
						// Never throws into the host's connection: a client that can't take a message is closed instead.
						message: (data, binary) => {
							if (ended) return;
							try {
								client.send(binary ? data : decoder.decode(data));
							} catch {
								finish();
								closeQuietly(client, 1011, "The client is gone");
								inner?.close();
							}
						},
						close: (code, reason) => {
							finish();
							closeQuietly(client, sendableCode(code), reason);
						},
					},
					target.host,
					{
						protocols,
						...(target.headers === undefined ? {} : { headers: target.headers }),
						maxMessageBytes: relayLimits.messageBytes ?? RELAY_MESSAGE_LIMIT,
						budget: relayBudget,
					},
				);
				const opened = inner;
				return {
					ready,
					send(data) {
						if (ended) return;
						const binary = typeof data !== "string";
						if (target.accept !== undefined && !target.accept(data, binary)) return;
						if (!open) {
							waiting += typeof data === "string" ? data.length * 3 : data.byteLength;
							waitingMessages += 1;
							if (waiting > TUNNEL_PENDING_LIMIT || waitingMessages > TUNNEL_PENDING_MESSAGES) {
								finish();
								closeQuietly(client, 1009, "Too much sent before the sandbox answered");
								opened.close();
								return;
							}
						}
						opened.send(data, binary);
					},
					close() {
						finish();
						opened.close();
					},
				};
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
								closeQuietly(client, 1011, "The tunnel's client is gone");
								stream?.close();
							}
						},
						// The host's reason, ended or refused with: cut to fit and never thrown (`closeQuietly`).
						end: (reason) => {
							done();
							closeQuietly(client, 1000, reason);
						},
					});
				} catch (error) {
					done();
					closeQuietly(client, 1011, error instanceof Error ? error.message : String(error));
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

/** What a relayed WebSocket's session is, for the access log, as self-hosted names it. */
function sessionKind(port: number, path: string | undefined): string {
	if (port === SSH_PORT) return "ssh";
	if (port === BROWSER_PORT) return "cdp";
	return path === undefined ? `tunnel ${port}` : `port ${port}`;
}

/**
 * An exposed port's WebSocket handshake headers for the sandbox, as its pages get them (`@kantel/hosts/ports`): the
 * application's cookies, less every name Kantel's gate cookie has had, its `Authorization`, and where it came from.
 */
export function portSocketHeaders(headers: Headers, url: URL): Record<string, string> {
	const out: Record<string, string> = { "x-forwarded-proto": "https", "x-forwarded-host": url.host };
	const gate = new Set([PORT_COOKIE, PORT_COOKIE_BASE, LEGACY_PORT_COOKIE]);
	const cookie = (headers.get("cookie") ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "" && !gate.has(part.split("=")[0]?.trim() ?? ""))
		.join("; ");
	if (cookie !== "") out.cookie = cookie;
	for (const name of ["authorization", "origin", "user-agent"]) {
		const value = headers.get(name);
		if (value !== null) out[name] = value;
	}
	const address = headers.get("cf-connecting-ip");
	if (address !== null) out["x-forwarded-for"] = address;
	return out;
}

/** A close code a client may be sent: the port's own, or 1011 for one only a runtime may use. */
const sendableCode = (code: number) => (code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011);

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

/**
 * Gives the account-host microVMs `sandboxIds` the `ports` capability. A placement's capabilities are written once,
 * when it boots, and before exposed ports were served here a microVM's were written without ports: its API record then
 * refuses `exposePort` until the machine is booted again. Called on every start with the registry's microVM placements,
 * before the API answers anything; a record that has it already, or isn't a live microVM, is left as it is, and nothing
 * else about any record changes.
 */
export async function grantPorts(store: ComputeStore, sandboxIds: readonly string[]): Promise<void> {
	for (const sandboxId of sandboxIds) {
		await store.sandboxes.update(sandboxId, (current) =>
			current.type !== "microvm" || current.state === "deleted" || current.capabilities.ports
				? undefined
				: { ...current, capabilities: { ...current.capabilities, ports: true } },
		);
	}
}

/** A registration is a token, a name, labels and facts: a few kilobytes. */
export const HOST_REGISTER_BODY_LIMIT = 64 * 1024;

/** The most of a release check's body read: it carries nothing the control plane uses. */
export const HOST_RELEASE_CHECK_BODY_LIMIT = 4 * 1024;

/** `GET /v1/hosts/images/{file}`: Kantel's published images, as a self-hosted gateway serves them by default. */
function hostImage(request: Request, path: string): Response {
	const name = path.slice(HOSTS_IMAGES_PATH.length + 1);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return new Response("Not found", { status: 404 });
	if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
	return new Response(null, { status: 302, headers: { location: `${DEFAULT_HOST_IMAGES}/${name}` } });
}

/**
 * Runs the API's timers from a request until `IDLE_MS` after the last one, then sends what telemetry is queued. A host's
 * usage tick (`touchUsage`) keeps the telemetry export's timer going too, as the metrics export is fed from the ticks.
 */
export function whileBusy(
	api: Pick<ComputeApi, "dispatcher" | "exporter">,
	now: () => number,
): { touch(): void; touchUsage(): void; stop(): void } {
	let lastRequest = Number.NEGATIVE_INFINITY;
	let lastUsage = Number.NEGATIVE_INFINITY;
	let dispatching = false;
	let check: ReturnType<typeof setTimeout> | undefined;
	const idle = (since: number) => now() - since >= IDLE_MS;
	const stop = () => {
		if (check === undefined) return;
		clearTimeout(check);
		check = undefined;
		dispatching = false;
		api.dispatcher.stop();
		api.exporter.stop();
	};
	const watch = () => {
		check = setTimeout(() => {
			if (dispatching && idle(lastRequest)) {
				dispatching = false;
				api.dispatcher.stop();
			}
			if (!idle(lastRequest) || !idle(lastUsage)) return watch();
			stop();
			api.exporter.flush().catch(() => undefined);
		}, IDLE_MS / 5);
	};
	const running = () => {
		api.exporter.start(TELEMETRY_INTERVAL_MS);
		if (check === undefined) watch();
	};
	return {
		touch() {
			lastRequest = now();
			if (!dispatching) {
				dispatching = true;
				api.dispatcher.start(WEBHOOK_INTERVAL_MS);
			}
			running();
		},
		touchUsage() {
			lastUsage = now();
			running();
		},
		stop,
	};
}

/** An account's host's snapshot reference is `{hostId}/{snapshotId}`; the stub's are `ref_…`. */
export const isHostSnapshotRef = (ref: string): boolean => ref.startsWith("host_") && ref.includes("/");

const lost = (error: unknown, prefix: string): error is KantelError =>
	isKantelError(error) && error.code === "not_found" && error.message.startsWith(prefix);
/** The stub's refusal for a sandbox it has no machine for (`stub-backend.ts`). */
const NO_MACHINE = "The stub has no machine for ";
/** The stub's refusal for a snapshot it doesn't hold. */
const NO_SNAPSHOT = "The stub has no snapshot ";

/**
 * The stub, for a stub whose memory can go while the records stay. A call for a sandbox it has no machine for gives that
 * sandbox a fresh machine (an empty disk, or its template's setup run on one, its type, size and environment from the
 * record) and is made again; a boot
 * from a snapshot it no longer holds boots from an empty disk. Anything else, and a sandbox the records don't have,
 * fails as the stub does.
 */
export function revivingStub(stub: SandboxBackend, sandboxes: Collection<StoredSandbox>): SandboxBackend {
	/**
	 * A sandbox or snapshot an account's host holds is never the stub's to revive: with account hosts off (or its host's
	 * placement gone) it's refused, so its disk and its host stay as they are for when the host is back.
	 */
	const onHost = () =>
		new KantelError("unavailable", "It is on one of an account's own hosts, which this deployment can't reach now");
	const hostBacked = async (sandboxId: string) => {
		const hostId = (await sandboxes.get(sandboxId))?.hostId;
		return hostId !== undefined && hostId !== STUB_HOST_ID;
	};
	const refuseHostSnapshot = (ref: string | undefined) => {
		if (ref !== undefined && isHostSnapshotRef(ref)) throw onHost();
	};
	/**
	 * Revivals under way, by sandbox: every call that finds the sandbox's machine gone while one runs waits for it, so a
	 * sandbox has one creation attempt at a time and no later one replaces a machine already answered. It goes once that
	 * attempt ends, made or failed, so a failed one (its template's setup, say) can be tried again.
	 */
	const reviving = new Map<string, Promise<void>>();
	const revive = (sandboxId: string, cause: KantelError): Promise<void> => {
		const under = reviving.get(sandboxId);
		if (under !== undefined) return under;
		const attempt = reviveOnce(sandboxId, cause).finally(() => {
			if (reviving.get(sandboxId) === attempt) reviving.delete(sandboxId);
		});
		reviving.set(sandboxId, attempt);
		return attempt;
	};
	const reviveOnce = async (sandboxId: string, cause: KantelError): Promise<void> => {
		const record = await sandboxes.get(sandboxId);
		if (record === undefined || record.state === "deleted") throw cause;
		if (record.hostId !== undefined && record.hostId !== STUB_HOST_ID) throw onHost();
		// Its custom image's holders are the service's to place by; here there's only the stub.
		const template =
			record.templateBoot === undefined ? undefined : (({ holders: _holders, ...boot }) => boot)(record.templateBoot);
		const made = stub.create({
			sandboxId,
			accountId: record.accountId,
			type: record.type,
			subdomain: record.subdomain,
			...(record.size === undefined ? {} : { size: record.size }),
			// What it asked for, so it revives as the shape it was made.
			...(record.shape === undefined ? {} : { shape: record.shape }),
			...(record.image === undefined ? {} : { image: record.image }),
			// One made from a template is made again from the base and setup its create resolved, booted fresh, as `bootAgain`
			// makes it: what its template is now, or whether it still is, doesn't matter.
			...(template === undefined ? {} : { template }),
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
		keepSnapshot: async (ref) => {
			refuseHostSnapshot(ref);
			return stub.keepSnapshot?.(ref);
		},
		exec: (id, request) => onMachine(id, () => stub.exec(id, request)),
		readFile: (id, path, range) => onMachine(id, () => stub.readFile(id, path, range)),
		writeFile: (id, path, content, mode) => onMachine(id, () => stub.writeFile(id, path, content, mode)),
		deleteFile: (id, path) => onMachine(id, () => stub.deleteFile(id, path)),
		listFiles: (id, path) => onMachine(id, () => stub.listFiles(id, path)),
		takeSnapshot: (id, options) => onMachine(id, () => stub.takeSnapshot(id, options)),
		exposePort: (id, port, options) => onMachine(id, () => stub.exposePort(id, port, options)),
		openSsh: (id, options) => onMachine(id, () => stub.openSsh(id, options)),
		openDesktop: (id, options) => onMachine(id, () => stub.openDesktop(id, options)),
		openBrowser: (id, options) => onMachine(id, () => stub.openBrowser(id, options)),
		usage: (id) => onMachine(id, () => stub.usage(id)),
	};
}
