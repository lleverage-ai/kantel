/**
 * Conformance suite for `Vault` (packages/contracts/src/vault.ts). Every target registers it with a provider that
 * builds a fresh vault on the suite's clock and audit sink.
 */
import {
	type CallContext,
	type ConnectorCredentialRequest,
	type ConnectorCredentials,
	type DecisionInput,
	type EgressDecision,
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
	assertAccessDenied,
	assertWorkerCallRefused,
	CANARY_SECRET,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceOptions,
	type ConformanceRunner,
	containsCanary,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
	WORKER,
} from "./harness.ts";

/** The vault every target builds: the `Vault` contract and the model gateway's connector credential read. */
export type HarbourVaultUnderTest = Vault & Required<ConnectorCredentials>;

export interface VaultSubject {
	readonly vault: HarbourVaultUnderTest;
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
/** The runtime's session-end hook calls the teardown with a system context in the session's organisation. */
const sessionEnd = contextFor(actors.system("session-end"), ORG);
/** Harbour's operator, the only caller that may create platform items. */
const operator = contextFor(actors.system("operator"), ORG);
/** The model gateway's call scope: agent-1's session in this project. */
const MODEL_SCOPE = { organisationId: ORG, projectId: PROJECT, agentId: "agent-1", sessionId: "session-1" } as const;
const MODEL_HOST = "llm.example.com";

function connectorRequest(itemId: string, extra: Partial<ConnectorCredentialRequest> = {}): ConnectorCredentialRequest {
	return {
		connectorId: "org-litellm",
		owner: { kind: "organisation", organisationId: ORG },
		vaultItemId: itemId,
		baseUrl: `https://${MODEL_HOST}/v1`,
		scope: MODEL_SCOPE,
		...extra,
	};
}

/** A model key: owned by the platform when `ctx` is the operator, else by the organisation of `ctx`. */
function putModelKey(
	vault: Vault,
	ctx: CallContext,
	owner: "platform" | "organisation" | "project",
	withValue = true,
): Promise<VaultItem> {
	return vault.putItem(ctx, {
		owner:
			owner === "platform"
				? { kind: "platform" }
				: owner === "project"
					? { kind: "project", organisationId: ctx.organisationId, projectId: PROJECT }
					: { kind: "organisation", organisationId: ctx.organisationId },
		name: `${owner}-model-key`,
		hosts: [MODEL_HOST],
		injection: { header: "Authorization", template: "Bearer {key}" },
		...(withValue ? { value: CANARY_SECRET } : {}),
	});
}

// Project access (settled question 7). `human` is an organisation-wide admin; these hold roles on one project only.
const OTHER_PROJECT = "proj-b";
const projectOperator = contextFor(actors.human("operator-a"), ORG, PROJECT);
const projectAdmin = contextFor(actors.human("admin-a"), ORG, PROJECT);
/** Claims this project in its context but holds operator on the other project only. */
const outsideOperator = contextFor(actors.human("operator-b"), ORG, PROJECT);
/** Claims this project in its context but holds admin on the other project only. */
const outsideAdmin = contextFor(actors.human("admin-b"), ORG, PROJECT);
/** An agent whose session belongs to the other project, claiming this one. */
const foreignAgent = contextFor(actors.agent("agent-3", "session-3"), ORG, PROJECT);
/** An agent in this project whose session the project-access case closes. */
const closingAgent = contextFor(actors.agent("agent-4", "session-4"), ORG, PROJECT);
/** An agent in a child session of `agent`'s session. */
const childAgent = contextFor(actors.agent("agent-5", "session-5"), ORG, PROJECT);

/** Gives every actor the cases use its role, and records every agent session, in `deps.tenancy`. */
function seedTenancy(deps: ConformanceDeps): void {
	const tenancy = deps.tenancy;
	tenancy.bind(human.actor, ORG, "admin");
	tenancy.bind(outsider.actor, OTHER_ORG, "admin");
	tenancy.bind(projectOperator.actor, ORG, "operator", PROJECT);
	tenancy.bind(projectAdmin.actor, ORG, "admin", PROJECT);
	tenancy.bind(outsideOperator.actor, ORG, "operator", OTHER_PROJECT);
	tenancy.bind(outsideAdmin.actor, ORG, "admin", OTHER_PROJECT);
	tenancy.session({ id: "session-1", organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });
	tenancy.session({ id: "session-2", organisationId: ORG, projectId: PROJECT, agentId: "agent-2" });
	tenancy.session({ id: "session-3", organisationId: ORG, projectId: OTHER_PROJECT, agentId: "agent-3" });
	tenancy.session({ id: "session-4", organisationId: ORG, projectId: PROJECT, agentId: "agent-4" });
	tenancy.session({
		id: "session-5",
		organisationId: ORG,
		projectId: PROJECT,
		agentId: "agent-5",
		parentSessionId: "session-1",
	});
}

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

/** Proposes as `ctx` and has `human` approve it; returns the grant's ID. */
async function approvedGrant(vault: Vault, ctx: CallContext, terms: ProposalTerms): Promise<string> {
	const proposal = await vault.propose(ctx, terms);
	return (await vault.decide(human, approval(proposal))).grantId!;
}

/** This project's records: an item, a policy, a pending proposal, an active grant and a use, all for session-1. */
async function projectRecords(vault: Vault) {
	const item = await putGithubToken(vault);
	const policy = await vault.putPolicy(human, {
		itemId: item.id,
		selector: { organisationId: ORG, projectId: PROJECT },
		route: { host: HOST, methods: ["GET"], pathPrefix: "/user" },
	});
	const pending = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
	const grantId = await approvedGrant(vault, agent, termsFor(item.id, ["GET"], {}));
	await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`));
	return { item, policy, pending, grantId };
}

export function createVaultConformance(options: {
	assertions: ConformanceAssertions;
	provider: VaultConformanceProvider;
	/** Adds the `project access:` cases; see `ConformanceOptions.projectAccess`. */
	projectAccess?: boolean;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (
		name: string,
		body: (vault: HarbourVaultUnderTest, deps: ConformanceDeps) => Promise<void>,
	): ConformanceCase => ({
		name,
		run: async () => {
			const deps = createDeps();
			seedTenancy(deps);
			await options.provider(deps, (subject) => body(subject.vault, deps));
		},
	});

	/** Runs each call in turn and asserts that project access refuses it, audited once under its operation. */
	async function assertEachDenied(
		deps: ConformanceDeps,
		calls: readonly (readonly [operation: string, call: () => Promise<unknown>])[],
		label: string,
	): Promise<void> {
		for (const [operation, call] of calls) {
			await assertAccessDenied(assert, deps, call(), { operation, message: `${operation} by ${label} is refused` });
		}
	}

	/** Asserts that `projectRecords` are as they were and that the vault audited nothing since `vaultEvents`. */
	async function assertUnchanged(
		vault: Vault,
		deps: ConformanceDeps,
		records: Awaited<ReturnType<typeof projectRecords>>,
		vaultEvents: number,
	): Promise<void> {
		assert.strictEqual(vaultAudits(deps), vaultEvents, "the vault audited no change");
		assert.strictEqual((await vault.getProposal(human, records.pending.id)).status, "pending", "still pending");
		assert.strictEqual((await vault.getGrant(human, records.grantId)).status, "active", "the grant is active");
		const policies = (await vault.listPolicies(human)).items;
		assert.strictEqual(policies.length, 1, "no policy was added");
		assert.strictEqual(policies[0]?.revokedAt, undefined, "the policy is not revoked");
		assert.strictEqual((await vault.listItems(human)).items.length, 1, "no item was added");
		assert.strictEqual((await vault.listProposals(human)).items.length, 2, "no proposal was added");
		assert.strictEqual(
			(await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`))).allow,
			true,
			"egress under the grant still works",
		);
	}

	const projectAccessCases: ConformanceCase[] = [
		test("project access: refuses an operator outside the project every change and read, and changes nothing", async (vault, deps) => {
			const records = await projectRecords(vault);
			const { item, policy, pending, grantId } = records;
			const before = vaultAudits(deps);
			const ctx = outsideOperator;
			await assertEachDenied(
				deps,
				[
					["vault.getItem", () => vault.getItem(ctx, item.id)],
					["vault.propose", () => vault.propose(ctx, termsFor(item.id, ["GET"], { maxUses: 1 }))],
					["vault.propose", () => vault.propose(ctx, secretTerms)],
					["vault.getProposal", () => vault.getProposal(ctx, pending.id)],
					["vault.listProposals", () => vault.listProposals(ctx, { sessionId: "session-1" })],
					["vault.approvalView", () => vault.approvalView(ctx, pending.id)],
					["vault.decide", () => vault.decide(ctx, approval(pending))],
					["vault.decide", () => vault.decide(ctx, { proposalId: pending.id, outcome: "deny" })],
					["vault.withdraw", () => vault.withdraw(ctx, pending.id)],
					["vault.waitForOutcome", () => vault.waitForOutcome(ctx, pending.id)],
					["vault.getGrant", () => vault.getGrant(ctx, grantId)],
					["vault.listGrants", () => vault.listGrants(ctx, { sessionId: "session-1" })],
					["vault.revokeGrant", () => vault.revokeGrant(ctx, grantId)],
					["vault.listUses", () => vault.listUses(ctx, { sessionId: "session-1" })],
					["vault.endSession", () => vault.endSession(ctx, "session-1", "session_ended")],
					["vault.getCeiling", () => vault.getCeiling(ctx)],
				],
				"an operator outside the project",
			);
			await assertEachDenied(
				deps,
				[
					[
						"vault.putItem",
						() =>
							vault.putItem(outsideAdmin, {
								owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
								name: "planted",
								hosts: [HOST],
								injection: { header: "Authorization", template: "Bearer {key}" },
								value: CANARY_SECRET,
							}),
					],
					[
						"vault.putItem",
						() =>
							vault.putItem(outsideAdmin, {
								owner: { kind: "organisation", organisationId: ORG },
								name: "planted",
								hosts: [HOST],
								injection: { header: "Authorization", template: "Bearer {key}" },
							}),
					],
					[
						"vault.putPolicy",
						() =>
							vault.putPolicy(outsideAdmin, {
								itemId: item.id,
								selector: { organisationId: ORG, projectId: OTHER_PROJECT },
								route: { host: HOST, methods: ["GET"], pathPrefix: "/" },
							}),
					],
					["vault.revokePolicy", () => vault.revokePolicy(outsideAdmin, policy.id)],
					[
						"vault.setCeiling",
						() => vault.setCeiling(outsideAdmin, [{ host: HOST, methods: ["GET"], pathPrefix: "/" }]),
					],
				],
				"an admin of another project",
			);
			await assertUnchanged(vault, deps, records, before);
		}),

		test("project access: refuses an agent whose session belongs to another project, and changes nothing", async (vault, deps) => {
			const records = await projectRecords(vault);
			const { item, pending, grantId } = records;
			const before = vaultAudits(deps);
			const ctx = foreignAgent;
			await assertEachDenied(
				deps,
				[
					["vault.propose", () => vault.propose(ctx, termsFor(item.id, ["GET"], { maxUses: 1 }))],
					["vault.getItem", () => vault.getItem(ctx, item.id)],
					["vault.getProposal", () => vault.getProposal(ctx, pending.id)],
					["vault.waitForOutcome", () => vault.waitForOutcome(ctx, pending.id)],
					["vault.listProposals", () => vault.listProposals(ctx, { sessionId: "session-1" })],
					["vault.getGrant", () => vault.getGrant(ctx, grantId)],
					["vault.listGrants", () => vault.listGrants(ctx, { sessionId: "session-1" })],
					["vault.listUses", () => vault.listUses(ctx, { sessionId: "session-1" })],
					["vault.endSession", () => vault.endSession(ctx, "session-1", "aborted")],
				],
				"an agent of another project",
			);
			await assertEachDenied(
				deps,
				[
					["vault.getProposal", () => vault.getProposal(otherAgent, pending.id)],
					["vault.listProposals", () => vault.listProposals(otherAgent, { sessionId: "session-1" })],
					["vault.getGrant", () => vault.getGrant(otherAgent, grantId)],
				],
				"an agent of another session in the project",
			);
			// The rules that refuse every agent still answer first.
			await assert.rejectsWithCode(vault.withdraw(ctx, pending.id), "forbidden");
			await assert.rejectsWithCode(vault.revokeGrant(ctx, grantId), "forbidden");
			await assert.rejectsWithCode(vault.decide(ctx, approval(pending)), "forbidden");
			await assertUnchanged(vault, deps, records, before);
		}),

		test("project access: refuses an agent whose session was closed", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(closingAgent, termsFor(item.id, ["GET"], {}));
			assert.strictEqual(proposal.projectId, PROJECT);
			deps.tenancy.close("session-4");
			const before = vaultAudits(deps);
			await assertEachDenied(
				deps,
				[
					["vault.propose", () => vault.propose(closingAgent, termsFor(item.id, ["GET"], { maxUses: 1 }))],
					["vault.propose", () => vault.propose(closingAgent, secretTerms)],
					["vault.getProposal", () => vault.getProposal(closingAgent, proposal.id)],
					["vault.waitForOutcome", () => vault.waitForOutcome(closingAgent, proposal.id)],
					["vault.withdraw", () => vault.withdraw(closingAgent, proposal.id)],
					["vault.listProposals", () => vault.listProposals(closingAgent, { sessionId: "session-4" })],
				],
				"an agent of a closed session",
			);
			assert.strictEqual(vaultAudits(deps), before, "the vault audited no change");
			assert.strictEqual((await vault.getProposal(human, proposal.id)).status, "pending");
			assert.strictEqual((await vault.listProposals(human)).items.length, 1);
		}),

		test("project access: lists leave out another project's records for an operator outside it", async (vault) => {
			const ours = await putGithubToken(vault);
			const theirs = await vault.putItem(human, {
				owner: { kind: "project", organisationId: ORG, projectId: OTHER_PROJECT },
				name: "github-token-b",
				hosts: [HOST],
				injection: { header: "Authorization", template: "Bearer {key}" },
				value: "another-value",
			});
			const shared = await vault.putItem(human, {
				owner: { kind: "organisation", organisationId: ORG },
				name: "uploads-token",
				hosts: ["uploads.github.com"],
				injection: { header: "Authorization", template: "Bearer {key}" },
			});
			const policyFor = (item: VaultItem, projectId?: string) =>
				vault.putPolicy(human, {
					itemId: item.id,
					selector: { organisationId: ORG, ...(projectId === undefined ? {} : { projectId }) },
					route: { host: item.hosts[0]!, methods: ["GET"], pathPrefix: "/user" },
				});
			await policyFor(ours, PROJECT);
			const theirPolicy = await policyFor(theirs, OTHER_PROJECT);
			const sharedPolicy = await policyFor(shared);
			const ourGrant = await approvedGrant(vault, agent, termsFor(ours.id, ["GET"], {}));
			const theirProposal = await vault.propose(foreignAgent, termsFor(theirs.id, ["GET"], {}));
			assert.strictEqual(theirProposal.projectId, OTHER_PROJECT, "the proposal is in the agent's session's project");
			const theirGrant = (await vault.decide(human, approval(theirProposal))).grantId!;
			await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`));
			const theirUse = await vault.decideEgress(
				WORKER,
				egress("GET", `https://${HOST}/repos/harbour`, {
					projectId: OTHER_PROJECT,
					agentId: "agent-3",
					sessionId: "session-3",
				}),
			);
			const ids = (page: { readonly items: readonly { readonly id: string }[] }) =>
				page.items.map((record) => record.id);

			assert.deepEqual(ids(await vault.listItems(outsideOperator)), [theirs.id, shared.id], "items");
			assert.deepEqual(ids(await vault.listPolicies(outsideOperator)), [theirPolicy.id, sharedPolicy.id], "policies");
			assert.deepEqual(ids(await vault.listProposals(outsideOperator)), [theirProposal.id], "proposals");
			assert.deepEqual(ids(await vault.listGrants(outsideOperator)), [theirGrant], "grants");
			assert.deepEqual(ids(await vault.listUses(outsideOperator)), [theirUse.useId], "uses");
			assert.deepEqual(ids(await vault.listProposals(agent)), [(await vault.getGrant(human, ourGrant)).proposalId]);
			assert.deepEqual(ids(await vault.listGrants(agent)), [ourGrant], "an agent lists its own session's grants");
			assert.strictEqual((await vault.listItems(human)).items.length, 3, "an organisation admin sees every item");
			assert.strictEqual((await vault.listGrants(human)).items.length, 2, "and every grant");
		}),

		test("project access: lets an operator on the project and an agent in its own session through", async (vault, deps) => {
			const item = await vault.putItem(projectAdmin, {
				owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
				name: "github-token",
				hosts: [HOST],
				injection: { header: "Authorization", template: "Bearer {key}" },
				value: CANARY_SECRET,
			});
			const policy = await vault.putPolicy(projectAdmin, {
				itemId: item.id,
				selector: { organisationId: ORG, projectId: PROJECT },
				route: { host: HOST, methods: ["GET"], pathPrefix: "/user" },
			});
			await vault.revokePolicy(projectAdmin, policy.id);
			assert.strictEqual((await vault.getItem(projectOperator, item.id)).id, item.id);
			assert.strictEqual((await vault.listItems(projectOperator)).items.length, 1);
			assert.strictEqual((await vault.listPolicies(projectOperator)).items.length, 1);

			// The proposal's project is the agent's session's, whatever its context claims.
			const claiming = contextFor(agent.actor, ORG, OTHER_PROJECT);
			const proposal = await vault.propose(claiming, termsFor(item.id, ["GET"], {}));
			assert.strictEqual(proposal.projectId, PROJECT);
			assert.strictEqual((await vault.getProposal(agent, proposal.id)).id, proposal.id);
			assert.strictEqual((await vault.listProposals(agent, { sessionId: "session-1" })).items.length, 1);
			const child = await vault.propose(childAgent, termsFor(item.id, ["GET"], { maxUses: 1 }));
			assert.strictEqual((await vault.getProposal(agent, child.id)).id, child.id, "a supervisor sees its child's");
			await vault.withdraw(childAgent, child.id);

			const view = await vault.approvalView(projectOperator, proposal.id);
			assert.strictEqual(view.proposal.id, proposal.id);
			const waiting = vault.waitForOutcome(agent, proposal.id);
			const decision = await vault.decide(projectOperator, approval(proposal));
			assert.strictEqual((await waiting).status, "approved");
			const grantId = decision.grantId!;
			assert.strictEqual((await vault.getGrant(projectOperator, grantId)).status, "active");
			assert.strictEqual((await vault.getGrant(agent, grantId)).status, "active");
			assert.strictEqual((await vault.listGrants(projectOperator, { sessionId: "session-1" })).items.length, 1);
			assert.strictEqual(
				(await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`))).allow,
				true,
			);
			assert.strictEqual((await vault.listUses(agent, { sessionId: "session-1" })).items.length, 1);

			const asked = await vault.propose(projectOperator, termsFor(item.id, ["POST"], { maxUses: 1 }));
			assert.strictEqual(asked.projectId, PROJECT, "an operator's proposal is in the item's project");
			assert.strictEqual((await vault.withdraw(projectOperator, asked.id)).status, "withdrawn");
			const own = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			assert.strictEqual((await vault.withdraw(agent, own.id)).status, "withdrawn");
			assert.strictEqual((await vault.revokeGrant(projectOperator, grantId)).status, "revoked");
			await vault.endSession(projectOperator, "session-1", "aborted");
			await vault.endSession(agent, "session-1", "session_ended");
			assert.strictEqual(deps.audit.ofType("access.denied").length, 0, "nothing was refused");
		}),
	];

	const sessionEndCases: ConformanceCase[] = [
		test("ends a session's grants and withdraws its pending proposals when the session ends", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const url = `https://${HOST}/repos/harbour`;
			const first = await approvedGrant(vault, agent, termsFor(item.id, ["GET"], {}));
			const second = await approvedGrant(vault, agent, termsFor(item.id, ["POST"], { maxUses: 5 }));
			const theirs = await approvedGrant(vault, otherAgent, termsFor(item.id, ["GET"], {}));
			const pending = await vault.propose(agent, termsFor(item.id, ["DELETE"], { maxUses: 1 }));
			const theirPending = await vault.propose(otherAgent, termsFor(item.id, ["DELETE"], { maxUses: 1 }));
			const waiting = vault.waitForOutcome(agent, pending.id);
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, true, "allowed before");

			await vault.endSession(sessionEnd, "session-1", "session_ended");
			for (const grantId of [first, second]) {
				assert.partialDeepEqual(await vault.getGrant(human, grantId), { status: "revoked", endReason: "revoked" });
			}
			const revoked = deps.audit.ofType("vault.grant.revoked");
			assert.deepEqual(
				revoked.map((event) => event.subject?.id),
				[first, second],
				"each grant's revocation is audited once",
			);
			for (const event of revoked) assert.strictEqual(event.data?.reason, "session_ended");
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, false, "egress is denied after");
			assert.strictEqual((await vault.decideEgress(WORKER, egress("POST", url))).allow, false);
			assert.strictEqual((await waiting).status, "withdrawn", "the waiting agent hears it was withdrawn");
			assert.strictEqual((await vault.getProposal(human, pending.id)).status, "withdrawn");
			const withdrawn = deps.audit.ofType("vault.proposal.withdrawn");
			assert.deepEqual(
				withdrawn.map((event) => event.subject?.id),
				[pending.id],
			);
			assert.strictEqual(withdrawn[0]?.data?.reason, "session_ended");

			assert.strictEqual((await vault.getGrant(human, theirs)).status, "active", "another session's grant stays");
			assert.strictEqual((await vault.getProposal(human, theirPending.id)).status, "pending");
			const theirEgress = egress("GET", url, { agentId: "agent-2", sessionId: "session-2" });
			assert.strictEqual((await vault.decideEgress(WORKER, theirEgress)).allow, true);

			const events = deps.audit.events.length;
			const grants = await vault.listGrants(human);
			const proposals = await vault.listProposals(human);
			deps.clock.advance(1_000);
			await vault.endSession(sessionEnd, "session-1", "session_ended");
			await vault.endSession(sessionEnd, "session-1", "aborted");
			assert.strictEqual(deps.audit.events.length, events, "a second teardown audits nothing");
			assert.deepEqual(await vault.listGrants(human), grants, "and changes no grant");
			assert.deepEqual(await vault.listProposals(human), proposals, "or proposal");
		}),

		test("ends a session's grants on abort and leaves its pending proposals and later grants working", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const url = `https://${HOST}/repos/harbour`;
			const held = await approvedGrant(vault, agent, termsFor(item.id, ["GET"], {}));
			const theirs = await approvedGrant(vault, otherAgent, termsFor(item.id, ["GET"], {}));
			const pending = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
			let settled = false;
			const waiting = vault.waitForOutcome(agent, pending.id).then((outcome) => {
				settled = true;
				return outcome;
			});

			await vault.endSession(sessionEnd, "session-1", "aborted");
			assert.strictEqual((await vault.getGrant(human, held)).status, "revoked");
			const revoked = deps.audit.ofType("vault.grant.revoked");
			assert.deepEqual(
				revoked.map((event) => event.subject?.id),
				[held],
			);
			assert.strictEqual(revoked[0]?.data?.reason, "aborted");
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, false, "egress is denied after");
			assert.strictEqual((await vault.getGrant(human, theirs)).status, "active", "another session's grant stays");
			const theirEgress = egress("GET", url, { agentId: "agent-2", sessionId: "session-2" });
			assert.strictEqual((await vault.decideEgress(WORKER, theirEgress)).allow, true);
			assert.strictEqual((await vault.getProposal(human, pending.id)).status, "pending", "the proposal stays");
			assert.strictEqual(deps.audit.ofType("vault.proposal.withdrawn").length, 0);
			assert.strictEqual(settled, false, "the wait is still open");

			const events = deps.audit.events.length;
			const grants = await vault.listGrants(human);
			deps.clock.advance(1_000);
			await vault.endSession(sessionEnd, "session-1", "aborted");
			assert.strictEqual(deps.audit.events.length, events, "a second teardown audits nothing");
			assert.deepEqual(await vault.listGrants(human), grants, "and changes no grant");

			// The session stays usable: what it is granted after the abort works.
			const decision = await vault.decide(human, approval(pending));
			assert.strictEqual((await waiting).status, "approved");
			assert.strictEqual((await vault.getGrant(human, decision.grantId!)).status, "active");
			assert.strictEqual((await vault.decideEgress(WORKER, egress("POST", `${url}/issues`))).allow, true);
		}),
	];

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

	const cases: ConformanceCase[] = [
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
			const allowed = await vault.decideEgress(WORKER, egress("POST", "https://api.linear.app/graphql"));
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
			const denied = await vault.decideEgress(WORKER, egress("POST", `https://${HOST}/repos/harbour/issues`));
			assert.strictEqual(denied.allow, false, "a narrowed-out method is denied");
			const outside = await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/other`));
			assert.strictEqual(outside.allow, false, "a narrowed-out path is denied");
			const allowed = await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour/pulls`));
			assert.strictEqual(allowed.allow, true);
		}),

		test("refuses a narrowing that widens the terms", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], { ttlMs: 60_000, maxUses: 5 }));
			for (const narrowing of [
				{ methods: ["GET", "DELETE"] as const },
				{ pathPrefix: "/" },
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

		test("refuses a narrowing to a sibling path that shares the prefix's letters", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], {}, "/repos"));
			for (const pathPrefix of ["/repositories", "/reposX/"]) {
				await assert.rejectsWithCode(
					vault.decide(human, approval(proposal, { narrowing: { pathPrefix } })),
					"invalid",
					`narrowing /repos to ${pathPrefix} is invalid`,
				);
			}
			const decision = await vault.decide(human, approval(proposal, { narrowing: { pathPrefix: "/repos/harbour" } }));
			assert.strictEqual(decision.effectiveTerms?.route.pathPrefix, "/repos/harbour");
		}),

		test("keeps an approval that lands as the proposal expires consistent", async (vault, deps) => {
			const proposal = await vault.propose(agent, secretTerms);
			const waiting = vault.waitForOutcome(agent, proposal.id);
			const deciding = vault.decide(human, approval(proposal, { secretValue: CANARY_SECRET })).then(
				(decision) => decision.outcome as string,
				(error: { code?: string }) => error.code ?? "error",
			);
			deps.clock.set(proposal.expiresAt + 1);
			const seen = (await vault.getProposal(human, proposal.id)).status;
			const result = await deciding;
			const stored = (await vault.getProposal(human, proposal.id)).status;
			const heard = (await waiting).status;
			assert.strictEqual(stored, seen, "a settled status never changes");
			assert.strictEqual(heard, stored, "the waiting agent hears the stored outcome");
			assert.strictEqual(result === "approved", stored === "approved", "decide reports what was stored");
			assert.ok((await grantCount(vault)) === (stored === "approved" ? 1 : 0), "a grant exists only if approved");
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
			const decision = await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`));
			assert.strictEqual(decision.allow, false);
			assert.strictEqual(decision.inject, undefined);
			assert.strictEqual(decision.fix?.action, "propose");
			assert.ok((decision.fix?.message.length ?? 0) > 0, "the fix says what to do");
			const unknownHost = await vault.decideEgress(WORKER, egress("GET", "https://api.unknown.example/x"));
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
			const allowed = await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour?page=2`));
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
				const decision = await vault.decideEgress(WORKER, request);
				assert.strictEqual(decision.allow, false, `denied for ${label}`);
				assert.strictEqual(decision.inject, undefined, `nothing injected for ${label}`);
				assert.ok(decision.fix !== undefined, `a fix for ${label}`);
			}
			assert.strictEqual(
				(await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`))).allow,
				true,
			);
		}),

		test("matches a path prefix by whole segments", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], {}, "/repos"));
			await vault.decide(human, approval(proposal));
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos`))).allow, true);
			assert.strictEqual(
				(await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`))).allow,
				true,
			);
			assert.strictEqual(
				(await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repositories`))).allow,
				false,
			);
		}),

		test("denies egress once a grant's uses are spent", async (vault) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 2 }));
			const decision = await vault.decide(human, approval(proposal));
			const url = `https://${HOST}/repos/harbour`;
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, true);
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, true);
			const spent = await vault.decideEgress(WORKER, egress("GET", url));
			assert.strictEqual(spent.allow, false);
			assert.strictEqual(spent.fix?.action, "propose");
			assert.partialDeepEqual(await vault.getGrant(human, decision.grantId!), { status: "exhausted", uses: 2 });
		}),

		test("denies egress after a grant expires by the clock", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], { ttlMs: 60_000 }));
			const decision = await vault.decide(human, approval(proposal));
			const url = `https://${HOST}/repos/harbour`;
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, true);
			deps.clock.advance(60_000);
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, false);
			assert.strictEqual((await vault.getGrant(human, decision.grantId!)).status, "expired");
		}),

		test("denies egress after a grant is revoked", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], {}));
			const decision = await vault.decide(human, approval(proposal));
			const revoked = await vault.revokeGrant(human, decision.grantId!, "No longer needed");
			assert.strictEqual(revoked.status, "revoked");
			assert.strictEqual(deps.audit.ofType("vault.grant.revoked").length, 1);
			assert.strictEqual(
				(await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`))).allow,
				false,
			);
			assert.strictEqual((await vault.listGrants(human, { status: "revoked" })).items.length, 1);
		}),

		test("denies egress under a grant whose item has no value yet", async (vault) => {
			const item = await putGithubToken(vault, false);
			const proposal = await vault.propose(agent, termsFor(item.id, ["GET"], {}));
			await vault.decide(human, approval(proposal));
			const decision = await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`));
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
			const allowed = await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`));
			assert.strictEqual(allowed.allow, true);
			assert.strictEqual(allowed.policyId, policy.id);
			assert.strictEqual(allowed.inject?.value, `Bearer ${CANARY_SECRET}`);
			const otherProject = await vault.decideEgress(
				WORKER,
				egress("GET", `https://${HOST}/repos/x`, { projectId: "proj-b" }),
			);
			assert.strictEqual(otherProject.allow, false, "the selector's project must match");
			const outside = await vault.decideEgress(WORKER, egress("POST", `https://${HOST}/repos/harbour`));
			assert.strictEqual(outside.allow, false);
			assert.strictEqual(outside.fix?.action, "none", "nothing can allow a request outside the ceiling");
			await vault.revokePolicy(human, policy.id);
			assert.strictEqual(
				(await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/repos/harbour`))).allow,
				false,
			);
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
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, true);
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, false, "a spent policy denies");
			await vault.putPolicy(human, {
				itemId: item.id,
				selector: { organisationId: ORG },
				route: { host: HOST, methods: ["GET"], pathPrefix: "/" },
				lifetime: { expiresAt: deps.clock.now() + 1_000 },
			});
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, true);
			deps.clock.advance(1_000);
			assert.strictEqual(
				(await vault.decideEgress(WORKER, egress("GET", url))).allow,
				false,
				"an expired policy denies",
			);
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
				await vault.decideEgress(WORKER, egress("POST", `https://${HOST}/repos/harbour/issues`)),
				await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/user`, { sessionId: "session-9" })),
				await vault.decideEgress(WORKER, egress("POST", "https://api.linear.app/graphql")),
			];
			const denied = [
				await vault.decideEgress(WORKER, egress("DELETE", `https://${HOST}/repos/harbour`)),
				await vault.decideEgress(WORKER, egress("GET", "https://elsewhere.example/")),
			];
			await vault.revokeGrant(human, routeDecision.grantId!);
			await vault.revokePolicy(human, policy.id);
			denied.push(await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/user`)));

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
				WORKER,
				egress("GET", `https://${HOST}/repos/harbour`, { organisationId: OTHER_ORG }),
			);
			assert.strictEqual(crossed.allow, false, "another organisation's grant never applies");
		}),
		test("worker calls: decideEgress refuses every caller but the gateway's system one, and records no use", async (vault, deps) => {
			await projectRecords(vault);
			const uses = (await vault.listUses(human)).items.length;
			const request = egress("GET", `https://${HOST}/repos/harbour`);
			await assertWorkerCallRefused(
				assert,
				deps,
				"vault.decideEgress",
				(caller) => vault.decideEgress(caller, request),
				ORG,
				{ agentId: "agent-1", sessionId: "session-1" },
			);
			assert.strictEqual((await vault.listUses(human)).items.length, uses, "a refused call records no use");
			assert.strictEqual((await vault.decideEgress(WORKER, request)).allow, true, "the gateway's own call still works");
		}),
	];
	/** Asserts that a connector read is refused with `code`, recording one denied use audited as `vault.use.denied`. */
	async function assertConnectorRefused(
		vault: HarbourVaultUnderTest,
		deps: ConformanceDeps,
		request: ConnectorCredentialRequest,
		code: "refused" | "invalid",
		label: string,
	): Promise<void> {
		const uses = (await vault.listUses(human)).items.length;
		const denied = deps.audit.ofType("vault.use.denied").length;
		await assert.rejectsWithCode(vault.readConnectorCredential(WORKER, request), code, label);
		const recorded = (await vault.listUses(human)).items;
		assert.strictEqual(recorded.length, uses + 1, `${label}: a use is recorded`);
		assert.partialDeepEqual(recorded.at(-1), { outcome: "denied", method: "POST", sessionId: "session-1" });
		assert.ok(recorded.at(-1)?.reason !== undefined, `${label}: the denied use has a reason`);
		assert.strictEqual(deps.audit.ofType("vault.use.denied").length, denied + 1, `${label}: audited as denied`);
	}

	const platformAndConnectorCases: ConformanceCase[] = [
		test("platform items: only a system caller creates one, and no organisation's caller lists or reads it", async (vault, deps) => {
			const platform = await putModelKey(vault, operator, "platform");
			assert.partialDeepEqual(platform, { owner: { kind: "platform" }, hasValue: true });
			for (const ctx of [human, projectAdmin, outsider]) {
				const before = deps.audit.ofType("access.denied").length;
				await assert.rejectsWithCode(putModelKey(vault, ctx, "platform"), "forbidden", "only the operator");
				assert.strictEqual(deps.audit.ofType("access.denied").length, before + 1, "the refusal is audited");
			}
			await assert.rejectsWithCode(putModelKey(vault, agent, "platform"), "forbidden", "never an agent");
			for (const ctx of [human, outsider, operator]) {
				await assert.rejectsWithCode(vault.getItem(ctx, platform.id), "not_found", "no organisation reads it");
				assert.strictEqual((await vault.listItems(ctx)).items.length, 0, "no organisation lists it");
			}
			await assert.rejectsWithCode(
				vault.putPolicy(human, {
					itemId: platform.id,
					selector: { organisationId: ORG },
					route: { host: MODEL_HOST, methods: ["POST"], pathPrefix: "/" },
				}),
				"not_found",
				"no organisation's policy can use it",
			);
			await assert.rejectsWithCode(
				vault.propose(agent, termsFor(platform.id, ["POST"], { maxUses: 1 })),
				"not_found",
				"and no proposal can name it",
			);
			assert.strictEqual(containsCanary(deps.audit.events), false, "the audit holds no value");
		}),

		test("connector credentials: refuses every caller but the model gateway's system one, and records no use", async (vault, deps) => {
			const item = await putModelKey(vault, human, "organisation");
			await assertWorkerCallRefused(
				assert,
				deps,
				"vault.readConnectorCredential",
				(caller) => vault.readConnectorCredential(caller, connectorRequest(item.id)),
				ORG,
				{ agentId: "agent-1", sessionId: "session-1" },
			);
			assert.strictEqual((await vault.listUses(human)).items.length, 0, "a refused call records no use");
			assert.strictEqual(deps.audit.ofType("vault.use.denied").length, 0);
			assert.strictEqual(
				(await vault.readConnectorCredential(WORKER, connectorRequest(item.id))).value,
				CANARY_SECRET,
				"the gateway's own call still works",
			);
		}),

		test("connector credentials: refuses an item that does not belong to the connector's owner", async (vault, deps) => {
			const platform = await putModelKey(vault, operator, "platform");
			const own = await putModelKey(vault, human, "organisation");
			const theirs = await putModelKey(vault, outsider, "organisation");
			const platformConnector = { connectorId: "platform-cpa", owner: { kind: "platform" } } as const;
			for (const [request, label] of [
				[connectorRequest(own.id, platformConnector), "an organisation's item for a platform connector"],
				[connectorRequest(platform.id), "a platform item for an organisation's connector"],
				[connectorRequest(theirs.id), "another organisation's item"],
				[
					connectorRequest(theirs.id, { owner: { kind: "organisation", organisationId: OTHER_ORG } }),
					"another organisation's connector for this organisation's session",
				],
				[connectorRequest("item_missing"), "an item that does not exist"],
			] as const) {
				await assertConnectorRefused(vault, deps, request, "refused", label);
			}
			assert.strictEqual(
				(await vault.readConnectorCredential(WORKER, connectorRequest(platform.id, platformConnector))).itemId,
				platform.id,
				"a platform connector reads a platform item",
			);
			const projectItem = await putModelKey(vault, human, "project");
			assert.strictEqual(
				(await vault.readConnectorCredential(WORKER, connectorRequest(projectItem.id))).itemId,
				projectItem.id,
				"an organisation's connector reads an item of one of its projects",
			);
		}),

		test("connector credentials: refuses a base URL whose host the item is not bound to", async (vault, deps) => {
			const item = await putModelKey(vault, human, "organisation");
			for (const [baseUrl, code] of [
				["https://evil.example/v1", "refused"],
				[`https://${MODEL_HOST}.evil.example/v1`, "refused"],
				[`ftp://${MODEL_HOST}/v1`, "invalid"],
				["not a url", "invalid"],
			] as const) {
				await assertConnectorRefused(vault, deps, connectorRequest(item.id, { baseUrl }), code, baseUrl);
			}
		}),

		test("connector credentials: refuses an item without a value", async (vault, deps) => {
			const item = await putModelKey(vault, human, "organisation", false);
			await assertConnectorRefused(vault, deps, connectorRequest(item.id), "refused", "an item without a value");
		}),

		test("connector credentials: reads the key, over http too, and records a use for the session", async (vault, deps) => {
			const item = await putModelKey(vault, human, "organisation");
			const credential = await vault.readConnectorCredential(WORKER, connectorRequest(item.id));
			assert.deepEqual(credential, {
				itemId: item.id,
				valueVersion: item.valueVersion,
				value: CANARY_SECRET,
				useId: credential.useId,
			});
			const internal = await vault.readConnectorCredential(
				WORKER,
				connectorRequest(item.id, { baseUrl: `http://${MODEL_HOST}:8317/v1` }),
			);
			assert.strictEqual(internal.value, CANARY_SECRET, "plain http is allowed for a connector");
			const recorded = (await vault.listUses(human, { sessionId: "session-1" })).items;
			assert.partialDeepEqual(recorded, [
				{
					id: credential.useId,
					organisationId: ORG,
					sessionId: "session-1",
					itemId: item.id,
					method: "POST",
					host: MODEL_HOST,
					path: "/v1",
					outcome: "injected",
				},
				{ id: internal.useId, outcome: "injected" },
			]);
			const injected = deps.audit.ofType("vault.use.injected");
			assert.deepEqual(
				injected.map((event) => event.subject?.id),
				[credential.useId, internal.useId],
				"each read is audited as vault.use.injected",
			);
			assert.partialDeepEqual(injected[0], { organisationId: ORG, projectId: PROJECT, sessionId: "session-1" });
		}),

		test("organisation scope: connector credentials: reads the key for an organisation session, which has no project", async (vault, deps) => {
			deps.tenancy.session({ id: "session-9", organisationId: ORG, agentId: "agent-9" });
			const item = await putModelKey(vault, human, "organisation");
			const scope = { organisationId: ORG, agentId: "agent-9", sessionId: "session-9" };
			const credential = await vault.readConnectorCredential(WORKER, connectorRequest(item.id, { scope }));
			assert.strictEqual(credential.value, CANARY_SECRET, "the key is read without a project");
			const [use] = (await vault.listUses(human, { sessionId: "session-9" })).items;
			assert.partialDeepEqual(use, { id: credential.useId, sessionId: "session-9", outcome: "injected" });
			const [event] = deps.audit.ofType("vault.use.injected");
			assert.strictEqual(event?.projectId, undefined, "the use is audited with no project");
			const blank = connectorRequest(item.id, { scope: { ...scope, projectId: "" } });
			await assert.rejectsWithCode(vault.readConnectorCredential(WORKER, blank), "invalid", "a blank project");
		}),

		test("connector credentials: keep the canary out of every use and audit event, returning it only as the value", async (vault, deps) => {
			const errors: unknown[] = [];
			const item = await putModelKey(vault, human, "organisation");
			const platform = await putModelKey(vault, operator, "platform");
			const credentials = [
				await vault.readConnectorCredential(WORKER, connectorRequest(item.id)),
				await vault.readConnectorCredential(
					WORKER,
					connectorRequest(platform.id, { connectorId: "platform-cpa", owner: { kind: "platform" } }),
				),
			];
			for (const request of [
				connectorRequest(platform.id),
				connectorRequest(item.id, { baseUrl: "https://evil.example/" }),
			]) {
				try {
					await vault.readConnectorCredential(WORKER, request);
				} catch (error) {
					errors.push(isHarbourError(error) ? { message: error.message, details: error.details } : String(error));
				}
			}
			for (const credential of credentials) {
				assert.strictEqual(credential.value, CANARY_SECRET, "the value is returned");
				assert.strictEqual(containsCanary({ ...credential, value: undefined }), false, "and nowhere else");
			}
			assert.strictEqual(errors.length, 2, "every refusal was captured");
			assert.strictEqual(containsCanary(errors), false, "no error carries the value");
			assert.strictEqual(containsCanary(await vault.listUses(human)), false, "no use carries the value");
			assert.strictEqual(containsCanary(await vault.listItems(human)), false, "no item read carries the value");
			assert.greaterThan(deps.audit.events.length, 0);
			assert.strictEqual(containsCanary(deps.audit.events), false, "no audit event carries the value");
		}),
	];

	/** Issues session-1's placeholders and returns the one for `itemId`. */
	async function placeholderFor(vault: HarbourVaultUnderTest, itemId: string, sessionId = "session-1") {
		const issued = await vault.issueSessionPlaceholders(WORKER, { organisationId: ORG, projectId: PROJECT, sessionId });
		const found = issued.placeholders.find((entry) => entry.itemId === itemId);
		assert.ok(found, `a placeholder is issued for ${itemId}`);
		return { issued, placeholder: found!.placeholder };
	}

	/** The github token with a policy letting session-1's project GET /user with it. */
	async function githubWithPolicy(vault: HarbourVaultUnderTest): Promise<VaultItem> {
		const item = await putGithubToken(vault);
		await vault.putPolicy(human, {
			itemId: item.id,
			selector: { organisationId: ORG, projectId: PROJECT },
			route: { host: HOST, methods: ["GET"], pathPrefix: "/user" },
		});
		return item;
	}

	const sessionCredentialCases: ConformanceCase[] = [
		test("placeholders: issued only to system, random, per item, and never written to the audit trail", async (vault, deps) => {
			const item = await putGithubToken(vault);
			const request = { organisationId: ORG, projectId: PROJECT, sessionId: "session-1" };
			await assertWorkerCallRefused(
				assert,
				deps,
				"vault.issueSessionPlaceholders",
				(caller) => vault.issueSessionPlaceholders(caller, request),
				ORG,
				{ agentId: "agent-1", sessionId: "session-1" },
			);
			const issued = await vault.issueSessionPlaceholders(WORKER, request);
			assert.strictEqual(issued.generation, 1, "the first start is generation 1");
			assert.partialDeepEqual(issued.placeholders, [
				{ itemId: item.id, name: "github-token", hosts: [HOST], header: "Authorization" },
			]);
			const placeholder = issued.placeholders[0]!.placeholder;
			assert.ok(/^harbour-ph-[0-9a-f]{32}$/.test(placeholder), "a placeholder is harbour-ph- and 32 hex digits");
			assert.strictEqual(containsCanary(issued), false, "no value is issued");
			const other = await vault.issueSessionPlaceholders(WORKER, { ...request, sessionId: "session-2" });
			assert.ok(other.placeholders[0]!.placeholder !== placeholder, "another session gets its own");
			const theirs = await vault.issueSessionPlaceholders(WORKER, { ...request, projectId: OTHER_PROJECT });
			assert.deepEqual(theirs.placeholders, [], "another project's session gets none for this project's item");
			assert.partialDeepEqual(deps.audit.ofType("vault.session.placeholders_issued")[0], {
				sessionId: "session-1",
				data: { generation: 1, itemIds: [item.id] },
			});
			assert.strictEqual(containsCanary(deps.audit.events, placeholder), false, "no audit event holds one");
		}),

		test("placeholders: one in the auth header injects its own item's key on its own host", async (vault) => {
			const item = await githubWithPolicy(vault);
			const { placeholder } = await placeholderFor(vault, item.id);
			const allowed = await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/user`, { placeholder }));
			assert.partialDeepEqual(allowed, {
				allow: true,
				inject: { header: "Authorization", value: `Bearer ${CANARY_SECRET}` },
			});
			const unknown = await vault.decideEgress(
				WORKER,
				egress("GET", `https://${HOST}/user`, { placeholder: `harbour-ph-${"0".repeat(32)}` }),
			);
			assert.strictEqual(unknown.allow, false, "a placeholder never issued gets nothing");
			assert.strictEqual(unknown.inject, undefined);
		}),

		test("placeholders: one sent to a host its item is not bound to is refused, even where another key would go", async (vault) => {
			const item = await githubWithPolicy(vault);
			const other = await vault.putItem(human, {
				owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
				name: "other-token",
				hosts: ["api.other.example"],
				injection: { header: "Authorization", template: "Bearer {key}" },
				value: "other-secret-value-0123",
			});
			await vault.putPolicy(human, {
				itemId: other.id,
				selector: { organisationId: ORG, projectId: PROJECT },
				route: { host: "api.other.example", methods: ["GET"], pathPrefix: "/" },
			});
			const { placeholder } = await placeholderFor(vault, item.id);
			const wrongHost = await vault.decideEgress(
				WORKER,
				egress("GET", "https://api.other.example/collect", { placeholder }),
			);
			assert.partialDeepEqual(wrongHost, { allow: false });
			assert.strictEqual(wrongHost.inject, undefined, "neither key is injected");
			assert.strictEqual(containsCanary(wrongHost), false);
			const plain = await vault.decideEgress(WORKER, egress("GET", "https://api.other.example/collect"));
			assert.strictEqual(plain.allow, true, "without the placeholder the other host's own policy still applies");
		}),

		test("placeholders: a restart's new placeholders replace the old; another session's never work", async (vault) => {
			const item = await githubWithPolicy(vault);
			const url = `https://${HOST}/user`;
			const first = await placeholderFor(vault, item.id);
			const theirs = await placeholderFor(vault, item.id, "session-2");
			const second = await placeholderFor(vault, item.id);
			assert.strictEqual(second.issued.generation, 2, "the restart is generation 2");
			const stale = await vault.decideEgress(WORKER, egress("GET", url, { placeholder: first.placeholder }));
			assert.strictEqual(stale.allow, false, "the placeholder from before the restart is refused");
			assert.strictEqual(stale.inject, undefined);
			const current = await vault.decideEgress(WORKER, egress("GET", url, { placeholder: second.placeholder }));
			assert.strictEqual(current.allow, true, "the new one works");
			const copied = await vault.decideEgress(WORKER, egress("GET", url, { placeholder: theirs.placeholder }));
			assert.strictEqual(copied.allow, false, "session-2's placeholder in session-1's request is refused");
		}),

		test("placeholders: a placeholder grants nothing a policy or grant does not", async (vault) => {
			const item = await putGithubToken(vault);
			const { placeholder } = await placeholderFor(vault, item.id);
			const denied = await vault.decideEgress(WORKER, egress("GET", `https://${HOST}/user`, { placeholder }));
			assert.strictEqual(denied.allow, false, "no policy, no grant: no key");
			assert.strictEqual(denied.inject, undefined);
		}),

		test("placeholders: an ended session's stop working and it gets no more; an aborted run keeps them", async (vault) => {
			const item = await githubWithPolicy(vault);
			const url = `https://${HOST}/user`;
			const { placeholder } = await placeholderFor(vault, item.id);
			await vault.endSession(sessionEnd, "session-1", "aborted");
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url, { placeholder }))).allow, true);
			await vault.endSession(sessionEnd, "session-1", "session_ended");
			const after = await vault.decideEgress(WORKER, egress("GET", url, { placeholder }));
			assert.strictEqual(after.allow, false, "refused once the session has ended");
			assert.strictEqual(
				(await vault.decideEgress(WORKER, egress("GET", url))).allow,
				false,
				"and so is the policy, with no placeholder",
			);
			await assert.rejectsWithCode(
				vault.issueSessionPlaceholders(WORKER, { organisationId: ORG, projectId: PROJECT, sessionId: "session-1" }),
				"refused",
				"an ended session is issued no placeholders",
			);
			assert.partialDeepEqual(await vault.getSessionAccess(human, "session-1"), { blocked: false, generation: 1 });
			assert.ok((await vault.getSessionAccess(human, "session-1")).endedAt !== undefined, "the end is recorded");
			await assert.rejectsWithCode(vault.assertSessionOpen(WORKER, MODEL_SCOPE), "refused");
			assert.strictEqual(
				(await vault.decideEgress(WORKER, egress("GET", url, { agentId: "agent-2", sessionId: "session-2" }))).allow,
				true,
				"another session is untouched",
			);
		}),

		test("session access: blocking refuses egress, key reads and model calls at once, until unblocked", async (vault, deps) => {
			const item = await githubWithPolicy(vault);
			const model = await putModelKey(vault, human, "organisation");
			const url = `https://${HOST}/user`;
			assert.deepEqual(await vault.getSessionAccess(human, "session-1"), {
				sessionId: "session-1",
				blocked: false,
				generation: 0,
			});
			await vault.assertSessionOpen(WORKER, MODEL_SCOPE);
			await assert.rejectsWithCode(
				vault.setSessionAccess(agent, "session-1", { blocked: true }),
				"forbidden",
				"an agent cannot block or unblock",
			);
			await assert.rejectsWithCode(
				vault.setSessionAccess(human, "session-1", { blocked: "yes" as unknown as boolean }),
				"invalid",
			);

			const blocked = await vault.setSessionAccess(human, "session-1", { blocked: true, reason: "Runaway spend" });
			assert.partialDeepEqual(blocked, { sessionId: "session-1", blocked: true, reason: "Runaway spend" });
			const denied = await vault.decideEgress(WORKER, egress("GET", url));
			assert.strictEqual(denied.allow, false, "egress under a policy is refused");
			assert.strictEqual(denied.inject, undefined);
			await assert.rejectsWithCode(vault.readConnectorCredential(WORKER, connectorRequest(model.id)), "refused");
			await assert.rejectsWithCode(vault.assertSessionOpen(WORKER, MODEL_SCOPE), "refused");
			const theirs = egress("GET", url, { agentId: "agent-2", sessionId: "session-2" });
			assert.strictEqual((await vault.decideEgress(WORKER, theirs)).allow, true, "another session is untouched");
			await vault.setSessionAccess(human, "session-1", { blocked: true });
			assert.strictEqual(deps.audit.ofType("vault.session.blocked").length, 1, "blocking twice is audited once");

			const open = await vault.setSessionAccess(human, "session-1", { blocked: false });
			assert.deepEqual(open, { sessionId: "session-1", blocked: false, generation: 0 });
			assert.strictEqual((await vault.decideEgress(WORKER, egress("GET", url))).allow, true, "allowed again");
			await vault.assertSessionOpen(WORKER, MODEL_SCOPE);
			assert.strictEqual(deps.audit.ofType("vault.session.unblocked").length, 1);
			assert.partialDeepEqual(deps.audit.ofType("vault.session.blocked")[0], {
				sessionId: "session-1",
				actor: human.actor,
				data: { reason: "Runaway spend" },
			});
			await assertWorkerCallRefused(
				assert,
				deps,
				"vault.assertSessionOpen",
				(caller) => vault.assertSessionOpen(caller, MODEL_SCOPE),
				ORG,
				{ agentId: "agent-1", sessionId: "session-1" },
			);
			assert.ok(item.id !== model.id);
		}),

		test("session usage: counts each of the session's egress decisions by host, and no other session's", async (vault) => {
			await githubWithPolicy(vault);
			const url = `https://${HOST}/user`;
			assert.deepEqual(await vault.getSessionUsage(human, "session-1"), {
				sessionId: "session-1",
				requests: 0,
				injected: 0,
				denied: 0,
				hosts: [],
			});
			await vault.decideEgress(WORKER, egress("GET", url));
			await vault.decideEgress(WORKER, egress("GET", url));
			await vault.decideEgress(WORKER, egress("POST", url));
			await vault.decideEgress(WORKER, egress("GET", url, { agentId: "agent-2", sessionId: "session-2" }));
			const usage = await vault.getSessionUsage(human, "session-1");
			assert.partialDeepEqual(usage, {
				sessionId: "session-1",
				requests: 3,
				injected: 2,
				denied: 1,
				hosts: [{ host: HOST, injected: 2, denied: 1 }],
			});
			assert.ok(usage.firstAt !== undefined && usage.lastAt !== undefined, "the first and last request are given");
			assert.partialDeepEqual(await vault.getSessionUsage(human, "session-2"), { requests: 1, injected: 1 });
		}),
	];

	/**
	 * User-owned items (docs/design/org-scope.md, decision 6). `user-a` owns the item; `agent-u1` (a project session) and
	 * `agent-u2` (an organisation session) work for `user-a`, `agent-u3` for `user-b`. `human` is an organisation admin.
	 */
	const userA = contextFor(actors.human("user-a"), ORG, PROJECT);
	const userB = contextFor(actors.human("user-b"), ORG, PROJECT);
	const hostApp = contextFor(actors.service("host-app"), ORG);
	const userAgent = contextFor(actors.agent("agent-u1", "session-u1"), ORG, PROJECT);
	const userOrgAgent = contextFor(actors.agent("agent-u2", "session-u2"), ORG);
	const otherUserAgent = contextFor(actors.agent("agent-u3", "session-u3"), ORG, PROJECT);
	const MAIL_HOST = "gmail.googleapis.com";

	function seedUsers(deps: ConformanceDeps): void {
		deps.tenancy.bind(userA.actor, ORG, "operator", PROJECT);
		deps.tenancy.bind(userB.actor, ORG, "operator", PROJECT);
		deps.tenancy.bind(hostApp.actor, ORG, "admin");
		const session = { organisationId: ORG, projectId: PROJECT };
		deps.tenancy.session({ ...session, id: "session-u1", agentId: "agent-u1", userId: "user-a" });
		deps.tenancy.session({ id: "session-u2", organisationId: ORG, agentId: "agent-u2", userId: "user-a" });
		deps.tenancy.session({ ...session, id: "session-u3", agentId: "agent-u3", userId: "user-b" });
	}

	function putMailToken(vault: Vault, ctx: CallContext = userA, withValue = true): Promise<VaultItem> {
		return vault.putItem(ctx, {
			owner: { kind: "user", organisationId: ORG, userId: "user-a" },
			name: "gmail-token",
			hosts: [MAIL_HOST],
			injection: { header: "Authorization", template: "Bearer {key}" },
			...(withValue ? { value: CANARY_SECRET } : {}),
		});
	}

	const mailTerms = (itemId: string): ProposalTerms => ({
		itemId,
		route: { host: MAIL_HOST, methods: ["GET"], pathPrefix: "/gmail/" },
		lifetime: { maxUses: 5 },
		reason: "Read my inbox",
	});

	const mailEgress = (agentId: string, sessionId: string, projectId?: string): EgressRequest => ({
		organisationId: ORG,
		...(projectId === undefined ? {} : { projectId }),
		agentId,
		sessionId,
		method: "GET",
		url: `https://${MAIL_HOST}/gmail/v1/users/me/messages`,
	});

	const userTest = (
		name: string,
		body: (vault: HarbourVaultUnderTest, deps: ConformanceDeps) => Promise<void>,
	): ConformanceCase =>
		test(name, async (vault, deps) => {
			seedUsers(deps);
			await body(vault, deps);
		});

	const userItemCases: ConformanceCase[] = [
		userTest(
			"user items: only the user, or a service acting for its users, makes one, and no one else sees it",
			async (vault, deps) => {
				const item = await putMailToken(vault);
				assert.partialDeepEqual(item, { owner: { kind: "user", userId: "user-a" }, hasValue: true });
				const made = await putMailToken(vault, hostApp, false);
				assert.partialDeepEqual(made, { owner: { kind: "user", userId: "user-a" }, hasValue: false });
				for (const [ctx, label] of [
					[human, "an organisation admin"],
					[userB, "another person"],
				] as const) {
					await assertAccessDenied(assert, deps, putMailToken(vault, ctx), {
						operation: "vault.putItem",
						message: `${label} making one`,
					});
					await assertAccessDenied(assert, deps, vault.getItem(ctx, item.id), {
						operation: "vault.getItem",
						message: `${label} reading one`,
					});
					const listed = (await vault.listItems(ctx)).items.map((found) => found.id);
					assert.ok(!listed.includes(item.id), `${label} doesn't see it listed`);
				}
				await assert.rejectsWithCode(putMailToken(vault, userAgent), "forbidden", "an agent never makes one");
				const blank = vault.putItem(userA, {
					owner: { kind: "user", organisationId: ORG, userId: " " },
					name: "nobody's",
					hosts: [MAIL_HOST],
					injection: { header: "Authorization", template: "Bearer {key}" },
				});
				await assert.rejectsWithCode(blank, "invalid", "a user's item names its user");
				assert.strictEqual((await vault.getItem(userA, item.id)).id, item.id, "its user reads it");
				const own = (await vault.listItems(userA)).items.map((found) => found.id);
				assert.deepEqual(own.sort(), [item.id, made.id].sort(), "its user lists both");
				assert.strictEqual((await vault.listItems(hostApp)).items.length, 2, "the host app lists them");
				assert.strictEqual(containsCanary(await vault.listItems(userA)), false, "no read carries the value");
			},
		),

		userTest(
			"user items: an agent sees one and proposes for it only through a session that works for its user, in a project or the organisation",
			async (vault, deps) => {
				const item = await putMailToken(vault);
				for (const ctx of [userAgent, userOrgAgent]) {
					const listed = (await vault.listItems(ctx)).items.map((found) => found.id);
					assert.ok(listed.includes(item.id), `${ctx.actor.kind} working for its user sees it`);
				}
				for (const ctx of [otherUserAgent, agent]) {
					const listed = (await vault.listItems(ctx)).items.map((found) => found.id);
					assert.ok(!listed.includes(item.id), "an agent working for someone else, or no one, doesn't");
				}
				const inProject = await vault.propose(userAgent, mailTerms(item.id));
				assert.partialDeepEqual(inProject, { projectId: PROJECT, requester: { sessionId: "session-u1" } });
				const inOrganisation = await vault.propose(userOrgAgent, mailTerms(item.id));
				assert.strictEqual(inOrganisation.projectId, undefined, "an organisation session's proposal has no project");
				for (const ctx of [otherUserAgent, agent]) {
					await assertAccessDenied(assert, deps, vault.propose(ctx, mailTerms(item.id)), {
						operation: "vault.propose",
						message: "an agent working for someone else proposing for it",
					});
				}
				await assertAccessDenied(assert, deps, vault.propose(userB, mailTerms(item.id)), {
					operation: "vault.propose",
					message: "another person proposing for it",
				});
			},
		),

		userTest(
			"user items: only its user decides a proposal for it, never a project operator or an organisation admin",
			async (vault, deps) => {
				const item = await putMailToken(vault);
				const proposal = await vault.propose(userOrgAgent, mailTerms(item.id));
				for (const [ctx, label] of [
					[projectOperator, "a project operator"],
					[human, "an organisation admin"],
					[userB, "another person"],
				] as const) {
					await assertAccessDenied(assert, deps, vault.approvalView(ctx, proposal.id), {
						operation: "vault.approvalView",
						message: `${label} opening the approval view`,
					});
					await assertAccessDenied(assert, deps, vault.decide(ctx, approval(proposal)), {
						operation: "vault.decide",
						message: `${label} deciding`,
					});
				}
				assert.strictEqual(
					(await vault.getProposal(userA, proposal.id)).id,
					proposal.id,
					"its user reads the proposal",
				);
				const view = await vault.approvalView(userA, proposal.id);
				assert.ok(view.codeChoices.includes(proposal.bindingCode), "its user sees the binding code among the choices");
				const decision = await vault.decide(userA, approval(proposal));
				assert.strictEqual(decision.outcome, "approved");
				const allowed = await vault.decideEgress(WORKER, mailEgress("agent-u2", "session-u2"));
				assert.partialDeepEqual(allowed, { allow: true, grantId: decision.grantId });
				assert.strictEqual(allowed.inject?.value, `Bearer ${CANARY_SECRET}`, "the grant injects it");
			},
		),

		userTest(
			"user items: egress injects one only for a session that works for its user, within the ceiling",
			async (vault, deps) => {
				const item = await putMailToken(vault);
				const route = { host: MAIL_HOST, methods: ["GET"] as HttpMethod[], pathPrefix: "/gmail/" };
				await assertAccessDenied(
					assert,
					deps,
					vault.putPolicy(human, { itemId: item.id, selector: { organisationId: ORG }, route }),
					{ operation: "vault.putPolicy", message: "an organisation admin setting a policy on it" },
				);
				const policy = await vault.putPolicy(userA, { itemId: item.id, selector: { organisationId: ORG }, route });
				for (const [request, label] of [
					[mailEgress("agent-u1", "session-u1", PROJECT), "its user's project session"],
					[mailEgress("agent-u2", "session-u2"), "its user's organisation session"],
				] as const) {
					const decision = await vault.decideEgress(WORKER, request);
					assert.partialDeepEqual(decision, { allow: true, policyId: policy.id }, `${label} is allowed`);
				}
				const { sessionId: _session, agentId: _agent, ...anonymous } = mailEgress("agent-u1", "session-u1", PROJECT);
				for (const [request, label] of [
					[mailEgress("agent-u3", "session-u3", PROJECT), "another user's session"],
					[mailEgress("agent-1", "session-1", PROJECT), "a session working for no one"],
					[mailEgress("agent-2", "session-u1", PROJECT), "another agent claiming the session"],
					[anonymous, "a request naming no session"],
				] as const) {
					const decision = await vault.decideEgress(WORKER, request);
					assert.strictEqual(decision.allow, false, `${label} is denied`);
					assert.strictEqual(decision.inject, undefined, `${label} gets no credential`);
					assert.ok(!JSON.stringify(decision.fix).includes(item.name), `${label}'s fix doesn't name the item`);
				}
				deps.tenancy.close("session-u1");
				const closed = await vault.decideEgress(WORKER, mailEgress("agent-u1", "session-u1", PROJECT));
				assert.strictEqual(closed.allow, false, "a closed session is denied");
				await vault.setCeiling(human, [{ host: HOST, methods: ["GET"], pathPrefix: "/" }]);
				const outside = await vault.decideEgress(WORKER, mailEgress("agent-u2", "session-u2"));
				assert.partialDeepEqual(outside, { allow: false, fix: { action: "none" } }, "the ceiling still bounds it");
				assert.strictEqual(containsCanary(deps.audit.events), false, "no audit event carries the value");
			},
		),

		userTest("user items: the policies on one are its user's to see and revoke", async (vault, deps) => {
			const item = await putMailToken(vault);
			const route = { host: MAIL_HOST, methods: ["GET"] as HttpMethod[], pathPrefix: "/" };
			const policy = await vault.putPolicy(userA, { itemId: item.id, selector: { organisationId: ORG }, route });
			const ids = async (ctx: CallContext) => (await vault.listPolicies(ctx)).items.map((found) => found.id);
			assert.deepEqual(await ids(userA), [policy.id], "its user lists it");
			assert.deepEqual(await ids(human), [], "an organisation admin doesn't");
			assert.deepEqual(await ids(userB), [], "another person doesn't");
			for (const ctx of [human, userB]) {
				await assertAccessDenied(assert, deps, vault.revokePolicy(ctx, policy.id), {
					operation: "vault.revokePolicy",
					message: "someone else revoking it",
				});
			}
			await vault.revokePolicy(userA, policy.id);
			assert.ok((await vault.listPolicies(userA)).items[0]?.revokedAt !== undefined, "its user revoked it");
		}),

		userTest("user items: a model connector never reads one", async (vault, deps) => {
			const item = await vault.putItem(userA, {
				owner: { kind: "user", organisationId: ORG, userId: "user-a" },
				name: "my-model-key",
				hosts: [MODEL_HOST],
				injection: { header: "Authorization", template: "Bearer {key}" },
				value: CANARY_SECRET,
			});
			await assertConnectorRefused(vault, deps, connectorRequest(item.id), "refused", "a user's item");
		}),
	];

	return [
		...cases,
		...sessionEndCases,
		...sessionCredentialCases,
		...platformAndConnectorCases,
		...(options.projectAccess === true ? [...projectAccessCases, ...userItemCases] : []),
	];
}

