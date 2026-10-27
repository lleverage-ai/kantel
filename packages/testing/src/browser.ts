/**
 * Conformance suite for `Browser` (packages/contracts/src/browser.ts). Its centre is one settled rule: a browser
 * context is chosen by a supervisor or a human and never by an agent. An agent in the parent session may only pass on,
 * no wider, a context it already holds. Every target registers it with a provider that builds a fresh broker on the
 * suite's clock and audit sink, wires `parentOf` to `setParent`, reports which provider sessions are still live, and
 * can make the provider fail releases or hold an open.
 */
import type {
	Actor,
	Browser,
	BrowserContext,
	BrowserGrant,
	CallContext,
	GrantBrowserInput,
	SessionId,
} from "@harbour/contracts";
import {
	actors,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";

export interface BrowserSubject {
	readonly browser: Browser;
	/** Provider session IDs opened and not yet released at the provider. */
	providerLive(): readonly string[];
	/** Records `parent` as the parent session of `child`; the broker's `parentOf` must read it. */
	setParent(child: SessionId, parent: SessionId): void;
	/** Makes the provider's next `times` releases throw, leaving their sessions live at the provider. */
	failReleases(times: number): void;
	/** Makes the provider's next `open` wait until the returned function is called. */
	holdNextOpen(): () => void;
}

export type BrowserConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: BrowserSubject) => Promise<void>,
) => Promise<void>;

const ORG = "org-a";
const OTHER_ORG = "org-b";
const PROJECT = "proj-a";
const SESSION = "session-child";
const PARENT_SESSION = "session-parent";
const GRANDCHILD_SESSION = "session-grandchild";
const UNRELATED_SESSION = "session-unrelated";
const AGENT = "agent-child";
const PARENT_AGENT = "agent-parent";
const GRANDCHILD_AGENT = "agent-grandchild";
/** A distinctive provider context ID; it must never appear in anything an agent sees. */
const PROVIDER_CONTEXT_ID = "brwsr-ctx-9c41e07a-never-show-agents";

const human = contextFor(actors.human("supervisor-1"), ORG, PROJECT);
const service = contextFor(actors.service("sal", "key-1"), ORG, PROJECT);
const agent = contextFor(actors.agent(AGENT, SESSION), ORG, PROJECT);
const parentAgent = contextFor(actors.agent(PARENT_AGENT, PARENT_SESSION), ORG, PROJECT);
const grandchildAgent = contextFor(actors.agent(GRANDCHILD_AGENT, GRANDCHILD_SESSION), ORG, PROJECT);
const unrelatedAgent = contextFor(actors.agent("agent-unrelated", UNRELATED_SESSION), ORG, PROJECT);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG);

function putContext(browser: Browser, name = "sal", providerContextId = PROVIDER_CONTEXT_ID): Promise<BrowserContext> {
	return browser.putContext(human, {
		owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
		name,
		providerContextId,
	});
}

function grantInput(contextId: string, extra: Partial<GrantBrowserInput> = {}): GrantBrowserInput {
	return {
		sessionId: SESSION,
		projectId: PROJECT,
		agentId: AGENT,
		contextId,
		persist: false,
		timeoutMs: 60_000,
		allowedSites: ["github.com", "*.github.com"],
		...extra,
	};
}

/** A human's grant of `contextId` to the parent session's agent, so it has something to pass on. */
function grantToParent(
	browser: Browser,
	contextId: string,
	extra: Partial<GrantBrowserInput> = {},
): Promise<BrowserGrant> {
	return browser.grant(human, grantInput(contextId, { sessionId: PARENT_SESSION, agentId: PARENT_AGENT, ...extra }));
}

