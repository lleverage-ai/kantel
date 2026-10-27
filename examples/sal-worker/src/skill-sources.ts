/**
 * Skill sources for a Sal worker: a Git repository at a commit (Tom's agent-toolkit, Sal's own skills) and a plain
 * directory pinned by a digest of its contents (skills installed without Git, such as an npm package's). Each finds
 * skills as Pi does (tvdavies/sal uses Pi's loader): a directory holding `SKILL.md` is a skill, named by its frontmatter
 * `name` or else the directory, described by its frontmatter `description`; one without a description is not loaded.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { JsonValue, SkillFile, SkillSource } from "@harbour/contracts";
import { parse } from "yaml";
import { type GitFile, readTree, resolveCommit } from "./git.ts";

/** Files a skill package can hold as text. `SkillFile.content` is text, so binary files are left out and reported. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface FoundSkill {
	readonly name: string;
	readonly description: string;
	readonly files: readonly SkillFile[];
	/** Where in the source the skill is, such as `skills/general/pr-review`. */
	readonly dir: string;
	/** Pi leaves a skill with `disable-model-invocation: true` out of the prompt; it is still installed. */
	readonly disableModelInvocation: boolean;
	/** Files left out because they are not UTF-8 text. */
	readonly binary: readonly string[];
}

export interface SkillProblem {
	readonly path: string;
	readonly reason: string;
}

/** Pi's frontmatter: CRLF folded, a leading `---`, YAML up to the next `\n---`. */
export function skillFrontmatter(text: string): Record<string, unknown> {
	const normalised = text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	if (!normalised.startsWith("---")) return {};
	const end = normalised.indexOf("\n---", 3);
	if (end === -1) return {};
	const value: unknown = parse(normalised.slice(4, end));
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The skills in a set of files, keyed by path relative to the source root. A skill holds every file under its directory
 * except those of a skill nested inside it, hidden ones and `node_modules`.
 */
export function findSkills(all: readonly GitFile[]): { skills: FoundSkill[]; problems: SkillProblem[] } {
	// Hidden entries and installed dependencies are not part of a skill.
	const files = all.filter((file) =>
		file.path.split("/").every((segment) => !segment.startsWith(".") && segment !== "node_modules"),
	);
	const dirs = files
		.filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))
		.map((file) => file.path.slice(0, -"SKILL.md".length).replace(/\/$/, ""))
		.sort();
	const skills: FoundSkill[] = [];
	const problems: SkillProblem[] = [];
	for (const dir of dirs) {
		const prefix = dir === "" ? "" : `${dir}/`;
		const nested = dirs.filter((other) => other !== dir && other.startsWith(prefix));
		const own = files.filter(
			(file) => file.path.startsWith(prefix) && !nested.some((other) => file.path.startsWith(`${other}/`)),
		);
		const skillFiles: SkillFile[] = [];
		const binary: string[] = [];
		for (const file of own) {
			const path = file.path.slice(prefix.length);
			try {
				skillFiles.push({ path, content: decoder.decode(file.bytes) });
			} catch {
				binary.push(path);
			}
		}
		const skillMd = skillFiles.find((file) => file.path === "SKILL.md");
		if (skillMd === undefined) {
			problems.push({ path: `${prefix}SKILL.md`, reason: "SKILL.md is not UTF-8 text" });
			continue;
		}
		let frontmatter: Record<string, unknown>;
		try {
			frontmatter = skillFrontmatter(skillMd.content);
		} catch (error) {
			problems.push({ path: `${prefix}SKILL.md`, reason: `frontmatter: ${(error as Error).message}` });
			continue;
		}
		const description = frontmatter.description;
		if (typeof description !== "string" || description.trim() === "") {
			problems.push({ path: `${prefix}SKILL.md`, reason: "no description, so Pi does not load it" });
			continue;
		}
		const name =
			typeof frontmatter.name === "string" && frontmatter.name !== ""
				? frontmatter.name
				: (dir.split("/").at(-1) ?? dir);
		skills.push({
			name,
			description,
			files: skillFiles,
			dir,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			binary,
		});
	}
	return { skills, problems };
}

