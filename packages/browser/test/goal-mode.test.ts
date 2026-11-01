import {
	BROWSER_RUN_CAPABILITY,
	browserCapabilityHandler,
	browserRunCapability,
	renderRun,
} from "@kantel/browser/capabilities";
import { createFakeBrowserProvider, createMemoryBrowser } from "@kantel/browser/memory";
import { createMemoryCapabilityRegistry } from "@kantel/codemode/memory";
import type { BrowserRunResult, CallContext, JsonValue } from "@kantel/contracts";
import { RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const human: CallContext = { actor: { kind: "human", userId: "supervisor-1" }, organisationId: "org-a" };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: "org-a",
	projectId: "proj-a",
};

async function setup(options: { readonly runModel?: "clef" | "jev"; readonly noRun?: boolean } = {}) {
	const fake = createFakeBrowserProvider();
	const provider = options.noRun ? { ...fake.provider, run: undefined } : fake.provider;
	const audit = new RecordingAuditSink();
	const browser = createMemoryBrowser({ provider, audit });
	const registry = createMemoryCapabilityRegistry();
	await registry.register(
		human,
		[browserRunCapability],
		browserCapabilityHandler({ browser, ...(options.runModel === undefined ? {} : { runModel: options.runModel }) }),
	);
	await registry.grant(human, { selector: { sessionId: "session-1" }, capabilities: ["browser.*"] });
	const context = await browser.putContext(human, {
		owner: { kind: "organisation", organisationId: "org-a" },
		name: "atlas",
		providerContextId: "ctx",
	});
	await browser.grant(human, {
		sessionId: "session-1",
		projectId: "proj-a",
		agentId: "agent-1",
		contextId: context.id,
		persist: false,
		timeoutMs: 60_000,
		allowedSites: ["example.com", "*.example.com"],
	});
	let calls = 0;
	const call = async (args: JsonValue) => {
		calls += 1;
		const result = await registry.invoke(agent, { callId: `call-${calls}`, capability: BROWSER_RUN_CAPABILITY, args });
		return { ...result, output: result.output as { readonly [key: string]: JsonValue } };
	};
	return { fake, audit, browser, call };
}

describe("browser.run (goal mode)", () => {
	it("is a host capability with honest replay, and names no context", () => {
		expect([browserRunCapability.name, browserRunCapability.replay, browserRunCapability.runsIn]).toEqual([
			BROWSER_RUN_CAPABILITY,
			"unsafe",
			"host",
		]);
		expect(JSON.stringify(browserRunCapability.inputSchema)).not.toContain("context");
	});

	it("opens a browser at url, hands the goal and its data to the provider on the project's model, and audits no goal", async () => {
		const { fake, audit, call } = await setup({ runModel: "jev" });
		const ran = await call({
			goal: "search one-way flights",
			data: { from: "Manchester", to: "Amsterdam" },
			url: "https://www.example.com/flights",
		});
		expect(ran.isError).toBeUndefined();
		expect(ran.output.status).toBe("done");
		expect(String(ran.output.text)).toContain("The goal is met.");
		expect(String(ran.output.text)).toContain("URL: https://www.example.com/flights");
		expect(fake.runs()).toEqual([
			expect.objectContaining({
				model: "jev",
				goal: expect.objectContaining({
					goal: "search one-way flights",
					data: { from: "Manchester", to: "Amsterdam" },
				}),
			}),
		]);
		const event = audit.events.find((each) => each.type === "browser.session.run");
		expect(event?.data).toMatchObject({ status: "done", steps: 1, model: "jev", host: "www.example.com" });
		expect(JSON.stringify(event)).not.toContain("Manchester");
		expect(JSON.stringify(event)).not.toContain("search one-way");
	});

	it("fails without a model: goal mode is off", async () => {
		const { fake, call } = await setup();
		const ran = await call({ goal: "anything", url: "https://example.com" });
		expect(ran.isError).toBe(true);
		expect(String(ran.output.text)).toContain("goal mode is off");
		expect(fake.runs()).toEqual([]);
	});

	it("refuses a url off the grant's sites before it starts", async () => {
		const { fake, browser, call } = await setup({ runModel: "clef" });
		const opened = await browser.open(agent, {
			grantId: (await browser.listGrants(agent, { sessionId: "session-1" }))[0]?.id ?? "",
		});
		const ran = await call({ goal: "go", browserSessionId: opened.id, url: "https://elsewhere.test/" });
		expect(ran.isError).toBe(true);
		expect(fake.runs()).toEqual([]);
	});

	it("sends a run that ends off the grant's sites to about:blank and refuses it", async () => {
		const { fake, call } = await setup({ runModel: "clef" });
		fake.nextClickLandsOn("https://elsewhere.test/landed");
		const ran = await call({ goal: "go", url: "https://example.com/" });
		expect(ran.isError).toBe(true);
		expect(Object.values(fake.urls())).toEqual(["about:blank"]);
	});

	it("is unavailable on a provider without goal mode", async () => {
		const { call } = await setup({ runModel: "clef", noRun: true });
		const ran = await call({ goal: "go", url: "https://example.com/" });
		expect(ran.isError).toBe(true);
		expect(String(ran.output.text)).toContain("no goal mode");
	});

	it("refuses an empty goal and unknown arguments", async () => {
		const { call } = await setup({ runModel: "clef" });
		expect((await call({ goal: " ", url: "https://example.com/" })).isError).toBe(true);
		expect((await call({ goal: "go", password: "x" })).isError).toBe(true);
	});

	it("renders a hand-back with its best guesses as element IDs", () => {
		const result: BrowserRunResult = {
			status: "needs_supervisor",
			steps: ["filled “From” with from"],
			handBack: {
				reason: "low_confidence",
				detail: "Which date picker cell is 14 November?",
				candidates: [{ id: "12", p: 0.41, describe: 'button "14"' }],
			},
			page: { url: "https://example.com/", title: "Flights", text: "", elements: [], succeeded: true },
			usage: { decisions: 3, ms: 2400 },
		};
		const text = renderRun(result);
		expect(text).toContain("It handed back to you");
		expect(text).toContain("Handed back (low confidence): Which date picker cell is 14 November?");
		expect(text).toContain('[12] button "14" (0.41)');
		expect(text).toContain("Steps (1, 3 decisions, 2.4 s):");
	});
});
