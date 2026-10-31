import type { Concept, MemoryProposal } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryScenario, FIXTURE_NOW, SAMPLE_QUERY } from "./fixtures.ts";
import {
	applyAsPerson,
	changeError,
	conceptHistory,
	correctionProblems,
	correctionWrite,
	forgetWrite,
	groupConcepts,
	isStale,
	manifestDetail,
	readAll,
	recallScopes,
	scopeText,
	sortProposals,
	sourceHref,
	writeConcept,
	writeSentence,
	writeTarget,
} from "./memory-model.ts";
import { decisionError } from "./memory-proposals.tsx";

const concept = (id: string, scope: Concept["scope"], extra: Partial<Concept> = {}): Concept => ({
	id,
	spaceId: "space",
	title: id,
	statement: `${id} is true`,
	tags: [],
	scope,
	sources: ["TASK-1"],
	setBy: "learned",
	version: 1,
	status: "active",
	updatedAt: 0,
	...extra,
});

describe("concepts", () => {
	it("groups everywhere first, then projects, then jobs, each by ID", () => {
		const groups = groupConcepts(
			[
				concept("projects/b/two", { kind: "project", project: "prj_billing" }),
				concept("personal/z", { kind: "global" }),
				concept("projects/b/one", { kind: "project", project: "prj_billing" }),
				concept("projects/x/exception", { kind: "job", job: "TASK-9" }),
				concept("personal/a", { kind: "global" }),
			],
			(project) => (project === "prj_billing" ? "Billing" : undefined),
		);
		expect(groups.map((group) => group.label)).toEqual(["Everywhere", "Project Billing", "Job TASK-9"]);
		expect(groups[0]!.concepts.map((item) => item.id)).toEqual(["personal/a", "personal/z"]);
		expect(groups[1]!.concepts.map((item) => item.id)).toEqual(["projects/b/one", "projects/b/two"]);
	});

	it("names a project by its ID when the directory doesn't know it", () => {
		expect(scopeText({ kind: "project", project: "prj_unknown" })).toBe("Project prj_unknown");
	});

	it("is stale once its date for checking has passed", () => {
		const dated = concept("a/b", { kind: "global" }, { staleAfter: 100 });
		expect(isStale(dated, 99)).toBe(false);
		expect(isStale(dated, 100)).toBe(true);
		expect(isStale(concept("a/c", { kind: "global" }), 1e15)).toBe(false);
	});

	it("links only web sources", () => {
		expect(sourceHref("https://github.com/tvdavies/harbour/pull/1")).toBe("https://github.com/tvdavies/harbour/pull/1");
		expect(sourceHref("TASK-12")).toBeUndefined();
		expect(sourceHref("tvdavies/harbour@abc:README.md")).toBeUndefined();
	});
});

describe("writes", () => {
	const input = {
		id: "a/new",
		title: "New",
		statement: "It is new",
		scope: { kind: "global" },
		sources: ["x"],
	} as const;

	it("says what each write would do", () => {
		expect(writeSentence({ op: "remember", concept: input })).toBe("remember a/new");
		expect(writeSentence({ op: "correct", concept: input, expectedVersion: 3 })).toBe("correct a/new (version 3)");
		expect(writeSentence({ op: "supersede", conceptId: "a/old", replacement: input, expectedVersion: 1 })).toBe(
			"replace a/old with a/new",
		);
		expect(writeSentence({ op: "forget", conceptId: "a/old", expectedVersion: 1, reason: "wrong" })).toBe(
			"forget a/old",
		);
	});

	it("names the concept each write changes, and the text it carries", () => {
		expect(writeTarget({ op: "supersede", conceptId: "a/old", replacement: input, expectedVersion: 1 })).toBe("a/old");
		expect(writeConcept({ op: "supersede", conceptId: "a/old", replacement: input, expectedVersion: 1 })).toBe(input);
		expect(writeConcept({ op: "forget", conceptId: "a/old", expectedVersion: 1, reason: "wrong" })).toBeUndefined();
	});

	it("reads recall scopes from the page's fields", () => {
		expect(recallScopes("", " ")).toBeUndefined();
		expect(recallScopes("prj_billing, prj_platform", "")).toEqual({ projects: ["prj_billing", "prj_platform"] });
		expect(recallScopes("", "TASK-1 TASK-2")).toEqual({ jobs: ["TASK-1", "TASK-2"] });
	});

	it("explains a manifest entry beyond its reason", () => {
		const entry = { spaceId: "s", conceptId: "a/b", version: 1, stale: false, truncated: false } as const;
		expect(manifestDetail({ ...entry, reason: "search", score: 7.44, matched: ["vault", "code"] })).toBe(
			"Score 7.4, matched vault, code",
		);
		expect(manifestDetail({ ...entry, reason: "profile", truncated: true })).toBe("cut short");
		expect(manifestDetail({ ...entry, reason: "profile" })).toBeUndefined();
	});
});

