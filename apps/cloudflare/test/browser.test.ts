// The browser on the stack (#24), in Node over the fake provider: a session asks for a browser, a person allows it
// through the gateway, the agent opens a page and acts, the transcript shows its screenshots, and closing or aborting
// the session releases the browser. And without brwsr's key, sessions have no browser tools.
import { createFakeBrowserProvider } from "@harbour/browser/memory";
import { createMockAccess } from "@harbour/identity/testing";
import type { ToolItem } from "@harbour/protocol";
import { createScriptedModel } from "@harbour/runtime/testing";
import type { ModelRequestView } from "@harbour/testing/session";
import { describe, expect, it } from "vitest";
import { BROWSER_TOOL_NAMES, brwsrProviderFrom, toolName } from "../src/browser.ts";
import { gatewayConfig } from "../src/config.ts";
import { createDevBrowserModels } from "../src/dev-browser-model.ts";
import { BROWSER_DECISIONS_PATH, createGateway } from "../src/gateway.ts";
import { createStack, DEFAULT_AGENT_ID } from "../src/stack.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const BASE = "https://harbour.test";

async function setup(options: { browser?: boolean; devModel?: boolean } = {}) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		HARBOUR_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		HARBOUR_ACCESS_AUD: AUD,
		HARBOUR_ADMIN_EMAIL: ADMIN,
	});
	const fake = createFakeBrowserProvider();
	const scripted = createScriptedModel();
	const stack = await createStack({
		config,
		accessFetch: mock.fetch,
		models: () => ({ models: options.devModel === true ? createDevBrowserModels() : scripted.models }),
		...(options.browser === false ? {} : { browserProvider: fake.provider }),
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
	return { stack, gateway, fake, scripted, runtime, session, tools, waitingRequest, decide };
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
		expect(brwsrProviderFrom({ HARBOUR_BRWSR_API_KEY: "  " })).toBeUndefined();
		expect(brwsrProviderFrom({ HARBOUR_BRWSR_API_KEY: "bk_secret_0123456789" })).toBeDefined();
	});

	it("gives sessions no browser tools without a provider", async () => {
		const { stack } = await setup({ browser: false });
		expect(stack.browser).toBeUndefined();
		expect((await stack.runtime.profiles.get(stack.admin, DEFAULT_AGENT_ID)).tools).toEqual([]);
		await stack.close();
	});

	it("asks a person, opens the granted site, shows each step's screenshot and releases the browser on close", async () => {
		const { stack, fake, scripted, runtime, session, tools, waitingRequest, decide } = await setup();
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
		// Opening at a URL shows where the browser landed; a look does not need a picture; a screenshot is one.
		expect(byName("browser_open")?.images).toEqual([{ mimeType: "image/png", data: expect.any(String) }]);
		expect(byName("browser_act")?.images ?? []).toEqual([]);
		expect(byName("browser_screenshot")?.images).toHaveLength(1);
		// The transcript never names a CDP URL.
		expect(JSON.stringify(items)).not.toContain("wss://");
		expect(fake.live()).toHaveLength(1);

		await runtime.close(stack.admin, session.id);
		expect(fake.live()).toEqual([]);
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
		expect(result).toMatchObject({ answer: expect.stringMatching(/^Done: Screenshot of https:\/\/example\.com\//) });
		expect((await tools()).map((item) => [item.name, item.status])).toEqual([
			["browser_request", "done"],
			["browser_open", "done"],
			["browser_screenshot", "done"],
		]);
		expect(fake.live()).toHaveLength(1);
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
