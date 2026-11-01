// `watch` over a WebSocket (`src/http/ws.ts`): the same frames as the event stream, batched per turn of the event
// loop, resumed with `?after=`, refused as JSON before any socket opens, and closed with the API.
import type { Authentication } from "@kantel/contracts";
import { PROTOCOL_VERSION, type ServerFrame } from "@kantel/protocol";
import {
	type AcceptWebSocket,
	createSessionApi,
	decodeFrames,
	frameBatcher,
	isWebSocketUpgrade,
	type ServerWebSocket,
	staticTokenAuthenticator,
	WS_KEEP_ALIVE,
} from "@kantel/runtime/http";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORG = "org-ws";
const supervisor: Authentication = { actor: { kind: "service", serviceId: "atlas-supervisor" }, organisationId: ORG };

/** A server socket that records what it is sent, and can be closed by its client. */
class FakeSocket implements ServerWebSocket {
	readonly sent: string[] = [];
	closed: number | undefined;
	readonly #listeners = new Set<() => void>();
	send(data: string) {
		if (this.closed !== undefined) throw new Error("closed");
		this.sent.push(data);
	}
	close(code?: number) {
		this.closed = code ?? 1000;
	}
	addEventListener(_type: "close" | "error", listener: () => void) {
		this.#listeners.add(listener);
	}
	/** The client hangs up. */
	hangUp() {
		this.closed = 1000;
		for (const listener of this.#listeners) listener();
	}
	frames(): ServerFrame[] {
		return this.sent.flatMap((data) => decodeFrames(data));
	}
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setUp(keepAliveMs = 60_000) {
	const { models, script } = createScriptedModel();
	const memory = createMemoryRuntime({ models });
	const sockets: FakeSocket[] = [];
	const accept: AcceptWebSocket = () => {
		const socket = new FakeSocket();
		sockets.push(socket);
		// A 101 can't be built outside a platform that upgrades; the API passes whatever response it is given back.
		return { socket, response: new Response(null, { status: 204, headers: { "x-upgraded": "yes" } }) };
	};
	const api = createSessionApi({
		runtime: memory.runtime,
		directory: memory.directory,
		profiles: memory.profiles,
		hostTools: memory.hostTools,
		authenticator: staticTokenAuthenticator({ supervisor }),
		keepAliveMs,
		acceptWebSocket: accept,
	});
	cleanups.push(async () => {
		await api.close();
		await memory.close();
	});
	const request = (method: string, path: string, options: { body?: unknown; upgrade?: boolean } = {}) =>
		api.fetch(
			new Request(`https://harbour.test/v1${path}`, {
				method,
				headers: {
					authorization: "Bearer supervisor",
					...(options.upgrade === true ? { upgrade: "websocket", connection: "Upgrade" } : {}),
					...(options.body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
			}),
		);
	return { api, script, request, sockets };
}

async function createSession(request: ReturnType<typeof setUp>["request"]): Promise<string> {
	await request("PUT", "/profiles/worker", {
		body: {
			id: "worker",
			organisationId: ORG,
			name: "Worker",
			model: { route: "default" },
			promptLayers: [],
			tools: [],
			skills: [],
			sandbox: { tiers: ["isolate"] },
			memoryScopes: [],
		},
	});
	const created = await request("POST", "/sessions", { body: { projectId: "proj-ws", agentId: "worker" } });
	expect(created.status).toBe(201);
	return ((await created.json()) as { id: string }).id;
}

const until = async (check: () => boolean) => {
	for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
};

describe("watching over a WebSocket", () => {
	it("answers an upgrade with the socket's response and sends hello and the snapshot in one message", async () => {
		const { request, sockets } = setUp();
		const sessionId = await createSession(request);
		const response = await request("GET", `/sessions/${sessionId}/events`, { upgrade: true });
		expect(response.headers.get("x-upgraded")).toBe("yes");
		const [socket] = sockets;
		if (socket === undefined) throw new Error("no socket");
		await until(() => socket.sent.length > 0);
		expect(socket.sent).toHaveLength(1);
		expect(socket.frames().map((frame) => frame.type)).toEqual(["hello", "snapshot"]);
	});

	it("streams a run's deltas live, then resumes after a cursor with only what was missed", async () => {
		const { request, script, sockets } = setUp();
		const sessionId = await createSession(request);
		await request("GET", `/sessions/${sessionId}/events`, { upgrade: true });
		const first = sockets[0];
		if (first === undefined) throw new Error("no socket");
		await until(() => first.frames().length >= 2);
		const snapshot = first.frames()[1] as Extract<ServerFrame, { type: "snapshot" }>;

		script.reply({ text: "Hello there" });
		const prompted = await request("POST", `/sessions/${sessionId}/prompt`, { body: { text: "Hi" } });
		expect(prompted.status).toBe(202);
		await until(() =>
			first
				.frames()
				.some(
					(frame) =>
						frame.type === "delta" &&
						frame.delta.ops.some(
							(op) => "item" in op && op.item.kind === "assistant" && op.item.text === "Hello there",
						),
				),
		);
		const live = first.frames().filter((frame) => frame.type === "delta");
		expect(live.length).toBeGreaterThan(0);

		first.hangUp();
		await request("GET", `/sessions/${sessionId}/events?after=${encodeURIComponent(snapshot.snapshot.cursor)}`, {
			upgrade: true,
		});
		const second = sockets[1];
		if (second === undefined) throw new Error("no second socket");
		await until(() => second.frames().length >= 1 + live.length);
		const resumed = second.frames();
		expect(resumed[0]).toMatchObject({ type: "hello", resumed: true });
		expect(resumed.slice(1).every((frame) => frame.type === "delta")).toBe(true);
	});

	it("refuses a session the caller cannot see as JSON, and opens no socket", async () => {
		const { request, sockets } = setUp();
		const response = await request("GET", "/sessions/no-such-session/events", { upgrade: true });
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(sockets).toHaveLength(0);
	});

	it("serves the event stream to a request that doesn't ask to upgrade", async () => {
		const { request, sockets } = setUp();
		const sessionId = await createSession(request);
		const response = await request("GET", `/sessions/${sessionId}/events`);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		await response.body?.cancel();
		expect(sockets).toHaveLength(0);
	});

	it("keeps an idle socket open with an empty message, and closes it when the API closes", async () => {
		const { api, request, sockets } = setUp(20);
		const sessionId = await createSession(request);
		await request("GET", `/sessions/${sessionId}/events`, { upgrade: true });
		const socket = sockets[0];
		if (socket === undefined) throw new Error("no socket");
		await until(() => socket.sent.includes(WS_KEEP_ALIVE));
		await api.close();
		expect(socket.closed).toBe(1001);
	});
});

describe("the frame batcher", () => {
	it("sends frames pushed in one turn as one message, and the next turn's in another", async () => {
		const sent: string[] = [];
		const batch = frameBatcher((data) => sent.push(data));
		const hello: ServerFrame = { type: "hello", v: PROTOCOL_VERSION, sessionId: "s", cursor: "c1", resumed: false };
		batch.push(hello);
		batch.push(hello);
		expect(sent).toHaveLength(0);
		await Promise.resolve();
		expect(sent).toHaveLength(1);
		expect(decodeFrames(sent[0] ?? "")).toHaveLength(2);
		batch.push(hello);
		batch.flush();
		expect(sent).toHaveLength(2);
		await Promise.resolve();
		expect(sent).toHaveLength(2);
	});

	it("knows an upgrade when it sees one", () => {
		expect(isWebSocketUpgrade(new Request("https://h/x", { headers: { upgrade: "WebSocket" } }))).toBe(true);
		expect(isWebSocketUpgrade(new Request("https://h/x"))).toBe(false);
	});
});
