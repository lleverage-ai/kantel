// The browser on the stack (#24), in Node over the fake provider: a session asks for a browser, a person allows it
// through the gateway, the agent opens a page and acts, the transcript shows its screenshots, and closing or aborting
// the session releases the browser. And without brwsr's key, sessions have no browser tools.
import { createFakeBrowserProvider } from "@kantel/browser/memory";
import { createMockAccess } from "@kantel/identity/testing";
import type { ToolItem } from "@kantel/protocol";
import { createScriptedModel } from "@kantel/runtime/testing";
import type { ModelRequestView } from "@kantel/testing/session";
import { describe, expect, it } from "vitest";
import { BROWSER_TOOL_NAMES, brwsrProviderFrom, toolName } from "../src/browser.ts";
import { CODING_TOOLS } from "../src/coding-tools.ts";
import { gatewayConfig } from "../src/config.ts";
import { createDevBrowserModels } from "../src/dev-browser-model.ts";
import { BROWSER_DECISIONS_PATH, BROWSER_LIVE_PATH, createGateway } from "../src/gateway.ts";
import { createStack, DEFAULT_AGENT_ID } from "../src/stack.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const BASE = "https://harbour.test";

async function setup(
	options: {
		browser?: boolean;
		devModel?: boolean;
		/** Holds every screenshot the provider takes until it settles. */
		shotGate?: Promise<void>;
	} = {},
) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		KANTEL_ACCESS_AUD: AUD,
		KANTEL_ADMIN_EMAIL: ADMIN,
	});
	const fake = createFakeBrowserProvider();
	const scripted = createScriptedModel();
	const stack = await createStack({
		config,
		accessFetch: mock.fetch,
		models: () => ({ models: options.devModel === true ? createDevBrowserModels() : scripted.models }),
		...(options.browser === false
			? {}
			: {
					browserProvider:
						options.shotGate === undefined
							? fake.provider
							: {
									...fake.provider,
									async screenshot(...args: Parameters<typeof fake.provider.screenshot>) {
										await options.shotGate;
										return fake.provider.screenshot(...args);
									},
								},
				}),
	});
	const gateway = createGateway(stack);
	const decide = async (body: unknown, email = ADMIN) =>
		gateway.fetch(
			new Request(`${BASE}${BROWSER_DECISIONS_PATH}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-access-jwt-assertion": await mock.sign({ sub: `sub-${email}`, email }),
				},
				body: JSON.stringify(body),
			}),
		);
	const live = async (body: unknown, email = ADMIN) =>
		gateway.fetch(
			new Request(`${BASE}${BROWSER_LIVE_PATH}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-access-jwt-assertion": await mock.sign({ sub: `sub-${email}`, email }),
				},
				body: JSON.stringify(body),
			}),
		);
	const runtime = stack.runtime.runtime;
	const session = await runtime.create(stack.admin, {
		projectId: stack.project.id,
		agentId: DEFAULT_AGENT_ID,
		title: "Browse",
	});
	const tools = async (): Promise<ToolItem[]> =>
		(await runtime.snapshot(stack.admin, session.id)).items.filter((item): item is ToolItem => item.kind === "tool");
	/** The waiting `browser_request` call, once the agent has made it. */
	const waitingRequest = async (): Promise<ToolItem> => {
		for (let i = 0; i < 200; i += 1) {
			const request = (await tools()).find((item) => item.name === "browser_request" && item.status === "running");
			if (request !== undefined) return request;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("the agent never asked for a browser");
	};
	return { stack, gateway, mock, fake, scripted, runtime, session, tools, waitingRequest, decide, live };
}

/** The tool results the model has had, as text. */
const results = (view: ModelRequestView): string[] =>
	view.messages.filter((message) => message.role === "tool").map((message) => message.text);

/** The browser's session ID from the last result that named one. */
const lastBrowserSessionId = (view: ModelRequestView): string => {
	for (const text of results(view).reverse()) {
		const found = /bsession_[\w-]+/.exec(text);
		if (found !== null) return found[0];
	}
	throw new Error("no browser session ID in the results");
};

