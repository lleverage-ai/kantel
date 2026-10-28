// The console reading a session over a WebSocket: the real session API (`@harbour/runtime/http`) over the in-memory
// runtime, with a socket that carries the API's server socket to the client in process. The socket stands in for the
// browser's, the bearer it adds for Access's cookie.
import type { AgentProfile, Authentication, CallContext } from "@harbour/contracts";
import {
	type AcceptWebSocket,
	createSessionApi,
	type ServerWebSocket,
	staticTokenAuthenticator,
} from "@harbour/runtime/http";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SessionClient } from "../state/session-client.ts";
import { createApiClient, type TransportKind } from "./http.ts";
import { framesOf, type OpenSocket, type SocketLike, socketUrl, watchOverSocket } from "./socket.ts";

const ORG = "org-socket";
const tom: Authentication = { actor: { kind: "service", serviceId: "tom" }, organisationId: ORG };
const ctx: CallContext = { actor: tom.actor, organisationId: ORG };
const ORIGIN = "https://harbour.test/";

const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function eventually(check: () => boolean, what: string, ms = 3000) {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** The client's end of an in-process socket; the server's end is what the API's `acceptWebSocket` returned. */
class ClientSocket implements SocketLike {
	extensions = "";
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closedByClient = false;
	server: ServerSide | undefined;
	close() {
		this.closedByClient = true;
		this.server?.hangUp();
	}
}

class ServerSide implements ServerWebSocket {
	readonly #listeners = new Set<() => void>();
	#open = true;
	constructor(readonly client: ClientSocket) {}
	send(data: string) {
		if (!this.#open) throw new Error("closed");
		queueMicrotask(() => this.client.onmessage?.({ data }));
	}
	close() {
		if (!this.#open) return;
		this.#open = false;
		queueMicrotask(() => this.client.onclose?.());
	}
	addEventListener(_type: "close" | "error", listener: () => void) {
		this.#listeners.add(listener);
	}
	hangUp() {
		this.#open = false;
		for (const listener of this.#listeners) listener();
	}
	/** The network drops: neither end says goodbye. */
	drop() {
		this.#open = false;
	}
}

async function setUp(options: { sockets?: boolean; headers?: Record<string, string> } = {}) {
	const { models, script } = createScriptedModel();
	const memory = createMemoryRuntime({ models });
	const servers: ServerSide[] = [];
	let pendingClient: ClientSocket | undefined;
	const accept: AcceptWebSocket = () => {
		if (pendingClient === undefined) throw new Error("no client is upgrading");
		const server = new ServerSide(pendingClient);
		pendingClient.server = server;
		servers.push(server);
		return { socket: server, response: new Response(null, { status: 204, headers: { "x-upgraded": "yes" } }) };
	};
	const api = createSessionApi({
		...memory,
		authenticator: staticTokenAuthenticator({ tom }),
		keepAliveMs: 60_000,
		...(options.sockets === false ? {} : { acceptWebSocket: accept }),
	});
	cleanups.push(async () => {
		await api.close();
		await memory.close();
	});
	await memory.profiles.put(ctx, profile);
	const opened: string[] = [];
	const openSocket: OpenSocket = (url) => {
		opened.push(url);
		const client = new ClientSocket();
		const http = url.replace(/^ws/, "http");
		pendingClient = client;
		void api
			.fetch(new Request(http, { headers: { authorization: "Bearer tom", upgrade: "websocket" } }))
			.then(async (response) => {
				pendingClient = undefined;
				if (response.headers.get("x-upgraded") === "yes") {
					client.extensions = "permessage-deflate";
					client.onopen?.();
				} else {
					await response.body?.cancel();
					client.onerror?.();
					client.onclose?.();
				}
			});
		return client;
	};
	const transports: TransportKind[] = [];
	const client = createApiClient({
		baseUrl: `${ORIGIN}v1`,
		origin: ORIGIN,
		openSocket,
		...(options.headers === undefined ? {} : { headers: () => options.headers ?? {} }),
		// The event stream, when the console falls back to it, carries the same bearer.
		fetch: (input, init) => {
			const request = new Request(input, init);
			const headers = new Headers(request.headers);
			headers.set("authorization", "Bearer tom");
			return api.fetch(new Request(request, { headers }));
		},
		onTransport: (_id, how) => transports.push(how),
	});
	const open = (sessionId: string) => {
		const session = new SessionClient(client.transport(sessionId), sessionId);
		session.start();
		cleanups.push(() => session.stop());
		return session;
	};
	const create = async () => (await memory.runtime.create(ctx, { projectId: "proj-a", agentId: "worker" })).id;
	return { client, script, open, create, opened, servers, transports };
}

const answers = (session: SessionClient) =>
	session
		.getState()
		.items.filter((item) => item.kind === "assistant")
		.map((item) => (item.kind === "assistant" ? item.text : ""));

describe("a session over a WebSocket", () => {
	it("streams the snapshot and the run's answer over the socket, compressed", async () => {
		const { client, script, open, create, opened, transports } = await setUp();
		const id = await create();
		const session = open(id);
		await eventually(() => session.getState().connection.status === "open", "the socket");
		expect(opened[0]).toBe(`wss://harbour.test/v1/sessions/${id}/events`);
		script.reply({ text: "Hi there" });
		await client.prompt(id, "Hello?");
		await eventually(() => answers(session).includes("Hi there"), "the answer");
		expect(transports).toEqual([{ kind: "websocket", extensions: "permessage-deflate" }]);
	});

	it("resumes after the last cursor it applied when the socket is closed under it", async () => {
		const { client, script, open, create, opened, servers } = await setUp();
		const id = await create();
		const session = open(id);
		await eventually(() => session.getState().connection.status === "open", "the socket");
		servers[0]?.close();
		await eventually(() => opened.length === 2 && session.getState().connection.status === "open", "the reconnect");
		expect(opened[1]).toMatch(/\/events\?after=/);
		expect(session.getState().resumes.at(-1)?.how).toBe("deltas");
		script.reply({ text: "Still here" });
		await client.prompt(id, "Are you there?");
		await eventually(() => answers(session).includes("Still here"), "the answer after the reconnect");
	});

	it("reads the event stream instead, from then on, when the gateway won't upgrade", async () => {
		const { open, create, opened, transports } = await setUp({ sockets: false });
		const id = await create();
		const session = open(id);
		await eventually(() => session.getState().connection.status === "open", "the event stream");
		expect(opened).toHaveLength(1);
		expect(transports).toEqual([{ kind: "sse" }]);
		const other = open(await create());
		await eventually(() => other.getState().connection.status === "open", "the second session");
		expect(opened).toHaveLength(1);
	});

	it("doesn't try a socket while the console signs calls in with a bearer of its own", async () => {
		const { open, create, opened, transports } = await setUp({ headers: { authorization: "Bearer tom" } });
		const session = open(await create());
		await eventually(() => session.getState().connection.status === "open", "the event stream");
		expect(opened).toHaveLength(0);
		expect(transports).toEqual([{ kind: "sse" }]);
	});
});

describe("watchOverSocket", () => {
	it("tells a socket that went silent as lost, and one that never opened as failed", async () => {
		const silent = new ClientSocket();
		let lost = 0;
		watchOverSocket(() => silent, "wss://h/x", { receive() {}, failed() {}, lost: () => lost++ }, 20);
		silent.onopen?.();
		await eventually(() => lost === 1, "the silence");
		expect(silent.closedByClient).toBe(true);

		const refused = new ClientSocket();
		let failed = 0;
		watchOverSocket(() => refused, "wss://h/x", { receive() {}, failed: () => failed++, lost() {} });
		refused.onerror?.();
		refused.onclose?.();
		expect(failed).toBe(1);
	});

	it("reads a message as its frames, a keep-alive or anything else as none", () => {
		expect(framesOf("[]")).toEqual([]);
		expect(framesOf('[{"type":"error","code":"x","message":"y"}]')).toHaveLength(1);
		expect(framesOf('{"type":"error"}')).toEqual([]);
		expect(framesOf("not json")).toEqual([]);
		expect(framesOf(new ArrayBuffer(2))).toEqual([]);
	});

	it("turns an API path into a socket URL on the page's origin", () => {
		expect(socketUrl("/v1/sessions/s/events", "https://harbour.myslop.app/p/x")).toBe(
			"wss://harbour.myslop.app/v1/sessions/s/events",
		);
		expect(socketUrl("/v1/x", "http://127.0.0.1:5173/")).toBe("ws://127.0.0.1:5173/v1/x");
	});
});
