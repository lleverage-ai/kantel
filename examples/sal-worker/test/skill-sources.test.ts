import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { skillDigest } from "@harbour/skills";
import { afterEach, describe, expect, it } from "vitest";
import { rootPath } from "../src/git.ts";
import {
	directorySkillSource,
	gitSkillSource,
	layerSalSources,
	type SalSkillSource,
	skillFrontmatter,
} from "../src/skill-sources.ts";
import { type FixtureFile, tempRepo, writeFixture } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const skillMd = (name: string, description: string, extra = "") =>
	`---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("skillFrontmatter", () => {
	it("reads YAML as Pi does, block scalars, comments and CRLF included", () => {
		expect(skillFrontmatter("---\r\nname: a\r\ndescription: |\r\n  Two\r\n  lines\r\n---\r\nBody")).toEqual({
			name: "a",
			description: "Two\nlines\n",
		});
		expect(skillFrontmatter("---\nname: review # a comment\ndescription: x\n---\n")).toEqual({
			name: "review",
			description: "x",
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
			// Pi does not search below a skill, so this is a file of start-ticket, not a skill.
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
			["start-ticket", "Start", ["SKILL.md", "nested/SKILL.md"]],
		]);
		expect(source.last.skills.map((skill) => [skill.file, skill.disableModelInvocation, skill.binary])).toEqual([
			["skills/general/pr-review/SKILL.md", false, ["logo.png"]],
			["skills/general/start/SKILL.md", true, []],
		]);
		expect(source.last.problems.map((problem) => [problem.path, problem.reason.split(":")[0]])).toEqual([
			["skills/general/broken/SKILL.md", "frontmatter"],
			["skills/general/undescribed/SKILL.md", "no description, so Pi does not load it"],
		]);
		await expect(source.fetch("main")).rejects.toThrow("pin a full commit");
	});

	it("searches each path as its own root, in order, and names a root skill by its root", async () => {
		const repo = tempRepo();
		cleanups.push(() => repo.remove());
		const commit = repo.commit({
			"a/review/SKILL.md": skillMd("review", "From a"),
			"b/review/SKILL.md": skillMd("review", "From b"),
			"b/SKILL.md": "---\ndescription: The root of b\n---\n",
		});
		const source = gitSkillSource({ id: "two", repo: repo.dir, paths: ["a", "b"] });
		const skills = await source.fetch(commit);
		expect(skills.map((skill) => [skill.name, skill.description])).toEqual([
			["review", "From a"],
			["b", "The root of b"],
		]);
		const repoRoot = await gitSkillSource({ id: "root", repo: repo.dir, paths: ["b"] }).fetch(commit);
		expect(repoRoot.map((skill) => skill.name)).toEqual(["b"]);
	});

	it("follows symlinks within the commit and reports the ones it cannot follow", async () => {
		const repo = tempRepo();
		cleanups.push(() => repo.remove());
		const commit = repo.commit({
			"shared/helper.sh": "echo help\n",
			"library/linked/SKILL.md": skillMd("linked", "Linked in"),
			"library/linked/notes.md": "notes",
			"skills/linked": { link: "../library/linked" },
			"skills/own/SKILL.md": skillMd("own", "Own"),
			"skills/own/helper.sh": { link: "../../shared/helper.sh" },
			"skills/own/outside": { link: "../../../elsewhere" },
			"skills/own/dangling": { link: "missing" },
			"skills/own/loop": { link: "." },
		});
		const source = gitSkillSource({ id: "links", repo: repo.dir, paths: ["skills"] });
		const skills = await source.fetch(commit);
		expect(skills.map((skill) => [skill.name, skill.files.map((file) => [file.path, file.content])])).toEqual([
			[
				"linked",
				[
					["SKILL.md", skillMd("linked", "Linked in")],
					["notes.md", "notes"],
				],
			],
			[
				"own",
				[
					["SKILL.md", skillMd("own", "Own")],
					["helper.sh", "echo help\n"],
				],
			],
		]);
		expect(source.last.problems.map((problem) => problem.path)).toEqual(
			expect.arrayContaining(["skills/own/dangling", "skills/own/outside", "skills/own/loop"]),
		);
	});

	it("stops a loop reached through another link at once, and keeps independent links to one place", async () => {
		const repo = tempRepo();
		cleanups.push(() => repo.remove());
		const commit = repo.commit({
			"library/SKILL.md": skillMd("library", "The library"),
			"library/x": { link: "." },
			"library/y": { link: "." },
			"library/up": { link: "../skills" },
			"skills/a": { link: "../library" },
			"skills/b": { link: "../library" },
		});
		const source = gitSkillSource({ id: "loops", repo: repo.dir, paths: ["skills"] });
		const started = Date.now();
		const skills = await source.fetch(commit);
		expect(Date.now() - started).toBeLessThan(5_000);
		// skills/a and skills/b are one file: loaded once, as Pi does.
		expect(skills.map((skill) => [skill.name, skill.files.map((file) => file.path)])).toEqual([
			["library", ["SKILL.md"]],
		]);
		const reported = source.last.problems.map((problem) => problem.path);
		expect(reported).toEqual(expect.arrayContaining(["skills/a/x", "skills/a/y", "skills/a/up"]));
		expect(reported.every((path) => path.split("/").length <= 3)).toBe(true);
	});

	it("bounds the paths links can fan out to, links to links included", async () => {
		const repo = tempRepo();
		cleanups.push(() => repo.remove());
		// d0..d29 each hold two links to the next; only the last holds a file. 2^30 paths if followed to the end.
		const files: Record<string, FixtureFile> = {
			"real/SKILL.md": skillMd("deep", "Deep"),
			"skills/entry": { link: "../fan/d0" },
			"fan/d30/SKILL.md": { link: "../../real/SKILL.md" },
		};
		for (let depth = 0; depth < 30; depth++) {
			files[`fan/d${depth}/l`] = { link: `../d${depth + 1}` };
			files[`fan/d${depth}/r`] = { link: `../d${depth + 1}` };
		}
		const commit = repo.commit(files);
		const source = gitSkillSource({ id: "fan", repo: repo.dir, paths: ["skills"] });
		const started = Date.now();
		await source.fetch(commit);
		expect(Date.now() - started).toBeLessThan(20_000);
		expect(source.last.problems.map((problem) => problem.reason)).toContain("more than 100000 paths through symlinks");
	});

	it("reads a hidden root and spells roots as given", async () => {
		expect([".", "./", "./x/", ".pi/skills", "./.pi/skills", "x//"].map(rootPath)).toEqual([
			"",
			"",
			"x",
			".pi/skills",
			".pi/skills",
			"x",
		]);
		const repo = tempRepo();
		cleanups.push(() => repo.remove());
		const commit = repo.commit({ ".pi/skills/hidden/SKILL.md": skillMd("hidden", "In a hidden root") });
		for (const path of [".pi/skills", "./.pi/skills"]) {
			const skills = await gitSkillSource({ id: "hidden", repo: repo.dir, paths: [path] }).fetch(commit);
			expect(skills.map((skill) => skill.name)).toEqual(["hidden"]);
		}
	});
});

describe("agents mode", () => {
	it("takes plain .md files below the root but not at it, as Pi does under ~/.agents/skills", async () => {
		const root = tempDir("harbour-agents-");
		writeFixture(root, {
			"top.md": "---\ndescription: At the root\n---\n",
			"group/loose.md": "---\ndescription: Below the root\n---\n",
			"group/skill/SKILL.md": skillMd("skill", "A skill"),
		});
		const pi = directorySkillSource({ id: "pi", root });
		const agents = directorySkillSource({ id: "agents", root, mode: "agents" });
		expect((await pi.fetch(pi.pin())).map((skill) => skill.description)).toEqual(["A skill", "At the root"]);
		expect((await agents.fetch(agents.pin())).map((skill) => [skill.name, skill.description])).toEqual([
			["group", "Below the root"],
			["skill", "A skill"],
		]);
	});
});

describe("directorySkillSource", () => {
	it("pins a directory by its contents, follows symlinks, and refuses a pin the directory no longer matches", async () => {
		const root = tempDir("harbour-skills-");
		const elsewhere = tempDir("harbour-skills-target-");
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "docs", "SKILL.md"), skillMd("docs", "Docs"));
		mkdirSync(join(elsewhere, "linked"));
		writeFileSync(join(elsewhere, "linked", "SKILL.md"), skillMd("linked", "Linked"));
		symlinkSync(join(elsewhere, "linked"), join(root, "linked"));
		// The same skill reached twice is loaded once, as Pi does.
		symlinkSync(join(elsewhere, "linked"), join(root, "again"));
		symlinkSync(root, join(root, "docs", "loop"));
		const source = directorySkillSource({ id: "synced", root });
		const pin = source.pin();
		expect(pin).toMatch(/^sha256:[0-9a-f]{64}$/);
		const skills = await source.fetch(pin);
		expect(skills.map((skill) => skill.name)).toEqual(["linked", "docs"]);
		expect(await skillDigest(skills[0]!.files)).toHaveLength(64);
		writeFileSync(join(root, "docs", "SKILL.md"), skillMd("docs", "Changed"));
		await expect(source.fetch(pin)).rejects.toThrow("not the pinned");
	});

	it("skips a link that loops on itself, as Pi does, and keeps the rest", async () => {
		const root = tempDir("harbour-eloop-");
		writeFixture(root, {
			"good/SKILL.md": skillMd("good", "Good"),
			self: { link: "self" },
			ping: { link: "pong" },
			pong: { link: "ping" },
		});
		const source = directorySkillSource({ id: "eloop", root });
		expect((await source.fetch(source.pin())).map((skill) => skill.name)).toEqual(["good"]);
		expect(source.last.problems.map((problem) => problem.path)).toEqual(["ping", "pong", "self"]);
	});

	it("pins which paths are one file, since that decides what Pi loads twice", async () => {
		const root = tempDir("harbour-alias-");
		const one = tempDir("harbour-alias-one-");
		const two = tempDir("harbour-alias-two-");
		const unnamed = "---\ndescription: Unnamed\n---\n";
		writeFixture(one, { "SKILL.md": unnamed });
		writeFixture(two, { "SKILL.md": unnamed });
		writeFixture(root, { a: { link: one }, b: { link: one } });
		const source = directorySkillSource({ id: "alias", root });
		const pin = source.pin();
		expect((await source.fetch(pin)).map((skill) => skill.name)).toEqual(["a"]);
		// Same paths, same bytes, but now two files: a different pin, and the old one is refused.
		writeFixture(root, { b: null });
		writeFixture(root, { b: { link: two } });
		expect(source.pin()).not.toBe(pin);
		await expect(source.fetch(pin)).rejects.toThrow("not the pinned");
		expect((await source.fetch(source.pin())).map((skill) => skill.name)).toEqual(["a", "b"]);
	});
});

describe("layerSalSources", () => {
	it("loads a file once across sources, as Pi's one loadSkills call does, and lets the next of a name in", async () => {
		const shared = tempDir("harbour-layer-shared-");
		writeFixture(shared, { "SKILL.md": "---\ndescription: Shared\n---\n" });
		const first = tempDir("harbour-layer-a-");
		const second = tempDir("harbour-layer-b-");
		writeFixture(first, { a: { link: shared } });
		writeFixture(second, {
			b: { link: shared },
			// Shadowed within the source by b's file until b is left out.
			"z/SKILL.md": skillMd("b", "Second b"),
		});
		const a = directorySkillSource({ id: "a", root: first });
		const b = directorySkillSource({ id: "b", root: second });
		const layered = await layerSalSources([
			{ source: a, ref: a.pin() },
			{ source: b, ref: b.pin() },
		]);
		expect(layered[0]!.ref).toBe(a.pin());
		expect(layered[1]!.ref).toBe(`${b.pin()}?skip=b%2FSKILL.md`);
		expect((await a.fetch(layered[0]!.ref)).map((skill) => skill.name)).toEqual(["a"]);
		expect((await b.fetch(layered[1]!.ref)).map((skill) => [skill.name, skill.description])).toEqual([
			["b", "Second b"],
		]);
		// The ref alone decides: fetched without the skip, b's own copy is back.
		expect((await b.fetch(b.pin())).map((skill) => skill.description)).toEqual(["Shared"]);
	});

	it("compares a Git source's files where a checkout of it has them", async () => {
		const repo = tempRepo();
		cleanups.push(() => repo.remove());
		const commit = repo.commit({ "skills/one/SKILL.md": skillMd("one", "One") });
		const git = gitSkillSource({ id: "git", repo: repo.dir, paths: ["skills"] });
		const linked = tempDir("harbour-layer-git-");
		writeFixture(linked, { one: { link: join(repo.dir, "skills", "one") } });
		const dir = directorySkillSource({ id: "dir", root: linked });
		const layered = await layerSalSources([
			{ source: git, ref: commit },
			{ source: dir, ref: dir.pin() },
		]);
		expect(layered[1]!.ref).toBe(`${dir.pin()}?skip=one%2FSKILL.md`);
		expect(await dir.fetch(layered[1]!.ref)).toEqual([]);
	});
});

/**
 * Differential: the same files through Pi's own loader (from an installed Sal release, which carries Pi) and through
 * the Harbour sources. Skipped where no Sal release is installed; `PI_SKILLS_JS` points at another `core/skills.js`.
 */
const PI_SKILLS_JS =
	process.env.PI_SKILLS_JS ??
	join(homedir(), ".local/share/sal/current/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js");

const FIXTURE: Record<string, FixtureFile> = {
	"root-note.md": "---\ndescription: A root file skill\n---\nBody",
	"root-plain.md": "No frontmatter, so not a skill",
	"README.md": "---\ntitle: no description\n---\n",
	"commented/SKILL.md": "---\nname: commented # a comment\ndescription: Commented name\n---\n",
	"fallback/SKILL.md": "---\ndescription: Named by its directory\n---\n",
	"blank-name/SKILL.md": '---\nname: ""\ndescription: Blank name\n---\n',
	"crlf/SKILL.md": "---\r\nname: crlf\r\ndescription: >\r\n  Folded\r\n  text\r\n---\r\n",
	"bom/SKILL.md": "\uFEFF---\nname: bom\ndescription: With a BOM\n---\n",
	"category/inner/SKILL.md": skillMd("inner", "Two levels down"),
	"category/loose.md": "---\nname: loose\ndescription: A file below the root\n---\n",
	"outer/SKILL.md": skillMd("outer", "Outer"),
	"outer/nested/SKILL.md": skillMd("nested", "Not found: below a skill"),
	"ignored/SKILL.md": skillMd("ignored", "Ignored by .gitignore"),
	"kept/SKILL.md": skillMd("kept", "Not ignored"),
	".gitignore": "ignored/\n",
	"deep/.ignore": "private.md\n",
	"deep/private.md": "---\ndescription: ignored file\n---\n",
	"deep/public.md": "---\ndescription: deep file\n---\n",
	".hidden/SKILL.md": skillMd("hidden", "Hidden"),
	"node_modules/dep/SKILL.md": skillMd("dep", "A dependency"),
	"bad-yaml/SKILL.md": "---\ndescription: Do it: now\n---\n",
	"no-description/SKILL.md": "---\nname: no-description\n---\n",
	"disabled/SKILL.md": skillMd("disabled", "Hidden from the model", "disable-model-invocation: true\n"),
	"elsewhere/target/SKILL.md": skillMd("target", "Reached through a link"),
	"elsewhere/target/notes.txt": "notes",
};
// Pi takes a directory's entries in readdir order, so which of two skills of one name (or one file reached twice) it
// keeps depends on the file system; those cases are in the tests above, against Harbour's sorted order.

interface PiSkill {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation: boolean;
}

describe.skipIf(!existsSync(PI_SKILLS_JS))("discovery matches Pi's loader", () => {
	async function piSkills(dir: string): Promise<[string, string, string, boolean][]> {
		const pi = (await import(PI_SKILLS_JS)) as { loadSkills(options: object): { skills: PiSkill[] } };
		return pi
			.loadSkills({ cwd: dir, agentDir: dir, skillPaths: [dir], includeDefaults: false })
			.skills.map((skill): [string, string, string, boolean] => [
				skill.name,
				skill.description,
				relative(dir, skill.filePath),
				skill.disableModelInvocation,
			])
			.sort((a, b) => (a[2] < b[2] ? -1 : 1));
	}

	async function harbour(
		source: SalSkillSource,
		ref: string,
		prefix = "",
	): Promise<[string, string, string, boolean][]> {
		await source.fetch(ref);
		return source.last.skills
			.map((skill): [string, string, string, boolean] => [
				skill.name,
				skill.description,
				prefix === "" ? skill.file : skill.file.slice(prefix.length + 1),
				skill.disableModelInvocation,
			])
			.sort((a, b) => (a[2] < b[2] ? -1 : 1));
	}

	it("loads the same skills from a directory and from the same files committed to Git", async () => {
		const dir = tempDir("harbour-pi-diff-");
		writeFixture(dir, FIXTURE);
		const expected = await piSkills(dir);
		// The fixture exercises each rule: check Pi does what the fixture expects before comparing.
		expect(expected.map(([name]) => name).sort()).toEqual(
			[
				"bom",
				"commented",
				"crlf",
				"disabled",
				"fallback",
				"blank-name",
				"inner",
				"kept",
				"outer",
				"target",
				// The root note is named by the root directory.
				expected.find(([, , path]) => path === "root-note.md")![0],
			].sort(),
		);
		const fromDirectory = directorySkillSource({ id: "dir", root: dir });
		expect(await harbour(fromDirectory, fromDirectory.pin())).toEqual(expected);

		const repo = tempRepo();
		cleanups.push(() => repo.remove());
		const commit = repo.commit(
			Object.fromEntries(Object.entries(FIXTURE).map(([path, file]) => [`tree/${path}`, file])),
		);
		const fromGit = gitSkillSource({ id: "git", repo: repo.dir, paths: ["tree"] });
		const gitSkills = await harbour(fromGit, commit, "tree");
		// The root note is named by its root: the temporary directory on one side, `tree` on the other.
		const rename = (skills: [string, string, string, boolean][]) =>
			skills.map((skill) => (skill[2] === "root-note.md" ? (["<root>", ...skill.slice(1)] as typeof skill) : skill));
		expect(rename(gitSkills)).toEqual(rename(expected));
	});

	it("loads a file reached through several paths once, as Pi's loadSkills over those paths does", async () => {
		const shared = tempDir("harbour-pi-shared-");
		writeFixture(shared, { "SKILL.md": "---\ndescription: Shared\n---\n" });
		const first = tempDir("harbour-pi-a-");
		const second = tempDir("harbour-pi-b-");
		writeFixture(first, { a: { link: shared }, "own/SKILL.md": skillMd("own", "Own") });
		writeFixture(second, {
			b: { link: shared },
			"z/SKILL.md": skillMd("b", "Second b"),
			loop: { link: "loop" },
		});
		const pi = (await import(PI_SKILLS_JS)) as { loadSkills(options: object): { skills: PiSkill[] } };
		const expected = pi
			.loadSkills({ cwd: first, agentDir: first, skillPaths: [first, second], includeDefaults: false })
			.skills.map((skill) => [skill.name, skill.description])
			.sort();
		const sources = [directorySkillSource({ id: "a", root: first }), directorySkillSource({ id: "b", root: second })];
		expect(expected).toEqual([
			["a", "Shared"],
			["b", "Second b"],
			["own", "Own"],
		]);
		expect(await layered(sources)).toEqual(expected);
	});

	it("lets a file whose first path lost on its name load through a later path, as Pi does", async () => {
		const shared = tempDir("harbour-pi-shared-");
		writeFixture(shared, { "SKILL.md": "---\ndescription: Shared\n---\n" });
		const roots = [tempDir("harbour-pi-a-"), tempDir("harbour-pi-b-"), tempDir("harbour-pi-c-")];
		writeFixture(roots[0]!, { "x/SKILL.md": skillMd("b", "Independent b") });
		writeFixture(roots[1]!, { b: { link: shared } });
		writeFixture(roots[2]!, { c: { link: shared } });
		const pi = (await import(PI_SKILLS_JS)) as { loadSkills(options: object): { skills: PiSkill[] } };
		const expected = pi
			.loadSkills({ cwd: roots[0], agentDir: roots[0], skillPaths: roots, includeDefaults: false })
			.skills.map((skill) => [skill.name, skill.description])
			.sort();
		expect(expected).toEqual([
			["b", "Independent b"],
			["c", "Shared"],
		]);
		const sources = roots.map((root, index) => directorySkillSource({ id: `s${index}`, root }));
		expect(await layered(sources)).toEqual(expected);
	});

	/** What syncSkillSources would publish from the layered sources: the first of a name across sources wins. */
	async function layered(sources: SalSkillSource[]): Promise<string[][]> {
		const refs = await layerSalSources(sources.map((source) => ({ source, ref: source.pin() })));
		const ours: string[][] = [];
		const names = new Set<string>();
		for (const { source, ref } of refs) {
			for (const skill of await source.fetch(ref)) {
				if (names.has(skill.name)) continue;
				names.add(skill.name);
				ours.push([skill.name, skill.description]);
			}
		}
		return ours.sort();
	}
});
