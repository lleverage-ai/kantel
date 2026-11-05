/**
 * Read-only mount sources every target can use, because they sit on contracts rather than on storage:
 *
 * - `createWorkspaceProjectFiles`: the `project-files` source (`/project`). Each project's files are a versioned tree
 *   kept in a workspace of the target's own `KeyedWorkspaces` (Postgres and S3 self-hosted, R2 on Cloudflare), so the
 *   source is as durable as the workspaces are. Writes go through `write`, as a tool call does, with the acting user.
 * - `createWorkspaceOrgFiles`: the `org-files` source (`/org`), one tree per organisation kept the same way. Its
 *   members read it from any session, organisation or project; only people and services with an organisation-wide
 *   operator role write it.
 *
 * Mounts are read-only whatever the source: the workspace refuses a commit under a mount point, and the sandbox tiers
 * mount these paths read-only.
 */
import {
	type Actor,
	type CallContext,
	type FileEntry,
	isKantelError,
	KantelError,
	type MountSource,
	type OwnerRef,
	type ProjectAccess,
	type ProjectId,
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
	 * because the workspace checks the source project on every read through a mount.
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
