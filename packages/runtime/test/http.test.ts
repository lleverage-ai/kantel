// The HTTP layer's own rules, beyond the conformance suite: authentication, error mapping, the event stream's wire
// format and resume, result polling, callback registration and signatures.
import {
	type AgentProfile,
	type Authentication,
	authenticationError,
	HarbourError,
	type HostToolCall,
	type SessionRuntime,
} from "@harbour/contracts";
import type { ServerFrame } from "@harbour/protocol";
import {
	bearer,
	callbackHostToolHandler,
	createHostToolEndpoint,
	createSessionApi,
	createSessionApiClient,
	HEADERS,
	readSse,
	signHostToolCall,
	staticTokenAuthenticator,
	verifyHostToolSignature,
} from "@harbour/runtime/http";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-http";
const PROJECT = "proj-http";
const supervisor: Authentication = { actor: { kind: "service", serviceId: "sal-supervisor" }, organisationId: ORG };
const other: Authentication = { actor: { kind: "service", serviceId: "someone-else" }, organisationId: ORG };
const system: Authentication = { actor: { kind: "system", component: "sneaky" }, organisationId: ORG };
/** Two API keys of one service. */
const keyOne: Authentication = { actor: { kind: "service", serviceId: "sal", keyId: "k1" }, organisationId: ORG };
const keyTwo: Authentication = { actor: { kind: "service", serviceId: "sal", keyId: "k2" }, organisationId: ORG };
const TOOLS = [{ name: "review", description: "Waits", inputSchema: { type: "object" }, replay: "unsafe" as const }];

const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools: ["review"],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
	hostId: "sal",
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setUp(outbound?: typeof fetch) {
	const { models, script } = createScriptedModel();
	const memory = createMemoryRuntime({ models });
	const api = createSessionApi({
		runtime: memory.runtime,
		branching: memory.branching,
		organising: memory.organising,
		directory: memory.directory,
		profiles: memory.profiles,
		hostTools: memory.hostTools,
		authenticator: staticTokenAuthenticator({ supervisor, other, system, keyOne, keyTwo }),
		keepAliveMs: 60_000,
		...(outbound === undefined ? {} : { fetch: outbound }),
	});
	cleanups.push(async () => {
		await api.close();
		await memory.close();
	});
	const request = (method: string, path: string, options: { token?: string; body?: unknown; headers?: object } = {}) =>
		api.fetch(
			new Request(`https://harbour.test/v1${path}`, {
				method,
				headers: {
					...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
					...(options.body === undefined ? {} : { "content-type": "application/json" }),
					...options.headers,
				},
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
			}),
		);
	return { api, memory, script, request };
}

async function createSession(request: ReturnType<typeof setUp>["request"]): Promise<string> {
	expect((await request("PUT", "/profiles/worker", { token: "supervisor", body: profile })).status).toBe(200);
	const created = await request("POST", "/sessions", {
		token: "supervisor",
		body: { projectId: PROJECT, agentId: "worker" },
	});
	expect(created.status).toBe(201);
	return ((await created.json()) as { id: string }).id;
}

/** Reads events until `count` have arrived, then stops reading. */
async function firstEvents(response: Response, count: number) {
	const events: { event: string; data: string; id?: string }[] = [];
	if (response.body === null) throw new Error("no body");
	await readSse(response.body, (event) => {
		events.push(event);
		return events.length < count;
	});
	return events;
}

