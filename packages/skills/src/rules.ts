/**
 * The rules every `Skills` store applies, whatever keeps its records: owners and who may change them, project access,
 * file preparation, visibility and the audit events. Shared by the in-memory store (`./memory.ts`) and the SQL one
 * (`./sql.ts`), so the two cannot drift apart. Not exported from the package.
 */
import {
	type AuditSink,
	authorKey,
	type CallContext,
	type Clock,
	DEFAULT_RESOURCE_POLICY,
	DEFAULT_SKILLS_AUTHORITY,
	KantelError,
	type JsonValue,
	type OwnerRef,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type ResourcePolicy,
	type Role,
	type SessionId,
	type SessionSkillPin,
	type SharePermission,
	type SkillFile,
	type SkillRevision,
	type SkillsAuthority,
	type SkillVisibility,
	systemContext,
} from "@kantel/contracts";
import { normaliseSkillPath, SKILL_MD } from "./index.ts";

/** Skills appends its audit events as itself. */
const AUDIT_CONTEXT = systemContext("skills");

export type Extensions = { readonly [namespace: string]: JsonValue };
export type Source = { readonly sourceId: string; readonly ref: string };

/** Name clashes in a listing go to the most specific owner. */
export const OWNER_RANK: { readonly [kind in OwnerRef["kind"]]: number } = {
	platform: 0,
	organisation: 1,
	project: 2,
	user: 3,
};

export function ownerKey(owner: OwnerRef): string {
	switch (owner.kind) {
		case "platform":
			return "platform";
		case "organisation":
			return `organisation:${owner.organisationId}`;
		case "project":
			return `project:${owner.organisationId}:${owner.projectId}`;
		case "user":
			return `user:${owner.organisationId}:${owner.userId}`;
	}
}

export function copyOwner(owner: OwnerRef): OwnerRef {
	switch (owner.kind) {
		case "platform":
			return { kind: "platform" };
		case "organisation":
			return { kind: "organisation", organisationId: owner.organisationId };
		case "project":
			return { kind: "project", organisationId: owner.organisationId, projectId: owner.projectId };
		case "user":
			return { kind: "user", organisationId: owner.organisationId, userId: owner.userId };
	}
}

export function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		for (const inner of Object.values(value)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
}

export function byPath(a: { readonly path: string }, b: { readonly path: string }): number {
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new KantelError("forbidden", `An agent cannot ${what}`);
}

/** Platform skills are Kantel's own: only a `system` actor may create or change them. */
export function assertMayOwn(ctx: CallContext, owner: OwnerRef): void {
	if (owner.kind === "platform") {
		if (ctx.actor.kind !== "system") throw new KantelError("forbidden", "Only Kantel may change platform skills");
		return;
	}
	if (owner.organisationId !== ctx.organisationId) {
		throw new KantelError("invalid", "A skill must be owned within the caller's organisation");
	}
}

/** A package is readable by its organisation, and a platform package by every organisation. */
export function ownerVisibleTo(ctx: CallContext, owner: OwnerRef): boolean {
	return owner.kind === "platform" || owner.organisationId === ctx.organisationId;
}

export function assertDescription(description: string): void {
	if (typeof description !== "string" || description.trim() === "") {
		throw new KantelError("invalid", "A skill needs a description");
	}
}

/** Normalised, frozen copies of a package's files, sorted by path; `invalid` without `SKILL.md` or with a duplicate. */
export function prepareFiles(files: readonly SkillFile[]): readonly SkillFile[] {
	const seen = new Set<string>();
	const prepared: SkillFile[] = [];
	for (const file of files) {
		if (typeof file.content !== "string") throw new KantelError("invalid", `${file.path} needs text content`);
		const path = normaliseSkillPath(file.path);
		if (seen.has(path)) throw new KantelError("invalid", `${path} appears twice`);
		seen.add(path);
		prepared.push(Object.freeze({ path, content: file.content }));
	}
	if (!seen.has(SKILL_MD)) throw new KantelError("invalid", `A skill package needs ${SKILL_MD} at its root`);
	return Object.freeze(prepared.sort(byPath));
}

export function utf8Size(content: string): number {
	return new TextEncoder().encode(content).length;
}

export function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new KantelError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

