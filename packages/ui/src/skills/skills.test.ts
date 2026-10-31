import type { SkillListing, SkillPackage, SkillRevision } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import {
	BILLING_VISIBILITY,
	createSkillsScenario,
	directory,
	FIXTURE_NOW,
	ORGANISATION,
	ownerChoices,
	VIEWER,
} from "./fixtures.ts";
import {
	authoringError,
	draftFiles,
	draftProblems,
	extensionNames,
	filterSkills,
	groupSkills,
	type ListedSkill,
	loadListedSkills,
	shortDigest,
	skillTemplate,
	sortFiles,
	sourceText,
	splitSkillMarkdown,
} from "./skills-model.ts";

const skill = (name: string, owner: SkillPackage["owner"], description = `${name} does things`): ListedSkill => ({
	listing: {
		skillId: `skill_${name}`,
		name,
		description,
		revision: 1,
		path: `/skills/${name}/SKILL.md`,
	} as SkillListing,
	pkg: { id: `skill_${name}`, owner, name, description, createdAt: 0, updatedAt: 0 },
});

describe("grouping and filtering", () => {
	const org = { kind: "organisation", organisationId: "org" } as const;
	const skills = [
		skill("zeta", org),
		skill("web-screenshot", { kind: "platform" }),
		skill("alpha", org),
		skill("stripe-reconcile", { kind: "project", organisationId: "org", projectId: "prj_billing" }),
		skill("morning-brief", { kind: "user", organisationId: "org", userId: VIEWER }),
	];

	it("groups by owner, narrowest scope first, each by name", () => {
		const groups = groupSkills(skills, directory, VIEWER);
		expect(groups.map((group) => group.label)).toEqual(["Yours", "Billing project", "Organisation", "Built in"]);
		expect(groups[2]!.skills.map((item) => item.listing.name)).toEqual(["alpha", "zeta"]);
	});

	it("names another person's skills after them", () => {
		const groups = groupSkills(skills, directory, "usr_alex");
		expect(groups[0]!.label).toBe("Tom Davies");
	});

	it("filters by every word in the name or description", () => {
		expect(filterSkills(skills, "").length).toBe(5);
		expect(filterSkills(skills, "STRIPE").map((item) => item.listing.name)).toEqual(["stripe-reconcile"]);
		expect(filterSkills(skills, "does zeta").map((item) => item.listing.name)).toEqual(["zeta"]);
		expect(filterSkills(skills, "nothing")).toEqual([]);
	});
});

describe("writing a skill", () => {
	it("starts a new SKILL.md with the frontmatter Agent Skills need", () => {
		expect(skillTemplate("invoice-notes", "Write mismatches down.")).toBe(
			"---\nname: invoice-notes\ndescription: Write mismatches down.\n---\n\n# Invoice notes\n\n",
		);
		expect(skillTemplate("x", "Use for: reviews")).toContain('description: "Use for: reviews"');
	});

	it("checks the name, the description and that SKILL.md names the skill", () => {
		const skillMd = skillTemplate("good-name", "Does things");
		expect(draftProblems({ name: "good-name", description: "Does things", skillMd })).toEqual({});
		const bad = draftProblems({ name: "Bad Name", description: " ", skillMd });
		expect(Object.keys(bad).sort()).toEqual(["description", "name", "skillMd"]);
		expect(draftProblems({ name: "x", description: "y", skillMd: "# No frontmatter" }).skillMd).toMatch(/frontmatter/);
	});

	it("replaces SKILL.md and keeps the other files", () => {
		const files = draftFiles("new", [
			{ path: "SKILL.md", content: "old" },
			{ path: "scripts/run.sh", content: "echo" },
		]);
		expect(files).toEqual([
			{ path: "SKILL.md", content: "new" },
			{ path: "scripts/run.sh", content: "echo" },
		]);
	});
});

describe("SKILL.md", () => {
	it("splits the frontmatter into fields and keeps the body", () => {
		const split = splitSkillMarkdown(
			'---\nname: pr-review\ndescription: "Review a PR."\nlicense: MIT\n---\n\n# PR review\n\nRead the diff.\n',
		);
		expect(split.fields).toEqual([
			{ key: "name", value: "pr-review" },
			{ key: "description", value: "Review a PR." },
			{ key: "license", value: "MIT" },
		]);
		expect(split.body).toBe("# PR review\n\nRead the diff.\n");
	});

	it("joins a folded description", () => {
		const split = splitSkillMarkdown("---\nname: x\ndescription: >\n  First line\n  second line\n---\nBody\n");
		expect(split.fields[1]).toEqual({ key: "description", value: "First line second line" });
		expect(split.body).toBe("Body\n");
	});

	it("treats a file without frontmatter as all body", () => {
		expect(splitSkillMarkdown("# Title\n")).toEqual({ fields: [], body: "# Title\n" });
	});

	it("puts SKILL.md first, then files by path", () => {
		expect(sortFiles([{ path: "scripts/a.sh" }, { path: "SKILL.md" }, { path: "references/b.md" }])).toEqual([
			{ path: "SKILL.md" },
			{ path: "references/b.md" },
			{ path: "scripts/a.sh" },
		]);
	});

	it("shortens digests, commit refs and names extensions", () => {
		expect(shortDigest("abcdef0123456789abcdef")).toBe("abcdef012345");
		expect(sourceText({ sourceId: "sal-skills", ref: "c0ffee1234567890abcdef1234567890abcdef12" })).toBe(
			"sal-skills at c0ffee1",
		);
		expect(sourceText({ sourceId: "builder", ref: "v3" })).toBe("builder at v3");
		expect(sourceText(undefined)).toBeUndefined();
		expect(extensionNames({ extensions: { sal: 1, lleverage: 2 } } as unknown as SkillRevision)).toEqual([
			"lleverage",
			"sal",
		]);
	});
});

