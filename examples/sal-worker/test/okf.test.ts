import { createMemoryMemory } from "@kantel/memory/memory";
import { describe, expect, it } from "vitest";
import { conceptIdOf, okfConcept, okfSnapshot, salExtension } from "../src/okf.ts";
import { conceptFile, source } from "./helpers.ts";

const generated = { by: "sal/0.1.0", at: "2026-10-22T14:29:56.280Z" };

describe("conceptIdOf", () => {
	it("reads Sal's concept IDs and leaves out index, log and deep paths", () => {
		expect(conceptIdOf("personal/timezone.md")).toBe("personal/timezone");
		expect(conceptIdOf("projects/sal/ipad-app.md")).toBe("projects/sal/ipad-app");
		expect(conceptIdOf("projects/index.md")).toBeNull();
		expect(conceptIdOf("projects/sal/log.md")).toBeNull();
		expect(conceptIdOf("a/b/c/d/e.md")).toBeNull();
		expect(conceptIdOf("Personal/Timezone.md")).toBeNull();
		expect(conceptIdOf("personal/timezone.txt")).toBeNull();
	});
});

describe("okfConcept", () => {
	it("maps a personal profile concept to a global, owner-set, active concept with Sal's fields kept", () => {
		const text = conceptFile(
			{
				title: "Give times in Tom's local time",
				tags: ["profile"],
				generated,
				sources: [source("slack:T1/D1/1"), source("/nowhere/notes.md")],
				sal: { learned_from: "owner", scope: "personal" },
				stale_after: "2027-01-01",
			},
			"Always give Tom times in his local time.",
		);
		const { concept, profile } = okfConcept("personal/timezone", text);
		expect(profile).toBe(true);
		expect(concept).toMatchObject({
			id: "personal/timezone",
			title: "Give times in Tom's local time",
			statement: "\nAlways give Tom times in his local time.\n",
			tags: ["profile"],
			scope: { kind: "global" },
			sources: ["slack:T1/D1/1", "/nowhere/notes.md"],
			setBy: "owner",
			status: "active",
			updatedAt: Date.parse(generated.at),
			staleAfter: Date.parse("2027-01-01"),
		});
		expect(salExtension(concept)).toMatchObject({
			type: "Fact",
			scope: "personal",
			learnedFrom: "owner",
			updated: generated.at,
			status: "stable",
			appliesTo: null,
			bytes: Buffer.byteLength(text),
		});
	});

	it("scopes project concepts, job exceptions and learned facts as Sal does", () => {
		const project = okfConcept(
			"projects/sal/ipad-app",
			conceptFile({ title: "iPad app", sources: [source("x")], sal: { learned_from: "task" } }, "Body"),
		).concept;
		expect(project).toMatchObject({ scope: { kind: "project", project: "sal" }, setBy: "learned" });
		expect(salExtension(project)?.scope).toBe("project");

		const exception = okfConcept(
			"projects/sal/sweep-exception",
			conceptFile(
				{
					title: "Sweep exception",
					sources: [source("x")],
					sal: { applies_to: "docket:TASK-12", overrides: "personal/bug-sweep-job" },
				},
				"Body",
			),
		).concept;
		expect(exception).toMatchObject({
			scope: { kind: "job", job: "docket:TASK-12" },
			overrides: "personal/bug-sweep-job",
		});
		expect(salExtension(exception)?.scope).toBe("exception");

		// An `overrides` without `applies_to` is not an exception; Kantel keeps overrides on job concepts only.
		const stray = okfConcept(
			"personal/stray",
			conceptFile({ title: "Stray", sources: [source("x")], sal: { overrides: "personal/other" } }, "Body"),
		).concept;
		expect(stray.overrides).toBeUndefined();
		expect(
			okfConcept("projects/one", conceptFile({ title: "One", sources: [source("x")] }, "B")).concept.scope,
		).toEqual({
			kind: "global",
		});
	});

	it("maps inactive concepts: deprecated and forgotten to forgotten, superseded with its replacement", () => {
		const status = (fields: Record<string, unknown>) =>
			okfConcept("personal/x", conceptFile({ title: "X", sources: [source("x")], ...fields }, "B")).concept;
		expect(status({ status: "deprecated" }).status).toBe("forgotten");
		expect(status({ status: "draft" }).status).toBe("active");
		expect(status({ sal: { forgotten: { at: "2026-10-01", reason: "wrong" } } }).status).toBe("forgotten");
		expect(status({ sal: { superseded_by: "personal/y" } })).toMatchObject({
			status: "superseded",
			supersededBy: "personal/y",
		});
		expect(status({ status: "deprecated", sal: { superseded_by: "personal/y" } }).status).toBe("superseded");
	});

	it("fills what Kantel requires and Sal does not, without changing what recall scores", () => {
		const { concept } = okfConcept("personal/bare", conceptFile({ tags: ["", "a-tag"] }, "Body"));
		expect(concept).toMatchObject({ title: "bare", sources: ["okf:personal/bare"], tags: ["a-tag"], updatedAt: 0 });
		expect(salExtension(concept)?.sources).toEqual([]);
		const many = okfConcept(
			"personal/many",
			conceptFile({ title: "M", sources: Array.from({ length: 12 }, (_, index) => source(`s${index}`)) }, "B"),
		).concept;
		expect(many.sources).toHaveLength(10);
	});

	it("refuses files Sal cannot read", () => {
		expect(() => okfConcept("personal/x", "no frontmatter")).toThrow("no YAML frontmatter");
		expect(() => okfConcept("personal/x", "---\ntitle: x\n---\nBody")).toThrow("non-empty type");
		expect(() => okfConcept("personal/x", "---\n- a\n---\nBody")).toThrow("mapping");
	});

	it("refuses, one concept at a time, what Sal reads but a Kantel snapshot cannot hold", () => {
		expect(() => okfConcept("personal/x", conceptFile({ title: "X" }, ""))).toThrow("needs a statement");
		expect(() => okfConcept("personal/x", conceptFile({ title: " " }, "Body"))).toThrow("needs a title");
		expect(() =>
			okfConcept("personal/x", conceptFile({ title: "X", sal: { applies_to: "TASK-1", overrides: "Not An ID" } }, "B")),
		).toThrow("sal.overrides");
		expect(() =>
			okfConcept("personal/x", conceptFile({ title: "X", sal: { superseded_by: "personal/x" } }, "B")),
		).toThrow("sal.superseded_by");
		expect(() => okfConcept("personal/x", conceptFile({ title: "X", sal: { applies_to: " " } }, "B"))).toThrow(
			"sal.applies_to",
		);
		// An empty source resource is kept for rendering, not as a Kantel source.
		const { concept } = okfConcept(
			"personal/x",
			conceptFile({ title: "X", sources: [source(""), source("slack:1")] }, "B"),
		);
		expect(concept.sources).toEqual(["slack:1"]);
		expect(salExtension(concept)?.sources).toEqual(["", "slack:1"]);
	});
});

