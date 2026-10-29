import { browserTeardown } from "@harbour/browser";
import { createFakeBrowserProvider, createMemoryBrowser } from "@harbour/browser/memory";
import type { Browser, CallContext } from "@harbour/contracts";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { describe, expect, it } from "vitest";

const operator: CallContext = {
	actor: { kind: "service", serviceId: "supervisor" },
	organisationId: "org-1",
	projectId: "proj-1",
};

/** A memory runtime with one agent profile, and a browser broker on a fake provider wired by `wire`. */
async function setup(
	wire: (
		runtime: ReturnType<typeof createMemoryRuntime>,
		fake: ReturnType<typeof createFakeBrowserProvider>,
	) => Browser,
) {
	const { models } = createScriptedModel();
	const runtime = createMemoryRuntime({ models });
	const fake = createFakeBrowserProvider();
	const browser = wire(runtime, fake);
	await runtime.profiles.put(operator, {
		id: "agent-1",
		organisationId: "org-1",
		name: "Worker",
		model: { route: "default" },
		promptLayers: [],
		tools: [],
		skills: [],
		sandbox: { tiers: ["isolate"] },
		memoryScopes: [],
	});
	const context = await browser.putContext(operator, {
		owner: { kind: "organisation", organisationId: "org-1" },
		name: "sal",
		providerContextId: "brwsr-ctx",
	});
	/** Grants the session a browser and opens it as the session's agent. */
	const openIn = async (sessionId: string, persist = false) => {
		const grant = await browser.grant(operator, {
			sessionId,
			projectId: "proj-1",
			agentId: "agent-1",
			contextId: context.id,
			persist,
			timeoutMs: 600_000,
			allowedSites: ["example.com"],
		});
		const agent: CallContext = {
			actor: { kind: "agent", agentId: "agent-1", sessionId },
			organisationId: "org-1",
			projectId: "proj-1",
		};
		return browser.open(agent, { grantId: grant.id });
	};
	return { runtime, fake, browser, openIn };
}

describe("browser leases end with their agent session, through the memory runtime's session-end hook", () => {
	it("closing a session closes its browsers as session_ended and releases them, and leaves other sessions' alone", async () => {
		const { runtime, fake, browser, openIn } = await setup((runtime, fake) =>
			createMemoryBrowser({ provider: fake.provider, sessionEnd: runtime.sessionEnd }),
		);
		try {
			const session = await runtime.runtime.create(operator, { projectId: "proj-1", agentId: "agent-1" });
			const other = await runtime.runtime.create(operator, { projectId: "proj-1", agentId: "agent-1" });
			const mine = await openIn(session.id, true);
			const theirs = await openIn(other.id);

			await runtime.runtime.close(operator, session.id);

			expect(await browser.get(operator, mine.id)).toMatchObject({ status: "closed", endReason: "session_ended" });
			expect((await browser.get(operator, theirs.id)).status).toBe("open");
			expect(fake.live()).toHaveLength(1);
			const grants = await browser.listGrants(operator, { sessionId: session.id });
			expect(grants.map((grant) => grant.status)).toEqual(["ended"]);
		} finally {
			await runtime.close();
		}
	});

	it("aborting a parent closes its children's browsers as aborted, and they can open browsers again", async () => {
		const { runtime, fake, browser, openIn } = await setup((runtime, fake) =>
			createMemoryBrowser({ provider: fake.provider, sessionEnd: runtime.sessionEnd }),
		);
		try {
			const parent = await runtime.runtime.create(operator, { projectId: "proj-1", agentId: "agent-1" });
			const child = await runtime.runtime.create(operator, {
				projectId: "proj-1",
				agentId: "agent-1",
				parentSessionId: parent.id,
			});
			const parentBrowser = await openIn(parent.id);
			const childBrowser = await openIn(child.id, true);

			await runtime.runtime.abort(operator, parent.id);

			for (const opened of [parentBrowser, childBrowser]) {
				expect(await browser.get(operator, opened.id)).toMatchObject({ status: "closed", endReason: "aborted" });
			}
			expect(fake.live()).toEqual([]);
			const again = await openIn(child.id, true);
			expect(again.status).toBe("open");
		} finally {
			await runtime.close();
		}
	});

	it("serves a broker built without the hook through browserTeardown, registered by whoever wires the runtime", async () => {
		const { runtime, fake, browser, openIn } = await setup((runtime, fake) => {
			const broker = createMemoryBrowser({ provider: fake.provider });
			runtime.sessionEnd.register("browser", browserTeardown(broker));
			return broker;
		});
		try {
			const session = await runtime.runtime.create(operator, { projectId: "proj-1", agentId: "agent-1" });
			const opened = await openIn(session.id);
			await runtime.runtime.close(operator, session.id);
			expect(await browser.get(operator, opened.id)).toMatchObject({ status: "closed", endReason: "session_ended" });
			expect(fake.live()).toEqual([]);
		} finally {
			await runtime.close();
		}
	});

	it("refuses the teardown to anyone but the system, so an agent cannot end its own browsers through it", async () => {
		const browser = createMemoryBrowser();
		const teardown = browserTeardown(browser);
		const end = {
			sessionId: "s",
			organisationId: "org-1",
			projectId: "proj-1",
			agentId: "agent-1",
			reason: "session_ended" as const,
			endedBy: operator.actor,
			at: 0,
		};
		await expect(
			teardown({ actor: { kind: "agent", agentId: "agent-1", sessionId: "s" }, organisationId: "org-1" }, end),
		).rejects.toMatchObject({ code: "forbidden" });
	});
});
