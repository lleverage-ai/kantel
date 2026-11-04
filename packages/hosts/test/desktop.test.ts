// The desktop's page: Selkies' web client, served for a live desktop ticket only, and only the files Kantel knows, byte
// for byte, so a sandbox can't put a page of its own on the gateway's origin. Its socket is the ticket's: view-only
// opens Selkies' viewer role whatever the client asks for, and lets through only what a viewer needs to watch.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type ClientFiles,
	createDesktopRoutes,
	DESKTOP_PORT,
	DESKTOP_SOCKET,
	desktopPath,
	HOSTS_DESKTOP_PATH,
	viewerMessage,
} from "../src/desktop.ts";
import type { PortSink } from "../src/hub.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { SELKIES_WEB } from "../src/selkies-web.ts";
import { createTunnelTickets, type DesktopMode } from "../src/tunnel.ts";

const tickets = createTunnelTickets(createMemoryRelayStore());
const encoder = new TextEncoder();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const served: { [path: string]: string } = {
	"/index.html": "<!doctype html><title>Selkies</title>",
	"/assets/index.js": "console.log('selkies')",
};
const client: ClientFiles = {
	version: "test",
	files: Object.fromEntries(
		Object.entries(served).map(([path, body]) => [path.slice(1), { sha256: sha256(body), size: body.length }]),
	),
};

/** Desktop routes over a fake port: an HTTP server answering `served` (as `answer` changes it), counting connections. */
function routes(
	answer: (path: string) => { status: number; body: string } | undefined = () => undefined,
	allowed?: (grantee: string | undefined) => Promise<boolean>,
) {
	const opened: { sandboxId: string; port: number; request: string }[] = [];
	const desktop = createDesktopRoutes({
		tickets,
		...(allowed === undefined ? {} : { allowed: (grant) => allowed(grant.grantee) }),
		client,
		async openPort(sandboxId: string, port: number, sink: PortSink) {
			return {
				stream: 1,
				write(bytes: Uint8Array) {
					const request = new TextDecoder().decode(bytes);
					opened.push({ sandboxId, port, request });
					const path = /^GET (\S+) /.exec(request)?.[1] ?? "";
					const { status, body } = answer(path) ?? {
						status: served[path] === undefined ? 404 : 200,
						body: served[path] ?? "nope",
					};
					sink.data(encoder.encode(`HTTP/1.1 ${status} X\r\nContent-Length: ${body.length}\r\n\r\n${body}`));
				},
				close() {},
			};
		},
	});
	return { desktop, opened };
}

const ticket = (
	desktop: DesktopMode | undefined,
	overrides: { port?: number; expiresAt?: number; grantee?: string } = {},
) =>
	tickets.issue({
		sandboxId: "sbx_4kq9x2mt",
		port: overrides.port ?? DESKTOP_PORT,
		expiresAt: overrides.expiresAt ?? Date.now() + 10 * 60_000,
		...(desktop === undefined ? {} : { desktop }),
		...(overrides.grantee === undefined ? {} : { grantee: overrides.grantee }),
	});
const get = (path: string, method = "GET") => new Request(`https://kantel.test${path}`, { method });

