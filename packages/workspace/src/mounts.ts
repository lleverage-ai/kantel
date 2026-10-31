/**
 * Read-only mount sources every target can use, because they sit on contracts rather than on storage:
 *
 * - `createWorkspaceProjectFiles`: the `project-files` source (`/project`). Each project's files are a versioned tree
 *   kept in a workspace of the target's own `KeyedWorkspaces` (Postgres and S3 self-hosted, R2 on Cloudflare), so the
 *   source is as durable as the workspaces are. Writes go through `write`, as a tool call does, with the acting user.
 * - `createWorkspaceOrgFiles`: the `org-files` source (`/org`), one tree per organisation kept the same way. Its
 *   members read it from any session, organisation or project; only people and services with an organisation-wide
 *   operator role write it.
 * - `createSkillsMountSource`: the `skills` source (`/skills`). It shows the skill revisions a session has pinned as
 *   `/skills/<name>/<file>`, matching `SkillListing.path`, read through the `Skills` contract.
 *
 * Mounts are read-only whatever the source: the workspace refuses a commit under a mount point, and the sandbox tiers
 * mount these paths read-only.
 */
import {
	type Actor,
	type AgentProfiles,
	type CallContext,
	type FileEntry,
	isKantelError,
	KantelError,
	type MountSource,
	type OwnerRef,
	type ProjectAccess,
	type ProjectId,
	type SessionDirectory,
	type SessionId,
	type SessionSkillPin,
	type SkillRevision,
	type Skills,
	type SkillVisibility,
	type WorkspaceChange,
	type WorkspaceId,
} from "@kantel/contracts";
import { type KeyedWorkspaces, normalizeWorkspacePath, sha256Hex, toBytes } from "./index.ts";
import { checkOrgFilesRef } from "./tree.ts";

export { checkOrgFilesRef };

const LIST_PAGE = 1000;
/** Blind writes retry a lost race on the head this many times before giving up with `conflict`. */
const WRITE_ATTEMPTS = 5;

// ---- project files ---------------------------------------------------------------------------------------------------

export interface WorkspaceProjectFilesOptions {
	/** Where the trees live. The source opens one workspace per organisation and project, owned by the project. */
	readonly workspaces: KeyedWorkspaces;
	/**
	 * Project access. `write` needs operator on the project as `workspace.files.write`. Reads are not checked here,
	 * because the workspace checks the source project on every read through a mount (settled question 11).
	 */
	readonly access?: ProjectAccess;
}

/** The workspace that holds a project's files: derived, so every host finds the same one without an index. */
export async function projectFilesWorkspaceId(organisationId: string, projectId: ProjectId): Promise<WorkspaceId> {
	// JSON is a lossless, unambiguous encoding of the pair (lone surrogates are escaped, separators quoted).
	const digest = await sha256Hex(toBytes(JSON.stringify(["project-files", organisationId, projectId])));
	return `pf_${digest.slice(0, 48)}`;
}

/** The `project-files` source over workspaces. Versions are the tree's workspace versions as strings; `"0"` is empty. */
export function createWorkspaceProjectFiles(options: WorkspaceProjectFilesOptions): MountSource {
	const { access } = options;
	return treeSource({
		kind: "project-files",
		workspaces: options.workspaces,
		store: async (ctx, ref) => {
			if (typeof ref !== "string" || ref === "") {
				throw new KantelError("invalid", "a project-files ref is a project ID");
			}
			return {
				id: await projectFilesWorkspaceId(ctx.organisationId, ref),
				owner: { kind: "project", organisationId: ctx.organisationId, projectId: ref },
				name: `the project files store for ${ref}`,
			};
		},
		requireWrite: async (ctx, ref) => {
			await access?.require(ctx, { projectId: ref, needed: "operator", operation: "workspace.files.write" });
		},
		message: "project files",
	});
}

// ---- organisation files ----------------------------------------------------------------------------------------------

