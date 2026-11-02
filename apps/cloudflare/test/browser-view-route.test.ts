// The Worker's routing of view links to Kantel's own browsers (src/route.ts): the token is checked before any object
// is asked, for the browser its path names, and only then is the request sent on, to that browser's object or to a
// self-hosted browser host.
import { createBrowserViewSigner } from "@kantel/browser/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeRequest } from "../src/route.ts";

const BASE = "https://kantel.test";
const VIEW_KEY = "test-browser-view-key-0123456789abcdef";
const views = createBrowserViewSigner(VIEW_KEY);
const token = (browser: string, expiresAt = Date.now() + 60_000) =>
	views.sign({ browser, mode: "replay", control: false, expiresAt });

function namespace(seen: string[]) {
	return {
		idFromName: (name: string) => name,
		get: (id: string) => ({
			fetch: async (request: Request) => {
				seen.push(`${id} ${new URL(request.url).pathname}`);
				return new Response(null, { status: 204 });
			},
		}),
	};
}

function env(seen: string[], extra: { [key: string]: unknown } = {}) {
	return {
		STACK: namespace([]),
		VAULTS: namespace([]),
		BROWSERS: namespace(seen),
		ASSETS: { fetch: async () => new Response(null, { status: 204 }) },
		KANTEL_BROWSER_VIEW_KEY: VIEW_KEY,
		...extra,
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("view links' routing", () => {
	it("sends a view with a good token to its browser's object", async () => {
		const seen: string[] = [];
		const response = await routeRequest(
			new Request(`${BASE}/v1/browser/view/b1/recording`, {
				headers: { authorization: `Bearer ${await token("b1")}` },
			}),
			env(seen),
		);
		expect(response.status).toBe(204);
		expect(seen).toEqual(["b1 /v1/browser/view/b1/recording"]);
	});

	it("asks no object for a view without a token, with an expired one, or with one for another browser", async () => {
		const seen: string[] = [];
		const ask = async (headers: { [name: string]: string }) =>
			(await routeRequest(new Request(`${BASE}/v1/browser/view/b1/recording`, { headers }), env(seen))).status;
		expect(await ask({})).toBe(401);
		expect(await ask({ authorization: `Bearer ${await token("b1", Date.now() - 1)}` })).toBe(401);
		expect(await ask({ authorization: `Bearer ${await token("b2")}` })).toBe(401);
		expect(await ask({ authorization: "Bearer not.a-token" })).toBe(401);
		expect(seen).toEqual([]);
	});

	it("refuses every view when the Worker has no view key", async () => {
		const seen: string[] = [];
		const response = await routeRequest(
			new Request(`${BASE}/v1/browser/view/b1`, { headers: { authorization: `Bearer ${await token("b1")}` } }),
			env(seen, { KANTEL_BROWSER_VIEW_KEY: "" }),
		);
		expect(response.status).toBe(401);
		expect(seen).toEqual([]);
	});

	it("sends a view to a self-hosted browser host with its token and nothing else of the viewer's", async () => {
		const sent: { url: string; headers: Headers }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			sent.push({ url, headers: new Headers(init.headers) });
			return new Response(null, { status: 204 });
		});
		const good = await token("b1");
		await routeRequest(
			new Request(`${BASE}/v1/browser/view/b1/recording/1/0`, {
				headers: { authorization: `Bearer ${good}`, cookie: "session=secret", "cf-access-jwt-assertion": "jwt" },
			}),
			env([], { BROWSERS: undefined, KANTEL_BROWSER_HOST_URL: "http://browsers.internal:8790/" }),
		);
		expect(sent.map((each) => each.url)).toEqual(["http://browsers.internal:8790/v1/browser/view/b1/recording/1/0"]);
		expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${good}`);
		expect(sent[0]?.headers.get("cookie")).toBeNull();
		expect(sent[0]?.headers.get("cf-access-jwt-assertion")).toBeNull();
	});
});

describe("the viewer page", () => {
	const page = (extra: { [key: string]: unknown } = {}) =>
		env([], {
			ASSETS: {
				fetch: async () =>
					new Response("<html></html>", {
						headers: { "content-type": "text/html", etag: '"v1"', "x-frame-options": "DENY" },
					}),
			},
			...extra,
		});

	it("is never cached or sent with a referrer, and only the console frames it by default", async () => {
		const response = await routeRequest(new Request(`${BASE}/browser/b1`), page());
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("<html></html>");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
		expect(response.headers.get("x-frame-options")).toBeNull();
		expect(response.headers.get("etag")).toBeNull();
	});

	it("may be framed by the origins KANTEL_EMBED_ORIGINS names, and nothing looser", async () => {
		const response = await routeRequest(
			new Request(`${BASE}/browser/b1`),
			page({
				KANTEL_EMBED_ORIGINS:
					"https://app.lleverage.ai, http://localhost:5173 https://*.evil.test http://plain.test https://x.test/path",
			}),
		);
		expect(response.headers.get("content-security-policy")).toBe(
			"frame-ancestors 'self' https://app.lleverage.ai http://localhost:5173",
		);
	});

	it("leaves the console's other pages as they are", async () => {
		const response = await routeRequest(new Request(`${BASE}/sessions/s1`), page());
		expect(response.headers.get("content-security-policy")).toBeNull();
		expect(response.headers.get("etag")).toBe('"v1"');
	});
});