describe("the desktop's page", () => {
	it("serves Selkies' files, checked against their hashes, once per gateway", async () => {
		const { desktop, opened } = routes();
		const page = `${HOSTS_DESKTOP_PATH}/${await ticket("control")}/`;
		const index = await desktop.fetch(get(page));
		expect(index?.status).toBe(200);
		expect(index?.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(index?.headers.get("cache-control")).toBe("no-store");
		expect(await index?.text()).toBe(served["/index.html"]);
		const script = await desktop.fetch(get(`${page}assets/index.js`));
		expect(script?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(script?.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await script?.text()).toBe(served["/assets/index.js"]);
		// The sandbox was asked once for each, as 127.0.0.1:6080 with nothing of the browser's request.
		expect(opened.map((open) => [open.port, /^GET (\S+)/.exec(open.request)?.[1]])).toEqual([
			[DESKTOP_PORT, "/index.html"],
			[DESKTOP_PORT, "/assets/index.js"],
		]);
		expect(opened[0]?.request).toContain(`Host: 127.0.0.1:${DESKTOP_PORT}\r\n`);
		// Another ticket, even a view-only one for another page load: from what the gateway checked already.
		const again = await desktop.fetch(get(`${HOSTS_DESKTOP_PATH}/${await ticket("view")}/assets/index.js`));
		expect(await again?.text()).toBe(served["/assets/index.js"]);
		expect(opened).toHaveLength(2);
		expect((await desktop.fetch(get(page, "HEAD")))?.status).toBe(200);
	});

	it("refuses a file a sandbox changed, and serves nothing Kantel doesn't know, Selkies' API included", async () => {
		const { desktop, opened } = routes((path) =>
			path === "/assets/index.js" ? { status: 200, body: "fetch('/v1/keys')" } : undefined,
		);
		const page = `${HOSTS_DESKTOP_PATH}/${await ticket("control")}/`;
		const changed = await desktop.fetch(get(`${page}assets/index.js`));
		expect(changed?.status).toBe(502);
		expect(await changed?.text()).not.toContain("fetch");
		for (const path of ["api/files", "api/status", "assets/other.js", "../index.html", "%2e%2e/index.html"]) {
			expect((await desktop.fetch(get(`${page}${path}`)))?.status).toBe(404);
		}
		expect(opened.map((open) => /^GET (\S+)/.exec(open.request)?.[1])).toEqual(["/assets/index.js"]);
		expect((await desktop.fetch(get(`${page}index.html`, "POST")))?.status).toBe(405);
	});

	it("answers only a live desktop ticket for the desktop's port", async () => {
		const { desktop, opened } = routes();
		const refused = {
			"a tunnel's ticket": await ticket(undefined),
			"another port": await ticket("control", { port: 22 }),
			expired: await ticket("control", { expiresAt: Date.now() - 1 }),
			"issued elsewhere": await createTunnelTickets(createMemoryRelayStore()).issue({
				sandboxId: "sbx_4kq9x2mt",
				port: DESKTOP_PORT,
				expiresAt: Date.now() + 60_000,
				desktop: "control",
			}),
		};
		for (const [what, bad] of Object.entries(refused)) {
			const answer = await desktop.fetch(get(`${HOSTS_DESKTOP_PATH}/${bad}/`));
			expect({ what, status: answer?.status }).toEqual({ what, status: 404 });
		}
		expect(opened).toEqual([]);
		expect(await desktop.fetch(get("/v1/hosts/view/abc.def"))).toBeUndefined();
		// Without the trailing slash, the page's relative files would miss the ticket.
		const bare = `${HOSTS_DESKTOP_PATH}/${await ticket("view")}`;
		const redirect = await desktop.fetch(get(bare));
		expect(redirect?.status).toBe(308);
		expect(redirect?.headers.get("location")).toBe(`${bare}/`);
	});

	it("answers nothing for a ticket whose holder has lost access, page or stream", async () => {
		const gone = JSON.stringify({ kind: "key", keyId: "key_revoked" });
		const { desktop, opened } = routes(undefined, async (grantee) => grantee !== gone);
		const revoked = await ticket("control", { grantee: gone });
		expect((await desktop.fetch(get(`${HOSTS_DESKTOP_PATH}/${revoked}/`)))?.status).toBe(404);
		expect(await desktop.socket(`${HOSTS_DESKTOP_PATH}/${revoked}/api/websockets`)).toBe("refused");
		expect(opened).toEqual([]);
		// Someone else's still opens, and says who it was given to, so the gateway can end it later.
		const kept = JSON.stringify({ kind: "key", keyId: "key_live" });
		const target = await desktop.socket(
			`${HOSTS_DESKTOP_PATH}/${await ticket("view", { grantee: kept })}/api/websockets`,
		);
		expect(target === "refused" ? undefined : target?.grant.grantee).toBe(kept);
	});

	it("doesn't let one sandbox's unfinished file hold up another's, and keeps only checked bytes", async () => {
		const body = served["/assets/index.js"] ?? "";
		let stalled = true;
		const closed: string[] = [];
		const desktop = createDesktopRoutes({
			tickets,
			client,
			fileTimeoutMs: 50,
			async openPort(sandboxId: string, _port: number, sink: PortSink) {
				return {
					stream: 1,
					write(bytes: Uint8Array) {
						const path = /^GET (\S+) /.exec(new TextDecoder().decode(bytes))?.[1] ?? "";
						const full = served[path] ?? "";
						// The slow sandbox says 200 and sends half, then nothing more while it is stalled.
						const sent = sandboxId === "sbx_slow" && stalled ? full.slice(0, 4) : full;
						sink.data(encoder.encode(`HTTP/1.1 200 OK\r\nContent-Length: ${full.length}\r\n\r\n${sent}`));
					},
					close() {
						closed.push(sandboxId);
					},
				};
			},
		});
		const issue = (sandboxId: string) =>
			tickets.issue({ sandboxId, port: DESKTOP_PORT, expiresAt: Date.now() + 60_000, desktop: "control" });
		const slow = desktop.fetch(get(`${HOSTS_DESKTOP_PATH}/${await issue("sbx_slow")}/assets/index.js`));
		const healthy = await desktop.fetch(get(`${HOSTS_DESKTOP_PATH}/${await issue("sbx_ok")}/assets/index.js`));
		expect(await healthy?.text()).toBe(body);
		// The slow one gives up on its own time, its stream closed, and nothing of it is kept.
		expect((await slow)?.status).toBe(502);
		expect(closed).toContain("sbx_slow");
		// The checked bytes are reused by any sandbox; one that failed is tried again.
		stalled = false;
		const reused = await desktop.fetch(get(`${HOSTS_DESKTOP_PATH}/${await issue("sbx_slow")}/assets/index.js`));
		expect(await reused?.text()).toBe(body);
		const index = await desktop.fetch(get(`${HOSTS_DESKTOP_PATH}/${await issue("sbx_slow")}/`));
		expect(await index?.text()).toBe(served["/index.html"]);
	});

	it("stops reading a file once it passes its known size, however it is split", async () => {
		const closed: number[] = [];
		let pushed = 0;
		const desktop = createDesktopRoutes({
			tickets,
			client,
			async openPort(_sandboxId: string, _port: number, sink: PortSink) {
				let open = true;
				return {
					stream: 1,
					write() {
						// No length: read to the end, so only the gateway's own count can stop it. Small chunks, many of them.
						sink.data(encoder.encode("HTTP/1.1 200 OK\r\n\r\n"));
						const more = () => {
							if (!open || pushed > 10_000) return;
							pushed += 1;
							sink.data(encoder.encode("x".repeat(16)));
							setTimeout(more, 0);
						};
						more();
					},
					close() {
						open = false;
						closed.push(pushed);
					},
				};
			},
		});
		const answer = await desktop.fetch(get(`${HOSTS_DESKTOP_PATH}/${await ticket("control")}/assets/index.js`));
		expect(answer?.status).toBe(502);
		// Closed after a few chunks: no more than the file's size (22 bytes) and one chunk was taken.
		expect(closed.length).toBeGreaterThan(0);
		expect(closed[0]).toBeLessThanOrEqual(3);
	});

	it("refuses a file pushed all at once past its size, before the reader runs", async () => {
		const closed: string[] = [];
		let closedInPush = false;
		const desktop = createDesktopRoutes({
			tickets,
			client,
			async openPort(sandboxId: string, _port: number, sink: PortSink) {
				return {
					stream: 1,
					write() {
						// 4000 chunks in one push, and no end: the reader can't run between them, so only the parser's count
						// can stop it and close the stream.
						const pieces = Array.from({ length: 4000 }, () => "10\r\nxxxxxxxxxxxxxxxx\r\n").join("");
						sink.data(encoder.encode(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${pieces}`));
						closedInPush = closed.length > 0;
					},
					close() {
						closed.push(sandboxId);
					},
				};
			},
		});
		const answer = await desktop.fetch(get(`${HOSTS_DESKTOP_PATH}/${await ticket("control")}/assets/index.js`));
		expect(answer?.status).toBe(502);
		// Closed while the push was still being parsed: past the file's size, nothing more was queued.
		expect(closedInPush).toBe(true);
	});

	it("holds at most its budget of files still arriving across sandboxes, one-byte pieces or not", async () => {
		const body = served["/assets/index.js"] ?? "";
		const sinks = new Map<string, PortSink>();
		const desktop = createDesktopRoutes({
			tickets,
			client,
			// Long enough that nothing here ends by timing out.
			fileTimeoutMs: 60_000,
			// Room for two of the file's 22 bytes in flight, not three.
			fetchBudgetBytes: 2 * body.length + 4,
			async openPort(sandboxId: string, _port: number, sink: PortSink) {
				return {
					stream: 1,
					write(bytes: Uint8Array) {
						const path = /^GET (\S+) /.exec(new TextDecoder().decode(bytes))?.[1] ?? "";
						const full = served[path] ?? "";
						if (path !== "/assets/index.js") {
							sink.data(encoder.encode(`HTTP/1.1 200 OK\r\nContent-Length: ${full.length}\r\n\r\n${full}`));
							return;
						}
						// All but the last byte, each in a chunk of its own, in one push; then nothing until the test says.
						sinks.set(sandboxId, sink);
						const pieces = [...full.slice(0, -1)].map((char) => `1\r\n${char}\r\n`).join("");
						sink.data(encoder.encode(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${pieces}`));
					},
					close() {},
				};
			},
		});
		const issue = (sandboxId: string) =>
			tickets.issue({ sandboxId, port: DESKTOP_PORT, expiresAt: Date.now() + 60_000, desktop: "control" });
		const settled = new Set<string>();
		const file = async (sandboxId: string, path = "assets/index.js") => {
			const answer = await desktop.fetch(get(`${HOSTS_DESKTOP_PATH}/${await issue(sandboxId)}/${path}`));
			settled.add(sandboxId);
			return answer;
		};
		const a = file("sbx_a");
		const b = file("sbx_b");
		await expect.poll(() => sinks.size).toBe(2);
		// The third doesn't fit beside them: refused at once, while the other two are still waiting.
		const c = await file("sbx_c");
		expect(c?.status).toBe(502);
		expect([...settled]).toEqual(["sbx_c"]);
		// The two held finish, and are checked and served as any other.
		for (const id of ["sbx_a", "sbx_b"]) sinks.get(id)?.data(encoder.encode(`1\r\n${body.slice(-1)}\r\n0\r\n\r\n`));
		expect(await (await a)?.text()).toBe(body);
		expect(await (await b)?.text()).toBe(body);
		// What they held is let go of: the refused sandbox's next file (37 bytes) fits where it couldn't before.
		const index = await file("sbx_c", "");
		expect(await index?.text()).toBe(served["/index.html"]);
	});

	it("lets go of what a refused or timed-out file held", async () => {
		const body = served["/assets/index.js"] ?? "";
		let mode: "stall" | "flood" | "serve" = "stall";
		const desktop = createDesktopRoutes({
			tickets,
			client,
			fileTimeoutMs: 30,
			// Room for one file only.
			fetchBudgetBytes: body.length + 2,
			async openPort(_sandboxId: string, _port: number, sink: PortSink) {
				return {
					stream: 1,
					write() {
						const sent = mode === "stall" ? body.slice(0, -1) : mode === "flood" ? `${body}${body}` : body;
						sink.data(encoder.encode(`HTTP/1.1 200 OK\r\n\r\n${sent}`));
						if (mode !== "stall") sink.end("done");
					},
					close() {},
				};
			},
		});
		const fetchIn = async (sandboxId: string) =>
			desktop.fetch(
				get(
					`${HOSTS_DESKTOP_PATH}/${await tickets.issue({ sandboxId, port: DESKTOP_PORT, expiresAt: Date.now() + 60_000, desktop: "control" })}/assets/index.js`,
				),
			);
		expect((await fetchIn("sbx_slow"))?.status).toBe(502);
		mode = "flood";
		expect((await fetchIn("sbx_flood"))?.status).toBe(502);
		// Had either kept its share, there would be no room for this one.
		mode = "serve";
		expect(await (await fetchIn("sbx_ok"))?.text()).toBe(body);
	});

	it("puts view-only in the URL's fragment for Selkies' own viewer page, and in the ticket for the gateway", () => {
		expect(desktopPath("a.b", "view")).toBe(`${HOSTS_DESKTOP_PATH}/a.b/#shared`);
		expect(desktopPath("a.b", "control")).toBe(`${HOSTS_DESKTOP_PATH}/a.b/`);
	});
});

describe("the desktop's socket", () => {
	it("opens Selkies' viewer role for a view-only ticket, whatever the client's query says", async () => {
		const { desktop } = routes();
		const view = await ticket("view");
		const target = await desktop.socket(
			`${HOSTS_DESKTOP_PATH}/${view}${DESKTOP_SOCKET}?role=controller&slot=2&token=abc`,
		);
		expect(target).toMatchObject({
			sandboxId: "sbx_4kq9x2mt",
			port: DESKTOP_PORT,
			path: `${DESKTOP_SOCKET}?role=viewer`,
		});
		const control = await desktop.socket(`${HOSTS_DESKTOP_PATH}/${await ticket("control")}${DESKTOP_SOCKET}`);
		expect(control).toMatchObject({ sandboxId: "sbx_4kq9x2mt", port: DESKTOP_PORT, path: DESKTOP_SOCKET });
		expect(control === "refused" ? undefined : control?.accept).toBeUndefined();
		// Only Selkies' stream: not its WebRTC signalling, nor any other path.
		for (const path of ["/api/webrtc/signaling", "/api/ws", "/", ""]) {
			expect(await desktop.socket(`${HOSTS_DESKTOP_PATH}/${view}${path}`)).toBe("refused");
		}
		expect(await desktop.socket(`${HOSTS_DESKTOP_PATH}/${await ticket(undefined)}${DESKTOP_SOCKET}`)).toBe("refused");
		expect(await desktop.socket("/v1/hosts/tunnel/a.b")).toBeUndefined();
	});

	it("lets a viewer send only what watching needs", () => {
		for (const watching of ["SETTINGS,{}", "START_VIDEO", "STOP_VIDEO", "REQUEST_KEYFRAME"]) {
			expect({ watching, ok: viewerMessage(watching, false) }).toEqual({ watching, ok: true });
		}
		const input = [
			"kd,65",
			"ku,65",
			"kh,65",
			"kr",
			"m,10,10,1,0",
			"m2,10,10,1,0",
			"co,end,hello",
			"cw,aGVsbG8=",
			"cws,1,5",
			"cmd,xterm",
			"r,3840x2160",
			"s,2",
			"js,b,0,1,1",
			"_gz,1",
			"SET_NATIVE_CURSOR_RENDERING,1",
			"",
		];
		for (const message of input) expect({ message, ok: viewerMessage(message, false) }).toEqual({ message, ok: false });
		// Binary: file uploads, and text gzipped into a 0x05 frame, which could carry any of the above.
		expect(viewerMessage(new Uint8Array([0x05, 0x1f, 0x8b]), true)).toBe(false);
		expect(viewerMessage(new Uint8Array([0x01]), true)).toBe(false);
		expect(viewerMessage("START_VIDEO", true)).toBe(false);
	});
});

describe("the client Kantel serves", () => {
	it("is the Selkies the sandbox image installs", () => {
		const dockerfile = readFileSync(new URL("../../../apps/host/guest/Dockerfile", import.meta.url), "utf8");
		expect(/^ARG SELKIES_VERSION=(\S+)$/m.exec(dockerfile)?.[1]).toBe(SELKIES_WEB.version);
		expect(SELKIES_WEB.files["index.html"]).toBeDefined();
		expect(SELKIES_WEB.files["selkies-core.js"]).toBeDefined();
	});
});
