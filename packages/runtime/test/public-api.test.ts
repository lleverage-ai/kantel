// Contract tests for the public API's session routes (`@kantel/api`), called through the generated SDK against the
// session API over the in-memory runtime, as a host app would call a deployed Kantel.

import { createKantelClient, KantelApiError, type ServerFrame, type WebSocketLike } from "@kantel/api/sdk";
import type { AgentProfile, Authentication } from "@kantel/contracts";
import { applyFrames, type SessionSnapshot } from "@kantel/protocol";
import {
	type AcceptWebSocket,
	createSessionApi,
	type ServerWebSocket,
	staticTokenAuthenticator,
} from "@kantel/runtime/http";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-public";
const PROJECT = "proj-public";
const host: Authentication = { actor: { kind: "service", serviceId: "lleverage", keyId: "k1" }, organisationId: ORG };

const profile: AgentProfile = {
	id: "assistant",
	organisationId: ORG,
	name: "Assistant",
	model: { route: "default" },
	promptLayers: [],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

/** A server socket that hands what it is sent to its client (holding it until one joins), which can hang up. */
class FakeSocket implements ServerWebSocket {
	closed: number | undefined;
	readonly #held: string[] = [];
	#client: ((data: string) => void) | undefined;
	readonly #listeners = new Set<() => void>();
	join(client: (data: string) => void) {
		this.#client = client;
		for (const data of this.#held.splice(0)) client(data);
	}
	send(data: string) {
		if (this.closed !== undefined) throw new Error("closed");
		if (this.#client === undefined) this.#held.push(data);
		else this.#client(data);
	}
	close(code?: number) {
		this.closed = code ?? 1000;
	}
	addEventListener(_type: "close" | "error", listener: () => void) {
		this.#listeners.add(listener);
	}
	hangUp() {
		this.closed = 1000;
		for (const listener of this.#listeners) listener();
	}
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp() {
	const { models, script } = createScriptedModel();
	const sockets: FakeSocket[] = [];
	const accept: AcceptWebSocket = () => {
		const socket = new FakeSocket();
		sockets.push(socket);
		// A 101 can't be built outside a platform that upgrades; the API passes back whatever response it is given.
		return { socket, response: new Response(null, { status: 204, headers: { "x-upgraded": "yes" } }) };
	};
	const memory = createMemoryRuntime({ models });
	const api = createSessionApi({
		runtime: memory.runtime,
		directory: memory.directory,
		profiles: memory.profiles,
		hostTools: memory.hostTools,
		history: memory.history,
		authenticator: staticTokenAuthenticator({ host }),
		acceptWebSocket: accept,
	});
	cleanups.push(async () => {
		await api.close();
		await memory.close();
	});
	const fetchApi = (input: string | URL | Request, init?: RequestInit) => api.fetch(new Request(input, init));
	/** The SDK's WebSocket, joined to the API in process: the upgrade goes through `api.fetch`, as on a platform. */
	const webSocket = (url: string, headers: { readonly [name: string]: string }): WebSocketLike => {
		let server: FakeSocket | undefined;
		const client: WebSocketLike = {
			onopen: null,
			onmessage: null,
			onclose: null,
			onerror: null,
			close() {
				server?.hangUp();
				client.onclose?.({ code: 1000, reason: "" });
			},
		};
		void (async () => {
			const before = sockets.length;
			const response = await fetchApi(url.replace(/^ws/, "http"), {
				headers: { ...headers, upgrade: "websocket", connection: "Upgrade" },
			});
			server = sockets[before];
			if (response.headers.get("x-upgraded") !== "yes" || server === undefined) {
				client.onclose?.({ code: 1006, reason: `${response.status} ${await response.text()}` });
				return;
			}
			client.onopen?.({});
			server.join((data) => client.onmessage?.({ data }));
		})();
		return client;
	};
	const client = createKantelClient({
		baseUrl: "https://kantel.test/v1",
		token: "host",
		fetch: fetchApi,
		webSocket,
	});
	await memory.profiles.put({ actor: host.actor, organisationId: ORG }, profile);
	return { client, fetchApi, memory, script, sockets };
}

const asHost = { actor: host.actor, organisationId: ORG };

async function failure(promise: Promise<unknown>): Promise<KantelApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("expected the call to fail");
}

describe("public API: sessions", () => {
	it("creates a session and reads it back", async () => {
		const { client } = await setUp();
		const created = await client.createSession({
			projectId: PROJECT,
			agentId: "assistant",
			title: "Invoice run",
			labels: { lleverageRef: "run-42" },
		});
		expect(created).toMatchObject({
			organisationId: ORG,
			projectId: PROJECT,
			agentId: "assistant",
			title: "Invoice run",
			labels: { lleverageRef: "run-42" },
			createdBy: host.actor,
		});
		expect(await client.getSession(created.id)).toEqual(created);
	});

	it("ignores fields the create body doesn't name, so a caller can't pick another organisation", async () => {
		const { client } = await setUp();
		const created = await client.createSession({
			projectId: PROJECT,
			agentId: "assistant",
			organisationId: "org-elsewhere",
		} as never);
		expect(created.organisationId).toBe(ORG);
	});

	it("lists sessions by project, status and label, a page at a time", async () => {
		const { client } = await setUp();
		const one = await client.createSession({ projectId: PROJECT, agentId: "assistant", labels: { ref: "a" } });
		const two = await client.createSession({ projectId: PROJECT, agentId: "assistant", labels: { ref: "b" } });
		await client.createSession({ projectId: "proj-other", agentId: "assistant" });
		const inProject = await client.listSessions({ projectId: PROJECT });
		expect(inProject.items.map((session) => session.id).sort()).toEqual([one.id, two.id].sort());
		expect((await client.listSessions({ label: { ref: "b" } })).items.map((session) => session.id)).toEqual([two.id]);
		expect((await client.listSessions({ label: { ref: "c" } })).items).toEqual([]);
		expect((await client.listSessions({ projectId: PROJECT, status: "running" })).items).toEqual([]);
		const first = await client.listSessions({ projectId: PROJECT, limit: 1 });
		expect(first.items).toHaveLength(1);
		expect(first.nextCursor).toBeDefined();
		const second = await client.listSessions({ projectId: PROJECT, limit: 1, cursor: first.nextCursor as string });
		expect(second.items).toHaveLength(1);
		expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
	});

	it("aborts a session's run, with or without a reason, and leaves it open", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		await expect(client.abortSession(session.id)).resolves.toBeUndefined();
		await expect(client.abortSession(session.id, { reason: "The user stopped it" })).resolves.toBeUndefined();
		expect((await client.getSession(session.id)).id).toBe(session.id);
	});

	it("closes a session, and closing it again does nothing", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		await expect(client.closeSession(session.id)).resolves.toBeUndefined();
		await expect(client.closeSession(session.id)).resolves.toBeUndefined();
	});

	it("answers errors with the KantelError's code and status", async () => {
		const { client } = await setUp();
		const missing = await failure(client.getSession("ses-missing"));
		expect([missing.status, missing.code]).toEqual([404, "not_found"]);
		const invalid = await failure(client.createSession({ projectId: PROJECT } as never));
		expect([invalid.status, invalid.code]).toEqual([400, "invalid"]);
		expect(invalid.message).toContain("agentId");
	});

	it("refuses a missing credential, a bad query and a malformed body over the wire", async () => {
		const { fetchApi } = await setUp();
		const anonymous = createKantelClient({ baseUrl: "https://kantel.test/v1", fetch: fetchApi });
		const refused = await failure(anonymous.listSessions());
		expect([refused.status, refused.code]).toEqual([401, "unauthenticated"]);
		const call = (path: string, init: RequestInit = {}) =>
			fetchApi(`https://kantel.test/v1${path}`, { ...init, headers: { authorization: "Bearer host" } });
		for (const query of ["status=bogus", "limit=0", "limit=many"]) {
			const response = await call(`/sessions?${query}`);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: "invalid" } });
		}
		const notJson = await call("/sessions", { method: "POST", body: "{" });
		expect(await notJson.json()).toEqual({ error: { code: "invalid", message: "The body is not JSON" } });
		const badReason = await call("/sessions/ses-1/abort", { method: "POST", body: JSON.stringify({ reason: 7 }) });
		expect(badReason.status).toBe(400);
	});
});

