/**
 * Portable logic for skills: path normalisation, the package digest, name rules and a small `SKILL.md` frontmatter
 * reader. See CONTRACT.md.
 */
import { HarbourError, type SkillFile } from "@harbour/contracts";

/** The file every skill package must hold at its root. */
export const SKILL_MD = "SKILL.md";

const SKILL_NAME = /^[a-z0-9-]{1,64}$/;

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
 * Reads `name` and `description` from `SKILL.md` frontmatter: a first line `---`, then `key: value` lines up to the
 * next `---`. Values may be single- or double-quoted. Anything else (nesting, block scalars) is ignored; no
 * frontmatter gives an empty result.
 */
export function parseSkillFrontmatter(skillMd: string): { readonly name?: string; readonly description?: string } {
	const lines = skillMd.replace(/^\uFEFF/, "").split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return {};
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return {};
	const fields: { name?: string; description?: string } = {};
	for (const line of lines.slice(1, end)) {
		const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
		if (match === null) continue;
		const value = unquote(match[2]!.trim());
		if (value !== "") fields[match[1] as "name" | "description"] = value;
	}
	return fields;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
	return value;
}
