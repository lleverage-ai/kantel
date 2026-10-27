/**
 * Conformance suite for `Vault` (packages/contracts/src/vault.ts). Every target registers it with a provider that
 * builds a fresh vault on the suite's clock and audit sink.
 */
import {
	type CallContext,
	type DecisionInput,
	type EgressRequest,
	type HttpMethod,
	isHarbourError,
	type Proposal,
	type ProposalTerms,
	type Vault,
	type VaultItem,
} from "@harbour/contracts";
import {
	actors,
	CANARY_SECRET,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceRunner,
	containsCanary,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";

export interface VaultSubject {
	readonly vault: Vault;
}

export type VaultConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: VaultSubject) => Promise<void>,
) => Promise<void>;

const ORG = "org-a";
const OTHER_ORG = "org-b";
const PROJECT = "proj-a";
const HOST = "api.github.com";
const BINDING_CODE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/;

const human = contextFor(actors.human("approver-1"), ORG, PROJECT);
const agent = contextFor(actors.agent("agent-1", "session-1"), ORG, PROJECT);
const otherAgent = contextFor(actors.agent("agent-2", "session-2"), ORG, PROJECT);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG);

function putGithubToken(vault: Vault, withValue = true): Promise<VaultItem> {
	return vault.putItem(human, {
		owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
		name: "github-token",
		hosts: [HOST],
		injection: { header: "Authorization", template: "Bearer {key}" },
		...(withValue ? { value: CANARY_SECRET } : {}),
	});
}

function termsFor(
	itemId: string,
	methods: readonly HttpMethod[],
	lifetime: ProposalTerms["lifetime"],
	pathPrefix = "/repos/",
): ProposalTerms {
	return { itemId, route: { host: HOST, methods, pathPrefix }, lifetime, reason: "Read the repository" };
}

const secretTerms: ProposalTerms = {
	secret: {
		name: "linear-key",
		hosts: ["api.linear.app"],
		injection: { header: "Authorization", template: "Bearer {key}" },
	},
	route: { host: "api.linear.app", methods: ["POST"], pathPrefix: "/graphql" },
	lifetime: { ttlMs: 3_600_000 },
	reason: "Create issues in Linear",
};

function approval(proposal: Proposal, extra: Partial<DecisionInput> = {}): DecisionInput {
	return {
		proposalId: proposal.id,
		outcome: "approve",
		termsHash: proposal.termsHash,
		pickedCode: proposal.bindingCode,
		...extra,
	};
}

function egress(method: HttpMethod, url: string, extra: Partial<EgressRequest> = {}): EgressRequest {
	return { organisationId: ORG, projectId: PROJECT, agentId: "agent-1", sessionId: "session-1", method, url, ...extra };
}

async function wrongCode(vault: Vault, proposal: Proposal): Promise<string> {
	const view = await vault.approvalView(human, proposal.id);
	return view.codeChoices.find((choice) => choice !== proposal.bindingCode)!;
}

async function grantCount(vault: Vault, ctx: CallContext = human): Promise<number> {
	return (await vault.listGrants(ctx)).items.length;
}