/** A store's authority, checked: each change a role. Without one, `DEFAULT_SKILLS_AUTHORITY`. */
export function authorityOf(authority: SkillsAuthority | undefined): SkillsAuthority {
	if (authority === undefined) return DEFAULT_SKILLS_AUTHORITY;
	const roles = new Set<unknown>(["viewer", "operator", "admin"]);
	for (const change of Object.keys(DEFAULT_SKILLS_AUTHORITY) as (keyof SkillsAuthority)[]) {
		if (!roles.has(authority[change])) {
			throw new KantelError("invalid", `The skills authority needs a role for ${change}`);
		}
	}
	return Object.freeze({
		create: authority.create,
		saveDraft: authority.saveDraft,
		publish: authority.publish,
		importRevision: authority.importRevision,
	});
}

/**
 * Checks the role a change needs on a skill of `owner` (`SkillsAuthority`): on the project for a project's skill;
 * otherwise across the organisation, except that a human user always may change their own skills. An agent acts
 * through its own open session, as an operator. Platform skills are `assertMayOwn`'s. Without `access` the store
 * checks only the organisation.
 */
export async function requireWrite(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	owner: OwnerRef,
	needed: Role,
	operation: string,
	skillId?: string,
): Promise<void> {
	if (access === undefined || owner.kind === "platform") return;
	const actor = ctx.actor;
	if (owner.kind === "user" && actor.kind === "human" && actor.userId === owner.userId) return;
	await access.require(ctx, {
		...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
		...(actor.kind === "agent" ? { sessionId: actor.sessionId } : {}),
		needed,
		operation,
		...(skillId === undefined ? {} : { subject: { kind: "skills.skill", id: skillId } }),
	});
}

/** A skill's resource kind (docs/design/sharing.md). */
export const SKILL_KIND = "skills.skill";

/**
 * Checks a read of a project's skill (`ProjectAccess.resource`, `use`): viewer on its project, or an active share
 * covering where the caller acts, at `revision` when given. Other owners' skills are open to their organisation.
 */
export async function requireUse(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	owner: OwnerRef,
	operation: string,
	skillId: string,
	revision?: number,
): Promise<void> {
	if (access === undefined || owner.kind !== "project") return;
	await access.resource(ctx, {
		resource: { kind: SKILL_KIND, id: skillId, ...(revision === undefined ? {} : { revision }) },
		owner,
		permission: "use",
		needed: "viewer",
		operation,
	});
}

/**
 * Checks a change to an existing skill (`ProjectAccess.resource`): the `SkillsAuthority` role on its owner (as
 * `requireWrite`), a maintainer or approver binding, or a share at `permission`. Resolves the skill's policy.
 */
export async function requireChange(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	owner: OwnerRef,
	permission: SharePermission,
	needed: Role,
	operation: string,
	skillId: string,
): Promise<ResourcePolicy> {
	if (access === undefined || owner.kind === "platform") return DEFAULT_RESOURCE_POLICY;
	const resolved = await access.resource(ctx, {
		resource: { kind: SKILL_KIND, id: skillId },
		owner,
		permission,
		needed,
		operation,
	});
	return resolved.policy;
}

/** Saving a draft: an agent proposes, everyone else edits. */
export function draftPermission(ctx: CallContext): SharePermission {
	return ctx.actor.kind === "agent" ? "propose" : "edit";
}

/** The two-person rule: with it on, no one who saved the open draft may publish it. */
export function assertNotAuthor(policy: ResourcePolicy, ctx: CallContext, authors: readonly string[]): void {
	if (policy.twoPersonRule && authors.includes(authorKey(ctx.actor))) {
		throw new KantelError("forbidden", "This skill needs a second person to publish: you saved its draft", {
			reason: "two_person_rule",
		});
	}
}

/** A skill named in `SkillVisibility.shared`, as a store finds it. */
export interface SharedCandidate {
	readonly skillId: string;
	readonly owner: OwnerRef;
	readonly name: string;
	readonly latestRevision?: number;
}

/**
 * Of the skills `visibility.shared` asks for, those owned outside the visibility that a share lets the caller use,
 * with the revision to show: the share's pinned one, else the latest. With `sessionId` (pinning), each is checked
 * with `ProjectAccess.resource`, so the use is recorded against the session's share and a refusal is audited;
 * otherwise only `allowsResource`.
 */