describe("okfSnapshot", () => {
	it("imports a bundle in ID order, names the profile and projects, and reports what it refused", async () => {
		const bundle = okfSnapshot(
			[
				{ path: "projects/sal/b.md", text: conceptFile({ title: "B", sources: [source("x")] }, "B") },
				{ path: "personal/a.md", text: conceptFile({ title: "A", tags: ["profile"], sources: [source("x")] }, "A") },
				{ path: "index.md", text: "# Index" },
				{ path: "personal/Broken.md", text: "x" },
				{ path: "personal/broken.md", text: "no frontmatter" },
			],
			{ sourceId: "sal-memory", ref: "abc" },
		);
		expect(bundle.snapshot.concepts.map((concept) => concept.id)).toEqual(["personal/a", "projects/sal/b"]);
		expect(bundle.profile).toEqual(["personal/a"]);
		expect(bundle.projects).toEqual(["sal"]);
		expect(bundle.refused).toEqual([
			{ path: "personal/Broken.md", reason: "not a concept ID" },
			{ path: "personal/broken.md", reason: "concept has no YAML frontmatter block" },
		]);
		const memory = createMemoryMemory();
		const ctx = { actor: { kind: "service", serviceId: "sal" }, organisationId: "org" } as const;
		const space = await memory.createSpace(ctx, {
			owner: { kind: "organisation", organisationId: "org" },
			name: "Sal",
		});
		const imported = await memory.importSnapshot(ctx, space.id, bundle.snapshot);
		expect(imported.snapshot?.ref).toBe("abc");
	});

	it("imports the rest of a bundle when one concept cannot be held, and warns of timestamps Sal orders by text", async () => {
		const bundle = okfSnapshot(
			[
				{
					path: "personal/good.md",
					text: conceptFile({ title: "Good", generated: { at: "2026-10-12T09:35:38.357Z" } }, "G"),
				},
				{ path: "personal/empty.md", text: conceptFile({ title: "Empty" }, "") },
				{ path: "personal/nojob.md", text: conceptFile({ title: "No job", sal: { applies_to: "" } }, "N") },
				{
					path: "personal/nodate.md",
					text: conceptFile({ title: "No date", generated: { at: "2026-99-99T00:00:00.000Z" } }, "D"),
				},
				{
					path: "personal/offset.md",
					text: conceptFile({ title: "O", generated: { at: "2026-01-01T00:00:00+02:00" } }, "O"),
				},
				// A bad byte, read as Sal reads it: the concept still parses.
				{
					path: "personal/bytes.md",
					text: new TextDecoder().decode(
						new Uint8Array([...new TextEncoder().encode(conceptFile({ title: "Bytes" }, "B")), 0xff]),
					),
				},
			],
			{ sourceId: "sal-memory", ref: "abc" },
		);
		expect(bundle.snapshot.concepts.map((concept) => concept.id)).toEqual([
			"personal/bytes",
			"personal/good",
			"personal/nodate",
			"personal/offset",
		]);
		expect(bundle.refused.map((entry) => entry.path)).toEqual(["personal/empty.md", "personal/nojob.md"]);
		expect(bundle.warnings.map((entry) => entry.path)).toEqual(["personal/nodate.md", "personal/offset.md"]);
		const memory = createMemoryMemory();
		const ctx = { actor: { kind: "service", serviceId: "sal" }, organisationId: "org" } as const;
		const space = await memory.createSpace(ctx, {
			owner: { kind: "organisation", organisationId: "org" },
			name: "Sal",
		});
		await expect(memory.importSnapshot(ctx, space.id, bundle.snapshot)).resolves.toBeDefined();
	});
});