describe("session API over HTTP", () => {
	it("answers 401 without a credential, with an unknown one, and for a system actor", async () => {
		const { request } = setUp();
		for (const token of [undefined, "nobody", "system"]) {
			const response = await request("GET", "/sessions", token === undefined ? {} : { token });
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toContain("Bearer");
			expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
		}
	});

	it("stores a profile's image model, and refuses a malformed one", async () => {
		const { request } = setUp();
		const withImages = { ...profile, imageModel: { route: "images", modelId: "gpt-image-1" } };
		const stored = await request("PUT", "/profiles/worker", { token: "supervisor", body: withImages });
		expect(stored.status).toBe(200);
		const read = await request("GET", "/profiles/worker", { token: "supervisor" });
		expect(await read.json()).toMatchObject({ imageModel: { route: "images", modelId: "gpt-image-1" } });
		for (const imageModel of ["images", { route: "" }, { route: "images", modelId: 3 }]) {
			const refused = await request("PUT", "/profiles/worker", {
				token: "supervisor",
				body: { ...profile, imageModel },
			});
			expect(refused.status).toBe(400);
			expect(await refused.json()).toMatchObject({
				error: { code: "invalid", message: expect.stringContaining("imageModel") },
			});
		}
	});

	it("maps Harbour errors to statuses with their code, and hides any other error", async () => {
		const { request } = setUp();
		const missing = await request("GET", "/sessions/no-such-session", { token: "supervisor" });
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
		expect((await request("GET", "/nowhere", { token: "supervisor" })).status).toBe(404);
		const bad = await request("POST", "/sessions", { token: "supervisor", body: [] });
		expect(bad.status).toBe(400);
		const failing = createSessionApi({
			...setUp().memory,
			authenticator: {
				authenticate: async () => {
					throw new Error("database password is hunter2");
				},
			},
		});
		const hidden = await failing.fetch(new Request("https://harbour.test/v1/sessions"));
		expect(hidden.status).toBe(500);
		expect(await hidden.text()).not.toContain("hunter2");
	});

	it("refuses a body over the limit", async () => {
		const { request } = setUp();
		const response = await request("POST", "/sessions", {
			token: "supervisor",
			body: { projectId: PROJECT, agentId: "worker", title: "x".repeat(1024 * 1024 + 1) },
		});
		expect(response.status).toBe(400);
	});

	it("answers 403 when the authenticator refuses the organisation, without saying more", async () => {
		const api = createSessionApi({
			...setUp().memory,
			authenticator: {
				authenticate: async () => {
					throw authenticationError("organisation", "Not in org-secret-name");
				},
			},
		});
		const response = await api.fetch(new Request("https://harbour.test/v1/sessions"));
		expect(response.status).toBe(403);
		expect(response.headers.get("www-authenticate")).toBeNull();
		expect(await response.text()).not.toContain("org-secret-name");
	});

	it("streams hello, a snapshot with its cursor as the event ID and ready, then resumes from Last-Event-ID", async () => {
		const { request, script } = setUp();
		const sessionId = await createSession(request);
		const first = await request("GET", `/sessions/${sessionId}/events`, { token: "supervisor" });
		expect(first.status).toBe(200);
		expect(first.headers.get("content-type")).toContain("text/event-stream");
		const opening = await firstEvents(first, 3);
		expect(opening.map((event) => event.event)).toEqual(["hello", "snapshot", "ready"]);
		const snapshot = JSON.parse(opening[1]?.data ?? "{}") as Extract<ServerFrame, { type: "snapshot" }>;
		expect(opening[1]?.id).toBe(snapshot.snapshot.cursor);

		script.reply({ text: "Hello" });
		const prompted = await request("POST", `/sessions/${sessionId}/prompt`, {
			token: "supervisor",
			body: { text: "Hi" },
		});
		expect(prompted.status).toBe(202);
		const submission = (await prompted.json()) as { id: string };
		const result = await request(
			"GET",
			`/sessions/${sessionId}/result?submission=${encodeURIComponent(submission.id)}`,
			{
				token: "supervisor",
			},
		);
		expect(await result.json()).toMatchObject({ status: "answered", answer: "Hello" });

		const resumed = await request("GET", `/sessions/${sessionId}/events`, {
			token: "supervisor",
			headers: { "last-event-id": snapshot.snapshot.cursor },
		});
		const events: { event: string; data: string; id?: string }[] = [];
		if (resumed.body === null) throw new Error("no body");
		await readSse(resumed.body, (event) => {
			events.push(event);
			return event.event !== "ready";
		});
		expect(events[0]?.event).toBe("hello");
		expect(JSON.parse(events[0]?.data ?? "{}")).toMatchObject({ type: "hello", resumed: true });
		const deltas = events.slice(1, -1);
		expect(deltas.length).toBeGreaterThan(0);
		expect(deltas.every((event) => event.event === "delta" && event.id !== undefined)).toBe(true);
	});

	it("refuses to stream a session the caller cannot see, as JSON rather than an event stream", async () => {
		const { request } = setUp();
		const response = await request("GET", "/sessions/no-such-session/events", { token: "supervisor" });
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("application/json");
	});

	it("answers 202 pending while a run is still going, then the result", async () => {
		const seen: HostToolCall[] = [];
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const host = createHostToolEndpoint(
			async (call) => {
				seen.push(call);
				await released;
				return { output: "Reviewed" };
			},
			{ secret: "s".repeat(32) },
		);
		const { request, script } = setUp(async (input, init) => host(new Request(input, init)));
		const sessionId = await createSession(request);
		const registered = await request("PUT", "/hosts/sal", {
			token: "supervisor",
			body: {
				tools: [{ name: "review", description: "Waits", inputSchema: { type: "object" }, replay: "unsafe" }],
				callback: { url: "https://sal.test/tools", secret: "s".repeat(32) },
			},
		});
		expect(registered.status).toBe(200);
		expect(await registered.json()).not.toHaveProperty("secret");
		script.reply({ toolCalls: [{ name: "review", args: {} }] }, { text: "Done" });
		const submission = (await (
			await request("POST", `/sessions/${sessionId}/prompt`, { token: "supervisor", body: { text: "Go" } })
		).json()) as { id: string };
		const path = `/sessions/${sessionId}/result?submission=${encodeURIComponent(submission.id)}`;
		const pending = await request("GET", `${path}&timeoutMs=20`, { token: "supervisor" });
		expect(pending.status).toBe(202);
		expect(await pending.json()).toMatchObject({ status: "pending", submissionId: submission.id });
		release();
		const done = await request("GET", path, { token: "supervisor" });
		expect(done.status).toBe(200);
		expect(await done.json()).toMatchObject({ status: "answered", answer: "Done" });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ hostId: "sal", sessionId, tool: "review", projectId: PROJECT });
	});

	it("forks a session from an answer and edits a message to rerun it, refusing malformed bodies", async () => {
		const { request, script, memory } = setUp();
		const sessionId = await createSession(request);
		const ask = async (text: string, answer: string) => {
			script.reply({ text: answer });
			const response = await request("POST", `/sessions/${sessionId}/prompt`, { token: "supervisor", body: { text } });
			const { id } = (await response.json()) as { id: string };
			await memory.runtime.wait({ ...supervisor }, sessionId, id);
		};
		await ask("One", "Answer one");
		await ask("Two", "Answer two");
		const snapshot = (await (
			await request("GET", `/sessions/${sessionId}/snapshot`, { token: "supervisor" })
		).json()) as {
			items: { id: string; kind: string; text?: string }[];
		};
		const idOf = (text: string) => snapshot.items.find((item) => item.text === text)!.id;

		const forked = await request("POST", `/sessions/${sessionId}/fork`, {
			token: "supervisor",
			body: { itemId: idOf("Answer one") },
		});
		expect(forked.status).toBe(201);
		const fork = (await forked.json()) as { id: string; projectId: string };
		expect(fork.projectId).toBe(PROJECT);
		const forkItems = (await (
			await request("GET", `/sessions/${fork.id}/snapshot`, { token: "supervisor" })
		).json()) as {
			items: { text?: string }[];
		};
		expect(forkItems.items.map((item) => item.text)).toEqual(["One", "Answer one"]);

		script.reply({ text: "Answer two, edited" });
		const edited = await request("POST", `/sessions/${sessionId}/edit`, {
			token: "supervisor",
			body: { itemId: idOf("Two"), text: "Two, edited", requestId: "r1" },
		});
		expect(edited.status).toBe(202);
		const submission = (await edited.json()) as { id: string; requestId: string };
		expect(submission.requestId).toBe("r1");
		await memory.runtime.wait({ ...supervisor }, sessionId, submission.id);
		const after = (await (await request("GET", `/sessions/${sessionId}/snapshot`, { token: "supervisor" })).json()) as {
			items: { text?: string }[];
		};
		expect(after.items.map((item) => item.text)).toEqual(["One", "Answer one", "Two, edited", "Answer two, edited"]);

		const refused = async (path: string, body: unknown) =>
			(await request("POST", `/sessions/${sessionId}/${path}`, { token: "supervisor", body })).status;
		expect(await refused("fork", {})).toBe(400);
		expect(await refused("fork", { itemId: "a1", title: 3 })).toBe(400);
		expect(await refused("edit", { itemId: "u1" })).toBe(400);
		expect(await refused("edit", { text: "x" })).toBe(400);
		expect(await refused("fork", { itemId: "nope" })).toBe(404);
	});

	it("renames, pins and deletes a session, refusing malformed bodies", async () => {
		const { request } = setUp();
		const sessionId = await createSession(request);
		const path = `/sessions/${sessionId}`;

		const patched = await request("PATCH", path, {
			token: "supervisor",
			body: { title: " Release plan ", pinned: true, unread: true, ignored: "x" },
		});
		expect(patched.status).toBe(200);
		const record = (await patched.json()) as { title: string; pinnedAt?: number; markedUnreadAt?: number };
		expect(record.title).toBe("Release plan");
		expect(record.pinnedAt).toBeTypeOf("number");
		expect(record.markedUnreadAt).toBeTypeOf("number");
		const read = await request("GET", path, { token: "supervisor" });
		expect(await read.json()).toMatchObject({ title: "Release plan", pinnedAt: record.pinnedAt });

		const refused = async (body: unknown) => (await request("PATCH", path, { token: "supervisor", body })).status;
		expect(await refused({ title: 3 })).toBe(400);
		expect(await refused({ pinned: "yes" })).toBe(400);
		expect(await refused({ archived: 1 })).toBe(400);
		expect(await refused({ title: "  " })).toBe(400);
		expect(await refused([])).toBe(400);

		const deleted = await request("DELETE", path, { token: "supervisor" });
		expect(deleted.status).toBe(204);
		expect((await request("GET", path, { token: "supervisor" })).status).toBe(404);
		expect((await request("DELETE", path, { token: "supervisor" })).status).toBe(404);
		expect((await request("PATCH", path, { token: "supervisor", body: { pinned: false } })).status).toBe(404);
		const listed = (await (await request("GET", "/sessions", { token: "supervisor" })).json()) as {
			items: { id: string }[];
		};
		expect(listed.items.map((item) => item.id)).not.toContain(sessionId);
	});

	it("registers only https callbacks with a long enough secret, and generates one when none is given", async () => {
		const { request } = setUp();
		const tools = [{ name: "review", description: "Waits", inputSchema: { type: "object" }, replay: "unsafe" }];
		const plain = await request("PUT", "/hosts/sal", {
			token: "supervisor",
			body: { tools, callback: { url: "http://169.254.169.254/latest" } },
		});
		expect(plain.status).toBe(422);
		expect(await plain.json()).toMatchObject({ error: { code: "refused" } });
		const withUser = await request("PUT", "/hosts/sal", {
			token: "supervisor",
			body: { tools, callback: { url: "https://user:pass@sal.test/tools" } },
		});
		expect(withUser.status).toBe(422);
		const short = await request("PUT", "/hosts/sal", {
			token: "supervisor",
			body: { tools, callback: { url: "https://sal.test/tools", secret: "short" } },
		});
		expect(short.status).toBe(400);
		const badTool = await request("PUT", "/hosts/sal", {
			token: "supervisor",
			body: { tools: [{ name: "x" }], callback: { url: "https://sal.test/tools" } },
		});
		expect(badTool.status).toBe(400);
		const generated = await request("PUT", "/hosts/sal", {
			token: "supervisor",
			body: { tools, callback: { url: "https://sal.test/tools" } },
		});
		expect(generated.status).toBe(200);
		const body = (await generated.json()) as { secret?: string; registration: string };
		expect(body.secret?.length ?? 0).toBeGreaterThanOrEqual(32);
		const listed = await request("GET", "/hosts/sal/tools", { token: "supervisor" });
		expect(await listed.json()).toMatchObject({ items: [{ name: "review" }] });
		const remove = `/hosts/sal?registration=${body.registration}`;
		expect((await request("DELETE", remove, { token: "other" })).status).toBe(403);
		// A removal must name the registration, so it can never take a newer one by accident.
		expect((await request("DELETE", "/hosts/sal", { token: "supervisor" })).status).toBe(400);
		expect(await (await request("GET", "/hosts/sal/tools", { token: "supervisor" })).json()).toMatchObject({
			items: [{ name: "review" }],
		});
		expect((await request("DELETE", remove, { token: "supervisor" })).status).toBe(204);
		expect(await (await request("GET", "/hosts/sal/tools", { token: "supervisor" })).json()).toEqual({ items: [] });
		expect((await request("DELETE", remove, { token: "supervisor" })).status).toBe(404);
	});
});