export async function sharedSkills(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	visibility: SkillVisibility,
	find: (skillId: string) => Promise<SharedCandidate | undefined>,
	sessionId?: SessionId,
): Promise<readonly (SharedCandidate & { readonly revision: number })[]> {
	if (access === undefined || visibility.shared === undefined) return [];
	const found: (SharedCandidate & { readonly revision: number })[] = [];
	const where =
		sessionId !== undefined
			? { sessionId }
			: visibility.projectId !== undefined
				? { projectId: visibility.projectId }
				: {};
	for (const skillId of new Set(visibility.shared)) {
		if (typeof skillId !== "string") continue;
		const candidate = await find(skillId);
		if (candidate === undefined || candidate.latestRevision === undefined) continue;
		if (candidate.owner.kind === "platform" || candidate.owner.organisationId !== ctx.organisationId) continue;
		if (visibleOwner(ctx, visibility, candidate.owner)) continue;
		const check = {
			resource: { kind: SKILL_KIND, id: skillId },
			owner: candidate.owner,
			permission: "use",
			...where,
		} as const;
		const allowed = await access.allowsResource(ctx, check);
		if (allowed === undefined) {
			if (sessionId !== undefined) {
				// Refused: audited as `access.denied`, and left out.
				await access.resource(ctx, { ...check, operation: "skills.pinForSession" }).catch((error: unknown) => {
					if (!(error instanceof KantelError && error.code === "forbidden")) throw error;
				});
			}
			continue;
		}
		const revision = allowed.share?.resource.revision ?? candidate.latestRevision;
		if (revision > candidate.latestRevision) continue;
		if (sessionId !== undefined) {
			await access.resource(ctx, {
				...check,
				resource: { kind: SKILL_KIND, id: skillId, revision },
				operation: "skills.pinForSession",
			});
		}
		found.push({ ...candidate, revision });
	}
	return found;
}

