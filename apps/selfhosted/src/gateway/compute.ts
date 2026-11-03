/**
 * The compute plane on the self-hosted gateway. Experimental: on only with `KANTEL_COMPUTE=experimental`; with it off
 * there is nothing here, none of its routes answer and there is no upgrade path.
 *
 * `@kantel/compute` serves the API (accounts, sandboxes, snapshots, scoped `ksk_` keys, webhooks, OpenTelemetry export
 * and hosts under `/v1`) over a `SandboxBackend`:
 *
 *   - `stub` (the default): a just-bash shell over files in memory, to try the API with no machine of your own.
 *   - `hosts`: machines running `kantel-host` (`@kantel/hosts`, apps/host). A host joins with a token the API mints
 *     (`POST /v1/admin/hosts/join-tokens`), registers at `POST /v1/hosts/register`, dials out to `GET /v1/hosts/connect`
 *     and runs the sandboxes the scheduler places on it: Firecracker microVMs and workerd isolates. The registry of
 *     hosts and placements is in Postgres with a database, in memory otherwise.
 *
 * The API's records are in memory either way, so they are gone after a restart. The super-admin's key is the
 * exception: the gateway keeps its secret in the bootstrap file and makes it again on each start.
 *
 *   KANTEL_COMPUTE               `experimental` turns it on
 *   KANTEL_COMPUTE_BACKEND       `hosts` runs sandboxes on joined hosts; default `stub`
 *   KANTEL_COMPUTE_PUBLIC_URL    with `hosts`: where hosts and clients reach this gateway (join commands, desktop,
 *                                browser and SSH tunnels); default KANTEL_PUBLIC_URL, one of which must be set
 *   KANTEL_COMPUTE_POOLS         warm sandboxes per host, as JSON such as {"microvm/default": 2}; default one
 *                                default-size microVM
 *   KANTEL_COMPUTE_JOIN_COMMAND  the join command shown with a token, with {url} and {token}; default the npm package's
 *   KANTEL_HOST_VERSION, KANTEL_HOST_UPDATE_URL
 *                                the kantel-host version hosts should run and where they fetch it ({version}, {os},
 *                                {arch}); unset, hosts aren't asked to update
 *   KANTEL_COMPUTE_IMAGES        where `kantel-host install` gets the kernel and images (GET /v1/hosts/images/...): a
 *                                directory this gateway serves (with manifest.json from `kantel-host manifest <dir>`), or
 *                                an http(s) URL it redirects to. The images are public (a Debian root file system, the
 *                                guest agent, a kernel), so the route asks no credential.
 *
 * A host's WebSocket is checked before it is used: no credential or a wrong or revoked one is accepted and closed at
 * once with 4003, which kantel-host reads as "stop, don't retry". (Bun's node:http drops a plain 401 written to an
 * upgrade's socket, so the host would see an empty reply and retry for ever.)
 *
 * A person signed in to the console (or with an OIDC or Access token) is a compute person under their user ID, and a
 * super-admin when they are an admin of the deployment's organisation.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { type Duplex, Readable } from "node:stream";
import {
	type ComputeApi,
	type ComputeStore,
	createComputeApi,
	createMemoryStore,
	joinTokenSpender,
	type PersonIdentity,
	type SandboxBackend,
} from "@kantel/compute";
import { bootstrapSuperAdmin } from "@kantel/compute/serve";
import { createStubBackend } from "@kantel/compute/stub";
import { type Authenticator, KantelError } from "@kantel/contracts";
import { createHostBackend } from "@kantel/hosts/backend";
import { createHostsApi, HOSTS_CONNECT_PATH, HOSTS_REGISTER_PATH } from "@kantel/hosts/http";
import { openPortWebSocket } from "@kantel/hosts/port-websocket";
import { HOST_CLOSE_REVOKED, HOST_MAX_MESSAGE_BYTES } from "@kantel/hosts/protocol";
import { createHostsService, type HostsService } from "@kantel/hosts/service";
import type { HostStore } from "@kantel/hosts/store";
import { HOSTS_TUNNEL_PATH, verifyTunnel } from "@kantel/hosts/tunnel";
import { WebSocketServer } from "ws";
import type { UpgradeHandler } from "./node-http.ts";

/** How often webhook deliveries that are due are sent. */
const WEBHOOK_INTERVAL_MS = 1000;
/** How often telemetry is exported. */
const TELEMETRY_INTERVAL_MS = 60_000;

/** Whether the compute plane is on: `KANTEL_COMPUTE=experimental`. */
export function computeEnabled(env: NodeJS.ProcessEnv): boolean {
	return env.KANTEL_COMPUTE?.trim().toLowerCase() === "experimental";
}

