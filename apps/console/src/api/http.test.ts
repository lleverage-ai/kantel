// The console's API client against the real session API (`@harbour/runtime/http`) over the in-memory runtime, in
// process: every call goes through the HTTP handler the gateway serves, with a scripted model holding runs open so
// steer, follow-up and cancel can be sent while one is running.
import type { AgentProfile, Authentication, CallContext } from "@harbour/contracts";
import { createSessionApi, staticTokenAuthenticator } from "@harbour/runtime/http";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SessionClient } from "../state/session-client.ts";
import { createApiClient } from "./http.ts";
import { readEvents } from "./sse.ts";

const ORG = "org-console";
const tom: Authentication = { actor: { kind: "service", serviceId: "tom" }, organisationId: ORG };
const ctx: CallContext = { actor: tom.actor, organisationId: ORG };
const BASE = "https://harbour.test/v1";

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

function gate() {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

async function eventually(check: () => boolean, what: string, ms = 3000) {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function setUp() {
	const { models, script } = createScriptedModel();
	const memory = createMemoryRuntime({ models });
	const api = createSessionApi({
		...memory,
		authenticator: staticTokenAuthenticator({ tom }),
		keepAliveMs: 60_000,
	});
	cleanups.push(async () => {
		await api.close();
		await memory.close();
	});
	await memory.profiles.put(ctx, profile);
	const apiFetch = (request: Request) => api.fetch(request);
	const client = createApiClient({
		baseUrl: BASE,
		headers: () => ({ authorization: "Bearer tom" }),
		fetch: (input, init) => apiFetch(new Request(input, init)),
		listPollMs: 20,
	});
	const create = async (projectId: string, title?: string) =>
		(await memory.runtime.create(ctx, { projectId, agentId: "worker", ...(title === undefined ? {} : { title }) })).id;
	const open = (sessionId: string) => {
		const session = new SessionClient(client.transport(sessionId), sessionId);
		session.start();
		cleanups.push(() => session.stop());
		return session;
	};
	return { memory, script, client, create, open, apiFetch };
}

const texts = (session: SessionClient) =>
	session
		.getState()
		.items.map((item) =>
			item.kind === "user"
				? `${item.via}:${item.text}`
				: item.kind === "assistant"
					? `assistant:${item.text}`
					: item.kind,
		);

describe("the console on the session API", () => {
	it("finds the projects from the caller's sessions, the most recently active first", async () => {
		const { client, create } = await setUp();
		await create("proj-a");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await create("proj-b");
		await create("proj-b");
		expect(await client.projects()).toEqual([
			{ id: "proj-b", name: "proj-b" },
			{ id: "proj-a", name: "proj-a" },
		]);
	});

	it("follows a project's sessions, and marks one unread when it finishes while it isn't open", async () => {
		const { client, create, script } = await setUp();
		const watched = await create("proj-a", "Watched");
		const away = await create("proj-a", "Away");
		await create("proj-b", "Elsewhere");
		const states: { sessions: readonly { id: string; status: string; unread?: boolean }[] }[] = [];
		const stop = client.watchSessions("proj-a", (state) => states.push(state));
		cleanups.push(stop);
		await eventually(() => states.length > 0, "the first list");
		expect(states[0]?.sessions.map((session) => session.id).sort()).toEqual([away, watched].sort());

		const release = client.markRead(watched);
		const held = gate();
		script.reply(async () => {
			await held.opened;
			return { text: "one" };
		});
		script.reply(async () => {
			await held.opened;
			return { text: "two" };
		});
		await client.prompt(watched, "Go");
		await client.prompt(away, "Go");
		const latest = () => states.at(-1)?.sessions ?? [];
		await eventually(() => latest().every((session) => session.status === "running"), "both running");
		held.open();
		await eventually(() => latest().every((session) => session.status === "done"), "both done");
		expect(latest().find((session) => session.id === away)?.unread).toBe(true);
		expect(latest().find((session) => session.id === watched)?.unread).toBeUndefined();
		release();
		client.markRead(away)();
		await eventually(() => latest().every((session) => session.unread === undefined), "away read");
		expect(await client.projectOf(away)).toBe("proj-a");
	});

	it("marks a session unread when a whole run happens between two looks at the list", async () => {
		const { client, create, script, memory } = await setUp();
		const id = await create("proj-a", "Quick");
		const states: { sessions: readonly { id: string; unread?: boolean }[] }[] = [];
		cleanups.push(client.watchSessions("proj-a", (state) => states.push(state)));
		await eventually(() => states.length > 0, "the first list");
		expect(states[0]?.sessions[0]?.unread).toBeUndefined();
		script.reply({ text: "Done already" });
		const submitted = await memory.runtime.prompt(ctx, id, { text: "Quick one" });
		await memory.runtime.wait(ctx, id, submitted.id);
		const after = states.length;
		await eventually(() => states.length > after, "the next list");
		expect(states.at(-1)?.sessions[0]?.unread).toBe(true);
	});

	it("doesn't mark a session unread when you watched it finish and left before the list caught up", async () => {
		const { apiFetch, client, create, open, script } = await setUp();
		const id = await create("proj-a", "Watched");
		const slow = createApiClient({
			baseUrl: BASE,
			headers: () => ({ authorization: "Bearer tom" }),
			fetch: (input, init) => apiFetch(new Request(input, init)),
			listPollMs: 300,
		});
		const states: { sessions: readonly { id: string; unread?: boolean }[] }[] = [];
		cleanups.push(slow.watchSessions("proj-a", (state) => states.push(state)));
		await eventually(() => states.length > 0, "the first list");
		const release = slow.markRead(id);
		const session = open(id);
		script.reply({ text: "Finished" });
		await client.prompt(id, "Go");
		await eventually(() => texts(session).includes("assistant:Finished"), "the answer on screen");
		const before = states.length;
		release();
		await eventually(() => states.length > before + 1, "two more lists");
		expect(states.at(-1)?.sessions[0]?.unread).toBeUndefined();
	});

	it("marks a session unread when it finishes just after you leave, even while its leaving is still being read", async () => {
		const { apiFetch, client, create, script } = await setUp();
		const id = await create("proj-a", "Left running");
		const answer = gate();
		const leaving = createApiClient({
			baseUrl: BASE,
			headers: () => ({ authorization: "Bearer tom" }),
			fetch: async (input, init) => {
				const request = new Request(input, init);
				const response = await apiFetch(request);
				// The lookup on leaving is answered late: after the session has finished.
				if (new URL(request.url).pathname === `/v1/sessions/${id}`) await answer.opened;
				return response;
			},
			listPollMs: 20,
		});
		const states: { sessions: readonly { id: string; status: string; unread?: boolean }[] }[] = [];
		cleanups.push(leaving.watchSessions("proj-a", (state) => states.push(state)));
		await eventually(() => states.length > 0, "the first list");
		const release = leaving.markRead(id);
		const run = gate();
		script.reply(async () => {
			await run.opened;
			return { text: "Finished" };
		});
		await client.prompt(id, "Go");
		const latest = () => states.at(-1)?.sessions[0];
		await eventually(() => latest()?.status === "running", "the run");
		release();
		run.open();
		await eventually(() => latest()?.status === "done", "the finish, listed");
		expect(latest()?.unread).toBeUndefined();
		answer.open();
		await eventually(() => latest()?.unread === true, "unread once the lookup is in");
	});

	it("lists every page of sessions, and finds a linked session the list hasn't shown", async () => {
		const { apiFetch, client, create } = await setUp();
		const first = await create("proj-old");
		for (let index = 0; index < 120; index++) await create("proj-a");
		// proj-old's one session is the oldest, past the first page.
		expect((await client.projects()).map((project) => project.id).sort()).toEqual(["proj-a", "proj-old"]);
		const states: { sessions: readonly unknown[] }[] = [];
		cleanups.push(client.watchSessions("proj-a", (state) => states.push(state)));
		await eventually(() => states.length > 0, "the list");
		expect(states[0]?.sessions).toHaveLength(120);

		const fresh = createApiClient({
			baseUrl: BASE,
			headers: () => ({ authorization: "Bearer tom" }),
			fetch: (input, init) => apiFetch(new Request(input, init)),
		});
		expect(await fresh.projectOf(first)).toBe("proj-old");
		expect(await fresh.projectOf("s-nobody")).toBeUndefined();
	});

	it("streams a session: a snapshot, then the run's answer as it happens", async () => {
		const { client, create, open, script } = await setUp();
		const id = await create("proj-a", "Hello");
		const session = open(id);
		await eventually(() => session.getState().connection.status === "open", "the stream");
		expect(session.getState().title).toBe("Hello");
		script.reply({ text: "Hi there" });
		await client.prompt(id, "Hello?", { requestId: "r-1" });
		await eventually(() => texts(session).includes("assistant:Hi there"), "the answer");
		expect(texts(session)).toEqual(["prompt:Hello?", "assistant:Hi there"]);
		expect(session.getState().status).not.toBe("running");
		// The same request id sends once.
		await client.prompt(id, "Hello?", { requestId: "r-1" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(texts(session)).toEqual(["prompt:Hello?", "assistant:Hi there"]);
	});

	it("steers a running session, queues a follow-up for after it, and cancels a run", async () => {
		const { client, create, open, script } = await setUp();
		const id = await create("proj-a");
		const session = open(id);
		const first = gate();
		script.reply(
			async () => {
				await first.opened;
				return { text: "First answer" };
			},
			{ text: "Steered answer" },
			{ text: "Follow-up answer" },
		);
		await client.prompt(id, "First");
		await eventually(() => session.getState().status === "running", "the run");
		await client.steer(id, "Shorter, please");
		await client.followUp(id, "And then this");
		first.open();
		await eventually(
			() => texts(session).includes("followUp:And then this") && session.getState().status !== "running",
			"both",
		);
		const shown = texts(session);
		expect(shown).toContain("steer:Shorter, please");
		expect(shown.indexOf("followUp:And then this")).toBeGreaterThan(shown.indexOf("steer:Shorter, please"));

		const held = gate();
		script.reply(async () => {
			await held.opened;
			return { text: "Too late" };
		});
		await client.prompt(id, "Long job");
		await eventually(() => session.getState().status === "running", "the long run");
		await client.cancel(id);
		held.open();
		await eventually(() => session.getState().status !== "running", "the cancel");
		// The run stops and the session stays usable.
		expect(session.getState().status).toBe("idle");
		expect(texts(session)).not.toContain("assistant:Too late");
	});

	it("sends a retried message once when the host took it but its answer was lost", async () => {
		const { apiFetch, create, open, script } = await setUp();
		const id = await create("proj-a");
		let loseNextAnswer = true;
		const lossy = createApiClient({
			baseUrl: BASE,
			headers: () => ({ authorization: "Bearer tom" }),
			fetch: async (input, init) => {
				const request = new Request(input, init);
				const response = await apiFetch(request);
				if (request.method === "POST" && loseNextAnswer) {
					loseNextAnswer = false;
					throw new TypeError("fetch failed");
				}
				return response;
			},
		});
		script.reply({ text: "Once" });
		await expect(lossy.prompt(id, "Hello", { requestId: "r-lost" })).rejects.toThrow("Can't reach Harbour");
		await lossy.prompt(id, "Hello", { requestId: "r-lost" });
		const session = open(id);
		await eventually(() => texts(session).includes("assistant:Once"), "the answer");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(texts(session)).toEqual(["prompt:Hello", "assistant:Once"]);
	});

	it("says why a call was refused, in words", async () => {
		const { create } = await setUp();
		const id = await create("proj-a");
		const signedOut = createApiClient({ baseUrl: BASE, fetch: async () => new Response(null, { status: 401 }) });
		await expect(signedOut.prompt(id, "Hi")).rejects.toThrow("You're signed out. Reload the page to sign in.");
		const offline = createApiClient({
			baseUrl: BASE,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		await expect(offline.cancel(id)).rejects.toThrow("Can't reach Harbour. Check your connection.");
	});

	it("shows an unknown session's error instead of retrying it", async () => {
		const { open } = await setUp();
		const session = open("s-nobody");
		await eventually(() => session.getState().error !== undefined, "the error");
		expect(session.getState().error).toMatch(/^not_found: /);
		expect(session.getState().connection.status).toBe("connecting");
	});

	it("reconnects when the stream drops, resuming after the last cursor it applied", async () => {
		const { apiFetch, client, create, script } = await setUp();
		const id = await create("proj-a");
		script.reply({ text: "Before" }, { text: "After" });
		// A stream the network can cut.
		const cuts: (() => void)[] = [];
		const afters: (string | null)[] = [];
		const flaky = createApiClient({
			baseUrl: BASE,
			headers: () => ({ authorization: "Bearer tom" }),
			fetch: async (input, init) => {
				const request = new Request(input, init);
				const response = await apiFetch(request);
				const url = new URL(request.url);
				if (!url.pathname.endsWith("/events") || response.body === null) return response;
				afters.push(url.searchParams.get("after"));
				const reader = response.body.getReader();
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						cuts.push(() => {
							controller.error(new Error("network gone"));
							void reader.cancel();
						});
					},
					async pull(controller) {
						const { done, value } = await reader.read();
						try {
							if (done) controller.close();
							else controller.enqueue(value);
						} catch {
							// Already cut.
						}
					},
				});
				return new Response(body, { status: response.status, headers: response.headers });
			},
		});
		const session = new SessionClient(flaky.transport(id), id);
		session.start();
		cleanups.push(() => session.stop());
		await client.prompt(id, "One");
		await eventually(() => texts(session).includes("assistant:Before"), "the first answer");
		const cursor = session.getState().cursor;
		cuts.at(-1)?.();
		await eventually(() => session.getState().connection.status === "offline", "the drop");
		await eventually(() => session.getState().connection.status === "open" && afters.length === 2, "the reconnect");
		expect(afters).toEqual([null, cursor]);
		expect(session.getState().resumes.at(-1)).toMatchObject({ from: cursor, how: "deltas" });
		await client.prompt(id, "Two");
		await eventually(() => texts(session).includes("assistant:After"), "the answer after reconnecting");
		expect(texts(session)).toEqual(["prompt:One", "assistant:Before", "prompt:Two", "assistant:After"]);
	});
});

describe("readEvents", () => {
	it("splits events across chunks and line endings, skipping comments", async () => {
		const chunks = ["event: hel", 'lo\r\ndata: {"a"', ":1}\r", "\n\r\n: keep-alive\n\nevent: x\ndata: 2\n\n"];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		});
		const events: unknown[] = [];
		await readEvents(body, (event) => events.push(event));
		expect(events).toEqual([
			{ event: "hello", data: '{"a":1}' },
			{ event: "x", data: "2" },
		]);
	});
});
