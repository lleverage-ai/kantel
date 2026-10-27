import type { Concept } from "@harbour/contracts";
import { isHarbourError } from "@harbour/contracts";
import {
	bm25,
	conceptBytes,
	conceptTokens,
	createBm25Index,
	DEFAULT_SIMILARITY_THRESHOLD,
	renderConcept,
	similarity,
	tokenize,
	validateConceptId,
} from "@harbour/memory";
import { describe, expect, it } from "vitest";

const concept: Concept = {
	spaceId: "space-1",
	id: "projects/harbour/vault-binding-codes",
	title: "Vault binding codes",
	description: "How approvals bind",
	statement: "Every vault write needs the matching binding code.",
	tags: ["vault", "approvals"],
	scope: { kind: "project", project: "harbour" },
	sources: ["tvdavies/harbour@9b66e3b:packages/contracts/src/vault.ts:1-20"],
	setBy: "owner",
	version: 3,
	status: "superseded",
	supersededBy: "projects/harbour/vault-codes",
	updatedAt: Date.UTC(2026, 9, 27),
	staleAfter: Date.UTC(2027, 0, 1),
};

describe("tokenize", () => {
	it("lower-cases words of letters and digits and drops stopwords", () => {
		expect(tokenize("The Vault's binding-codes, in 2026: café!")).toEqual([
			"vault",
			"s",
			"binding",
			"codes",
			"2026",
			"café",
		]);
		expect(tokenize("  ")).toEqual([]);
	});
});

describe("bm25", () => {
	const doc = (key: string, title: string, statement: string) => ({
		key,
		tokens: conceptTokens({ title, statement, tags: [] }),
	});

	it("ranks documents by relevance and leaves out those that do not match", () => {
		const index = createBm25Index([
			doc("deploy", "Deploy windows", "Deploy on weekday mornings."),
			doc("review", "Review timing", "Review pull requests after lunch."),
			doc("release", "Release checklist", "Write the deploy note before the release."),
		]);
		const results = bm25(index, "when do we deploy");
		expect(results.map((result) => result.key)).toEqual(["deploy", "release"]);
		expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
		expect(bm25(index, "the and of")).toEqual([]);
		expect(bm25(createBm25Index([]), "deploy")).toEqual([]);
	});

	it("counts the title twice", () => {
		expect(
			conceptTokens({ title: "Rollback", description: "Plan", tags: ["Ops"], statement: "Keep it short" }),
		).toEqual(["rollback", "rollback", "plan", "ops", "keep", "short"]);
		// Equal length documents: the term in the title outranks the same term once in the statement.
		const index = createBm25Index([
			doc("statement", "Release notes", "rollback alpha beta gamma"),
			doc("title", "Rollback notes", "release alpha beta gamma"),
		]);
		expect(bm25(index, "rollback")[0]!.key).toBe("title");
	});

	it("uses k1 1.2 and b 0.75", () => {
		const index = createBm25Index([
			{ key: "a", tokens: ["x", "x", "y"] },
			{ key: "b", tokens: ["y"] },
		]);
		const idf = Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5));
		const norm = 1 - 0.75 + 0.75 * (3 / 2);
		expect(bm25(index, "x")[0]!.score).toBeCloseTo((idf * (2 * 2.2)) / (2 + 1.2 * norm), 10);
	});
});

describe("similarity", () => {
	it("is the Jaccard index of the token sets", () => {
		expect(similarity("deploy on mornings", "Deploy mornings")).toBe(1);
		expect(similarity("deploy weekday mornings", "deploy weekday evenings")).toBeCloseTo(2 / 4);
		expect(similarity("alpha", "beta")).toBe(0);
		expect(similarity("", "")).toBe(0);
		expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.6);
	});
});

describe("conceptBytes", () => {
	it("counts UTF-8 bytes of the title and statement", () => {
		expect(conceptBytes({ title: "Café", statement: "ok" })).toBe(7);
	});
});

describe("validateConceptId", () => {
	it("accepts slash-separated lower-case segments", () => {
		expect(() => validateConceptId("projects/harbour/vault-binding-codes")).not.toThrow();
		expect(() => validateConceptId("personal/pr-review-timing")).not.toThrow();
	});

	it("rejects anything else as invalid", () => {
		for (const id of ["single", "Projects/x", "a//b", "a/b/", "/a/b", "../a/b", "a/-b", "a/b c", "a/b.md", ""]) {
			let caught: unknown;
			try {
				validateConceptId(id);
			} catch (error) {
				caught = error;
			}
			expect(isHarbourError(caught, "invalid"), id).toBe(true);
		}
	});
});

describe("renderConcept", () => {
	it("writes YAML frontmatter and then the statement", () => {
		expect(renderConcept(concept)).toBe(
			[
				"---",
				'id: "projects/harbour/vault-binding-codes"',
				'title: "Vault binding codes"',
				'description: "How approvals bind"',
				'tags: ["vault", "approvals"]',
				"scope:",
				"  kind: project",
				'  project: "harbour"',
				'sources: ["tvdavies/harbour@9b66e3b:packages/contracts/src/vault.ts:1-20"]',
				"setBy: owner",
				"version: 3",
				"status: superseded",
				'supersededBy: "projects/harbour/vault-codes"',
				'staleAfter: "2027-01-01T00:00:00.000Z"',
				"---",
				"",
				"Every vault write needs the matching binding code.",
				"",
			].join("\n"),
		);
	});

	it("leaves out absent optional fields and quotes awkward text", () => {
		const { description: _description, supersededBy: _supersededBy, staleAfter: _staleAfter, ...rest } = concept;
		const rendered = renderConcept({ ...rest, title: 'Say "hi": now', scope: { kind: "global" }, status: "active" });
		expect(rendered).toContain('title: "Say \\"hi\\": now"');
		expect(rendered).toContain("scope:\n  kind: global\n");
		expect(rendered).not.toMatch(/^(description|supersededBy|staleAfter):/m);
	});
});
