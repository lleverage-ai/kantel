/**
 * `KantelStack`: the Durable Object that hosts the stack and its gateway. Its state is durable:
 *
 * - the identity directory and the audit store in D1 (`DB`);
 * - audit events queued in this object's own SQLite before they drain to D1 (`src/audit-outbox.ts`);
 * - what the bootstrap made, in this object's storage, so a restart finds the same organisation;
 * - the compute API's records (`src/compute.ts`), in this object's own SQLite, table `compute_api_records`;
 * - with email-code sign-in on (KANTEL_PUBLIC_URL), each UTC day's count of mail sent (`src/mail.ts`), in its storage,
 *   so the daily cap holds across restarts. Codes and sessions are in D1 with the directory.
 *
 * With account hosts on (KANTEL_ACCOUNT_HOSTS=experimental), it also holds each such host's WebSocket
 * (`GET /v1/hosts/connect`), accepted here and handed to the hub `src/compute.ts` keeps, so the compute API's calls reach
 * the host over the connection the host opened. The socket isn't hibernated (the hub's calls in flight live in
 * memory), so the object stays in memory while any host is connected; with account hosts off no socket is ever taken.
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
import type { MailCounts, SendEmailBinding } from "./mail.ts";
import type { PlacementVars } from "./route.ts";
import type { SignUpRecord } from "./sign-up.ts";
import { type BootstrapRecord, createStack, type Stack, type StackOptions, type StackStorage } from "./stack.ts";
import { startOnce } from "./start.ts";

export { STACK_NAME } from "./route.ts";

export interface Env extends GatewayVars, PlacementVars {
	readonly STACK: DurableObjectNamespace;
	readonly ASSETS: Fetcher;
	readonly DB: D1Database;
	/** The `send_email` binding sign-in codes and invites go through, limited to KANTEL_SIGN_IN_FROM. */
	readonly SIGN_IN_MAIL?: SendEmailBinding;
}

/** The key the bootstrap record is kept under in this object's storage. */
const BOOTSTRAP_KEY = "harbour.bootstrap";
/** Each UTC day's mail count is kept under this prefix and the day. */
const MAIL_COUNT_PREFIX = "kantel.mail.";
/** Each open sign-up's record is kept under this prefix and the user's ID. */
const SIGN_UP_PREFIX = "kantel.sign-up.";

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
		const binding = this.env.SIGN_IN_MAIL;
		const wakeAt = (at: number) => this.wakeAt(at);
		return binding === undefined
			? { wakeAt }
			: { wakeAt, mail: { binding, counts: this.mailCounts(), defer: (work) => this.ctx.waitUntil(work) } };
	}

	/** Arms the alarm for `at`, unless one is armed sooner already. */
	protected async wakeAt(at: number): Promise<void> {
		const armed = await this.ctx.storage.getAlarm();
		if (armed === null || at < armed) await this.ctx.storage.setAlarm(at);
	}

	/** Each day's mail count, in this object's storage. */
	protected mailCounts(): MailCounts {
		const storage = this.ctx.storage;
		return {
			get: (day) => storage.get<number>(`${MAIL_COUNT_PREFIX}${day}`),
			put: (day, count) => storage.put(`${MAIL_COUNT_PREFIX}${day}`, count),
			async prune(day) {
				const kept = await storage.list<number>({ prefix: MAIL_COUNT_PREFIX });
				const old = [...kept.keys()].filter((key) => key < `${MAIL_COUNT_PREFIX}${day}`);
				if (old.length > 0) await storage.delete(old);
			},
		};
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
			signUps: {
				load: (userId) => storage.get<SignUpRecord>(`${SIGN_UP_PREFIX}${userId}`),
				save: (userId, record) => storage.put(`${SIGN_UP_PREFIX}${userId}`, record),
				delete: async (userId) => {
					await storage.delete(`${SIGN_UP_PREFIX}${userId}`);
				},
			},
		};
	}

	protected ready(): Promise<{ stack: Stack; gateway: Gateway }> {
		return this.#ready();
	}

	/**
	 * Carries on account deletions whose pass is due, and runs the GitHub runner broker's pass, then arms the alarm for
	 * whichever is next: they go on though no request comes. (An alarm an older version armed, for a session's wake or a
	 * schedule, finds nothing due and isn't armed again.)
	 */
	override async alarm(): Promise<void> {
		const { stack } = await this.ready();
		const service = stack.compute.api.service;
		const deletion = await service.carryOnDeletions();
		const runners = await service.tickGithubRunners().catch((error: unknown) => {
			console.error("kantel: the GitHub runner pass failed", error);
			return Date.now() + 60_000;
		});
		const next = [deletion, runners].filter((at): at is number => at !== undefined);
		if (next.length > 0) await this.wakeAt(Math.min(...next));
	}

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
		const url = new URL(request.url);
		const hosts = stack.compute.hosts;
		// An exposed port's name (`src/route.ts` sends every one here): only the sandbox's page and its WebSockets answer.
		if (stack.compute.isPortName(url.hostname)) {
			if (hosts !== undefined && isWebSocket(request)) return (await relaySocket(hosts, request)) ?? notFound();
			return stack.compute.servePort(request);
		}
		if (hosts !== undefined) {
			const path = url.pathname;
			if (path === HOSTS_CONNECT_PATH) return hostConnection(hosts, request);
			const ticket = tunnelTicket(path);
			if (ticket !== undefined) return rawTunnel(hosts, ticket, request);
			// A desktop's stream, a browser's CDP: passed through to the sandbox's port.
			if (isWebSocket(request)) {
				const relayed = await relaySocket(hosts, request);
				if (relayed !== undefined) return relayed;
			}
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

const isWebSocket = (request: Request) =>
	request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";

const notFound = () => Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });

/**
 * A WebSocket passed through to a sandbox's port (`StackHosts.socketTarget`): a desktop's stream, a browser's CDP, an
 * exposed port's. Accepted first, so a refusal is a close with a code saying why (4003 for a wrong or expired ticket,
 * 4000 plus the HTTP status for a port's), as self-hosted does. Undefined for an upgrade that is none of these. The
 * client's subprotocols are offered to the sandbox's server, and the 101 waits for its answer so it carries the one it
 * chose (a Vite dev server's `vite-hmr`, say).
 */
async function relaySocket(hosts: StackHosts, request: Request): Promise<Response | undefined> {
	let target: Awaited<ReturnType<StackHosts["socketTarget"]>>;
	try {
		target = await hosts.socketTarget(request);
	} catch (error) {
		console.error("kantel: a WebSocket's target could not be checked", error);
		target = { refused: { code: 4502, reason: "The gateway could not check the URL" } };
	}
	if (target === undefined) return undefined;
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	if ("refused" in target) {
		server.close(target.refused.code, target.refused.reason);
		return new Response(null, { status: 101, webSocket: client });
	}
	const offered = (request.headers.get("sec-websocket-protocol") ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");
	const relayed = hosts.relay(
		target,
		{
			send: (data) => server.send(data),
			close: (code, reason) => server.close(code, reason),
		},
		offered,
	);
	onMessages(server, (frame) => relayed.send(frame));
	server.addEventListener("close", () => relayed.close());
	server.addEventListener("error", () => relayed.close());
	// Refused, failed or too slow: the client is already closed with why, which it hears once this 101 is taken.
	const answer = await relayed.ready;
	const protocol = answer?.protocol;
	return new Response(null, {
		status: 101,
		webSocket: client,
		...(protocol !== undefined && offered.includes(protocol)
			? { headers: { "sec-websocket-protocol": protocol } }
			: {}),
	});
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