/** Waits one macrotask, so every pending microtask has run and a call in flight has reached the provider. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function grantFresh(
	browser: Browser,
	extra: Partial<GrantBrowserInput> = {},
): Promise<{ context: BrowserContext; grant: BrowserGrant }> {
	const context = await putContext(browser);
	const grant = await browser.grant(human, grantInput(context.id, extra));
	return { context, grant };
}

function sameActor(actual: Actor, expected: Actor): boolean {
	return JSON.stringify(actual) === JSON.stringify(expected);
}

export function createBrowserConformance(options: {
	assertions: ConformanceAssertions;
	provider: BrowserConformanceProvider;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (
		name: string,
		body: (subject: BrowserSubject, deps: ConformanceDeps) => Promise<void>,
	): ConformanceCase => ({
		name,
		run: async () => {
			const deps = createDeps();
			await options.provider(deps, (subject) => body(subject, deps));
		},
	});

	/**
	 * Asserts that `ctx` granting `input` is refused, audited with the actor (and `reason`, if given), and adds no
	 * grant.
	 */
	async function assertGrantRefused(
		browser: Browser,
		deps: ConformanceDeps,
		ctx: CallContext,
		input: GrantBrowserInput,
		reason?: string,
	): Promise<void> {
		const before = deps.audit.ofType("browser.grant.refused").length;
		const grantsBefore = (await browser.listGrants(human, {})).length;
		const createdBefore = deps.audit.ofType("browser.grant.created").length;
		await assert.rejectsWithCode(browser.grant(ctx, input), "refused", "the grant is refused");
		const refusals = deps.audit.ofType("browser.grant.refused");
		assert.strictEqual(refusals.length, before + 1, "the refusal is audited");
		assert.deepEqual(refusals.at(-1)!.actor, ctx.actor, "the refusal names the actor");
		assert.strictEqual(refusals.at(-1)!.sessionId, input.sessionId, "the refusal names the target session");
		if (reason !== undefined) assert.strictEqual(refusals.at(-1)!.data?.reason, reason, "the refusal names why");
		assert.strictEqual((await browser.listGrants(human, {})).length, grantsBefore, "no grant was added");
		assert.strictEqual(
			deps.audit.ofType("browser.grant.created").length,
			createdBefore,
			"no grant was audited as created",
		);
	}

	/** Holds the provider's next open, starts `open`, ends the grant with `end` mid-open, then lets the open finish. */
	async function assertOpenInFlightExpires(
		subject: BrowserSubject,
		end: (browser: Browser, grant: BrowserGrant) => Promise<unknown>,
	): Promise<void> {
		const { browser } = subject;
		const { context, grant } = await grantFresh(browser, { persist: true });
		const letOpen = subject.holdNextOpen();
		const outcome = assert.rejectsWithCode(
			browser.open(agent, { grantId: grant.id }),
			"expired",
			"the open in flight fails as expired",
		);
		await settle();
		await end(browser, grant);
		letOpen();
		await outcome;
		assert.strictEqual(subject.providerLive().length, 0, "nothing is live at the provider");
		const fresh = await browser.grant(
			human,
			grantInput(context.id, { sessionId: UNRELATED_SESSION, agentId: "agent-unrelated", persist: true }),
		);
		const next = await browser.open(unrelatedAgent, { grantId: fresh.id });
		assert.strictEqual(next.persisting, true, "the context's persisting slot is free");
	}

	return [
		test("refuses an agent granting a browser context to its own session", async ({ browser, setParent }, deps) => {
			const context = await putContext(browser);
			await assertGrantRefused(browser, deps, agent, grantInput(context.id));
			setParent(SESSION, SESSION);
			await assertGrantRefused(browser, deps, agent, grantInput(context.id));
			assert.strictEqual((await browser.listGrants(agent, {})).length, 0, "the agent sees no grant");
		}),

		test("refuses an unrelated agent, a child agent or a system actor granting to another session", async ({
			browser,
			setParent,
		}, deps) => {
			const context = await putContext(browser);
			await assertGrantRefused(browser, deps, unrelatedAgent, grantInput(context.id));
			setParent(SESSION, PARENT_SESSION);
			await assertGrantRefused(browser, deps, unrelatedAgent, grantInput(context.id));
			setParent(UNRELATED_SESSION, SESSION);
			await assertGrantRefused(browser, deps, agent, grantInput(context.id, { sessionId: PARENT_SESSION }));
			const harbour = contextFor(actors.system("sweeper"), ORG, PROJECT);
			await assertGrantRefused(browser, deps, harbour, grantInput(context.id));
			const other = await putContext(browser, "lleverage-staging", "brwsr-ctx-other");
			const retried = contextFor(unrelatedAgent.actor, ORG, PROJECT, { requestId: "req-shared" });
			const before = deps.audit.ofType("browser.grant.refused").length;
			await assert.rejectsWithCode(browser.grant(retried, grantInput(context.id)), "refused");
			await assert.rejectsWithCode(browser.grant(retried, grantInput(other.id)), "refused");
			assert.strictEqual(
				deps.audit.ofType("browser.grant.refused").length,
				before + 2,
				"two refusals for different contexts under one request ID are two rows",
			);
		}),

		test("lets an agent in the parent session pass on a browser context it holds to its child", async (subject, deps) => {
			const { browser } = subject;
			const context = await putContext(browser);
			subject.setParent(SESSION, PARENT_SESSION);
			const parentGrant = await grantToParent(browser, context.id);
			const grant = await browser.grant(parentAgent, grantInput(context.id));
			assert.strictEqual(grant.status, "active");
			assert.strictEqual(grant.sessionId, SESSION);
			assert.strictEqual(grant.contextId, context.id);
			assert.strictEqual(grant.parentGrantId, parentGrant.id, "the grant names the grant it was passed on from");
			assert.deepEqual(grant.grantedBy, parentAgent.actor, "the grant names the supervising agent");
			assert.deepEqual(
				(await browser.listGrants(agent, {})).map((listed) => listed.id),
				[grant.id],
			);
			const created = deps.audit.ofType("browser.grant.created").filter((event) => event.sessionId === SESSION);
			assert.strictEqual(created.length, 1);
			assert.deepEqual(created[0]!.actor, parentAgent.actor, "the audit names the supervising agent");
			const session = await browser.open(agent, { grantId: grant.id });
			assert.strictEqual(session.status, "open", "the child can open under its parent's grant");
		}),

		test("lets a human or a service grant a browser context", async ({ browser }, deps) => {
			const context = await putContext(browser);
			for (const ctx of [human, service]) {
				const grant = await browser.grant(ctx, grantInput(context.id));
				assert.strictEqual(grant.status, "active");
				assert.deepEqual(grant.grantedBy, ctx.actor);
				assert.strictEqual(grant.persist, false);
				assert.strictEqual(grant.timeoutMs, 60_000);
				assert.deepEqual(grant.allowedSites, ["github.com", "*.github.com"]);
			}
			assert.strictEqual((await browser.listGrants(human, { sessionId: SESSION })).length, 2);
			assert.strictEqual(deps.audit.ofType("browser.grant.created").length, 2);
			assert.strictEqual(deps.audit.ofType("browser.grant.refused").length, 0);
		}),

		test("refuses an agent supervisor granting a context it holds no active grant for", async (subject, deps) => {
			const { browser } = subject;
			const context = await putContext(browser);
			const other = await putContext(browser, "lleverage-staging", "brwsr-ctx-other");
			subject.setParent(SESSION, PARENT_SESSION);
			await assertGrantRefused(browser, deps, parentAgent, grantInput(context.id), "no_parent_grant");
			await browser.grant(human, grantInput(context.id, { sessionId: UNRELATED_SESSION, agentId: "agent-unrelated" }));
			await assertGrantRefused(browser, deps, parentAgent, grantInput(context.id), "no_parent_grant");
			await browser.grant(human, grantInput(context.id, { sessionId: PARENT_SESSION, agentId: "agent-other" }));
			await assertGrantRefused(browser, deps, parentAgent, grantInput(context.id), "no_parent_grant");
			const held = await grantToParent(browser, other.id);
			await assertGrantRefused(browser, deps, parentAgent, grantInput(context.id), "no_parent_grant");
			const revoked = await grantToParent(browser, context.id);
			await browser.revokeGrant(human, revoked.id);
			await assertGrantRefused(browser, deps, parentAgent, grantInput(context.id), "no_parent_grant");
			const passed = await browser.grant(parentAgent, grantInput(other.id));
			assert.strictEqual(passed.parentGrantId, held.id, "the context it does hold can be passed on");
		}),

		test("refuses an agent supervisor passing on a grant wider than its own in persist, sites or timeout", async (subject, deps) => {
			const { browser } = subject;
			const context = await putContext(browser);
			subject.setParent(SESSION, PARENT_SESSION);
			const parentGrant = await grantToParent(browser, context.id, {
				persist: false,
				timeoutMs: 60_000,
				allowedSites: ["github.com", "*.api.github.com"],
			});
			const wider: readonly Partial<GrantBrowserInput>[] = [
				{ persist: true, allowedSites: ["github.com"] },
				{ timeoutMs: 60_001, allowedSites: ["github.com"] },
				{ allowedSites: ["github.com", "gitlab.com"] },
				{ allowedSites: ["*.github.com"] },
				{ allowedSites: ["api.github.com"] },
				{ allowedSites: ["*.evilapi.github.com"] },
			];
			for (const extra of wider) {
				await assertGrantRefused(browser, deps, parentAgent, grantInput(context.id, extra), "wider_than_parent");
			}
			const narrower = await browser.grant(
				parentAgent,
				grantInput(context.id, {
					persist: false,
					timeoutMs: 60_000,
					allowedSites: ["github.com", "*.api.github.com", "v3.api.github.com", "*.eu.api.github.com"],
				}),
			);
			assert.strictEqual(narrower.parentGrantId, parentGrant.id, "a grant no wider than the parent's is allowed");
		}),

		test("ends the grants passed on from a grant, transitively, and closes their browsers, when it is revoked or its session ends", async (subject, deps) => {
			const { browser } = subject;
			const context = await putContext(browser);
			subject.setParent(SESSION, PARENT_SESSION);
			subject.setParent(GRANDCHILD_SESSION, SESSION);
			const passOn = async () => {
				const parentGrant = await grantToParent(browser, context.id);
				const childGrant = await browser.grant(parentAgent, grantInput(context.id));
				const grandchildGrant = await browser.grant(
					agent,
					grantInput(context.id, { sessionId: GRANDCHILD_SESSION, agentId: GRANDCHILD_AGENT }),
				);
				assert.strictEqual(grandchildGrant.parentGrantId, childGrant.id);
				const browsers = [
					await browser.open(parentAgent, { grantId: parentGrant.id }),
					await browser.open(agent, { grantId: childGrant.id }),
					await browser.open(grandchildAgent, { grantId: grandchildGrant.id }),
				];
				return { parentGrant, passedOn: [childGrant, grandchildGrant], browsers };
			};
			const unrelated = await browser.grant(
				human,
				grantInput(context.id, { sessionId: UNRELATED_SESSION, agentId: "agent-unrelated" }),
			);
			const kept = await browser.open(unrelatedAgent, { grantId: unrelated.id });

			const first = await passOn();
			await browser.revokeGrant(human, first.parentGrant.id);
			for (const grant of first.passedOn) {
				const read = (await browser.listGrants(human, {})).find((listed) => listed.id === grant.id);
				assert.strictEqual(read?.status, "revoked", "a grant passed on is revoked with its parent");
			}
			for (const opened of first.browsers) {
				const read = await browser.get(human, opened.id);
				assert.strictEqual(read.status, "closed");
				assert.strictEqual(read.endReason, "revoked");
			}
			assert.strictEqual(subject.providerLive().length, 1, "only the unrelated browser is live");
			assert.strictEqual(deps.audit.ofType("browser.grant.revoked").length, 3, "each revocation is audited");

			const second = await passOn();
			await browser.endSession(PARENT_SESSION, "session_ended");
			for (const grant of second.passedOn) {
				const read = (await browser.listGrants(human, {})).find((listed) => listed.id === grant.id);
				assert.strictEqual(read?.status, "ended", "a grant passed on ends with its parent's session");
			}
			for (const opened of second.browsers) {
				const read = await browser.get(human, opened.id);
				assert.strictEqual(read.status, "closed");
				assert.strictEqual(read.endReason, "session_ended");
			}
			assert.strictEqual(subject.providerLive().length, 1, "only the unrelated browser is live");
			assert.strictEqual((await browser.get(human, kept.id)).status, "open", "the unrelated browser is untouched");
			await assert.rejectsWithCode(browser.open(agent, { grantId: second.passedOn[0]!.id }), "expired");
		}),

		test("forbids an agent listing or creating browser contexts", async ({ browser }) => {
			const context = await putContext(browser);
			await assert.rejectsWithCode(browser.listContexts(agent), "forbidden", "an agent cannot list contexts");
			await assert.rejectsWithCode(
				browser.putContext(agent, {
					owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
					name: "mine",
					providerContextId: "brwsr-ctx-agent-chosen",
				}),
				"forbidden",
				"an agent cannot create a context",
			);
			const listed = await browser.listContexts(service);
			assert.deepEqual(
				listed.items.map((item) => item.id),
				[context.id],
				"a service sees the one context",
			);
			assert.strictEqual(listed.items[0]!.providerContextId, PROVIDER_CONTEXT_ID, "humans and services see it");
		}),

		test("takes a request naming no context and marks it granted when a supervisor answers it", async (subject, deps) => {
			const { browser } = subject;
			const context = await putContext(browser);
			await assert.rejectsWithCode(
				browser.request(human, { reason: "Check the PR", sites: ["github.com"] }),
				"forbidden",
				"only an agent asks for a browser",
			);
			const request = await browser.request(agent, { reason: "Check the PR", sites: ["github.com"] });
			assert.strictEqual(request.status, "pending");
			assert.strictEqual(request.sessionId, SESSION);
			assert.strictEqual(request.agentId, AGENT);
			assert.strictEqual("contextId" in request, false, "a request names no context");
			await assertGrantRefused(browser, deps, agent, grantInput(context.id, { requestId: request.id }));
			assert.strictEqual(deps.audit.ofType("browser.request.granted").length, 0, "a refusal answers nothing");
			subject.setParent(SESSION, PARENT_SESSION);
			await grantToParent(browser, context.id);
			const grant = await browser.grant(parentAgent, grantInput(context.id, { requestId: request.id }));
			assert.strictEqual(grant.requestId, request.id);
			const granted = deps.audit.ofType("browser.request.granted");
			assert.strictEqual(granted.length, 1, "the request is marked granted");
			assert.deepEqual(granted[0]!.subject, { kind: "browser.request", id: request.id });
			assert.deepEqual(granted[0]!.actor, parentAgent.actor);
			await assert.rejectsWithCode(
				browser.grant(human, grantInput(context.id, { requestId: request.id })),
				"conflict",
				"a granted request cannot be answered twice",
			);
		}),

		test("refuses opening with a context the grant does not hold and uses the grant's when none is named", async ({
			browser,
		}, deps) => {
			const { context, grant } = await grantFresh(browser);
			const other = await putContext(browser, "lleverage-staging", "brwsr-ctx-other");
			await assert.rejectsWithCode(
				browser.open(agent, { grantId: grant.id, contextId: other.id }),
				"refused",
				"the agent cannot pick another context",
			);
			await assert.rejectsWithCode(
				browser.open(agent, { grantId: grant.id, contextId: "bctx_made_up" }),
				"refused",
				"the agent cannot name an unknown context",
			);
			const refusals = deps.audit.ofType("browser.session.refused");
			assert.strictEqual(refusals.length, 2, "each refusal is audited");
			assert.deepEqual(refusals[0]!.actor, agent.actor);
			assert.strictEqual(deps.audit.ofType("browser.session.opened").length, 0, "nothing opened");
			const session = await browser.open(agent, { grantId: grant.id });
			assert.strictEqual(session.contextId, context.id, "no contextId means the grant's");
			const named = await browser.open(agent, { grantId: grant.id, contextId: context.id });
			assert.strictEqual(named.contextId, context.id, "naming the grant's own context is fine");
		}),

		test("hides another session's grant from an agent opening a browser", async (subject) => {
			const { browser } = subject;
			const { grant } = await grantFresh(browser);
			await assert.rejectsWithCode(browser.open(unrelatedAgent, { grantId: grant.id }), "not_found");
			subject.setParent(SESSION, PARENT_SESSION);
			await assert.rejectsWithCode(
				browser.open(parentAgent, { grantId: grant.id }),
				"not_found",
				"even the supervising parent cannot open under its child's grant",
			);
			const sameSessionOtherAgent = contextFor(actors.agent("agent-impostor", SESSION), ORG, PROJECT);
			await assert.rejectsWithCode(browser.open(sameSessionOtherAgent, { grantId: grant.id }), "not_found");
			const sameAgentOtherSession = contextFor(actors.agent(AGENT, UNRELATED_SESSION), ORG, PROJECT);
			await assert.rejectsWithCode(browser.open(sameAgentOtherSession, { grantId: grant.id }), "not_found");
			assert.strictEqual((await browser.listGrants(unrelatedAgent, {})).length, 0, "agents list only their own");
			assert.strictEqual(
				(await browser.listGrants(unrelatedAgent, { sessionId: SESSION })).length,
				0,
				"an agent cannot list another session's grants by filter",
			);
			assert.strictEqual((await browser.listGrants(agent, {})).length, 1);
			await assert.rejectsWithCode(
				browser.open(human, { grantId: grant.id }),
				"forbidden",
				"only an agent opens a browser",
			);
			assert.strictEqual(subject.providerLive().length, 0, "nothing opened at the provider");
		}),

		test("gives the agent a CDP URL and never the provider context ID", async (subject) => {
			const { browser } = subject;
			const { grant } = await grantFresh(browser);
			const first = await browser.open(agent, { grantId: grant.id });
			const second = await browser.open(agent, { grantId: grant.id });
			assert.ok(typeof first.cdpUrl === "string" && first.cdpUrl.length > 0, "a CDP URL");
			assert.ok(first.cdpUrl !== second.cdpUrl, "each browser session has its own CDP URL");
			assert.strictEqual(subject.providerLive().length, 2);
			const views = [
				first,
				second,
				await browser.get(agent, first.id),
				await browser.listGrants(agent, {}),
				await browser.checkSite(agent, first.id, "https://github.com/"),
				await browser.close(agent, second.id),
				await browser.request(agent, { reason: "More", sites: ["github.com"] }),
			];
			const serialised = JSON.stringify(views);
			assert.strictEqual(serialised.includes(PROVIDER_CONTEXT_ID), false, "no agent view holds the provider ID");
			assert.strictEqual(serialised.includes("providerContextId"), false, "no agent view has the field");
			assert.strictEqual(serialised.includes("providerSessionId"), false, "no agent view has provider session IDs");
		}),

		test("allows one persisting browser session per context at a time and any number of non-persisting ones", async (subject) => {
			const { browser } = subject;
			const context = await putContext(browser);
			const persisting = await browser.grant(human, grantInput(context.id, { persist: true }));
			const otherPersisting = await browser.grant(human, grantInput(context.id, { persist: true }));
			const ephemeral = await browser.grant(human, grantInput(context.id, { persist: false }));
			const first = await browser.open(agent, { grantId: persisting.id });
			assert.strictEqual(first.persisting, true);
			await assert.rejectsWithCode(browser.open(agent, { grantId: persisting.id }), "conflict");
			await assert.rejectsWithCode(
				browser.open(agent, { grantId: otherPersisting.id }),
				"conflict",
				"the limit is per context, not per grant",
			);
			const looseA = await browser.open(agent, { grantId: ephemeral.id });
			const looseB = await browser.open(agent, { grantId: ephemeral.id });
			assert.strictEqual(looseA.persisting, false);
			assert.strictEqual(looseB.persisting, false);
			const elsewhere = await putContext(browser, "lleverage-staging", "brwsr-ctx-other");
			const elsewhereGrant = await browser.grant(human, grantInput(elsewhere.id, { persist: true }));
			await browser.open(agent, { grantId: elsewhereGrant.id });
			await browser.close(agent, first.id);
			const next = await browser.open(agent, { grantId: otherPersisting.id });
			assert.strictEqual(next.status, "open", "the slot frees once the first closes");
			assert.strictEqual(subject.providerLive().length, 4);
		}),

		test("settles concurrent persisting opens on one context with exactly one browser session", async (subject) => {
			const { browser } = subject;
			const { grant } = await grantFresh(browser, { persist: true });
			const results = await Promise.allSettled([
				browser.open(agent, { grantId: grant.id }),
				browser.open(agent, { grantId: grant.id }),
				browser.open(agent, { grantId: grant.id }),
			]);
			assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1, "one opens");
			assert.strictEqual(subject.providerLive().length, 1, "one is live at the provider");
		}),

		test("checks sites against the grant, with wildcards for subdomains and lookalike hosts refused", async ({
			browser,
		}) => {
			const { grant } = await grantFresh(browser, { allowedSites: ["github.com", "*.githubusercontent.com"] });
			const session = await browser.open(agent, { grantId: grant.id });
			const check = async (url: string) => (await browser.checkSite(agent, session.id, url)).allow;
			assert.strictEqual(await check("https://github.com/tvdavies/harbour"), true);
			assert.strictEqual(await check("http://github.com:8080/"), true, "ports are ignored");
			assert.strictEqual(await check("https://GitHub.com/"), true, "hosts compare case-insensitively");
			assert.strictEqual(await check("https://raw.githubusercontent.com/x"), true, "a wildcard covers a subdomain");
			assert.strictEqual(await check("https://a.b.githubusercontent.com/x"), true, "and deeper subdomains");
			assert.strictEqual(await check("https://githubusercontent.com/"), false, "a wildcard skips the bare host");
			assert.strictEqual(await check("https://api.github.com/"), false, "an exact site covers no subdomain");
			assert.strictEqual(await check("https://github.com.evil.example/"), false, "a lookalike is refused");
			assert.strictEqual(await check("https://evilgithub.com/"), false, "a suffix lookalike is refused");
			assert.strictEqual(await check("https://evilgithubusercontent.com/"), false, "a wildcard needs a dot boundary");
			assert.strictEqual(await check("https://example.com/"), false);
			assert.strictEqual(await check("ftp://github.com/"), false, "only http and https");
			assert.strictEqual(await check("not a url"), false, "an invalid URL is refused");
			await assert.rejectsWithCode(browser.checkSite(unrelatedAgent, session.id, "https://github.com/"), "not_found");
		}),

		test("rejects a wildcard over a single label as invalid", async ({ browser }) => {
			const context = await putContext(browser);
			for (const site of ["*.com", "*"]) {
				await assert.rejectsWithCode(
					browser.grant(human, grantInput(context.id, { allowedSites: ["github.com", site] })),
					"invalid",
					`a grant of ${site}`,
				);
				await assert.rejectsWithCode(
					browser.request(agent, { reason: "Browse", sites: [site] }),
					"invalid",
					`a request for ${site}`,
				);
			}
			const grant = await browser.grant(human, grantInput(context.id, { allowedSites: ["*.co.uk"] }));
			assert.deepEqual(grant.allowedSites, ["*.co.uk"], "two labels are enough: there is no public suffix list");
		}),

		test("closes a browser session past its timeout as timeout and releases it at the provider", async (subject, deps) => {
			const { browser } = subject;
			const { grant } = await grantFresh(browser, { timeoutMs: 30_000, persist: true });
			const session = await browser.open(agent, { grantId: grant.id });
			assert.strictEqual(session.expiresAt, session.openedAt + 30_000);
			deps.clock.advance(29_999);
			assert.strictEqual((await browser.get(agent, session.id)).status, "open", "still open before the timeout");
			deps.clock.advance(1);
			await browser.listGrants(human, {});
			assert.strictEqual(subject.providerLive().length, 0, "any call sweeps and releases it");
			const read = await browser.get(agent, session.id);
			assert.strictEqual(read.status, "closed");
			assert.strictEqual(read.endReason, "timeout");
			assert.strictEqual(
				(await browser.checkSite(agent, session.id, "https://github.com/")).allow,
				false,
				"a timed-out browser visits nothing",
			);
			const closed = deps.audit.ofType("browser.session.closed");
			assert.strictEqual(closed.length, 1);
			assert.strictEqual(closed[0]!.data?.endReason, "timeout");
			const again = await browser.open(agent, { grantId: grant.id });
			assert.strictEqual(again.status, "open", "the timeout frees the persisting slot");
		}),

		test("ends every browser session and grant when the agent session ends", async (subject, deps) => {
			const { browser } = subject;
			const { context, grant } = await grantFresh(browser, { persist: true });
			const second = await browser.grant(human, grantInput(context.id));
			const unrelated = await browser.grant(
				human,
				grantInput(context.id, { sessionId: UNRELATED_SESSION, agentId: "agent-unrelated" }),
			);
			const sessionA = await browser.open(agent, { grantId: grant.id });
			const sessionB = await browser.open(agent, { grantId: second.id });
			const kept = await browser.open(unrelatedAgent, { grantId: unrelated.id });
			assert.strictEqual(subject.providerLive().length, 3);
			await browser.endSession(SESSION, "session_ended");
			assert.strictEqual(subject.providerLive().length, 1, "only the unrelated session's browser is live");
			for (const id of [sessionA.id, sessionB.id]) {
				const read = await browser.get(human, id);
				assert.strictEqual(read.status, "closed");
				assert.strictEqual(read.endReason, "session_ended");
			}
			const grants = await browser.listGrants(human, { sessionId: SESSION });
			assert.deepEqual(
				grants.map((listed) => listed.status),
				["ended", "ended"],
			);
			assert.strictEqual((await browser.get(human, kept.id)).status, "open", "other sessions are untouched");
			await assert.rejectsWithCode(
				browser.open(agent, { grantId: grant.id }),
				"expired",
				"an ended grant opens nothing",
			);
			assert.strictEqual(subject.providerLive().length, 1);
			assert.strictEqual(deps.audit.ofType("browser.session.closed").length, 2);
		}),

		test("closes a grant's browser sessions when the grant is revoked", async (subject, deps) => {
			const { browser } = subject;
			const { context, grant } = await grantFresh(browser);
			const kept = await browser.grant(human, grantInput(context.id));
			const first = await browser.open(agent, { grantId: grant.id });
			const second = await browser.open(agent, { grantId: grant.id });
			const other = await browser.open(agent, { grantId: kept.id });
			await assert.rejectsWithCode(
				browser.revokeGrant(agent, grant.id),
				"forbidden",
				"an agent does not revoke its own grant",
			);
			const revoked = await browser.revokeGrant(human, grant.id);
			assert.strictEqual(revoked.status, "revoked");
			for (const id of [first.id, second.id]) {
				const read = await browser.get(agent, id);
				assert.strictEqual(read.status, "closed");
				assert.strictEqual(read.endReason, "revoked");
			}
			assert.strictEqual((await browser.get(agent, other.id)).status, "open", "other grants are untouched");
			assert.strictEqual(subject.providerLive().length, 1);
			await assert.rejectsWithCode(browser.open(agent, { grantId: grant.id }), "expired");
			const closed = deps.audit.ofType("browser.session.closed");
			assert.strictEqual(closed.length, 2);
			assert.ok(
				closed.every((event) => sameActor(event.actor, human.actor)),
				"the closes name the revoker",
			);
		}),

		test("fails an open in flight when its grant is revoked, releasing the browser and freeing the persisting slot", async (subject) => {
			await assertOpenInFlightExpires(subject, (browser, grant) => browser.revokeGrant(human, grant.id));
		}),

		test("fails an open in flight when its session ends, releasing the browser and freeing the persisting slot", async (subject) => {
			await assertOpenInFlightExpires(subject, (browser) => browser.endSession(SESSION, "session_ended"));
		}),

		test("releases each browser independently when a provider release fails, and retries the failed one on the next call", async (subject, deps) => {
			const { browser } = subject;
			const { grant } = await grantFresh(browser);
			const opened = [
				await browser.open(agent, { grantId: grant.id }),
				await browser.open(agent, { grantId: grant.id }),
				await browser.open(agent, { grantId: grant.id }),
			];
			assert.strictEqual(subject.providerLive().length, 3);
			subject.failReleases(1);
			await browser.endSession(SESSION, "session_ended");
			assert.strictEqual(subject.providerLive().length, 1, "the other two are released");
			subject.failReleases(1);
			const theirs = await browser.listContexts(outsider);
			assert.strictEqual(theirs.items.length, 0, "an unrelated organisation's call resolves during the failure");
			assert.strictEqual(subject.providerLive().length, 1, "the retry during the failure fails too");
			const failures = deps.audit.ofType("browser.session.release_failed");
			assert.strictEqual(failures.length, 2, "each failed attempt is audited once");
			assert.strictEqual(failures[0]!.subject?.id, failures[1]!.subject?.id, "both name the same browser session");
			for (const session of opened) {
				assert.strictEqual((await browser.get(agent, session.id)).status, "closed", "every record is closed");
			}
			assert.strictEqual(subject.providerLive().length, 0, "the next call after the failure clears releases it");
			assert.strictEqual(deps.audit.ofType("browser.session.release_failed").length, 2, "no new failure row");
			assert.strictEqual(deps.audit.ofType("browser.session.closed").length, 3);
		}),

		test("hides another organisation's contexts, grants and browser sessions as not found", async ({ browser }) => {
			const { context, grant } = await grantFresh(browser);
			const session = await browser.open(agent, { grantId: grant.id });
			const outsideAgent = contextFor(actors.agent(AGENT, SESSION), OTHER_ORG, PROJECT);
			await assert.rejectsWithCode(browser.get(outsider, session.id), "not_found");
			await assert.rejectsWithCode(browser.close(outsider, session.id), "not_found");
			await assert.rejectsWithCode(browser.checkSite(outsider, session.id, "https://github.com/"), "not_found");
			await assert.rejectsWithCode(browser.revokeGrant(outsider, grant.id), "not_found");
			await assert.rejectsWithCode(browser.open(outsideAgent, { grantId: grant.id }), "not_found");
			await assert.rejectsWithCode(
				browser.grant(outsider, grantInput(context.id)),
				"not_found",
				"another organisation's context cannot be granted",
			);
			assert.strictEqual((await browser.listGrants(outsider, {})).length, 0);
			assert.strictEqual((await browser.listGrants(outsideAgent, {})).length, 0);
			assert.strictEqual((await browser.listContexts(outsider)).items.length, 0);
			assert.strictEqual((await browser.get(agent, session.id)).status, "open", "the session is untouched");
		}),

		test("audits every grant, refusal, open and close with its actor", async (subject, deps) => {
			const { browser } = subject;
			const context = await putContext(browser);
			await assert.rejectsWithCode(browser.grant(agent, grantInput(context.id)), "refused");
			const grant = await browser.grant(service, grantInput(context.id));
			await assert.rejectsWithCode(browser.open(agent, { grantId: grant.id, contextId: "bctx_other" }), "refused");
			const session = await browser.open(agent, { grantId: grant.id });
			await browser.close(agent, session.id);
			await browser.close(agent, session.id);
			const expected: readonly [string, Actor, string | undefined][] = [
				["browser.grant.refused", agent.actor, undefined],
				["browser.grant.created", service.actor, grant.id],
				["browser.session.refused", agent.actor, undefined],
				["browser.session.opened", agent.actor, session.id],
				["browser.session.closed", agent.actor, session.id],
			];
			for (const [type, actor, subjectId] of expected) {
				const events = deps.audit.ofType(type);
				assert.strictEqual(events.length, 1, `one ${type} event`);
				const event = events[0]!;
				assert.deepEqual(event.actor, actor, `${type} names its actor`);
				assert.strictEqual(event.source, "browser");
				assert.strictEqual(event.organisationId, ORG);
				assert.strictEqual(event.sessionId, SESSION, `${type} names the agent session`);
				if (subjectId !== undefined) assert.strictEqual(event.subject?.id, subjectId, `${type} names its record`);
			}
			const closedView = await browser.get(agent, session.id);
			assert.strictEqual(closedView.endReason, "closed");
			assert.strictEqual(subject.providerLive().length, 0, "close releases at the provider");
		}),
	];
}

export function registerBrowserConformance(
	runner: ConformanceRunner,
	name: string,
	provider: BrowserConformanceProvider,
): void {
	registerCases(
		runner,
		name,
		createBrowserConformance({ assertions: createExpectAssertions(runner.expect), provider }),
	);
}
