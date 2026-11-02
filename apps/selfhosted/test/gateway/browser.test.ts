// The browser on the self-hosted gateway (#24): the same session browser as Cloudflare's, over a real socket. A session
// asks for a browser, a person allows it through the gateway, the agent opens a page, the console gets a watch-only
// live view, an outside app an embed, and closing the session releases the browser. With Kantel's own browsers, a
// viewer's requests and live socket reach the browser host only with a valid view token.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBrowserProvider } from "@kantel/browser/memory";
import { createBrowserViewSigner, VIEW_PROTOCOL, VIEW_TOKEN_PROTOCOL } from "@kantel/browser/runtime";
import { BROWSER_TOOL_NAMES } from "@kantel/browser/session";
import { type CallContext, systemContext } from "@kantel/contracts";
import { createScriptedModel } from "@kantel/runtime/testing";
import { CODING_TOOLS } from "@kantel/sandbox/coding-tools";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { browserConfig, createBrowserViews, gatewayBrowserProvider } from "../../src/gateway/browser.ts";
import { bootstrap, createGatewayComponents, type GatewayComponents } from "../../src/gateway/components.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { type Listening, listen } from "../../src/gateway/node-http.ts";

type Snapshot = Awaited<ReturnType<GatewayComponents["runtime"]["runtime"]["snapshot"]>>;
type ToolItem = Extract<Snapshot["items"][number], { kind: "tool" }>;

