// What the broker adds for Kantel's own browsers (packages/browser/CONTRACT.md): the grant's sites go to the
// provider, each step is audited by its verb and host only, and replay links follow share links' rules.
import { createFakeBrowserProvider, createMemoryBrowser } from "@kantel/browser/memory";
import type { AuditEventInput, BrowserProvider, CallContext, SystemContext } from "@kantel/contracts";
import { ManualClock } from "@kantel/testing/harness";
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

async function setup(options: { replay?: boolean; recording?: boolean } = {}) {
	const fake = createFakeBrowserProvider();
	const sites: (readonly string[] | undefined)[] = [];
	const replays: string[] = [];
	const shares: { minutes: number; control: boolean | undefined }[] = [];
	const provider: BrowserProvider = {
		...fake.provider,
		async release(providerSessionId) {
			await fake.provider.release(providerSessionId);
			return options.recording === true
				? { recording: { pages: 2, frames: 40, durationMs: 9_000, expiresAt: 7 * 86_400_000 } }
				: undefined;
		},
		async share(providerSessionId, minutes, signal, shareOptions) {
			shares.push({ minutes, control: shareOptions?.control });
			return fake.provider.share(providerSessionId, minutes, signal, shareOptions);
		},
		async open(input) {
			sites.push(input.allowedSites);
			return fake.provider.open(input);
		},
		...(options.replay === false
			? {}
			: {
					async replay(providerSessionId: string, minutes: number) {
						replays.push(providerSessionId);
						return { url: `/browser/${providerSessionId}#token-for-${minutes}`, expiresAt: 0 };
					},
				}),
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
		allowedSites: ["github.com", "*.example.org"],
	});
	const opened = await browser.open(agent, { grantId: grant.id });
	return { browser, opened, events, sites, replays, shares };
}

describe("the broker over Kantel's own browsers", () => {
	it("tells the provider the grant's sites, for the browser's own guard", async () => {
		const { sites } = await setup();
		expect(sites).toEqual([["github.com", "*.example.org"]]);
	});

	it("audits each step by its verb and the host it ended on, never a value or the whole URL", async () => {
		const { browser, opened, events } = await setup();
		await browser.act(agent, opened.id, { kind: "goto", url: "https://github.com/login?return_to=%2Fsecret-repo" });
		await browser.act(agent, opened.id, { kind: "fill", element: "1", value: "correct horse battery staple" });
		await browser.act(agent, opened.id, { kind: "look" });
		const steps = events.filter((event) => event.type === "browser.session.step");
		expect(steps.map((event) => event.data)).toEqual([
			{ step: "goto", host: "github.com", succeeded: true },
			{ step: "fill", host: "github.com", succeeded: true },
		]);
		const everything = JSON.stringify(events);
		expect(everything).not.toContain("correct horse");
		expect(everything).not.toContain("secret-repo");
	});

	it("makes a replay link for a person who may view the session, and audits it", async () => {
		const { browser, opened, events, replays } = await setup();
		await browser.close(agent, opened.id);
		const link = await browser.replay(human, opened.id, { minutes: 15 });
		expect(link.url).toMatch(/^\/browser\/fake_[\w-]+#token-for-15$/);
		expect(replays).toHaveLength(1);
		const shared = events.filter((event) => event.type === "browser.session.shared");
		expect(shared.map((event) => event.data)).toEqual([{ minutes: 15, replay: true }]);
		// The link itself is never audited.
		expect(JSON.stringify(events)).not.toContain("token-for");
	});

	it("never gives an agent a replay link", async () => {
		const { browser, opened } = await setup();
		await expect(browser.replay(agent, opened.id, { minutes: 15 })).rejects.toMatchObject({ code: "forbidden" });
	});

	it("refuses a replay link of a length share links don't have", async () => {
		const { browser, opened } = await setup();
		await expect(browser.replay(human, opened.id, { minutes: 7 })).rejects.toMatchObject({ code: "invalid" });
	});

	it("makes an outside app's live embed watch-only, for 5 to 60 minutes, and audits it without the link", async () => {
		const { browser, opened, events, shares } = await setup();
		const link = await browser.embed(human, opened.id, { mode: "live" });
		await browser.embed(human, opened.id, { mode: "live", minutes: 5 });
		expect(shares).toEqual([
			{ minutes: 15, control: false },
			{ minutes: 5, control: false },
		]);
		const embedded = events.filter((event) => event.type === "browser.session.embedded");
		expect(embedded.map((event) => [event.data, event.subject])).toEqual([
			[
				{ mode: "live", minutes: 15 },
				{ kind: "browser.session", id: opened.id },
			],
			[
				{ mode: "live", minutes: 5 },
				{ kind: "browser.session", id: opened.id },
			],
		]);
		expect(JSON.stringify(events)).not.toContain(link.url);
		for (const minutes of [4, 61, 7.5]) {
			await expect(browser.embed(human, opened.id, { mode: "live", minutes })).rejects.toMatchObject({
				code: "invalid",
			});
		}
	});

	it("embeds a closed browser's replay, but not its live view, and never for an agent", async () => {
		const { browser, opened, replays } = await setup();
		await browser.close(agent, opened.id);
		await expect(browser.embed(human, opened.id, { mode: "live" })).rejects.toMatchObject({ code: "expired" });
		const link = await browser.embed(human, opened.id, { mode: "replay", minutes: 30 });
		expect(link.url).toMatch(/#token-for-30$/);
		expect(replays).toHaveLength(1);
		await expect(browser.embed(agent, opened.id, { mode: "replay" })).rejects.toMatchObject({ code: "forbidden" });
		await expect(browser.embed(human, opened.id, { mode: "control" as unknown as "live" })).rejects.toMatchObject({
			code: "invalid",
		});
	});

	it("audits the stored recording once the browser closes, by its counts only", async () => {
		const { browser, opened, events } = await setup({ recording: true });
		await browser.close(agent, opened.id);
		const stored = events.filter((event) => event.type === "browser.recording.stored");
		expect(stored.map((event) => [event.subject, event.data, event.sessionId])).toEqual([
			[
				{ kind: "browser.session", id: opened.id },
				{ pages: 2, frames: 40, durationMs: 9_000, expiresAt: 7 * 86_400_000 },
				"sess-1",
			],
		]);
	});

	it("audits no recording when the provider stored none", async () => {
		const { browser, opened, events } = await setup();
		await browser.close(agent, opened.id);
		expect(events.some((event) => event.type === "browser.recording.stored")).toBe(false);
	});

	it("says a provider without recordings (brwsr) has no replays", async () => {
		const { browser, opened } = await setup({ replay: false });
		await expect(browser.replay(human, opened.id)).rejects.toMatchObject({ code: "unavailable" });
	});
});
