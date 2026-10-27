import { createHash } from "node:crypto";
import { isHarbourError } from "@harbour/contracts";
import { normaliseSkillPath, parseSkillFrontmatter, skillDigest, validateSkillName } from "@harbour/skills";
import { createMemorySkills } from "@harbour/skills/memory";
import { describe, expect, it } from "vitest";

function codeOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return isHarbourError(error) ? error.code : String(error);
	}
	return undefined;
}

describe("normaliseSkillPath", () => {
	it("keeps relative paths and drops `.` segments", () => {
		expect(normaliseSkillPath("SKILL.md")).toBe("SKILL.md");
		expect(normaliseSkillPath("./scripts/./run.sh")).toBe("scripts/run.sh");
	});

	it("refuses absolute, escaping, empty-segment, backslash and NUL paths as invalid", () => {
		for (const path of ["", ".", "/abs", "../x", "a/../../x", "a/..", "a//b", "a/", "a\\b", "a\0b"]) {
			expect(
				codeOf(() => normaliseSkillPath(path)),
				JSON.stringify(path),
			).toBe("invalid");
		}
	});
});

describe("skillDigest", () => {
	it("is hex SHA-256 over the files sorted by path, each as path NUL content NUL", async () => {
		const expected = createHash("sha256").update("SKILL.md\0# Skill\0b.sh\0echo\0").digest("hex");
		expect(
			await skillDigest([
				{ path: "b.sh", content: "echo" },
				{ path: "SKILL.md", content: "# Skill" },
			]),
		).toBe(expected);
	});

	it("tells a moved byte between path and content apart", async () => {
		const a = await skillDigest([{ path: "ab", content: "c" }]);
		const b = await skillDigest([{ path: "a", content: "bc" }]);
		expect(a).not.toBe(b);
	});
});

describe("validateSkillName", () => {
	it("accepts lowercase letters, digits and dashes, 1 to 64 characters", () => {
		for (const name of ["a", "pr-review", "v2", "x".repeat(64)])
			expect(codeOf(() => validateSkillName(name))).toBe(undefined);
	});

	it("refuses anything else as invalid", () => {
		for (const name of ["", "PR", "pr_review", "pr review", "pr.review", "é", "x".repeat(65)]) {
			expect(
				codeOf(() => validateSkillName(name)),
				JSON.stringify(name),
			).toBe("invalid");
		}
	});
});

describe("parseSkillFrontmatter", () => {
	it("reads name and description, plain or quoted", () => {
		expect(
			parseSkillFrontmatter('---\nname: pr-review\ndescription: "Review: pull requests"\nlicense: MIT\n---\n# Body\n'),
		).toEqual({ name: "pr-review", description: "Review: pull requests" });
		expect(parseSkillFrontmatter("---\r\nname: 'it''s'\r\n---\r\n")).toEqual({ name: "it's" });
	});

	it("ignores text without frontmatter, unclosed frontmatter and keys after it", () => {
		expect(parseSkillFrontmatter("# No frontmatter\nname: x\n")).toEqual({});
		expect(parseSkillFrontmatter("---\nname: x\n")).toEqual({});
		expect(parseSkillFrontmatter("---\ntitle: y\n---\nname: x\n")).toEqual({});
	});
});

describe("createMemorySkills", () => {
	const ctx = { actor: { kind: "human", userId: "u" }, organisationId: "org" } as const;

	it("takes a draft's description from SKILL.md when none is given, and mounts under mountRoot", async () => {
		const skills = createMemorySkills({ mountRoot: "/mnt/skills/" });
		const pkg = await skills.create(ctx, {
			owner: { kind: "organisation", organisationId: "org" },
			name: "deploy",
			description: "Old",
		});
		const { digest } = await skills.saveDraft(ctx, pkg.id, {
			files: [{ path: "SKILL.md", content: "---\nname: deploy\ndescription: Ship it\n---\n" }],
		});
		const revision = await skills.publish(ctx, pkg.id, { expectedDigest: digest });
		expect(revision.description).toBe("Ship it");
		expect((await skills.get(ctx, pkg.id)).description).toBe("Ship it");
		expect((await skills.list(ctx, {})).items[0]?.path).toBe("/mnt/skills/deploy/SKILL.md");
	});

	it("returns the published revision again when a publish is retried after it succeeded", async () => {
		const skills = createMemorySkills();
		const pkg = await skills.create(ctx, {
			owner: { kind: "organisation", organisationId: "org" },
			name: "deploy",
			description: "Deploy",
		});
		const { digest } = await skills.saveDraft(ctx, pkg.id, { files: [{ path: "SKILL.md", content: "x" }] });
		const [first, retried] = await Promise.all([
			skills.publish(ctx, pkg.id, { expectedDigest: digest }),
			skills.publish(ctx, pkg.id, { expectedDigest: digest }),
		]);
		expect(retried).toBe(first);
		expect((await skills.listRevisions(ctx, pkg.id)).items).toHaveLength(1);
	});
});
