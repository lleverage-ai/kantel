/**
 * Conformance suite for `Memory` (packages/contracts/src/memory.ts). Every target registers it with a provider that
 * builds a fresh memory on the suite's clock, audit sink and project access.
 */
import type {
	CallContext,
	Concept,
	ConceptInput,
	Memory,
	MemoryAuthority,
	MemoryProposal,
	MemorySpace,
	MemoryWrite,
	ParaphraseCheck,
} from "@kantel/contracts";
import {
	actors,
	assertAccessDenied,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceOptions,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";

export interface MemorySubject {
	readonly memory: Memory;
}

/**
 * What a case asks the memory to be built with, beyond the deps: only the `writes` cases set either, and a provider
 * registered with `writes: true` must pass both on.
 */
export interface MemorySettings {
	readonly authority?: MemoryAuthority;
	readonly paraphrase?: ParaphraseCheck;
}

export type MemoryConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: MemorySubject) => Promise<void>,
	settings: MemorySettings,
) => Promise<void>;

export interface MemoryConformanceOptions extends ConformanceOptions {
	/**
	 * Runs the write cases that build the memory with `MemorySettings`: a stricter `MemoryAuthority` and a host's
	 * `ParaphraseCheck`. Needs `projectAccess` too.
	 */
	readonly writes?: boolean;
}

const ORG = "org-a";
const OTHER_ORG = "org-b";
const PROJECT = "proj-a";
const OTHER_PROJECT = "proj-b";

const human = contextFor(actors.human("owner-1"), ORG);
const service = contextFor(actors.service("atlas-supervisor"), ORG);
const agent = contextFor(actors.agent("agent-1", "session-1"), ORG);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG);
const outsiderAgent = contextFor(actors.agent("agent-9", "session-9"), OTHER_ORG);
/** An operator in the organisation, but only on another project. */
const stranger = contextFor(actors.human("stranger-1"), ORG, OTHER_PROJECT);
/** A viewer on the project. */
const viewer = contextFor(actors.human("viewer-1"), ORG, PROJECT);
/** An agent whose session belongs to another project. */
const otherProjectAgent = contextFor(actors.agent("agent-2", "session-other-project"), ORG, OTHER_PROJECT);
/** An admin across the organisation. */
const admin = contextFor(actors.human("admin-1"), ORG);
/** A user of the organisation with no role anywhere, who owns a space of their own. */
const solo = contextFor(actors.human("solo-1"), ORG);

/** The role bindings and agent sessions every case acts with. */
function seedTenancy(deps: ConformanceDeps): void {
	const tenancy = deps.tenancy;
	// Organisation-wide, so they may write to the organisation's spaces as well as the project's.
	tenancy.bind(human.actor, ORG, "operator");
	tenancy.bind(service.actor, ORG, "operator");
	tenancy.bind(admin.actor, ORG, "admin");
	tenancy.bind(stranger.actor, ORG, "operator", OTHER_PROJECT);
	tenancy.bind(viewer.actor, ORG, "viewer", PROJECT);
	tenancy.bind(outsider.actor, OTHER_ORG, "operator");
	tenancy.session({ id: "session-1", organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });
	tenancy.session({ id: "session-other-project", organisationId: ORG, projectId: OTHER_PROJECT, agentId: "agent-2" });
	tenancy.session({ id: "session-9", organisationId: OTHER_ORG, projectId: PROJECT, agentId: "agent-9" });
}

function conceptInput(id: string, title: string, statement: string, extra: Partial<ConceptInput> = {}): ConceptInput {
	return { id, title, statement, scope: { kind: "global" }, sources: ["tvdavies/harbour#39"], ...extra };
}

function bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

function createSpace(memory: Memory, ctx: CallContext = human): Promise<MemorySpace> {
	return memory.createSpace(ctx, { owner: { kind: "organisation", organisationId: ORG }, name: "Team memory" });
}

function createProjectSpace(memory: Memory, ctx: CallContext = human): Promise<MemorySpace> {
	return memory.createSpace(ctx, {
		owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
		name: "Project memory",
	});
}

/** Proposes `write` as `proposer` and applies it as a human; returns the applied proposal. */
async function applied(
	memory: Memory,
	spaceId: string,
	write: MemoryWrite,
	proposer: CallContext = human,
): Promise<MemoryProposal> {
	const proposal = await memory.propose(proposer, spaceId, write);
	return memory.decide(human, proposal.id, { outcome: "apply" });
}

async function remember(
	memory: Memory,
	spaceId: string,
	input: ConceptInput,
	proposer: CallContext = human,
): Promise<Concept> {
	await applied(memory, spaceId, { op: "remember", concept: input }, proposer);
	return memory.getConcept(human, spaceId, input.id);
}

const EMPTY_SNAPSHOT = { sourceId: "fixture", ref: "planted", concepts: [] };

function recalledIds(recall: { readonly concepts: readonly Concept[] }): string[] {
	return recall.concepts.map((concept) => concept.id);
}

