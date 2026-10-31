// The self-hosted browser host (packages/browser/CONTRACT.md): Kantel's own browsers on Docker (docker.ts) or
// Kubernetes (kubernetes.ts), one container or Pod of images/browser per browser, each run by the portable coordinator (`@kantel/browser/runtime`), the same code the
// Cloudflare host runs in its `KantelBrowser` objects. A gateway's harbour provider reaches it over HTTP
// (`httpBrowserHost`); a viewer reaches it with a view link's token.
//
//   /browsers/{id}/…           the coordinator's routes, for the gateway: `Authorization: Bearer KANTEL_BROWSER_HOST_TOKEN`
//   /v1/browser/view/{browser}/… a view (live socket, status, recording), for whoever holds its token (a bearer
//                              header, or the live socket's subprotocol: never in the URL, so never in a log)
//   /health                    liveness
//
// Environment:
//   KANTEL_BROWSER_HOST_TOKEN   the gateway's bearer token (required, at least 32 characters)
//   KANTEL_BROWSER_VIEW_KEY     the key view links are signed with, the gateway's own (required)
//   KANTEL_BROWSER_SEAL_KEY     seals profiles and recordings on disk (required)
//   KANTEL_BROWSER_DATA_DIR     where they go (default ./data/browser)
//   KANTEL_BROWSER_IMAGE        the browser image (default harbour-browser:dev)
//   KANTEL_BROWSER_STACK        names this host's containers, so its janitor touches only its own (default local)
//   KANTEL_BROWSER_NETWORK, KANTEL_BROWSER_RUNTIME, KANTEL_BROWSER_MEMORY_MB, KANTEL_BROWSER_CPUS: see docker.ts
//   KANTEL_BROWSER_DRIVER       `docker` (the default) or `kubernetes`: a Pod per browser in the host's own namespace
//                                (or KANTEL_BROWSER_NAMESPACE), KANTEL_BROWSER_RUNTIME_CLASS: see kubernetes.ts
//   KANTEL_BROWSER_RECORDING_DAYS  how long recordings are kept (default 7)
//   KANTEL_BROWSER_CONSENT      `off` stops steps and looks declining cookie and consent dialogs (default on)
//   DOCKER_SOCKET                (default /var/run/docker.sock); PORT (default 8790); HOST (default 127.0.0.1)
//
// State is in memory: a restarted host forgets its browsers and removes their containers (the gateway's leases end
// with its sessions anyway). Profiles and recordings are on disk, sealed. Runs on Bun, as the self-hosted gateway does.

// First: HARBOUR_* settings from before the rename still count.
import "@kantel/contracts/legacy-env";
import { timingSafeEqual } from "node:crypto";
import {
	type BrowserCoordinator,
	type BrowserHostClient,
	createBrowserCoordinator,
	createBrowserViewSigner,
	createSealer,
	declineConsentSetting,
	handleBrowserView,
	type PipeSocket,
	pipeLive,
	VIEW_PROTOCOL,
} from "@kantel/browser/runtime";
import type { ServerWebSocket } from "bun";
import { directoryBlobStore, sweepRecordings } from "./blobs.ts";
import { type DockerBrowserMachine, type DockerOptions, dockerMachine, removeLeftovers } from "./docker.ts";
import { inClusterOptions, kubernetesMachine, removeKubernetesLeftovers } from "./kubernetes.ts";

/** Where the host's browsers run: a machine per browser, and the janitor for what an earlier run left. */
export interface BrowserMachines {
	machine(browserId: string): DockerBrowserMachine;
	cleanUp(keep: ReadonlySet<string>): Promise<number>;
}

/** Containers on a Docker daemon. */
export const dockerMachines = (options: DockerOptions): BrowserMachines => ({
	machine: (browserId) => dockerMachine(options, browserId),
	cleanUp: (keep) => removeLeftovers(options, keep),
});

const TICK_MS = 5_000;
const BROWSER_PATH = /^\/browsers\/([A-Za-z0-9-]{1,64})(\/.*)$/;

export interface BrowserHostOptions {
	readonly token: string;
	readonly viewKey: string;
	readonly sealKey: string;
	readonly dataDir: string;
	readonly machines: BrowserMachines;
	readonly recordingRetentionMs: number;
	/** Whether steps and looks decline cookie and consent dialogs (`KANTEL_BROWSER_CONSENT`). Default on. */
	readonly declineConsent?: boolean;
}

interface Running {
	readonly coordinator: BrowserCoordinator;
	readonly machine: DockerBrowserMachine;
}