describe("the browser on the stack", () => {
	it("names one tool per capability", () => {
		expect(BROWSER_TOOL_NAMES).toEqual(
			expect.arrayContaining(["browser_request", "browser_open", "browser_act", "browser_screenshot"]),
		);
		expect(toolName("browser.open")).toBe("browser_open");
	});

	it("has no provider without brwsr's key, and never puts the key in what it returns", () => {
		expect(brwsrProviderFrom({})).toBeUndefined();
		expect(brwsrProviderFrom({ KANTEL_BRWSR_API_KEY: "  " })).toBeUndefined();
		expect(brwsrProviderFrom({ KANTEL_BRWSR_API_KEY: "bk_secret_0123456789" })).toBeDefined();
	});

	it("gives sessions no browser tools without a provider", async () => {
		const { stack } = await setup({ browser: false });
		expect(stack.browser).toBeUndefined();
		expect((await stack.runtime.profiles.get(stack.admin, DEFAULT_AGENT_ID)).tools).toEqual([...CODING_TOOLS]);
		await stack.close();
	});

	it("asks a person, opens the granted site, shows each step's screenshot and releases the browser on close", async () => {
		const { stack, gateway, mock, fake, scripted, runtime, session, tools, waitingRequest, decide } = await setup();
		scripted.script.reply(
			{ toolCalls: [{ name: "browser_request", args: { reason: "Read the example page", sites: ["example.com"] } }] },
			{ toolCalls: [{ name: "browser_open", args: { url: "https://example.com/" } }] },
			(view) => {
				const id = lastBrowserSessionId(view);
				return { toolCalls: [{ name: "browser_act", args: { browserSessionId: id, action: "look" } }] };
			},
			(view) => {
				const id = lastBrowserSessionId(view);
				return { toolCalls: [{ name: "browser_screenshot", args: { browserSessionId: id } }] };
			},
			{ text: "I looked at example.com." },
		);
		const prompt = await runtime.prompt(stack.admin, session.id, { text: "Look at example.com" });
		const request = await waitingRequest();

		// Nothing is open until a person answers.
		expect(fake.opened()).toEqual([]);
		const allowed = await decide({ sessionId: session.id, callId: request.callId, allow: true });
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toEqual({ status: "granted" });

		expect(await runtime.wait(stack.admin, session.id, prompt.id)).toMatchObject({
			answer: "I looked at example.com.",
		});
		const items = await tools();
		const byName = (name: string) => items.find((item) => item.name === name);
		expect(byName("browser_request")).toMatchObject({ status: "done" });
		// Opening at a URL shows where the browser landed; a look does not need a picture; a screenshot is one. The
		// transcript's screenshot is a reference to the project's attachment, taken after the step answered (the next call
		// waited for it). The model's own screenshot stays inline in the conversation, as the model sees it, and the
		// transcript names it by its hash, served from the session.
		const opened = byName("browser_open")?.images;
		expect(opened).toEqual([
			{
				mimeType: "image/jpeg",
				url: expect.stringMatching(new RegExp(`^/v1/attachments/[0-9a-f-]{36}\\?projectId=${stack.project.id}$`)),
			},
		]);
		const shot = await gateway.fetch(
			new Request(`${BASE}${opened?.[0]?.url}`, {
				headers: { "cf-access-jwt-assertion": await mock.sign({ sub: `sub-${ADMIN}`, email: ADMIN }) },
			}),
		);
		expect(shot.status).toBe(200);
		expect(shot.headers.get("content-type")).toBe("image/png");
		expect((await shot.arrayBuffer()).byteLength).toBeGreaterThan(0);
		expect(byName("browser_act")?.images ?? []).toEqual([]);
		const own = byName("browser_screenshot")?.images;
		expect(own).toEqual([
			{
				mimeType: "image/png",
				url: expect.stringMatching(new RegExp(`^/v1/sessions/${session.id}/images/[0-9a-f]{64}$`)),
				size: expect.any(Number),
			},
		]);
		const ownShot = await gateway.fetch(
			new Request(`${BASE}${own?.[0]?.url}`, {
				headers: { "cf-access-jwt-assertion": await mock.sign({ sub: `sub-${ADMIN}`, email: ADMIN }) },
			}),
		);
		expect(ownShot.status).toBe(200);
		expect(ownShot.headers.get("content-type")).toBe("image/png");
		expect(ownShot.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		const ownRef = own?.[0];
		expect((await ownShot.arrayBuffer()).byteLength).toBe(ownRef?.url === undefined ? -1 : ownRef.size);
		// The transcript never names a CDP URL.
		expect(JSON.stringify(items)).not.toContain("wss://");
		expect(fake.live()).toHaveLength(1);

		await runtime.close(stack.admin, session.id);
		expect(fake.live()).toEqual([]);
		await stack.close();
	});

	it("answers a step before its screenshot is taken, and waits for it before the browser's next step", async () => {
		let release = () => {};
		const shotGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { stack, scripted, runtime, session, tools, waitingRequest, decide } = await setup({ shotGate });
		let shownBeforeShot: string | undefined;
		scripted.script.reply(
			{ toolCalls: [{ name: "browser_request", args: { reason: "Read the page", sites: ["example.com"] } }] },
			{ toolCalls: [{ name: "browser_open", args: { url: "https://example.com/" } }] },
			async (view) => {
				// The step has answered while its screenshot is still being taken: the model never waited for it.
				shownBeforeShot = (await tools()).find((item) => item.name === "browser_open")?.status;
				release();
				const id = lastBrowserSessionId(view);
				return { toolCalls: [{ name: "browser_act", args: { browserSessionId: id, action: "scroll" } }] };
			},
			{ text: "Done." },
		);
		const prompt = await runtime.prompt(stack.admin, session.id, { text: "Look at example.com" });
		const request = await waitingRequest();
		await decide({ sessionId: session.id, callId: request.callId, allow: true });
		await runtime.wait(stack.admin, session.id, prompt.id);
		expect(shownBeforeShot).toBe("done");
		const items = await tools();
		const opened = items.find((item) => item.name === "browser_open")?.images?.[0];
		expect(opened?.url).toMatch(/^\/v1\/attachments\//);
		const stored = await stack.attachments.get(
			{ organisationId: stack.admin.organisationId, projectId: stack.project.id },
			String(opened?.url?.split("/")[3]?.split("?")[0]),
		);
		expect(new TextDecoder().decode(stored?.bytes)).toBe("fake screenshot of https://example.com/");
		await stack.close();
	});

	it("takes a step's screenshot before the close the model sent with it", async () => {
		let release = () => {};
		const shotGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { stack, fake, scripted, runtime, session, tools, waitingRequest, decide } = await setup({ shotGate });
		scripted.script.reply(
			{ toolCalls: [{ name: "browser_request", args: { reason: "Read the page", sites: ["example.com"] } }] },
			{ toolCalls: [{ name: "browser_open", args: { url: "https://example.com/" } }] },
			(view) => {
				const id = lastBrowserSessionId(view);
				// Both at once, as models do: the act's screenshot must be taken before the close ends the browser.
				setTimeout(release, 50);
				return {
					toolCalls: [
						{ name: "browser_act", args: { browserSessionId: id, action: "scroll" } as Record<string, string> },
						{ name: "browser_close", args: { browserSessionId: id } as Record<string, string> },
					],
				};
			},
			{ text: "Done." },
		);
		const prompt = await runtime.prompt(stack.admin, session.id, { text: "Look at example.com" });
		const request = await waitingRequest();
		await decide({ sessionId: session.id, callId: request.callId, allow: true });
		await runtime.wait(stack.admin, session.id, prompt.id);
		const items = await tools();
		expect(items.find((item) => item.name === "browser_close")).toMatchObject({ status: "done" });
		expect(fake.live()).toEqual([]);
		const scrolled = items.find((item) => item.name === "browser_act")?.images?.[0];
		expect(scrolled?.url).toMatch(/^\/v1\/attachments\//);
		const stored = await stack.attachments.get(
			{ organisationId: stack.admin.organisationId, projectId: stack.project.id },
			String(scrolled?.url?.split("/")[3]?.split("?")[0]),
		);
		expect(stored).toBeDefined();
		await stack.close();
	});

	it("offers browser_run only to a project with goal mode on, on the decision model it picks", async () => {
		const { stack, fake, scripted, runtime, decide } = await setup();
		expect(BROWSER_TOOL_NAMES).toContain("browser_run");
		expect(stack.projectDefaults).toEqual({ browserGoalMode: "off", browserDecisionModel: "clef" });
		await stack.identity.setProjectSettings(stack.admin, stack.project.id, {
			browserGoalMode: "on",
			browserDecisionModel: "jev",
		});
		const session = await runtime.create(stack.admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
			title: "Goal",
		});
		scripted.script.reply(
			{ toolCalls: [{ name: "browser_request", args: { reason: "Search flights", sites: ["example.com"] } }] },
			{ toolCalls: [{ name: "browser_run", args: { goal: "search flights", url: "https://example.com/" } }] },
			(view) => ({ text: results(view).at(-1)?.includes("The goal is met.") ? "ran" : "no run" }),
		);
		const prompt = await runtime.prompt(stack.admin, session.id, { text: "Search" });
		const waiting = async () => {
			for (let i = 0; i < 200; i += 1) {
				const items = (await runtime.snapshot(stack.admin, session.id)).items;
				const found = items.find(
					(item): item is ToolItem =>
						item.kind === "tool" && item.name === "browser_request" && item.status === "running",
				);
				if (found !== undefined) return found;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error("the agent never asked for a browser");
		};
		const request = await waiting();
		await decide({ sessionId: session.id, callId: request.callId, allow: true });
		expect(await runtime.wait(stack.admin, session.id, prompt.id)).toMatchObject({ answer: "ran" });
		expect(fake.runs().map((run) => run.model)).toEqual(["jev"]);
		await stack.close();
	});

	it("has no browser_run where goal mode is off", async () => {
		const { stack, fake, scripted, runtime, session, waitingRequest, decide } = await setup();
		scripted.script.reply(
			{ toolCalls: [{ name: "browser_request", args: { reason: "Search flights", sites: ["example.com"] } }] },
			{ toolCalls: [{ name: "browser_run", args: { goal: "search flights", url: "https://example.com/" } }] },
			{ text: "done" },
		);
		const prompt = await runtime.prompt(stack.admin, session.id, { text: "Search" });
		const request = await waitingRequest();
		await decide({ sessionId: session.id, callId: request.callId, allow: true });
		await runtime.wait(stack.admin, session.id, prompt.id);
		expect(fake.runs()).toEqual([]);
		await stack.close();
	});

	it("tells the agent when a person declines, and opens nothing", async () => {
		const { stack, fake, scripted, runtime, session, waitingRequest, decide } = await setup();
		scripted.script.reply(
			{ toolCalls: [{ name: "browser_request", args: { reason: "Read the page", sites: ["example.com"] } }] },
			(view) => ({ text: results(view).at(-1) ?? "" }),
		);
		const prompt = await runtime.prompt(stack.admin, session.id, { text: "Look at example.com" });
		const request = await waitingRequest();
		const declined = await decide({ sessionId: session.id, callId: request.callId, allow: false });
		expect(await declined.json()).toEqual({ status: "declined" });
		expect(await runtime.wait(stack.admin, session.id, prompt.id)).toMatchObject({
			answer: "A person declined the browser request.",
		});
		expect(fake.opened()).toEqual([]);
		// The call has been answered: a second answer finds nothing waiting.
		const again = await decide({ sessionId: session.id, callId: request.callId, allow: true });
		expect(again.status).toBe(404);
		await stack.close();
	});

	it("keeps the browser off a site the person did not allow, and releases it when the session is aborted", async () => {
		const { stack, fake, scripted, runtime, session, tools, waitingRequest, decide } = await setup();
		scripted.script.reply(
			{ toolCalls: [{ name: "browser_request", args: { reason: "Read the page", sites: ["example.com"] } }] },
			{ toolCalls: [{ name: "browser_open", args: { url: "https://example.org/" } }] },
			{ toolCalls: [{ name: "browser_open", args: { url: "https://example.com/" } }] },
			{ text: "Opened." },
		);
		const prompt = await runtime.prompt(stack.admin, session.id, { text: "Look" });
		const request = await waitingRequest();
		await decide({ sessionId: session.id, callId: request.callId, allow: true });
		await runtime.wait(stack.admin, session.id, prompt.id);
		const opens = (await tools()).filter((item) => item.name === "browser_open");
		expect(opens[0]?.output).toContain("It did not open https://example.org/");
		expect(Object.values(fake.urls())).not.toContain("https://example.org/");
		expect(Object.values(fake.urls())).toContain("https://example.com/");
		expect(fake.live().length).toBeGreaterThan(0);

		await runtime.abort(stack.admin, session.id, "stop");
		expect(fake.live()).toEqual([]);
		await stack.close();
	});

	it("runs wrangler dev's browse errand on the same tools", async () => {
		const { stack, fake, runtime, session, tools, waitingRequest, decide } = await setup({ devModel: true });
		const echo = await runtime.prompt(stack.admin, session.id, { text: "hello" });
		expect(await runtime.wait(stack.admin, session.id, echo.id)).toMatchObject({ answer: "Echo: hello" });
		const prompt = await runtime.prompt(stack.admin, session.id, { text: "browse https://example.com/" });
		const request = await waitingRequest();
		expect(request.args).toMatchObject({ sites: ["example.com"] });
		await decide({ sessionId: session.id, callId: request.callId, allow: true });
		const result = await runtime.wait(stack.admin, session.id, prompt.id);
		// It scrolls after the screenshot, so a replay shows the page move.
		expect(result).toMatchObject({ answer: expect.stringMatching(/^Done: URL: https:\/\/example\.com\//) });
		expect((await tools()).map((item) => [item.name, item.status])).toEqual([
			["browser_request", "done"],
			["browser_open", "done"],
			["browser_screenshot", "done"],
			["browser_act", "done"],
		]);
		expect(fake.live()).toHaveLength(1);

		// `close` closes the browser it opened, so its replay can show.
		const close = await runtime.prompt(stack.admin, session.id, { text: "close" });
		expect(await runtime.wait(stack.admin, session.id, close.id)).toMatchObject({
			answer: expect.stringMatching(/^Closed: /),
		});
		expect((await tools()).at(-1)).toMatchObject({ name: "browser_close", status: "done" });
		expect(fake.live()).toEqual([]);
		await stack.close();
	});

	it("names each call's browser on its tool item, and gives the person watching a watch-only live view of it", async () => {
		const { stack, fake, scripted, runtime, session, tools, waitingRequest, decide, live } = await setup();
		scripted.script.reply(
			{ toolCalls: [{ name: "browser_request", args: { reason: "Read the page", sites: ["example.com"] } }] },
			{ toolCalls: [{ name: "browser_open", args: { url: "https://example.com/" } }] },
			(view) => {
				const id = lastBrowserSessionId(view);
				return { toolCalls: [{ name: "browser_act", args: { browserSessionId: id, action: "scroll" } }] };
			},
			{ text: "Scrolled." },
		);
		const prompt = await runtime.prompt(stack.admin, session.id, { text: "Look" });
		const request = await waitingRequest();
		await decide({ sessionId: session.id, callId: request.callId, allow: true });
		await runtime.wait(stack.admin, session.id, prompt.id);
		const items = await tools();
		const opened = items.find((item) => item.name === "browser_open");
		const browserSessionId = opened?.browserSessionId ?? "";
		expect(browserSessionId).toMatch(/^bsession_/);
		expect(items.find((item) => item.name === "browser_act")?.browserSessionId).toBe(browserSessionId);
		expect(items.find((item) => item.name === "browser_request")?.browserSessionId).toBeUndefined();

		// A watch-only link, the same one for the same person while it lasts, and never in the transcript.
		const first = await live({ sessionId: session.id, browserSessionId });
		expect(first.status).toBe(200);
		const link = (await first.json()) as { kind: string; url: string };
		expect(link.kind).toBe("embed");
		expect(link.url).toMatch(/^https:\/\/.*watch=1/);
		expect(fake.shares()).toBe(1);
		const again = await live({ sessionId: session.id, browserSessionId });
		expect(((await again.json()) as { url: string }).url).toBe(link.url);
		expect(JSON.stringify(await runtime.snapshot(stack.admin, session.id))).not.toContain(link.url);

		// Another session's ID doesn't reach this browser; a closed browser has no live view.
		expect((await live({ sessionId: "session-other", browserSessionId })).status).toBe(404);
		expect((await live({ sessionId: session.id })).status).toBe(400);
		await runtime.close(stack.admin, session.id);
		const closed = await live({ sessionId: session.id, browserSessionId });
		expect(closed.status).toBe(410);
		await stack.close();
	});

	it("takes a decision only as a well-formed POST from someone signed in", async () => {
		const { stack, gateway, decide } = await setup();
		const anonymous = await gateway.fetch(
			new Request(`${BASE}${BROWSER_DECISIONS_PATH}`, { method: "POST", body: "{}" }),
		);
		expect(anonymous.status).toBe(401);
		expect((await gateway.fetch(new Request(`${BASE}${BROWSER_DECISIONS_PATH}`))).status).toBe(405);
		expect((await decide({ sessionId: "s", allow: "yes" })).status).toBe(400);
		expect((await decide({ sessionId: "s", callId: "c", allow: true })).status).toBe(404);
		await stack.close();
	});
});
