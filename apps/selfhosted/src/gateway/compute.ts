/**
 * The compute plane on the self-hosted gateway (@kantel/hosts): machines running `kantel-host` join with a token,
 * dial out to `GET /v1/hosts/connect`, and run sandboxes the gateway places on them. Experimental: on only with
 * `KANTEL_COMPUTE=experimental`; with it off there are no routes, no tables and no upgrade path.
 *
 *   KANTEL_COMPUTE               `experimental` turns it on
 *   KANTEL_COMPUTE_PUBLIC_URL    where hosts reach this gateway, for the join command; default KANTEL_PUBLIC_URL, which
 *                                one of them must be set to
 *   KANTEL_COMPUTE_POOLS         warm sandboxes per host, as JSON such as {"microvm/default": 2}; default one default-size
 *                                microVM
 *   KANTEL_COMPUTE_JOIN_COMMAND  the join command shown with a token, with {url} and {token}; default the npm package's
 *   KANTEL_HOST_VERSION, KANTEL_HOST_UPDATE_URL
 *                                the kantel-host version hosts should run and where they fetch it ({version}, {os},
 *                                {arch}); unset, hosts aren't asked to update
 *   KANTEL_COMPUTE_IMAGES        where `kantel-host install` gets the kernel and images (GET /v1/hosts/images/...): a
 *                                directory this gateway serves (with manifest.json from `kantel-host manifest <dir>`), or
 *                                an http(s) URL it redirects to. Unset, installs need --images. The images are public
 *                                (a Debian root file system, the guest agent, a kernel), so the route asks no credential.
 *
 * The host's WebSocket is checked before it is used: no credential or a wrong or revoked one is accepted and closed
 * at once with 4003, which kantel-host reads as "stop, don't retry" (as it does a 401 or 403).
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { type Duplex, Readable } from "node:stream";
import { HOST_CLOSE_REVOKED, HOST_MAX_MESSAGE_BYTES, HOSTS_CONNECT_PATH, type HostsService } from "@kantel/hosts";
import { computeEnabled, createHostsService } from "@kantel/hosts/service";
import type { HostStore } from "@kantel/hosts/store";
import { WebSocketServer } from "ws";
import type { UpgradeHandler } from "./node-http.ts";

export interface ComputeConfig {
	readonly publicUrl: string;
	readonly pools?: { readonly [pool: string]: number };
	readonly joinCommand?: string;
	readonly desiredVersion?: string;
	readonly updateUrl?: string;
	readonly images?: string;
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

/** The compute plane's settings, or undefined when it is off. */
export function computeConfig(env: NodeJS.ProcessEnv): ComputeConfig | undefined {
	if (!computeEnabled(env.KANTEL_COMPUTE)) return undefined;
	const publicUrl = (env.KANTEL_COMPUTE_PUBLIC_URL ?? env.KANTEL_PUBLIC_URL ?? "").trim();
	if (!/^https?:\/\/[^/]+\/?$/.test(publicUrl)) {
		throw new Error(
			"KANTEL_COMPUTE needs KANTEL_COMPUTE_PUBLIC_URL or KANTEL_PUBLIC_URL: where hosts reach this gateway",
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
	return {
		...(images === "" ? {} : { images }),
		publicUrl: new URL(publicUrl).origin,
		...(pools === undefined ? {} : { pools }),
		...(env.KANTEL_COMPUTE_JOIN_COMMAND?.trim() ? { joinCommand: env.KANTEL_COMPUTE_JOIN_COMMAND.trim() } : {}),
		...(version === "" || updateUrl === "" ? {} : { desiredVersion: version, updateUrl }),
	};
}

export function gatewayCompute(config: ComputeConfig, store: HostStore, log?: (message: string) => void): HostsService {
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

/** `GET /v1/admin/compute/sandboxes/{id}/ports/{port}`: a sandbox's TCP port as a WebSocket of binary frames. */
const PORT_PATH = /^\/v1\/admin\/compute\/sandboxes\/([^/]+)\/ports\/(\d{1,5})$/;

/**
 * Hosts' connections, and the operator's sandbox ports (`ssh -o ProxyCommand=…` through the gateway, the desktop's
 * VNC, Chromium's CDP), then whatever served upgrades before. `operator` checks a port's request.
 */
export function withHostUpgrades(
	compute: HostsService | undefined,
	operator: ((request: Request) => Promise<boolean>) | undefined,
	next: UpgradeHandler | undefined,
): UpgradeHandler | undefined {
	if (compute === undefined) return next;
	const sockets = new WebSocketServer({ noServer: true, maxPayload: HOST_MAX_MESSAGE_BYTES });
	return (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
		const path = new URL(incoming.url ?? "/", "http://gateway").pathname;
		// A refusal is a WebSocket close, not a plain HTTP answer: Bun's node:http drops what is written to an upgrade's
		// raw socket, so a 401 there reaches the client as an empty reply, and kantel-host would retry for ever. 4003
		// tells it to stop (HOST_CLOSE_REVOKED).
		const refuse = (code: number, reason: string) =>
			sockets.handleUpgrade(incoming, socket, head, (accepted) => accepted.close(code, reason));
		const port = PORT_PATH.exec(path);
		if (port?.[1] !== undefined && port[2] !== undefined) {
			const sandboxId = decodeURIComponent(port[1]);
			const number = Number(port[2]);
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (typeof value === "string") headers.set(name, value);
			}
			void (operator?.(new Request(`http://gateway${path}`, { headers })) ?? Promise.resolve(false)).then(
				(allowed) => {
					if (!allowed) return refuse(HOST_CLOSE_REVOKED, "Only the deployment's operators reach sandboxes' ports");
					sockets.handleUpgrade(incoming, socket, head, (accepted) => {
						const pending: Uint8Array[] = [];
						let stream: { write(bytes: Uint8Array): void; close(): void } | undefined;
						let done = false;
						accepted.on("message", (data) => {
							const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
							const chunk = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
							if (stream === undefined) pending.push(chunk);
							else stream.write(chunk);
						});
						accepted.on("close", () => {
							done = true;
							stream?.close();
						});
						accepted.on("error", () => accepted.terminate());
						compute.sandboxes
							.openPort(sandboxId, number, {
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
				},
				() => refuse(1011, "The gateway could not check the request"),
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
						if (binary) {
							const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
							held.receive(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
						} else {
							held.receive(data.toString());
						}
					});
					accepted.on("close", (code, reason) => held.closed(code, reason.toString()));
					accepted.on("error", () => accepted.terminate());
				});
			},
			// The registry is down: a plain close, so the host retries.
			() => refuse(1011, "The gateway could not check the credential"),
		);
	};
}
