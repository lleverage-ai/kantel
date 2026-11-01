// The memory page's fixtures: an in-memory `Memory` (from @kantel/memory) with one space of a team's concepts, built
// over the weeks before FIXTURE_NOW through the store's own propose and decide, so versions, who set each concept,
// supersessions, forgetting and the proposals still pending are what the real store made.

import type { CallContext, Clock, ConceptInput, Memory, MemorySpace, MemoryWrite } from "@kantel/contracts";
import { createMemoryMemory } from "@kantel/memory/memory";
import { directory } from "../audit/fixtures.ts";
import { DAY, HOUR } from "../primitives/format.ts";
import { FIXTURE_NOW } from "../session/fixtures.ts";
import { bindMemory, type MemoryPageSource } from "./memory-model.ts";

export { directory, FIXTURE_NOW };

export const ORGANISATION = "org_harbour";

const TOM: CallContext = { actor: { kind: "human", userId: "usr_tom" }, organisationId: ORGANISATION };
const agent = (agentId: string, sessionId: string): CallContext => ({
	actor: { kind: "agent", agentId, sessionId },
	organisationId: ORGANISATION,
});
const RELEASE = agent("agt_release", "ses_release_notes");
const OPS = agent("agt_ops", "ses_staging_jobs");
const BILLING = agent("agt_billing", "ses_invoice_sweep");

const PLATFORM = { kind: "project", project: "prj_platform" } as const;
const BILLING_PROJECT = { kind: "project", project: "prj_billing" } as const;

const concept = (input: Omit<ConceptInput, "scope"> & { scope?: ConceptInput["scope"] }): ConceptInput => ({
	scope: { kind: "global" },
	...input,
});

/** The recall a story runs first: what a worker on a Kantel vault task would be shown. */
export const SAMPLE_QUERY = "rotate the vault binding codes for the Linear key";

export interface MemoryScenario {
	readonly memory: Memory;
	readonly source: Required<MemoryPageSource>;
	readonly space: MemorySpace;
	/** Concept IDs the profile names: recalled whatever the query. */
	readonly profile: readonly string[];
	/** Pending proposal IDs, oldest first. */
	readonly pending: readonly string[];
}

