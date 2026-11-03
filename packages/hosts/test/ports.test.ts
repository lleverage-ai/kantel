// Exposed ports through the gateway: a port's name answers only what was exposed, only with its token unless public,
// and the server in the sandbox sees the request as sent, less Kantel's token and cookie, over HTTP/1.1 on the port's
// stream.
import { describe, expect, it } from "vitest";
import type { PortSink, PortStream } from "../src/hub.ts";
import { proxyHttp, requestBytes } from "../src/port-http.ts";
import { createPortRouter, PORT_COOKIE } from "../src/ports.ts";
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
		expect(await router.upgrade("3000-brave-otter-ab12cd.kantel-ports.test", "/", undefined)).toMatchObject({
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
		expect(cookie).toBe(`${PORT_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure`);
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
		expect(await router.upgrade(host, "/hmr", undefined)).toEqual({
			ok: false,
			status: 401,
			reason: "This port needs its token",
		});
		expect(await router.upgrade(host, "/hmr", `${PORT_COOKIE}=nope`)).toMatchObject({ ok: false, status: 401 });
		expect(await router.upgrade(host, "/hmr?x=1", `${PORT_COOKIE}=${token}`)).toEqual({
			ok: true,
			sandboxId: "sbx_1",
			port: 5173,
			path: "/hmr?x=1",
			host,
		});
		expect(await router.upgrade(`${host}:443`, `/hmr?_token=${token}`, undefined)).toMatchObject({
			ok: true,
			path: "/hmr",
		});
		expect(await router.upgrade("5174-brave-otter-ab12cd.kantel-ports.test", "/", undefined)).toMatchObject({
			status: 404,
		});
		expect(await router.upgrade("kantel.test", "/v1/hosts/connect", undefined)).toBeUndefined();
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
