/**
 * Portable logic for skills: path normalisation, the package digest, name rules, a small `SKILL.md` frontmatter
 * reader and a package check against the Agent Skills rules. See CONTRACT.md.
 */
import { HarbourError, isHarbourError, type SkillFile } from "@harbour/contracts";

/** The file every skill package must hold at its root. */
export const SKILL_MD = "SKILL.md";

const SKILL_NAME = /^[a-z0-9-]{1,64}$/;
/** The Agent Skills specification's name rule (https://agentskills.io/specification), stricter than a store's. */
const SPEC_NAME = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;
/** The specification's longest description. */
const MAX_DESCRIPTION = 1024;

/**
 * A package path as stored: relative, `/`-separated, no `..`, no empty segments. `.` segments are dropped. A
 * backslash or NUL is `invalid` too: a backslash escapes on some mounts and NUL separates entries in the digest.
 */
export function normaliseSkillPath(path: string): string {
	if (path.includes("\\") || path.includes("\0")) {
		throw new HarbourError("invalid", `A skill path cannot contain a backslash or NUL: ${JSON.stringify(path)}`);
	}
	if (path.startsWith("/")) throw new HarbourError("invalid", `A skill path must be relative: ${path}`);
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "") throw new HarbourError("invalid", `A skill path cannot have empty segments: ${path}`);
		if (segment === "..") throw new HarbourError("invalid", `A skill path cannot leave its package: ${path}`);
		if (segment !== ".") segments.push(segment);
	}
	if (segments.length === 0) throw new HarbourError("invalid", `A skill path must name a file: ${path}`);
	return segments.join("/");
}

/** Hex SHA-256 over the files sorted by path, each as `path\0content\0`. */
export async function skillDigest(files: readonly SkillFile[]): Promise<string> {
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const text = sorted.map((file) => `${file.path}\0${file.content}\0`).join("");
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Agent Skills names: lowercase letters, digits and dashes, 1 to 64 characters; otherwise `invalid`. */
export function validateSkillName(name: string): void {
	if (!SKILL_NAME.test(name)) {
		throw new HarbourError("invalid", `A skill name must be 1 to 64 lowercase letters, digits or dashes: ${name}`);
	}
}

/**
 * Reads `name` and `description` from `SKILL.md` frontmatter: a first line `---`, then top-level `key: value` lines up
 * to the next `---`. A value may be plain (a trailing ` # comment` dropped), single- or double-quoted, or a `|` or `>`
 * block scalar. A value that is not text (`null`, `~`, a `[...]` or `{...}` collection) is ignored, as is anything
 * else; no frontmatter gives an empty result.
 */
export function parseSkillFrontmatter(skillMd: string): { readonly name?: string; readonly description?: string } {
	const lines = skillMd.replace(/^\uFEFF/, "").split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return {};
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return {};
	const body = lines.slice(1, end);
	const fields: { name?: string; description?: string } = {};
	for (const [index, line] of body.entries()) {
		const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
		if (match === null) continue;
		const raw = match[2]!.trim();
		const block = /^([|>])[-+]?(?:\s+#.*)?$/.exec(raw);
		const value = block === null ? scalar(raw) : blockScalar(block[1] as "|" | ">", body.slice(index + 1));
		if (value !== undefined && value !== "") fields[match[1] as "name" | "description"] = value;
	}
	return fields;
}

/** A one-line YAML value as text, or undefined when it is not text. */
function scalar(raw: string): string | undefined {
	const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?:\s+#.*)?$/.exec(raw);
	if (quoted !== null) return unquote(quoted[1]!);
	const plain = raw.replace(/(^|\s+)#.*$/, "").trim();
	if (plain === "null" || plain === "~" || plain.startsWith("[") || plain.startsWith("{")) return undefined;
	return plain;
}

/** A block scalar's text: its indented lines, joined by newlines (`|`) or folded to one line (`>`), trimmed. */
function blockScalar(style: "|" | ">", following: readonly string[]): string {
	const taken: string[] = [];
	for (const line of following) {
		if (line.trim() !== "" && !/^\s/.test(line)) break;
		taken.push(line.trim());
	}
	return (style === "|" ? taken.join("\n") : taken.filter((line) => line !== "").join(" ")).trim();
}

/** Something `validateSkillPackage` found wrong: the file it is about (`""` for the package itself) and why. */
export interface SkillPackageProblem {
	readonly path: string;
	readonly reason: string;
}

/**
 * Checks a package against the Agent Skills specification (https://agentskills.io/specification), without throwing:
 * a name of 1 to 64 lowercase letters, digits and single inner dashes, text files at valid paths (as
 * `normaliseSkillPath` reads them), each path once, and `SKILL.md` at the root with frontmatter (as
 * `parseSkillFrontmatter` reads it) naming the package and holding a description of at most 1024 characters. Empty when
 * the package is valid. Stores accept more than this (they need only `SKILL.md` and valid paths), so a host runs it
 * before publishing to know a package will work in any Agent Skills client.
 */
export function validateSkillPackage(name: string, files: readonly SkillFile[]): readonly SkillPackageProblem[] {
	const problems: SkillPackageProblem[] = [];
	if (typeof name !== "string" || !SPEC_NAME.test(name)) {
		problems.push({
			path: "",
			reason:
				"A skill name must be 1 to 64 lowercase letters, digits or dashes, not starting or ending with a dash or holding two in a row",
		});
	}
	const seen = new Set<string>();
	let skillMd: string | undefined;
	for (const file of files) {
		if (typeof file?.path !== "string") {
			problems.push({ path: "", reason: "Every file needs a path" });
			continue;
		}
		let path: string;
		try {
			path = normaliseSkillPath(file.path);
		} catch (error) {
			if (!isHarbourError(error)) throw error;
			problems.push({ path: file.path, reason: error.message });
			continue;
		}
		if (seen.has(path)) {
			problems.push({ path, reason: `${path} appears twice` });
			continue;
		}
		seen.add(path);
		if (typeof file.content !== "string") {
			problems.push({ path, reason: `${path} needs text content` });
			continue;
		}
		if (path === SKILL_MD) skillMd = file.content;
	}
	if (skillMd === undefined) {
		if (!seen.has(SKILL_MD)) problems.push({ path: SKILL_MD, reason: `A skill package needs ${SKILL_MD} at its root` });
		return problems;
	}
	const frontmatter = parseSkillFrontmatter(skillMd);
	if (frontmatter.name === undefined) {
		problems.push({ path: SKILL_MD, reason: "The frontmatter needs a name" });
	} else if (frontmatter.name !== name) {
		problems.push({
			path: SKILL_MD,
			reason: `The frontmatter names the skill ${JSON.stringify(frontmatter.name)}, not ${JSON.stringify(name)}`,
		});
	}
	if (frontmatter.description === undefined || frontmatter.description.trim() === "") {
		problems.push({ path: SKILL_MD, reason: "The frontmatter needs a description" });
	} else if (frontmatter.description.length > MAX_DESCRIPTION) {
		problems.push({ path: SKILL_MD, reason: `The description is longer than ${MAX_DESCRIPTION} characters` });
	}
	return problems;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
	return value;
}
