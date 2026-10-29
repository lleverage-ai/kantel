import { BRWSR_MAX_TIMEOUT_S, createBrwsrProvider } from "@harbour/browser/brwsr";
import { isHarbourError } from "@harbour/contracts";
import { describe, expect, it } from "vitest";

const KEY = "bb_test_key_never_returned";
const CONNECT_URL = "wss://connect.brwsr.test/sessions/s-1?token=session-scoped";

interface Seen {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
	readonly key: string | null;
}

/** A brwsr API: answers each request with the first matching route's reply. */
function fakeApi(routes: readonly [method: string, path: string | RegExp, status: number, body: unknown][]) {
	const seen: Seen[] = [];
	const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
		const url = new URL(input);
		const path = `${url.pathname}${url.search}`;
		const method = init?.method ?? "GET";
		seen.push({
			method,
			path,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			key: new Headers(init?.headers).get("x-bb-api-key"),
		});
		const route = routes.find(([m, p]) => m === method && (typeof p === "string" ? p === path : p.test(path)));
		if (route === undefined) return new Response(JSON.stringify({ message: "no route" }), { status: 501 });
		return new Response(route[3] === undefined ? "" : JSON.stringify(route[3]), { status: route[2] });
	};
	return { fetch, seen };
}

/** A CDP endpoint over a fake socket: one page, attachable, screenshots as `data`. */
function fakeCdp(pages: readonly { targetId: string; url: string; title: string }[]) {
	const sent: { method: string; sessionId?: string }[] = [];
	let closed = false;
	const factory = (url: string): WebSocket => {
		expect(url).toBe(CONNECT_URL);
		const listeners = new Map<string, Set<(event: { data?: string }) => void>>();
		const dispatch = (type: string, event: { data?: string } = {}) => {
			for (const listener of listeners.get(type) ?? []) listener(event);
		};
		const socket = {
			addEventListener(type: string, listener: (event: { data?: string }) => void) {
				listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
			},
			removeEventListener(type: string, listener: (event: { data?: string }) => void) {
				listeners.get(type)?.delete(listener);
			},
			send(data: string) {
				const message = JSON.parse(data) as { id: number; method: string; sessionId?: string };
				sent.push({
					method: message.method,
					...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
				});
				const result =
					message.method === "Target.getTargets"
						? { targetInfos: pages.map((page) => ({ ...page, type: "page" })) }
						: message.method === "Target.attachToTarget"
							? { sessionId: "cdp-page-session" }
							: message.method === "Page.captureScreenshot"
								? { data: "SlBFRw==" }
								: {};
				queueMicrotask(() => dispatch("message", { data: JSON.stringify({ id: message.id, result }) }));
			},
			close() {
				closed = true;
			},
		};
		queueMicrotask(() => dispatch("open"));
		return socket as unknown as WebSocket;
	};
	return { factory, sent, closed: () => closed };
}