export interface WorkspaceOrgFilesOptions {
	/** Where the tree lives. The source opens one workspace per organisation, owned by the organisation. */
	readonly workspaces: KeyedWorkspaces;
	/**
	 * Access. `write` needs operator on the organisation scope as `workspace.org-files.write`: a human or service with
	 * an organisation-wide role. Reads are open to the organisation's members, so the workspace checks only the
	 * workspace read through and that the ref is the caller's organisation, on every read.
	 */
	readonly access?: ProjectAccess;
}

/** The workspace that holds an organisation's files: derived, as `projectFilesWorkspaceId` is. */
export async function orgFilesWorkspaceId(organisationId: string): Promise<WorkspaceId> {
	const digest = await sha256Hex(toBytes(JSON.stringify(["org-files", organisationId])));
	return `of_${digest.slice(0, 48)}`;
}

/**
 * The `org-files` source (`/org`) over workspaces. A mount's `ref` is the organisation ID, and only the caller's own
 * organisation's: another is `not_found`, as every record of another organisation is. Agents never write it, whatever
 * their session's scope; people and services write with an organisation-wide operator role.
 */
export function createWorkspaceOrgFiles(options: WorkspaceOrgFilesOptions): MountSource {
	const { access } = options;
	return treeSource({
		kind: "org-files",
		workspaces: options.workspaces,
		store: async (ctx, ref) => {
			checkOrgFilesRef(ctx, ref);
			return {
				id: await orgFilesWorkspaceId(ctx.organisationId),
				owner: { kind: "organisation", organisationId: ctx.organisationId },
				name: "the organisation files store",
			};
		},
		requireWrite: async (ctx) => {
			// An organisation session's agent passes organisation checks as an operator, so the agent rule is its own:
			// asking for admin, which no agent holds, refuses and audits it as every other refusal is.
			const needed = ctx.actor.kind === "agent" ? "admin" : "operator";
			if (access === undefined) {
				if (ctx.actor.kind === "agent") throw new KantelError("forbidden", "Agents may not write organisation files");
				return;
			}
			await access.require(ctx, { needed, operation: "workspace.org-files.write" });
		},
		message: "organisation files",
	});
}

// ---- a versioned tree kept in a workspace ----------------------------------------------------------------------------

interface TreeSourceSpec {
	readonly kind: string;
	readonly workspaces: KeyedWorkspaces;
	/** The workspace holding `ref`'s tree, its exact owner, and how a conflict names it. Checks `ref` first. */
	store(
		ctx: CallContext,
		ref: string,
	): Promise<{ readonly id: WorkspaceId; readonly owner: OwnerRef; readonly name: string }>;
	requireWrite(ctx: CallContext, ref: string): Promise<void>;
	/** The commit message of a write. */
	readonly message: string;
}