/** A viewer's socket as `pipeLive` wants it: Bun's server socket with listeners, fed by the server's handlers. */
class ViewerSocket implements PipeSocket {
	readonly #listeners = new Map<string, ((event: never) => void)[]>();
	constructor(readonly socket: ServerWebSocket<ViewerData>) {}
	send(data: string | ArrayBuffer | ArrayBufferView) {
		this.socket.send(data as string | ArrayBuffer);
	}
	close(code?: number, reason?: string) {
		this.socket.close(code, reason);
	}
	addEventListener(type: string, listener: (event: never) => void) {
		const list = this.#listeners.get(type) ?? [];
		list.push(listener);
		this.#listeners.set(type, list);
	}
	emit(type: string, event: unknown) {
		for (const listener of this.#listeners.get(type) ?? []) (listener as (event: unknown) => void)(event);
	}
}

interface ViewerData {
	readonly up: WebSocket;
	readonly control: boolean;
	readonly expiresAt: number;
	viewer?: ViewerSocket;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function bearerMatches(header: string | null, token: string): boolean {
	const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
	const want = Buffer.from(token);
	return given.length === want.length && timingSafeEqual(given, want);
}

export function createBrowserHost(options: BrowserHostOptions) {
	if (options.token.length < 32) throw new Error("KANTEL_BROWSER_HOST_TOKEN must be at least 32 characters");
	const views = createBrowserViewSigner(options.viewKey);
	const sealer = createSealer(options.sealKey);
	const blobs = directoryBlobStore(options.dataDir);
	const browsers = new Map<string, Running>();

	const browserFor = (id: string, create: boolean): Running | undefined => {
		const known = browsers.get(id);
		if (known !== undefined || !create) return known;
		const machine = options.machines.machine(id);
		const state = new Map<string, unknown>();
		const coordinator = createBrowserCoordinator({
			id,
			machine,
			blobs,
			store: {
				get: async <T>(key: string) => state.get(key) as T | undefined,
				put: async <T>(key: string, value: T) => void state.set(key, value),
			},
			sealer,
			recordingRetentionMs: options.recordingRetentionMs,
			...(options.declineConsent === undefined ? {} : { declineConsent: options.declineConsent }),
		});
		const running = { coordinator, machine };
		browsers.set(id, running);
		return running;
	};

	const local: BrowserHostClient = {
		async fetch(id, path, init) {
			const running = browserFor(id, false);
			if (running === undefined) return json({ error: { code: "not_found", message: "No such browser" } }, 404);
			return running.coordinator.handle(new Request(new URL(path, "http://browser"), init));
		},
	};

	const timer = setInterval(() => {
		for (const [id, running] of browsers) {
			void running.coordinator
				.tick()
				.then(() => running.coordinator.state())
				.then((state) => {
					// An ended browser stays known while its recording might be asked for; its container is gone already.
					if (state?.status === "ended" && Date.now() - (state.endedAt ?? 0) > options.recordingRetentionMs) {
						browsers.delete(id);
					}
				})
				.catch(() => undefined);
		}
	}, TICK_MS);
	const sweeper = setInterval(
		() => void sweepRecordings(options.dataDir, options.recordingRetentionMs).catch(() => undefined),
		3_600_000,
	);

	async function fetch(request: Request, server: import("bun").Server<ViewerData>): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (url.pathname === "/health") return json({ ok: true, service: "harbour-browser-host", browsers: browsers.size });
		const match = url.pathname.match(BROWSER_PATH);
		if (match !== null) {
			if (!bearerMatches(request.headers.get("authorization"), options.token)) {
				return json({ error: { code: "unauthenticated", message: "The browser host needs its token" } }, 401);
			}
			const running = browserFor(match[1]!, match[2] === "/start");
			if (running === undefined) return json({ error: { code: "not_found", message: "No such browser" } }, 404);
			return running.coordinator.handle(new Request(new URL(`${match[2]}${url.search}`, "http://browser"), request));
		}
		const answer = await handleBrowserView(request, { views, host: local });
		if (answer.response !== undefined) return answer.response;
		const live = answer.live!;
		const running = browserFor(live.claims.browser, false);
		const headers = await running?.coordinator.agentHeaders();
		const address = running?.machine.address();
		if (running === undefined || headers === undefined || address === undefined) {
			return json({ error: { code: "expired", message: "The browser has ended" } }, 410);
		}
		// Bun's WebSocket client takes headers: the agent's token goes only to the agent.
		const up = new WebSocket(`ws://${address.host}:${address.port}${live.path}`, {
			headers,
		} as unknown as string[]);
		up.binaryType = "arraybuffer";
		const opened = await new Promise<boolean>((resolve) => {
			up.addEventListener("open", () => resolve(true), { once: true });
			up.addEventListener("error", () => resolve(false), { once: true });
			setTimeout(() => resolve(false), 10_000);
		});
		if (!opened) {
			up.close();
			return json({ error: { code: "unavailable", message: "The live view did not open" } }, 503);
		}
		const data: ViewerData = { up, control: live.claims.control, expiresAt: live.claims.expiresAt };
		// The viewer offered the token as a subprotocol; the answer picks the plain one, so the token isn't echoed.
		if (server.upgrade(request, { data, headers: { "sec-websocket-protocol": VIEW_PROTOCOL } })) return undefined;
		up.close();
		return json({ error: { code: "invalid", message: "The live view is a WebSocket" } }, 426);
	}