describe("host registrations", () => {
	const register = (request: ReturnType<typeof setUp>["request"], token: string) =>
		request("PUT", "/hosts/sal", { token, body: { tools: TOOLS, callback: { url: "https://sal.test/tools" } } });
	const toolCount = async (request: ReturnType<typeof setUp>["request"]) =>
		((await (await request("GET", "/hosts/sal/tools", { token: "supervisor" })).json()) as { items: unknown[] }).items
			.length;

	it("lets only the API key that registered a host remove it, not another key of the same service", async () => {
		const { request } = setUp();
		const registered = await register(request, "keyOne");
		expect(registered.status).toBe(200);
		const remove = `/hosts/sal?registration=${((await registered.json()) as { registration: string }).registration}`;
		expect((await request("DELETE", remove, { token: "keyTwo" })).status).toBe(403);
		expect(await toolCount(request)).toBe(1);
		expect((await request("DELETE", remove, { token: "keyOne" })).status).toBe(204);
		expect(await toolCount(request)).toBe(0);
	});

	it("does not let a replaced registration remove the one that replaced it", async () => {
		const { request } = setUp();
		const first = (await (await register(request, "supervisor")).json()) as { registration: string };
		const second = (await (await register(request, "supervisor")).json()) as { registration: string };
		expect(first.registration).not.toBe(second.registration);
		const stale = await request("DELETE", `/hosts/sal?registration=${first.registration}`, { token: "supervisor" });
		expect(stale.status).toBe(404);
		expect(await toolCount(request)).toBe(1);
		const current = await request("DELETE", `/hosts/sal?registration=${second.registration}`, { token: "supervisor" });
		expect(current.status).toBe(204);
		expect(await toolCount(request)).toBe(0);
	});

	it("keeps a second client's registration when the first client's subscription closes", async () => {
		const { api, memory } = setUp();
		const served: string[] = [];
		const clientFor = (name: string) =>
			createSessionApiClient({
				baseUrl: "https://harbour.test/v1",
				credentials: bearer("supervisor"),
				fetch: async (input, init) => api.fetch(new Request(input, init)),
				hostCallbacks: {
					url: () => "https://sal.test/tools",
					serve: (_hostId, endpoint) => {
						served.push(`${name}:${endpoint === undefined ? "off" : "on"}`);
					},
				},
			});
		const ctx = { actor: supervisor.actor, organisationId: ORG };
		const first = await clientFor("a").hostTools.register(ctx, "sal", TOOLS, async () => ({ output: "a" }));
		await clientFor("b").hostTools.register(ctx, "sal", TOOLS, async () => ({ output: "b" }));
		await first.close();
		expect(await memory.hostTools.list(ctx, "sal")).toHaveLength(1);
		expect(served).toEqual(["a:on", "b:on", "a:off"]);
	});

	it("retries the removal when a subscription's first close fails", async () => {
		const { api, memory } = setUp();
		const served: string[] = [];
		let failNextDelete = true;
		const client = createSessionApiClient({
			baseUrl: "https://harbour.test/v1",
			credentials: bearer("supervisor"),
			fetch: async (input, init) => {
				const request = new Request(input, init);
				if (request.method === "DELETE" && failNextDelete) {
					failNextDelete = false;
					return new Response(JSON.stringify({ error: { code: "unavailable", message: "Down" } }), { status: 503 });
				}
				return api.fetch(request);
			},
			hostCallbacks: {
				url: () => "https://sal.test/tools",
				serve: (_hostId, endpoint) => {
					served.push(endpoint === undefined ? "off" : "on");
				},
			},
		});
		const ctx = { actor: supervisor.actor, organisationId: ORG };
		const subscription = await client.hostTools.register(ctx, "sal", TOOLS, async () => ({ output: "ok" }));
		await expect(subscription.close()).rejects.toMatchObject({ code: "unavailable" });
		expect(await memory.hostTools.list(ctx, "sal")).toHaveLength(1);
		expect(served).toEqual(["on"]);
		await subscription.close();
		expect(await memory.hostTools.list(ctx, "sal")).toHaveLength(0);
		expect(served).toEqual(["on", "off"]);
		await subscription.close();
		expect(served).toEqual(["on", "off"]);
	});
});