const VIEW_KEY = "view-key-0123456789abcdef0123456789abcdef";
const HOST_TOKEN = "host-token-0123456789abcdef0123456789ab";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp(options: { browser?: boolean } = {}) {
	const { models, script } = createScriptedModel();
	const fake = createFakeBrowserProvider();
	const components: GatewayComponents = createGatewayComponents({
		models: { models },
		...(options.browser === false ? {} : { browserProvider: fake.provider, browserBinding: "fake" }),
	});
	const seeded = await bootstrap(components, { organisation: "Browse", project: "browse" });
	const scratch = await mkdtemp(join(tmpdir(), "kantel-browser-gateway-"));
	await writeFile(join(scratch, "index.html"), '<!doctype html><div id="root"></div>');
	const gateway = createGateway({
		components,
		consoleDir: scratch,
		embedOrigins: "https://app.example.com",
		publicOrigin: "https://kantel.example.com",
	});
	const server = await listen(gateway.fetch, 0, { host: "127.0.0.1" });
	cleanups.push(async () => {
		await gateway.close();
		await server.close();
		await components.close();
		await rm(scratch, { recursive: true, force: true });
	});
	const key = await components.identity.authenticateApiKey(
		{ ...systemContext("browser-test"), organisationId: seeded.organisationId },
		seeded.apiKey,
	);
	const operator: CallContext = {
		actor: key.actor,
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	};
	const post = (path: string, body: unknown, authorised = true) =>
		fetch(`${server.url}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(authorised ? { authorization: `Bearer ${seeded.apiKey}` } : {}),
			},
			body: JSON.stringify(body),
		});
	const { runtime } = components.runtime;
	const session = await runtime.create(operator, { projectId: seeded.projectId, agentId: "echo" });
	const tools = async (): Promise<ToolItem[]> =>
		(await runtime.snapshot(operator, session.id)).items.filter((item): item is ToolItem => item.kind === "tool");
	const waitingRequest = async (): Promise<ToolItem> => {
		for (let i = 0; i < 400; i += 1) {
			const request = (await tools()).find((item) => item.name === "browser_request" && item.status === "running");
			if (request !== undefined) return request;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("the agent never asked for a browser");
	};
	return { components, server, fake, script, operator, runtime, session, tools, waitingRequest, post };
}

describe("the browser on the self-hosted gateway", () => {
	it("gives sessions no browser without a provider, and says so", async () => {
		const { components, operator, post, session } = await setUp({ browser: false });
		expect(components.browser).toBeUndefined();
		expect(components.bindings.browser).toBe("none");
		expect((await components.runtime.profiles.get(operator, "echo")).tools).toEqual([...CODING_TOOLS]);
		const live = await post("/v1/browser/live", { sessionId: session.id, browserSessionId: "bsession_x" });
		expect(live.status).toBe(503);
	});

	it("asks a person, opens the granted site, shows a watch-only live view and an embed, and releases on close", async () => {
		const { components, fake, script, operator, runtime, session, tools, waitingRequest, post, server } = await setUp();
		expect((await components.runtime.profiles.get(operator, "echo")).tools).toEqual([
			...CODING_TOOLS,
			...BROWSER_TOOL_NAMES,
		]);
		script.reply(
			{ toolCalls: [{ name: "browser_request", args: { reason: "Read the example page", sites: ["example.com"] } }] },
			{ toolCalls: [{ name: "browser_open", args: { url: "https://example.com/" } }] },
			{ text: "Opened example.com." },
		);
		const prompt = await runtime.prompt(operator, session.id, { text: "Look at example.com" });
		const request = await waitingRequest();
		expect(fake.opened()).toEqual([]);

		// Signed in only, and as a POST.
		expect((await post("/v1/browser/decisions", {}, false)).status).toBe(401);
		expect((await fetch(`${server.url}/v1/browser/decisions`)).status).toBe(405);
		expect((await post("/v1/browser/decisions", { sessionId: session.id, allow: "yes" })).status).toBe(400);
		const allowed = await post("/v1/browser/decisions", { sessionId: session.id, callId: request.callId, allow: true });
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toEqual({ status: "granted" });
		expect(await runtime.wait(operator, session.id, prompt.id)).toMatchObject({ answer: "Opened example.com." });

		const open = (await tools()).find((item) => item.name === "browser_open");
		const browserSessionId = /bsession_[\w-]+/.exec(open?.output ?? "")?.[0];
		expect(browserSessionId).toMatch(/^bsession_/);
		const target = { sessionId: session.id, browserSessionId };

		const live = await post("/v1/browser/live", target);
		expect(live.status).toBe(200);
		expect(live.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await live.json()).toMatchObject({ kind: "embed", mode: "live", url: expect.stringContaining("watch=1") });

		const embed = await post(`/v1/sessions/${session.id}/browsers/${browserSessionId}/embed`, {
			mode: "live",
			minutes: 5,
		});
		expect(embed.status).toBe(200);
		expect(await embed.json()).toMatchObject({ mode: "live", url: expect.stringContaining("watch=1") });
		const tooLong = await post(`/v1/sessions/${session.id}/browsers/${browserSessionId}/embed`, {
			mode: "live",
			minutes: 90,
		});
		expect(tooLong.status).toBe(400);
		// Another session's browser is not found.
		const other = await runtime.create(operator, { projectId: session.projectId, agentId: "echo" });
		expect((await post("/v1/browser/live", { sessionId: other.id, browserSessionId })).status).toBe(404);

		expect(fake.live()).toHaveLength(1);
		await runtime.close(operator, session.id);
		expect(fake.live()).toEqual([]);
		expect((await post("/v1/browser/live", target)).status).toBe(410);
	});

	it("serves the viewer page uncached, without a referrer, framed only by the console and the embed origins", async () => {
		const { server } = await setUp();
		const page = await fetch(`${server.url}/browser/browser-1`);
		expect(page.status).toBe(200);
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(page.headers.get("referrer-policy")).toBe("no-referrer");
		expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'self' https://app.example.com");
	});
});

describe("the gateway's browser configuration", () => {
	it("chooses Kantel's own browsers when a browser host is set, and refuses a part missing", () => {
		expect(browserConfig({})).toBeUndefined();
		expect(browserConfig({ KANTEL_BRWSR_API_KEY: "bk_0123456789" })).toMatchObject({ provider: "brwsr" });
		const kantel = {
			KANTEL_BROWSER_HOST_URL: "http://browser-host:8790/",
			KANTEL_BROWSER_HOST_TOKEN: HOST_TOKEN,
			KANTEL_BROWSER_VIEW_KEY: VIEW_KEY,
		};
		expect(browserConfig(kantel)).toEqual({
			provider: "kantel",
			hostUrl: "http://browser-host:8790",
			hostToken: HOST_TOKEN,
			viewKey: VIEW_KEY,
		});
		// brwsr's key beside a host does not switch to brwsr unless it is named.
		expect(browserConfig({ ...kantel, KANTEL_BRWSR_API_KEY: "bk_0123456789" })).toMatchObject({
			provider: "kantel",
		});
		expect(
			browserConfig({ ...kantel, KANTEL_BRWSR_API_KEY: "bk_0123456789", KANTEL_BROWSER_PROVIDER: "brwsr" }),
		).toMatchObject({ provider: "brwsr" });
		expect(() => browserConfig({ KANTEL_BROWSER_PROVIDER: "kantel" })).toThrow(/KANTEL_BROWSER_HOST_URL/);
		expect(() => browserConfig({ ...kantel, KANTEL_BROWSER_HOST_TOKEN: "short" })).toThrow(/HOST_TOKEN/);
		expect(() => browserConfig({ ...kantel, KANTEL_BROWSER_VIEW_KEY: "short" })).toThrow(/VIEW_KEY/);
	});

	it("opens Kantel's browsers on the host with its token, and makes relative view links", async () => {
		const calls: { url: string; authorization: string | null }[] = [];
		const provider = gatewayBrowserProvider(
			{ provider: "kantel", hostUrl: "http://host.invalid", hostToken: HOST_TOKEN, viewKey: VIEW_KEY },
			{
				fetch: async (input, init) => {
					calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
					return Response.json({ status: "running", expiresAt: Date.now() + 600_000 });
				},
			},
		);
		const link = await provider.share("browser-1", 5, undefined, { control: false });
		expect(link.url).toMatch(/^\/browser\/browser-1#/);
		expect(calls.every((call) => call.authorization === `Bearer ${HOST_TOKEN}`)).toBe(true);
	});
});

/** A browser host's view routes, standing in for `src/browser/host.ts`: what reached it, and an echoing live socket. */
async function fakeHost() {
	const seen: { path: string; authorization: string | null; cookie: string | null }[] = [];
	const protocols: string[] = [];
	const server: Server = createServer((request, response) => {
		seen.push({
			path: request.url ?? "",
			authorization: request.headers.authorization ?? null,
			cookie: request.headers.cookie ?? null,
		});
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ status: "live" }));
	});
	const sockets = new WebSocketServer({ noServer: true, handleProtocols: () => VIEW_PROTOCOL });
	server.on("upgrade", (request, socket, head) => {
		protocols.push(String(request.headers["sec-websocket-protocol"] ?? ""));
		sockets.handleUpgrade(request, socket, head, (ws) => {
			ws.send("hello from the browser");
			ws.on("message", (data) => ws.send(`echo:${data}`));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				sockets.close();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	return { url, seen, protocols };
}

describe("a viewer's requests to Kantel's own browsers", () => {
	async function viewsOver() {
		const host = await fakeHost();
		const views = createBrowserViews({
			provider: "kantel",
			hostUrl: host.url,
			hostToken: HOST_TOKEN,
			viewKey: VIEW_KEY,
		});
		const server: Listening = await listen(views.fetch, 0, {
			host: "127.0.0.1",
			onUpgrade: (incoming, socket, head) => views.upgrade(incoming, socket, head),
		});
		cleanups.push(() => server.close());
		const signer = createBrowserViewSigner(VIEW_KEY);
		const token = (browser: string, expiresAt = Date.now() + 60_000) =>
			signer.sign({ browser, mode: "live", control: false, expiresAt });
		return { host, server, token };
	}

	it("passes a request with a valid token on, with the token and nothing else", async () => {
		const { host, server, token } = await viewsOver();
		const good = await token("browser-1");
		const answer = await fetch(`${server.url}/v1/browser/view/browser-1/status`, {
			headers: { authorization: `Bearer ${good}`, cookie: "hbs=secret" },
		});
		expect(answer.status).toBe(200);
		expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
		expect(host.seen).toEqual([
			{ path: "/v1/browser/view/browser-1/status", authorization: `Bearer ${good}`, cookie: null },
		]);

		// None, a forged one, another browser's and an expired one never reach the host.
		const refused = [
			{},
			{ authorization: "Bearer forged" },
			{ authorization: `Bearer ${await token("browser-2")}` },
			{ authorization: `Bearer ${await token("browser-1", Date.now() - 1000)}` },
		];
		for (const headers of refused) {
			expect((await fetch(`${server.url}/v1/browser/view/browser-1/status`, { headers })).status).toBe(401);
		}
		expect(host.seen).toHaveLength(1);
	});

	it("proxies the live socket once its token checks out, and refuses one without", async () => {
		const { host, server, token } = await viewsOver();
		const ws = `ws://127.0.0.1:${server.port}/v1/browser/view/browser-1/live`;
		const good = await token("browser-1");
		const socket = new WebSocket(ws, [VIEW_PROTOCOL, `${VIEW_TOKEN_PROTOCOL}${good}`]);
		const messages: string[] = [];
		await new Promise<void>((resolve, reject) => {
			socket.onerror = () => reject(new Error("the socket failed"));
			socket.onmessage = (event) => {
				messages.push(String(event.data));
				if (messages.length === 1) socket.send("ping");
				if (messages.length === 2) resolve();
			};
		});
		expect(socket.protocol).toBe(VIEW_PROTOCOL);
		expect(messages).toEqual(["hello from the browser", "echo:ping"]);
		socket.close();
		expect(host.protocols).toHaveLength(1);

		const refused = new WebSocket(ws, [VIEW_PROTOCOL, `${VIEW_TOKEN_PROTOCOL}forged`]);
		await new Promise<void>((resolve) => {
			refused.onerror = () => resolve();
			refused.onclose = () => resolve();
		});
		expect(refused.readyState).toBe(WebSocket.CLOSED);
		expect(host.protocols).toHaveLength(1);
	});
});
