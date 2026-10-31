import {
	BROWSER_ACT_CAPABILITY,
	BROWSER_CLOSE_CAPABILITY,
	BROWSER_OPEN_CAPABILITY,
	BROWSER_REQUEST_CAPABILITY,
	BROWSER_SCREENSHOT_CAPABILITY,
	browserCapabilities,
	browserCapabilityHandler,
	elementId,
	MAX_PAGE_TEXT,
	renderPage,
} from "@kantel/browser/capabilities";
import { createFakeBrowserProvider, createMemoryBrowser } from "@kantel/browser/memory";
import { createMemoryCapabilityRegistry } from "@kantel/codemode/memory";
import type { Browser, BrowserAction, CallContext, CapabilityInvocation, JsonValue } from "@kantel/contracts";
import { RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const human: CallContext = { actor: { kind: "human", userId: "supervisor-1" }, organisationId: "org-a" };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: "org-a",
	projectId: "proj-a",
};

async function setup() {
	const fake = createFakeBrowserProvider();
	const audit = new RecordingAuditSink();
	const browser = createMemoryBrowser({ provider: fake.provider, audit });
	const registry = createMemoryCapabilityRegistry();
	await registry.register(human, browserCapabilities, browserCapabilityHandler({ browser }));
	await registry.grant(human, { selector: { sessionId: "session-1" }, capabilities: ["browser.*"] });
	const context = await browser.putContext(human, {
		owner: { kind: "organisation", organisationId: "org-a" },
		name: "sal",
		providerContextId: "brwsr-ctx-never-shown",
	});
	const grant = (sites: readonly string[] = ["example.com", "*.example.com"], requestId?: string) =>
		browser.grant(human, {
			sessionId: "session-1",
			projectId: "proj-a",
			agentId: "agent-1",
			contextId: context.id,
			persist: false,
			timeoutMs: 60_000,
			allowedSites: sites,
			...(requestId === undefined ? {} : { requestId }),
		});
	let calls = 0;
	const call = async (capability: string, args: JsonValue) => {
		calls += 1;
		const result = await registry.invoke(agent, { callId: `call-${calls}`, capability, args });
		return { ...result, output: result.output as { readonly [key: string]: JsonValue } };
	};
	return { fake, audit, browser, registry, grant, call };
}