/** How many events the vault itself (not `ProjectAccess`) has audited. */
function vaultAudits(deps: ConformanceDeps): number {
	return deps.audit.events.filter((event) => event.source === "vault").length;
}

export function registerVaultConformance(
	runner: ConformanceRunner,
	name: string,
	provider: VaultConformanceProvider,
	options?: ConformanceOptions,
): void {
	registerCases(
		runner,
		name,
		createVaultConformance({
			assertions: createExpectAssertions(runner.expect),
			provider,
			...(options?.projectAccess === undefined ? {} : { projectAccess: options.projectAccess }),
		}),
	);
}

/**
 * A durable target under the proofs of issue #13: one durable store per case, with as many vault instances over it as
 * a case opens, each built as another process would build it (same store, same cipher key, the case's clock, audit sink
 * and access).
 */
export interface VaultDurableSubject {
	/** A new vault instance over the case's store. */
	open(): HarbourVaultUnderTest;
	/** Every row of every vault table, read raw from the database: what an operator with database access sees. */
	rawRows(): Promise<readonly { readonly table: string; readonly row: unknown }[]>;
	/**
	 * Serves the egress decision API (`@harbour/vault/egress-api`) for `vault` over HTTP, and returns a client of it
	 * authenticated as the egress gateway.
	 */
	serveEgressApi(vault: HarbourVaultUnderTest): Promise<{
		readonly client: { decideEgress(request: EgressRequest): Promise<EgressDecision> };
		close(): Promise<void>;
	}>;
}

