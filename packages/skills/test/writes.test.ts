import { type CallContext, isKantelError, type SkillFile, type SkillSource } from "@kantel/contracts";
import { createMemorySkills } from "@kantel/skills/memory";
import { withSourcePublishing } from "@kantel/skills/publish";
import {
	createOperation,
	exportRevisionOperation,
	importRevisionOperation,
	parseOwner,
	publishOperation,
	runSkillsWrite,
	type SkillValidation,
	saveDraftOperation,
	skillsWriteOperations,
	validateOperation,
} from "@kantel/skills/writes";
import { describe, expect, it } from "vitest";

const human: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-a" };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: "org-a",
};
const owner = { kind: "organisation", organisationId: "org-a" } as const;

function codeOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return isKantelError(error) ? error.code : String(error);
	}
	return undefined;
}

async function rejectedCode(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return isKantelError(error) ? error.code : String(error);
	}
	return undefined;
}

function skillMd(name: string, description: string): SkillFile {
	return { path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n` };
}

describe("skills write parsers", () => {
	it("take exactly the documented input", () => {
		expect(createOperation.parse({ owner, name: "deploy", description: "Deploy" })).toEqual({
			owner,
			name: "deploy",
			description: "Deploy",
		});
		expect(saveDraftOperation.parse({ skillId: "s", files: [skillMd("deploy", "Deploy")] })).toEqual({
			skillId: "s",
			files: [skillMd("deploy", "Deploy")],
		});
		expect(
			publishOperation.parse({ skillId: "s", expectedDigest: "d", extensions: { "atlas.trigger": { on: "tag" } } }),
		).toEqual({ skillId: "s", expectedDigest: "d", extensions: { "atlas.trigger": { on: "tag" } } });
		expect(exportRevisionOperation.parse({ skillId: "s", revision: 2 })).toEqual({ skillId: "s", revision: 2 });
		expect(
			importRevisionOperation.parse({
				owner: { kind: "platform" },
				name: "builtin",
				description: "Built in",
				files: [{ path: "SKILL.md", content: "" }],
				source: { sourceId: "git", ref: "abc" },
			}),
		).toMatchObject({ owner: { kind: "platform" }, source: { sourceId: "git", ref: "abc" } });
	});

	it("refuse unknown and missing fields as invalid", () => {
		const bad: [string, (input: unknown) => unknown, unknown][] = [
			["create, unknown field", createOperation.parse, { owner, name: "deploy", description: "D", extra: 1 }],
			["create, no description", createOperation.parse, { owner, name: "deploy" }],
			["create, empty name", createOperation.parse, { owner, name: " ", description: "D" }],
			["saveDraft, no files", saveDraftOperation.parse, { skillId: "s" }],
			["saveDraft, unknown field", saveDraftOperation.parse, { skillId: "s", files: [], owner }],
			["saveDraft, files not a list", saveDraftOperation.parse, { skillId: "s", files: { "SKILL.md": "x" } }],
			["saveDraft, file without content", saveDraftOperation.parse, { skillId: "s", files: [{ path: "SKILL.md" }] }],
			[
				"saveDraft, file with an unknown field",
				saveDraftOperation.parse,
				{ skillId: "s", files: [{ path: "SKILL.md", content: "", mode: 755 }] },
			],
			["saveDraft, content not text", saveDraftOperation.parse, { skillId: "s", files: [{ path: "a", content: 1 }] }],
			["validate, unknown field", validateOperation.parse, { skillId: "s", files: [] }],
			["validate, no skill", validateOperation.parse, {}],
			["publish, no digest", publishOperation.parse, { skillId: "s" }],
			[
				"publish, extensions not an object",
				publishOperation.parse,
				{ skillId: "s", expectedDigest: "d", extensions: [] },
			],
			[
				"importRevision, no source",
				importRevisionOperation.parse,
				{ owner, name: "deploy", description: "D", files: [] },
			],
			[
				"importRevision, source with an unknown field",
				importRevisionOperation.parse,
				{ owner, name: "deploy", description: "D", files: [], source: { sourceId: "git", ref: "a", branch: "main" } },
			],
			["exportRevision, revision not a positive integer", exportRevisionOperation.parse, { skillId: "s", revision: 0 }],
			["exportRevision, revision not a number", exportRevisionOperation.parse, { skillId: "s", revision: "1" }],
			["not an object", createOperation.parse, "deploy"],
			["null", publishOperation.parse, null],
		];
		for (const [label, parse, input] of bad)
			expect(
				codeOf(() => parse(input)),
				label,
			).toBe("invalid");
	});

	it("read owners of every kind, each with only its own fields", () => {
		expect(parseOwner({ kind: "platform" })).toEqual({ kind: "platform" });
		expect(parseOwner({ kind: "project", organisationId: "org-a", projectId: "p" })).toEqual({
			kind: "project",
			organisationId: "org-a",
			projectId: "p",
		});
		expect(parseOwner({ kind: "user", organisationId: "org-a", userId: "u" })).toEqual({
			kind: "user",
			organisationId: "org-a",
			userId: "u",
		});
		for (const input of [
			{ kind: "platform", organisationId: "org-a" },
			{ kind: "organisation" },
			{ kind: "organisation", organisationId: "org-a", projectId: "p" },
			{ kind: "project", organisationId: "org-a" },
			{ kind: "user", organisationId: "org-a", projectId: "p" },
			{ kind: "team", organisationId: "org-a" },
			{ organisationId: "org-a" },
			{ kind: "organisation", organisationId: "org-a", extra: true },
		]) {
			expect(
				codeOf(() => parseOwner(input)),
				JSON.stringify(input),
			).toBe("invalid");
		}
	});
});

describe("runSkillsWrite", () => {
	it("runs each operation on the store as the caller", async () => {
		const sources: SkillSource = {
			id: "atlas-git",
			fetch: async () => [],
			publish: async () => ({ ref: "commit-1" }),
		};
		const skills = withSourcePublishing({ skills: createMemorySkills(), sourceFor: () => sources });
		const pkg = (await runSkillsWrite(skills, human, "skills.create", {
			owner,
			name: "deploy",
			description: "Deploy",
		})) as { id: string };
		const saved = (await runSkillsWrite(skills, agent, "skills.saveDraft", {
			skillId: pkg.id,
			files: [skillMd("deploy", "Ship it")],
		})) as { digest: string };
		const validation = (await runSkillsWrite(skills, agent, "skills.validate", { skillId: pkg.id })) as SkillValidation;
		expect(validation).toEqual({ digest: saved.digest, problems: [] });
		const revision = await runSkillsWrite(skills, human, "skills.publish", {
			skillId: pkg.id,
			expectedDigest: saved.digest,
		});
		expect(revision).toMatchObject({ skillId: pkg.id, revision: 1, digest: saved.digest });
		const imported = await runSkillsWrite(skills, human, "skills.importRevision", {
			owner,
			name: "deploy",
			description: "Imported",
			files: [skillMd("deploy", "Imported")],
			source: { sourceId: "atlas-git", ref: "abc" },
		});
		expect(imported).toMatchObject({ skillId: pkg.id, revision: 2, source: { sourceId: "atlas-git", ref: "abc" } });
		expect(await runSkillsWrite(skills, human, "skills.exportRevision", { skillId: pkg.id, revision: 2 })).toEqual({
			sourceId: "atlas-git",
			ref: "commit-1",
		});
		expect(
			await rejectedCode(runSkillsWrite(skills, human, "skills.exportRevision", { skillId: pkg.id, revision: 1 })),
		).toBe("conflict");
		expect(Object.keys(skillsWriteOperations).sort()).toEqual([
			"skills.create",
			"skills.exportRevision",
			"skills.importRevision",
			"skills.publish",
			"skills.saveDraft",
			"skills.validate",
		]);
	});

	it("leaves the store's rules to the store, refuses an unknown name and an export without a source", async () => {
		const skills = createMemorySkills();
		expect(
			await rejectedCode(
				runSkillsWrite(skills, agent, "skills.create", { owner, name: "deploy", description: "Deploy" }),
			),
		).toBe("forbidden");
		expect(await rejectedCode(runSkillsWrite(skills, human, "skills.delete", { skillId: "s" }))).toBe("not_found");
		expect(await rejectedCode(runSkillsWrite(skills, human, "toString", {}))).toBe("not_found");
		expect(await rejectedCode(runSkillsWrite(skills, human, "skills.create", { owner }))).toBe("invalid");
		const pkg = await skills.create(human, { owner, name: "deploy", description: "Deploy" });
		expect(
			await rejectedCode(runSkillsWrite(skills, human, "skills.exportRevision", { skillId: pkg.id, revision: 1 })),
		).toBe("not_supported");
	});
});

describe("skills.validate", () => {
	it("reports a frontmatter name that is not the package's and a missing description, and the draft's digest", async () => {
		const skills = createMemorySkills();
		const pkg = await skills.create(human, { owner, name: "deploy", description: "Deploy" });
		const { digest } = await skills.saveDraft(human, pkg.id, {
			files: [{ path: "SKILL.md", content: "---\nname: release\n---\n# Release\n" }],
		});
		const result = await validateOperation.run(skills, human, { skillId: pkg.id });
		expect(result.digest).toBe(digest);
		expect(result.problems.map((problem) => problem.path)).toEqual(["SKILL.md", "SKILL.md"]);
		expect(result.problems.map((problem) => problem.reason).join("\n")).toContain('"release"');
		expect(result.problems.map((problem) => problem.reason).join("\n")).toContain("description");
		// Validating changes nothing: the draft is still open and publishable as it is.
		expect((await skills.get(human, pkg.id)).draftDigest).toBe(digest);
	});

	it("says so when there is no open draft, and refuses a skill the caller cannot see", async () => {
		const skills = createMemorySkills();
		const pkg = await skills.create(human, { owner, name: "deploy", description: "Deploy" });
		const result = await validateOperation.run(skills, human, { skillId: pkg.id });
		expect(result.digest).toBeUndefined();
		expect(result.problems).toHaveLength(1);
		const outsider: CallContext = { actor: { kind: "human", userId: "x" }, organisationId: "org-b" };
		expect(await rejectedCode(validateOperation.run(skills, outsider, { skillId: pkg.id }))).toBe("not_found");
	});
});