/** The `hosts` backend's settings. */
export interface ComputeHostsConfig {
	readonly publicUrl: string;
	readonly pools?: { readonly [pool: string]: number };
	readonly joinCommand?: string;
	readonly desiredVersion?: string;
	readonly updateUrl?: string;
	readonly images?: string;
}

/** The compute plane's settings: `hosts` is set when sandboxes run on joined hosts, not the stub. */
export interface ComputeConfig {
	readonly hosts?: ComputeHostsConfig;
}

/** The compute plane's settings, or undefined when it is off. */
export function computeConfig(env: NodeJS.ProcessEnv): ComputeConfig | undefined {
	if (!computeEnabled(env)) return undefined;
	const backend = env.KANTEL_COMPUTE_BACKEND?.trim().toLowerCase() || "stub";
	if (backend === "stub") return {};
	if (backend !== "hosts") throw new Error("KANTEL_COMPUTE_BACKEND is `stub` or `hosts`");
	const publicUrl = (env.KANTEL_COMPUTE_PUBLIC_URL ?? env.KANTEL_PUBLIC_URL ?? "").trim();
	if (!/^https?:\/\/[^/]+\/?$/.test(publicUrl)) {
		throw new Error(
			"KANTEL_COMPUTE_BACKEND=hosts needs KANTEL_COMPUTE_PUBLIC_URL or KANTEL_PUBLIC_URL: where hosts reach this gateway",
		);
	}
	let pools: { [pool: string]: number } | undefined;
	const rawPools = env.KANTEL_COMPUTE_POOLS?.trim() ?? "";
	if (rawPools !== "") {
		const parsed: unknown = JSON.parse(rawPools);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Object.entries(parsed).some(
				([key, value]) => !/^(microvm|isolate)\/[a-z0-9-]+$/.test(key) || !Number.isInteger(value) || value < 0,
			)
		) {
			throw new Error('KANTEL_COMPUTE_POOLS is JSON such as {"microvm/default": 2}');
		}
		pools = parsed as { [pool: string]: number };
	}
	const version = env.KANTEL_HOST_VERSION?.trim() ?? "";
	const updateUrl = env.KANTEL_HOST_UPDATE_URL?.trim() ?? "";
	const images = env.KANTEL_COMPUTE_IMAGES?.trim() ?? "";
	const joinCommand = env.KANTEL_COMPUTE_JOIN_COMMAND?.trim() ?? "";
	return {
		hosts: {
			publicUrl: new URL(publicUrl).origin,
			...(images === "" ? {} : { images }),
			...(pools === undefined ? {} : { pools }),
			...(joinCommand === "" ? {} : { joinCommand }),
			...(version === "" || updateUrl === "" ? {} : { desiredVersion: version, updateUrl }),
		},
	};
}

/** The registry of hosts (`@kantel/hosts`) the `hosts` backend places sandboxes on. */
export function gatewayHosts(
	config: ComputeHostsConfig,
	store: HostStore,
	log?: (message: string) => void,
): HostsService {
	return createHostsService({
		store,
		publicUrl: config.publicUrl,
		...(config.pools === undefined ? {} : { pools: config.pools }),
		...(config.joinCommand === undefined ? {} : { joinCommand: config.joinCommand }),
		...(config.desiredVersion === undefined ? {} : { desiredVersion: config.desiredVersion }),
		...(config.updateUrl === undefined ? {} : { updateUrl: config.updateUrl }),
		...(log === undefined ? {} : { log }),
	});
}

/** `GET /v1/hosts/images/{file}`: the host images `kantel-host install` fetches. */
export const HOST_IMAGES_PATH = "/v1/hosts/images";

/**
 * Serves the host images from a directory, or redirects to where they are; undefined for any other path. A file name
 * is one path segment of letters, digits, dots, dashes and underscores, so nothing outside the directory is reachable.
 */
export function hostImages(source: string): (request: Request) => Promise<Response | undefined> {
	const remote = /^https?:\/\//.test(source);
	return async (request) => {
		const path = new URL(request.url).pathname;
		if (!path.startsWith(`${HOST_IMAGES_PATH}/`)) return undefined;
		const name = path.slice(HOST_IMAGES_PATH.length + 1);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return new Response("Not found", { status: 404 });
		if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
		if (remote) {
			return new Response(null, { status: 302, headers: { location: `${source.replace(/\/+$/, "")}/${name}` } });
		}
		const file = join(source, name);
		const info = await stat(file).catch(() => undefined);
		if (info === undefined || !info.isFile()) return new Response("Not found", { status: 404 });
		const headers = {
			"content-type": name.endsWith(".json") ? "application/json" : "application/octet-stream",
			"content-length": String(info.size),
			"cache-control": name === "manifest.json" ? "no-cache" : "public, max-age=300",
		};
		if (request.method === "HEAD") return new Response(null, { headers });
		return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, { headers });
	};
}