	const websocket: import("bun").WebSocketHandler<ViewerData> = {
		open(socket) {
			const viewer = new ViewerSocket(socket);
			socket.data.viewer = viewer;
			pipeLive(socket.data.up as unknown as PipeSocket, viewer, {
				control: socket.data.control,
				expiresAt: socket.data.expiresAt,
			});
		},
		message(socket, message) {
			const data = typeof message === "string" ? message : new Uint8Array(message).buffer;
			socket.data.viewer?.emit("message", { data });
		},
		close(socket, code, reason) {
			socket.data.viewer?.emit("close", { code, reason });
		},
	};

	return {
		fetch,
		websocket,
		/** Removes containers a previous run of this host left behind. */
		cleanUp: () => options.machines.cleanUp(new Set(browsers.keys())),
		async stop() {
			clearInterval(timer);
			clearInterval(sweeper);
			await Promise.all([...browsers.values()].map((running) => running.coordinator.end("closed")));
		},
	};
}

function required(name: string): string {
	const value = (process.env[name] ?? "").trim();
	if (value === "") throw new Error(`${name} is required`);
	return value;
}

if (import.meta.main) {
	const days = Number(process.env.KANTEL_BROWSER_RECORDING_DAYS ?? "7");
	const image = process.env.KANTEL_BROWSER_IMAGE ?? "harbour-browser:dev";
	const stack = process.env.KANTEL_BROWSER_STACK ?? "local";
	const memoryBytes = Number(process.env.KANTEL_BROWSER_MEMORY_MB ?? "2048") * 1024 * 1024;
	const nanoCpus = Math.round(Number(process.env.KANTEL_BROWSER_CPUS ?? "1") * 1e9);
	const driver = process.env.KANTEL_BROWSER_DRIVER?.trim() || "docker";
	if (driver !== "docker" && driver !== "kubernetes") throw new Error("KANTEL_BROWSER_DRIVER is docker or kubernetes");
	let machines: BrowserMachines;
	if (driver === "kubernetes") {
		const options = await inClusterOptions({
			image,
			stack,
			memoryBytes,
			nanoCpus,
			...(process.env.KANTEL_BROWSER_NAMESPACE ? { namespace: process.env.KANTEL_BROWSER_NAMESPACE } : {}),
			...(process.env.KANTEL_BROWSER_RUNTIME_CLASS ? { runtimeClass: process.env.KANTEL_BROWSER_RUNTIME_CLASS } : {}),
		});
		machines = {
			machine: (browserId) => kubernetesMachine(options, browserId),
			cleanUp: (keep) => removeKubernetesLeftovers(options, keep),
		};
	} else {
		machines = dockerMachines({
			socket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
			image,
			stack,
			...(process.env.KANTEL_BROWSER_RUNTIME ? { runtime: process.env.KANTEL_BROWSER_RUNTIME } : {}),
			...(process.env.KANTEL_BROWSER_NETWORK ? { network: process.env.KANTEL_BROWSER_NETWORK } : {}),
			memoryBytes,
			nanoCpus,
		});
	}
	const host = createBrowserHost({
		token: required("KANTEL_BROWSER_HOST_TOKEN"),
		viewKey: required("KANTEL_BROWSER_VIEW_KEY"),
		sealKey: required("KANTEL_BROWSER_SEAL_KEY"),
		dataDir: process.env.KANTEL_BROWSER_DATA_DIR ?? "./data/browser",
		recordingRetentionMs: (Number.isFinite(days) && days > 0 ? days : 7) * 24 * 3_600_000,
		declineConsent: declineConsentSetting(process.env.KANTEL_BROWSER_CONSENT),
		machines,
	});
	const removed = await host.cleanUp();
	if (removed > 0) console.log(`browser host: removed ${removed} container(s) left from before`);
	const server = Bun.serve<ViewerData>({
		hostname: process.env.HOST ?? "127.0.0.1",
		port: Number(process.env.PORT ?? "8790"),
		fetch: (request, server) => host.fetch(request, server),
		websocket: host.websocket,
	});
	console.log(`browser host on http://${server.hostname}:${server.port}`);
	const shutdown = async () => {
		await host.stop();
		server.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