/** The visible listings with the shared skills added: asked for by ID, a shared skill replaces one of its name. */
export function withShared<T extends { readonly name: string }>(visible: readonly T[], shared: readonly T[]): T[] {
	const names = new Set(shared.map((listing) => listing.name));
	const seen = new Set<string>();
	const merged = [...visible.filter((listing) => !names.has(listing.name))];
	for (const listing of shared) {
		if (seen.has(listing.name)) continue;
		seen.add(listing.name);
		merged.push(listing);
	}
	return merged.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * A visibility may name only the calling human's own user; services and Kantel may name any user, agents none.
 * Not a project check, so a refusal is not audited as `access.denied`.
 */
export function assertMayNameUser(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	visibility: SkillVisibility,
): void {
	if (access === undefined || visibility.userId === undefined) return;
	const actor = ctx.actor;
	if (actor.kind === "service" || actor.kind === "system") return;
	if (actor.kind === "human" && actor.userId === visibility.userId) return;
	throw new KantelError("forbidden", "A caller may name only its own user's skills");
}

/** The checks `list` makes before it reads anything. */
export async function checkList(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	visibility: SkillVisibility,
): Promise<void> {
	assertMayNameUser(access, ctx, visibility);
	if (access !== undefined && visibility.projectId !== undefined) {
		await access.require(ctx, { projectId: visibility.projectId, needed: "viewer", operation: "skills.list" });
	}
}

/** The checks `pinForSession` makes before it reads anything. */
export async function checkPin(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	sessionId: SessionId,
	visibility: SkillVisibility,
): Promise<void> {
	if (ctx.actor.kind === "agent" && ctx.actor.sessionId !== sessionId) {
		throw new KantelError("forbidden", "An agent may pin skills only for its own session");
	}
	assertMayNameUser(access, ctx, visibility);
	if (access !== undefined) {
		// The session must belong to the project the visibility names.
		await access.require(ctx, {
			sessionId,
			...(visibility.projectId === undefined ? {} : { projectId: visibility.projectId }),
			needed: "operator",
			operation: "skills.pinForSession",
		});
	}
}

/** The checks `importRevision` makes before it reads anything. */
export async function checkImport(
	access: ProjectAccess | undefined,
	authority: SkillsAuthority,
	ctx: CallContext,
	input: { readonly owner: OwnerRef; readonly name: string; readonly description: string; readonly source: Source },
	validateName: (name: string) => void,
): Promise<void> {
	forbidAgent(ctx, "import skills");
	assertMayOwn(ctx, input.owner);
	await requireWrite(access, ctx, input.owner, authority.importRevision, "skills.importRevision");
	validateName(input.name);
	assertDescription(input.description);
	if (input.source.sourceId === "" || input.source.ref === "") {
		throw new KantelError("invalid", "An import needs a source ID and a ref");
	}
}

/** Whether a session with `visibility` sees a package of `owner`, before name clashes are settled. */
export function visibleOwner(ctx: CallContext, visibility: SkillVisibility, owner: OwnerRef): boolean {
	return (
		owner.kind === "platform" ||
		(owner.organisationId === ctx.organisationId &&
			(owner.kind === "organisation" ||
				(owner.kind === "project" && visibility.projectId !== undefined && owner.projectId === visibility.projectId) ||
				(owner.kind === "user" && visibility.userId !== undefined && owner.userId === visibility.userId)))
	);
}

/** Of the visible packages, the most specific owner's per name, sorted by name. */
export function chooseByName<T extends { readonly owner: OwnerRef; readonly name: string }>(
	candidates: Iterable<T>,
): T[] {
	const chosen = new Map<string, T>();
	for (const candidate of candidates) {
		const current = chosen.get(candidate.name);
		if (current === undefined || OWNER_RANK[candidate.owner.kind] > OWNER_RANK[current.owner.kind]) {
			chosen.set(candidate.name, candidate);
		}
	}
	return [...chosen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The audit events a store appends, as its actor. Data holds names, digests and counts, never file contents. */
export function skillsAudit(audit: AuditSink | undefined, clock: Clock) {
	async function change(
		ctx: CallContext,
		event: {
			readonly id: string;
			readonly type: string;
			readonly subjectId: string;
			readonly data: { readonly [key: string]: JsonValue };
		},
	): Promise<void> {
		if (audit === undefined) return;
		await audit.append(AUDIT_CONTEXT, [
			{
				id: event.id,
				at: clock.now(),
				source: "skills",
				type: event.type,
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				subject: { kind: "skills.skill", id: event.subjectId },
				data: event.data,
			},
		]);
	}

	return {
		created: (ctx: CallContext, pkg: { readonly id: string; readonly name: string; readonly owner: OwnerRef }) =>
			change(ctx, {
				id: `skills:package:${pkg.id}:created`,
				type: "skills.package.created",
				subjectId: pkg.id,
				data: { name: pkg.name, owner: pkg.owner.kind },
			}),

		draftSaved: (
			ctx: CallContext,
			draft: { readonly skillId: string; readonly name: string; readonly digest: string; readonly files: number },
			saves: number,
		) =>
			change(ctx, {
				id: `skills:draft:${draft.skillId}:${saves}`,
				type: "skills.draft.saved",
				subjectId: draft.skillId,
				data: { name: draft.name, digest: draft.digest, files: draft.files },
			}),

		async published(ctx: CallContext, revision: SkillRevision): Promise<void> {
			if (audit === undefined) return;
			await audit.append(AUDIT_CONTEXT, [
				{
					id: `skills:revision:${revision.skillId}:${revision.revision}`,
					at: revision.publishedAt,
					source: "skills",
					type: "skills.revision.published",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
					subject: { kind: "skills.skill", id: revision.skillId },
					data: {
						name: revision.name,
						revision: revision.revision,
						digest: revision.digest,
						...(revision.source === undefined ? {} : { source: { ...revision.source } }),
					},
				},
			]);
		},

		async pinned(ctx: CallContext, sessionId: SessionId, pins: readonly SessionSkillPin[], at: number): Promise<void> {
			if (audit === undefined) return;
			await audit.append(AUDIT_CONTEXT, [
				{
					id: `skills:session:${ctx.organisationId}:${sessionId}:pinned`,
					at,
					source: "skills",
					type: "skills.session.pinned",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
					sessionId,
					data: { pins: pins.map((pin) => ({ skillId: pin.skillId, revision: pin.revision })) },
				},
			]);
		},
	};
}
