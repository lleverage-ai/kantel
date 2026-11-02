// Kantel's own browser runtime (src/runtime): the coordinator over a fake agent, the kantel provider over the
// coordinator, view tokens and the view handler, sealing, and the live pipe's filter. The agent here answers as
// images/browser/agent does, with what the coordinator reads of it.
import {
	AGENT_TOKEN_HEADER,
	type BlobStore,
	type BrowserMachine,
	blobKeys,
	browserProviderName,
	CLOSE_EXPIRED,
	createBrowserCoordinator,
	createBrowserViewSigner,
	createKantelBrowserProvider,
	createSealer,
	declineConsentSetting,
	handleBrowserView,
	KANTEL_VIEW_END_MESSAGE,
	type PipeSocket,
	pipeLive,
	prefixedBlobs,
	type RecordingManifest,
	VIEW_TOKEN_PROTOCOL,
	viewTokenOf,
	watchMessage,
} from "@kantel/browser/runtime";
import { KantelError } from "@kantel/contracts";
import { describe, expect, it } from "vitest";

const VIEW_KEY = "test-browser-view-key-0123456789abcdef";
const SEAL_KEY = "test-browser-seal-key-0123456789abcdef";

type Call = { readonly method: string; readonly path: string; readonly body: string; readonly token: string | null };

/** The agent in images/browser, as far as the coordinator uses it. */
function fakeAgent(options: { domainsFail?: boolean; recording?: boolean; busyPage?: boolean } = {}) {
	const calls: Call[] = [];
	let token: string | undefined;
	let running = false;
	let profile: Uint8Array | undefined;
	let chunks: { name: string; index: number; bytes: Uint8Array }[] = [];
	let done = false;

	let decisionToken: string | undefined;
	const machine: BrowserMachine = {
		async start(env, startOptions) {
			token = env.AGENT_TOKEN;
			decisionToken = startOptions?.decisionToken;
			running = true;
		},
		async stop() {
			running = false;
		},
		async fetch(path, init = {}) {
			if (!running) throw new Error("connection refused");
			const method = init.method ?? "GET";
			const headers = new Headers(init.headers);
			const body =
				init.body instanceof Uint8Array
					? `<${init.body.length} bytes>`
					: typeof init.body === "string"
						? init.body
						: "";
			calls.push({ method, path, body, token: headers.get(AGENT_TOKEN_HEADER) });
			if (path === "/health") return Response.json({ ok: true });
			if (headers.get(AGENT_TOKEN_HEADER) !== token) return Response.json({ error: "forbidden" }, { status: 403 });
			if (path === "/profile" && method === "PUT") {
				profile = init.body as Uint8Array;
				return Response.json({ ok: true });
			}
			if (path === "/start") return Response.json({ ok: true });
			if (path === "/domains") {
				return options.domainsFail
					? Response.json({ error: "guard failed" }, { status: 500 })
					: Response.json({ ok: true });
			}
			if (path === "/recording/start") {
				if (options.recording === false) return Response.json({ error: "no" }, { status: 500 });
				chunks = [{ name: "00000.mkv", index: 0, bytes: new Uint8Array([1, 2, 3, 4]) }];
				return Response.json({ ok: true });
			}
			if (path === "/recording/stop") {
				done = true;
				chunks.push({ name: "00001.mkv", index: 1, bytes: new Uint8Array([5, 6]) });
				return Response.json({ ok: true });
			}
			if (path === "/recording" && method === "GET") {
				return Response.json({
					done,
					pages: [
						{
							pageId: "1",
							startedAt: 1_000_500,
							durationMs: 12_000,
							width: 1280,
							height: 800,
							frames: 30,
							navigations: [
								{ atMs: 0, url: "about:blank" },
								{ atMs: 1_200, url: "https://example.com/", title: "Example Domain" },
								{ atMs: "soon", url: "https://bad.example/" },
							],
							chunks: chunks.map((chunk) => ({
								name: chunk.name,
								index: chunk.index,
								startMs: chunk.index * 10_000,
								durationMs: 10_000,
								frames: 15,
							})),
						},
					],
				});
			}
			const chunk = path.match(/^\/recording\/1\/(\d{5}\.mkv)$/);
			if (chunk !== null) {
				const found = chunks.find((each) => each.name === chunk[1]);
				if (found === undefined) return new Response("gone", { status: 404 });
				if (method === "DELETE") {
					chunks = chunks.filter((each) => each !== found);
					return Response.json({ ok: true });
				}
				return new Response(found.bytes as Uint8Array<ArrayBuffer>);
			}
			// A page still busy loading: Reflex never answers (until the coordinator gives up), and no frame is drawn.
			if (options.busyPage === true && path.startsWith("/reflex/")) {
				return await new Promise<Response>((_, reject) => {
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				});
			}
			if (options.busyPage === true && path.startsWith("/screenshot")) {
				return Response.json({ error: "no page to capture" }, { status: 404 });
			}
			if (path === "/reflex/act") {
				return Response.json({ success: true, did: "Clicked", page: { url: "https://example.com/", title: "Ex" } });
			}
			if (path === "/reflex/run") {
				return Response.json({
					status: "needs_supervisor",
					steps: [
						{ n: 1, url: "https://example.com/", did: "filled “From” with from", by: "fast" },
						{ n: 2, url: "https://example.com/", note: "no change", by: "fast" },
					],
					escalation: {
						reason: "low_confidence",
						detail: "Which day?",
						page: { url: "https://example.com/" },
						candidates: [{ id: "7", p: 0.4321, describe: 'button "14"' }],
					},
					page: { url: "https://example.com/", title: "Ex" },
					usage: { decisions: 4, supervisorCalls: 0, inputTokens: 900, costUsd: 0.0003, ms: 3210.6 },
				});
			}
			if (path === "/reflex/look") return Response.json({ url: "https://example.com/", title: "Ex", elements: [] });
			if (path === "/pages") return Response.json([{ url: "https://example.com/", title: "Ex" }]);
			if (path.startsWith("/screenshot")) return new Response(new Uint8Array([0xff, 0xd8, 0xff]));
			if (path === "/export") return new Response(new Uint8Array([9, 9, 9]));
			return new Response("no route", { status: 404 });
		},
	};
	return { machine, calls, running: () => running, profile: () => profile, decisionToken: () => decisionToken };
}