describe("the fixture space", () => {
	it("lists the active concepts the store kept, with the forgotten and replaced ones apart", async () => {
		const { source, space } = await createMemoryScenario();
		const active = await readAll<Concept>((page) => source.listConcepts(space.id, { status: "active" }, page));
		expect(active.map((item) => item.id)).toContain("projects/harbour/merge-when-green");
		expect(active.map((item) => item.id)).not.toContain("projects/harbour/sandbox-on-fly");
		const superseded = await source.listConcepts(space.id, { status: "superseded" });
		expect(superseded.items.map((item) => [item.id, item.supersededBy])).toEqual([
			["projects/harbour/merge-after-review", "projects/harbour/merge-when-green"],
		]);
		const forgotten = await source.listConcepts(space.id, { status: "forgotten" });
		expect(forgotten.items.map((item) => item.id)).toEqual(["projects/harbour/sandbox-on-fly"]);
		const stale = active.filter((item) => isStale(item, FIXTURE_NOW)).map((item) => item.id);
		expect(stale).toEqual(["projects/harbour/staging-jobs-retry"]);
	});

	it("reads a concept's history from the proposals that changed it, newest first", async () => {
		const { source, space } = await createMemoryScenario();
		const proposals = await readAll<MemoryProposal>((page) => source.listProposals(space.id, undefined, page));
		const history = conceptHistory(proposals, "projects/harbour/vault-binding-codes");
		expect(history.map((proposal) => proposal.write.op)).toEqual(["correct", "remember"]);
		const replaced = conceptHistory(proposals, "projects/harbour/merge-when-green");
		expect(replaced.map((proposal) => proposal.write.op)).toEqual(["supersede"]);
		// A pending correction isn't history yet.
		expect(conceptHistory(proposals, "projects/harbour/release-notes-folder")).toHaveLength(1);
	});

	it("waits on three proposals, oldest first, one nearly repeating a concept", async () => {
		const { source, space, pending } = await createMemoryScenario();
		const proposals = await readAll<MemoryProposal>((page) => source.listProposals(space.id, undefined, page));
		const sorted = sortProposals(proposals);
		expect(sorted.pending.map((proposal) => proposal.id)).toEqual(pending);
		expect(sorted.pending.find((proposal) => proposal.duplicateOf !== undefined)?.duplicateOf).toBe(
			"projects/harbour/vault-binding-codes",
		);
		expect(sorted.decided[0]!.status).toBe("rejected");
	});

	it("approving a proposal makes the concept; rejecting one leaves the space as it was", async () => {
		const { source, space, pending } = await createMemoryScenario();
		const [invoices, , notes] = pending;
		await source.decide(invoices!, { outcome: "apply" });
		const made = await source.getConcept(space.id, "projects/billing/invoice-mismatch-notes");
		expect(made.version).toBe(1);
		await source.decide(notes!, { outcome: "reject" });
		const unchanged = await source.getConcept(space.id, "projects/harbour/release-notes-folder");
		expect(unchanged.version).toBe(1);
		const left = await source.listProposals(space.id, { status: "pending" });
		expect(left.items).toHaveLength(1);
	});

	it("lets a person correct a learned concept: proposed and applied at once, theirs after, in its history", async () => {
		const { source, space } = await createMemoryScenario();
		const before = await source.getConcept(space.id, "projects/harbour/staging-jobs-retry");
		const draft = {
			title: before.title,
			statement: "Retry stuck staging jobs from the admin console.",
			sources: "TASK-1\n\n",
		};
		expect(correctionProblems(draft)).toEqual({});
		const write = correctionWrite(before, draft, FIXTURE_NOW);
		// Its date for checking had passed: correcting it is the check, so the date goes.
		expect(write.op === "correct" ? write.concept.staleAfter : "not a correction").toBeUndefined();
		const result = await applyAsPerson(source, space.id, write);
		expect(result.applied).toBe(true);
		const after = await source.getConcept(space.id, before.id);
		expect([after.version, after.setBy, after.sources, isStale(after, FIXTURE_NOW)]).toEqual([
			2,
			"owner",
			["TASK-1"],
			false,
		]);
		const proposals = await readAll<MemoryProposal>((page) => source.listProposals(space.id, undefined, page));
		expect(conceptHistory(proposals, before.id).map((proposal) => proposal.write.op)).toEqual(["correct", "remember"]);
	});

	it("lets a person forget a concept, with the reason", async () => {
		const { source, space } = await createMemoryScenario();
		const concept = await source.getConcept(space.id, "projects/billing/stripe-test-mode");
		const result = await applyAsPerson(source, space.id, forgetWrite(concept, " Moved to the vault. "));
		expect(result.applied).toBe(true);
		expect((await source.getConcept(space.id, concept.id)).status).toBe("forgotten");
	});

	it("refuses a correction at an old version, and leaves the proposal pending", async () => {
		const { source, space } = await createMemoryScenario();
		const concept = await source.getConcept(space.id, "projects/billing/stripe-test-mode");
		const draft = { title: "x", statement: "y", sources: "TASK-1" };
		await applyAsPerson(source, space.id, correctionWrite(concept, draft, FIXTURE_NOW));
		const stale = await applyAsPerson(source, space.id, correctionWrite(concept, draft, FIXTURE_NOW)).catch(
			(error: unknown) => ({ applied: false, error, proposal: undefined }),
		);
		expect(stale.applied).toBe(false);
		expect(changeError(stale.error, stale.proposal === undefined ? "propose" : "apply")).toMatch(
			/changed since you opened it/,
		);
		expect(correctionProblems({ title: " ", statement: "", sources: "\n" })).toEqual({
			title: "Give it a title.",
			statement: "Say the fact itself.",
			sources: "Name at least one source: a link, a commit or a ticket.",
		});
	});

	it("refuses to approve a near repeat, and says which concept it repeats", async () => {
		const { source, pending } = await createMemoryScenario();
		const error = await source.decide(pending[1]!, { outcome: "apply" }).catch((caught: unknown) => caught);
		expect(decisionError(error, "apply")).toBe(
			"Refused: it nearly repeats projects/harbour/vault-binding-codes. Reject it, or correct that concept instead.",
		);
		expect(decisionError(new Error("offline"), "reject")).toMatch(/Couldn't reject it/);
	});

	it("recalls the profile and the matches for a message, saying why each came", async () => {
		const { source, space, profile } = await createMemoryScenario();
		const recall = await source.recall({
			spaceIds: [space.id],
			query: SAMPLE_QUERY,
			profile,
			scopes: { projects: ["prj_platform"] },
		});
		const reasons = new Map(recall.manifest.map((entry) => [entry.conceptId, entry.reason]));
		expect(reasons.get("personal/plain-sentence-case")).toBe("profile");
		expect(reasons.get("projects/harbour/vault-binding-codes")).toBe("search");
		expect(recall.text).toContain("vault approval");
	});

	it("brings a job's exception along with the rule it overrides", async () => {
		const { source, space } = await createMemoryScenario();
		const recall = await source.recall({
			spaceIds: [space.id],
			query: "merge the pull request once checks are green",
			scopes: { projects: ["prj_platform"], jobs: ["TASK-3700"] },
		});
		const exception = recall.manifest.find((entry) => entry.conceptId === "projects/harbour/release-freeze-exception");
		expect(exception?.reason).toBe("exception");
	});
});
