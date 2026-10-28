/**
 * `wrangler dev` only: vault requests for the console's vault page to show, made in the VaultDO by `POST
 * /__dev/vault-seed` (src/dev.ts). Never imported by the deployed entry point. Portable, so a test runs it in Node.
 *
 * It sets a ceiling, makes three items and has the default agent ask for six things from three sessions: a route
 * grant, a write and a read still open, one approved, one approved narrowed and one denied.
 */
import type { CallContext, DecisionInput, Proposal, ProposalTerms } from "@harbour/contracts";
import type { HarbourVault } from "@harbour/vault/engine";

const HOUR = 60 * 60 * 1000;

export interface DevVaultSeedInput {
	/** The organisation's admin, who decides the settled requests. */
	readonly admin: CallContext;
	/** The agent in each session the requests come from, with the session's project in the context. */
	readonly agents: {
		readonly release: CallContext;
		readonly linear: CallContext;
		readonly billing: CallContext;
	};
}

/** Each request's ID, by the state the console shows it in. */
export interface DevVaultSeed {
	readonly proposals: {
		readonly route: string;
		readonly write: string;
		readonly read: string;
		readonly approved: string;
		readonly narrowed: string;
		readonly denied: string;
	};
}

function approval(proposal: Proposal, extra: Partial<DecisionInput> = {}): DecisionInput {
	return {
		proposalId: proposal.id,
		outcome: "approve",
		termsHash: proposal.termsHash,
		pickedCode: proposal.bindingCode,
		...extra,
	};
}

export async function seedDevVault(vault: HarbourVault, input: DevVaultSeedInput): Promise<DevVaultSeed> {
	const { admin, agents } = input;
	const organisationId = admin.organisationId;
	const projectId = agents.release.projectId;
	if (projectId === undefined) throw new Error("the agents' contexts need their session's project");
	await vault.setCeiling(admin, [
		{ host: "api.github.com", methods: ["GET", "POST", "PATCH"], pathPrefix: "/" },
		{ host: "api.linear.app", methods: ["POST"], pathPrefix: "/graphql" },
		{ host: "api.stripe.com", methods: ["GET"], pathPrefix: "/v1" },
	]);
	const injection = { header: "Authorization", template: "Bearer {key}" };
	const github = await vault.putItem(admin, {
		owner: { kind: "project", organisationId, projectId },
		name: "GitHub token",
		description: "The harbour-bot fine-grained token for the acme organisation",
		hosts: ["api.github.com"],
		injection,
		value: "dev-github-token-not-a-real-one",
	});
	const linear = await vault.putItem(admin, {
		owner: { kind: "organisation", organisationId },
		name: "Linear API key",
		description: "Workspace key for the triage job",
		hosts: ["api.linear.app"],
		injection,
		value: "dev-linear-key-not-a-real-one",
	});
	const stripe = await vault.putItem(admin, {
		owner: { kind: "project", organisationId, projectId },
		name: "Stripe restricted key",
		hosts: ["api.stripe.com"],
		injection,
		value: "dev-stripe-key-not-a-real-one",
	});

	const ask = (ctx: CallContext, terms: ProposalTerms) => vault.propose(ctx, terms);
	const approved = await ask(agents.linear, {
		itemId: linear.id,
		route: { host: "api.linear.app", methods: ["POST"], pathPrefix: "/graphql" },
		lifetime: { ttlMs: 8 * HOUR, maxUses: 50 },
		reason: "Read this week's triage queue and label new issues",
	});
	await vault.decide(admin, approval(approved));
	const narrowed = await ask(agents.release, {
		itemId: github.id,
		route: { host: "api.github.com", methods: ["GET", "POST", "PATCH"], pathPrefix: "/repos" },
		lifetime: { ttlMs: 8 * HOUR },
		reason: "Open and update the release pull requests",
	});
	await vault.decide(
		admin,
		approval(narrowed, { narrowing: { methods: ["GET", "POST"], pathPrefix: "/repos/acme/harbour", maxUses: 20 } }),
	);
	const denied = await ask(agents.billing, {
		itemId: stripe.id,
		route: { host: "api.stripe.com", methods: ["GET"], pathPrefix: "/v1" },
		lifetime: { ttlMs: 24 * HOUR },
		reason: "Pull every customer's invoices for the quarter",
	});
	await vault.decide(admin, { proposalId: denied.id, outcome: "deny", note: "Only the balance, not every customer" });

	const route = await ask(agents.release, {
		itemId: github.id,
		route: { host: "api.github.com", methods: ["GET", "POST"], pathPrefix: "/repos/acme" },
		lifetime: { ttlMs: 4 * HOUR },
		reason: "Tag the release, open the changelog PR and comment on the issues it closes",
	});
	const write = await ask(agents.linear, {
		itemId: linear.id,
		route: { host: "api.linear.app", methods: ["POST"], pathPrefix: "/graphql" },
		lifetime: { ttlMs: HOUR, maxUses: 1 },
		reason: "Create the follow-up issue for the failing triage run",
	});
	const read = await ask(agents.billing, {
		itemId: stripe.id,
		route: { host: "api.stripe.com", methods: ["GET"], pathPrefix: "/v1/balance" },
		lifetime: { ttlMs: HOUR, maxUses: 1 },
		reason: "Check this month's balance before the payout",
	});
	return {
		proposals: {
			route: route.id,
			write: write.id,
			read: read.id,
			approved: approved.id,
			narrowed: narrowed.id,
			denied: denied.id,
		},
	};
}
