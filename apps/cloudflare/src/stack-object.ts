/**
 * `KantelStack`: the Durable Object that hosts the stack and its gateway. Its state is durable:
 *
 * - the identity directory and the audit store in D1 (`DB`);
 * - audit events queued in this object's own SQLite before they drain to D1 (`src/audit-outbox.ts`);
 * - what the bootstrap made, in this object's storage, so a restart finds the same organisation;
 * - the compute API's records (`src/compute.ts`), in this object's own SQLite, table `compute_api_records`.
 *
 * With Kantel Connect on (KANTEL_CONNECT=experimental), it also holds each enrolled host's WebSocket
 * (`GET /v1/hosts/connect`), accepted here and handed to the hub `src/compute.ts` keeps, so the compute API's calls reach
 * the host over the connection the host opened. The socket isn't hibernated (the hub's calls in flight live in
 * memory), so the object stays in memory while any host is connected; with Connect off no socket is ever taken.
 *
 * Its SQLite still holds what the agent plane kept there (the session runtime's directory, profiles and each session's
 * Pi storage, the session homes table); nothing reads it now, and nothing deletes it. The alarm the runtime used to arm
 * is answered and not armed again.
 */
import { DurableObject } from "cloudflare:workers";
import { withKantelEnv } from "@kantel/contracts/env";
import { d1Driver } from "@kantel/sql/sqlite";
import { objectSqlDriver } from "./audit-outbox.ts";
import {
	HOSTS_CONNECT_PATH,
	hostCredential,
	onMessages,
	preOpenBuffer,
	type StackHosts,
	tunnelTicket,
} from "./compute.ts";
import type { GatewayVars } from "./config.ts";
import { gatewayConfig } from "./config.ts";
import { createGateway, type Gateway } from "./gateway.ts";
import type { PlacementVars } from "./route.ts";
import { type BootstrapRecord, createStack, type Stack, type StackOptions, type StackStorage } from "./stack.ts";
import { startOnce } from "./start.ts";

export { STACK_NAME } from "./route.ts";

export interface Env extends GatewayVars, PlacementVars {
	readonly STACK: DurableObjectNamespace;
	readonly ASSETS: Fetcher;
	readonly DB: D1Database;
}

/** The key the bootstrap record is kept under in this object's storage. */
const BOOTSTRAP_KEY = "harbour.bootstrap";

export abstract class KantelStackBase extends DurableObject<Env> {
	// A deployment's HARBOUR_* vars and secrets from before the rename still count: every KANTEL_* left unset takes its
	// old name's value.
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, withKantelEnv(env));
	}

	/** Starts the stack once; see `startOnce` for what a failed configuration or start does. */
	readonly #ready = startOnce({
		configure: () => ({ config: gatewayConfig(this.env) }),
		start: async ({ config }) => {
			const started = performance.now();
			const stack = await createStack({ ...this.stackOptions(), config, storage: this.stackStorage() });
			console.log(
				`kantel: the stack object started in ${Math.round(performance.now() - started)} ms`,
				JSON.stringify(stack.startedIn),
			);
			return { stack, gateway: createGateway(stack) };
		},
		reset: (reason) => this.ctx.abort(reason),
		onStartError: (error) => console.error("kantel: the stack did not start; resetting the object", error),
	});

	/** How the stack is built beyond its config and storage; the dev entry point adds a mock Access issuer. */
	protected stackOptions(): Omit<StackOptions, "config" | "storage"> {
		return {};
	}

	/** The stack's storage over this object's bindings and its own SQLite. */
	protected stackStorage(): StackStorage {
		const storage = this.ctx.storage;
		const own = objectSqlDriver(storage.sql, (work) => storage.transactionSync(work));
		return {
			sql: d1Driver(this.env.DB),
			// Audit events queue in this object's SQLite and drain to D1 after the answer (src/audit-outbox.ts).
			auditOutbox: {
				driver: own,
				background: (work) => this.ctx.waitUntil(work),
			},
			bootstrap: {
				load: async () => (await storage.get<BootstrapRecord>(BOOTSTRAP_KEY)) ?? {},
				save: (record) => storage.put(BOOTSTRAP_KEY, record),
			},
			compute: own,
		};
	}

	protected ready(): Promise<{ stack: Stack; gateway: Gateway }> {
		return this.#ready();
	}

	/**
	 * An alarm an older version armed (a session's wake, a schedule) fires once more after the upgrade: there is nothing
	 * left to run, so it is answered and not armed again.
	 */
	override async alarm(): Promise<void> {}

	override async fetch(request: Request): Promise<Response> {
		let gateway: Gateway;
		let stack: Stack;
		try {
			({ gateway, stack } = await this.ready());
		} catch (error) {
			console.error("kantel: the stack did not start", error);
			return Response.json(
				{ error: { code: "unavailable", message: "Kantel is not configured correctly" } },
				{ status: 503 },
			);
		}
		const hosts = stack.compute.hosts;
		if (hosts !== undefined) {
			const path = new URL(request.url).pathname;
			if (path === HOSTS_CONNECT_PATH) return hostConnection(hosts, request);
			const ticket = tunnelTicket(path);
			if (ticket !== undefined) return rawTunnel(hosts, ticket, request);
		}
		return gateway.fetch(request);
	}
}