/** A pinned source with what it found at its last fetch, for reporting. */
export interface SalSkillSource extends SkillSource {
	/** The ref to pin now: the commit a Git source's ref names, or a directory's content digest. */
	pin(): string;
	/** The skills of the last fetch, with where they are and what was left out. */
	readonly last: { skills: readonly FoundSkill[]; problems: readonly SkillProblem[] };
}

function sourceOf(id: string, pin: () => string, load: (ref: string) => GitFile[]): SalSkillSource {
	const last: { skills: FoundSkill[]; problems: SkillProblem[] } = { skills: [], problems: [] };
	return {
		id,
		pin,
		last,
		async fetch(ref) {
			const found = findSkills(load(ref));
			last.skills = found.skills;
			last.problems = found.problems;
			return found.skills.map(({ name, description, files }) => ({ name, description, files }));
		},
	};
}

/** Skills under `paths` of a Git repository, at a commit. `ref` may be a branch when pinning; fetch wants a commit. */
export function gitSkillSource(input: {
	readonly id: string;
	readonly repo: string;
	readonly paths: readonly string[];
	readonly ref?: string;
}): SalSkillSource {
	return sourceOf(
		input.id,
		() => resolveCommit(input.repo, input.ref ?? "HEAD"),
		(ref) => {
			if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`${input.id}: pin a full commit, not ${ref}`);
			const prefixes = input.paths.map((path) => path.replace(/\/+$/, ""));
			return readTree(input.repo, ref, prefixes).map((file) => {
				const prefix = prefixes.find((candidate) => file.path === candidate || file.path.startsWith(`${candidate}/`));
				return { path: prefix === undefined ? file.path : file.path.slice(prefix.length + 1), bytes: file.bytes };
			});
		},
	);
}

/** Every regular file under `root`, following symlinks, as Pi reads a skills directory. Hidden entries are skipped. */
function readDirectory(root: string): GitFile[] {
	const files: GitFile[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 8) return;
		for (const entry of readdirSync(dir).sort()) {
			if (entry.startsWith(".") || entry === "node_modules") continue;
			const path = join(dir, entry);
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat === undefined) continue;
			if (stat.isDirectory()) walk(path, depth + 1);
			else if (stat.isFile()) {
				files.push({ path: relative(root, path).split(sep).join("/"), bytes: new Uint8Array(readFileSync(path)) });
			}
		}
	};
	walk(root, 0);
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** SHA-256 over the files sorted by path, each as `path\0bytes\0`: a directory's ref. */
export function directoryDigest(files: readonly GitFile[]): string {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.path);
		hash.update("\0");
		hash.update(file.bytes);
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

/**
 * Skills in a directory without Git, pinned by a digest of its contents. Fetching a digest the directory no longer has
 * fails: a session pinned to it keeps its revisions in the store, but a new import needs a new pin.
 */
export function directorySkillSource(input: { readonly id: string; readonly root: string }): SalSkillSource {
	return sourceOf(
		input.id,
		() => directoryDigest(readDirectory(input.root)),
		(ref) => {
			const files = readDirectory(input.root);
			const digest = directoryDigest(files);
			if (digest !== ref) throw new Error(`${input.id}: ${input.root} is now ${digest}, not the pinned ${ref}`);
			return files;
		},
	);
}

/** Namespaced data a Sal skill revision carries: where it came from and whether Pi shows it to the model. */
export function salSkillExtensions(skill: FoundSkill): { readonly [namespace: string]: JsonValue } {
	return {
		sal: {
			dir: skill.dir,
			disableModelInvocation: skill.disableModelInvocation,
			...(skill.binary.length === 0 ? {} : { binaryLeftOut: [...skill.binary] }),
		},
	};
}
