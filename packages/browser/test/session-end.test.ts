import { createFakeBrowserProvider, createMemoryBrowser } from "@harbour/browser/memory";
import {
	type AuditEventInput,
	type CallContext,
	HarbourError,
	type SystemContext,
	systemContext,
} from "@harbour/contracts";
import { ManualClock } from "@harbour/testing/harness";
import { describe, expect, it } from "vitest";

const human: CallContext = {
	actor: { kind: "human", userId: "supervisor-1" },
	organisationId: "org-a",
	projectId: "proj-a",
};
const agentIn = (sessionId: string): CallContext => ({
	actor: { kind: "agent", agentId: `agent-${sessionId}`, sessionId },
	organisationId: "org-a",
	projectId: "proj-a",
});

describe("the in-memory browser's endSession", () => {
	it("ends the session's browsers and grants even when sweeping another session's timeout fails, then rejects", async () => {
		const clock = new ManualClock();
		const fake = createFakeBrowserProvider();
		// Audit fails only for the other session's timeout, which the sweep closes first.
		const browser = createMemoryBrowser({
			clock,
			provider: fake.provider,
			audit: {
				append: async (_ctx: SystemContext, events: readonly AuditEventInput[]) => {
					if (events.some((event) => event.type === "browser.session.closed" && event.sessionId === "sess-other")) {
						throw new HarbourError("unavailable", "The audit sink is down");
					}
				},
			},
		});
		const context = await browser.putContext(human, {
			owner: { kind: "project", organisationId: "org-a", projectId: "proj-a" },
			name: "sal",
			providerContextId: "provider-ctx",
		});
		const grantTo = (sessionId: string, timeoutMs: number) =>
			browser.grant(human, {
				sessionId,
				projectId: "proj-a",
				agentId: `agent-${sessionId}`,
				contextId: context.id,
				persist: false,
				timeoutMs,
				allowedSites: ["github.com"],
			});
		const other = await grantTo("sess-other", 1_000);
		const mine = await grantTo("sess-mine", 60_000);
		await browser.open(agentIn("sess-other"), { grantId: other.id });
		const opened = await browser.open(agentIn("sess-mine"), { grantId: mine.id });
		clock.advance(5_000);

		await expect(browser.endSession(systemContext("test"), "sess-mine", "session_ended")).rejects.toMatchObject({
			code: "unavailable",
		});

		expect((await browser.get(human, opened.id)).status).toBe("closed");
		const grants = await browser.listGrants(human, { sessionId: "sess-mine" });
		expect(grants.map((grant) => grant.status)).toEqual(["ended"]);
	});
});