/** Builds the space. `empty` creates the space and nothing in it. */
export async function createMemoryScenario(options: { readonly empty?: boolean } = {}): Promise<MemoryScenario> {
	let now = FIXTURE_NOW - 30 * DAY;
	const clock: Clock = { now: () => now };
	const memory = createMemoryMemory({ clock });
	const space = await memory.createSpace(TOM, {
		owner: { kind: "organisation", organisationId: ORGANISATION },
		name: "Kantel team",
	});
	const source = bindMemory(memory, TOM);
	const profile = ["personal/plain-sentence-case", "personal/answer-first"];
	if (options.empty === true) return { memory, source, space, profile, pending: [] };

	/** Proposes as `by` and, unless left pending, decides as Tom a little later. */
	const write = async (
		by: CallContext,
		change: MemoryWrite,
		decision: "apply" | "reject" | "pending" = "apply",
		note?: string,
	) => {
		const proposal = await memory.propose(by, space.id, change);
		now += 2 * HOUR;
		if (decision !== "pending") {
			await memory.decide(TOM, proposal.id, { outcome: decision, ...(note === undefined ? {} : { note }) });
		}
		now += 22 * HOUR;
		return proposal;
	};

	// Tom's own: set by the owner, so no agent may change them.
	await write(TOM, {
		op: "remember",
		concept: concept({
			id: "personal/plain-sentence-case",
			title: "Copy is plain sentence case",
			description: "How every Kantel screen and message is written",
			statement:
				"Copy is plain sentence case: no uppercase tracked labels, no middle-dot meta strings, no arrows on buttons.",
			tags: ["copy", "ui"],
			sources: ["https://github.com/tvdavies/harbour/blob/main/packages/ui/README.md"],
		}),
	});
	await write(TOM, {
		op: "remember",
		concept: concept({
			id: "personal/answer-first",
			title: "Answer first, then the detail",
			statement: "Reports and replies lead with the answer and the recommendation; the evidence follows.",
			tags: ["writing"],
			sources: ["TASK-12"],
		}),
	});

	// Learned from agents' sessions, approved by Tom.
	await write(RELEASE, {
		op: "remember",
		concept: concept({
			id: "projects/harbour/release-notes-folder",
			title: "Release notes go in notes/releases",
			statement: "Draft release notes in notes/releases/<version>.md, grouped by area, each pull request linked.",
			tags: ["release"],
			scope: PLATFORM,
			sources: ["https://github.com/tvdavies/harbour/pull/131"],
		}),
	});
	await write(OPS, {
		op: "remember",
		concept: concept({
			id: "projects/harbour/vault-binding-codes",
			title: "Vault approvals need a binding code",
			description: "How a person approves a credential request",
			statement:
				"A vault approval shows three binding codes; the approver picks the one the agent's request shows, so an approval can't be replayed onto another request.",
			tags: ["vault", "approval", "security"],
			scope: PLATFORM,
			sources: ["https://github.com/tvdavies/harbour/issues/12", "tvdavies/harbour:packages/vault/README.md"],
		}),
	});
	await write(OPS, {
		op: "correct",
		expectedVersion: 1,
		concept: concept({
			id: "projects/harbour/vault-binding-codes",
			title: "Vault approvals need a binding code",
			description: "How a person approves a credential request",
			statement:
				"A vault approval shows three binding codes; the approver picks the one the agent's request shows, so an approval can't be replayed onto another request. Route grants skip the code.",
			tags: ["vault", "approval", "security"],
			scope: PLATFORM,
			sources: ["https://github.com/tvdavies/harbour/issues/12", "tvdavies/harbour:packages/vault/README.md"],
		}),
	});
	await write(OPS, {
		op: "remember",
		concept: concept({
			id: "projects/harbour/staging-jobs-retry",
			title: "Stuck staging jobs retry from the admin API",
			statement: "Retry stuck staging jobs with POST /jobs/retry on the staging admin API, one job ID at a time.",
			tags: ["staging", "ops"],
			scope: PLATFORM,
			sources: ["https://admin.staging.harbour.dev/docs#retry"],
			staleAfter: FIXTURE_NOW - 2 * DAY,
		}),
	});
	await write(BILLING, {
		op: "remember",
		concept: concept({
			id: "projects/billing/stripe-test-mode",
			title: "Billing sessions use Stripe test mode",
			statement: "Billing agents use the Stripe test key; the live key is never granted to a session.",
			tags: ["stripe", "billing", "vault"],
			scope: BILLING_PROJECT,
			sources: ["https://github.com/tvdavies/harbour/issues/88"],
		}),
	});

	// A rule, replaced by a newer one; and an exception for one job.
	await write(TOM, {
		op: "remember",
		concept: concept({
			id: "projects/harbour/merge-after-review",
			title: "Kantel PRs wait for Tom to merge",
			statement: "Kantel pull requests wait for Tom to review and merge them.",
			tags: ["merge", "review"],
			scope: PLATFORM,
			sources: ["https://github.com/tvdavies/harbour/pull/40"],
		}),
	});
	now = FIXTURE_NOW - 6 * DAY;
	await write(TOM, {
		op: "supersede",
		conceptId: "projects/harbour/merge-after-review",
		expectedVersion: 1,
		replacement: concept({
			id: "projects/harbour/merge-when-green",
			title: "Workers merge Kantel PRs once CI is green",
			statement:
				"Workers merge their own Kantel pull requests (squash) once the required checks are green and no review asks for changes.",
			tags: ["merge", "review", "ci"],
			scope: PLATFORM,
			sources: ["https://github.com/tvdavies/harbour/pull/150"],
		}),
	});
	await write(TOM, {
		op: "remember",
		concept: concept({
			id: "projects/harbour/release-freeze-exception",
			title: "During the release freeze, wait for Tom",
			statement: "For the 0.4 release job, don't merge: leave the pull request for Tom.",
			tags: ["merge", "release"],
			scope: { kind: "job", job: "TASK-7" },
			overrides: "projects/harbour/merge-when-green",
			sources: ["TASK-7"],
		}),
	});

	// Forgotten, and a rejected proposal.
	await write(OPS, {
		op: "remember",
		concept: concept({
			id: "projects/harbour/sandbox-on-fly",
			title: "Sandboxes run on Fly machines",
			statement: "Self-hosted sandboxes run on Fly machines in the ams region.",
			tags: ["sandbox"],
			scope: PLATFORM,
			sources: ["https://github.com/tvdavies/harbour/issues/31"],
		}),
	});
	await write(TOM, {
		op: "forget",
		conceptId: "projects/harbour/sandbox-on-fly",
		expectedVersion: 1,
		reason: "Sandboxes moved to Docker on the self-hosted stack.",
	});
	await write(
		RELEASE,
		{
			op: "remember",
			concept: concept({
				id: "projects/harbour/release-day",
				title: "Releases go out on Fridays",
				statement: "Kantel releases go out on Friday afternoons.",
				scope: PLATFORM,
				sources: ["https://github.com/tvdavies/harbour/releases"],
			}),
		},
		"reject",
		"Not a rule: we release when it's ready.",
	);

	// Waiting on a person now.
	now = FIXTURE_NOW - 5 * HOUR;
	const pending = [
		await write(
			BILLING,
			{
				op: "remember",
				concept: concept({
					id: "projects/billing/invoice-mismatch-notes",
					title: "Invoice mismatches go in notes/reconcile",
					statement:
						"Write each month's invoice mismatches to notes/reconcile/<month>.md, one line per invoice with the amount and why it didn't match.",
					tags: ["billing", "notes"],
					scope: BILLING_PROJECT,
					sources: ["https://github.com/tvdavies/harbour/pull/162"],
				}),
			},
			"pending",
		),
		await write(
			OPS,
			{
				op: "remember",
				concept: concept({
					id: "projects/harbour/vault-codes-pick-one",
					title: "Approvers pick one of three codes",
					statement:
						"A vault approval shows three binding codes; the approver picks the one the agent's request shows.",
					tags: ["vault", "approval"],
					scope: PLATFORM,
					sources: ["https://github.com/tvdavies/harbour/issues/12"],
				}),
			},
			"pending",
		),
		await write(
			RELEASE,
			{
				op: "correct",
				expectedVersion: 1,
				concept: concept({
					id: "projects/harbour/release-notes-folder",
					title: "Release notes go in notes/releases",
					statement:
						"Draft release notes in notes/releases/<version>.md, grouped by area, each pull request linked, with breaking changes first.",
					tags: ["release"],
					scope: PLATFORM,
					sources: ["https://github.com/tvdavies/harbour/pull/131", "https://github.com/tvdavies/harbour/pull/158"],
				}),
			},
			"pending",
		),
	].map((proposal) => proposal.id);

	now = FIXTURE_NOW;
	return { memory, source, space, profile, pending };
}

export const pendingSource: MemoryPageSource = {
	listConcepts: () => new Promise(() => undefined),
	getConcept: () => new Promise(() => undefined),
	search: () => new Promise(() => undefined),
	recall: () => new Promise(() => undefined),
	listProposals: () => new Promise(() => undefined),
	decide: () => new Promise(() => undefined),
};

const unavailable = () => Promise.reject(new Error("Kantel is unavailable"));

export const failingSource: MemoryPageSource = {
	listConcepts: unavailable,
	getConcept: unavailable,
	search: unavailable,
	recall: unavailable,
	listProposals: unavailable,
	decide: unavailable,
};

/** The scenario's source with decisions failing, for the proposal's error state. */
export function failingDecisions(source: MemoryPageSource): MemoryPageSource {
	return { ...source, decide: unavailable };
}

/** A space as the page names it, for stories without a scenario. */
export const placeholderSpace: MemorySpace = {
	id: "space_placeholder",
	owner: { kind: "organisation", organisationId: ORGANISATION },
	name: "Kantel team",
	createdAt: FIXTURE_NOW - 30 * DAY,
};
