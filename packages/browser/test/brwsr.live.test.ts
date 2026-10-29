/**
 * The broker on real brwsr. Opt-in, like the GitHub seeding test: it runs only with HARBOUR_TEST_BRWSR=1 and a brwsr
 * project key in BRWSR_API_KEY (BRWSR_API_URL optional), never in CI. It opens at most two browsers at once on the
 * context named by HARBOUR_TEST_BRWSR_CONTEXT (default `harbour-test`, made if missing) and releases every one.
 */
import { createBrwsrProvider } from "@harbour/browser/brwsr";
import { createMemoryBrowser } from "@harbour/browser/memory";
import { type BrowserProvider, type CallContext, systemContext } from "@harbour/contracts";
import { describe, expect, it } from "vitest";

const apiKey = process.env.BRWSR_API_KEY ?? "";
const apiUrl = process.env.BRWSR_API_URL || undefined;
const enabled = process.env.HARBOUR_TEST_BRWSR === "1" && apiKey !== "";
const contextName = process.env.HARBOUR_TEST_BRWSR_CONTEXT || "harbour-test";

const human: CallContext = { actor: { kind: "human", userId: "live-test" }, organisationId: "org-live" };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-live", sessionId: "session-live" },
	organisationId: "org-live",
	projectId: "proj-live",
};

describe.skipIf(!enabled)("the browser broker on brwsr.dev (HARBOUR_TEST_BRWSR=1)", () => {
	it("opens, steps, refuses off-grant pages, screenshots, shares and ends every browser with its session", async () => {
		const brwsr = createBrwsrProvider({
			apiKey,
			...(apiUrl === undefined ? {} : { apiUrl }),
			userMetadata: { agent: "harbour-live-test" },
		});
		const opened: string[] = [];
		// Records every browser opened, so the test releases them whatever happens.
		const provider: BrowserProvider = {
			...brwsr,
			async open(input) {
				const result = await brwsr.open(input);
				opened.push(result.providerSessionId);
				return result;
			},
		};
		const status = async (providerSessionId: string) => {
			const response = await fetch(`${apiUrl ?? "https://api.brwsr.dev"}/v1/sessions/${providerSessionId}`, {
				headers: { "x-bb-api-key": apiKey },
			});
			return ((await response.json()) as { status?: string }).status;
		};
		const browser = createMemoryBrowser({ provider });
		try {
			const context = await browser.putContext(human, {
				owner: { kind: "organisation", organisationId: "org-live" },
				name: contextName,
				providerContextId: await brwsr.contextId(contextName),
			});
			const grant = await browser.grant(human, {
				sessionId: "session-live",
				projectId: "proj-live",
				agentId: "agent-live",
				contextId: context.id,
				persist: true,
				timeoutMs: 120_000,
				allowedSites: ["example.com"],
			});
			const session = await browser.open(agent, { grantId: grant.id });
			expect(session.cdpUrl).toMatch(/^wss:\/\//);
			await expect(browser.open(agent, { grantId: grant.id })).rejects.toMatchObject({ code: "conflict" });

			const page = await browser.act(agent, session.id, { kind: "goto", url: "https://example.com/" });
			expect(page.url).toBe("https://example.com/");
			expect(page.title).toBe("Example Domain");
			const link = page.elements.find((element) => /learn more/i.test(element.describe));
			expect(link, JSON.stringify(page.elements)).toBeDefined();

			const shot = await browser.screenshot(agent, session.id);
			expect(shot).toMatchObject({ url: "https://example.com/", mimeType: "image/jpeg" });
			expect(shot.data.length).toBeGreaterThan(1000);

			await expect(
				browser.act(agent, session.id, { kind: "goto", url: "https://www.iana.org/" }),
			).rejects.toMatchObject({ code: "refused" });
			// "Learn more" goes to www.iana.org, off the grant: the broker blanks the browser and refuses.
			await expect(browser.act(agent, session.id, { kind: "click", element: link!.id })).rejects.toMatchObject({
				code: "refused",
			});
			expect((await browser.act(agent, session.id, { kind: "look" })).url).toBe("about:blank");

			const share = await browser.share(human, session.id);
			expect(share.url).toMatch(/^https:\/\//);

			await browser.endSession(systemContext("live-test"), "session-live", "session_ended");
			expect(await browser.get(human, session.id)).toMatchObject({ status: "closed", endReason: "session_ended" });
			expect(await status(opened[0]!)).not.toBe("RUNNING");
		} finally {
			await Promise.allSettled(opened.map((id) => brwsr.release(id)));
		}
	}, 120_000);
});