describe("public API: messages", () => {
	it("sends a prompt, and the session answers it", async () => {
		const { client, memory, script } = await setUp();
		script.reply({ text: "Hello back" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const submission = await client.sendMessage(session.id, { text: "Hello" });
		expect(submission).toMatchObject({ sessionId: session.id, via: "prompt" });
		expect(await memory.runtime.wait(asHost, session.id, submission.id)).toMatchObject({ answer: "Hello back" });
	});

	it("sends a steer or a follow-up by `via`", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		expect((await client.sendMessage(session.id, { via: "steer", text: "Faster" })).via).toBe("steer");
		expect((await client.sendMessage(session.id, { via: "followUp", text: "Then this" })).via).toBe("followUp");
	});

	it("answers a replay with the same Idempotency-Key with the first submission, and sends nothing again", async () => {
		const { client, memory, script } = await setUp();
		script.reply({ text: "Once" }, { text: "Twice" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const first = await client.sendMessage(session.id, { text: "Go" }, { idempotencyKey: "msg-1" });
		expect(first.requestId).toBe("msg-1");
		const again = await client.sendMessage(session.id, { text: "Go" }, { idempotencyKey: "msg-1" });
		expect(again).toEqual(first);
		expect(await memory.runtime.wait(asHost, session.id, first.id)).toMatchObject({ answer: "Once" });
		const later = await client.sendMessage(session.id, { text: "Go" }, { idempotencyKey: "msg-1" });
		expect(later).toEqual(first);
		expect(script.requests).toHaveLength(1);
		const snapshot = await memory.runtime.snapshot(asHost, session.id);
		expect(snapshot.items.filter((item) => item.kind === "user")).toHaveLength(1);
	});

	it("refuses a key reused for another kind of message, and sends nothing", async () => {
		const { client, memory } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const first = await client.sendMessage(session.id, { text: "Go" }, { idempotencyKey: "msg-2" });
		await memory.runtime.wait(asHost, session.id, first.id);
		const reused = await failure(
			client.sendMessage(session.id, { via: "steer", text: "Go" }, { idempotencyKey: "msg-2" }),
		);
		expect([reused.status, reused.code]).toEqual([409, "conflict"]);
		const snapshot = await memory.runtime.snapshot(asHost, session.id);
		expect(snapshot.items.filter((item) => item.kind === "user")).toHaveLength(1);
	});

	it("refuses an empty message, an unknown via and a malformed key", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		expect((await failure(client.sendMessage(session.id, { text: "" }))).code).toBe("invalid");
		expect((await failure(client.sendMessage(session.id, { via: "shout", text: "Hi" } as never))).code).toBe("invalid");
		for (const key of ["has space", "x".repeat(256)]) {
			const refused = await failure(client.sendMessage(session.id, { text: "Hi" }, { idempotencyKey: key }));
			expect([refused.status, refused.code]).toEqual([400, "invalid"]);
		}
	});

	it("refuses a message to a closed or unknown session", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		await client.closeSession(session.id);
		expect((await failure(client.sendMessage(session.id, { text: "Hi" }))).code).toBe("conflict");
		expect((await failure(client.sendMessage("ses-missing", { text: "Hi" }))).code).toBe("not_found");
	});

	it("sends a new session its first message", async () => {
		const { client, memory, script } = await setUp();
		script.reply({ text: "Started" });
		const created = await client.createSession({
			projectId: PROJECT,
			agentId: "assistant",
			message: { text: "Begin" },
		});
		expect(created.submission).toMatchObject({ sessionId: created.id, via: "prompt" });
		expect(await memory.runtime.wait(asHost, created.id, created.submission?.id as string)).toMatchObject({
			answer: "Started",
		});
	});

	it("closes a new session whose first message is refused, and answers the refusal", async () => {
		const { client } = await setUp();
		const refused = await failure(
			client.createSession({ projectId: PROJECT, agentId: "assistant", message: { text: "Hi", model: "no-such" } }),
		);
		expect(refused.code).toBe("invalid");
		const [session] = (await client.listSessions({ projectId: PROJECT })).items;
		expect(session).toBeDefined();
		expect((await failure(client.sendMessage(session?.id as string, { text: "Again" }))).code).toBe("conflict");
	});
});

/** Opens the session's stream through the SDK and folds what it sends with the protocol's reducer. */
function watch(client: ReturnType<typeof createKantelClient>, sessionId: string, after?: string) {
	const frames: ServerFrame[] = [];
	let state: SessionSnapshot | undefined;
	const closed: { code: number; reason: string }[] = [];
	const handle = client.streamSession(
		sessionId,
		{
			onFrames(batch) {
				frames.push(...batch);
				// A resumed stream's deltas fold onto the snapshot the client already holds; this one holds none.
				if (after === undefined) state = applyFrames(batch, state);
			},
			onClose: (event) => closed.push(event),
		},
		after === undefined ? {} : { after },
	);
	return {
		handle,
		frames,
		closed,
		get state() {
			return state;
		},
	};
}

const until = async (check: () => boolean) => {
	for (let tries = 0; tries < 200 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
};

describe("public API: stream", () => {
	it("streams hello, a snapshot, then the run's deltas as @kantel/protocol frames", async () => {
		const { client, script } = await setUp();
		script.reply({ text: "Streamed answer" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const stream = watch(client, session.id);
		await until(() => stream.state !== undefined);
		expect(stream.frames.map((frame) => frame.type).slice(0, 2)).toEqual(["hello", "snapshot"]);
		await client.sendMessage(session.id, { text: "Go" });
		await until(() => stream.state?.items.some((item) => item.kind === "assistant" && !item.streaming) ?? false);
		expect(stream.state?.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
		expect(stream.state?.items.at(-1)).toMatchObject({ text: "Streamed answer" });
		expect(stream.handle.cursor).toBeDefined();
		stream.handle.close();
	});

	it("resumes after a cursor with only the deltas since", async () => {
		const { client, memory, script } = await setUp();
		script.reply({ text: "One" }, { text: "Two" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const first = await client.sendMessage(session.id, { text: "First" });
		await memory.runtime.wait(asHost, session.id, first.id);
		const { cursor } = await memory.runtime.snapshot(asHost, session.id);
		const second = await client.sendMessage(session.id, { text: "Second" });
		await memory.runtime.wait(asHost, session.id, second.id);
		const stream = watch(client, session.id, cursor);
		await until(() => stream.frames.some((frame) => frame.type === "delta"));
		expect(stream.frames[0]).toMatchObject({ type: "hello", resumed: true });
		expect(stream.frames.some((frame) => frame.type === "snapshot")).toBe(false);
		stream.handle.close();
	});

	it("serves server-sent events without an upgrade", async () => {
		const { client, fetchApi } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const abort = new AbortController();
		const response = await fetchApi(`https://kantel.test/v1/sessions/${session.id}/stream`, {
			headers: { authorization: "Bearer host" },
			signal: abort.signal,
		});
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		let text = "";
		while (!text.includes("event: ready")) text += new TextDecoder().decode((await reader.read()).value);
		expect(text).toContain("event: hello");
		expect(text).toContain("event: snapshot");
		abort.abort();
		await reader.cancel();
	});

	it("refuses an unknown session as JSON before any socket opens", async () => {
		const { client, sockets } = await setUp();
		const stream = watch(client, "ses-missing");
		await until(() => stream.closed.length === 1);
		expect(stream.closed[0]?.reason).toMatch(/^404 /);
		expect(sockets).toHaveLength(0);
	});
});

describe("public API: history", () => {
	it("pages back through a session, newest first", async () => {
		const { client, memory, script } = await setUp();
		script.reply({ text: "A" }, { text: "B" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		for (const text of ["one", "two"]) {
			const sent = await client.sendMessage(session.id, { text });
			await memory.runtime.wait(asHost, session.id, sent.id);
		}
		const all = await client.getSessionHistory(session.id);
		expect(all.items.map((item) => item.kind)).toEqual(["assistant", "user", "assistant", "user"]);
		const page = await client.getSessionHistory(session.id, { limit: 2 });
		expect(page.items).toHaveLength(2);
		const older = await client.getSessionHistory(session.id, { cursor: page.nextCursor as string });
		expect(older.items.map((item) => item.kind)).toEqual(["assistant", "user"]);
		expect(older.nextCursor).toBeUndefined();
		expect((await failure(client.getSessionHistory(session.id, { limit: 0 }))).code).toBe("invalid");
	});
});