describe("browser capabilities", () => {
	it("defines request, open, act, screenshot and close as host capabilities with honest replay", () => {
		expect(browserCapabilities.map((definition) => [definition.name, definition.replay, definition.runsIn])).toEqual([
			[BROWSER_REQUEST_CAPABILITY, "unsafe", "host"],
			[BROWSER_OPEN_CAPABILITY, "unsafe", "host"],
			[BROWSER_ACT_CAPABILITY, "unsafe", "host"],
			[BROWSER_SCREENSHOT_CAPABILITY, "safe", "host"],
			[BROWSER_CLOSE_CAPABILITY, "idempotent", "host"],
		]);
		for (const definition of browserCapabilities) {
			expect(JSON.stringify(definition.inputSchema), definition.name).not.toContain("context");
		}
	});

	it("says every step returns the page, so a step needs no look after it", () => {
		const about = (name: string) => browserCapabilities.find((definition) => definition.name === name)!.description;
		expect(about(BROWSER_ACT_CAPABILITY)).toContain("Every step returns the page as it is after the step");
		expect(about(BROWSER_ACT_CAPABILITY)).toContain("no need to look after a step");
		expect(about(BROWSER_ACT_CAPABILITY)).toContain("one at a time");
		expect(about(BROWSER_OPEN_CAPABILITY)).toContain("also returns that page");
		expect(about(BROWSER_SCREENSHOT_CAPABILITY)).toContain("every step already returns the page");
	});

	it("asks for a browser, opens it once granted, steps, screenshots and closes it, never showing the provider context", async () => {
		const { fake, browser, grant, call } = await setup();
		const none = await call(BROWSER_OPEN_CAPABILITY, {});
		expect(none.isError).toBe(true);
		expect(String(none.output.text)).toContain("browser.request");

		const asked = await call(BROWSER_REQUEST_CAPABILITY, { reason: "Read the docs", sites: ["example.com"] });
		expect(asked.isError).toBeUndefined();
		await grant(["example.com", "*.example.com"], String(asked.output.requestId));

		const opened = await call(BROWSER_OPEN_CAPABILITY, { url: "https://example.com/docs" });
		expect(opened.isError).toBeUndefined();
		const browserSessionId = String(opened.output.browserSessionId);
		expect(opened.output.cdpUrl).toMatch(/^wss:\/\/browser\.invalid\//);
		expect(opened.output.allowedSites).toEqual(["example.com", "*.example.com"]);
		expect(String(opened.output.text)).toContain("URL: https://example.com/docs");

		const clicked = await call(BROWSER_ACT_CAPABILITY, { browserSessionId, action: "click", element: "1" });
		expect(clicked.isError).toBeUndefined();
		expect(clicked.output.url).toBe("https://example.com/docs");
		expect(String(clicked.output.text)).toContain("[1] link");

		const shot = await call(BROWSER_SCREENSHOT_CAPABILITY, { browserSessionId });
		expect(shot.output).toMatchObject({ url: "https://example.com/docs", image: { mimeType: "image/png" } });

		const closed = await call(BROWSER_CLOSE_CAPABILITY, { browserSessionId });
		expect(closed.isError).toBeUndefined();
		expect(fake.live()).toEqual([]);
		expect((await browser.get(human, browserSessionId)).endReason).toBe("closed");

		const after = await call(BROWSER_ACT_CAPABILITY, { browserSessionId, action: "look" });
		expect(after.isError).toBe(true);
		expect(String(after.output.text)).toContain("expired");

		for (const result of [opened, clicked, shot, closed]) {
			expect(JSON.stringify(result.output)).not.toContain("brwsr-ctx-never-shown");
		}
	});

	it("refuses a goto off the grant's sites and blanks a page a click landed on off them", async () => {
		const { fake, audit, grant, call } = await setup();
		await grant(["example.com"]);
		const opened = await call(BROWSER_OPEN_CAPABILITY, { url: "https://example.com/" });
		const browserSessionId = String(opened.output.browserSessionId);

		const away = await call(BROWSER_ACT_CAPABILITY, { browserSessionId, action: "goto", url: "https://evil.test/x" });
		expect(away.isError).toBe(true);
		expect(String(away.output.text)).toContain("refused");
		expect(Object.values(fake.urls())).toEqual(["https://example.com/"]);

		fake.nextClickLandsOn("https://evil.test/landing?token=secret");
		const landed = await call(BROWSER_ACT_CAPABILITY, { browserSessionId, action: "click", element: "1" });
		expect(landed.isError).toBe(true);
		expect(JSON.stringify(landed.output)).not.toContain("The fake page at https://evil.test");
		expect(Object.values(fake.urls())).toEqual(["about:blank"]);

		const refusals = audit.ofType("browser.site.refused");
		expect(refusals.map((event) => event.data)).toEqual([
			{ step: "goto", host: "evil.test", why: "asked" },
			{ step: "click", host: "evil.test", why: "landed" },
		]);
		expect(JSON.stringify(refusals)).not.toContain("secret");
	});

	it("opens at a URL off the grant but says it did not go there", async () => {
		const { fake, grant, call } = await setup();
		await grant(["example.com"]);
		const opened = await call(BROWSER_OPEN_CAPABILITY, { url: "https://evil.test/" });
		expect(opened.isError).toBeUndefined();
		expect(String(opened.output.text)).toContain("It did not open https://evil.test/");
		expect(Object.values(fake.urls())).toEqual(["about:blank"]);
	});

	it("picks the grant whose sites allow the URL, and asks for grantId when that does not settle it", async () => {
		const { fake, grant, call } = await setup();
		await grant(["example.com"]);
		const github = await grant(["github.com"]);
		const ambiguous = await call(BROWSER_OPEN_CAPABILITY, {});
		expect(ambiguous.isError).toBe(true);
		expect(String(ambiguous.output.text)).toContain(github.id);
		const picked = await call(BROWSER_OPEN_CAPABILITY, { url: "https://github.com/tvdavies" });
		expect(picked.output.allowedSites).toEqual(["github.com"]);
		const named = await call(BROWSER_OPEN_CAPABILITY, { grantId: github.id });
		expect(named.isError).toBeUndefined();
		expect(fake.live()).toHaveLength(2);
	});

	it("explains bad arguments instead of throwing", async () => {
		const { grant, call } = await setup();
		await grant();
		const opened = await call(BROWSER_OPEN_CAPABILITY, {});
		const browserSessionId = String(opened.output.browserSessionId);
		for (const [args, says] of [
			[{ browserSessionId, action: "click" }, "element"],
			[{ browserSessionId, action: "fill", element: "1" }, "value"],
			[{ browserSessionId, action: "press", key: "Enter; rm" }, "invalid"],
			[{ browserSessionId, action: "fly" }, "action must be one of"],
			[{ browserSessionId, action: "look", context: "sal" }, "unknown argument context"],
			[{ browserSessionId: "bsession_nope", action: "look" }, "not_found"],
		] as const) {
			const result = await call(BROWSER_ACT_CAPABILITY, args);
			expect(result.isError, JSON.stringify(args)).toBe(true);
			expect(String(result.output.text), JSON.stringify(args)).toContain(says);
		}
	});

	it("never acts on another session's browser", async () => {
		const { browser, grant } = await setup();
		const mine = await grant();
		const opened = await browser.open(agent, { grantId: mine.id });
		const handler = browserCapabilityHandler({ browser });
		const intruder: CapabilityInvocation = {
			callId: "call-x",
			capability: BROWSER_ACT_CAPABILITY,
			version: "1",
			args: { browserSessionId: opened.id, action: "look" },
			organisationId: "org-a",
			projectId: "proj-a",
			sessionId: "session-2",
			agentId: "agent-2",
		};
		const result = await handler(intruder, new AbortController().signal);
		expect(result.isError).toBe(true);
		expect(String((result.output as { text: string }).text)).toContain("not_found");
	});
});

describe("element IDs", () => {
	it("reads [4], #4 and 4 as element 4", () => {
		for (const raw of ["4", "[4]", "#4", " [4] ", "[ 4 ]", "[#4]", "# 4"]) expect(elementId(raw), raw).toBe("4");
		expect(elementId("b-12")).toBe("b-12");
		expect(elementId("[]")).toBe("[]");
		expect(elementId(undefined)).toBeUndefined();
	});

	it("passes the bare ID to the browser for click, check, fill and select", async () => {
		const steps: BrowserAction[] = [];
		const browser = {
			async act(_ctx: CallContext, _id: string, action: BrowserAction) {
				steps.push(action);
				return { url: "https://example.com/", title: "Example", text: "", elements: [], succeeded: true };
			},
		} as unknown as Browser;
		const handler = browserCapabilityHandler({ browser });
		const invoke = (args: JsonValue) =>
			handler(
				{
					callId: "call-1",
					capability: BROWSER_ACT_CAPABILITY,
					version: "1",
					args,
					organisationId: "org-a",
					projectId: "proj-a",
					sessionId: "session-1",
					agentId: "agent-1",
				},
				new AbortController().signal,
			);
		const browserSessionId = "bsession_1";
		await invoke({ browserSessionId, action: "click", element: "[4]" });
		await invoke({ browserSessionId, action: "check", element: "#5" });
		await invoke({ browserSessionId, action: "fill", element: "[49]", value: "after 9am" });
		await invoke({ browserSessionId, action: "select", element: "7", value: "Economy" });
		expect(steps).toEqual([
			{ kind: "click", element: "4" },
			{ kind: "check", element: "5" },
			{ kind: "fill", element: "49", value: "after 9am" },
			{ kind: "select", element: "7", value: "Economy" },
		]);
	});

	it("says in the schema that the listing's [4] is element 4", () => {
		const act = browserCapabilities.find((definition) => definition.name === BROWSER_ACT_CAPABILITY)!;
		const element = (act.inputSchema as { properties: { element: { description: string } } }).properties.element;
		expect(element.description).toContain("[4]");
	});
});

describe("renderPage", () => {
	it("cuts long text and long element lists", () => {
		const page = {
			url: "https://example.com/",
			title: "Example",
			text: "x".repeat(MAX_PAGE_TEXT + 10),
			elements: Array.from({ length: 305 }, (_, index) => ({ id: String(index), describe: `button ${index}` })),
			succeeded: false,
			did: "click button 1",
		};
		const text = renderPage(page);
		expect(text).toContain("Failed: click button 1");
		expect(text).toContain("[cut]");
		expect(text).toContain("[299] button 299");
		expect(text).not.toContain("[300]");
		expect(text).toContain("(5 more not shown");
	});
});