/** What the `hosts` backend needs from the gateway: the registry, and the secret tunnel tickets are signed with. */
export interface GatewayHostsBackend {
	readonly service: HostsService;
	readonly config: ComputeHostsConfig;
	/** 32 random bytes; a new one each start, so tunnel URLs end with the process. */
	readonly tunnelSecret: Uint8Array;
}

export interface GatewayCompute {
	readonly api: ComputeApi;
	/** The super-admin key's secret, for the bootstrap file. */
	readonly superAdminKey: string;
	/** `/v1/deployment`'s line about it. */
	readonly binding: string;
	/**
	 * The routes a host calls with no sign-in (`POST /v1/hosts/register`, its join token the authority) and the host
	 * images; undefined for any other path. Absent on the stub.
	 */
	readonly hostRoutes?: (request: Request) => Promise<Response | undefined>;
	close(): Promise<void>;
}

/** The person a gateway sign-in is, or undefined for a key or no sign-in (a `ksk_` key is the compute API's own). */
async function personOf(authenticator: Authenticator, request: Request): Promise<PersonIdentity | undefined> {
	try {
		const caller = await authenticator.authenticate(request);
		if (caller.actor.kind !== "human") return undefined;
		return { userId: caller.actor.userId, name: caller.actor.userId, superAdmin: caller.role === "admin" };
	} catch {
		return undefined;
	}
}

/** The compute API over the stub, or over joined hosts with `hosts`, signed in with the gateway's `authenticator`. */
export async function gatewayCompute(options: {
	readonly authenticator: Authenticator;
	/** The super-admin key's secret from an earlier start, if any. */
	readonly superAdminKey?: string;
	readonly publicUrl?: string;
	readonly now?: () => number;
	readonly hosts?: GatewayHostsBackend;
}): Promise<GatewayCompute> {
	const store: ComputeStore = createMemoryStore();
	const hosts = options.hosts;
	const backend: SandboxBackend =
		hosts === undefined
			? createStubBackend()
			: createHostBackend({
					hosts: hosts.service,
					publicUrl: hosts.config.publicUrl,
					tunnelSecret: hosts.tunnelSecret,
					...(options.now === undefined ? {} : { now: options.now }),
				});
	// The API mints and keeps join tokens; the registry spends them when a host registers.
	hosts?.service.useJoinTokens(joinTokenSpender(store));
	const publicUrl = hosts?.config.publicUrl ?? options.publicUrl;
	const api = createComputeApi({
		store,
		backend,
		authenticatePerson: (request) => personOf(options.authenticator, request),
		...(publicUrl === undefined ? {} : { publicUrl }),
		...(hosts?.config.joinCommand === undefined ? {} : { hostJoinCommand: hosts.config.joinCommand }),
		...(options.now === undefined ? {} : { now: options.now }),
	});
	const superAdminKey = await bootstrapSuperAdmin(api.store, options.superAdminKey, (options.now ?? Date.now)());
	api.dispatcher.start(WEBHOOK_INTERVAL_MS);
	api.exporter.start(TELEMETRY_INTERVAL_MS);
	let hostRoutes: GatewayCompute["hostRoutes"];
	if (hosts !== undefined) {
		// Registration only: the API serves the operator's routes, so the registry's own admin routes refuse everyone.
		const register = createHostsApi({
			hosts: hosts.service,
			authorizeAdmin: () => Promise.reject(new KantelError("not_found", "Not found")),
		});
		const images = hosts.config.images === undefined ? undefined : hostImages(hosts.config.images);
		hostRoutes = async (request) => {
			const path = new URL(request.url).pathname;
			if (path === HOSTS_REGISTER_PATH) return register.fetch(request);
			if (path.startsWith(`${HOST_IMAGES_PATH}/`)) {
				return (await images?.(request)) ?? new Response("Not found", { status: 404 });
			}
			return undefined;
		};
	}
	return {
		api,
		superAdminKey,
		binding: hosts === undefined ? "memory, stub backend (experimental)" : "memory, kantel-host hosts (experimental)",
		...(hostRoutes === undefined ? {} : { hostRoutes }),
		async close() {
			await api.close();
		},
	};
}

/** `GET /v1/hosts/tunnel/{ticket}[/{path}]`: a sandbox's port, as the ticket grants. */
const TUNNEL_PATH = new RegExp(`^${HOSTS_TUNNEL_PATH}/([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)(/.*)?$`);

function bytesOf(data: unknown): Uint8Array {
	const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
	return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Hosts' connections and sandboxes' tunnels, then whatever served upgrades before.
 *
 * A tunnel is `/v1/hosts/tunnel/{ticket}`, a WebSocket of binary frames carrying the port's raw TCP (VNC for noVNC,
 * SSH through a ProxyCommand), or `/v1/hosts/tunnel/{ticket}/{path}`, an HTTP upgrade passed through to the port with
 * that path (Chrome's DevTools WebSocket, for Playwright's `connectOverCDP`).
 */
