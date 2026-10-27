/**
 * Conformance suite for `Memory` (packages/contracts/src/memory.ts). Every target registers it with a provider that
 * builds a fresh memory on the suite's clock and audit sink.
 */
import type {
	CallContext,
	Concept,
	ConceptInput,
	Memory,
	MemoryProposal,
	MemorySpace,
	MemoryWrite,
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

export interface MemorySubject {
	readonly memory: Memory;
}

export type MemoryConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: MemorySubject) => Promise<void>,
) => Promise<void>;

const ORG = "org-a";
const OTHER_ORG = "org-b";

const human = contextFor(actors.human("owner-1"), ORG);
const service = contextFor(actors.service("sal-supervisor"), ORG);
const agent = contextFor(actors.agent("agent-1", "session-1"), ORG);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG);
const outsiderAgent = contextFor(actors.agent("agent-9", "session-9"), OTHER_ORG);

function conceptInput(id: string, title: string, statement: string, extra: Partial<ConceptInput> = {}): ConceptInput {
	return { id, title, statement, scope: { kind: "global" }, sources: ["tvdavies/harbour#39"], ...extra };
}

function bytesOf(concept: Pick<Concept, "title" | "statement">): number {
	return new TextEncoder().encode(concept.title + concept.statement).length;
}

