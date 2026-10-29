// The embed API (`POST /v1/sessions/{sessionId}/browsers/{browserSessionId}/embed`, docs/design/browser-runtime.md)
// over the broker: an outside app gets an absolute, watch-only link to frame, for its session's browser only.
import { createBrowserApi } from "@harbour/browser/http";
import { createFakeBrowserProvider, createMemoryBrowser } from "@harbour/browser/memory";
import type { AuditEventInput, BrowserProvider, CallContext, SystemContext } from "@harbour/contracts";
import { ManualClock } from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

const human: CallContext = {
	actor: { kind: "human", userId: "supervisor-1" },
	organisationId: "org-a",
	projectId: "proj-a",
};
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "sess-1" },
	organisationId: "org-a",
	projectId: "proj-a",
};

async function setup(publicOrigin?: string) {
	const fake = createFakeBrowserProvider();
	const provider: BrowserProvider = {
		...fake.provider,
		async share(_id, minutes, _signal, options) {
			return {
				url: `/browser/b1#live-${minutes}-${options?.control === true ? "control" : "watch"}`,
				expiresAt: 1_000 + minutes,
				embed: { url: `/browser/b1#live-${minutes}`, endMessage: "harbour-view-ended" },
			};
		},
		async replay(_id, minutes) {
			return { url: `/browser/b1#replay-${minutes}`, expiresAt: 2_000 };
		},
	};
	const events: AuditEventInput[] = [];
	const browser = createMemoryBrowser({
		clock: new ManualClock(),
		provider,
		audit: { append: async (_ctx: SystemContext, batch: readonly AuditEventInput[]) => void events.push(...batch) },
	});
	const context = await browser.putContext(human, {
		owner: { kind: "project", organisationId: "org-a", projectId: "proj-a" },
		name: "sal",
		providerContextId: "provider-ctx",
	});
	const grant = await browser.grant(human, {
		sessionId: "sess-1",
		projectId: "proj-a",
		agentId: "agent-1",
		contextId: context.id,
		persist: false,
		timeoutMs: 60_000,
		allowedSites: ["example.org"],
	});
	const opened = await browser.open(agent, { grantId: grant.id });
	let caller = human;
	const api = createBrowserApi({
		browser,
		authenticate: async () => caller,
		...(publicOrigin === undefined ? {} : { publicOrigin }),
	});
	const embed = (body: unknown, session = "sess-1", browserSessionId = opened.id) =>
		api.fetch(
			new Request(`https://harbour.test/v1/sessions/${session}/browsers/${browserSessionId}/embed`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	return { browser, opened, events, embed, asAgent: () => (caller = agent) };
}

describe("the embed API", () => {
	it("answers an absolute, watch-only live link and what the page posts when it ends", async () => {
		const { embed, events } = await setup();
		const response = await embed({ mode: "live" });
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			url: "https://harbour.test/browser/b1#live-15",
			mode: "live",
			expiresAt: 1_015,
			endMessage: "harbour-view-ended",
		});
		expect(events.filter((event) => event.type === "browser.session.embedded").map((event) => event.data)).toEqual([
			{ mode: "live", minutes: 15 },
		]);
	});

	it("makes the link absolute against the console's public origin when one is set", async () => {
		const { embed } = await setup("https://harbour.example.com");
		const response = await embed({ mode: "replay", minutes: 60 });
		expect(await response?.json()).toMatchObject({ url: "https://harbour.example.com/browser/b1#replay-60" });
	});

	it("refuses a mode or length it doesn't know before the broker sees it", async () => {
		const { embed, events } = await setup();
		for (const body of [{ mode: "control" }, { mode: "live", minutes: 61 }, { mode: "live", minutes: 4 }, {}]) {
			const response = await embed(body);
			expect(response?.status).toBe(400);
			expect(await response?.json()).toMatchObject({ error: { code: "invalid" } });
		}
		expect(events.some((event) => event.type === "browser.session.embedded")).toBe(false);
	});

	it("hides a browser of another session, and gives an agent no link", async () => {
		const { embed, asAgent } = await setup();
		expect((await embed({ mode: "live" }, "sess-2"))?.status).toBe(404);
		asAgent();
		expect((await embed({ mode: "live" }))?.status).toBe(403);
	});

	it("leaves every other path to the gateway's other routes", async () => {
		const { browser } = await setup();
		const api = createBrowserApi({ browser, authenticate: async () => human });
		expect(await api.fetch(new Request("https://harbour.test/v1/sessions/sess-1/messages"))).toBeUndefined();
		expect(await api.fetch(new Request("https://harbour.test/v1/browser/live"))).toBeUndefined();
	});
});
