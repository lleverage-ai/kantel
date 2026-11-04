// Exposed ports through the gateway: a port's name answers only what was exposed, only with its token unless public,
// and the server in the sandbox sees the request as sent, less Kantel's token and cookie, over HTTP/1.1 on the port's
// stream. The cookie is `__Host-` and counts only from the port's own pages, the person, or the same sandbox's other
// ports (TASK-4887).
import v8 from "node:v8";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { PortSink, PortStream } from "../src/hub.ts";
import { proxyHttp, requestBytes } from "../src/port-http.ts";
import { createPortRouter, PORT_COOKIE, portCookieName } from "../src/ports.ts";
import { createMemoryRelayStore, type RelayStore } from "../src/relay-store.ts";
import { sha256Hex } from "../src/tunnel.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A port whose server answers each request with `reply(request text)`, in pieces of `chunk` bytes. */
function fakePort(reply: (request: string) => string | Uint8Array, chunk = 7) {
	const opened: { sandboxId: string; port: number; request: string }[] = [];
	const openPort = async (sandboxId: string, port: number, sink: PortSink): Promise<PortStream> => {
		const entry = { sandboxId, port, request: "" };
		opened.push(entry);
		return {
			stream: opened.length,
			write(bytes) {
				entry.request += decoder.decode(bytes);
				const answer = reply(entry.request);
				const out = typeof answer === "string" ? encoder.encode(answer) : answer;
				queueMicrotask(() => {
					for (let at = 0; at < out.length; at += chunk) sink.data(out.slice(at, at + chunk));
					sink.end("closed");
				});
			},
			close() {},
		};
	};
	return { openPort, opened };
}

const OK =
	"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\nhello";