/**
 * A host's connection: the WebSocket is accepted first, so a refusal is a close with 4003, which kantel-host reads as
 * "stop, don't retry" (a plain 401 to an upgrade looks to it like a network fault, and it would retry for ever).
 */
async function hostConnection(hosts: StackHosts, request: Request): Promise<Response> {
	if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return Response.json({ error: { code: "invalid", message: "A host connects with a WebSocket" } }, { status: 426 });
	}
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	const held = await hosts.connect(hostCredential(request), {
		sendText: (text) => server.send(text),
		sendBinary: (bytes) => server.send(bytes),
		close: (code, reason) => server.close(code, reason),
	});
	if (held !== undefined) {
		onMessages(server, (frame) => held.receive(frame));
		server.addEventListener("close", (event) => held.closed(event.code, event.reason));
		server.addEventListener("error", () => held.closed(1011, "The host's connection failed"));
	}
	return new Response(null, { status: 101, webSocket: client });
}

/** A raw tunnel (SSH's ProxyCommand): the sandbox's port as binary frames, over the host's connection. */
async function rawTunnel(hosts: StackHosts, ticket: string, request: Request): Promise<Response> {
	if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return Response.json({ error: { code: "invalid", message: "A tunnel is a WebSocket" } }, { status: 426 });
	}
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	// What the client sends before the port is open waits here, bounded (preOpenBuffer): the one stack object holds
	// every tunnel, so a client that floods a tunnel whose host never answers is closed rather than kept in memory. It
	// is let go of however the tunnel ends.
	const pending = preOpenBuffer();
	let stream: { write(bytes: Uint8Array): void; close(): void } | undefined;
	let done = false;
	const end = () => {
		done = true;
		pending.clear();
		stream?.close();
	};
	const shut = (code: number, reason: string) => {
		done = true;
		pending.clear();
		try {
			server.close(code, reason);
		} catch {
			// Already closed.
		}
	};
	onMessages(server, (frame) => {
		if (done) return;
		const bytes = typeof frame === "string" ? new TextEncoder().encode(frame) : frame;
		if (stream !== undefined) return stream.write(bytes);
		if (!pending.hold(bytes)) {
			end();
			shut(1009, "Too much sent before the tunnel opened");
		}
	});
	server.addEventListener("close", end);
	server.addEventListener("error", end);
	void hosts
		.tunnel(ticket, {
			// The host can send before its port.open reply (SSH's banner), even after the client has gone: dropped then.
			send: (bytes) => {
				if (done) return;
				try {
					server.send(bytes);
				} catch {
					end();
				}
			},
			close: (code, reason) => shut(code, reason),
		})
		.then((opened) => {
			// Refused (the ticket, its grant): closed already, with nothing to write.
			if (opened === undefined) return pending.clear();
			stream = opened;
			if (done) return opened.close();
			for (const chunk of pending.take()) opened.write(chunk);
		})
		.catch((error: unknown) => {
			console.error("kantel: a tunnel failed", error);
			shut(1011, "The gateway could not open the tunnel");
		});
	return new Response(null, { status: 101, webSocket: client });
}
