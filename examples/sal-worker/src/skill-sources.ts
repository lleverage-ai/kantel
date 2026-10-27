/**
 * Skill sources for a Sal worker: a Git repository at a commit (Tom's agent-toolkit, Sal's own skills) and a plain
 * directory pinned by a digest of its contents (skills installed without Git, such as an npm package's). Each finds
 * skills with the rules of Pi's loader (tvdavies/sal hands Pi the paths; Pi's `collectSkillEntries` and
 * `loadSkillFromFile`):
 *
 * - A directory holding `SKILL.md` is a skill, and nothing below it is searched.
 * - Otherwise its other `.md` files are skills too: at the search root in `pi` mode (`~/.pi/agent/skills`, package skill
 *   directories, a configured path), below it in `agents` mode (`~/.agents/skills`). Such a file needs a description.
 * - Hidden entries and `node_modules` are not searched, and `.gitignore`, `.ignore` and `.fdignore` rules apply.
 * - Frontmatter is YAML. A skill is named by its `name`, or else its directory; one without a description, or whose YAML
 *   does not parse, is not loaded and is reported.
 * - Within a source, the first skill of a name wins and a file reached twice through symlinks is loaded once.
 *
 * A package is every file under the skill's directory but hidden ones and `node_modules`; a skill from a plain `.md`
 * file is that file as `SKILL.md`. Files that are not UTF-8 text are left out and recorded (`SkillFile` is text).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { JsonValue, SkillFile, SkillSource } from "@harbour/contracts";
import ignore, { type Ignore } from "ignore";
import { parse } from "yaml";
import { type GitFile, readTree, resolveCommit } from "./git.ts";

/** Package files must be UTF-8 text; anything else is left out. */
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Pi reads a skill file as Node's `utf-8` does: bad bytes become U+FFFD and a BOM stays for the parser to strip. */
const lenient = new TextDecoder("utf-8", { ignoreBOM: true });
const IGNORE_FILES = [".gitignore", ".ignore", ".fdignore"];

export type DiscoveryMode = "pi" | "agents";

export interface FoundSkill {
	readonly name: string;
	readonly description: string;
	readonly files: readonly SkillFile[];
	/** The skill's file in the source, such as `skills/general/pr-review/SKILL.md`. */
	readonly file: string;
	/** Pi leaves a skill with `disable-model-invocation: true` out of the prompt; it is still installed. */
	readonly disableModelInvocation: boolean;
	/** Files left out because they are not UTF-8 text. */
	readonly binary: readonly string[];
}

export interface SkillProblem {
	readonly path: string;
	readonly reason: string;
}

/** Pi's frontmatter: BOM stripped, CRLF folded, a leading `---`, YAML up to the next `\n---`. */
export function skillFrontmatter(text: string): Record<string, unknown> {
	const normalised = text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	if (!normalised.startsWith("---")) return {};
	const end = normalised.indexOf("\n---", 3);
	if (end === -1) return {};
	const yaml = normalised.slice(4, end);
	if (yaml === "") return {};
	const value: unknown = parse(yaml);
	return (value ?? {}) as Record<string, unknown>;
}

/** One search root's files, keyed by path relative to it. */
export interface SkillRoot {
	readonly files: readonly GitFile[];
	/** The root directory's own name: a `SKILL.md` at the root without a `name` is named by it. */
	readonly name: string;
	/** Where the root is in the source, prefixed to reported paths, such as `skills`. */
	readonly at?: string;
}

interface Dir {
	readonly files: Map<string, GitFile>;
	readonly dirs: Set<string>;
}

function indexOf(files: readonly GitFile[]): Map<string, Dir> {
	const dirs = new Map<string, Dir>();
	const dir = (path: string) => {
		let found = dirs.get(path);
		if (found === undefined) {
			found = { files: new Map(), dirs: new Set() };
			dirs.set(path, found);
		}
		return found;
	};
	dir("");
	for (const file of files) {
		const segments = file.path.split("/");
		for (let depth = 0; depth < segments.length; depth++) {
			const parent = segments.slice(0, depth).join("/");
			if (depth === segments.length - 1) dir(parent).files.set(segments[depth]!, file);
			else {
				dir(parent).dirs.add(segments[depth]!);
				dir(segments.slice(0, depth + 1).join("/"));
			}
		}
	}
	return dirs;
}

