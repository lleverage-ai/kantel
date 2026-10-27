/**
 * A session's pinned skills as a read-only `skills` mount source: mounted at `/skills`, a session reads
 * `/skills/<name>/SKILL.md` and the rest of each package at exactly the revision it was pinned to. Portable: reads
 * through any `Skills`, no storage and no Node APIs.
 *
 * The mount's `ref` is the session ID and its version names the session's pins (`pins:<sha256>`), so a mount can never
 * show another revision than the session's listing says. Nothing writes through it; skills change by publishing.
 */
import {
	type CallContext,
	type FileEntry,
	HarbourError,
	type MountSource,
	type SessionSkillPin,
	type SkillRevision,
	type Skills,
	type SkillVisibility,
} from "@harbour/contracts";

export interface SkillsMountOptions {
	/** The visibility a session's skills are pinned with, the first time any are asked for. */
	readonly visibility: (ctx: CallContext, sessionId: string) => SkillVisibility | Promise<SkillVisibility>;
}

const encoder = new TextEncoder();

async function sha256(text: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The version naming a set of pins. */
export async function pinsVersion(pins: readonly SessionSkillPin[]): Promise<string> {
	const lines = pins.map((pin) => `${pin.skillId}@${pin.revision}`).sort();
	return `pins:${await sha256(lines.join("\n"))}`;
}

export function createSkillsMountSource(skills: Skills, options: SkillsMountOptions): MountSource {
	/** The session's revisions by skill name, checked against the version a mount is pinned to. */
	async function pinned(ctx: CallContext, sessionId: string, version: string): Promise<Map<string, SkillRevision>> {
		const pins = await skills.pinForSession(ctx, sessionId, await options.visibility(ctx, sessionId));
		if ((await pinsVersion(pins)) !== version) {
			throw new HarbourError("not_found", `version ${version} of the skills of session ${sessionId} not found`);
		}
		const byName = new Map<string, SkillRevision>();
		for (const pin of pins) {
			const revision = await skills.getRevision(ctx, pin.skillId, pin.revision);
			byName.set(revision.name, revision);
		}
		return byName;
	}

	function split(path: string): { readonly name: string; readonly rest: string } {
		if (path.startsWith("/") || path.split("/").some((segment) => segment === "" || segment === "..")) {
			throw new HarbourError("invalid", `Not a path inside the skills mount: ${JSON.stringify(path)}`);
		}
		const slash = path.indexOf("/");
		return slash === -1 ? { name: path, rest: "" } : { name: path.slice(0, slash), rest: path.slice(slash + 1) };
	}

	function revisionNamed(byName: Map<string, SkillRevision>, name: string, path: string): SkillRevision {
		const revision = byName.get(name);
		if (revision === undefined) throw new HarbourError("not_found", `${path} not found`);
		return revision;
	}

	return {
		kind: "skills",
		async latestVersion(ctx, sessionId) {
			return pinsVersion(await skills.pinForSession(ctx, sessionId, await options.visibility(ctx, sessionId)));
		},
		async list(ctx, sessionId, version, path) {
			const byName = await pinned(ctx, sessionId, version);
			if (path === "") {
				return [...byName.values()]
					.map(
						(revision): FileEntry => ({
							path: revision.name,
							kind: "directory",
							size: 0,
							version: `${revision.revision}`,
						}),
					)
					.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
			}
			const { name, rest } = split(path);
			const revision = revisionNamed(byName, name, path);
			const prefix = rest === "" ? "" : `${rest}/`;
			const entries = new Map<string, FileEntry>();
			for (const file of revision.files) {
				if (!file.path.startsWith(prefix)) continue;
				const child = file.path.slice(prefix.length);
				const slash = child.indexOf("/");
				const entryPath = `${name}/${prefix}${slash === -1 ? child : child.slice(0, slash)}`;
				if (entries.has(entryPath)) continue;
				// No digest: a revision lists sizes, not per-file digests, and listing never reads file bodies.
				entries.set(entryPath, {
					path: entryPath,
					kind: slash === -1 ? "file" : "directory",
					size: slash === -1 ? file.size : 0,
					version: `${revision.revision}`,
				});
			}
			if (entries.size === 0) throw new HarbourError("not_found", `${path} not found`);
			return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		},
		async read(ctx, sessionId, version, path) {
			const byName = await pinned(ctx, sessionId, version);
			const { name, rest } = split(path);
			const revision = revisionNamed(byName, name, path);
			if (!revision.files.some((file) => file.path === rest)) throw new HarbourError("not_found", `${path} not found`);
			return encoder.encode(await skills.readFile(ctx, revision.skillId, revision.revision, rest));
		},
	};
}