describe("the fixture over the in-memory store", () => {
	it("lists what a Billing session sees, with each package", async () => {
		const scenario = await createSkillsScenario();
		const listed = await loadListedSkills(scenario.source, BILLING_VISIBILITY);
		const groups = groupSkills(listed, directory, VIEWER);
		expect(groups.map((group) => [group.label, group.skills.map((item) => item.listing.name)])).toEqual([
			["Yours", ["morning-brief"]],
			["Billing project", ["stripe-reconcile"]],
			["Organisation", ["pr-review", "writing-for-humans"]],
			["Built in", ["file-upload", "web-screenshot"]],
		]);
		const review = listed.find((item) => item.listing.name === "pr-review")!;
		expect(review.listing.revision).toBe(3);
		expect(review.pkg.source?.sourceId).toBe("sal-skills");
		expect(listed.find((item) => item.listing.name === "morning-brief")!.pkg.draftDigest).toBeDefined();
	});

	it("shows Platform's own pr-review in place of the organisation's", async () => {
		const scenario = await createSkillsScenario();
		const listed = await loadListedSkills(scenario.source, { projectId: "prj_platform", userId: VIEWER });
		const review = listed.find((item) => item.listing.name === "pr-review")!;
		expect(review.pkg.owner.kind).toBe("project");
		expect(review.listing.skillId).toBe(scenario.ids["pr-review-platform"]);
	});

	it("reads a revision's files", async () => {
		const scenario = await createSkillsScenario();
		const id = scenario.ids["pr-review"]!;
		const revisions = (await scenario.source.listRevisions(id)).items;
		expect(revisions.map((revision) => revision.revision)).toEqual([3, 2, 1]);
		expect(sortFiles(revisions[0]!.files).map((file) => file.path)).toEqual([
			"SKILL.md",
			"references/checklist.md",
			"scripts/run-tests.sh",
		]);
		const text = await scenario.source.readFile(id, 3, "SKILL.md");
		expect(splitSkillMarkdown(text).body.startsWith("# PR review")).toBe(true);
		expect(revisions[0]!.publishedAt).toBeLessThan(FIXTURE_NOW);
	});

	it("publishes a new skill that the next session pins, while a running session keeps its pins", async () => {
		const scenario = await createSkillsScenario();
		const ctx = { actor: { kind: "service", serviceId: "orchestrator" }, organisationId: ORGANISATION } as const;
		const before = await scenario.store.pinForSession(ctx, "ses_running", BILLING_VISIBILITY);
		const pkg = await scenario.author.create({
			owner: ownerChoices[1]!.owner,
			name: "invoice-notes",
			description: "Write invoice mismatches to notes/reconcile.",
		});
		const skillMd = skillTemplate("invoice-notes", "Write invoice mismatches to notes/reconcile.");
		expect(draftProblems({ name: "invoice-notes", description: "x", skillMd })).toEqual({});
		const { digest } = await scenario.author.saveDraft(pkg.id, { files: draftFiles(skillMd, []) });
		const revision = await scenario.author.publish(pkg.id, { expectedDigest: digest });
		expect(revision.revision).toBe(1);
		const next = await scenario.store.pinForSession(ctx, "ses_next", BILLING_VISIBILITY);
		expect(next.map((pin) => pin.skillId)).toContain(pkg.id);
		const again = await scenario.store.pinForSession(ctx, "ses_running", BILLING_VISIBILITY);
		expect(again).toEqual(before);
		const listed = await loadListedSkills(scenario.source, BILLING_VISIBILITY);
		expect(listed.map((item) => item.listing.name)).toContain("invoice-notes");
	});

	it("publishes an edit as the next revision, keeping the other files", async () => {
		const scenario = await createSkillsScenario();
		const id = scenario.ids["pr-review"]!;
		const latest = (await scenario.source.listRevisions(id)).items.find((item) => item.revision === 3)!;
		const others = await Promise.all(
			latest.files
				.filter((file) => file.path !== "SKILL.md")
				.map(async (file) => ({ path: file.path, content: await scenario.source.readFile(id, 3, file.path) })),
		);
		const text = `${await scenario.source.readFile(id, 3, "SKILL.md")}\nAlso check the changelog.\n`;
		const { digest } = await scenario.author.saveDraft(id, { files: draftFiles(text, others) });
		const revision = await scenario.author.publish(id, { expectedDigest: digest });
		expect(revision.revision).toBe(4);
		expect(revision.files.map((file) => file.path).sort()).toEqual(latest.files.map((file) => file.path).sort());
	});

	it("says a duplicate name is taken", async () => {
		const scenario = await createSkillsScenario();
		const error = await scenario.author
			.create({ owner: ownerChoices[2]!.owner, name: "pr-review", description: "Again" })
			.catch((caught: unknown) => caught);
		expect(authoringError(error, "create")).toMatch(/already has a skill with this name/);
		expect(authoringError(new Error("network"), "publish")).toMatch(/The draft is saved/);
	});

	it("can start empty", async () => {
		const scenario = await createSkillsScenario({ empty: true });
		expect(await loadListedSkills(scenario.source, BILLING_VISIBILITY)).toEqual([]);
	});
});