/** Pi's `prefixIgnorePattern`: a rule from `dir`'s ignore file, rooted at `dir`. */
function prefixed(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (trimmed === "" || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;
	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) pattern = pattern.slice(1);
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	return `${negated ? "!" : ""}${prefix}${pattern}`;
}

const join2 = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`);
const sorted = (names: Iterable<string>) => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The skill files under one root, in Pi's search order. */
function skillFiles(dirs: Map<string, Dir>, mode: DiscoveryMode): string[] {
	const ig: Ignore = ignore();
	const found: string[] = [];
	const visit = (path: string) => {
		const dir = dirs.get(path)!;
		const prefix = path === "" ? "" : `${path}/`;
		for (const name of IGNORE_FILES) {
			const file = dir.files.get(name);
			if (file === undefined) continue;
			const rules = lenient
				.decode(file.bytes)
				.split(/\r?\n/)
				.map((line) => prefixed(line, prefix))
				.filter((line): line is string => line !== null);
			if (rules.length > 0) ig.add(rules);
		}
		if (dir.files.has("SKILL.md") && !ig.ignores(join2(path, "SKILL.md"))) {
			found.push(join2(path, "SKILL.md"));
			return;
		}
		for (const name of sorted([...dir.files.keys(), ...dir.dirs])) {
			if (name.startsWith(".") || name === "node_modules") continue;
			const child = join2(path, name);
			if (dir.dirs.has(name)) {
				if (!ig.ignores(`${child}/`)) visit(child);
				continue;
			}
			const atRoot = path === "";
			if (name.endsWith(".md") && (mode === "pi" ? atRoot : !atRoot) && !ig.ignores(child)) found.push(child);
		}
	};
	visit("");
	return found;
}

function hiddenOrDependency(path: string): boolean {
	return path.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules");
}

/**
 * The skills Pi loads from search roots taken in order, with the problems Pi reports or that keep a skill out of
 * Harbour. Within the roots, the first skill of a name wins.
 */
export function findSkills(
	roots: readonly SkillRoot[],
	mode: DiscoveryMode,
): { skills: FoundSkill[]; problems: SkillProblem[] } {
	const skills: FoundSkill[] = [];
	const problems: SkillProblem[] = [];
	const seenReal = new Set<string>();
	const names = new Map<string, string>();
	for (const root of roots) {
		const at = (path: string) => (root.at === undefined || root.at === "" ? path : `${root.at}/${path}`);
		const dirs = indexOf(root.files);
		for (const path of skillFiles(dirs, mode)) {
			const slash = path.lastIndexOf("/");
			const dirPath = slash === -1 ? "" : path.slice(0, slash);
			const file = dirs.get(dirPath)!.files.get(path.slice(slash + 1))!;
			const declared = path.slice(slash + 1) === "SKILL.md";
			const text = lenient.decode(file.bytes);
			let frontmatter: Record<string, unknown>;
			try {
				frontmatter = skillFrontmatter(text);
			} catch (error) {
				if (declared) {
					problems.push({ path: at(path), reason: `frontmatter: ${(error as Error).message.split("\n")[0]}` });
				}
				continue;
			}
			const description = frontmatter.description;
			if (typeof description !== "string" || description.trim() === "") {
				if (declared) problems.push({ path: at(path), reason: "no description, so Pi does not load it" });
				continue;
			}
			const real = file.real ?? at(path);
			if (seenReal.has(real)) continue;
			const name =
				typeof frontmatter.name === "string" && frontmatter.name !== ""
					? frontmatter.name
					: dirPath === ""
						? root.name
						: dirPath.slice(dirPath.lastIndexOf("/") + 1);
			const winner = names.get(name);
			if (winner !== undefined) {
				problems.push({ path: at(path), reason: `the name ${name} is taken by ${winner}, so Pi does not load it` });
				continue;
			}
			names.set(name, at(path));
			seenReal.add(real);
			const files: SkillFile[] = [];
			const binary: string[] = [];
			if (declared) {
				const prefix = dirPath === "" ? "" : `${dirPath}/`;
				for (const member of root.files) {
					if (!member.path.startsWith(prefix)) continue;
					const inside = member.path.slice(prefix.length);
					if (inside === "SKILL.md") files.push({ path: inside, content: text });
					else if (hiddenOrDependency(inside)) continue;
					else {
						try {
							files.push({ path: inside, content: strict.decode(member.bytes) });
						} catch {
							binary.push(inside);
						}
					}
				}
			} else files.push({ path: "SKILL.md", content: text });
			skills.push({
				name,
				description,
				files,
				file: at(path),
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
				binary,
			});
		}
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

function sourceOf(
	id: string,
	mode: DiscoveryMode,
	pin: () => string,
	load: (ref: string) => { roots: SkillRoot[]; problems: SkillProblem[] },
): SalSkillSource {
	const last: { skills: FoundSkill[]; problems: SkillProblem[] } = { skills: [], problems: [] };
	return {
		id,
		pin,
		last,
		async fetch(ref) {
			const loaded = load(ref);
			const found = findSkills(loaded.roots, mode);
			last.skills = found.skills;
			last.problems = [...loaded.problems, ...found.problems];
			return found.skills.map(({ name, description, files }) => ({ name, description, files }));
		},
	};
}

/**
 * Skills under `paths` of a Git repository at a commit, each path a search root taken in order. `ref` may be a branch
 * when pinning; fetch wants a commit. Symlinks are followed within the commit.
 */
export function gitSkillSource(input: {
	readonly id: string;
	readonly repo: string;
	readonly paths: readonly string[];
	readonly ref?: string;
	readonly mode?: DiscoveryMode;
}): SalSkillSource {
	return sourceOf(
		input.id,
		input.mode ?? "pi",
		() => resolveCommit(input.repo, input.ref ?? "HEAD"),
		(ref) => {
			if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`${input.id}: pin a full commit, not ${ref}`);
			const prefixes = input.paths.map((path) => path.replace(/^\.\/?/, "").replace(/\/+$/, ""));
			const tree = readTree(input.repo, ref, prefixes);
			const roots = prefixes.map((prefix): SkillRoot => {
				const files = tree.files
					.filter((file) => prefix === "" || file.path.startsWith(`${prefix}/`))
					.map((file) => ({ ...file, path: prefix === "" ? file.path : file.path.slice(prefix.length + 1) }));
				const name = prefix === "" ? basename(input.repo) : prefix.slice(prefix.lastIndexOf("/") + 1);
				return { files, name, at: prefix };
			});
			return { roots, problems: tree.problems };
		},
	);
}

/**
 * Every regular file under `root`, following symlinks as Pi does, with the ignore files Pi reads but no other hidden
 * entry and no `node_modules`. A directory already open further up (a symlink loop) is not entered again.
 */
function readDirectory(root: string): GitFile[] {
	const files: GitFile[] = [];
	const walk = (dir: string, open: ReadonlySet<string>) => {
		const real = realpathSync(dir);
		if (open.has(real)) return;
		const inside = new Set([...open, real]);
		for (const entry of readdirSync(dir).sort()) {
			if (entry === "node_modules" || (entry.startsWith(".") && !IGNORE_FILES.includes(entry))) continue;
			const path = join(dir, entry);
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat === undefined) continue;
			if (stat.isDirectory()) walk(path, inside);
			else if (stat.isFile()) {
				files.push({
					path: relative(root, path).split(sep).join("/"),
					bytes: new Uint8Array(readFileSync(path)),
					real: realpathSync(path),
				});
			}
		}
	};
	walk(root, new Set());
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
export function directorySkillSource(input: {
	readonly id: string;
	readonly root: string;
	readonly mode?: DiscoveryMode;
}): SalSkillSource {
	return sourceOf(
		input.id,
		input.mode ?? "pi",
		() => directoryDigest(readDirectory(input.root)),
		(ref) => {
			const files = readDirectory(input.root);
			const digest = directoryDigest(files);
			if (digest !== ref) throw new Error(`${input.id}: ${input.root} is now ${digest}, not the pinned ${ref}`);
			return { roots: [{ files, name: basename(input.root) }], problems: [] };
		},
	);
}

/** Namespaced data a Sal skill revision carries: where it came from and whether Pi shows it to the model. */
export function salSkillExtensions(skill: FoundSkill): { readonly [namespace: string]: JsonValue } {
	return {
		sal: {
			file: skill.file,
			disableModelInvocation: skill.disableModelInvocation,
			...(skill.binary.length === 0 ? {} : { binaryLeftOut: [...skill.binary] }),
		},
	};
}
