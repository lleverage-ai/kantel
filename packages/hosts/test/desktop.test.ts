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
import { SELKIES_WEB } from "../src/selkies-web.ts";
import { type DesktopMode, signTunnel } from "../src/tunnel.ts";

const secret = crypto.getRandomValues(new Uint8Array(32));
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
function routes(answer: (path: string) => { status: number; body: string } | undefined = () => undefined) {
	const opened: { sandboxId: string; port: number; request: string }[] = [];
	const desktop = createDesktopRoutes({
		secret,
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

const ticket = (desktop: DesktopMode | undefined, overrides: { port?: number; expiresAt?: number } = {}) =>
	signTunnel(secret, {
		sandboxId: "sbx_4kq9x2mt",
		port: overrides.port ?? DESKTOP_PORT,
		expiresAt: overrides.expiresAt ?? Date.now() + 10 * 60_000,
		...(desktop === undefined ? {} : { desktop }),
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
			"another secret": await signTunnel(new Uint8Array(32), {
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
		expect(control).toEqual({ sandboxId: "sbx_4kq9x2mt", port: DESKTOP_PORT, path: DESKTOP_SOCKET });
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
