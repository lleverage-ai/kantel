import type { Concept } from "@harbour/contracts";
import { isHarbourError } from "@harbour/contracts";
import { DEFAULT_SIMILARITY_THRESHOLD, renderConcept, similarity, tokenize, validateConceptId } from "@harbour/memory";
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

describe("similarity", () => {
	it("is the Jaccard index of the token sets", () => {
		expect(similarity("deploy on mornings", "Deploy mornings")).toBe(1);
		expect(similarity("deploy weekday mornings", "deploy weekday evenings")).toBeCloseTo(2 / 4);
		expect(similarity("alpha", "beta")).toBe(0);
		expect(similarity("", "")).toBe(0);
		expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.6);
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
