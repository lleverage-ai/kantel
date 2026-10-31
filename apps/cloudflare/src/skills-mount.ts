/**
 * A session's skills at `/skills` on its workspace (#12): the runtime's `skills.mount` (`@kantel/runtime`'s
 * `SessionSkillsOptions`), called once on the session's first prompt with the revisions it just pinned.
 *
 * The mount is the `skills` source of `@kantel/workspace/mounts` with the session's ID as its ref, pinned to exactly
 * those revisions (`skillsMountVersion`), so the files the listing points at are the ones the session was given and a
 * later revision reaches only new sessions. It is read-only, as every mount is: the workspace refuses a commit under
 * it, and the file tools and the isolate read it through the workspace.
 *
 * Every session has a workspace (`src/coding-tools.ts`), and which kind decides how the mount gets there:
 *
 * - its own (`session_<ID>`), not made until a tool needs it: made here, empty, with the mount;
 * - one with `/skills` already mounted: re-pinned to these revisions (`Workspaces.remount`);
 * - one made before the session, with no `/skills` (a repository the console seeded with `POST /v1/workspaces`): the
 *   mount is added to its record, with the same checks and the same compare-and-set on its head that `remount` makes.
 *   `Workspaces` can only re-pin a mount it already has, and a workspace made before its session cannot name the
 *   session's ID, so the stack adds it here.
 *
 * All of it runs as the session's agent, who is an operator only on its own session's project.
 *
 * A workspace shared by several sessions has one `/skills`: each session's first prompt re-pins it to that session's
 * revisions, so an earlier session sharing it then reads the later one's. A session's own workspace has no such sharing.
 */
import {
	type CallContext,
	KantelError,
	type MountRequest,
	type MountSource,
	type ProjectAccess,
	type SessionRecord,
	type SessionSkillPin,
	scopeOwner,
	type WorkspaceRecord,
} from "@kantel/contracts";
import { skillsMountVersion } from "@kantel/workspace/mounts";
import type { StoredWorkspaces, WorkspaceStore } from "@kantel/workspace/stored";
import { checkMountsDisjoint, mountSources, workspaceAccess } from "@kantel/workspace/tree";
import { agentContext, isSessionWorkspace } from "./coding-tools.ts";

/** Where a session's skills are mounted, and where its listing says they are. */
export const SKILLS_MOUNT_ROOT = "/skills";

/** Times adding the mount re-reads the head after losing a race with a commit or another remount. */
const ADD_ATTEMPTS = 5;

export interface SessionSkillsMountOptions {
	/** The stack's workspaces; asked at each mount, so they may be built after the runtime. */
	readonly workspaces: () => StoredWorkspaces;
	/** The store under them, for adding a mount to a workspace that has none at `/skills`. */
	readonly store: WorkspaceStore;
	/** The `skills` mount source the workspaces were given. */
	readonly source: MountSource;
	/** The runtime's project access; asked at each mount, likewise. */
	readonly access: () => ProjectAccess;
	readonly now: () => number;
}

/** The request that mounts a session's pinned skills. */
export function skillsMountRequest(session: SessionRecord, pins: readonly SessionSkillPin[]): MountRequest {
	return { path: SKILLS_MOUNT_ROOT, source: "skills", ref: session.id, version: skillsMountVersion(pins) };
}

/** The runtime's `skills.mount` for the stack: the pinned skills read-only at `/skills` on the session's workspace. */
export function sessionSkillsMount(
	options: SessionSkillsMountOptions,
): (session: SessionRecord, pins: readonly SessionSkillPin[]) => Promise<void> {
	return async (session, pins) => {
		const workspaceId = session.workspaceId;
		if (workspaceId === undefined) return;
		const ctx = agentContext(session);
		const request = skillsMountRequest(session, pins);
		const workspaces = options.workspaces();
		const record = isSessionWorkspace(workspaceId)
			? await workspaces.ensure(ctx, workspaceId, {
					owner: scopeOwner(session),
					mounts: [request],
				})
			: await workspaces.get(ctx, workspaceId);
		const mounted = record.mounts.find((mount) => mount.path === SKILLS_MOUNT_ROOT);
		if (mounted !== undefined) {
			if (mounted.source === "skills" && mounted.ref === request.ref && mounted.version === request.version) return;
			await workspaces.remount(ctx, workspaceId, request);
			return;
		}
		await addMount(options, ctx, workspaceId, request);
	};
}

/**
 * Adds `request` to a workspace that has no mount at its path, as `remount` re-pins one: operator on the workspace,
 * the version checked against the source, mounts kept disjoint, and the record replaced only if the head has not moved.
 */
async function addMount(
	options: SessionSkillsMountOptions,
	ctx: CallContext,
	workspaceId: string,
	request: MountRequest,
): Promise<WorkspaceRecord> {
	const checks = workspaceAccess(options.access());
	for (let attempt = 1; ; attempt++) {
		const head = await options.store.load(workspaceId);
		if (head === undefined || head.organisationId !== ctx.organisationId) {
			throw new KantelError("not_found", `workspace ${workspaceId} not found`);
		}
		await checks.requireWorkspace(ctx, head.record, "operator", "workspace.remount");
		await checks.requireMounts(ctx, [request], { kind: "workspace", id: workspaceId });
		if (head.record.mounts.some((mount) => mount.path === request.path)) {
			return options.workspaces().remount(ctx, workspaceId, request);
		}
		// Resolving lists the source's root at the version: one it does not have fails here, before the record changes.
		const mount = await mountSources([options.source]).resolve(ctx, request);
		const mounts = [...head.record.mounts, mount];
		checkMountsDisjoint(mounts);
		const record: WorkspaceRecord = { ...head.record, mounts, updatedAt: options.now() };
		if (await options.store.update(head, { organisationId: head.organisationId, record, tree: head.tree }))
			return record;
		if (attempt >= ADD_ATTEMPTS) throw new KantelError("conflict", "the workspace changed while mounting skills");
	}
}