export function withHostUpgrades(
	hosts: GatewayHostsBackend | undefined,
	next: UpgradeHandler | undefined,
	now: () => number = Date.now,
): UpgradeHandler | undefined {
	if (hosts === undefined) return next;
	const compute = hosts.service;
	const sockets = new WebSocketServer({ noServer: true, maxPayload: HOST_MAX_MESSAGE_BYTES });
	return (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
		const path = new URL(incoming.url ?? "/", "http://gateway").pathname;
		const refuse = (code: number, reason: string) =>
			sockets.handleUpgrade(incoming, socket, head, (accepted) => accepted.close(code, reason));
		const tunnel = TUNNEL_PATH.exec(path);
		if (tunnel?.[1] !== undefined) {
			const ticket = tunnel[1];
			const rest = tunnel[2];
			void verifyTunnel(hosts.tunnelSecret, ticket, now()).then(
				(grant) => {
					if (grant === undefined) return refuse(HOST_CLOSE_REVOKED, "The tunnel URL is wrong or has expired");
					if (rest === undefined) return rawTunnel(grant.sandboxId, grant.port);
					return passThrough(grant.sandboxId, grant.port, rest);
				},
				() => refuse(1011, "The gateway could not check the tunnel URL"),
			);
			return;
		}
		if (path !== HOSTS_CONNECT_PATH) {
			if (next !== undefined) return next(incoming, socket, head);
			socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		const credential = /^Bearer\s+(\S+)$/i.exec(incoming.headers.authorization ?? "")?.[1];
		if (incoming.method !== "GET" || credential === undefined) return refuse(HOST_CLOSE_REVOKED, "No host credential");
		void compute.authenticate(credential).then(
			(host) => {
				if (host === undefined) return refuse(HOST_CLOSE_REVOKED, "The host credential is unknown or revoked");
				sockets.handleUpgrade(incoming, socket, head, (accepted) => {
					const held = compute.hub.accept(host.id, {
						sendText: (text) => accepted.send(text),
						sendBinary: (bytes) => accepted.send(bytes, { binary: true }),
						close: (code, reason) => accepted.close(code, reason),
					});
					accepted.on("message", (data, binary) => {
						if (binary) held.receive(bytesOf(data));
						else held.receive(data.toString());
					});
					accepted.on("close", (code, reason) => held.closed(code, reason.toString()));
					accepted.on("error", () => accepted.terminate());
				});
			},
			// The registry is down: a plain close, so the host retries.
			() => refuse(1011, "The gateway could not check the credential"),
		);

		/** The port's bytes as binary WebSocket frames. */
		function rawTunnel(sandboxId: string, port: number) {
			sockets.handleUpgrade(incoming, socket, head, (accepted) => {
				const pending: Uint8Array[] = [];
				let stream: { write(bytes: Uint8Array): void; close(): void } | undefined;
				let done = false;
				accepted.on("message", (data) => {
					const chunk = bytesOf(data);
					if (stream === undefined) pending.push(chunk);
					else stream.write(chunk);
				});
				accepted.on("close", () => {
					done = true;
					stream?.close();
				});
				accepted.on("error", () => accepted.terminate());
				compute.sandboxes
					.openPort(sandboxId, port, {
						data: (bytes) => accepted.send(bytes, { binary: true }),
						end: (reason) => accepted.close(1000, reason.slice(0, 120)),
					})
					.then(
						(opened) => {
							stream = opened;
							if (done) return opened.close();
							for (const chunk of pending.splice(0)) opened.write(chunk);
						},
						(error: unknown) =>
							accepted.close(1011, (error instanceof Error ? error.message : String(error)).slice(0, 120)),
					);
			});
		}

		/**
		 * The client's WebSocket, passed message by message to a WebSocket at `path` on the port, which the gateway opens
		 * as a client on 127.0.0.1 (Chrome refuses DevTools to any other Host). Not raw bytes: Bun drops what is written
		 * to an upgrade's socket, so the client's side has to be `ws`'s.
		 */
		function passThrough(sandboxId: string, port: number, rest: string) {
			const query = new URL(incoming.url ?? "/", "http://gateway").search;
			sockets.handleUpgrade(incoming, socket, head, (accepted) => {
				const inner = openPortWebSocket(
					(sink) => compute.sandboxes.openPort(sandboxId, port, sink),
					port,
					`${rest}${query}`,
					{
						message: (data, binary) => accepted.send(data, { binary }),
						close: (code, reason) =>
							accepted.close(
								code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011,
								reason.slice(0, 120),
							),
					},
				);
				accepted.on("message", (data, binary) => inner.send(binary ? bytesOf(data) : data.toString(), binary));
				accepted.on("close", () => inner.close());
				accepted.on("error", () => accepted.terminate());
			});
		}
	};
}
