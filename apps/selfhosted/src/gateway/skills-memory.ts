// A session's skills and memory on the self-hosted gateway (#12, as #194 meant it for each target):
//
//   skills   `Skills` (SQL on Postgres, each file's body in S3; in memory without a database). On a session's first
//            prompt the runtime pins what the session may see, the gateway mounts those pins read-only at `/skills` in
//            the session's workspace (the `skills` mount source of `@kantel/workspace/mounts`), and the skills its
//            profile names are listed through `renderSkillListings`, Pi's own `<available_skills>` block.
//   memory   `Memory` (SQL on Postgres; in memory without a database). On the same first prompt the runtime recalls over
//            the profile's `memoryScopes` with the memory's default renderer, and every session with memory scopes gets
//            `memory_search` and `memory_read`.
//
// What a session is given goes into its transcript as one `harbour.context` entry before its first prompt (a user
// message to the model); the system prompt is the profile's prompt layers and nothing else. A profile that names no
// skills and no memory scopes is given nothing.
//
// Where `/skills` is: a session created without a workspace gets one of its own, made as the session is created
// (`withOwnWorkspaces`), as every Cloudflare session has one (its `session_<id>`): so a session started from the
// console with no repository has its coding tools, `present_files` and `codemode`. When its profile names skills the
// workspace has the `/skills` mount, so its `read` and `ls` see `/skills/<name>/SKILL.md`. The exception is a host
// app's profile (one with a `hostId`) that names no skills: it keeps having no workspace, because the host app's worker
// may serve its own `read`, `write`, `edit` and `ls` as host tools, and the runtime's coding tools of those names would
// take their place (the runtime's own tools come first). A session started on an existing workspace keeps it:
// workspaces take their mounts when they are made, so `/skills` is there only if whoever made it mounted it.
import {
	type AgentProfiles,
	type CallContext,
	type Memory,
	type MountSource,
	type SessionDirectory,
	type SessionRecord,
	type SessionRuntime,
	type SessionSkillPin,
	type Skills,
	scopeOwner,
} from "@kantel/contracts";
import type { SessionRuntimeOptions, SessionRuntimeService } from "@kantel/runtime/core";
import { renderSkillListings } from "@kantel/skills/sources";
import { createSkillsMountSource, sessionSkillVisibility, skillsMountVersion } from "@kantel/workspace/mounts";
import type { StoredWorkspaces } from "@kantel/workspace/stored";

/** Where a session's skills are mounted, as their listings say (`SkillListing.path`). */
export const SKILLS_MOUNT = "/skills";

/** The prefix of the workspace a session gets when it is created without one. */
export const OWN_WORKSPACE_PREFIX = "session_";

/** The session's own agent, acting in its project: who pins, mounts and reads the session's skills. */
export function sessionAgentContext(record: SessionRecord): CallContext {
	return {
		actor: { kind: "agent", agentId: record.agentId, sessionId: record.id },
		organisationId: record.organisationId,
		projectId: record.projectId,
	};
}

/**
 * The `skills` mount source over the store: a mount's ref is a session ID, its version the session's pins. With
 * `profiles`, a session's pins include the skills its profile names that are shared into it.
 */
export function skillsMountSource(
	skills: Skills,
	directory: () => Pick<SessionDirectory, "get">,
	profiles?: () => Pick<AgentProfiles, "get">,
): MountSource {
	return createSkillsMountSource({
		skills,
		visibility: (ctx, sessionId) => sessionSkillVisibility(directory(), profiles?.())(ctx, sessionId),
	});
}

/**
 * The runtime's `skills` and `memory` settings. The workspaces are asked for only when a session's first prompt mounts
 * its skills, so they may be built after the runtime (they need its project access).
 */
export function sessionContextOptions(options: {
	readonly skills: Skills;
	readonly memory: Memory;
	readonly workspaces: () => StoredWorkspaces;
}): Required<Pick<SessionRuntimeOptions, "skills" | "memory">> {
	return {
		skills: {
			store: options.skills,
			render: (listings) => renderSkillListings(listings),
			mount: (session, pins) => mountSkills(options.workspaces(), session, pins),
		},
		memory: { store: options.memory },
	};
}

/**
 * Brings the session's `/skills` mount to its pins. The mount was pinned when the workspace was made, from the same
 * pins (`Skills.pinForSession` pins a session once), so this changes nothing unless the two disagree. A session with no
 * workspace, or on a workspace made without the mount, has nowhere to mount them: its listing names paths it cannot
 * read, which is what a session on such a workspace gets on every target.
 */
async function mountSkills(
	workspaces: StoredWorkspaces,
	session: SessionRecord,
	pins: readonly SessionSkillPin[],
): Promise<void> {
	if (session.workspaceId === undefined) return;
	const ctx = sessionAgentContext(session);
	const workspace = await workspaces.get(ctx, session.workspaceId);
	const mount = workspace.mounts.find((each) => each.path === SKILLS_MOUNT);
	if (mount === undefined || mount.source !== "skills" || mount.ref !== session.id) return;
	if (mount.version === skillsMountVersion(pins)) return;
	await workspaces.remount(ctx, session.workspaceId, { path: SKILLS_MOUNT, source: "skills", ref: session.id });
}

/** Whether a session of `profile` created without a workspace gets one of its own (see the top of this file). */
export function getsOwnWorkspace(profile: { readonly skills: readonly string[]; readonly hostId?: string }): boolean {
	return profile.skills.length > 0 || profile.hostId === undefined;
}

/**
 * The runtime, with each session created without a workspace given one of its own (`getsOwnWorkspace`): an empty
 * workspace in the session's project, with the session's skills mounted read-only at `/skills` when its profile names
 * any. It is made as the session's agent, right after the session, which is closed again if the workspace cannot be
 * made.
 */
export function withOwnWorkspaces(
	service: SessionRuntimeService,
	workspaces: () => StoredWorkspaces,
): SessionRuntimeService {
	const inner = service.runtime;
	const runtime: SessionRuntime = {
		...inner,
		async create(ctx, input) {
			if (input.workspaceId !== undefined) return inner.create(ctx, input);
			const profile = await service.profiles.get(ctx, input.agentId);
			if (!getsOwnWorkspace(profile)) return inner.create(ctx, input);
			const workspaceId = `${OWN_WORKSPACE_PREFIX}${crypto.randomUUID()}`;
			const record = await inner.create(ctx, { ...input, workspaceId });
			try {
				await workspaces().ensure(sessionAgentContext(record), workspaceId, {
					owner: scopeOwner(record),
					sessionId: record.id,
					...(profile.skills.length === 0
						? {}
						: { mounts: [{ path: SKILLS_MOUNT, source: "skills" as const, ref: record.id }] }),
				});
			} catch (error) {
				await inner.close(ctx, record.id).catch(() => undefined);
				throw error;
			}
			return record;
		},
	};
	return { ...service, runtime };
}
