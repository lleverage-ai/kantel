import type { Concept } from "@harbour/contracts";
import { SAL_RECALL_PREAMBLE, salLocalPath, salRecallRenderer } from "@harbour/memory";
import { describe, expect, it } from "vitest";

const concept = (fields: Partial<Concept>): Concept => ({
	spaceId: "space-1",
	id: "projects/harbour/import",
	title: "Import",
	statement: "Import at pinned refs.",
	tags: [],
	scope: { kind: "project", project: "harbour" },
	sources: ["tvdavies/harbour#12"],
	setBy: "learned",
	version: 2,
	status: "active",
	updatedAt: 1,
	...fields,
});

describe("salRecallRenderer", () => {
	it("renders Sal's block from the sal extension, counting local sources the host lacks as missing", () => {
		const renderer = salRecallRenderer();
		expect(renderer.open).toBe(`<memory_recall>\n${SAL_RECALL_PREAMBLE}`);
		expect(renderer.close).toBe("</memory_recall>");
		const sal = {
			scope: "project",
			learnedFrom: "session",
			updated: "2026-10-16T09:00:00.000Z",
			appliesTo: null,
			sources: ["claude-code:session/1", "/home/tvd/notes.md", "file:///home/tvd/log.txt", "https://x.test/a"],
		};
		expect(renderer.concept(concept({ extensions: { sal } }), { reason: "search", stale: false })).toEqual({
			text: '<memory_concept id="projects/harbour/import" recalled="match" scope="project" learned_from="session" updated="2026-10-16" source="claude-code:session/1" missing_sources="2">\n# Import\nImport at pinned refs.\n</memory_concept>',
			truncated: false,
		});
		// A host with the files says so.
		const local = salRecallRenderer({ exists: (path) => path === "/home/tvd/notes.md" });
		expect(local.concept(concept({ extensions: { sal } }), { reason: "search", stale: false }).text).toContain(
			'missing_sources="1"',
		);
	});

	it("falls back to Harbour's fields for a concept with no sal extension", () => {
		const renderer = salRecallRenderer();
		const exception = renderer.concept(
			concept({ scope: { kind: "job", job: "docket:TASK-1" }, overrides: "projects/harbour/general", setBy: "owner" }),
			{ reason: "exception", stale: true },
		);
		expect(exception.text).toBe(
			'<memory_concept id="projects/harbour/import" recalled="exception" scope="exception" learned_from="owner" applies_to="docket:TASK-1" overrides="projects/harbour/general" stale="true" source="tvdavies/harbour#12">\n# Import\nImport at pinned refs.\n</memory_concept>',
		);
		const profile = renderer.concept(concept({ statement: "é".repeat(700) }), { reason: "profile", stale: false });
		expect(profile.truncated).toBe(true);
		expect(profile.text).toBe(
			`<memory_concept id="projects/harbour/import" recalled="profile" learned_from="task">\n# Import\n${"é".repeat(600)}\n…(truncated; memory_read has the rest)\n</memory_concept>`,
		);
		expect(renderer.omitted(["a/b"])).toBe(
			"<profile_omitted>Left out of the owner's profile this turn only for size, not because they are unknown: a/b. Read any that matter with memory_read.</profile_omitted>",
		);
	});
});

describe("salLocalPath", () => {
	it("reads absolute paths and file URLs as Node's fileURLToPath does on POSIX", () => {
		expect(salLocalPath("/home/tvd/a b.md")).toBe("/home/tvd/a b.md");
		expect(salLocalPath("file:///home/tvd/a%20b.md")).toBe("/home/tvd/a b.md");
		expect(salLocalPath("file://localhost/etc/hosts")).toBe("/etc/hosts");
		expect(salLocalPath("file://server/share/x")).toBeNull();
		expect(salLocalPath("file:///a%2Fb")).toBeNull();
		expect(salLocalPath("relative/path.md")).toBeNull();
		expect(salLocalPath("slack:T1/C1")).toBeNull();
	});
});
