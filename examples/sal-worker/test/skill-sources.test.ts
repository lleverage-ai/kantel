import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillDigest } from "@harbour/skills";
import { afterEach, describe, expect, it } from "vitest";
import { directorySkillSource, gitSkillSource, skillFrontmatter } from "../src/skill-sources.ts";
import { tempRepo } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const skillMd = (name: string, description: string, extra = "") =>
	`---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

describe("skillFrontmatter", () => {
	it("reads YAML as Pi does, block scalars and CRLF included", () => {
		expect(skillFrontmatter("---\r\nname: a\r\ndescription: |\r\n  Two\r\n  lines\r\n---\r\nBody")).toEqual({
			name: "a",
			description: "Two\nlines\n",
		});
		expect(skillFrontmatter("# No frontmatter")).toEqual({});
		expect(() => skillFrontmatter("---\ndescription: Do it: now\n---\n")).toThrow();
	});
});

describe("gitSkillSource", () => {
	it("pins a commit and reads the skills under its paths at that commit, whatever the tree holds now", async () => {
		const repo = tempRepo();
		cleanups.push(() => repo.remove());
		const first = repo.commit({
			"skills/general/pr-review/SKILL.md": skillMd("pr-review", "Review a PR"),
			"skills/general/pr-review/scripts/check.sh": "#!/bin/sh\necho ok\n",
			"skills/general/pr-review/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]),
			"skills/general/pr-review/.cache/x": "hidden",
			"skills/general/start/SKILL.md": skillMd("start-ticket", "Start", "disable-model-invocation: true\n"),
			"skills/general/start/nested/SKILL.md": skillMd("nested", "A skill inside a skill"),
			"skills/general/broken/SKILL.md": "---\ndescription: Do it: now\n---\n",
			"skills/general/undescribed/SKILL.md": "---\nname: undescribed\n---\n",
			"README.md": "not a skill",
		});
		const source = gitSkillSource({ id: "toolkit", repo: repo.dir, paths: ["skills"] });
		expect(source.pin()).toBe(first);
		repo.commit({ "skills/general/pr-review/SKILL.md": skillMd("pr-review", "Changed") });
		expect(source.pin()).not.toBe(first);

		const skills = await source.fetch(first);
		expect(skills.map((skill) => [skill.name, skill.description, skill.files.map((file) => file.path)])).toEqual([
			["pr-review", "Review a PR", ["SKILL.md", "scripts/check.sh"]],
			["start-ticket", "Start", ["SKILL.md"]],
			["nested", "A skill inside a skill", ["SKILL.md"]],
		]);
		expect(source.last.skills.map((skill) => [skill.dir, skill.disableModelInvocation, skill.binary])).toEqual([
			["general/pr-review", false, ["logo.png"]],
			["general/start", true, []],
			["general/start/nested", false, []],
		]);
		expect(source.last.problems.map((problem) => [problem.path, problem.reason.split(":")[0]])).toEqual([
			["general/broken/SKILL.md", "frontmatter"],
			["general/undescribed/SKILL.md", "no description, so Pi does not load it"],
		]);
		await expect(source.fetch("main")).rejects.toThrow("pin a full commit");
	});

	it("reads a repository whose skills are at its root", async () => {
		const repo = tempRepo();
		cleanups.push(() => repo.remove());
		const commit = repo.commit({ "brwsr/SKILL.md": skillMd("brwsr", "Browser"), "README.md": "Sal's skills" });
		const skills = await gitSkillSource({ id: "sal-skills", repo: repo.dir, paths: ["."] }).fetch(commit);
		expect(skills.map((skill) => skill.name)).toEqual(["brwsr"]);
	});
});

describe("directorySkillSource", () => {
	it("pins a directory by its contents, follows symlinks, and refuses a pin the directory no longer matches", async () => {
		const root = mkdtempSync(join(tmpdir(), "harbour-skills-"));
		const elsewhere = mkdtempSync(join(tmpdir(), "harbour-skills-target-"));
		cleanups.push(() => {
			rmSync(root, { recursive: true, force: true });
			rmSync(elsewhere, { recursive: true, force: true });
		});
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "docs", "SKILL.md"), skillMd("docs", "Docs"));
		mkdirSync(join(elsewhere, "linked"));
		writeFileSync(join(elsewhere, "linked", "SKILL.md"), skillMd("linked", "Linked"));
		symlinkSync(join(elsewhere, "linked"), join(root, "linked"));
		const source = directorySkillSource({ id: "synced", root });
		const pin = source.pin();
		expect(pin).toMatch(/^sha256:[0-9a-f]{64}$/);
		const skills = await source.fetch(pin);
		expect(skills.map((skill) => skill.name)).toEqual(["docs", "linked"]);
		expect(await skillDigest(skills[0]!.files)).toHaveLength(64);
		writeFileSync(join(root, "docs", "SKILL.md"), skillMd("docs", "Changed"));
		await expect(source.fetch(pin)).rejects.toThrow("not the pinned");
	});
});