function memoryBlobs(): BlobStore & { readonly keys: () => string[]; readonly raw: (key: string) => Uint8Array } {
	const map = new Map<string, Uint8Array>();
	return {
		get: async (key) => map.get(key),
		put: async (key, bytes) => void map.set(key, bytes),
		delete: async (key) => void map.delete(key),
		keys: () => [...map.keys()].sort(),
		raw: (key) => map.get(key)!,
	};
}

function setup(
	options: Parameters<typeof fakeAgent>[0] & {
		blobs?: ReturnType<typeof memoryBlobs>;
		agentTimeoutMs?: number;
		decisions?: { url: string };
		declineConsent?: boolean;
	} = {},
) {
	let clock = 1_000_000;
	const agent = fakeAgent(options);
	const blobs = options.blobs ?? memoryBlobs();
	const state = new Map<string, unknown>();
	const sealer = createSealer(SEAL_KEY);
	const coordinator = createBrowserCoordinator({
		id: "b1",
		machine: agent.machine,
		blobs,
		store: {
			get: async <T>(key: string) => state.get(key) as T,
			put: async (key, value) => void state.set(key, value),
		},
		sealer,
		now: () => clock,
		recordingRetentionMs: 60_000,
		...(options.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: options.agentTimeoutMs }),
		...(options.decisions === undefined ? {} : { decisions: options.decisions }),
		...(options.declineConsent === undefined ? {} : { declineConsent: options.declineConsent }),
	});
	const call = (method: string, path: string, body?: unknown) =>
		coordinator.handle(
			new Request(`http://browser${path}`, {
				method,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	return {
		agent,
		blobs,
		sealer,
		coordinator,
		call,
		advance: (ms: number) => {
			clock += ms;
		},
		now: () => clock,
	};
}

describe("browser coordinator", () => {
	it("starts the container with a fresh agent token, guards the grant's sites and starts recording", async () => {
		const t = setup();
		const started = await t.call("POST", "/start", { timeoutMs: 60_000, sites: ["example.com", "*.example.org"] });
		expect(started.status).toBe(200);
		expect(await started.json()).toMatchObject({ status: "running", expiresAt: 1_060_000 });
		const paths = t.agent.calls.map((call) => `${call.method} ${call.path}`);
		expect(paths).toEqual(["GET /health", "POST /start", "POST /domains", "POST /recording/start"]);
		// The broker's `*.host` reaches the agent as its domain: the agent's guard admits a domain's subdomains.
		expect(JSON.parse(t.agent.calls[2]!.body)).toEqual({ domains: ["example.com", "example.org"] });
		const token = t.agent.calls[1]!.token;
		expect(token).toMatch(/^[0-9a-f]{48}$/);
		expect(t.agent.calls.slice(1).every((call) => call.token === token)).toBe(true);
	});

	it("refuses to run a browser whose site guard fails, and stops its container", async () => {
		const t = setup({ domainsFail: true });
		const started = await t.call("POST", "/start", { timeoutMs: 60_000, sites: ["example.com"] });
		expect(started.status).toBe(503);
		expect(t.agent.running()).toBe(false);
		expect(await t.coordinator.state()).toBeUndefined();
	});

	it("keeps a browser running when its recording can't start, with no recording to replay", async () => {
		const t = setup({ recording: false });
		expect((await t.call("POST", "/start", { timeoutMs: 60_000, sites: [] })).status).toBe(200);
		expect((await t.call("GET", "/status")).status).toBe(200);
		expect(await (await t.call("GET", "/recording")).json()).toMatchObject({ status: "none" });
	});

	it("refuses a start outside 10 s to 6 h", async () => {
		const t = setup();
		expect((await t.call("POST", "/start", { timeoutMs: 1_000 })).status).toBe(400);
		expect((await t.call("POST", "/start", { timeoutMs: 7 * 3_600_000 })).status).toBe(400);
	});

	it("passes steps to Reflex and refuses unknown ones", async () => {
		const t = setup();
		await t.call("POST", "/start", { timeoutMs: 60_000, sites: [] });
		const acted = await t.call("POST", "/act", { action: { kind: "fill", element: "3", value: "hello" } });
		expect(await acted.json()).toMatchObject({ success: true, did: "Clicked" });
		const reflex = t.agent.calls.find((call) => call.path === "/reflex/act")!;
		expect(JSON.parse(reflex.body)).toEqual({ verb: "fill", element: "3", value: "hello", consent: "reject" });
		await t.call("POST", "/act", { action: { kind: "slide", element: "7", value: "09:00" } });
		const slid = t.agent.calls.filter((call) => call.path === "/reflex/act").at(-1)!;
		expect(JSON.parse(slid.body)).toEqual({ verb: "slide", element: "7", value: "09:00", consent: "reject" });
		await t.call("GET", "/look");
		const look = t.agent.calls.find((call) => call.path === "/reflex/look")!;
		expect(JSON.parse(look.body)).toEqual({ consent: "reject" });
		expect((await t.call("POST", "/act", { action: { kind: "evaluate", script: "1" } })).status).toBe(400);
	});

	it("runs a goal with the host's decision endpoint and the browser's own token, never a key", async () => {
		const t = setup({ decisions: { url: "http://192.0.2.10/decide" } });
		await t.call("POST", "/start", { timeoutMs: 60_000, sites: [] });
		const token = t.agent.decisionToken();
		expect(token).toMatch(/^[0-9a-f]{32,}$/);
		const ran = await t.call("POST", "/run", {
			goal: { goal: "search flights", data: { from: "MAN" }, url: "https://example.com/", maxSteps: 10 },
			model: "jev",
		});
		expect(ran.status).toBe(200);
		const body = (await ran.json()) as { status: string; page: { elements: unknown[] } };
		expect(body.status).toBe("needs_supervisor");
		expect(body.page.elements).toEqual([]);
		const sent = JSON.parse(t.agent.calls.find((call) => call.path === "/reflex/run")!.body);
		expect(sent).toEqual({
			task: { goal: "search flights", data: { from: "MAN" }, maxSteps: 10 },
			url: "https://example.com/",
			model: "jev",
			keys: { endpoint: { url: "http://192.0.2.10/decide/jev", token, name: "typesafe/jev" } },
		});
		expect((await t.call("POST", "/run", { goal: { goal: "x" }, model: "gpt" })).status).toBe(400);
	});

	it("has no goal mode without a host that answers decisions", async () => {
		const t = setup();
		await t.call("POST", "/start", { timeoutMs: 60_000, sites: [] });
		expect(t.agent.decisionToken()).toBeUndefined();
		const ran = await t.call("POST", "/run", { goal: { goal: "search" }, model: "clef" });
		expect(ran.status).toBe(503);
		expect(t.agent.calls.some((call) => call.path === "/reflex/run")).toBe(false);
	});

	it("leaves cookie dialogs alone when declining them is switched off", async () => {
		const t = setup({ declineConsent: false });
		await t.call("POST", "/start", { timeoutMs: 60_000, sites: [] });
		await t.call("POST", "/act", { action: { kind: "click", element: "3" } });
		await t.call("GET", "/look");
		const bodies = t.agent.calls
			.filter((call) => call.path.startsWith("/reflex/"))
			.map((call) => JSON.parse(call.body) as unknown);
		expect(bodies).toEqual([{ verb: "click", element: "3" }, {}]);
		expect(["off", "OFF", "false", "0", "no"].map(declineConsentSetting)).toEqual([false, false, false, false, false]);
		expect([undefined, "", "on", "reject"].map(declineConsentSetting)).toEqual([true, true, true, true]);
	});

	it("says a busy page is still loading, not that the browser is gone, when a step or a screenshot times out", async () => {
		const t = setup({ busyPage: true, agentTimeoutMs: 50 });
		await t.call("POST", "/start", { timeoutMs: 60_000, sites: [] });
		const acted = await t.call("POST", "/act", { action: { kind: "wait" } });
		expect(acted.status).toBe(503);
		const actError = JSON.stringify(await acted.json());
		expect(actError).toContain("The page did not answer within");
		expect(actError).toContain("it may still be loading. The browser is still open");
		const shot = await t.call("GET", "/screenshot");
		expect(shot.status).toBe(503);
		expect(JSON.stringify(await shot.json())).toContain("it may still be loading. The browser is still open");
	});

	it("moves closed chunks into the blob store, sealed, and serves them back", async () => {
		const t = setup();
		await t.call("POST", "/start", { timeoutMs: 60_000, sites: [] });
		await t.coordinator.tick();
		const key = blobKeys.chunk("b1", "1", 0);
		expect(t.blobs.keys()).toContain(key);
		// Sealed: what is stored is not the chunk.
		expect([...t.blobs.raw(key)].slice(0, 4)).not.toEqual([1, 2, 3, 4]);
		const chunk = await t.call("GET", "/recording/1/0");
		expect(new Uint8Array(await chunk.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
		// The agent's copy is deleted once stored.
		expect(t.agent.calls.some((call) => call.method === "DELETE" && call.path === "/recording/1/00000.mkv")).toBe(true);
	});

	it("on release, stops the recording, drains the last chunk, saves the profile and stops the container", async () => {
		const t = setup();
		await t.call("POST", "/start", { timeoutMs: 60_000, sites: [], contextId: "ctx-1", persist: true });
		await t.call("POST", "/release");
		expect(t.agent.running()).toBe(false);
		const manifest = (await (await t.call("GET", "/recording")).json()) as RecordingManifest;
		expect(manifest).toMatchObject({ status: "complete", browserId: "b1" });
		expect(manifest.pages[0]).toMatchObject({ pageId: "1", startMs: 500, width: 1280 });
		expect(manifest.pages[0]!.chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
		// Where the page went, for the replay's address bar: only well-formed entries are kept.
		expect(manifest.pages[0]!.navigations).toEqual([
			{ atMs: 0, url: "about:blank" },
			{ atMs: 1_200, url: "https://example.com/", title: "Example Domain" },
		]);
		const profileKey = blobKeys.context("ctx-1");
		expect(t.blobs.keys()).toContain(profileKey);
		expect(await t.sealer.open(profileKey, t.blobs.raw(profileKey))).toEqual(new Uint8Array([9, 9, 9]));
		expect(await (await t.call("GET", "/status")).json()).toMatchObject({ status: "ended", endReason: "closed" });
		// Steps on an ended browser are refused, not sent.
		expect((await t.call("POST", "/act", { action: { kind: "scroll" } })).status).toBe(410);
	});

	it("restores a saved profile into the next browser on the same context", async () => {
		const blobs = memoryBlobs();
		const first = setup({ blobs });
		await first.call("POST", "/start", { timeoutMs: 60_000, sites: [], contextId: "ctx-1", persist: true });
		await first.call("POST", "/release");
		const second = setup({ blobs });
		await second.call("POST", "/start", { timeoutMs: 60_000, sites: [], contextId: "ctx-1", persist: false });
		expect(second.agent.profile()).toEqual(new Uint8Array([9, 9, 9]));
		await second.call("POST", "/release");
		// A browser that doesn't persist exports nothing.
		expect(second.agent.calls.some((call) => call.path === "/export")).toBe(false);
	});

	it("ends a browser at its timeout on the next tick", async () => {
		const t = setup();
		await t.call("POST", "/start", { timeoutMs: 10_000, sites: [] });
		t.advance(10_001);
		await t.coordinator.tick();
		expect(t.agent.running()).toBe(false);
		expect(await t.coordinator.state()).toMatchObject({ status: "ended", endReason: "timeout" });
		expect(await t.coordinator.agentHeaders()).toBeUndefined();
	});

	it("refuses a recording past its retention", async () => {
		const t = setup();
		await t.call("POST", "/start", { timeoutMs: 60_000, sites: [] });
		await t.call("POST", "/release");
		t.advance(60_001);
		expect((await t.call("GET", "/recording")).status).toBe(410);
		expect((await t.call("GET", "/recording/1/0")).status).toBe(410);
	});
});

describe("kantel browser provider", () => {
	const views = createBrowserViewSigner(VIEW_KEY);
	const withHost = () => {
		const t = setup();
		const provider = createKantelBrowserProvider({
			host: { fetch: (_id, path, init) => t.coordinator.handle(new Request(`http://browser${path}`, init)) },
			views,
			viewBase: "/browser",
			now: t.now,
			newId: () => "b1",
		});
		return { t, provider };
	};

	it("runs a goal through the coordinator and reads how it ended, its steps and its hand-back", async () => {
		const t = setup({ decisions: { url: "http://192.0.2.10/decide" } });
		const provider = createKantelBrowserProvider({
			host: { fetch: (_id, path, init) => t.coordinator.handle(new Request(`http://browser${path}`, init)) },
			views,
			viewBase: "/browser",
			now: t.now,
			newId: () => "b1",
		});
		await provider.open({
			providerContextId: "ctx-1",
			persist: false,
			timeoutMs: 60_000,
			allowedSites: ["example.com"],
		});
		const result = await provider.run!("b1", { goal: "search flights" }, { model: "clef" });
		expect(result).toMatchObject({
			status: "needs_supervisor",
			steps: ["filled “From” with from", "no change"],
			handBack: { reason: "low_confidence", detail: "Which day?", candidates: [{ id: "7", p: 0.43 }] },
			page: { url: "https://example.com/", succeeded: true },
			usage: { decisions: 4, ms: 3211 },
		});
	});

	it("opens a browser on the grant's sites and acts on it", async () => {
		const { t, provider } = withHost();
		const opened = await provider.open({
			providerContextId: "ctx-1",
			persist: false,
			timeoutMs: 60_000,
			allowedSites: ["example.com"],
		});
		expect(opened.providerSessionId).toBe("b1");
		expect(JSON.parse(t.agent.calls.find((call) => call.path === "/domains")!.body)).toEqual({
			domains: ["example.com"],
		});
		const page = await provider.act("b1", { kind: "click", element: "2" });
		expect(page).toMatchObject({ url: "https://example.com/", succeeded: true, did: "Clicked" });
		const shot = await provider.screenshot("b1");
		expect(shot).toMatchObject({ mimeType: "image/jpeg", url: "https://example.com/" });
	});

	it("guards a Google grant's browser with Google's consent host for the same country too", async () => {
		const { t, provider } = withHost();
		await provider.open({
			providerContextId: "ctx-1",
			persist: false,
			timeoutMs: 60_000,
			allowedSites: ["www.google.co.uk", "www.kayak.co.uk"],
		});
		expect(JSON.parse(t.agent.calls.find((call) => call.path === "/domains")!.body)).toEqual({
			domains: ["www.google.co.uk", "www.kayak.co.uk", "consent.google.co.uk"],
		});
	});

	it("makes view links with the token in the fragment, never past the browser's end", async () => {
		const { provider } = withHost();
		await provider.open({ providerContextId: "ctx-1", persist: false, timeoutMs: 120_000 });
		const link = await provider.share("b1", 30, undefined, { control: false });
		const [path, token] = link.url.split("#");
		expect(path).toBe("/browser/b1");
		expect(await views.verify(token!, 1_000_000)).toMatchObject({ browser: "b1", mode: "live", control: false });
		expect(link.expiresAt).toBe(1_000_000 + 120_000);
		// The view page embeds as it is, and says when its stream is over.
		expect(link.embed).toEqual({ url: link.url, endMessage: KANTEL_VIEW_END_MESSAGE });
	});

	it("makes a replay link once the browser has ended, and refuses one with no recording", async () => {
		const { provider } = withHost();
		await provider.open({ providerContextId: "ctx-1", persist: false, timeoutMs: 60_000 });
		await expect(provider.share("b1", 5)).resolves.toBeDefined();
		const released = await provider.release("b1");
		// What was stored, as counts, for the broker's `browser.recording.stored`.
		expect(released).toEqual({
			recording: {
				pages: 1,
				frames: expect.any(Number),
				durationMs: expect.any(Number),
				expiresAt: expect.any(Number),
			},
		});
		expect(released?.recording?.frames).toBeGreaterThan(0);
		await expect(provider.share("b1", 5)).rejects.toMatchObject({ code: "expired" });
		const replay = await provider.replay!("b1", 10);
		expect(await views.verify(replay.url.split("#")[1]!, 1_000_000)).toMatchObject({ mode: "replay", control: false });
		// Released twice is still released, and says the same.
		await expect(provider.release("b1")).resolves.toEqual(released);
	});

	it("is chosen only by KANTEL_BROWSER_PROVIDER=kantel", () => {
		expect(browserProviderName("kantel")).toBe("kantel");
		expect(browserProviderName(" HARBOUR ")).toBe("kantel");
		for (const value of [undefined, "", "brwsr", "harbor"]) expect(browserProviderName(value)).toBe("brwsr");
	});
});

describe("view tokens and the view handler", () => {
	const views = createBrowserViewSigner(VIEW_KEY);
	const claims = { browser: "b1", mode: "replay" as const, control: false, expiresAt: 2_000_000 };

	it("verifies its own tokens until they expire, and nothing forged", async () => {
		const token = await views.sign(claims);
		expect(await views.verify(token, 1_999_999)).toEqual(claims);
		expect(await views.verify(token, 2_000_000)).toBeUndefined();
		const [body, signature] = token.split(".");
		const forged = btoa(JSON.stringify({ b: "b2", m: "live", c: 1, e: 9e12 })).replace(/=+$/, "");
		expect(await views.verify(`${forged}.${signature}`, 0)).toBeUndefined();
		expect(await views.verify(`${body}.${signature}x`, 0)).toBeUndefined();
		expect(await createBrowserViewSigner(`${VIEW_KEY}-other`).verify(token, 0)).toBeUndefined();
		expect(() => createBrowserViewSigner("short")).toThrow(KantelError);
	});

	it("reads the token from a bearer header or the live socket's subprotocol, never the URL", async () => {
		const token = await views.sign(claims);
		const bearer = new Request("http://h/v1/browser/view/b1", { headers: { authorization: `Bearer ${token}` } });
		expect(viewTokenOf(bearer)).toBe(token);
		const socket = new Request("http://h/v1/browser/view/b1/live", {
			headers: { "sec-websocket-protocol": `harbour-view.v1, ${VIEW_TOKEN_PROTOCOL}${token}` },
		});
		expect(viewTokenOf(socket)).toBe(token);
		expect(viewTokenOf(new Request(`http://h/v1/browser/view/b1?token=${token}`))).toBeUndefined();
	});

	const host = (answers: { [path: string]: Response }) => ({
		fetch: async (_id: string, path: string) => answers[path]?.clone() ?? new Response("{}", { status: 404 }),
	});
	const ask = async (path: string, token: string | undefined, init: RequestInit = {}, answers = {}) =>
		handleBrowserView(
			new Request(`http://h${path}`, {
				...init,
				headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...init.headers },
			}),
			{ views, host: host(answers), now: () => 1_000_000 },
		);

	it("refuses a token for another browser than the path's", async () => {
		const token = await views.sign(claims);
		expect((await ask("/v1/browser/view/b2/recording", token)).response?.status).toBe(401);
		expect((await ask("/v1/browser/view/b1/recording", undefined)).response?.status).toBe(401);
	});

	it("serves a replay token the recording and not the live socket", async () => {
		const token = await views.sign(claims);
		const answers = { "/recording": Response.json({ status: "complete" }), "/recording/1/0": new Response("mkv") };
		const manifest = await ask("/v1/browser/view/b1/recording", token, {}, answers);
		expect(manifest.response?.status).toBe(200);
		expect(manifest.response?.headers.get("cache-control")).toBe("no-store");
		const chunk = await ask("/v1/browser/view/b1/recording/1/0", token, {}, answers);
		expect(await chunk.response?.text()).toBe("mkv");
		expect(chunk.response?.headers.get("vary")).toBe("authorization");
		const live = await ask("/v1/browser/view/b1/live", token, { headers: { upgrade: "websocket" } });
		expect(live.response?.status).toBe(403);
	});

	it("gives a live token the socket with only the live view's own parameters", async () => {
		const token = await views.sign({ ...claims, mode: "live", control: false });
		const live = await ask("/v1/browser/view/b1/live?w=800&h=600&cdp=1&quality=bad%20value", token, {
			headers: { upgrade: "websocket" },
		});
		expect(live.live?.path).toBe("/live?v=2&w=800&h=600");
		expect(live.live?.claims.control).toBe(false);
		expect((await ask("/v1/browser/view/b1/recording", token)).response?.status).toBe(403);
	});

	it("reads views with GET only", async () => {
		const token = await views.sign(claims);
		expect((await ask("/v1/browser/view/b1/recording", token, { method: "POST" })).response?.status).toBe(405);
	});
});

describe("the live pipe", () => {
	it("lets a watch-only viewer's acks and canvas size through, and no input", () => {
		expect(watchMessage('{"type":"ack"}')).toBe('{"type":"ack"}');
		expect(watchMessage('{"type":"ack","x":1}')).toBe('{"type":"ack"}');
		expect(watchMessage('{"type":"size","w":800,"h":600,"extra":"x"}')).toBe('{"type":"size","w":800,"h":600}');
		for (const input of [
			'{"type":"mouse","x":1,"y":2}',
			'{"type":"key","key":"a"}',
			'{"type":"size","w":"800","h":600}',
			"not json",
			new ArrayBuffer(4),
			`{"type":"ack","pad":"${"x".repeat(300)}"}`,
		]) {
			expect(watchMessage(input)).toBeNull();
		}
	});

	class Socket implements PipeSocket {
		sent: unknown[] = [];
		closed?: { code?: number; reason?: string };
		readonly listeners: { [type: string]: ((event: never) => void)[] } = {};
		send(data: unknown) {
			this.sent.push(data);
		}
		close(code?: number, reason?: string) {
			this.closed ??= { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
		}
		addEventListener(type: string, listener: (event: never) => void) {
			const list = this.listeners[type] ?? [];
			list.push(listener);
			this.listeners[type] = list;
		}
		emit(type: string, event: unknown) {
			for (const listener of this.listeners[type] ?? []) (listener as (event: unknown) => void)(event);
		}
	}
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("forwards frames down, filters a watch-only viewer's messages up, and closes both with either", async () => {
		const up = new Socket();
		const down = new Socket();
		pipeLive(up, down, { control: false, expiresAt: Date.now() + 60_000 });
		const frame = new Uint8Array([1, 2, 3]).buffer;
		up.emit("message", { data: frame });
		down.emit("message", { data: '{"type":"mouse","x":1}' });
		down.emit("message", { data: '{"type":"ack"}' });
		await settle();
		expect(down.sent).toEqual([frame]);
		expect(up.sent).toEqual(['{"type":"ack"}']);
		up.emit("close", { code: 1006, reason: "" });
		expect(down.closed?.code).toBe(1001);
		expect(up.closed).toBeDefined();
	});

	it("lets a control link's input through", async () => {
		const up = new Socket();
		const down = new Socket();
		pipeLive(up, down, { control: true, expiresAt: Date.now() + 60_000 });
		down.emit("message", { data: '{"type":"mouse","x":1}' });
		await settle();
		expect(up.sent).toEqual(['{"type":"mouse","x":1}']);
	});

	it("closes both when the token expires", async () => {
		const up = new Socket();
		const down = new Socket();
		pipeLive(up, down, { control: false, expiresAt: Date.now() + 20 });
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(down.closed?.code).toBe(CLOSE_EXPIRED);
		expect(up.closed).toBeDefined();
	});
});

describe("sealing", () => {
	it("opens only what it sealed, under the same name", async () => {
		const sealer = createSealer(SEAL_KEY);
		const sealed = await sealer.seal("contexts/a.tgz", new Uint8Array([1, 2, 3]));
		expect(await sealer.open("contexts/a.tgz", sealed)).toEqual(new Uint8Array([1, 2, 3]));
		await expect(sealer.open("contexts/b.tgz", sealed)).rejects.toThrow();
		await expect(createSealer(`${SEAL_KEY}-other`).open("contexts/a.tgz", sealed)).rejects.toThrow();
	});

	it("keeps the runtime's blobs under their prefix", async () => {
		const blobs = memoryBlobs();
		const prefixed = prefixedBlobs(blobs, "browser/");
		await prefixed.put("recordings/b1/manifest.json", new Uint8Array([1]));
		expect(blobs.keys()).toEqual(["browser/recordings/b1/manifest.json"]);
		expect(await prefixed.get("recordings/b1/manifest.json")).toEqual(new Uint8Array([1]));
	});
});