/** The proofs, named by the prefix of their case names. */
export type VaultDurableProof = "canary" | "revocation" | "wrong code" | "lifecycle" | "durable waits" | "races";

export type VaultDurableProvider = (
	deps: ConformanceDeps,
	use: (subject: VaultDurableSubject) => Promise<void>,
) => Promise<void>;

type ConsoleMethod = "log" | "error" | "warn" | "info" | "debug";

/** Runs `body` with every console method recorded (and still printed); resolves what was written. */
async function recordingConsole(body: () => Promise<void>): Promise<readonly string[]> {
	const methods: readonly ConsoleMethod[] = ["log", "error", "warn", "info", "debug"];
	const originals = methods.map((method) => [method, console[method]] as const);
	const written: string[] = [];
	for (const [method, original] of originals) {
		console[method] = (...args: unknown[]) => {
			written.push(
				args
					.map((arg) =>
						arg instanceof Error
							? `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`
							: (JSON.stringify(arg) ?? String(arg)),
					)
					.join(" "),
			);
			original.apply(console, args);
		};
	}
	try {
		await body();
	} finally {
		for (const [method, original] of originals) console[method] = original;
	}
	return written;
}

/** Times `check` until it holds, every 10 ms of real time, for at most `limitMs`; resolves the milliseconds taken. */
async function timeUntil(check: () => Promise<boolean>, limitMs: number): Promise<number> {
	const started = Date.now();
	while (!(await check())) {
		if (Date.now() - started > limitMs) return Date.now() - started;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return Date.now() - started;
}

/**
 * The proofs from issue #13's definition of done, for a durable target: the canary never leaves the vault except in
 * an allowed decision's `inject.value`; a revocation through one instance holds for another within 5 s; a wrong
 * binding code changes nothing; and the whole lifecycle, each step followed by a decision over the egress API. Also the
 * race rules and durable waits across two instances.
 */
export function createVaultDurableProofs(options: {
	assertions: ConformanceAssertions;
	provider: VaultDurableProvider;
	/** Only these proofs; default all. */
	only?: readonly VaultDurableProof[];
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const proof = (
		name: string,
		body: (subject: VaultDurableSubject, deps: ConformanceDeps) => Promise<void>,
	): ConformanceCase => ({
		name,
		timeoutMs: 20_000,
		run: async () => {
			const deps = createDeps();
			seedTenancy(deps);
			await options.provider(deps, (subject) => body(subject, deps));
		},
	});
	const url = (path: string) => `https://${HOST}${path}`;

	const proofs: ConformanceCase[] = [
		proof(
			"canary: the value appears only in an allowed decision's inject.value, never in a row, record, audit event, error or log",
			async (subject, deps) => {
				const seen: unknown[] = [];
				const errors: unknown[] = [];
				const injected: EgressDecision[] = [];
				const capture = async (operation: Promise<unknown>) => {
					try {
						seen.push(await operation);
					} catch (error) {
						errors.push(
							isHarbourError(error)
								? { code: error.code, message: error.message, details: error.details ?? null }
								: String(error),
						);
					}
				};
				const vault = subject.open();
				const api = await subject.serveEgressApi(vault);
				let placeholder = "";
				const written = await recordingConsole(async () => {
					try {
						const item = await putGithubToken(vault);
						placeholder = item.placeholder;
						await vault.setCeiling(human, [
							{ host: HOST, methods: ["GET", "POST"], pathPrefix: "/" },
							{ host: "api.linear.app", methods: ["POST"], pathPrefix: "/" },
						]);
						// A write, approved with the right code after a wrong one, then used over the API.
						const write = await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }, "/repos/harbour"));
						seen.push(await vault.approvalView(human, write.id));
						await capture(vault.decide(human, approval(write, { pickedCode: await wrongCode(vault, write) })));
						await capture(vault.decide(human, approval(write)));
						await capture(vault.waitForOutcome(agent, write.id));
						const allowed = await api.client.decideEgress(egress("POST", url("/repos/harbour/issues")));
						assert.strictEqual(allowed.allow, true, "the approved write goes out");
						injected.push(allowed);
						seen.push(await api.client.decideEgress(egress("POST", url("/repos/harbour/issues"))));
						// Denied.
						const denied = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 1 }, "/repos/denied"));
						await capture(vault.decide(human, { proposalId: denied.id, outcome: "deny", note: "No" }));
						await capture(vault.waitForOutcome(agent, denied.id));
						seen.push(await api.client.decideEgress(egress("GET", url("/repos/denied"))));
						// Expired.
						const expiring = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 1 }, "/repos/expired"));
						deps.clock.set(expiring.expiresAt + 1);
						await capture(vault.decide(human, approval(expiring)));
						await capture(vault.waitForOutcome(agent, expiring.id));
						seen.push(await api.client.decideEgress(egress("GET", url("/repos/expired"))));
						// Revoked.
						const route = await vault.propose(agent, termsFor(item.id, ["GET"], {}, "/repos/revoked"));
						const decision = await vault.decide(human, approval(route));
						seen.push(decision);
						const before = await api.client.decideEgress(egress("GET", url("/repos/revoked")));
						assert.strictEqual(before.allow, true, "the route grant is used before it is revoked");
						injected.push(before);
						await capture(vault.revokeGrant(human, decision.grantId!, "Done"));
						seen.push(await api.client.decideEgress(egress("GET", url("/repos/revoked"))));
						// A secret pasted through a second instance, and a refusal that names the item.
						const secret = await vault.propose(agent, secretTerms);
						await capture(subject.open().decide(human, approval(secret, { secretValue: CANARY_SECRET })));
						await capture(vault.propose(agent, { ...secretTerms, itemId: item.id }));
						await capture(api.client.decideEgress({ ...egress("GET", url("/")), method: "BREW" as HttpMethod }));
					} finally {
						await api.close();
					}
				});
				const records = [
					await vault.listItems(human),
					await vault.listPolicies(human),
					await vault.listProposals(human),
					await vault.listGrants(human),
					await vault.listUses(human),
					await subject.open().listProposals(human),
				];
				const rows = await subject.rawRows();

				assert.greaterThan(rows.length, 0);
				assert.strictEqual(injected.length, 2);
				for (const decision of injected) {
					assert.strictEqual(decision.inject?.value, `Bearer ${CANARY_SECRET}`, "the allowed decision injects it");
					assert.strictEqual(containsCanary({ ...decision, inject: undefined }), false, "and nothing else in it does");
				}
				assert.ok(
					rows.some((entry) => entry.table === "items"),
					"the store holds the items",
				);
				assert.strictEqual(containsCanary(rows), false, "no stored row holds the value: values are sealed");
				assert.strictEqual(containsCanary(deps.audit.events), false, "no audit event holds it");
				assert.strictEqual(containsCanary(records), false, "no use, proposal, policy, grant or item record holds it");
				assert.strictEqual(containsCanary(seen), false, "no decision, outcome or view holds it");
				assert.strictEqual(errors.length, 4, "every refusal was captured");
				assert.strictEqual(containsCanary(errors), false, "no error message holds it");
				assert.strictEqual(containsCanary(written), false, "nothing written to the console holds it");
				assert.ok(/^harbour:\/\/github-token\/[0-9a-f]{6}$/.test(placeholder), "the placeholder is random");
				assert.strictEqual(containsCanary(placeholder), false, "the placeholder a sandbox holds is not the value");
			},
		),

		proof("revocation: a grant revoked through one instance is refused by another within 5 s", async (subject) => {
			const admin = subject.open();
			const egressSide = subject.open();
			const api = await subject.serveEgressApi(egressSide);
			try {
				const item = await putGithubToken(admin);
				const grantId = await approvedGrant(admin, agent, termsFor(item.id, ["GET"], {}));
				const request = egress("GET", url("/repos/harbour"));
				assert.strictEqual((await api.client.decideEgress(request)).allow, true, "allowed under the active grant");
				await admin.revokeGrant(human, grantId, "Revoked by the admin side");
				let decisions = 0;
				const elapsed = await timeUntil(async () => {
					decisions += 1;
					return !(await api.client.decideEgress(request)).allow;
				}, 5_000);
				assert.ok(elapsed < 5_000, `the egress side refused within 5 s (took ${elapsed} ms)`);
				assert.strictEqual(decisions, 1, "the very next decision is refused: decisions read the store");
				assert.strictEqual((await egressSide.getGrant(human, grantId)).status, "revoked");
			} finally {
				await api.close();
			}
		}),

		proof(
			"wrong code: approving a write, a route or a secret paste with a wrong code is refused, audited and changes nothing",
			async (subject, deps) => {
				const vault = subject.open();
				const item = await putGithubToken(vault, false);
				const proposals = [
					await vault.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 })),
					await vault.propose(agent, termsFor(item.id, ["GET"], { ttlMs: 60_000 })),
					await vault.propose(agent, secretTerms),
				];
				assert.deepEqual(
					proposals.map((proposal) => proposal.kind),
					["write", "route", "secret"],
				);
				const rowsBefore = await subject.rawRows();
				for (const proposal of proposals) {
					const before = deps.audit.ofType("vault.binding_code.mismatch").length;
					const input = approval(proposal, {
						pickedCode: await wrongCode(vault, proposal),
						...(proposal.kind === "secret" ? { secretValue: CANARY_SECRET } : {}),
					});
					await assert.rejectsWithCode(vault.decide(human, input), "refused", `a wrong code on a ${proposal.kind}`);
					const mismatches = deps.audit.ofType("vault.binding_code.mismatch");
					assert.strictEqual(mismatches.length, before + 1, `the ${proposal.kind} mismatch is audited`);
					assert.strictEqual(mismatches.at(-1)?.subject?.id, proposal.id);
				}
				// Read back through an instance that never saw the attempts: the store is as it was.
				const fresh = subject.open();
				for (const proposal of proposals) {
					assert.strictEqual((await fresh.getProposal(human, proposal.id)).status, "pending", "still pending");
				}
				assert.strictEqual((await fresh.listGrants(human)).items.length, 0, "no grant");
				assert.strictEqual((await fresh.getItem(human, item.id)).hasValue, false, "no value on the item");
				assert.strictEqual((await fresh.listItems(human)).items.length, 1, "no item for the secret");
				assert.deepEqual(await subject.rawRows(), rowsBefore, "no stored row changed");
				assert.strictEqual(containsCanary(await subject.rawRows()), false);
			},
		),

		proof(
			"lifecycle: approve, narrow, deny, expire and revoke, each followed by a decision over the egress API",
			async (subject, deps) => {
				const vault = subject.open();
				const api = await subject.serveEgressApi(subject.open());
				const decide = (method: HttpMethod, path: string) => api.client.decideEgress(egress(method, url(path)));
				try {
					const item = await putGithubToken(vault);

					const approved = await vault.propose(agent, termsFor(item.id, ["GET"], {}, "/repos/approved"));
					assert.strictEqual((await decide("GET", "/repos/approved/x")).allow, false, "nothing before the approval");
					await vault.decide(human, approval(approved));
					assert.strictEqual((await vault.waitForOutcome(agent, approved.id)).status, "approved");
					assert.strictEqual((await decide("GET", "/repos/approved/x")).allow, true, "approved: allowed");

					const narrowed = await vault.propose(agent, termsFor(item.id, ["GET", "POST"], {}, "/repos/narrowed"));
					await vault.decide(
						human,
						approval(narrowed, { narrowing: { methods: ["GET"], pathPrefix: "/repos/narrowed/only" } }),
					);
					const outcome = await vault.waitForOutcome(agent, narrowed.id);
					assert.deepEqual(outcome.effectiveTerms?.route, {
						host: HOST,
						methods: ["GET"],
						pathPrefix: "/repos/narrowed/only",
					});
					assert.strictEqual((await decide("GET", "/repos/narrowed/only/x")).allow, true, "narrowed: inside allowed");
					assert.strictEqual((await decide("POST", "/repos/narrowed/only/x")).allow, false, "a narrowed-out method");
					assert.strictEqual((await decide("GET", "/repos/narrowed/other")).allow, false, "a narrowed-out path");

					const denied = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 1 }, "/repos/denied"));
					await vault.decide(human, { proposalId: denied.id, outcome: "deny" });
					assert.strictEqual((await vault.waitForOutcome(agent, denied.id)).status, "denied");
					const deniedDecision = await decide("GET", "/repos/denied");
					assert.strictEqual(deniedDecision.allow, false, "denied: refused");
					assert.strictEqual(deniedDecision.fix?.action, "propose", "with a fix");

					const expiring = await vault.propose(agent, termsFor(item.id, ["GET"], { maxUses: 1 }, "/repos/expired"));
					deps.clock.set(expiring.expiresAt + 1);
					assert.strictEqual((await vault.waitForOutcome(agent, expiring.id)).status, "expired");
					await assert.rejectsWithCode(vault.decide(human, approval(expiring)), "expired");
					assert.strictEqual((await decide("GET", "/repos/expired")).allow, false, "expired: refused");

					const revoked = await vault.propose(agent, termsFor(item.id, ["GET"], {}, "/repos/revoked"));
					const grantId = (await vault.decide(human, approval(revoked))).grantId!;
					assert.strictEqual((await decide("GET", "/repos/revoked")).allow, true, "allowed before the revocation");
					await vault.revokeGrant(human, grantId);
					assert.strictEqual((await decide("GET", "/repos/revoked")).allow, false, "revoked: refused");

					const uses = (await vault.listUses(human, { sessionId: "session-1" })).items;
					assert.strictEqual(uses.length, 9, "every decision over the API recorded a use");
					assert.deepEqual(
						uses.map((use) => use.outcome),
						["denied", "injected", "injected", "denied", "denied", "denied", "denied", "injected", "denied"],
					);
				} finally {
					await api.close();
				}
			},
		),

		proof(
			"durable waits: a vault opened after the proposal resolves its wait for a decision made through another",
			async (subject) => {
				const first = subject.open();
				const item = await putGithubToken(first);
				const proposal = await first.propose(agent, termsFor(item.id, ["POST"], { maxUses: 1 }));
				// The agent's process restarts: a new instance waits; another instance (the vault page) decides.
				const restarted = subject.open();
				const waiting = restarted.waitForOutcome(agent, proposal.id);
				await subject.open().decide(human, approval(proposal));
				const outcome = await Promise.race([
					waiting,
					new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
				]);
				assert.strictEqual(outcome?.status, "approved", "the wait resolved from the store");
				assert.strictEqual(outcome?.effectiveTerms?.itemId, item.id);
				assert.ok(outcome?.message.includes("No request has run"), "and says no request has run");
				assert.strictEqual((await subject.open().waitForOutcome(agent, proposal.id)).status, "approved", "again later");
			},
		),

		proof("races: two instances settle a proposal once and never spend a grant past maxUses", async (subject) => {
			const a = subject.open();
			const b = subject.open();
			const item = await putGithubToken(a);
			const proposal = await a.propose(agent, termsFor(item.id, ["GET"], { maxUses: 3 }));
			const results = await Promise.allSettled([
				a.decide(human, approval(proposal)),
				b.decide(human, approval(proposal)),
				b.decide(human, { proposalId: proposal.id, outcome: "deny" }),
				a.withdraw(agent, proposal.id),
			]);
			assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1, "one decision wins");
			for (const result of results) {
				if (result.status === "rejected") {
					assert.strictEqual((result.reason as { code?: string }).code, "conflict", "the others are conflicts");
				}
			}
			const settled = await subject.open().getProposal(human, proposal.id);
			const grants = (await b.listGrants(human)).items.length;
			assert.strictEqual(grants, settled.status === "approved" ? 1 : 0, "a grant only for an approval");

			const spending = await a.propose(otherAgent, termsFor(item.id, ["GET"], { maxUses: 3 }));
			const grantId = (await b.decide(human, approval(spending))).grantId!;
			const request = egress("GET", url("/repos/harbour"), { agentId: "agent-2", sessionId: "session-2" });
			const decisions = await Promise.all(
				Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? a : b).decideEgress(WORKER, request)),
			);
			assert.strictEqual(decisions.filter((decision) => decision.allow).length, 3, "exactly maxUses are allowed");
			assert.partialDeepEqual(await a.getGrant(human, grantId), { uses: 3, status: "exhausted" });
		}),
	];
	const only = options.only;
	return only === undefined ? proofs : proofs.filter((entry) => only.some((id) => entry.name.startsWith(`${id}:`)));
}

export function registerVaultDurableProofs(
	runner: ConformanceRunner,
	name: string,
	provider: VaultDurableProvider,
	only?: readonly VaultDurableProof[],
): void {
	registerCases(
		runner,
		name,
		createVaultDurableProofs({
			assertions: createExpectAssertions(runner.expect),
			provider,
			...(only === undefined ? {} : { only }),
		}),
	);
}
