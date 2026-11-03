/**
 * A dev server for the compute plane: `node packages/compute/src/serve.ts [--port 58190] [--host 127.0.0.1]` serves
 * `createComputeApi` over the stub backend with node:http, and `GET /healthz`. On start it makes a super-admin,
 * `admin@localhost`, with their personal account and an API key holding every scope (`hosts:admin` too), and prints
 * `KANTEL_URL=…` and `KANTEL_API_KEY=ksk_…`; `KANTEL_COMPUTE_BOOTSTRAP_KEY` fixes the key's secret. It runs the webhook
 * dispatcher, the telemetry exporter and the auto-stop sweep on timers. For local runs and tests, not production.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { computeSchema } from "@kantel/api";
import { API_KEY_PREFIX, type AuthenticatePerson, ensurePerson, keyForSecret, newApiKeySecret } from "./auth.ts";
import type { SandboxBackend } from "./backend.ts";
import { type ComputeApi, createComputeApi } from "./http.ts";
import { type ComputeStore, createMemoryStore, type StoredApiKey } from "./store.ts";
import { createStubBackend } from "./stub-backend.ts";
import { randomId, sha256Hex } from "./util.ts";

export const DEFAULT_PORT = 58190;
export const DEFAULT_HOST = "127.0.0.1";
/** The longest request body the server reads. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export interface ComputeServerOptions {
	/** Default 58190; 0 picks a free port. */
	readonly port?: number;
	/** Default `127.0.0.1`. */
	readonly host?: string;
	/** Default the stub backend. */
	readonly backend?: SandboxBackend;
	/** Default an in-memory store. */
	readonly store?: ComputeStore;
	/** The bootstrap key's secret, `ksk_…`. Default `KANTEL_COMPUTE_BOOTSTRAP_KEY`, else a new one. */
	readonly bootstrapKey?: string;
	readonly authenticatePerson?: AuthenticatePerson;
	/** For webhook deliveries and telemetry exports. Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** Default the server's own URL. */
	readonly publicUrl?: string;
	/** How often the webhook dispatcher drains. Default 1000 ms. */
	readonly webhookIntervalMs?: number;
	/** How often telemetry is exported. Default 60 000 ms. */
	readonly telemetryIntervalMs?: number;
}

export interface ComputeServer {
	/** `http://<host>:<port>`. */
	readonly url: string;
	/** The bootstrap key's secret. */
	readonly apiKey: string;
	readonly api: ComputeApi;
	close(): Promise<void>;
}

/** The bootstrap super-admin, their personal account, and their every-scope key (made unless it exists). */
async function bootstrap(store: ComputeStore, secret: string | undefined, now: number): Promise<string> {
	const user = await ensurePerson(
		store,
		{ userId: "usr_admin", email: "admin@localhost", name: "Admin", superAdmin: true },
		now,
	);
	if (secret !== undefined) {
		if (!secret.startsWith(API_KEY_PREFIX)) throw new Error(`The bootstrap key must start with ${API_KEY_PREFIX}`);
		if ((await keyForSecret(store, secret, now)) !== undefined) return secret;
	}
	const made = secret === undefined ? await newApiKeySecret() : undefined;
	const value = secret ?? made?.secret ?? "";
	const key: StoredApiKey = {
		id: randomId("key"),
		accountId: user.personalAccountId,
		name: "bootstrap",
		prefix: value.slice(0, 8),
		scopes: [...computeSchema.API_KEY_SCOPES],
		createdBy: { kind: "user", id: user.id, name: user.name },
		createdAt: now,
		secretHash: made?.hash ?? (await sha256Hex(value)),
		ownerUserId: user.id,
	};
	await store.apiKeys.put(key);
	return value;
}

async function toRequest(incoming: IncomingMessage, origin: string): Promise<Request | undefined> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of incoming) {
		const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);
		size += bytes.byteLength;
		if (size > MAX_REQUEST_BYTES) return undefined;
		chunks.push(bytes);
	}
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const item of value) headers.append(name, item);
		else headers.set(name, value);
	}
	const method = incoming.method ?? "GET";
	let body: Uint8Array<ArrayBuffer> | undefined;
	if (method !== "GET" && method !== "HEAD" && size > 0) {
		body = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
	}
	return new Request(new URL(incoming.url ?? "/", origin), {
		method,
		headers,
		...(body === undefined ? {} : { body }),
	});
}

async function send(outgoing: ServerResponse, response: Response): Promise<void> {
	outgoing.statusCode = response.status;
	response.headers.forEach((value, name) => {
		outgoing.setHeader(name, value);
	});
	outgoing.end(new Uint8Array(await response.arrayBuffer()));
}

const jsonResponse = (body: unknown, status: number) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Starts the dev server; resolves once it listens. */
export async function startComputeServer(options: ComputeServerOptions = {}): Promise<ComputeServer> {
	const host = options.host ?? DEFAULT_HOST;
	const store = options.store ?? createMemoryStore();
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? DEFAULT_PORT, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
	const api = createComputeApi({
		store,
		backend: options.backend ?? createStubBackend(),
		publicUrl: options.publicUrl ?? url,
		...(options.authenticatePerson === undefined ? {} : { authenticatePerson: options.authenticatePerson }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
	const apiKey = await bootstrap(store, options.bootstrapKey ?? process.env.KANTEL_COMPUTE_BOOTSTRAP_KEY, Date.now());

	server.on("request", (incoming: IncomingMessage, outgoing: ServerResponse) => {
		void (async () => {
			try {
				const request = await toRequest(incoming, url);
				if (request === undefined) {
					await send(outgoing, jsonResponse({ error: { code: "invalid", message: "The body is too large" } }, 413));
					return;
				}
				if (new URL(request.url).pathname === "/healthz") {
					await send(outgoing, jsonResponse({ ok: true }, 200));
					return;
				}
				const response = await api.fetch(request);
				await send(outgoing, response ?? jsonResponse({ error: { code: "not_found", message: "No such route" } }, 404));
			} catch {
				if (!outgoing.headersSent) {
					await send(outgoing, jsonResponse({ error: { code: "unavailable", message: "The server failed" } }, 500));
				} else outgoing.destroy();
			}
		})();
	});

	api.dispatcher.start(options.webhookIntervalMs ?? 1000);
	api.exporter.start(options.telemetryIntervalMs ?? 60_000);
	const sweeper = setInterval(() => {
		api.service.sweep().catch(() => undefined);
	}, 5000);
	(sweeper as { unref?: () => void }).unref?.();

	return {
		url,
		apiKey,
		api,
		async close() {
			clearInterval(sweeper);
			await api.close();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		},
	};
}

function argument(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index < 0 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const port = argument(argv, "--port");
	const server = await startComputeServer({
		port: port === undefined ? DEFAULT_PORT : Number(port),
		host: argument(argv, "--host") ?? DEFAULT_HOST,
	});
	process.stdout.write(`KANTEL_URL=${server.url}\nKANTEL_API_KEY=${server.apiKey}\n`);
	const stop = () => {
		server.close().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