function treeSource(spec: TreeSourceSpec): MountSource {
	const { workspaces } = spec;

	/** The source acts on its own trees as Kantel, in the caller's organisation; callers are checked before this. */
	function internal(ctx: CallContext): CallContext {
		return { actor: { kind: "system", component: `workspace.${spec.kind}` }, organisationId: ctx.organisationId };
	}

	async function open(ctx: CallContext, ref: string): Promise<WorkspaceId> {
		const { id, owner: expected, name } = await spec.store(ctx, ref);
		const record = await workspaces.ensure(internal(ctx), id, { owner: expected });
		// Anyone who may create workspaces could have taken the derived ID first. The source acts with Kantel's own
		// authority on this tree, so it uses only one that is exactly its owner's: owned by it, in no session and with no
		// mounts of its own.
		if (!sameOwner(record.owner, expected) || record.sessionId !== undefined || record.mounts.length > 0) {
			throw new KantelError("conflict", `${name} is taken by another workspace`);
		}
		return id;
	}

	return {
		kind: spec.kind,

		async latestVersion(ctx, ref) {
			const id = await open(ctx, ref);
			return String((await workspaces.get(internal(ctx), id)).head);
		},

		async list(ctx, ref, version, path) {
			const id = await open(ctx, ref);
			const at = parseVersion(version);
			const dir = path === "" ? undefined : normalizeWorkspacePath(path);
			const entries: FileEntry[] = [];
			let cursor: string | undefined;
			do {
				const page = await workspaces.list(internal(ctx), id, {
					...(dir === undefined ? {} : { path: dir }),
					version: at,
					limit: LIST_PAGE,
					...(cursor === undefined ? {} : { cursor }),
				});
				for (const entry of page.items) entries.push({ ...entry, version: String(entry.version) });
				cursor = page.nextCursor;
			} while (cursor !== undefined);
			return entries;
		},

		async read(ctx, ref, version, path) {
			const id = await open(ctx, ref);
			return (
				await workspaces.read(internal(ctx), id, normalizeWorkspacePath(path), { version: parseVersion(version) })
			).content;
		},

		async write(ctx, ref, changes: readonly WorkspaceChange[]): Promise<{ version: string; actor: Actor }> {
			await spec.requireWrite(ctx, ref);
			const id = await open(ctx, ref);
			for (let attempt = 1; ; attempt++) {
				const head = (await workspaces.get(internal(ctx), id)).head;
				try {
					// The commit carries the caller as its actor, so the tree's history says who wrote what.
					const committed = await workspaces.commit({ ...internal(ctx), actor: ctx.actor }, id, {
						baseVersion: head,
						changes,
						message: spec.message,
					});
					return { version: String(committed.version), actor: ctx.actor };
				} catch (error) {
					// Writes are blind puts and deletes, so a lost race on the head is retried on the new head.
					if (!isKantelError(error, "conflict") || attempt >= WRITE_ATTEMPTS) throw error;
				}
			}
		},
	};
}

function sameOwner(actual: OwnerRef, expected: OwnerRef): boolean {
	return JSON.stringify(ownerKey(actual)) === JSON.stringify(ownerKey(expected));
}

function ownerKey(owner: OwnerRef): readonly string[] {
	switch (owner.kind) {
		case "platform":
			return [owner.kind];
		case "organisation":
			return [owner.kind, owner.organisationId];
		case "project":
			return [owner.kind, owner.organisationId, owner.projectId];
		case "user":
			return [owner.kind, owner.organisationId, owner.userId];
	}
}

function parseVersion(version: string): number {
	if (typeof version !== "string" || !/^\d+$/.test(version)) {
		throw new KantelError("not_found", `files version ${String(version)} not found`);
	}
	return Number(version);
}

// ---- skills ----------------------------------------------------------------------------------------------------------

export interface SkillsMountSourceOptions {
	readonly skills: Pick<Skills, "pinForSession" | "getRevision" | "readFile">;
	/** Which skills a session may see: its project, and its user when the host has one. */
	readonly visibility: (ctx: CallContext, sessionId: SessionId) => Promise<SkillVisibility>;
}

/**
 * A `visibility` for `createSkillsMountSource` from the session directory: the session's own project and, with
 * `profiles`, the skills its agent's profile names (`SkillVisibility.shared`), so a skill shared into the project is
 * pinned whichever of the mount and the runtime pins first.
 */
export function sessionSkillVisibility(
	sessions: Pick<SessionDirectory, "get">,
	profiles?: Pick<AgentProfiles, "get">,
): (ctx: CallContext, sessionId: SessionId) => Promise<SkillVisibility> {
	return async (ctx, sessionId) => {
		const system: CallContext = {
			actor: { kind: "system", component: "workspace.skills" },
			organisationId: ctx.organisationId,
		};
		const session = await sessions.get(system, sessionId);
		if (profiles === undefined) return { projectId: session.projectId };
		const profile = await profiles.get(system, session.agentId);
		return { projectId: session.projectId, shared: profile.skills };
	};
}

const PIN_VERSION_PREFIX = "pins:";

/**
 * The version a skills mount pins: the session's pinned revisions themselves, `pins:<skillId>@<revision>,…` sorted by
 * skill ID, so a version names exactly what it shows and never changes meaning.
 */