export function createVaultConformance(options: {
	assertions: ConformanceAssertions;
	provider: VaultConformanceProvider;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (name: string, body: (vault: Vault, deps: ConformanceDeps) => Promise<void>): ConformanceCase => ({
		name,
		run: async () => {
			const deps = createDeps();
			await options.provider(deps, (subject) => body(subject.vault, deps));
		},
	});

	/** Asserts that an approval is refused for its binding code, audited, and leaves the proposal pending. */
	async function assertCodeRefused(vault: Vault, deps: ConformanceDeps, proposal: Proposal, input: DecisionInput) {
		const before = deps.audit.ofType("vault.binding_code.mismatch").length;
		await assert.rejectsWithCode(vault.decide(human, input), "refused", "a code mismatch is refused");
		const mismatches = deps.audit.ofType("vault.binding_code.mismatch");
		assert.strictEqual(mismatches.length, before + 1, "the mismatch is audited");
		const event = mismatches.at(-1)!;
		assert.deepEqual(event.actor, human.actor, "the audit names the approver");
		assert.strictEqual(event.data?.pickedCode ?? null, input.pickedCode ?? null, "the audit records the picked code");
		assert.strictEqual((await vault.getProposal(human, proposal.id)).status, "pending", "the proposal stays pending");
		assert.strictEqual(await grantCount(vault), 0, "no grant exists");
	}

	return [
		test("never returns an item's value from getItem or listItems", async (vault) => {
			const item = await putGithubToken(vault);
			assert.strictEqual(item.hasValue, true);
			assert.ok(/^harbour:\/\/github-token\/[0-9a-f]{6}$/.test(item.placeholder), "placeholder format");
			const fetched = await vault.getItem(human, item.id);
			const listed = await vault.listItems(human);
			assert.strictEqual(fetched.hasValue, true);
			assert.strictEqual(listed.items.length, 1);
			assert.strictEqual(containsCanary([item, fetched, listed]), false, "no read returns the value");
			const empty = await putGithubToken(vault, false);
			assert.strictEqual(empty.hasValue, false);
			assert.ok(empty.placeholder !== item.placeholder, "each item gets its own placeholder");
		}),

		test("derives the proposal kind from its terms, never from the agent", async (vault) => {
			const item = await putGithubToken(vault);
			const read = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 1 }));
			const write = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			const unlimited = await vault.propose(agent, termsFor(item.id, ["GET"], {}));
			const reusable = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 5 }));
			const secret = await vault.propose(agent, secretTerms);
			const disguised = { ...termsFor(item.id, ["GET", "DELETE"], { maxUses: 1 }), kind: "read" } as ProposalTerms;
			assert.strictEqual(read.kind, "read");
			assert.strictEqual(write.kind, "write", "a POST with maxUses 1 is a write");
			assert.strictEqual(unlimited.kind, "route");
			assert.strictEqual(reusable.kind, "route");
			assert.strictEqual(secret.kind, "secret");
			assert.strictEqual((await vault.propose(agent, disguised)).kind, "write", "a kind supplied in terms is ignored");
		}),

		test("gives every proposal a binding code, a terms hash, a pending status, a link and an expiry", async (vault) => {
			const item = await putGithubToken(vault);
			const terms = termsFor(item.id, ["POST"], { maxUses: 1 });
			const first = await vault.propose(agent, terms);
			const second = await vault.propose(agent, terms);
			for (const proposal of [first, second]) {
				assert.ok(BINDING_CODE.test(proposal.bindingCode), `binding code ${proposal.bindingCode} is XXX-XXX`);
				assert.ok(/^[0-9a-f]{64}$/.test(proposal.termsHash), "terms hash is 64 hex characters");
				assert.strictEqual(proposal.status, "pending");
				assert.ok(proposal.link.length > 0 && proposal.link.includes(proposal.id), "the link names the proposal");
				assert.greaterThan(proposal.expiresAt, proposal.createdAt);
				assert.strictEqual(proposal.requester.agentId, "agent-1");
				assert.strictEqual(proposal.requester.sessionId, "session-1");
			}
			assert.strictEqual(first.termsHash, second.termsHash, "identical terms hash alike");
			assert.ok(first.bindingCode !== second.bindingCode, "identical terms still get different codes");
		}),

		test("shows the approver the real code exactly once among at least four choices", async (vault) => {
			const item = await putGithubToken(vault);
			for (const [terms, required] of [
				[termsFor(item.id, ["GET"], { maxUses: 1 }), false],
				[termsFor(item.id, ["PUT"], { maxUses: 1 }), true],
				[termsFor(item.id, ["GET"], {}), true],
				[secretTerms, true],
			] as const) {
				const proposal = await vault.propose(agent, terms);
				const view = await vault.approvalView(human, proposal.id);
				assert.ok(view.codeChoices.length >= 4, "at least four choices");
				assert.strictEqual(view.codeChoices.filter((code) => code === proposal.bindingCode).length, 1);
				assert.strictEqual(new Set(view.codeChoices).size, view.codeChoices.length, "choices are distinct");
				assert.strictEqual(view.codeRequired, required, `codeRequired for ${proposal.kind}`);
				assert.deepEqual(
					(await vault.approvalView(human, proposal.id)).codeChoices,
					view.codeChoices,
					"choices are stable",
				);
			}
		}),

		test("refuses the approval view to an agent actor", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			await assert.rejectsWithCode(vault.approvalView(agent, proposal.id), "forbidden");
		}),

		test("refuses approving a write without the matching binding code", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			const { pickedCode: _omitted, ...withoutCode } = approval(proposal);
			await assertCodeRefused(vault, deps, proposal, withoutCode);
			await assertCodeRefused(
				vault,
				deps,
				proposal,
				approval(proposal, { pickedCode: await wrongCode(vault, proposal) }),
			);
			const decision = await vault.decide(human, approval(proposal));
			assert.strictEqual(decision.outcome, "approved");
			const grant = await vault.getGrant(human, decision.grantId!);
			assert.strictEqual(grant.status, "active");
			assert.strictEqual(grant.maxUses, 1);
			assert.strictEqual(deps.audit.ofType("vault.decision.approved").length, 1);
		}),

		test("refuses approving a route grant without the matching binding code", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], { ttlMs: 60_000 }));
			assert.strictEqual(proposal.kind, "route");
			const { pickedCode: _omitted, ...withoutCode } = approval(proposal);
			await assertCodeRefused(vault, deps, proposal, withoutCode);
			await assertCodeRefused(
				vault,
				deps,
				proposal,
				approval(proposal, { pickedCode: await wrongCode(vault, proposal) }),
			);
			const decision = await vault.decide(human, approval(proposal));
			assert.strictEqual((await vault.getGrant(human, decision.grantId!)).status, "active");
		}),

		test("refuses a secret paste with a wrong code and stores nothing", async (vault, deps) => {
			const proposal = await vault.propose(agent, secretTerms);
			const pasted = approval(proposal, { pickedCode: await wrongCode(vault, proposal), secretValue: CANARY_SECRET });
			await assertCodeRefused(vault, deps, proposal, pasted);
			assert.strictEqual((await vault.listItems(human)).items.length, 0, "no item was created");
			await assert.rejectsWithCode(
				vault.decide(human, approval(proposal)),
				"invalid",
				"approving a secret needs the pasted value",
			);
			assert.strictEqual((await vault.listItems(human)).items.length, 0, "still no item");
		}),

		test("stores a pasted secret only with the matching code and never returns it", async (vault) => {
			const proposal = await vault.propose(agent, secretTerms);
			const decision = await vault.decide(human, approval(proposal, { secretValue: CANARY_SECRET }));
			const itemId = decision.effectiveTerms!.itemId;
			const item = await vault.getItem(human, itemId);
			assert.strictEqual(item.hasValue, true);
			assert.strictEqual(item.name, "linear-key");
			assert.partialDeepEqual(item.owner, { kind: "project", organisationId: ORG, projectId: PROJECT });
			const grant = await vault.getGrant(human, decision.grantId!);
			assert.strictEqual(grant.itemId, itemId);
			const reads = [
				item,
				await vault.listItems(human),
				await vault.getProposal(human, proposal.id),
				await vault.listProposals(human),
				decision,
				grant,
				await vault.waitForOutcome(agent, proposal.id),
			];
			assert.strictEqual(containsCanary(reads), false, "the pasted value appears in no record");
			const allowed = await vault.decideEgress(egress("POST", "https://api.linear.app/graphql"));
			assert.strictEqual(allowed.inject?.value, `Bearer ${CANARY_SECRET}`);
		}),

		test("approves a read without a binding code", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 1 }));
			const { pickedCode: _omitted, ...withoutCode } = approval(proposal);
			const decision = await vault.decide(human, withoutCode);
			assert.strictEqual(decision.outcome, "approved");
			assert.strictEqual((await vault.getGrant(human, decision.grantId!)).status, "active");
			assert.strictEqual(deps.audit.ofType("vault.binding_code.mismatch").length, 0);
		}),

		test("refuses a read approval that cites a wrong binding code", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 1 }));
			await assertCodeRefused(
				vault,
				deps,
				proposal,
				approval(proposal, { pickedCode: await wrongCode(vault, proposal) }),
			);
		}),

		test("refuses a decision citing a different terms hash", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			await assert.rejectsWithCode(vault.decide(human, approval(proposal, { termsHash: "0".repeat(64) })), "refused");
			const { termsHash: _omitted, ...withoutHash } = approval(proposal);
			await assert.rejectsWithCode(vault.decide(human, withoutHash), "refused", "approving needs the terms hash");
			assert.strictEqual((await vault.getProposal(human, proposal.id)).status, "pending");
			assert.strictEqual(await grantCount(vault), 0);
		}),

		test("refuses a decision from an agent actor, even on its own proposal", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 1 }));
			await assert.rejectsWithCode(vault.decide(agent, approval(proposal)), "forbidden");
			await assert.rejectsWithCode(vault.decide(agent, { proposalId: proposal.id, outcome: "deny" }), "forbidden");
			assert.strictEqual((await vault.getProposal(agent, proposal.id)).status, "pending");
		}),

		test("refuses admin changes from an agent actor", async (vault) => {
			const item = await putGithubToken(vault);
			await assert.rejectsWithCode(
				vault.putItem(agent, {
					owner: { kind: "organisation", organisationId: ORG },
					name: "mine",
					hosts: [HOST],
					injection: { header: "Authorization", template: "Bearer {key}" },
					value: "x",
				}),
				"forbidden",
			);
			await assert.rejectsWithCode(
				vault.putPolicy(agent, {
					itemId: item.id,
					selector: { organisationId: ORG },
					route: { host: HOST, methods: ["GET"], pathPrefix: "/" },
				}),
				"forbidden",
			);
			await assert.rejectsWithCode(vault.setCeiling(agent, []), "forbidden");
		}),

		test("applies a narrowing and tells the agent the narrowed terms", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET", "POST"], { ttlMs: 3_600_000 }));
			const narrowing = { methods: ["GET"], pathPrefix: "/repos/harbour/", maxUses: 3, ttlMs: 60_000 } as const;
			await vault.decide(human, approval(proposal, { narrowing }));
			const outcome = await vault.waitForOutcome(agent, proposal.id);
			assert.strictEqual(outcome.status, "approved");
			assert.deepEqual(outcome.effectiveTerms, {
				itemId: item.id,
				route: { host: HOST, methods: ["GET"], pathPrefix: "/repos/harbour/" },
				expiresAt: deps.clock.now() + 60_000,
				maxUses: 3,
			});
			const denied = await vault.decideEgress(egress("POST", `https://${HOST}/repos/harbour/issues`));
			assert.strictEqual(denied.allow, false, "a narrowed-out method is denied");
			const outside = await vault.decideEgress(egress("GET", `https://${HOST}/repos/other`));
			assert.strictEqual(outside.allow, false, "a narrowed-out path is denied");
			const allowed = await vault.decideEgress(egress("GET", `https://${HOST}/repos/harbour/pulls`));
			assert.strictEqual(allowed.allow, true);
		}),

		test("refuses a narrowing that widens the terms", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], { ttlMs: 60_000, maxUses: 5 }));
			for (const narrowing of [
				{ methods: ["GET", "DELETE"] as const },
				{ pathPrefix: "/" },
				{ pathPrefix: "/repositories" },
				{ maxUses: 6 },
				{ ttlMs: 120_000 },
			]) {
				await assert.rejectsWithCode(
					vault.decide(human, approval(proposal, { narrowing })),
					"invalid",
					`widening ${JSON.stringify(narrowing)} is invalid`,
				);
			}
			assert.strictEqual((await vault.getProposal(human, proposal.id)).status, "pending");
			assert.strictEqual(await grantCount(vault), 0);
		}),

		test("resolves waitForOutcome after a later decision and says no request has run", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			let settled = false;
			const waiting = vault.waitForOutcome(agent, proposal.id).then((outcome) => {
				settled = true;
				return outcome;
			});
			await Promise.resolve();
			assert.strictEqual(settled, false, "the wait is still open before a decision");
			await vault.decide(human, approval(proposal));
			const outcome = await waiting;
			assert.strictEqual(outcome.status, "approved");
			assert.strictEqual(outcome.effectiveTerms?.itemId, item.id);
			assert.ok(outcome.message.includes("No request has run"), outcome.message);
		}),

		test("yields a denied outcome and no grant for a denied proposal", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			const waiting = vault.waitForOutcome(agent, proposal.id);
			const decision = await vault.decide(human, { proposalId: proposal.id, outcome: "deny", note: "Not today" });
			assert.strictEqual(decision.outcome, "denied");
			const outcome = await waiting;
			assert.strictEqual(outcome.status, "denied");
			assert.strictEqual(outcome.effectiveTerms, undefined);
			assert.ok(outcome.message.includes("No request has run"), outcome.message);
			assert.strictEqual(await grantCount(vault), 0);
			assert.strictEqual(deps.audit.ofType("vault.decision.denied").length, 1);
		}),

		test("stops waiting when the caller's signal aborts", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			const controller = new AbortController();
			const signalled = contextFor(agent.actor, ORG, PROJECT, { signal: controller.signal });
			const waiting = vault.waitForOutcome(signalled, proposal.id);
			controller.abort();
			await assert.rejectsWithCode(waiting, "aborted");
			assert.strictEqual((await vault.getProposal(agent, proposal.id)).status, "pending", "the proposal stays");
		}),

		test("refuses approving a pending proposal past its expiry", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			const waiting = vault.waitForOutcome(agent, proposal.id);
			deps.clock.set(proposal.expiresAt + 1);
			await assert.rejectsWithCode(vault.decide(human, approval(proposal)), "expired");
			assert.strictEqual((await vault.getProposal(human, proposal.id)).status, "expired");
			assert.strictEqual((await waiting).status, "expired");
			assert.strictEqual((await vault.waitForOutcome(agent, proposal.id)).status, "expired");
			assert.strictEqual(await grantCount(vault), 0);
		}),

		test("tells a waiting agent its proposal expired without anyone touching it", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			const waiting = vault.waitForOutcome(agent, proposal.id);
			deps.clock.set(proposal.expiresAt + 1);
			const outcome = await Promise.race([
				waiting,
				new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
			]);
			assert.strictEqual(outcome?.status, "expired", "the wait resolves as expired on its own");
		}),

		test("denies egress without a grant and offers a proposal as the fix", async (vault) => {
			await putGithubToken(vault);
			const decision = await vault.decideEgress(egress("GET", `https://${HOST}/repos/harbour`));
			assert.strictEqual(decision.allow, false);
			assert.strictEqual(decision.inject, undefined);
			assert.strictEqual(decision.fix?.action, "propose");
			assert.ok((decision.fix?.message.length ?? 0) > 0, "the fix says what to do");
			const unknownHost = await vault.decideEgress(egress("GET", "https://api.unknown.example/x"));
			assert.strictEqual(unknownHost.fix?.action, "propose");
			const recorded = await vault.listUses(human, { sessionId: "session-1" });
			assert.strictEqual(recorded.items.length, 2, "every call records a use");
			assert.strictEqual(recorded.items[0]?.outcome, "denied");
			assert.ok(recorded.items[0]?.reason !== undefined, "a denied use has a reason");
		}),

		test("allows egress under a matching grant and injects the credential header", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], {}));
			const decision = await vault.decide(human, approval(proposal));
			const allowed = await vault.decideEgress(egress("GET", `https://${HOST}/repos/harbour?page=2`));
			assert.strictEqual(allowed.allow, true);
			assert.strictEqual(allowed.grantId, decision.grantId);
			assert.deepEqual(allowed.inject, { header: "Authorization", value: `Bearer ${CANARY_SECRET}` });
			assert.strictEqual((await vault.getGrant(human, decision.grantId!)).uses, 1);
			const recorded = await vault.listUses(human);
			assert.partialDeepEqual(recorded.items, [
				{ id: allowed.useId, outcome: "injected", host: HOST, path: "/repos/harbour", grantId: decision.grantId },
			]);
			assert.strictEqual(deps.audit.ofType("vault.use.injected").length, 1);
		}),

		test("denies egress for another host, method, path prefix or session", async (vault) => {
			const item = await putGithubToken(vault);
			await vault.putItem(human, {
				owner: { kind: "organisation", organisationId: ORG },
				name: "uploads-token",
				hosts: ["uploads.github.com"],
				injection: { header: "Authorization", template: "Bearer {key}" },
				value: "another-value",
			});
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], {}));
			await vault.decide(human, approval(proposal));
			for (const [request, label] of [
				[egress("GET", "https://uploads.github.com/repos/harbour"), "another host"],
				[egress("DELETE", `https://${HOST}/repos/harbour`), "another method"],
				[egress("GET", `https://${HOST}/user`), "another path prefix"],
				[egress("GET", `https://${HOST}/repos/../user`), "a path escaping the prefix"],
				[egress("GET", `https://${HOST}/repositories`), "a path sharing the prefix's letters, not its segment"],
				[egress("GET", `http://${HOST}/repos/harbour`), "plain http"],
				[egress("GET", `https://${HOST}/repos/harbour`, { sessionId: "session-2" }), "another session"],
				[egress("GET", `https://${HOST}/repos/harbour`, { agentId: "agent-2" }), "another agent"],
			] as const) {
				const decision = await vault.decideEgress(request);
				assert.strictEqual(decision.allow, false, `denied for ${label}`);
				assert.strictEqual(decision.inject, undefined, `nothing injected for ${label}`);
				assert.ok(decision.fix !== undefined, `a fix for ${label}`);
			}
			assert.strictEqual((await vault.decideEgress(egress("GET", `https://${HOST}/repos/harbour`))).allow, true);
		}),

		test("matches a path prefix by whole segments", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], {}, "/repos"));
			await vault.decide(human, approval(proposal));
			assert.strictEqual((await vault.decideEgress(egress("GET", `https://${HOST}/repos`))).allow, true);
			assert.strictEqual((await vault.decideEgress(egress("GET", `https://${HOST}/repos/harbour`))).allow, true);
			assert.strictEqual((await vault.decideEgress(egress("GET", `https://${HOST}/repositories`))).allow, false);
		}),

		test("denies egress once a grant's uses are spent", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 2 }));
			const decision = await vault.decide(human, approval(proposal));
			const url = `https://${HOST}/repos/harbour`;
			assert.strictEqual((await vault.decideEgress(egress("GET", url))).allow, true);
			assert.strictEqual((await vault.decideEgress(egress("GET", url))).allow, true);
			const spent = await vault.decideEgress(egress("GET", url));
			assert.strictEqual(spent.allow, false);
			assert.strictEqual(spent.fix?.action, "propose");
			assert.partialDeepEqual(await vault.getGrant(human, decision.grantId!), { status: "exhausted", uses: 2 });
		}),

		test("denies egress after a grant expires by the clock", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], { ttlMs: 60_000 }));
			const decision = await vault.decide(human, approval(proposal));
			const url = `https://${HOST}/repos/harbour`;
			assert.strictEqual((await vault.decideEgress(egress("GET", url))).allow, true);
			deps.clock.advance(60_000);
			assert.strictEqual((await vault.decideEgress(egress("GET", url))).allow, false);
			assert.strictEqual((await vault.getGrant(human, decision.grantId!)).status, "expired");
		}),

		test("denies egress after a grant is revoked", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], {}));
			const decision = await vault.decide(human, approval(proposal));
			const revoked = await vault.revokeGrant(human, decision.grantId!, "No longer needed");
			assert.strictEqual(revoked.status, "revoked");
			assert.strictEqual(deps.audit.ofType("vault.grant.revoked").length, 1);
			assert.strictEqual((await vault.decideEgress(egress("GET", `https://${HOST}/repos/harbour`))).allow, false);
			assert.strictEqual((await vault.listGrants(human, { status: "revoked" })).items.length, 1);
		}),

		test("denies egress under a grant whose item has no value yet", async (vault) => {
			const item = await putGithubToken(vault, false);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], {}));
			await vault.decide(human, approval(proposal));
			const decision = await vault.decideEgress(egress("GET", `https://${HOST}/repos/harbour`));
			assert.strictEqual(decision.allow, false);
			assert.strictEqual(decision.fix?.action, "propose");
		}),

		test("refuses a proposal outside the organisation's ceiling", async (vault) => {
			const item = await putGithubToken(vault);
			await vault.setCeiling(human, [{ host: HOST, methods: ["GET", "HEAD"], pathPrefix: "/repos/" }]);
			assert.strictEqual((await vault.getCeiling(human)).routes.length, 1);
			await assert.rejectsWithCode(vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 })), "refused");
			await assert.rejectsWithCode(vault.propose(agent, termsFor(item.id, ["GET"], {}, "/")), "refused");
			assert.strictEqual((await vault.propose(agent, termsFor(item.id, ["GET"], {}))).status, "pending");
		}),

		test("refuses a proposal or policy for a host the item is not bound to", async (vault) => {
			const item = await putGithubToken(vault);
			const elsewhere = {
				...termsFor(item.id, ["GET"], {}),
				route: { host: "evil.example", methods: ["GET"], pathPrefix: "/" },
			};
			await assert.rejectsWithCode(vault.propose(agent, elsewhere as ProposalTerms), "refused");
			await assert.rejectsWithCode(
				vault.putPolicy(human, {
					itemId: item.id,
					selector: { organisationId: ORG },
					route: { host: "evil.example", methods: ["GET"], pathPrefix: "/" },
				}),
				"refused",
			);
		}),

		test("refuses a policy outside the ceiling and lets egress through under one inside it", async (vault, deps) => {
			const item = await putGithubToken(vault);
			await vault.setCeiling(human, [{ host: HOST, methods: ["GET"], pathPrefix: "/" }]);
			await assert.rejectsWithCode(
				vault.putPolicy(human, {
					itemId: item.id,
					selector: { organisationId: ORG },
					route: { host: HOST, methods: ["GET", "POST"], pathPrefix: "/" },
				}),
				"refused",
			);
			const policy = await vault.putPolicy(human, {
				itemId: item.id,
				selector: { organisationId: ORG, projectId: PROJECT },
				route: { host: HOST, methods: ["GET"], pathPrefix: "/repos/" },
			});
			assert.strictEqual(deps.audit.ofType("vault.policy.created").length, 1);
			const allowed = await vault.decideEgress(egress("GET", `https://${HOST}/repos/harbour`));
			assert.strictEqual(allowed.allow, true);
			assert.strictEqual(allowed.policyId, policy.id);
			assert.strictEqual(allowed.inject?.value, `Bearer ${CANARY_SECRET}`);
			const otherProject = await vault.decideEgress(egress("GET", `https://${HOST}/repos/x`, { projectId: "proj-b" }));
			assert.strictEqual(otherProject.allow, false, "the selector's project must match");
			const outside = await vault.decideEgress(egress("POST", `https://${HOST}/repos/harbour`));
			assert.strictEqual(outside.allow, false);
			assert.strictEqual(outside.fix?.action, "none", "nothing can allow a request outside the ceiling");
			await vault.revokePolicy(human, policy.id);
			assert.strictEqual((await vault.decideEgress(egress("GET", `https://${HOST}/repos/harbour`))).allow, false);
		}),

		test("expires and exhausts policies with a lifetime like grants", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const url = `https://${HOST}/repos/harbour`;
			await vault.putPolicy(human, {
				itemId: item.id,
				selector: { organisationId: ORG, sessionId: "session-1" },
				route: { host: HOST, methods: ["GET"], pathPrefix: "/" },
				lifetime: { maxUses: 1 },
			});
			assert.strictEqual((await vault.decideEgress(egress("GET", url))).allow, true);
			assert.strictEqual((await vault.decideEgress(egress("GET", url))).allow, false, "a spent policy denies");
			await vault.putPolicy(human, {
				itemId: item.id,
				selector: { organisationId: ORG },
				route: { host: HOST, methods: ["GET"], pathPrefix: "/" },
				lifetime: { expiresAt: deps.clock.now() + 1_000 },
			});
			assert.strictEqual((await vault.decideEgress(egress("GET", url))).allow, true);
			deps.clock.advance(1_000);
			assert.strictEqual((await vault.decideEgress(egress("GET", url))).allow, false, "an expired policy denies");
		}),

		test("refuses deciding a proposal twice", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			await vault.decide(human, approval(proposal));
			await assert.rejectsWithCode(vault.decide(human, approval(proposal)), "conflict");
			await assert.rejectsWithCode(vault.decide(human, { proposalId: proposal.id, outcome: "deny" }), "conflict");
			assert.strictEqual(await grantCount(vault), 1);
		}),

		test("settles concurrent decisions on one proposal exactly once", async (vault) => {
			for (const terms of [secretTerms, undefined]) {
				const proposal =
					terms === undefined
						? await vault.propose(agent, termsFor((await putGithubToken(vault)).id, ["POST"], { maxUses: 1 }))
						: await vault.propose(agent, terms);
				const approve = approval(proposal, terms === undefined ? {} : { secretValue: CANARY_SECRET });
				const waiting = vault.waitForOutcome(agent, proposal.id);
				const results = await Promise.allSettled([
					vault.decide(human, approve),
					vault.decide(human, approve),
					vault.decide(human, { proposalId: proposal.id, outcome: "deny" }),
				]);
				const won = results.filter((result) => result.status === "fulfilled");
				assert.strictEqual(won.length, 1, "exactly one decision wins");
				for (const result of results) {
					if (result.status === "rejected") {
						assert.strictEqual((result.reason as { code?: string }).code, "conflict", "the others are conflicts");
					}
				}
				const stored = await vault.getProposal(human, proposal.id);
				const outcome = await waiting;
				assert.strictEqual(outcome.status, stored.status, "the waiting agent hears the stored outcome");
			}
			const grants = await grantCount(vault);
			assert.ok(grants <= 2, "at most one grant per proposal");
			assert.ok((await vault.listItems(human)).items.filter((item) => item.name === "linear-key").length <= 1);
		}),

		test("refuses a secret paste without a code", async (vault, deps) => {
			const proposal = await vault.propose(agent, secretTerms);
			const { pickedCode: _omitted, ...withoutCode } = approval(proposal, { secretValue: CANARY_SECRET });
			await assertCodeRefused(vault, deps, proposal, withoutCode);
			assert.strictEqual((await vault.listItems(human)).items.length, 0, "no item was created");
		}),

		test("lets the agent withdraw its own pending proposal", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			await assert.rejectsWithCode(vault.withdraw(otherAgent, proposal.id), "forbidden", "not another agent's");
			const waiting = vault.waitForOutcome(agent, proposal.id);
			const withdrawn = await vault.withdraw(agent, proposal.id);
			assert.strictEqual(withdrawn.status, "withdrawn");
			assert.strictEqual((await waiting).status, "withdrawn");
			await assert.rejectsWithCode(vault.decide(human, approval(proposal)), "conflict");
			await assert.rejectsWithCode(vault.withdraw(agent, proposal.id), "conflict");
		}),

		test("keeps the canary value out of every record and audit event", async (vault, deps) => {
			const errors: unknown[] = [];
			const capture = async (operation: Promise<unknown>) => {
				try {
					await operation;
				} catch (error) {
					errors.push(isHarbourError(error) ? { message: error.message, details: error.details } : String(error));
				}
			};
			const item = await putGithubToken(vault);
			await vault.setCeiling(human, [
				{ host: HOST, methods: ["GET", "POST"], pathPrefix: "/" },
				{ host: "api.linear.app", methods: ["POST"], pathPrefix: "/" },
			]);
			const policy = await vault.putPolicy(human, {
				itemId: item.id,
				selector: { organisationId: ORG },
				route: { host: HOST, methods: ["GET"], pathPrefix: "/user" },
			});
			const route = await vault.propose(agent, termsFor(item.id, ["GET", "POST"], { maxUses: 3 }));
			await capture(vault.decide(human, approval(route, { pickedCode: await wrongCode(vault, route) })));
			const routeDecision = await vault.decide(human, approval(route));
			const secret = await vault.propose(agent, secretTerms);
			await capture(
				vault.decide(
					human,
					approval(secret, { pickedCode: await wrongCode(vault, secret), secretValue: CANARY_SECRET }),
				),
			);
			await capture(
				vault.decide(human, approval(secret, { secretValue: CANARY_SECRET, narrowing: { methods: ["DELETE"] } })),
			);
			const secretDecision = await vault.decide(human, approval(secret, { secretValue: CANARY_SECRET }));
			const injected = [
				await vault.decideEgress(egress("POST", `https://${HOST}/repos/harbour/issues`)),
				await vault.decideEgress(egress("GET", `https://${HOST}/user`, { sessionId: "session-9" })),
				await vault.decideEgress(egress("POST", "https://api.linear.app/graphql")),
			];
			const denied = [
				await vault.decideEgress(egress("DELETE", `https://${HOST}/repos/harbour`)),
				await vault.decideEgress(egress("GET", "https://elsewhere.example/")),
			];
			await vault.revokeGrant(human, routeDecision.grantId!);
			await vault.revokePolicy(human, policy.id);
			denied.push(await vault.decideEgress(egress("GET", `https://${HOST}/user`)));

			for (const decision of injected) {
				assert.strictEqual(decision.allow, true);
				assert.ok(containsCanary(decision.inject?.value), "the value appears in inject.value");
				assert.strictEqual(containsCanary({ ...decision, inject: undefined }), false, "and nowhere else");
			}
			assert.strictEqual(containsCanary(denied), false);
			const reads = [
				await vault.getItem(human, item.id),
				await vault.getItem(human, secretDecision.effectiveTerms!.itemId),
				await vault.listItems(human),
				await vault.getCeiling(human),
				await vault.listPolicies(human),
				await vault.getProposal(human, route.id),
				await vault.getProposal(agent, secret.id),
				await vault.listProposals(human),
				await vault.approvalView(human, secret.id),
				routeDecision,
				secretDecision,
				await vault.waitForOutcome(agent, route.id),
				await vault.waitForOutcome(agent, secret.id),
				await vault.getGrant(human, routeDecision.grantId!),
				await vault.listGrants(human),
				await vault.listUses(human),
			];
			assert.strictEqual(errors.length, 3, "every refusal was captured");
			assert.strictEqual(containsCanary(reads), false, "no read API returns the value");
			assert.strictEqual(containsCanary(errors), false, "no error carries the value");
			assert.greaterThan(deps.audit.events.length, 0);
			assert.strictEqual(containsCanary(deps.audit.events), false, "no audit event carries the value");
		}),

		test("hides another organisation's records as not found", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], {}));
			await assert.rejectsWithCode(vault.getProposal(outsider, proposal.id), "not_found");
			await assert.rejectsWithCode(vault.approvalView(outsider, proposal.id), "not_found");
			await assert.rejectsWithCode(vault.decide(outsider, approval(proposal)), "not_found");
			await assert.rejectsWithCode(vault.waitForOutcome(outsider, proposal.id), "not_found");
			await assert.rejectsWithCode(vault.getItem(outsider, item.id), "not_found");
			const decision = await vault.decide(human, approval(proposal));
			await assert.rejectsWithCode(vault.getGrant(outsider, decision.grantId!), "not_found");
			await assert.rejectsWithCode(vault.revokeGrant(outsider, decision.grantId!), "not_found");
			assert.strictEqual((await vault.listProposals(outsider)).items.length, 0);
			assert.strictEqual((await vault.listItems(outsider)).items.length, 0);
			assert.strictEqual((await vault.listGrants(outsider)).items.length, 0);
			const crossed = await vault.decideEgress(
				egress("GET", `https://${HOST}/repos/harbour`, { organisationId: OTHER_ORG }),
			);
			assert.strictEqual(crossed.allow, false, "another organisation's grant never applies");
		}),
	];
}

export function registerVaultConformance(
	runner: ConformanceRunner,
	name: string,
	provider: VaultConformanceProvider,
): void {
	registerCases(runner, name, createVaultConformance({ assertions: createExpectAssertions(runner.expect), provider }));
}