export function createMemoryConformance(options: {
	assertions: ConformanceAssertions;
	provider: MemoryConformanceProvider;
	projectAccess?: boolean;
	writes?: boolean;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (
		name: string,
		body: (memory: Memory, deps: ConformanceDeps) => Promise<void>,
		settings: MemorySettings = {},
	): ConformanceCase => ({
		name,
		run: async () => {
			const deps = createDeps();
			seedTenancy(deps);
			await options.provider(deps, (subject) => body(subject.memory, deps), settings);
		},
	});

	const cases: ConformanceCase[] = [
		test("lets only humans and services create memory spaces", async (memory, deps) => {
			await assert.rejectsWithCode(createSpace(memory, agent), "forbidden", "an agent cannot create a space");
			const byHuman = await createSpace(memory, human);
			const byService = await createSpace(memory, service);
			assert.strictEqual(byHuman.name, "Team memory");
			assert.strictEqual(byHuman.createdAt, deps.clock.now());
			assert.ok(byHuman.id !== byService.id, "spaces get distinct IDs");
			assert.partialDeepEqual(deps.audit.ofType("memory.space.created"), [
				{ actor: human.actor, subject: { kind: "memory.space", id: byHuman.id } },
				{ actor: service.actor, subject: { kind: "memory.space", id: byService.id } },
			]);
		}),

		test("keeps a proposed fact out of memory until a human applies it", async (memory, deps) => {
			const space = await createSpace(memory);
			const input = conceptInput("projects/kantel/vault-codes", "Vault binding codes", "Writes need a binding code.");
			const proposal = await memory.propose(agent, space.id, { op: "remember", concept: input });
			assert.strictEqual(proposal.status, "pending");
			assert.strictEqual(proposal.spaceId, space.id);
			assert.deepEqual(proposal.proposedBy, agent.actor);
			assert.strictEqual(proposal.sessionId, "session-1", "an agent's proposal names its session");
			assert.strictEqual(deps.audit.ofType("memory.proposal.created").length, 1, "the proposal is audited");
			await assert.rejectsWithCode(memory.getConcept(human, space.id, input.id), "not_found", "not yet in memory");
			assert.strictEqual((await memory.listConcepts(human, space.id)).items.length, 0);
			const before = await memory.recall(agent, { spaceIds: [space.id], query: "vault binding code" });
			assert.strictEqual(before.concepts.length, 0, "recall does not return a pending fact");

			const decided = await memory.decide(human, proposal.id, { outcome: "apply", note: "Right" });
			assert.strictEqual(decided.status, "applied");
			assert.deepEqual(decided.decidedBy, human.actor);
			assert.strictEqual(decided.decidedAt, deps.clock.now());
			assert.strictEqual(decided.note, "Right");
			assert.strictEqual(deps.audit.ofType("memory.proposal.applied").length, 1, "the apply is audited");
			const concept = await memory.getConcept(agent, space.id, input.id);
			assert.partialDeepEqual(concept, { id: input.id, statement: input.statement, status: "active", version: 1 });
			const after = await memory.recall(agent, { spaceIds: [space.id], query: "vault binding code" });
			assert.deepEqual(recalledIds(after), [input.id], "an agent recalls the applied fact");
		}),

		test("rejects a proposal without changing memory and never decides a proposal twice", async (memory, deps) => {
			const space = await createSpace(memory);
			const input = conceptInput("personal/review-timing", "Review timing", "Review pull requests after lunch.");
			const proposal = await memory.propose(agent, space.id, { op: "remember", concept: input });
			const rejected = await memory.decide(service, proposal.id, { outcome: "reject", note: "Not true" });
			assert.strictEqual(rejected.status, "rejected");
			assert.deepEqual(rejected.decidedBy, service.actor);
			assert.strictEqual(deps.audit.ofType("memory.proposal.rejected").length, 1, "the rejection is audited");
			await assert.rejectsWithCode(memory.getConcept(human, space.id, input.id), "not_found");
			await assert.rejectsWithCode(memory.decide(human, proposal.id, { outcome: "apply" }), "conflict");
			await assert.rejectsWithCode(memory.decide(human, proposal.id, { outcome: "reject" }), "conflict");
			const listed = await memory.listProposals(human, space.id, { status: "rejected" });
			assert.deepEqual(
				listed.items.map((item) => item.id),
				[proposal.id],
			);
		}),

		test("refuses an agent applying or rejecting a proposal, even its own", async (memory) => {
			const space = await createSpace(memory);
			const input = conceptInput("personal/review-timing", "Review timing", "Review pull requests after lunch.");
			const proposal = await memory.propose(agent, space.id, { op: "remember", concept: input });
			await assert.rejectsWithCode(memory.decide(agent, proposal.id, { outcome: "apply" }), "forbidden");
			await assert.rejectsWithCode(memory.decide(agent, proposal.id, { outcome: "reject" }), "forbidden");
			const pending = await memory.listProposals(human, space.id, { status: "pending" });
			assert.deepEqual(
				pending.items.map((item) => item.id),
				[proposal.id],
				"the proposal stays pending",
			);
			await assert.rejectsWithCode(memory.getConcept(human, space.id, input.id), "not_found");
		}),

		test("flags a near-duplicate remember with duplicateOf and refuses to apply it while the original is active", async (memory) => {
			const space = await createSpace(memory);
			const original = await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/deploy-window", "Deploy window", "Deploy kantel only on weekday mornings"),
			);
			const near = conceptInput(
				"projects/kantel/deploy-times",
				"Deploy times",
				"Deploy kantel only on weekday mornings please",
			);
			const flagged = await memory.propose(agent, space.id, { op: "remember", concept: near });
			assert.strictEqual(flagged.duplicateOf, original.id, "the near-duplicate is flagged");
			const distinct = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput("projects/kantel/ci", "CI runner", "CI runs biome, tsc and vitest on every push"),
			});
			assert.strictEqual(distinct.duplicateOf, undefined, "an unrelated statement is not flagged");

			await assert.rejectsWithCode(memory.decide(human, flagged.id, { outcome: "apply" }), "conflict");
			assert.strictEqual((await memory.listProposals(human, space.id, { status: "pending" })).items.length, 2);
			await assert.rejectsWithCode(memory.getConcept(human, space.id, near.id), "not_found");

			await applied(memory, space.id, {
				op: "forget",
				conceptId: original.id,
				expectedVersion: original.version,
				reason: "Replaced by the deploy times concept",
			});
			const decided = await memory.decide(human, flagged.id, { outcome: "apply" });
			assert.strictEqual(decided.status, "applied", "once the original is gone the duplicate may apply");
		}),

		test("flags a paraphrase of an active concept, not only a near-identical statement, and refuses to apply it", async (memory) => {
			const space = await createSpace(memory);
			const original = await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/deploy-window", "Deploy window", "Deploy kantel only on weekday mornings"),
			);
			const merges = await remember(
				memory,
				space.id,
				conceptInput(
					"projects/kantel/merge-authority",
					"Merge authority",
					"Tom said he doesn't need to merge Kantel PRs; workers merge them once CI is green.",
				),
			);
			// Inflected and reordered: too few words in common for `similarity`, the same words once stemmed.
			const reworded = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput(
					"projects/kantel/deploy-days",
					"Deploy days",
					"Kantel deploys happen only on weekday mornings",
				),
			});
			assert.strictEqual(reworded.duplicateOf, original.id, "a reworded statement is caught");
			assert.strictEqual(reworded.duplicate?.check, "paraphrase");
			assert.ok((reworded.duplicate?.score ?? 0) >= 0.5 && (reworded.duplicate?.score ?? 2) <= 1, "scored 0 to 1");
			const restated = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput(
					"projects/kantel/who-merges",
					"Who merges Kantel PRs",
					"Workers merge Kantel pull requests themselves once CI passes; Tom doesn't need to merge them.",
				),
			});
			assert.strictEqual(restated.duplicateOf, merges.id, "a restatement is caught");
			const related = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput("projects/brwsr/deploy-window", "brwsr deploys", "Deploy brwsr on weekday evenings"),
			});
			assert.strictEqual(related.duplicateOf, undefined, "a related but different fact is not flagged");
			assert.strictEqual(related.duplicate, undefined);
			const exact = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput("projects/kantel/deploys", "Deploys", "Deploy kantel only on weekday mornings"),
			});
			assert.deepEqual(exact.duplicate, { score: 1, check: "similarity" }, "an exact repeat is a similarity match");

			await assert.rejectsWithCode(memory.decide(human, reworded.id, { outcome: "apply" }), "conflict");
			await assert.rejectsWithCode(memory.decide(human, restated.id, { outcome: "apply" }), "conflict");
			await assert.rejectsWithCode(memory.getConcept(human, space.id, "projects/kantel/deploy-days"), "not_found");
			assert.strictEqual((await memory.decide(human, related.id, { outcome: "apply" })).status, "applied");
		}),

		test("flags a correction or a replacement that repeats another active concept, but never the concept it changes", async (memory) => {
			const space = await createSpace(memory);
			const ci = await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/ci", "CI runner", "CI runs biome, tsc and vitest on every push"),
			);
			const deploy = await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/deploy-window", "Deploy window", "Deploy kantel only on weekday mornings"),
				agent,
			);
			const reworded = await memory.propose(agent, space.id, {
				op: "correct",
				concept: conceptInput(deploy.id, "Deploy window", "Deploy kantel only on weekday mornings, never Fridays"),
				expectedVersion: deploy.version,
			});
			assert.strictEqual(reworded.duplicateOf, undefined, "correcting a concept is not a duplicate of itself");
			const copied = await memory.propose(agent, space.id, {
				op: "correct",
				concept: conceptInput(deploy.id, "Deploy window", "CI runs biome, tsc and vitest on every push"),
				expectedVersion: deploy.version,
			});
			assert.strictEqual(copied.duplicateOf, ci.id, "a correction repeating another concept is flagged");
			const replaced = await memory.propose(agent, space.id, {
				op: "supersede",
				conceptId: deploy.id,
				expectedVersion: deploy.version,
				replacement: conceptInput(
					"projects/kantel/ci-checks",
					"CI checks",
					"On every push CI runs tsc, vitest and biome",
				),
			});
			assert.strictEqual(replaced.duplicateOf, ci.id, "a replacement repeating another concept is flagged");
			const renamed = await memory.propose(agent, space.id, {
				op: "supersede",
				conceptId: deploy.id,
				expectedVersion: deploy.version,
				replacement: conceptInput(
					"projects/kantel/deploy-days",
					"Deploy days",
					"Deploy kantel only on weekday mornings",
				),
			});
			assert.strictEqual(renamed.duplicateOf, undefined, "a replacement may restate the concept it supersedes");

			await assert.rejectsWithCode(memory.decide(human, copied.id, { outcome: "apply" }), "conflict");
			await assert.rejectsWithCode(memory.decide(human, replaced.id, { outcome: "apply" }), "conflict");
			assert.partialDeepEqual(await memory.getConcept(human, space.id, deploy.id), { version: 1, status: "active" });
			assert.strictEqual((await memory.decide(human, renamed.id, { outcome: "apply" })).status, "applied");
		}),

		test("refuses to apply a proposal that repeats a concept applied after it was proposed", async (memory) => {
			const space = await createSpace(memory);
			const statement = "Release notes go out every Tuesday after the weekly planning call";
			const first = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput("projects/kantel/release-notes", "Release notes", statement),
			});
			const second = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput("projects/kantel/release-cadence", "Release cadence", statement),
			});
			assert.strictEqual(second.duplicateOf, undefined, "nothing was active to repeat when it was proposed");
			assert.strictEqual((await memory.decide(human, first.id, { outcome: "apply" })).status, "applied");
			await assert.rejectsWithCode(memory.decide(human, second.id, { outcome: "apply" }), "conflict");
			await assert.rejectsWithCode(memory.getConcept(human, space.id, "projects/kantel/release-cadence"), "not_found");
		}),

		test("refuses a remember for a concept ID that is already active", async (memory) => {
			const space = await createSpace(memory);
			const input = conceptInput("projects/kantel/ci", "CI runner", "CI runs on every push.");
			await remember(memory, space.id, input);
			await assert.rejectsWithCode(
				memory.propose(human, space.id, { op: "remember", concept: { ...input, statement: "Something else" } }),
				"conflict",
			);
		}),

		test("refuses an agent correcting, superseding or forgetting an owner-set concept, but lets it propose a correction to a learned one", async (memory) => {
			const space = await createSpace(memory);
			const owned = await remember(
				memory,
				space.id,
				conceptInput("personal/editor", "Editor", "The owner uses Helix as their editor."),
			);
			assert.strictEqual(owned.setBy, "owner");
			const writes: MemoryWrite[] = [
				{ op: "correct", concept: { ...conceptInput(owned.id, "Editor", "The owner uses Vim.") }, expectedVersion: 1 },
				{
					op: "supersede",
					conceptId: owned.id,
					expectedVersion: 1,
					replacement: conceptInput("personal/editor-2", "Editor", "The owner uses Vim."),
				},
				{ op: "forget", conceptId: owned.id, expectedVersion: 1, reason: "Outdated" },
			];
			const proposalsBefore = (await memory.listProposals(human, space.id)).items.length;
			for (const write of writes) {
				await assert.rejectsWithCode(memory.propose(agent, space.id, write), "refused", `an agent's ${write.op}`);
			}
			assert.strictEqual(
				(await memory.listProposals(human, space.id)).items.length,
				proposalsBefore,
				"no proposal was created",
			);
			assert.partialDeepEqual(await memory.getConcept(human, space.id, owned.id), { version: 1, status: "active" });

			const learned = await remember(
				memory,
				space.id,
				conceptInput("personal/terminal", "Terminal", "The owner uses Ghostty."),
				agent,
			);
			assert.strictEqual(learned.setBy, "learned");
			const correction = await memory.propose(agent, space.id, {
				op: "correct",
				concept: conceptInput(learned.id, "Terminal", "The owner uses WezTerm."),
				expectedVersion: learned.version,
			});
			assert.strictEqual(correction.status, "pending");
			await memory.decide(human, correction.id, { outcome: "apply" });
			assert.partialDeepEqual(await memory.getConcept(human, space.id, learned.id), {
				statement: "The owner uses WezTerm.",
				setBy: "learned",
				version: 2,
			});
		}),

		test("marks a concept learned when an agent's proposal is applied and owner when a human's or service's is", async (memory, deps) => {
			const space = await createSpace(memory);
			const fromAgent = await remember(
				memory,
				space.id,
				conceptInput("personal/coffee", "Coffee", "The owner drinks flat whites."),
				agent,
			);
			const fromHuman = await remember(
				memory,
				space.id,
				conceptInput("personal/tea", "Tea", "The owner never drinks tea."),
				human,
			);
			const fromService = await remember(
				memory,
				space.id,
				conceptInput("personal/standup", "Standup", "Standup is at nine thirty."),
				service,
			);
			assert.partialDeepEqual(fromAgent, { setBy: "learned", version: 1, updatedAt: deps.clock.now() });
			assert.strictEqual(fromHuman.setBy, "owner");
			assert.strictEqual(fromService.setBy, "owner");

			deps.clock.advance(60_000);
			await applied(memory, space.id, {
				op: "correct",
				concept: conceptInput(fromAgent.id, "Coffee", "The owner drinks cortados."),
				expectedVersion: 1,
			});
			assert.partialDeepEqual(
				await memory.getConcept(human, space.id, fromAgent.id),
				{ setBy: "owner", version: 2, updatedAt: deps.clock.now() },
				"a human's correction makes the concept owner-set and bumps its version and time",
			);
		}),

		test("refuses a stale expectedVersion with conflict and changes nothing", async (memory) => {
			const space = await createSpace(memory);
			const concept = await remember(memory, space.id, conceptInput("projects/kantel/ci", "CI", "CI runs on push."));
			await applied(memory, space.id, {
				op: "correct",
				concept: conceptInput(concept.id, "CI", "CI runs on push and pull request."),
				expectedVersion: 1,
			});
			const stale: MemoryWrite[] = [
				{ op: "correct", concept: conceptInput(concept.id, "CI", "CI never runs."), expectedVersion: 1 },
				{
					op: "supersede",
					conceptId: concept.id,
					expectedVersion: 1,
					replacement: conceptInput("projects/kantel/ci-2", "CI", "CI runs nightly."),
				},
				{ op: "forget", conceptId: concept.id, expectedVersion: 1, reason: "Gone" },
			];
			for (const write of stale) {
				const proposal = await memory.propose(human, space.id, write);
				await assert.rejectsWithCode(
					memory.decide(human, proposal.id, { outcome: "apply" }),
					"conflict",
					`a stale ${write.op}`,
				);
			}
			assert.partialDeepEqual(await memory.getConcept(human, space.id, concept.id), {
				statement: "CI runs on push and pull request.",
				version: 2,
				status: "active",
			});
			await assert.rejectsWithCode(memory.getConcept(human, space.id, "projects/kantel/ci-2"), "not_found");
			assert.strictEqual(
				(await memory.listProposals(human, space.id, { status: "pending" })).items.length,
				3,
				"the stale proposals stay pending",
			);
		}),

		test("serialises concurrent applies on one space so exactly one of two racing corrections applies", async (memory, deps) => {
			const space = await createSpace(memory);
			const concept = await remember(memory, space.id, conceptInput("projects/kantel/ci", "CI", "CI runs on push."));
			const first = await memory.propose(human, space.id, {
				op: "correct",
				concept: conceptInput(concept.id, "CI", "CI runs on every push."),
				expectedVersion: 1,
			});
			const second = await memory.propose(service, space.id, {
				op: "correct",
				concept: conceptInput(concept.id, "CI", "CI runs on every pull request."),
				expectedVersion: 1,
			});
			const appliedBefore = deps.audit.ofType("memory.proposal.applied").length;
			const results = await Promise.allSettled([
				memory.decide(human, first.id, { outcome: "apply" }),
				memory.decide(service, second.id, { outcome: "apply" }),
			]);
			const fulfilled = results.filter((result) => result.status === "fulfilled");
			const rejected = results.filter((result) => result.status === "rejected");
			assert.strictEqual(fulfilled.length, 1, "exactly one correction applies");
			assert.strictEqual(rejected.length, 1, "the other is refused");
			await assert.rejectsWithCode(Promise.reject(rejected[0]?.reason), "conflict");
			const winner = (fulfilled[0] as PromiseFulfilledResult<MemoryProposal>).value;
			const current = await memory.getConcept(human, space.id, concept.id);
			assert.strictEqual(current.version, 2);
			assert.strictEqual(
				current.statement,
				winner.write.op === "correct" ? winner.write.concept.statement : undefined,
				"the concept holds the winner's statement",
			);
			assert.strictEqual(deps.audit.ofType("memory.proposal.applied").length, appliedBefore + 1);

			const third = await memory.propose(human, space.id, {
				op: "forget",
				conceptId: concept.id,
				expectedVersion: 2,
				reason: "Done",
			});
			const twice = await Promise.allSettled([
				memory.decide(human, third.id, { outcome: "apply" }),
				memory.decide(service, third.id, { outcome: "apply" }),
			]);
			assert.strictEqual(
				twice.filter((result) => result.status === "fulfilled").length,
				1,
				"one proposal applied twice at once applies once",
			);
			assert.strictEqual((await memory.getConcept(human, space.id, concept.id)).version, 3);

			const raced = await memory.propose(human, space.id, {
				op: "remember",
				concept: conceptInput("projects/kantel/lint", "Lint", "Biome lints and formats the code."),
			});
			const applyOrReject = await Promise.allSettled([
				memory.decide(human, raced.id, { outcome: "apply" }),
				memory.decide(service, raced.id, { outcome: "reject" }),
			]);
			const outcomes = applyOrReject.flatMap((result) => (result.status === "fulfilled" ? [result.value.status] : []));
			assert.strictEqual(outcomes.length, 1, "an apply racing a reject settles the proposal once");
			const settled = (await memory.listProposals(human, space.id)).items.find((item) => item.id === raced.id);
			assert.strictEqual(settled?.status, outcomes[0], "the stored status is the outcome that won");
			const remembered = await memory
				.getConcept(human, space.id, "projects/kantel/lint")
				.then(() => true)
				.catch(() => false);
			assert.strictEqual(remembered, outcomes[0] === "applied", "memory matches the outcome");
		}),

		test("bounds recall by maxConcepts and maxBytes, reports truncation and keeps the profile apart", async (memory) => {
			const space = await createSpace(memory);
			const profile = await remember(
				memory,
				space.id,
				conceptInput("personal/name", "Owner's name", "The owner is called Tom."),
			);
			for (let index = 0; index < 6; index += 1) {
				await remember(
					memory,
					space.id,
					conceptInput(
						`projects/kantel/deploy-${index}`,
						`Deploy note ${index}`,
						`Deploy step ${index}: café ${"é".repeat(index)}`,
					),
				);
			}
			const query = "deploy";
			const two = await memory.recall(human, { spaceIds: [space.id], query, profile: [profile.id], maxConcepts: 2 });
			assert.strictEqual(two.concepts.length, 3, "maxConcepts counts matches, not the profile");
			assert.strictEqual(two.concepts[0]?.id, profile.id, "the profile comes first");
			assert.deepEqual(
				two.manifest.map((entry) => entry.reason),
				["profile", "search", "search"],
			);
			assert.strictEqual(two.truncated, true, "more matched than maxConcepts allowed");

			const defaults = await memory.recall(human, { spaceIds: [space.id], query });
			assert.strictEqual(defaults.concepts.length, 5, "five concepts by default");
			assert.strictEqual(defaults.truncated, true);
			assert.ok(defaults.skipped.length > 0, "what was left out is named");

			// Without a profile, the rendered text is exactly what maxBytes counts.
			const pair = await memory.recall(human, { spaceIds: [space.id], query, maxConcepts: 2 });
			const budget = bytes(pair.text);
			const exact = await memory.recall(human, { spaceIds: [space.id], query, maxBytes: budget });
			assert.deepEqual(recalledIds(exact), recalledIds(pair), "a concept that fits exactly is kept");
			const tight = await memory.recall(human, { spaceIds: [space.id], query, maxBytes: budget - 1 });
			assert.deepEqual(recalledIds(tight), recalledIds(pair).slice(0, 1), "maxBytes counts UTF-8 bytes of the text");
			assert.strictEqual(tight.truncated, true);

			const fits = await memory.recall(human, { spaceIds: [space.id], query: "", profile: [profile.id] });
			assert.deepEqual(recalledIds(fits), [profile.id], "the profile is recalled whatever the query");
			assert.strictEqual(fits.truncated, false, "nothing more matched");
			assert.ok(fits.text.includes("The owner is called Tom."), "the text shows the statement");
			const none = await memory.recall(human, {
				spaceIds: [space.id],
				query: "",
				profile: [profile.id],
				maxProfileConcepts: 0,
			});
			assert.deepEqual(recalledIds(none), [], "a profile limit of 0 turns the profile off");
			assert.strictEqual(none.text, "", "an empty recall renders nothing");

			const longSpace = await createSpace(memory);
			for (let index = 0; index < 3; index += 1) {
				await remember(
					memory,
					longSpace.id,
					conceptInput(`projects/kantel/long-${index}`, `Release ${index}`, `release ${"x ".repeat(1500)} ${index}`),
				);
			}
			const bytesDefault = await memory.recall(human, { spaceIds: [longSpace.id], query: "release" });
			assert.ok(bytes(bytesDefault.text) <= 4096, "4096 bytes by default");
			assert.ok(bytesDefault.concepts.length < 3);
			assert.strictEqual(bytesDefault.truncated, true);
		}),

		test("keeps the profile within its own limits, names what it leaves out and shows the oldest first", async (memory, deps) => {
			const space = await createSpace(memory);
			const ids: string[] = [];
			const habits = [
				"Runs before breakfast along the canal",
				"Reads papers on Sunday afternoons",
				"Answers email only after lunch",
				"Plays chess with friends on Thursdays",
			];
			for (let index = 0; index < habits.length; index += 1) {
				deps.clock.advance(1000);
				const concept = await remember(
					memory,
					space.id,
					conceptInput(`personal/habit-${index}`, `Habit ${index}`, `${habits[index]}.`),
				);
				ids.push(concept.id);
			}
			const all = await memory.recall(human, { spaceIds: [space.id], query: "", profile: [...ids].reverse() });
			assert.deepEqual(recalledIds(all), ids, "rendered oldest first, whatever order the profile names them in");
			assert.deepEqual(all.profileOmitted, []);

			const capped = await memory.recall(human, {
				spaceIds: [space.id],
				query: "papers",
				profile: ids,
				maxProfileConcepts: 2,
			});
			assert.strictEqual(capped.concepts.length, 2);
			assert.ok(recalledIds(capped).includes("personal/habit-1"), "a profile concept the query matches goes first");
			assert.ok(recalledIds(capped).includes("personal/habit-3"), "then the newest");
			assert.deepEqual([...capped.profileOmitted].sort(), ["personal/habit-0", "personal/habit-2"]);
			for (const id of capped.profileOmitted) assert.ok(capped.text.includes(id), "the text names what was left out");
			assert.strictEqual(capped.truncated, true);

			const one = await memory.recall(human, { spaceIds: [space.id], query: "", profile: ids, maxProfileBytes: 1 });
			assert.deepEqual(recalledIds(one), [], "a profile concept over its byte budget is left out");
			assert.deepEqual([...one.profileOmitted].sort(), ids);
		}),

		test("recalls a concept only for a keyword match in its title, ID or tags, not one passing word", async (memory) => {
			const space = await createSpace(memory);
			await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/tunnels", "Tunnels", "Tunnels carry traffic; the gateway deploys them."),
			);
			await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/gateways", "Gateway notes", "The gateway fronts every session."),
			);
			await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/egress", "Egress", "Egress goes through the proxy.", { tags: ["gateway"] }),
			);
			const recall = await memory.recall(human, { spaceIds: [space.id], query: "gateway" });
			assert.deepEqual(
				[...recalledIds(recall)].sort(),
				["projects/kantel/egress", "projects/kantel/gateways"],
				"a title, ID or tag match recalls; a word in the statement alone does not",
			);
			assert.deepEqual(recall.manifest[0]?.matched, ["gateway"], "the manifest names the matched terms");
			const filler = await memory.recall(human, { spaceIds: [space.id], query: "hi, thanks, quick question" });
			assert.deepEqual(recalledIds(filler), [], "filler words recall nothing");
		}),

		test("brings a job's exception along with the general concept it overrides, and only for that job", async (memory) => {
			const space = await createSpace(memory);
			await remember(
				memory,
				space.id,
				conceptInput("personal/merge-policy", "Merge policy", "Never merge without review."),
			);
			await remember(
				memory,
				space.id,
				conceptInput("personal/merge-policy-nightly", "Nightly merges", "The nightly job may merge green PRs.", {
					scope: { kind: "job", job: "T-7" },
					overrides: "personal/merge-policy",
				}),
			);
			const plain = await memory.recall(human, { spaceIds: [space.id], query: "merge policy" });
			assert.deepEqual(recalledIds(plain), ["personal/merge-policy"], "another job's exception stays out");
			assert.ok(
				plain.skipped.some((entry) => entry.conceptId === "personal/merge-policy-nightly"),
				"and is named as skipped",
			);
			const forJob = await memory.recall(human, {
				spaceIds: [space.id],
				query: "merge policy",
				scopes: { jobs: ["T-6", "T-7"] },
			});
			assert.deepEqual(recalledIds(forJob), ["personal/merge-policy", "personal/merge-policy-nightly"]);
			assert.deepEqual(
				forJob.manifest.map((entry) => entry.reason),
				["search", "exception"],
			);
			const excluded = await memory.recall(human, {
				spaceIds: [space.id],
				query: "merge policy",
				exclude: ["personal/merge-policy"],
			});
			assert.deepEqual(recalledIds(excluded), [], "a concept the session already has is not recalled");
			await assert.rejectsWithCode(
				memory.propose(human, space.id, {
					op: "remember",
					concept: conceptInput("personal/merge-other", "Other", "Something else entirely here.", {
						overrides: "personal/merge-policy",
					}),
				}),
				"invalid",
				"only a job concept overrides another",
			);
		}),

		test("searches by keyword, ranks stale concepts lower and lists inactive ones only when asked", async (memory, deps) => {
			const space = await createSpace(memory);
			const staleAt = deps.clock.now() + 1000;
			await remember(memory, space.id, conceptInput("projects/kantel/ci", "CI runners", "CI runs on GitHub Actions."));
			await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/ci-cache", "CI cache", "The pnpm store is cached between CI runs.", {
					staleAfter: staleAt,
				}),
			);
			const gone = await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/ci-old", "Old CI", "CI used to run on Buildkite runners."),
			);
			await applied(memory, space.id, { op: "forget", conceptId: gone.id, expectedVersion: 1, reason: "Moved" });
			deps.clock.set(staleAt);
			const hits = await memory.search(agent, { spaceIds: [space.id], query: "ci runners" });
			assert.deepEqual(
				hits.map((hit) => hit.concept.id),
				["projects/kantel/ci", "projects/kantel/ci-cache"],
			);
			assert.strictEqual(hits[1]?.stale, true);
			assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0), "the stale concept ranks lower");
			assert.ok(hits[0]?.snippet.includes("GitHub Actions"), "a hit carries a snippet");
			const history = await memory.search(agent, { spaceIds: [space.id], query: "ci runners", includeInactive: true });
			assert.ok(
				history.some((hit) => hit.concept.id === gone.id),
				"inactive concepts are listed when asked for",
			);
			const one = await memory.search(agent, { spaceIds: [space.id], query: "ci", limit: 1 });
			assert.strictEqual(one.length, 1);
			await assert.rejectsWithCode(memory.search(agent, { spaceIds: [space.id], query: "ci", limit: 11 }), "invalid");
			await assert.rejectsWithCode(memory.search(outsider, { spaceIds: [space.id], query: "ci" }), "not_found");
		}),

		test("imports a snapshot as one change, records its ref and names it in every recall", async (memory, deps) => {
			const space = await createSpace(memory);
			await remember(memory, space.id, conceptInput("projects/kantel/old", "Old fact", "Something applied before."));
			const at = deps.clock.now();
			const snapshot = {
				sourceId: "team-memory",
				ref: "7fbf30f",
				concepts: [
					{
						...conceptInput("projects/kantel/deploys", "Deploy windows", "Deploy on weekday mornings.", {
							extensions: { sal: { learnedFrom: "owner" } },
						}),
						setBy: "owner" as const,
						status: "active" as const,
						updatedAt: at - 5000,
					},
					{
						...conceptInput("projects/kantel/deploy-fridays", "Deploy on Fridays", "Deploy on Fridays too."),
						setBy: "learned" as const,
						status: "superseded" as const,
						supersededBy: "projects/kantel/deploys",
						updatedAt: at - 9000,
					},
				],
			};
			await assert.rejectsWithCode(
				memory.importSnapshot(agent, space.id, snapshot),
				"forbidden",
				"agents cannot import",
			);
			const imported = await memory.importSnapshot(service, space.id, snapshot);
			assert.partialDeepEqual(imported.snapshot, { sourceId: "team-memory", ref: "7fbf30f" });
			const concepts = await memory.listConcepts(human, space.id);
			assert.deepEqual(
				concepts.items.map((concept) => concept.id),
				["projects/kantel/deploy-fridays", "projects/kantel/deploys"],
				"the snapshot replaces what the space held",
			);
			assert.partialDeepEqual(await memory.getConcept(human, space.id, "projects/kantel/deploys"), {
				setBy: "owner",
				updatedAt: at - 5000,
				extensions: { sal: { learnedFrom: "owner" } },
			});
			const recall = await memory.recall(agent, { spaceIds: [space.id], query: "deploy windows fridays" });
			assert.deepEqual(recalledIds(recall), ["projects/kantel/deploys"], "inactive snapshot concepts stay out");
			assert.strictEqual(recall.manifest[0]?.snapshotRef, "7fbf30f", "the manifest names the snapshot's ref");
			const version = (await memory.getConcept(human, space.id, "projects/kantel/deploys")).version;
			await memory.importSnapshot(service, space.id, { ...snapshot, ref: "8a1b2c3" });
			assert.strictEqual(
				(await memory.getConcept(human, space.id, "projects/kantel/deploys")).version,
				version,
				"an unchanged concept keeps its version",
			);
			await assert.rejectsWithCode(
				memory.importSnapshot(service, space.id, {
					...snapshot,
					concepts: [snapshot.concepts[0]!, snapshot.concepts[0]!],
				}),
				"invalid",
				"a concept appears once",
			);
			await assert.rejectsWithCode(memory.importSnapshot(outsider, space.id, snapshot), "not_found");
			assert.strictEqual(deps.audit.ofType("memory.snapshot.imported").length, 2, "each import is audited once");

			// A concept a snapshot drops and a later one brings back carries on from its highest version, so a proposal
			// made against the old one is stale.
			const pending = await memory.propose(human, space.id, {
				op: "correct",
				concept: conceptInput("projects/kantel/deploys", "Deploy windows", "Deploy only on Mondays."),
				expectedVersion: version,
			});
			await memory.importSnapshot(service, space.id, {
				...snapshot,
				ref: "9c0d1e2",
				concepts: [snapshot.concepts[1]!],
			});
			const back = { ...snapshot.concepts[0]!, statement: "Deploy on weekday mornings before ten." };
			await memory.importSnapshot(service, space.id, { ...snapshot, ref: "a3b4c5d", concepts: [back] });
			const restored = await memory.getConcept(human, space.id, "projects/kantel/deploys");
			assert.greaterThan(restored.version, version, "a concept that comes back gets a new version");
			await assert.rejectsWithCode(memory.decide(human, pending.id, { outcome: "apply" }), "conflict");
			assert.strictEqual(
				(await memory.getConcept(human, space.id, "projects/kantel/deploys")).statement,
				back.statement,
				"the stale correction changed nothing",
			);

			// Going back to an earlier ref is a change of its own, audited as one.
			await memory.importSnapshot(service, space.id, snapshot);
			await memory.importSnapshot(service, space.id, snapshot);
			assert.strictEqual(
				deps.audit.ofType("memory.snapshot.imported").length,
				5,
				"returning to a ref is audited, importing the current one again is not",
			);
		}),

		test("applies the BM25 floor and half-the-best cutoff once a space holds 30 concepts", async (memory) => {
			const space = await createSpace(memory);
			const words = [
				"amber",
				"birch",
				"cedar",
				"delta",
				"ember",
				"fjord",
				"grove",
				"heath",
				"inlet",
				"juniper",
				"kestrel",
				"larch",
				"maple",
				"nettle",
				"orchid",
				"poplar",
				"quartz",
				"rowan",
				"sorrel",
				"thistle",
				"umber",
				"violet",
				"willow",
				"xylem",
				"yarrow",
				"zinnia",
				"aspen",
				"bracken",
			];
			const snapshot = {
				sourceId: "fixture",
				ref: "1",
				concepts: [
					...words.map((word) => ({
						...conceptInput(`projects/garden/${word}`, `${word} bed`, `The ${word} bed is watered weekly.`),
						setBy: "owner" as const,
						status: "active" as const,
						updatedAt: 1,
					})),
					{
						...conceptInput("projects/garden/compost-heap", "Compost heap", "Turn the compost heap monthly.", {
							tags: ["compost"],
						}),
						setBy: "owner" as const,
						status: "active" as const,
						updatedAt: 1,
					},
					{
						...conceptInput("projects/garden/heap-notes", "Heap notes", "Notes on the leaf heap behind the shed."),
						setBy: "owner" as const,
						status: "active" as const,
						updatedAt: 1,
					},
				],
			};
			await memory.importSnapshot(service, space.id, snapshot);
			const recall = await memory.recall(human, { spaceIds: [space.id], query: "compost heap" });
			assert.deepEqual(
				recalledIds(recall),
				["projects/garden/compost-heap"],
				"a weaker keyword match under half the best score is left out",
			);
			assert.strictEqual(recall.truncated, false, "a concept under the cutoff did not match, so nothing was cut");
			const small = await createSpace(memory);
			await memory.importSnapshot(service, small.id, { ...snapshot, concepts: snapshot.concepts.slice(-2) });
			assert.deepEqual(
				[...recalledIds(await memory.recall(human, { spaceIds: [small.id], query: "compost heap" }))].sort(),
				["projects/garden/compost-heap", "projects/garden/heap-notes"],
				"below 30 concepts only the keyword gate applies",
			);
		}),

		test("recalls the most relevant concept for a query first by BM25, without embeddings", async (memory) => {
			const space = await createSpace(memory);
			const entries = [
				conceptInput("projects/kantel/vault-codes", "Vault binding codes", "Every vault write needs a binding code."),
				conceptInput("personal/review-timing", "Review timing", "Review pull requests after lunch."),
				conceptInput("projects/kantel/deploys", "Deploy windows", "Deploy on weekday mornings, never Fridays."),
				conceptInput("projects/kantel/vault-items", "Vault items", "Items hold credentials for one host.", {
					tags: ["vault"],
				}),
			];
			for (const entry of entries) await remember(memory, space.id, entry);
			const recall = await memory.recall(agent, {
				spaceIds: [space.id],
				query: "How do binding codes work in the vault?",
			});
			assert.strictEqual(recall.concepts[0]?.id, "projects/kantel/vault-codes", "the best match comes first");
			assert.ok(!recalledIds(recall).includes("personal/review-timing"), "an unrelated concept is not recalled");
			const scores = recall.manifest.map((entry) => entry.score ?? 0);
			for (const score of scores) assert.greaterThan(score, 0);
			for (let index = 1; index < scores.length; index += 1) {
				assert.ok(scores[index - 1]! >= scores[index]!, "search results are ordered by score");
			}
			const deploy = await memory.recall(agent, { spaceIds: [space.id], query: "when should we deploy" });
			assert.deepEqual(recalledIds(deploy), ["projects/kantel/deploys"]);
		}),

		test("recalls project and job concepts only when their scope is asked for, and global ones always", async (memory) => {
			const space = await createSpace(memory);
			await remember(memory, space.id, conceptInput("org/deploy", "Deploy", "Deploy with the release checklist."));
			await remember(
				memory,
				space.id,
				conceptInput(
					"projects/kantel/deploy",
					"Deploy kantel",
					"Kantel deploys from the main branch through Workers.",
					{
						scope: { kind: "project", project: "kantel" },
					},
				),
			);
			await remember(
				memory,
				space.id,
				conceptInput("projects/atlas/deploy", "Deploy atlas", "Atlas deploys to the home server by hand.", {
					scope: { kind: "project", project: "atlas" },
				}),
			);
			await remember(
				memory,
				space.id,
				conceptInput("jobs/nightly/deploy", "Deploy nightly", "The nightly job deploys previews only.", {
					scope: { kind: "job", job: "nightly" },
				}),
			);
			const sorted = (ids: string[]) => [...ids].sort();
			const query = "deploy";
			const plain = await memory.recall(human, {
				spaceIds: [space.id],
				query,
				profile: ["projects/kantel/deploy", "jobs/nightly/deploy"],
			});
			assert.deepEqual(recalledIds(plain), ["org/deploy"], "without scopes only global concepts, even in the profile");
			const project = await memory.recall(human, { spaceIds: [space.id], query, scopes: { projects: ["kantel"] } });
			assert.deepEqual(sorted(recalledIds(project)), ["org/deploy", "projects/kantel/deploy"]);
			const job = await memory.recall(human, { spaceIds: [space.id], query, scopes: { jobs: ["nightly"] } });
			assert.deepEqual(sorted(recalledIds(job)), ["jobs/nightly/deploy", "org/deploy"]);
		}),

		test("names each recalled concept's version and reason in the manifest and marks stale concepts", async (memory, deps) => {
			const space = await createSpace(memory);
			const staleAt = deps.clock.now() + 60_000;
			const fresh = await remember(memory, space.id, conceptInput("personal/owner", "Owner", "Tom is the owner."));
			const ageing = await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/release-train", "Release train", "Kantel releases ship every Tuesday.", {
					staleAfter: staleAt,
				}),
			);
			await applied(memory, space.id, {
				op: "correct",
				concept: conceptInput(ageing.id, "Release train", "Kantel releases ship every Wednesday.", {
					staleAfter: staleAt,
				}),
				expectedVersion: 1,
			});
			const request = {
				spaceIds: [space.id],
				query: "release train",
				profile: [fresh.id],
				scopes: { projects: ["kantel"] },
			};
			const before = await memory.recall(human, request);
			assert.partialDeepEqual(before.manifest, [
				{ spaceId: space.id, conceptId: fresh.id, version: 1, reason: "profile", stale: false, truncated: false },
				{ spaceId: space.id, conceptId: ageing.id, version: 2, reason: "search", stale: false, truncated: false },
			]);
			assert.strictEqual(before.manifest[0]?.score, undefined, "a profile entry the query missed has no score");
			assert.greaterThan(before.manifest[1]?.score ?? 0, 0);
			assert.deepEqual(before.manifest[1]?.matched, ["release", "train"]);

			deps.clock.set(staleAt);
			const after = await memory.recall(human, request);
			assert.deepEqual(
				after.manifest.map((entry) => entry.stale),
				[false, true],
				"a concept is stale from its staleAfter time",
			);
			assert.deepEqual(recalledIds(after), [fresh.id, ageing.id], "stale concepts are still recalled");
			assert.ok((after.manifest[1]?.score ?? 0) < (before.manifest[1]?.score ?? 0), "a stale concept scores half");
		}),

		test("never recalls superseded or forgotten concepts, and a superseded one points to its replacement", async (memory) => {
			const space = await createSpace(memory);
			const old = await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/runtime", "Kantel runtime", "Kantel runs sessions on Node."),
			);
			const gone = await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/runtime-host", "Kantel runtime host", "Kantel sessions run on a VPS."),
			);
			await applied(memory, space.id, {
				op: "supersede",
				conceptId: old.id,
				expectedVersion: 1,
				replacement: conceptInput("projects/kantel/runtime-workers", "Kantel runtime", "Kantel runs on Workers."),
			});
			await applied(memory, space.id, { op: "forget", conceptId: gone.id, expectedVersion: 1, reason: "Wrong" });

			assert.partialDeepEqual(await memory.getConcept(human, space.id, old.id), {
				status: "superseded",
				supersededBy: "projects/kantel/runtime-workers",
				version: 2,
			});
			assert.partialDeepEqual(await memory.getConcept(human, space.id, gone.id), { status: "forgotten", version: 2 });
			const recall = await memory.recall(human, {
				spaceIds: [space.id],
				query: "kantel runtime sessions node vps",
				profile: [old.id, gone.id],
			});
			assert.deepEqual(recalledIds(recall), ["projects/kantel/runtime-workers"]);
			const active = await memory.listConcepts(human, space.id, { status: "active" });
			assert.deepEqual(
				active.items.map((concept) => concept.id),
				["projects/kantel/runtime-workers"],
			);
			const superseded = await memory.listConcepts(human, space.id, { status: "superseded" });
			assert.deepEqual(
				superseded.items.map((concept) => concept.id),
				[old.id],
			);
		}),

		test("refuses a concept without a source as invalid", async (memory) => {
			const space = await createSpace(memory);
			const existing = await remember(memory, space.id, conceptInput("projects/kantel/ci", "CI", "CI runs on push."));
			const unsourced = (id: string) => conceptInput(id, "Unsourced", "No one knows why.", { sources: [] });
			const writes: MemoryWrite[] = [
				{ op: "remember", concept: unsourced("projects/kantel/unsourced") },
				{ op: "correct", concept: unsourced(existing.id), expectedVersion: 1 },
				{
					op: "supersede",
					conceptId: existing.id,
					expectedVersion: 1,
					replacement: unsourced("projects/kantel/ci-2"),
				},
			];
			for (const write of writes) {
				await assert.rejectsWithCode(memory.propose(human, space.id, write), "invalid", `an unsourced ${write.op}`);
			}
			assert.strictEqual((await memory.listProposals(human, space.id)).items.length, 1, "only the first remember");
		}),

		test("refuses a malformed concept ID as invalid", async (memory) => {
			const space = await createSpace(memory);
			for (const id of ["Projects/Kantel", "projects//ci", "../etc/passwd", "projects/kantel/", "projects/ci note"]) {
				await assert.rejectsWithCode(
					memory.propose(human, space.id, { op: "remember", concept: conceptInput(id, "Bad", "Bad ID.") }),
					"invalid",
					`ID ${id}`,
				);
			}
		}),

		test("hides another organisation's spaces as not found for reads, recall, proposals and decisions", async (memory) => {
			const space = await createSpace(memory);
			const concept = await remember(memory, space.id, conceptInput("projects/kantel/ci", "CI", "CI runs on push."));
			const pending = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput("projects/kantel/lint", "Lint", "Biome lints the code."),
			});
			await assert.rejectsWithCode(memory.getConcept(outsider, space.id, concept.id), "not_found");
			await assert.rejectsWithCode(memory.listConcepts(outsider, space.id), "not_found");
			await assert.rejectsWithCode(memory.listProposals(outsider, space.id), "not_found");
			await assert.rejectsWithCode(memory.exportBundle(outsider, space.id), "not_found");
			await assert.rejectsWithCode(memory.recall(outsider, { spaceIds: [space.id], query: "ci" }), "not_found");
			await assert.rejectsWithCode(memory.recall(outsiderAgent, { spaceIds: [space.id], query: "ci" }), "not_found");
			await assert.rejectsWithCode(
				memory.propose(outsider, space.id, {
					op: "remember",
					concept: conceptInput("projects/kantel/x", "X", "X."),
				}),
				"not_found",
			);
			await assert.rejectsWithCode(memory.decide(outsider, pending.id, { outcome: "apply" }), "not_found");
			const own = await memory.createSpace(outsider, {
				owner: { kind: "organisation", organisationId: OTHER_ORG },
				name: "Other memory",
			});
			await assert.rejectsWithCode(
				memory.recall(outsider, { spaceIds: [own.id, space.id], query: "ci" }),
				"not_found",
				"one foreign space in the request is enough to refuse it",
			);
			assert.strictEqual((await memory.getConcept(human, space.id, concept.id)).version, 1);
		}),

		test("exports one Markdown file with frontmatter per concept and an index of active concepts", async (memory) => {
			const space = await createSpace(memory);
			const kept = await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/ci", "CI runner", "CI runs biome, tsc and vitest.", {
					description: "What CI checks",
					tags: ["ci"],
					scope: { kind: "project", project: "kantel" },
				}),
			);
			const old = await remember(
				memory,
				space.id,
				conceptInput("projects/kantel/host", "Host", "Kantel runs on a VPS."),
			);
			const gone = await remember(memory, space.id, conceptInput("personal/tea", "Tea", "The owner drinks tea."));
			await applied(memory, space.id, {
				op: "supersede",
				conceptId: old.id,
				expectedVersion: 1,
				replacement: conceptInput("projects/kantel/host-workers", "Host on Workers", "Kantel runs on Workers."),
			});
			await applied(memory, space.id, { op: "forget", conceptId: gone.id, expectedVersion: 1, reason: "Wrong" });

			const bundle = await memory.exportBundle(human, space.id);
			const paths = bundle.map((file) => file.path).sort();
			assert.deepEqual(paths, [
				"index.md",
				"personal/tea.md",
				"projects/kantel/ci.md",
				"projects/kantel/host-workers.md",
				"projects/kantel/host.md",
			]);
			const file = (path: string) => bundle.find((entry) => entry.path === path)?.content ?? "";
			const ci = file(`${kept.id}.md`);
			const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(ci)?.[1] ?? "";
			for (const field of ["id", "title", "description", "tags", "scope", "sources", "setBy", "version", "status"]) {
				assert.ok(new RegExp(`^${field}:`, "m").test(frontmatter), `the frontmatter has ${field}`);
			}
			assert.ok(/^setBy: "?owner"?$/m.test(frontmatter), "setBy is recorded");
			assert.ok(/^status: "?active"?$/m.test(frontmatter), "status is recorded");
			assert.ok(ci.trimEnd().endsWith(kept.statement), "the statement follows the frontmatter");
			assert.ok(/^supersededBy: "?projects\/kantel\/host-workers"?$/m.test(file(`${old.id}.md`)));
			assert.ok(/^status: "?forgotten"?$/m.test(file(`${gone.id}.md`)));

			const index = file("index.md");
			assert.ok(index.includes(`${kept.id}.md`), "the index lists an active concept");
			assert.ok(index.includes("projects/kantel/host-workers.md"), "the index lists the replacement");
			assert.ok(!index.includes(`${old.id}.md`), "the index leaves out a superseded concept");
			assert.ok(!index.includes(`${gone.id}.md`), "the index leaves out a forgotten concept");
		}),
	];
	if (options.projectAccess !== true) return cases;

	/** A project space holding one applied concept and one pending proposal. */
	const seedProjectSpace = async (memory: Memory) => {
		const space = await createProjectSpace(memory);
		const concept = await remember(memory, space.id, conceptInput("projects/kantel/ci", "CI", "CI runs on push."));
		const pending = await memory.propose(human, space.id, {
			op: "remember",
			concept: conceptInput("projects/kantel/lint", "Lint", "Biome lints the code."),
		});
		return { space, concept, pending };
	};

	/** Asserts the seeded project space is as `seedProjectSpace` left it. */
	const assertUnchanged = async (memory: Memory, seeded: Awaited<ReturnType<typeof seedProjectSpace>>) => {
		const { space, concept, pending } = seeded;
		assert.partialDeepEqual(await memory.getConcept(human, space.id, concept.id), { version: 1, status: "active" });
		const proposals = (await memory.listProposals(human, space.id)).items;
		assert.strictEqual(proposals.length, 2, "no proposal was added");
		assert.strictEqual(proposals.find((item) => item.id === pending.id)?.status, "pending", "the proposal is pending");
		assert.strictEqual((await memory.listConcepts(human, space.id)).items.length, 1, "no concept was added");
	};

	const withAccess: ConformanceCase[] = [
		...cases,

		test("project access: an operator outside the project is refused for every change and read of its space, and nothing changed", async (memory, deps) => {
			const seeded = await seedProjectSpace(memory);
			const { space, concept, pending } = seeded;
			const team = await createSpace(memory);
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			await refused("memory.createSpace", createProjectSpace(memory, stranger));
			await refused("memory.getConcept", memory.getConcept(stranger, space.id, concept.id));
			await refused("memory.listConcepts", memory.listConcepts(stranger, space.id));
			await refused("memory.listProposals", memory.listProposals(stranger, space.id));
			await refused("memory.exportBundle", memory.exportBundle(stranger, space.id));
			await refused("memory.recall", memory.recall(stranger, { spaceIds: [space.id], query: "ci" }));
			await refused("memory.recall", memory.recall(stranger, { spaceIds: [team.id, space.id], query: "ci" }));
			await refused("memory.search", memory.search(stranger, { spaceIds: [space.id], query: "ci" }));
			await refused("memory.search", memory.search(stranger, { spaceIds: [team.id, space.id], query: "ci" }));
			await refused("memory.importSnapshot", memory.importSnapshot(stranger, space.id, EMPTY_SNAPSHOT));
			await refused(
				"memory.propose",
				memory.propose(stranger, space.id, {
					op: "remember",
					concept: conceptInput("projects/kantel/planted", "Planted", "Planted by a stranger."),
				}),
			);
			await refused("memory.decide", memory.decide(stranger, pending.id, { outcome: "apply" }));
			await refused("memory.decide", memory.decide(stranger, pending.id, { outcome: "reject" }));
			await assertUnchanged(memory, seeded);
			assert.strictEqual(deps.audit.ofType("memory.space.created").length, 2, "no space was created");
			assert.strictEqual(
				(await memory.recall(stranger, { spaceIds: [team.id], query: "ci" })).concepts.length,
				0,
				"the organisation's own space stays readable",
			);
		}),

		test("project access: a viewer on the project may read its space but not change it", async (memory, deps) => {
			const seeded = await seedProjectSpace(memory);
			const { space, concept, pending } = seeded;
			assert.strictEqual((await memory.getConcept(viewer, space.id, concept.id)).version, 1);
			assert.strictEqual((await memory.listConcepts(viewer, space.id)).items.length, 1);
			assert.strictEqual((await memory.listProposals(viewer, space.id)).items.length, 2);
			assert.ok((await memory.exportBundle(viewer, space.id)).some((file) => file.path === `${concept.id}.md`));
			assert.deepEqual(recalledIds(await memory.recall(viewer, { spaceIds: [space.id], query: "ci" })), [concept.id]);
			assert.deepEqual(
				(await memory.search(viewer, { spaceIds: [space.id], query: "ci" })).map((hit) => hit.concept.id),
				[concept.id],
			);
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			await refused("memory.createSpace", createProjectSpace(memory, viewer));
			await refused(
				"memory.propose",
				memory.propose(viewer, space.id, {
					op: "remember",
					concept: conceptInput("projects/kantel/planted", "Planted", "Planted by a viewer."),
				}),
			);
			await refused("memory.decide", memory.decide(viewer, pending.id, { outcome: "apply" }));
			await refused("memory.importSnapshot", memory.importSnapshot(viewer, space.id, EMPTY_SNAPSHOT));
			await assertUnchanged(memory, seeded);
		}),

		test("project access: an agent whose session belongs to another project is refused, and nothing changed", async (memory, deps) => {
			const seeded = await seedProjectSpace(memory);
			const { space, concept, pending } = seeded;
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			await refused("memory.getConcept", memory.getConcept(otherProjectAgent, space.id, concept.id));
			await refused("memory.listConcepts", memory.listConcepts(otherProjectAgent, space.id));
			await refused("memory.listProposals", memory.listProposals(otherProjectAgent, space.id));
			await refused("memory.exportBundle", memory.exportBundle(otherProjectAgent, space.id));
			await refused("memory.recall", memory.recall(otherProjectAgent, { spaceIds: [space.id], query: "ci" }));
			await refused("memory.search", memory.search(otherProjectAgent, { spaceIds: [space.id], query: "ci" }));
			await refused(
				"memory.propose",
				memory.propose(otherProjectAgent, space.id, {
					op: "remember",
					concept: conceptInput("projects/kantel/planted", "Planted", "Planted by another project's agent."),
				}),
			);
			// Agents never create spaces or decide, whichever project: that refusal comes first.
			await assert.rejectsWithCode(createProjectSpace(memory, otherProjectAgent), "forbidden");
			await assert.rejectsWithCode(memory.decide(otherProjectAgent, pending.id, { outcome: "apply" }), "forbidden");
			await assertUnchanged(memory, seeded);
			const team = await createSpace(memory);
			await remember(memory, team.id, conceptInput("org/ci", "CI", "CI runs on push."));
			assert.deepEqual(
				recalledIds(await memory.recall(otherProjectAgent, { spaceIds: [team.id], query: "ci" })),
				["org/ci"],
				"the organisation's spaces stay readable to its agents",
			);
		}),

		test("project access: an agent whose session was closed is refused", async (memory, deps) => {
			const seeded = await seedProjectSpace(memory);
			const { space, concept } = seeded;
			assert.strictEqual((await memory.getConcept(agent, space.id, concept.id)).version, 1, "open, it reads");
			deps.tenancy.close("session-1");
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			await refused("memory.getConcept", memory.getConcept(agent, space.id, concept.id));
			await refused("memory.listConcepts", memory.listConcepts(agent, space.id));
			await refused("memory.recall", memory.recall(agent, { spaceIds: [space.id], query: "ci" }));
			await refused("memory.search", memory.search(agent, { spaceIds: [space.id], query: "ci" }));
			await refused(
				"memory.propose",
				memory.propose(agent, space.id, {
					op: "remember",
					concept: conceptInput("projects/kantel/late", "Late", "Proposed after the session closed."),
				}),
			);
			await assertUnchanged(memory, seeded);
		}),

		test("project access: an operator on the project and an agent in its own session still work on its space", async (memory, deps) => {
			const space = await createProjectSpace(memory, service);
			const proposal = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput("projects/kantel/ci", "CI", "CI runs on push."),
			});
			assert.strictEqual(proposal.sessionId, "session-1");
			assert.strictEqual((await memory.listProposals(agent, space.id)).items.length, 1);
			await memory.decide(human, proposal.id, { outcome: "apply" });
			assert.strictEqual((await memory.getConcept(agent, space.id, "projects/kantel/ci")).setBy, "learned");
			assert.strictEqual((await memory.listConcepts(agent, space.id)).items.length, 1);
			assert.deepEqual(recalledIds(await memory.recall(agent, { spaceIds: [space.id], query: "ci" })), [
				"projects/kantel/ci",
			]);
			assert.strictEqual((await memory.exportBundle(agent, space.id)).length, 2);
			assert.strictEqual((await memory.search(agent, { spaceIds: [space.id], query: "ci" })).length, 1);
			const imported = await memory.importSnapshot(service, space.id, EMPTY_SNAPSHOT);
			assert.strictEqual(imported.snapshot?.ref, EMPTY_SNAPSHOT.ref, "an operator on the project imports");
			const rejected = await memory.propose(service, space.id, {
				op: "remember",
				concept: conceptInput("projects/kantel/lint", "Lint", "Biome lints the code."),
			});
			assert.strictEqual((await memory.decide(service, rejected.id, { outcome: "reject" })).status, "rejected");
			assert.strictEqual(deps.audit.ofType("access.denied").length, 0, "nothing was refused");
		}),

		test("write authority: writing to an organisation's space needs a role across the organisation, not on one project", async (memory, deps) => {
			const team = await createSpace(memory);
			const concept = await remember(memory, team.id, conceptInput("org/ci", "CI", "CI runs on push."));
			const pending = await memory.propose(human, team.id, {
				op: "remember",
				concept: conceptInput("org/lint", "Lint", "Biome lints the code."),
			});
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			// The stranger is an operator, but only on another project.
			await refused("memory.createSpace", createSpace(memory, stranger));
			await refused(
				"memory.propose",
				memory.propose(stranger, team.id, {
					op: "remember",
					concept: conceptInput("org/planted", "Planted", "Planted by a project operator."),
				}),
			);
			await refused("memory.decide", memory.decide(stranger, pending.id, { outcome: "apply" }));
			await refused("memory.decide", memory.decide(viewer, pending.id, { outcome: "reject" }));
			await refused("memory.importSnapshot", memory.importSnapshot(stranger, team.id, EMPTY_SNAPSHOT));
			assert.strictEqual(deps.audit.ofType("memory.space.created").length, 1, "no space was created");
			assert.strictEqual((await memory.listProposals(human, team.id, { status: "pending" })).items.length, 1);
			assert.strictEqual((await memory.listConcepts(human, team.id)).items.length, 1, "nothing was applied");
			// Reading the organisation's memory is still open to its members.
			assert.strictEqual((await memory.getConcept(stranger, team.id, concept.id)).version, 1);
			assert.deepEqual(recalledIds(await memory.recall(stranger, { spaceIds: [team.id], query: "ci" })), [concept.id]);
			// An organisation-wide admin may do all of it.
			assert.strictEqual((await memory.decide(admin, pending.id, { outcome: "apply" })).status, "applied");
			assert.strictEqual((await createSpace(memory, admin)).name, "Team memory");
		}),

		test("write authority: a user writes to their own space without a role; anyone else needs one across the organisation", async (memory, deps) => {
			const own = await memory.createSpace(solo, {
				owner: { kind: "user", organisationId: ORG, userId: "solo-1" },
				name: "My memory",
			});
			const mine = await memory.propose(solo, own.id, {
				op: "remember",
				concept: conceptInput("personal/editor", "Editor", "I use Helix as my editor."),
			});
			assert.strictEqual((await memory.decide(solo, mine.id, { outcome: "apply" })).status, "applied");
			assert.strictEqual((await memory.getConcept(solo, own.id, "personal/editor")).setBy, "owner");
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			await refused(
				"memory.createSpace",
				memory.createSpace(solo, { owner: { kind: "user", organisationId: ORG, userId: "viewer-1" }, name: "Theirs" }),
			);
			const theirs = await memory.propose(agent, own.id, {
				op: "remember",
				concept: conceptInput("personal/shell", "Shell", "The user's shell is fish."),
			});
			await refused("memory.decide", memory.decide(stranger, theirs.id, { outcome: "apply" }));
			await refused(
				"memory.propose",
				memory.propose(viewer, own.id, {
					op: "remember",
					concept: conceptInput("personal/planted", "Planted", "Planted by a viewer."),
				}),
			);
			assert.strictEqual((await memory.decide(service, theirs.id, { outcome: "apply" })).status, "applied");
			assert.strictEqual((await memory.getConcept(solo, own.id, "personal/shell")).setBy, "learned");
		}),

		test("write authority: an agent proposes to an organisation's space only through its own open session", async (memory, deps) => {
			const team = await createSpace(memory);
			const proposal = await memory.propose(otherProjectAgent, team.id, {
				op: "remember",
				concept: conceptInput("org/ci", "CI", "CI runs on push."),
			});
			assert.strictEqual(proposal.sessionId, "session-other-project", "any project's agent may propose");
			deps.tenancy.close("session-other-project");
			await assertAccessDenied(
				assert,
				deps,
				memory.propose(otherProjectAgent, team.id, {
					op: "remember",
					concept: conceptInput("org/late", "Late", "Proposed after the session closed."),
				}),
				{ operation: "memory.propose" },
			);
			const ghost = contextFor(actors.agent("agent-ghost", "session-unknown"), ORG);
			await assertAccessDenied(
				assert,
				deps,
				memory.propose(ghost, team.id, {
					op: "remember",
					concept: conceptInput("org/ghost", "Ghost", "Proposed by an agent without a session."),
				}),
				{ operation: "memory.propose" },
			);
			assert.strictEqual((await memory.listProposals(human, team.id)).items.length, 1, "only the first was kept");
		}),
	];
	if (options.writes !== true) return withAccess;

	const strict: MemorySettings = {
		authority: { createSpace: "admin", propose: "operator", decide: "admin", importSnapshot: "admin" },
	};

	return [
		...withAccess,

		test(
			"writes: a memory's authority sets the role each write needs, and an agent never holds more than operator",
			async (memory, deps) => {
				const refused = (operation: string, call: Promise<unknown>) =>
					assertAccessDenied(assert, deps, call, { operation });
				await refused("memory.createSpace", createSpace(memory, human));
				const team = await createSpace(memory, admin);
				const project = await createProjectSpace(memory, admin);
				const byOperator = await memory.propose(human, team.id, {
					op: "remember",
					concept: conceptInput("org/ci", "CI", "CI runs on push."),
				});
				const byAgent = await memory.propose(agent, project.id, {
					op: "remember",
					concept: conceptInput("projects/kantel/lint", "Lint", "Biome lints the code."),
				});
				await refused("memory.decide", memory.decide(human, byOperator.id, { outcome: "apply" }));
				await refused("memory.decide", memory.decide(service, byAgent.id, { outcome: "reject" }));
				await refused("memory.importSnapshot", memory.importSnapshot(human, team.id, EMPTY_SNAPSHOT));
				assert.strictEqual((await memory.listProposals(admin, team.id, { status: "pending" })).items.length, 1);
				assert.strictEqual((await memory.decide(admin, byOperator.id, { outcome: "apply" })).status, "applied");
				assert.strictEqual((await memory.decide(admin, byAgent.id, { outcome: "apply" })).status, "applied");
				assert.strictEqual((await memory.getConcept(human, project.id, "projects/kantel/lint")).setBy, "learned");
			},
			strict,
		),

		test(
			"writes: an authority needing admin to propose shuts agents out, since an agent counts as an operator",
			async (memory, deps) => {
				const team = await createSpace(memory, admin);
				await assertAccessDenied(
					assert,
					deps,
					memory.propose(agent, team.id, {
						op: "remember",
						concept: conceptInput("org/ci", "CI", "CI runs on push."),
					}),
					{ operation: "memory.propose" },
				);
				const proposal = await memory.propose(admin, team.id, {
					op: "remember",
					concept: conceptInput("org/ci", "CI", "CI runs on push."),
				});
				assert.strictEqual(proposal.status, "pending");
			},
			{ authority: { createSpace: "admin", propose: "admin", decide: "admin", importSnapshot: "admin" } },
		),

		(() => {
			const shown: { candidate: string; nearest: string[] }[] = [];
			const paraphrase: ParaphraseCheck = {
				name: "host-judge",
				async check(candidate, nearest) {
					shown.push({ candidate: candidate.id, nearest: nearest.map((concept) => concept.id) });
					if (candidate.id === "personal/heartbeat-messages") {
						return { conceptId: "personal/heartbeat-silent", score: 0.9 };
					}
					// Naming a concept it was not shown is ignored.
					if (candidate.id === "personal/stray") return { conceptId: "personal/elsewhere", score: 0.9 };
					return undefined;
				},
			};
			return test(
				"writes: a host's paraphrase check catches what words alone miss, shown only the nearest active concepts",
				async (memory) => {
					const space = await createSpace(memory);
					const silent = await remember(
						memory,
						space.id,
						conceptInput("personal/heartbeat-silent", "Heartbeat", "Alex wants heartbeat check-ins to finish silently"),
					);
					await remember(memory, space.id, conceptInput("personal/editor", "Editor", "Alex uses Helix."));
					const asked = () => shown.filter((entry) => entry.candidate !== "personal/editor");
					const exact = await memory.propose(agent, space.id, {
						op: "remember",
						concept: conceptInput("personal/repeat", "Repeat", "Alex wants heartbeat check-ins to finish silently"),
					});
					assert.strictEqual(exact.duplicate?.check, "similarity", "Kantel's own check comes first");
					assert.strictEqual(asked().length, 0, "the host is not asked when Kantel's checks find one");

					const reworded = await memory.propose(agent, space.id, {
						op: "remember",
						concept: conceptInput(
							"personal/heartbeat-messages",
							"Heartbeat messages",
							"Alex prefers not to receive heartbeat check-in messages",
						),
					});
					assert.strictEqual(reworded.duplicateOf, silent.id);
					assert.deepEqual(reworded.duplicate, { score: 0.9, check: "host-judge" });
					const judged = asked()[0];
					assert.strictEqual(judged?.candidate, "personal/heartbeat-messages");
					assert.ok(!judged?.nearest.includes("personal/repeat"), "a pending proposal is not shown");
					assert.strictEqual(judged?.nearest[0], silent.id, "the nearest concept comes first");
					assert.ok(judged?.nearest.includes("personal/editor"), "any active concept sharing a word is shown");
					await assert.rejectsWithCode(memory.decide(human, reworded.id, { outcome: "apply" }), "conflict");

					const stray = await memory.propose(agent, space.id, {
						op: "remember",
						concept: conceptInput("personal/stray", "Stray", "Alex reviews heartbeat changes on Fridays"),
					});
					assert.strictEqual(stray.duplicateOf, undefined, "a host naming a concept it was not shown is ignored");
					const unrelated = await memory.propose(agent, space.id, {
						op: "remember",
						concept: conceptInput("personal/coffee", "Coffee", "Bethan drinks oat flat whites"),
					});
					assert.strictEqual(unrelated.duplicateOf, undefined);
					assert.ok(
						!shown.some((entry) => entry.candidate === "personal/coffee"),
						"the host is not asked when no concept shares a word",
					);
				},
				{ paraphrase },
			);
		})(),

		test("project access: lists the spaces a caller may read, oldest first, and never another user's", async (memory, deps) => {
			const team = await createSpace(memory);
			deps.clock.advance(1000);
			const project = await createProjectSpace(memory);
			deps.clock.advance(1000);
			const mine = await memory.createSpace(human, {
				owner: { kind: "user", organisationId: ORG, userId: "owner-1" },
				name: "My memory",
			});
			deps.clock.advance(1000);
			const theirs = await memory.createSpace(service, {
				owner: { kind: "user", organisationId: ORG, userId: "viewer-1" },
				name: "Their memory",
			});
			const ids = async (ctx: CallContext) => (await memory.listSpaces(ctx)).items.map((space) => space.id);
			assert.deepEqual(await ids(human), [team.id, project.id, mine.id], "the owner's own space, never another user's");
			assert.deepEqual(await ids(service), [team.id, project.id, mine.id, theirs.id], "a service sees every space");
			assert.deepEqual(await ids(viewer), [team.id, project.id, theirs.id], "a viewer sees the project's");
			assert.deepEqual(await ids(stranger), [team.id], "not a project the caller has no role on");
			assert.deepEqual(await ids(agent), [team.id, project.id], "an agent sees its session's project, no user's");
			assert.deepEqual(await ids(otherProjectAgent), [team.id]);
			assert.deepEqual(await ids(outsider), [], "never another organisation's");
			const first = await memory.listSpaces(service, { limit: 2 });
			assert.deepEqual(
				first.items.map((space) => space.id),
				[team.id, project.id],
			);
			assert.ok(first.nextCursor !== undefined, "a page says more follow");
			const rest = await memory.listSpaces(service, { limit: 2, cursor: first.nextCursor! });
			assert.deepEqual(
				rest.items.map((space) => space.id),
				[mine.id, theirs.id],
			);
			assert.strictEqual(deps.audit.ofType("access.denied").length, 0, "a list filters, it never refuses");
		}),
	];
}

export function registerMemoryConformance(
	runner: ConformanceRunner,
	name: string,
	provider: MemoryConformanceProvider,
	options?: MemoryConformanceOptions,
): void {
	registerCases(
		runner,
		name,
		createMemoryConformance({
			assertions: createExpectAssertions(runner.expect),
			provider,
			...(options?.projectAccess === undefined ? {} : { projectAccess: options.projectAccess }),
			...(options?.writes === undefined ? {} : { writes: options.writes }),
		}),
	);
}