function createSpace(memory: Memory, ctx: CallContext = human): Promise<MemorySpace> {
	return memory.createSpace(ctx, { owner: { kind: "organisation", organisationId: ORG }, name: "Team memory" });
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

function recalledIds(recall: { readonly concepts: readonly Concept[] }): string[] {
	return recall.concepts.map((concept) => concept.id);
}

export function createMemoryConformance(options: {
	assertions: ConformanceAssertions;
	provider: MemoryConformanceProvider;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (name: string, body: (memory: Memory, deps: ConformanceDeps) => Promise<void>): ConformanceCase => ({
		name,
		run: async () => {
			const deps = createDeps();
			await options.provider(deps, (subject) => body(subject.memory, deps));
		},
	});

	return [
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
			const input = conceptInput("projects/harbour/vault-codes", "Vault binding codes", "Writes need a binding code.");
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
				conceptInput("projects/harbour/deploy-window", "Deploy window", "Deploy harbour only on weekday mornings"),
			);
			const near = conceptInput(
				"projects/harbour/deploy-times",
				"Deploy times",
				"Deploy harbour only on weekday mornings please",
			);
			const flagged = await memory.propose(agent, space.id, { op: "remember", concept: near });
			assert.strictEqual(flagged.duplicateOf, original.id, "the near-duplicate is flagged");
			const distinct = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput("projects/harbour/ci", "CI runner", "CI runs biome, tsc and vitest on every push"),
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

		test("refuses a remember for a concept ID that is already active", async (memory) => {
			const space = await createSpace(memory);
			const input = conceptInput("projects/harbour/ci", "CI runner", "CI runs on every push.");
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
			const concept = await remember(memory, space.id, conceptInput("projects/harbour/ci", "CI", "CI runs on push."));
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
					replacement: conceptInput("projects/harbour/ci-2", "CI", "CI runs nightly."),
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
			await assert.rejectsWithCode(memory.getConcept(human, space.id, "projects/harbour/ci-2"), "not_found");
			assert.strictEqual(
				(await memory.listProposals(human, space.id, { status: "pending" })).items.length,
				3,
				"the stale proposals stay pending",
			);
		}),

		test("serialises concurrent applies on one space so exactly one of two racing corrections applies", async (memory, deps) => {
			const space = await createSpace(memory);
			const concept = await remember(memory, space.id, conceptInput("projects/harbour/ci", "CI", "CI runs on push."));
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
				concept: conceptInput("projects/harbour/lint", "Lint", "Biome lints and formats the code."),
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
				.getConcept(human, space.id, "projects/harbour/lint")
				.then(() => true)
				.catch(() => false);
			assert.strictEqual(remembered, outcomes[0] === "applied", "memory matches the outcome");
		}),

		test("bounds recall by maxConcepts and maxBytes, reports truncation and puts profile concepts first", async (memory) => {
			const space = await createSpace(memory);
			const profile = await remember(
				memory,
				space.id,
				conceptInput("personal/name", "Owner's name", "The owner is called Tom."),
			);
			const deploys: Concept[] = [];
			for (let index = 0; index < 6; index += 1) {
				deploys.push(
					await remember(
						memory,
						space.id,
						conceptInput(
							`projects/harbour/deploy-${index}`,
							`Déploy note ${index}`,
							`Déploy step ${index}: café ${"é".repeat(index)}`,
						),
					),
				);
			}
			const query = "déploy";
			const two = await memory.recall(human, { spaceIds: [space.id], query, profile: [profile.id], maxConcepts: 2 });
			assert.strictEqual(two.concepts.length, 2);
			assert.strictEqual(two.concepts[0]?.id, profile.id, "the profile comes first");
			assert.strictEqual(two.manifest[0]?.reason, "profile");
			assert.strictEqual(two.manifest[1]?.reason, "search");
			assert.strictEqual(two.truncated, true, "more matched than maxConcepts allowed");

			const defaults = await memory.recall(human, { spaceIds: [space.id], query });
			assert.strictEqual(defaults.concepts.length, 5, "five concepts by default");
			assert.strictEqual(defaults.truncated, true);

			const [firstHit, secondHit] = defaults.concepts;
			const budget = bytesOf(firstHit!) + bytesOf(secondHit!);
			const tight = await memory.recall(human, { spaceIds: [space.id], query, maxBytes: budget - 1 });
			assert.deepEqual(recalledIds(tight), [firstHit!.id], "maxBytes counts UTF-8 bytes of title and statement");
			assert.strictEqual(tight.truncated, true);
			const exact = await memory.recall(human, { spaceIds: [space.id], query, maxBytes: budget });
			assert.deepEqual(recalledIds(exact), [firstHit!.id, secondHit!.id], "a concept that fits exactly is kept");

			const fits = await memory.recall(human, { spaceIds: [space.id], query: "", profile: [profile.id] });
			assert.deepEqual(recalledIds(fits), [profile.id]);
			assert.strictEqual(fits.truncated, false, "nothing more matched");

			const longSpace = await createSpace(memory);
			for (let index = 0; index < 3; index += 1) {
				await remember(
					memory,
					longSpace.id,
					conceptInput(`projects/harbour/long-${index}`, `Release ${index}`, `release ${"x".repeat(1500)} ${index}`),
				);
			}
			const bytesDefault = await memory.recall(human, { spaceIds: [longSpace.id], query: "release" });
			assert.strictEqual(bytesDefault.concepts.length, 2, "4096 bytes by default");
			assert.strictEqual(bytesDefault.truncated, true);
		}),

		test("recalls the most relevant concept for a query first by BM25, without embeddings", async (memory) => {
			const space = await createSpace(memory);
			const entries = [
				conceptInput("projects/harbour/vault-codes", "Vault binding codes", "Every vault write needs a binding code."),
				conceptInput("personal/review-timing", "Review timing", "Review pull requests after lunch."),
				conceptInput("projects/harbour/deploys", "Deploy windows", "Deploy on weekday mornings, never Fridays."),
				conceptInput("projects/harbour/vault-items", "Vault items", "Items hold credentials for one host.", {
					tags: ["vault"],
				}),
			];
			for (const entry of entries) await remember(memory, space.id, entry);
			const recall = await memory.recall(agent, {
				spaceIds: [space.id],
				query: "How do binding codes work in the vault?",
			});
			assert.strictEqual(recall.concepts[0]?.id, "projects/harbour/vault-codes", "the best match comes first");
			assert.ok(!recalledIds(recall).includes("personal/review-timing"), "an unrelated concept is not recalled");
			const scores = recall.manifest.map((entry) => entry.score ?? 0);
			for (const score of scores) assert.greaterThan(score, 0);
			for (let index = 1; index < scores.length; index += 1) {
				assert.ok(scores[index - 1]! >= scores[index]!, "search results are ordered by score");
			}
			const deploy = await memory.recall(agent, { spaceIds: [space.id], query: "when should we deploy" });
			assert.deepEqual(recalledIds(deploy), ["projects/harbour/deploys"]);
		}),

		test("recalls project and job concepts only when their scope is asked for, and global ones always", async (memory) => {
			const space = await createSpace(memory);
			await remember(memory, space.id, conceptInput("org/deploy", "Deploy", "Deploy with the release checklist."));
			await remember(
				memory,
				space.id,
				conceptInput(
					"projects/harbour/deploy",
					"Deploy harbour",
					"Harbour deploys from the main branch through Workers.",
					{
						scope: { kind: "project", project: "harbour" },
					},
				),
			);
			await remember(
				memory,
				space.id,
				conceptInput("projects/sal/deploy", "Deploy sal", "Sal deploys to the home server by hand.", {
					scope: { kind: "project", project: "sal" },
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
				profile: ["projects/harbour/deploy", "jobs/nightly/deploy"],
			});
			assert.deepEqual(recalledIds(plain), ["org/deploy"], "without scopes only global concepts, even in the profile");
			const project = await memory.recall(human, { spaceIds: [space.id], query, scopes: { projects: ["harbour"] } });
			assert.deepEqual(sorted(recalledIds(project)), ["org/deploy", "projects/harbour/deploy"]);
			const job = await memory.recall(human, { spaceIds: [space.id], query, scopes: { jobs: ["nightly"] } });
			assert.deepEqual(sorted(recalledIds(job)), ["jobs/nightly/deploy", "org/deploy"]);
		}),

		test("names each recalled concept's version and reason in the manifest and marks stale concepts", async (memory, deps) => {
			const space = await createSpace(memory);
			const staleAt = deps.clock.now() + 60_000;
			const fresh = await remember(
				memory,
				space.id,
				conceptInput("projects/harbour/owner", "Harbour owner", "Tom owns harbour releases."),
			);
			const ageing = await remember(
				memory,
				space.id,
				conceptInput("projects/harbour/release-train", "Release train", "Harbour releases ship every Tuesday.", {
					staleAfter: staleAt,
				}),
			);
			await applied(memory, space.id, {
				op: "correct",
				concept: conceptInput(ageing.id, "Release train", "Harbour releases ship every Wednesday.", {
					staleAfter: staleAt,
				}),
				expectedVersion: 1,
			});
			const request = { spaceIds: [space.id], query: "harbour releases", profile: [fresh.id] };
			const before = await memory.recall(human, request);
			assert.deepEqual(before.manifest, [
				{ spaceId: space.id, conceptId: fresh.id, version: 1, reason: "profile", stale: false },
				{
					spaceId: space.id,
					conceptId: ageing.id,
					version: 2,
					reason: "search",
					score: before.manifest[1]?.score,
					stale: false,
				},
			]);
			assert.strictEqual(before.manifest[0]?.score, undefined, "a profile entry has no score");
			assert.greaterThan(before.manifest[1]?.score ?? 0, 0);

			deps.clock.set(staleAt);
			const after = await memory.recall(human, request);
			assert.deepEqual(
				after.manifest.map((entry) => entry.stale),
				[false, true],
				"a concept is stale from its staleAfter time",
			);
			assert.deepEqual(recalledIds(after), [fresh.id, ageing.id], "stale concepts are still recalled");
		}),

		test("never recalls superseded or forgotten concepts, and a superseded one points to its replacement", async (memory) => {
			const space = await createSpace(memory);
			const old = await remember(
				memory,
				space.id,
				conceptInput("projects/harbour/runtime", "Harbour runtime", "Harbour runs sessions on Node."),
			);
			const gone = await remember(
				memory,
				space.id,
				conceptInput("projects/harbour/runtime-host", "Harbour runtime host", "Harbour sessions run on a VPS."),
			);
			await applied(memory, space.id, {
				op: "supersede",
				conceptId: old.id,
				expectedVersion: 1,
				replacement: conceptInput("projects/harbour/runtime-workers", "Harbour runtime", "Harbour runs on Workers."),
			});
			await applied(memory, space.id, { op: "forget", conceptId: gone.id, expectedVersion: 1, reason: "Wrong" });

			assert.partialDeepEqual(await memory.getConcept(human, space.id, old.id), {
				status: "superseded",
				supersededBy: "projects/harbour/runtime-workers",
				version: 2,
			});
			assert.partialDeepEqual(await memory.getConcept(human, space.id, gone.id), { status: "forgotten", version: 2 });
			const recall = await memory.recall(human, {
				spaceIds: [space.id],
				query: "harbour runtime sessions node vps",
				profile: [old.id, gone.id],
			});
			assert.deepEqual(recalledIds(recall), ["projects/harbour/runtime-workers"]);
			const active = await memory.listConcepts(human, space.id, { status: "active" });
			assert.deepEqual(
				active.items.map((concept) => concept.id),
				["projects/harbour/runtime-workers"],
			);
			const superseded = await memory.listConcepts(human, space.id, { status: "superseded" });
			assert.deepEqual(
				superseded.items.map((concept) => concept.id),
				[old.id],
			);
		}),

		test("refuses a concept without a source as invalid", async (memory) => {
			const space = await createSpace(memory);
			const existing = await remember(memory, space.id, conceptInput("projects/harbour/ci", "CI", "CI runs on push."));
			const unsourced = (id: string) => conceptInput(id, "Unsourced", "No one knows why.", { sources: [] });
			const writes: MemoryWrite[] = [
				{ op: "remember", concept: unsourced("projects/harbour/unsourced") },
				{ op: "correct", concept: unsourced(existing.id), expectedVersion: 1 },
				{
					op: "supersede",
					conceptId: existing.id,
					expectedVersion: 1,
					replacement: unsourced("projects/harbour/ci-2"),
				},
			];
			for (const write of writes) {
				await assert.rejectsWithCode(memory.propose(human, space.id, write), "invalid", `an unsourced ${write.op}`);
			}
			assert.strictEqual((await memory.listProposals(human, space.id)).items.length, 1, "only the first remember");
		}),

		test("refuses a malformed concept ID as invalid", async (memory) => {
			const space = await createSpace(memory);
			for (const id of ["Projects/Harbour", "projects//ci", "../etc/passwd", "projects/harbour/", "projects/ci note"]) {
				await assert.rejectsWithCode(
					memory.propose(human, space.id, { op: "remember", concept: conceptInput(id, "Bad", "Bad ID.") }),
					"invalid",
					`ID ${id}`,
				);
			}
		}),

		test("hides another organisation's spaces as not found for reads, recall, proposals and decisions", async (memory) => {
			const space = await createSpace(memory);
			const concept = await remember(memory, space.id, conceptInput("projects/harbour/ci", "CI", "CI runs on push."));
			const pending = await memory.propose(agent, space.id, {
				op: "remember",
				concept: conceptInput("projects/harbour/lint", "Lint", "Biome lints the code."),
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
					concept: conceptInput("projects/harbour/x", "X", "X."),
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
				conceptInput("projects/harbour/ci", "CI runner", "CI runs biome, tsc and vitest.", {
					description: "What CI checks",
					tags: ["ci"],
					scope: { kind: "project", project: "harbour" },
				}),
			);
			const old = await remember(
				memory,
				space.id,
				conceptInput("projects/harbour/host", "Host", "Harbour runs on a VPS."),
			);
			const gone = await remember(memory, space.id, conceptInput("personal/tea", "Tea", "The owner drinks tea."));
			await applied(memory, space.id, {
				op: "supersede",
				conceptId: old.id,
				expectedVersion: 1,
				replacement: conceptInput("projects/harbour/host-workers", "Host on Workers", "Harbour runs on Workers."),
			});
			await applied(memory, space.id, { op: "forget", conceptId: gone.id, expectedVersion: 1, reason: "Wrong" });

			const bundle = await memory.exportBundle(human, space.id);
			const paths = bundle.map((file) => file.path).sort();
			assert.deepEqual(paths, [
				"index.md",
				"personal/tea.md",
				"projects/harbour/ci.md",
				"projects/harbour/host-workers.md",
				"projects/harbour/host.md",
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
			assert.ok(/^supersededBy: "?projects\/harbour\/host-workers"?$/m.test(file(`${old.id}.md`)));
			assert.ok(/^status: "?forgotten"?$/m.test(file(`${gone.id}.md`)));

			const index = file("index.md");
			assert.ok(index.includes(`${kept.id}.md`), "the index lists an active concept");
			assert.ok(index.includes("projects/harbour/host-workers.md"), "the index lists the replacement");
			assert.ok(!index.includes(`${old.id}.md`), "the index leaves out a superseded concept");
			assert.ok(!index.includes(`${gone.id}.md`), "the index leaves out a forgotten concept");
		}),
	];
}

export function registerMemoryConformance(
	runner: ConformanceRunner,
	name: string,
	provider: MemoryConformanceProvider,
): void {
	registerCases(runner, name, createMemoryConformance({ assertions: createExpectAssertions(runner.expect), provider }));
}