describe("the brwsr provider", () => {
	it("opens a keepAlive session on the grant's context, with brwsr's timeout bounds, and returns its CDP URL", async () => {
		const api = fakeApi([["POST", "/v1/sessions", 201, { id: "s-1", connectUrl: CONNECT_URL, signingKey: "sk" }]]);
		const provider = createBrwsrProvider({
			apiKey: KEY,
			apiUrl: "https://api.brwsr.test/",
			fetch: api.fetch,
			userMetadata: { agent: "harbour" },
		});
		expect(await provider.open({ providerContextId: "ctx-1", persist: true, timeoutMs: 90_500 })).toEqual({
			providerSessionId: "s-1",
			cdpUrl: CONNECT_URL,
		});
		await provider.open({ providerContextId: "ctx-1", persist: false, timeoutMs: 1_000 });
		await provider.open({ providerContextId: "ctx-1", persist: false, timeoutMs: 24 * 3600_000 });
		expect(api.seen.map((request) => request.body)).toEqual([
			{
				keepAlive: true,
				timeout: 91,
				browserSettings: { context: { id: "ctx-1", persist: true } },
				userMetadata: { agent: "harbour" },
			},
			expect.objectContaining({ timeout: 60, browserSettings: { context: { id: "ctx-1", persist: false } } }),
			expect.objectContaining({ timeout: BRWSR_MAX_TIMEOUT_S }),
		]);
		expect(api.seen.every((request) => request.key === KEY)).toBe(true);
	});

	it("maps brwsr's refusals: a held persisting context is conflict, a full project exhausted, a bad key unavailable", async () => {
		for (const [status, code] of [
			[409, "conflict"],
			[429, "exhausted"],
			[401, "unavailable"],
			[400, "invalid"],
			[500, "unavailable"],
		] as const) {
			const api = fakeApi([["POST", "/v1/sessions", status, { statusCode: status, message: `nope ${status}` }]]);
			const provider = createBrwsrProvider({ apiKey: KEY, fetch: api.fetch });
			const error = await provider
				.open({ providerContextId: "ctx-1", persist: true, timeoutMs: 60_000 })
				.catch((caught: unknown) => caught);
			expect(isHarbourError(error, code), `${status}`).toBe(true);
			expect(String((error as Error).message)).not.toContain(KEY);
		}
	});

	it("releases with REQUEST_RELEASE and treats a session already gone as released", async () => {
		const api = fakeApi([
			["POST", "/v1/sessions/s-1", 200, { id: "s-1", status: "COMPLETED" }],
			["POST", "/v1/sessions/gone", 404, { message: "Session not found" }],
			["POST", "/v1/sessions/down", 503, { message: "busy" }],
		]);
		const provider = createBrwsrProvider({ apiKey: KEY, fetch: api.fetch });
		await provider.release("s-1");
		await provider.release("gone");
		await expect(provider.release("down")).rejects.toMatchObject({ code: "unavailable" });
		expect(api.seen[0]).toMatchObject({
			method: "POST",
			path: "/v1/sessions/s-1",
			body: { status: "REQUEST_RELEASE" },
		});
	});

	it("runs each step as one model-free Reflex verb and reads the page back", async () => {
		const page = {
			url: "https://example.com/",
			title: "Example Domain",
			text: "Example text",
			elements: [{ id: 7, describe: "link “Learn more”" }, { describe: "no id" }],
		};
		const api = fakeApi([
			["GET", "/brwsr/v1/sessions/s-1/reflex/look", 200, { pageId: "P", ...page }],
			["POST", "/brwsr/v1/sessions/s-1/reflex/act", 200, { success: true, did: "did it", page, pageId: "P" }],
		]);
		const provider = createBrwsrProvider({ apiKey: KEY, fetch: api.fetch });
		const looked = await provider.act("s-1", { kind: "look" });
		expect(looked).toEqual({
			url: "https://example.com/",
			title: "Example Domain",
			text: "Example text",
			elements: [{ id: "7", describe: "link “Learn more”" }],
			succeeded: true,
		});
		for (const action of [
			{ kind: "goto", url: "https://example.com/" },
			{ kind: "click", element: "7" },
			{ kind: "fill", element: "3", value: "Tom" },
			{ kind: "select", element: "4", value: "UK" },
			{ kind: "check", element: "5" },
			{ kind: "press", key: "Enter" },
			{ kind: "scroll" },
			{ kind: "wait" },
		] as const) {
			expect(await provider.act("s-1", action)).toMatchObject({ succeeded: true, did: "did it" });
		}
		expect(api.seen.slice(1).map((request) => request.body)).toEqual([
			{ verb: "goto", url: "https://example.com/" },
			{ verb: "click", element: "7" },
			{ verb: "fill", element: "3", value: "Tom" },
			{ verb: "select", element: "4", value: "UK" },
			{ verb: "check", element: "5" },
			{ verb: "press", key: "Enter" },
			{ verb: "scroll" },
			{ verb: "wait" },
		]);
	});

	it("reads the page with look when a step's reply has none, and says the step failed", async () => {
		const api = fakeApi([
			["POST", "/brwsr/v1/sessions/s-1/reflex/act", 200, { success: false, did: null, page: null }],
			[
				"GET",
				"/brwsr/v1/sessions/s-1/reflex/look",
				200,
				{ url: "https://example.com/", title: "", text: "", elements: [] },
			],
		]);
		const provider = createBrwsrProvider({ apiKey: KEY, fetch: api.fetch });
		expect(await provider.act("s-1", { kind: "click", element: "9" })).toEqual({
			url: "https://example.com/",
			title: "",
			text: "",
			elements: [],
			succeeded: false,
		});
	});

	it("treats a session brwsr no longer runs as expired", async () => {
		const api = fakeApi([
			["POST", "/brwsr/v1/sessions/s-1/reflex/act", 409, { message: "Session is not running" }],
			["GET", "/v1/sessions/s-1", 200, { id: "s-1", status: "COMPLETED", connectUrl: CONNECT_URL }],
			["POST", "/brwsr/v1/sessions/s-1/shares", 404, { message: "Session not found" }],
		]);
		const provider = createBrwsrProvider({ apiKey: KEY, fetch: api.fetch });
		await expect(provider.act("s-1", { kind: "wait" })).rejects.toMatchObject({ code: "expired" });
		await expect(provider.screenshot("s-1")).rejects.toMatchObject({ code: "expired" });
		await expect(provider.share("s-1", 15)).rejects.toMatchObject({ code: "expired" });
	});

	it("screenshots the first page that is not blank over CDP and disconnects", async () => {
		const api = fakeApi([["GET", "/v1/sessions/s-1", 200, { id: "s-1", status: "RUNNING", connectUrl: CONNECT_URL }]]);
		const cdp = fakeCdp([
			{ targetId: "T0", url: "about:blank", title: "" },
			{ targetId: "T1", url: "https://example.com/", title: "Example Domain" },
		]);
		const provider = createBrwsrProvider({ apiKey: KEY, fetch: api.fetch, webSocket: cdp.factory });
		expect(await provider.screenshot("s-1")).toEqual({
			url: "https://example.com/",
			title: "Example Domain",
			mimeType: "image/jpeg",
			data: "SlBFRw==",
		});
		expect(cdp.sent).toEqual([
			{ method: "Target.getTargets" },
			{ method: "Target.attachToTarget" },
			{ method: "Page.captureScreenshot", sessionId: "cdp-page-session" },
		]);
		expect(cdp.closed()).toBe(true);
	});

	it("makes a share link with control and reads its expiry", async () => {
		const api = fakeApi([
			[
				"POST",
				"/brwsr/v1/sessions/s-1/shares",
				201,
				{ url: "https://brwsr.dev/s/abc", expiresAt: "2026-10-29T00:15:00.000Z" },
			],
		]);
		const provider = createBrwsrProvider({ apiKey: KEY, fetch: api.fetch });
		expect(await provider.share("s-1", 60)).toEqual({
			url: "https://brwsr.dev/s/abc",
			expiresAt: Date.parse("2026-10-29T00:15:00.000Z"),
		});
		expect(api.seen[0]?.body).toEqual({ control: true, minutes: 60 });
	});

	it("makes a watch-only share link when asked for no control", async () => {
		const api = fakeApi([["POST", "/brwsr/v1/sessions/s-1/shares", 201, { url: "https://brwsr.dev/s/def" }]]);
		const provider = createBrwsrProvider({ apiKey: KEY, fetch: api.fetch });
		expect(await provider.share("s-1", 60, undefined, { control: false })).toEqual({ url: "https://brwsr.dev/s/def" });
		expect(api.seen[0]?.body).toEqual({ control: false, minutes: 60 });
	});

	it("finds a context by name, or makes it, and looks again when another caller made it first", async () => {
		const found = fakeApi([["GET", "/v1/contexts?name=sal", 200, [{ id: "ctx-sal", name: "sal" }]]]);
		expect(await createBrwsrProvider({ apiKey: KEY, fetch: found.fetch }).contextId("sal")).toBe("ctx-sal");

		const made = fakeApi([
			["GET", "/v1/contexts?name=harbour-test", 200, []],
			["POST", "/v1/contexts", 201, { id: "ctx-new", name: "harbour-test" }],
		]);
		expect(await createBrwsrProvider({ apiKey: KEY, fetch: made.fetch }).contextId("harbour-test")).toBe("ctx-new");

		let lookups = 0;
		const raced = fakeApi([
			["POST", "/v1/contexts", 409, { message: "A context with that name exists" }],
			["GET", /^\/v1\/contexts\?name=raced$/, 200, []],
		]);
		const racedFetch = async (input: string, init?: RequestInit) => {
			if ((init?.method ?? "GET") === "GET") {
				lookups += 1;
				if (lookups === 2) return new Response(JSON.stringify([{ id: "ctx-raced" }]), { status: 200 });
			}
			return raced.fetch(input, init);
		};
		expect(await createBrwsrProvider({ apiKey: KEY, fetch: racedFetch }).contextId("raced")).toBe("ctx-raced");
	});

	it("refuses to start without a key and reports an unreachable brwsr as unavailable", async () => {
		expect(() => createBrwsrProvider({ apiKey: " " })).toThrow();
		const provider = createBrwsrProvider({
			apiKey: KEY,
			fetch: async () => {
				throw new TypeError(`fetch failed for ${KEY}`);
			},
		});
		const error = await provider.release("s-1").catch((caught: unknown) => caught);
		expect(isHarbourError(error, "unavailable")).toBe(true);
		expect(String((error as Error).message)).not.toContain(KEY);
	});
});