describe("an exposed port's name", () => {
	const setup = (
		reply: (request: string) => string = () => OK,
		options: { store?: RelayStore; stillAllowed?: (grantee: string | undefined) => Promise<boolean> } = {},
	) => {
		const port = fakePort(reply);
		const store = options.store ?? createMemoryRelayStore();
		const router = createPortRouter({
			domain: "kantel-ports.test",
			openPort: port.openPort,
			store,
			...(options.stillAllowed === undefined ? {} : { stillAllowed: options.stillAllowed }),
		});
		return { router, store, ...port };
	};

	it("keeps its exposures in the store, a token only as its hash, so another gateway over it serves them", async () => {
		const { router, store } = setup();
		const { url } = await router.expose("sbx_1", 3000, { public: false, subdomain: "brave-otter-ab12cd" });
		const token = new URL(url).searchParams.get("_token") ?? "";
		const [row] = await store.exposuresOf("sbx_1");
		expect(row).toMatchObject({ label: "3000-brave-otter-ab12cd", port: 3000, tokenHash: await sha256Hex(token) });
		expect(JSON.stringify(row)).not.toContain(token);
		const other = setup(undefined, { store });
		expect((await other.router.fetch(new Request(url)))?.status).toBe(303);
		const page = await other.router.fetch(
			new Request("https://3000-brave-otter-ab12cd.kantel-ports.test/", {
				headers: { cookie: `${PORT_COOKIE}=${token}` },
			}),
		);
		expect(page?.status).toBe(200);
		expect(other.opened).toHaveLength(1);
	});

	it("refuses a request with the right token once whoever exposed the port lost access", async () => {
		let allowed = true;
		const seen: (string | undefined)[] = [];
		const { router, opened } = setup(undefined, {
			stillAllowed: async (grantee) => {
				seen.push(grantee);
				return allowed;
			},
		});
		const grantee = JSON.stringify({ kind: "key", keyId: "key_1" });
		const { url } = await router.expose("sbx_1", 3000, { public: true, subdomain: "brave-otter-ab12cd", grantee });
		expect((await router.fetch(new Request(url)))?.status).toBe(200);
		allowed = false;
		expect((await router.fetch(new Request(url)))?.status).toBe(403);
		expect(await router.upgrade("3000-brave-otter-ab12cd.kantel-ports.test", "/", undefined, {})).toMatchObject({
			ok: false,
			status: 403,
		});
		expect(opened).toHaveLength(1);
		expect(seen).toEqual([grantee, grantee, grantee]);
	});

	it("is token-gated by default: no token or a wrong one never reaches the sandbox", async () => {
		const { router, opened } = setup();
		const { url } = await router.expose("sbx_1", 3000, { public: false, subdomain: "brave-otter-ab12cd" });
		expect(url).toMatch(/^https:\/\/3000-brave-otter-ab12cd\.kantel-ports\.test\/\?_token=[A-Za-z0-9_-]{43}$/);
		const bare = "https://3000-brave-otter-ab12cd.kantel-ports.test/";
		expect((await router.fetch(new Request(bare)))?.status).toBe(401);
		expect((await router.fetch(new Request(`${bare}?_token=wrong`)))?.status).toBe(401);
		const forged = new Request(bare, { headers: { cookie: `${PORT_COOKIE}=${"A".repeat(43)}` } });
		expect((await router.fetch(forged))?.status).toBe(401);
		expect(opened).toEqual([]);
	});

	it("trades the token for a cookie on that one name, then relays with the cookie", async () => {
		const { router, opened } = setup();
		const { url } = await router.expose("sbx_1", 3000, { public: false, subdomain: "brave-otter-ab12cd" });
		const token = new URL(url).searchParams.get("_token") ?? "";
		const first = await router.fetch(new Request(`${url}&page=2`));
		expect(first?.status).toBe(303);
		expect(first?.headers.get("location")).toBe("/?page=2");
		const cookie = first?.headers.get("set-cookie") ?? "";
		expect(PORT_COOKIE).toBe("__Host-kantel_port");
		expect(cookie).toBe(`__Host-kantel_port=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`);
		expect(cookie).not.toMatch(/Domain=/i);
		expect(opened).toEqual([]);

		const page = await router.fetch(
			new Request("https://3000-brave-otter-ab12cd.kantel-ports.test/?page=2", {
				headers: { cookie: `theme=dark; ${PORT_COOKIE}=${token}` },
			}),
			{ address: "203.0.113.9" },
		);
		expect(page?.status).toBe(200);
		expect(await page?.text()).toBe("hello");
		expect(page?.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
		const seen = opened[0]?.request ?? "";
		expect(opened[0]).toMatchObject({ sandboxId: "sbx_1", port: 3000 });
		expect(seen).toMatch(/^GET \/\?page=2 HTTP\/1\.1\r\nHost: 3000-brave-otter-ab12cd\.kantel-ports\.test\r\n/);
		expect(seen).toContain("Cookie: theme=dark\r\n");
		expect(seen).not.toContain(token);
		expect(seen).toContain("x-forwarded-for: 203.0.113.9\r\n");
		expect(seen).toContain("Connection: close\r\n\r\n");
	});

	it("passes a POST with the token in the query on without a redirect, the token taken off", async () => {
		const { router, opened } = setup();
		const { url } = await router.expose("sbx_1", 8080, { public: false, subdomain: "calm-heron-zz99yy" });
		const answer = await router.fetch(new Request(url, { method: "POST", body: "x=1" }));
		expect(answer?.status).toBe(200);
		expect(opened[0]?.request).toMatch(/^POST \/ HTTP\/1\.1\r\n/);
		expect(opened[0]?.request).toContain("Content-Length: 3\r\n");
		expect(opened[0]?.request.endsWith("\r\n\r\nx=1")).toBe(true);
	});

	it("answers anyone for a public port, and nothing for a name nobody exposed, a hidden port or a forgotten sandbox", async () => {
		const { router, opened } = setup();
		const { url } = await router.expose("sbx_1", 3000, { public: true, subdomain: "brave-otter-ab12cd" });
		expect(url).toBe("https://3000-brave-otter-ab12cd.kantel-ports.test/");
		expect((await router.fetch(new Request(url)))?.status).toBe(200);
		expect((await router.fetch(new Request("https://3001-brave-otter-ab12cd.kantel-ports.test/")))?.status).toBe(404);
		expect((await router.fetch(new Request("https://3000-someone-else.kantel-ports.test/")))?.status).toBe(404);
		expect((await router.fetch(new Request("https://a.b.kantel-ports.test/")))?.status).toBe(404);
		await router.hide("sbx_1", 3000);
		expect((await router.fetch(new Request(url)))?.status).toBe(404);
		await router.expose("sbx_1", 3000, { public: true, subdomain: "brave-otter-ab12cd" });
		await router.forget("sbx_1");
		expect((await router.fetch(new Request(url)))?.status).toBe(404);
		expect(opened).toHaveLength(1);
		// Any other name isn't the router's.
		expect(await router.fetch(new Request("https://kantel.test/v1/sandboxes"))).toBeUndefined();
		expect(await router.fetch(new Request("https://evilkantel-ports.test/"))).toBeUndefined();
	});

	it("ends a token when the port is exposed again or hidden", async () => {
		const { router } = setup();
		const first = (await router.expose("sbx_1", 3000, { public: false, subdomain: "brave-otter-ab12cd" })).url;
		const second = (await router.expose("sbx_1", 3000, { public: false, subdomain: "brave-otter-ab12cd" })).url;
		expect(second).not.toBe(first);
		expect((await router.fetch(new Request(first)))?.status).toBe(401);
		expect((await router.fetch(new Request(second)))?.status).toBe(303);
		await router.hide("sbx_1", 3000);
		expect((await router.fetch(new Request(second)))?.status).toBe(404);
	});

	it("lets a WebSocket upgrade through with the token, and no other", async () => {
		const { router } = setup();
		const { url } = await router.expose("sbx_1", 5173, { public: false, subdomain: "brave-otter-ab12cd" });
		const token = new URL(url).searchParams.get("_token") ?? "";
		const host = "5173-brave-otter-ab12cd.kantel-ports.test";
		expect(await router.upgrade(host, "/hmr", undefined, {})).toEqual({
			ok: false,
			status: 401,
			reason: "This port needs its token",
		});
		expect(await router.upgrade(host, "/hmr", `${PORT_COOKIE}=nope`, {})).toMatchObject({ ok: false, status: 401 });
		expect(await router.upgrade(host, "/hmr?x=1", `${PORT_COOKIE}=${token}`, {})).toEqual({
			ok: true,
			sandboxId: "sbx_1",
			port: 5173,
			path: "/hmr?x=1",
			host,
		});
		expect(await router.upgrade(`${host}:443`, `/hmr?_token=${token}`, undefined, {})).toMatchObject({
			ok: true,
			path: "/hmr",
		});
		expect(await router.upgrade("5174-brave-otter-ab12cd.kantel-ports.test", "/", undefined, {})).toMatchObject({
			status: 404,
		});
		expect(await router.upgrade("kantel.test", "/v1/hosts/connect", undefined, {})).toBeUndefined();
	});
});

describe("an exposed port's cookie", () => {
	const DOMAIN = "kantel-ports.test";
	const VICTIM = `https://3000-brave-otter-ab12cd.${DOMAIN}`;
	/** The same sandbox's frontend, on another port. */
	const FRONTEND = `https://5173-brave-otter-ab12cd.${DOMAIN}`;
	/** Another sandbox's port: the same site to a browser, under the same domain. */
	const SIBLING = `https://5173-sly-fox-zz99yy.${DOMAIN}`;

	const setup = async (scheme: "https" | "http" = "https") => {
		const port = fakePort(() => OK);
		const router = createPortRouter({
			domain: DOMAIN,
			scheme,
			openPort: port.openPort,
			store: createMemoryRelayStore(),
		});
		const { url } = await router.expose("sbx_1", 3000, { public: false, subdomain: "brave-otter-ab12cd" });
		await router.expose("sbx_1", 5173, { public: false, subdomain: "brave-otter-ab12cd" });
		await router.expose("sbx_2", 5173, { public: false, subdomain: "sly-fox-zz99yy" });
		const token = new URL(url).searchParams.get("_token") ?? "";
		const cookie = `${portCookieName(scheme)}=${token}`;
		/** The status for a request to the victim's port with its cookie and `headers`. */
		const status = async (headers: Record<string, string>, init: RequestInit = {}) =>
			(await router.fetch(new Request(`${VICTIM}/api/me`, { ...init, headers: { cookie, ...headers } })))?.status;
		return { router, token, cookie, status, opened: port.opened };
	};

	it("isn't used by another sandbox's page for a fetch or XHR, an image or script, or a form post", async () => {
		const { status, opened } = await setup();
		// fetch() or XHR: same-site, with Origin.
		expect(await status({ "sec-fetch-site": "same-site", "sec-fetch-mode": "cors", origin: SIBLING })).toBe(401);
		expect(
			await status(
				{ "sec-fetch-site": "same-site", "sec-fetch-mode": "cors", origin: SIBLING },
				{ method: "POST", body: "{}" },
			),
		).toBe(401);
		// <img> or <script>: no Origin, a Referer, or neither.
		expect(await status({ "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", referer: `${SIBLING}/` })).toBe(
			401,
		);
		expect(await status({ "sec-fetch-site": "same-site", "sec-fetch-dest": "script" })).toBe(401);
		// A form posted to the victim's port as a top-level navigation: it changes something, so the cookie doesn't count.
		const form = { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
		expect(await status({ ...form, origin: SIBLING }, { method: "POST", body: "x=1" })).toBe(401);
		// A frame of the victim's port in the sibling's page.
		expect(await status({ ...form, "sec-fetch-dest": "iframe" })).toBe(401);
		// A browser without Sec-Fetch-* still sends Origin.
		expect(await status({ origin: SIBLING })).toBe(401);
		expect(opened).toEqual([]);
	});

	it("isn't used by another site, nor an opaque origin", async () => {
		const { status, opened } = await setup();
		expect(await status({ "sec-fetch-site": "cross-site", origin: "https://evil.example" })).toBe(401);
		expect(await status({ "sec-fetch-site": "cross-site", referer: "https://evil.example/page" })).toBe(401);
		expect(await status({ "sec-fetch-site": "cross-site" })).toBe(401);
		expect(await status({ origin: "null" })).toBe(401);
		// A look-alike name that isn't under the ports domain.
		expect(await status({ origin: `https://3000-brave-otter-ab12cd.evil${DOMAIN}` })).toBe(401);
		expect(opened).toEqual([]);
	});

	it("is used by the port's own pages, the person, and the same sandbox's other ports", async () => {
		const { status, opened } = await setup();
		// The port's own page: fetch, XHR, a form.
		expect(await status({ "sec-fetch-site": "same-origin", origin: VICTIM }, { method: "POST", body: "{}" })).toBe(200);
		expect(await status({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" })).toBe(200);
		// A typed URL or a bookmark.
		expect(await status({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })).toBe(
			200,
		);
		// A link followed from anywhere (SameSite=Lax would send it too): a GET that changes nothing.
		const link = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
		expect(await status({ ...link, "sec-fetch-site": "same-site" })).toBe(200);
		expect(await status({ ...link, "sec-fetch-site": "cross-site" })).toBe(200);
		// The same sandbox's frontend on another port calling this one: by Origin, or Referer for an <img>.
		expect(await status({ "sec-fetch-site": "same-site", origin: FRONTEND }, { method: "POST", body: "{}" })).toBe(200);
		expect(await status({ "sec-fetch-site": "same-site", referer: `${FRONTEND}/page` })).toBe(200);
		expect(await status({ origin: FRONTEND })).toBe(200);
		// A script or an API client, which says nothing about where it comes from.
		expect(await status({})).toBe(200);
		expect(opened).toHaveLength(9);
	});

	it("answers a cookie it doesn't count as no cookie, and still takes the token from anywhere", async () => {
		const { router, token, status } = await setup();
		const refused = await router.fetch(
			new Request(`${VICTIM}/`, { headers: { cookie: "x=1", "sec-fetch-site": "same-site", origin: SIBLING } }),
		);
		const cross = await router.fetch(
			new Request(`${VICTIM}/`, {
				headers: { cookie: `${PORT_COOKIE}=${token}`, "sec-fetch-site": "same-site", origin: SIBLING },
			}),
		);
		expect(cross?.status).toBe(401);
		expect(await cross?.text()).toBe(await refused?.text());
		// The token in the query is the capability: whoever has it may use it.
		const withToken = await router.fetch(
			new Request(`${VICTIM}/?_token=${token}`, {
				method: "POST",
				body: "x=1",
				headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
			}),
		);
		expect(withToken?.status).toBe(200);
		// The name before TASK-4887 is no longer read; nor is a bare name without the prefix over https.
		expect(await status({ cookie: `_kantel_port=${token}` })).toBe(401);
		expect(await status({ cookie: `kantel_port=${token}` })).toBe(401);
		// A planted cookie of the same name beside the real one doesn't hide it.
		expect(await status({ cookie: `${PORT_COOKIE}=planted; ${PORT_COOKIE}=${token}` })).toBe(200);
	});

	it("trades the token for the cookie only where the redirected request may use it, else serves it directly", async () => {
		const { router, token, opened } = await setup();
		const withToken = (headers: Record<string, string>) =>
			router.fetch(new Request(`${VICTIM}/page?_token=${token}`, { headers }));
		const frame = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };

		// A top-level navigation (typed, or a link from anywhere), the port's own page, or a script: the 303 and cookie.
		const trading: Record<string, string>[] = [
			{ "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
			{ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
			{ "sec-fetch-site": "same-origin", ...frame },
			{},
		];
		for (const headers of trading) {
			const traded = await withToken(headers);
			expect(traded?.status).toBe(303);
			expect(traded?.headers.get("location")).toBe("/page");
			expect(traded?.headers.get("set-cookie")).toMatch(/^__Host-kantel_port=/);
		}
		expect(opened).toEqual([]);

		// A frame of the port in another sandbox's page or the same sandbox's (whose Referer the redirect would drop), or
		// another page's fetch: served directly, the token taken off, no cookie set.
		const direct: Record<string, string>[] = [
			{ "sec-fetch-site": "same-site", ...frame, referer: `${SIBLING}/` },
			{ "sec-fetch-site": "same-site", ...frame, referer: `${FRONTEND}/` },
			{ "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", origin: "https://evil.example" },
		];
		for (const headers of direct) {
			const served = await withToken(headers);
			expect(served?.status).toBe(200);
			expect(served?.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
		}
		expect(opened).toHaveLength(direct.length);
		for (const { request } of opened) {
			expect(request).toMatch(/^GET \/page HTTP\/1\.1\r\n/);
			expect(request).not.toContain(token);
		}
		// The same frames without the token still get nothing, cookie or not.
		const bare = await router.fetch(
			new Request(`${VICTIM}/page`, {
				headers: { cookie: `${PORT_COOKIE}=${token}`, "sec-fetch-site": "same-site", ...frame },
			}),
		);
		expect(bare?.status).toBe(401);
	});

	it("keeps every name the cookie has had from the sandbox's server, whatever the scheme", async () => {
		const all = (token: string) => `theme=dark; _kantel_port=old; kantel_port=${token}; __Host-kantel_port=${token}`;
		for (const scheme of ["https", "http"] as const) {
			const { status, token, opened } = await setup(scheme);
			expect(await status({ cookie: all(token) })).toBe(200);
			expect(opened[0]?.request).toContain("Cookie: theme=dark\r\n");
			expect(opened[0]?.request).not.toContain("kantel_port");
			expect(opened[0]?.request).not.toContain(token);
		}
	});

	it("makes a token-gated port's answers revalidate through the gate, and leaves a public port's alone", async () => {
		const cacheable =
			'HTTP/1.1 200 OK\r\nCache-Control: public, max-age=3600\r\nETag: "v1"\r\nContent-Length: 2\r\n\r\nok';
		const port = fakePort(() => cacheable);
		const router = createPortRouter({ domain: DOMAIN, openPort: port.openPort, store: createMemoryRelayStore() });
		const { url } = await router.expose("sbx_1", 3000, { public: false, subdomain: "brave-otter-ab12cd" });
		const token = new URL(url).searchParams.get("_token") ?? "";
		const gated = await router.fetch(
			new Request(`${VICTIM}/config.js`, {
				headers: { cookie: `${PORT_COOKIE}=${token}`, "sec-fetch-site": "same-origin" },
			}),
		);
		expect(gated?.status).toBe(200);
		expect(gated?.headers.get("cache-control")).toBe("private, no-cache");
		expect(gated?.headers.get("etag")).toBe('"v1"');
		const { url: open } = await router.expose("sbx_1", 4000, { public: true, subdomain: "brave-otter-ab12cd" });
		const publicAnswer = await router.fetch(new Request(`${open}config.js`));
		expect(publicAnswer?.headers.get("cache-control")).toBe("public, max-age=3600");
	});

	it("has no prefix and no Secure over plain http, where a browser refuses __Host-", async () => {
		const { router, token, cookie, status } = await setup("http");
		expect(cookie).toBe(`kantel_port=${token}`);
		const traded = await router.fetch(new Request(`http://3000-brave-otter-ab12cd.${DOMAIN}/?_token=${token}`));
		expect(traded?.headers.get("set-cookie")).toBe(`kantel_port=${token}; Path=/; HttpOnly; SameSite=Lax`);
		expect(await status({ "sec-fetch-site": "same-site", origin: SIBLING.replace("https:", "http:") })).toBe(401);
		expect(await status({ "sec-fetch-site": "same-site", origin: FRONTEND.replace("https:", "http:") })).toBe(200);
	});

	it("is used for a WebSocket upgrade only from the port's own name or the same sandbox's, by Origin", async () => {
		const { router, token, cookie } = await setup();
		const host = `3000-brave-otter-ab12cd.${DOMAIN}`;
		const upgrade = (origin?: string) => router.upgrade(host, "/ws", cookie, { origin });
		expect(await upgrade(SIBLING)).toEqual({ ok: false, status: 401, reason: "This port needs its token" });
		expect(await upgrade("https://evil.example")).toMatchObject({ ok: false, status: 401 });
		expect(await upgrade("null")).toMatchObject({ ok: false, status: 401 });
		expect(await upgrade(VICTIM)).toMatchObject({ ok: true, sandboxId: "sbx_1", port: 3000 });
		expect(await upgrade(FRONTEND)).toMatchObject({ ok: true, sandboxId: "sbx_1", port: 3000 });
		// No Origin: not a browser's page.
		expect(await upgrade()).toMatchObject({ ok: true });
		// The token in the URL opens it from anywhere.
		expect(await router.upgrade(host, `/ws?_token=${token}`, undefined, { origin: SIBLING })).toMatchObject({
			ok: true,
			path: "/ws",
		});
	});
});

describe("HTTP over a port's stream", () => {
	const send = (reply: string | Uint8Array, request = new Request("https://p.test/x"), chunk = 3) => {
		const port = fakePort(() => reply, chunk);
		return proxyHttp((sink) => port.openPort("sbx_1", 3000, sink), request, { host: "p.test" });
	};

	it("reads a chunked body, skips a 100 Continue, and drops hop-by-hop headers", async () => {
		const answer = await send(
			"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\nX-App: 1\r\n\r\n" +
				"5;ext=1\r\nhello\r\n7\r\n, world\r\n0\r\nTrailer: x\r\n\r\n",
		);
		expect(answer.status).toBe(201);
		expect(answer.headers.get("x-app")).toBe("1");
		expect(answer.headers.get("connection")).toBeNull();
		expect(answer.headers.get("transfer-encoding")).toBeNull();
		expect(await answer.text()).toBe("hello, world");
	});

	it("hands each piece of the body to `take` instead of queueing it, and fails at the first it refuses", async () => {
		let closed = 0;
		let admitted = 0;
		const taken: string[] = [];
		const pieces = Array.from({ length: 200 }, () => "4\r\nabcd\r\n").join("");
		const answer = await proxyHttp(
			async (sink) => ({
				stream: 1,
				// One push holding the head and 800 bytes of body in 200 chunks: nothing reads between them.
				write: () =>
					sink.data(encoder.encode(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${pieces}0\r\n\r\n`)),
				close: () => {
					closed += 1;
				},
			}),
			new Request("https://p.test/"),
			{
				host: "p.test",
				take: (bytes) => {
					if (admitted + bytes.length > 10) return false;
					admitted += bytes.length;
					taken.push(decoder.decode(bytes));
					return true;
				},
			},
		);
		expect(answer.status).toBe(200);
		// The stream carries none of it: it only fails, once `take` refused.
		const reader = answer.body?.getReader();
		await expect(reader?.read()).rejects.toMatchObject({ status: 502 });
		expect(taken).toEqual(["abcd", "abcd"]);
		expect(closed).toBeGreaterThan(0);

		// One it takes whole ends the stream with nothing in it.
		const whole: string[] = [];
		const done = await proxyHttp(
			async (sink) => ({
				stream: 2,
				write: () => sink.data(encoder.encode("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello")),
				close: () => undefined,
			}),
			new Request("https://p.test/"),
			{ host: "p.test", take: (bytes) => whole.push(decoder.decode(bytes)) > 0 },
		);
		expect(await done.text()).toBe("");
		expect(whole).toEqual(["hello"]);
	});

	it("keeps no push it has read alive while an answer `take` is given stalls, chunked or not", async () => {
		v8.setFlagsFromString("--expose-gc");
		const gc = vm.runInNewContext("gc") as () => void;
		for (const framing of ["chunked", "length"] as const) {
			let sink: PortSink | undefined;
			let pushed: WeakRef<ArrayBuffer> | undefined;
			let taken = 0;
			const answer = await proxyHttp(
				async (given) => {
					sink = given;
					return {
						stream: 1,
						write: () => {
							// One big push: the head, then 100,000 one-byte chunks (or 100,000 bytes of a longer body),
							// then a size line cut short, so the parser has something it must keep.
							const body = framing === "chunked" ? `${"1\r\nx\r\n".repeat(100_000)}1` : "x".repeat(100_000);
							const head = framing === "chunked" ? "Transfer-Encoding: chunked\r\n" : "Content-Length: 100001\r\n";
							const bytes = encoder.encode(`HTTP/1.1 200 OK\r\n${head}\r\n${body}`);
							pushed = new WeakRef(bytes.buffer);
							given.data(bytes);
						},
						close: () => undefined,
					};
				},
				new Request("https://p.test/"),
				{
					host: "p.test",
					take: (bytes) => {
						taken += bytes.length;
						return true;
					},
				},
			);
			expect(taken).toBe(100_000);
			// Stalled: the answer and its parser are still alive, the push long read.
			await new Promise((resolve) => setTimeout(resolve, 0));
			gc();
			await new Promise((resolve) => setTimeout(resolve, 0));
			gc();
			expect({ framing, kept: pushed?.deref() !== undefined }).toEqual({ framing, kept: false });
			expect(answer.status).toBe(200);
			sink?.end("done");
		}
	});

	it("refuses too big a head even whole in one push, and keeps no interim head while waiting for the real one", async () => {
		const big = `HTTP/1.1 200 OK\r\nX-Big: ${"x".repeat(70 * 1024)}\r\n\r\nhello`;
		await expect(send(big)).rejects.toMatchObject({ status: 502 });
		const whole = proxyHttp(
			async (sink) => ({ stream: 1, write: () => sink.data(encoder.encode(big)), close: () => undefined }),
			new Request("https://p.test/"),
			{ host: "p.test" },
		);
		await expect(whole).rejects.toMatchObject({ status: 502 });

		v8.setFlagsFromString("--expose-gc");
		const gc = vm.runInNewContext("gc") as () => void;
		let pushed: WeakRef<ArrayBuffer> | undefined;
		let sink: PortSink | undefined;
		const pending = proxyHttp(
			async (given) => {
				sink = given;
				return {
					stream: 1,
					write: () => {
						// A thousand interim heads, then the start of the real one.
						const bytes = encoder.encode(`${"HTTP/1.1 100 Continue\r\n\r\n".repeat(1000)}HTTP/1.1 200 OK\r\n`);
						pushed = new WeakRef(bytes.buffer);
						given.data(bytes);
					},
					close: () => undefined,
				};
			},
			new Request("https://p.test/"),
			{ host: "p.test" },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		gc();
		await new Promise((resolve) => setTimeout(resolve, 0));
		gc();
		expect(pushed?.deref()).toBeUndefined();
		// What it kept is the head's start: the rest of it still makes the answer.
		sink?.data(encoder.encode("Content-Length: 2\r\n\r\nok"));
		expect(await (await pending).text()).toBe("ok");
	});

	it("reads a body to the end of the stream when it has no length", async () => {
		const answer = await send("HTTP/1.0 200 OK\r\n\r\nall of it");
		expect(await answer.text()).toBe("all of it");
	});

	it("passes bytes through as they are", async () => {
		const body = new Uint8Array([0, 255, 13, 10, 13, 10, 7]);
		const head = encoder.encode(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`);
		const all = new Uint8Array(head.length + body.length);
		all.set(head);
		all.set(body, head.length);
		const answer = await send(all);
		expect(new Uint8Array(await answer.arrayBuffer())).toEqual(body);
	});

	it("gives no body for HEAD, 204 and 304", async () => {
		const head = await send(
			"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n",
			new Request("https://p.test/", { method: "HEAD" }),
		);
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		expect((await send("HTTP/1.1 204 No Content\r\n\r\n")).status).toBe(204);
	});

	it("makes a sandbox's cookies host-only, so one port's page can't set them for every sandbox's", async () => {
		const answer = await send(
			"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nSet-Cookie: s=1; Domain=kantel-ports.test; Path=/\r\nSet-Cookie: t=2; domain =.x; Secure\r\n\r\n",
		);
		expect(answer.headers.getSetCookie()).toEqual(["s=1; Path=/", "t=2; Secure"]);
	});

	it("errors a body cut short, rather than passing it off as whole", async () => {
		const cut = await send("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nonly this");
		await expect(cut.text()).rejects.toThrow(/stopped mid-answer/);
		const chunks = await send("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel");
		await expect(chunks.text()).rejects.toThrow(/stopped mid-answer/);
	});

	it("fails with 502 for an answer that isn't HTTP or a port that closes without one", async () => {
		await expect(send("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\n\r\n")).rejects.toMatchObject({ status: 502 });
		await expect(send("HTTP/1.1 999 Nope\r\n\r\n")).rejects.toMatchObject({ status: 502 });
		await expect(send("SSH-2.0-OpenSSH_9.6\r\n\r\n")).rejects.toMatchObject({ status: 502 });
		await expect(send("")).rejects.toMatchObject({ status: 502 });
		const refused = proxyHttp(() => Promise.reject(new Error("no such port")), new Request("https://p.test/"), {
			host: "p.test",
		});
		await expect(refused).rejects.toMatchObject({ status: 502 });
	});

	it("keeps a client from adding headers or a second request through its own", async () => {
		const bytes = decoder.decode(
			await requestBytes(
				new Request("https://p.test/a%20b?q=1", {
					headers: { "x-evil": "a", connection: "upgrade", "x-forwarded-for": "1.2.3.4", "transfer-encoding": "x" },
				}),
				{ host: "p.test\r\nX-Injected: 1", forwarded: { "x-forwarded-proto": "https" } },
			),
		);
		expect(bytes).toMatch(/^GET \/a%20b\?q=1 HTTP\/1\.1\r\nHost: p\.test X-Injected: 1\r\n/);
		expect(bytes).not.toContain("1.2.3.4");
		expect(bytes).not.toMatch(/connection: upgrade/i);
		expect(bytes).not.toMatch(/transfer-encoding/i);
		expect(bytes).toContain("x-forwarded-proto: https\r\n");
		expect(bytes.split("\r\n\r\n")).toHaveLength(2);
	});
});