export function skillsMountVersion(pins: readonly Pick<SessionSkillPin, "skillId" | "revision">[]): string {
	return (
		PIN_VERSION_PREFIX +
		[...pins]
			.sort((left, right) => (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0))
			.map((pin) => `${encodeURIComponent(pin.skillId)}@${pin.revision}`)
			.join(",")
	);
}

function parsePins(version: string): { readonly skillId: string; readonly revision: number }[] {
	const bad = () => new KantelError("not_found", "skills mount version not found");
	if (typeof version !== "string" || !version.startsWith(PIN_VERSION_PREFIX)) throw bad();
	const body = version.slice(PIN_VERSION_PREFIX.length);
	if (body === "") return [];
	return body.split(",").map((part) => {
		const at = part.lastIndexOf("@");
		const revision = Number(part.slice(at + 1));
		if (at <= 0 || !Number.isInteger(revision) || revision < 1) throw bad();
		let skillId: string;
		try {
			skillId = decodeURIComponent(part.slice(0, at));
		} catch {
			throw bad();
		}
		return { skillId, revision };
	});
}

/**
 * The `skills` source. A mount's `ref` is the session ID. `latestVersion` pins the session's skills (once: later calls
 * return the same pins), so it needs what `Skills.pinForSession` needs: the session's own agent, or an operator on its
 * project. Reads go through `getRevision` and `readFile` as the caller, so the skills store's own access rules apply
 * to every read.
 */
export function createSkillsMountSource(options: SkillsMountSourceOptions): MountSource {
	const { skills } = options;

	/** The pinned revisions by mount directory name; a name is unique among a session's listed skills. */
	async function layout(ctx: CallContext, version: string): Promise<Map<string, SkillRevision>> {
		const byName = new Map<string, SkillRevision>();
		for (const pin of parsePins(version)) {
			const revision = await skills.getRevision(ctx, pin.skillId, pin.revision);
			byName.set(revision.name, revision);
		}
		return byName;
	}

	function split(path: string): { readonly name: string; readonly rest: string } {
		const normalized = normalizeWorkspacePath(path);
		const slash = normalized.indexOf("/");
		return slash < 0
			? { name: normalized, rest: "" }
			: { name: normalized.slice(0, slash), rest: normalized.slice(slash + 1) };
	}

	return {
		kind: "skills",

		async latestVersion(ctx, ref) {
			const visibility = await options.visibility(ctx, ref);
			return skillsMountVersion(await skills.pinForSession(ctx, ref, visibility));
		},

		async list(ctx, _ref, version, path) {
			const byName = await layout(ctx, version);
			if (path === "") {
				return [...byName.keys()].map((name) => ({ path: name, kind: "directory", size: 0, version }));
			}
			const { name, rest } = split(path);
			const revision = byName.get(name);
			if (revision === undefined) throw new KantelError("not_found", `${path} not found`, { path });
			const prefix = rest === "" ? "" : `${rest}/`;
			const entries = new Map<string, FileEntry>();
			for (const file of revision.files) {
				if (file.path === rest) throw new KantelError("invalid", `${path} is a file`, { path });
				if (!file.path.startsWith(prefix)) continue;
				const below = file.path.slice(prefix.length);
				const slash = below.indexOf("/");
				const child = `${name}/${prefix}${slash < 0 ? below : below.slice(0, slash)}`;
				if (!entries.has(child)) {
					entries.set(
						child,
						slash < 0
							? { path: child, kind: "file", size: file.size, version }
							: { path: child, kind: "directory", size: 0, version },
					);
				}
			}
			if (entries.size === 0 && rest !== "") throw new KantelError("not_found", `${path} not found`, { path });
			return [...entries.values()];
		},

		async read(ctx, _ref, version, path) {
			const { name, rest } = split(path);
			const revision = (await layout(ctx, version)).get(name);
			if (revision === undefined || !revision.files.some((file) => file.path === rest)) {
				throw new KantelError("not_found", `${path} not found`, { path });
			}
			return toBytes(await skills.readFile(ctx, revision.skillId, revision.revision, rest));
		},
	};
}