describe("agent profiles", () => {
	it("refuses a malformed profile and keeps the one stored", async () => {
		const { request } = setUp();
		expect((await request("PUT", "/profiles/worker", { token: "supervisor", body: profile })).status).toBe(200);
		const before = await (await request("GET", "/profiles/worker", { token: "supervisor" })).json();
		for (const body of [
			{ id: "worker", organisationId: ORG },
			{ ...(before as object), promptLayers: "be good" },
			{ ...(before as object), model: { route: 7 } },
			{ ...(before as object), sandbox: {} },
		]) {
			const response = await request("PUT", "/profiles/worker", { token: "supervisor", body });
			expect(response.status).toBe(400);
		}
		expect(await (await request("GET", "/profiles/worker", { token: "supervisor" })).json()).toEqual(before);
		const renamed = await request("PUT", "/profiles/worker", {
			token: "supervisor",
			body: { ...(before as object), name: "Renamed" },
		});
		expect(renamed.status).toBe(200);
	});
});

describe("requests that go away", () => {
	const stubApi = (runtime: Partial<SessionRuntime>) =>
		createSessionApi({
			runtime: runtime as SessionRuntime,
			directory: {} as never,
			profiles: {} as never,
			hostTools: {} as never,
			authenticator: staticTokenAuthenticator({ supervisor }),
			keepAliveMs: 5,
		});

	it("closes the watch when the caller goes away while it is being set up", async () => {
		let resolveWatch: (subscription: { close(): Promise<void> }) => void = () => {};
		let closed = 0;
		let watching: () => void = () => {};
		const watchStarted = new Promise<void>((resolve) => {
			watching = resolve;
		});
		const api = stubApi({
			watch: () =>
				new Promise((resolve) => {
					resolveWatch = resolve;
					watching();
				}),
		});
		const controller = new AbortController();
		const responding = api.fetch(
			new Request("https://harbour.test/v1/sessions/s-1/events", {
				headers: { authorization: "Bearer supervisor" },
				signal: controller.signal,
			}),
		);
		// Gone while the watch is being set up: after the API has asked for it, before it is ready. A fixed wait here
		// raced the request's own setup on a loaded host.
		await watchStarted;
		controller.abort();
		resolveWatch({
			close: async () => {
				closed += 1;
			},
		});
		const response = await responding;
		expect(closed).toBe(1);
		// The stream is already closed, so no keep-alive is left running to write to it.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await response.text()).not.toContain("keep-alive");
		await api.close();
		expect(closed).toBe(1);
	});

	it("stops a result wait when its caller goes away, without stopping the run", async () => {
		let seen: AbortSignal | undefined;
		const api = stubApi({
			wait: (ctx) => {
				seen = ctx.signal;
				return new Promise((_resolve, reject) =>
					ctx.signal?.addEventListener("abort", () => reject(new HarbourError("aborted", "stopped"))),
				);
			},
		});
		const controller = new AbortController();
		const responding = api.fetch(
			new Request("https://harbour.test/v1/sessions/s-1/result?submission=s-1%2F1&timeoutMs=60000", {
				headers: { authorization: "Bearer supervisor" },
				signal: controller.signal,
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(seen?.aborted).toBe(false);
		controller.abort();
		const response = await responding;
		expect(seen?.aborted).toBe(true);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: { code: "aborted" } });
	});

	it("does not tie a prompt's run to the request that sent it", async () => {
		const { api, script, request } = setUp();
		const sessionId = await createSession(request);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		script.reply(async () => {
			await gate;
			return { text: "Still answered" };
		});
		const controller = new AbortController();
		const prompted = await api.fetch(
			new Request(`https://harbour.test/v1/sessions/${sessionId}/prompt`, {
				method: "POST",
				headers: { authorization: "Bearer supervisor", "content-type": "application/json" },
				body: JSON.stringify({ text: "Go" }),
				signal: controller.signal,
			}),
		);
		const submission = (await prompted.json()) as { id: string };
		controller.abort();
		release();
		const result = await request(
			"GET",
			`/sessions/${sessionId}/result?submission=${encodeURIComponent(submission.id)}`,
			{ token: "supervisor" },
		);
		expect(await result.json()).toMatchObject({ status: "answered", answer: "Still answered" });
	});
});

describe("host-tool callbacks", () => {
	const secret = "a-callback-secret-at-least-32-chars-long";
	const call: HostToolCall = {
		hostId: "sal",
		sessionId: "s-1",
		organisationId: ORG,
		projectId: PROJECT,
		agentId: "worker",
		callId: "call-1",
		tool: "lookup",
		args: { key: "plan" },
	};

	it("signs each call so the host can check it, and refuses a changed body, another secret or an old signature", async () => {
		const now = Date.UTC(2026, 9, 27, 12);
		const header = await signHostToolCall(secret, "{}", now);
		expect(await verifyHostToolSignature(secret, "{}", header, now)).toBe(true);
		expect(await verifyHostToolSignature(secret, '{"a":1}', header, now)).toBe(false);
		expect(await verifyHostToolSignature(`${secret}x`, "{}", header, now)).toBe(false);
		expect(await verifyHostToolSignature(secret, "{}", header, now + 6 * 60 * 1000)).toBe(false);
		expect(await verifyHostToolSignature(secret, "{}", null, now)).toBe(false);
		expect(await verifyHostToolSignature(secret, "{}", "t=abc,v1=00", now)).toBe(false);
	});

	it("sends the call to the host endpoint, which runs the handler and returns its result", async () => {
		const received: HostToolCall[] = [];
		const endpoint = createHostToolEndpoint(
			async (incoming) => {
				received.push(incoming);
				return { output: "Note plan is ready", structured: { key: "plan" } };
			},
			{ secret },
		);
		let headers: Headers | undefined;
		const handler = callbackHostToolHandler({
			url: "https://sal.test/tools/sal",
			secret,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				headers = request.headers;
				expect(request.redirect).toBe("manual");
				return endpoint(request);
			},
		});
		const result = await handler(call, new AbortController().signal);
		expect(result).toEqual({ output: "Note plan is ready", structured: { key: "plan" } });
		expect(received).toEqual([call]);
		expect(headers?.get(HEADERS.callId)).toBe("call-1");
		expect(headers?.get(HEADERS.hostId)).toBe("sal");
	});

	it("rejects an unsigned call at the endpoint, and fails the tool call when the host refuses or is down", async () => {
		const endpoint = createHostToolEndpoint(async () => ({ output: "never" }), { secret });
		const unsigned = await endpoint(new Request("https://sal.test/tools/sal", { method: "POST", body: "{}" }));
		expect(unsigned.status).toBe(401);
		const wrongSecret = callbackHostToolHandler({
			url: "https://sal.test/tools/sal",
			secret: `${secret}-other`,
			fetch: async (input, init) => endpoint(new Request(input, init)),
		});
		await expect(wrongSecret(call, new AbortController().signal)).rejects.toMatchObject({ code: "unavailable" });
		const down = callbackHostToolHandler({
			url: "https://sal.test/tools/sal",
			secret,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		await expect(down(call, new AbortController().signal)).rejects.toMatchObject({ code: "unavailable" });
	});

	it("aborts the host request, and the handler's signal, when the call is aborted", async () => {
		let handlerSignal: AbortSignal | undefined;
		let handling: () => void = () => {};
		const handlerStarted = new Promise<void>((resolve) => {
			handling = resolve;
		});
		const endpoint = createHostToolEndpoint(
			(_incoming, signal) => {
				handlerSignal = signal;
				handling();
				return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
			},
			{ secret },
		);
		const handler = callbackHostToolHandler({
			url: "https://sal.test/tools/sal",
			secret,
			fetch: async (input, init) => endpoint(new Request(input, init)),
		});
		const controller = new AbortController();
		const running = handler(call, controller.signal);
		// Aborted while the host's handler runs. A fixed wait here could abort before the endpoint had checked the
		// signature and called the handler, which then waited for an abort that had already happened (main, 30 Oct).
		await handlerStarted;
		controller.abort();
		// In process the endpoint answers 500 once its handler rejects; over a network the fetch itself rejects.
		await expect(running).rejects.toBeInstanceOf(HarbourError);
		expect(handlerSignal?.aborted).toBe(true);
	});
});

describe("readSse", () => {
	it("parses events split across chunks, with CRLF line ends, comments and multi-line data", async () => {
		const text = ": hi\r\nid: c1\r\nevent: delta\r\ndata: a\r\ndata: b\r\n\r\nevent: ready\ndata: {}\n\n";
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let index = 0; index < text.length; index += 3)
					controller.enqueue(encoder.encode(text.slice(index, index + 3)));
				controller.close();
			},
		});
		const events: unknown[] = [];
		await readSse(body, (event) => {
			events.push(event);
			return true;
		});
		expect(events).toEqual([
			{ event: "delta", data: "a\nb", id: "c1" },
			{ event: "ready", data: "{}" },
		]);
	});
});
