/**
 * Project access: the one check every component makes before it acts on a project's records, or the organisation's.
 *
 * It is a scope check (docs/design/org-scope.md): each check resolves to one `AccessScope`, the project it names, else
 * the project of the session it names, else the organisation. A session may be scoped to the organisation (it has no
 * project), and its agent passes only checks that resolve to the organisation, never a project's. `ScopeAccess` is
 * the same interface under the name it is moving to.
 *
 * Settled 27 Oct 2026 (open question 7): the runtime and the components enforce it, never the caller or the target
 * alone. Each component calls `ProjectAccess.require` on every project-scoped call, for operators as well as agents. The
 * check uses identity's project and role model (`IdentityDirectory.roleOf`) for humans and services, and the session
 * directory for agents, which act through their session only:
 *
 * - `system` actors pass.
 * - A human or service needs at least `needed` on the project, from a role binding on the project or across the
 *   organisation; a service calling with an API key is limited to the key's projects and role.
 * - An agent passes only when its session exists in the call's organisation, runs as that agent, is not closed, and
 *   is in the check's scope: in the project for a project check, scoped to the organisation for an organisation
 *   check. It counts as an operator there, never an admin. When the call names a session, the agent must be acting in
 *   that session or in its parent (a supervisor of a child session). So a project agent passes an organisation check
 *   only through its own session (which resolves to its project), and an organisation agent no project's check.
 * - For an organisation check a human or service needs an organisation-wide binding; an API key, which holds roles
 *   only on its projects, never passes one.
 *
 * A refusal is `forbidden`, says the same thing whichever check failed, names no record beyond the project and holds no
 * secret, and is audited once as `access.denied`.
 *
 * Resources (docs/design/sharing.md): `resource` is the one check for using or changing a resource that may be owned
 * outside the project acting on it, such as another project's skill. It applies the owner rules above, then the
 * resource's bindings (maintainer, approver) and its active shares, read through `SharingLookup`. Without a lookup only
 * the owner rules apply, which is how every resource behaved before sharing. An agent never gets past `propose` this way,
 * except to `edit` through an active share that opts in to agent writes (`ResourceShare.agentWrites`).
 *
 * Worker calls (settled 27 Oct 2026, open question 13) are the calls Harbour makes on its own behalf and no caller
 * reaches: scheduler ticks and claims, audit appends and relays, retention, the egress gateway's decision, the sandbox
 * sweep, the browser's session end, and identity's `roleOf` and `authenticateApiKey`. Each takes a `SystemContext` and
 * calls `requireSystem` first, which refuses anything but a `system` actor (a missing caller included) the same way.
 */
import type { AuditEventInput, AuditSink } from "./audit.ts";
import {
	type AccessScope,
	type Actor,
	type CallContext,
	type Clock,
	HarbourError,
	isSystemActor,
	type OrganisationId,
	type OwnerRef,
	type ProjectId,
	type SessionId,
	type SystemContext,
	scopeOf,
	systemClock,
	systemContext,
} from "./common.ts";
import { type IdentityDirectory, type Role, roleSatisfies } from "./identity.ts";
import type { SessionDirectory, SessionRecord } from "./session.ts";
import {
	AGENT_MAX_PERMISSION,
	AGENT_WRITES_PERMISSION,
	type BindingSubject,
	DEFAULT_RESOURCE_POLICY,
	permissionSatisfies,
	type ResourcePolicy,
	type ResourceSelector,
	type ResourceShare,
	type ShareGrantee,
	type SharePermission,
	type SharingLookup,
	shareActive,
} from "./sharing.ts";

/** What a call needs. Name the project, the session, or both; with neither, the call needs an organisation-wide role. */
export interface AccessCheck {
	/** The project whose records the call reads or changes. */
	readonly projectId?: ProjectId;
	/**
	 * The session the call acts for or on. Its project is the one checked; when `projectId` is given too, the session
	 * must belong to it.
	 */
	readonly sessionId?: SessionId;
	readonly needed: Role;
	/** The operation, dotted, such as `vault.propose` or `workspace.commit`. Audited on a refusal. */
	readonly operation: string;
	/** The record acted on, audited on a refusal. Its ID only, never its contents. */
	readonly subject?: { readonly kind: string; readonly id: string };
}

/** What a passed check resolved. */
export interface AccessResult {
	/** The project checked: `check.projectId`, or the session's project. Absent for an organisation-wide check. */
	readonly projectId?: ProjectId;
	/** The scope checked: the project above, or the organisation. */
	readonly scope: AccessScope;
}

/**
 * Using or changing one resource. `use` asks whether the actor may use it where it acts (`projectId`, `sessionId`, or
 * an agent's own session); `propose`, `edit` and `approve` ask whether it may change it.
 */
export interface ResourceCheck {
	/** With `revision`, the revision about to be used; a share pinned to another revision doesn't cover it. */
	readonly resource: ResourceSelector;
	/** The resource's owner, as its component holds it. */
	readonly owner: OwnerRef;
	readonly permission: SharePermission;
	/**
	 * For `use`, the role needed where the actor acts (default `viewer`). For a change, the role the owner fallback needs
	 * on the owner, and a project share needs on its project (default `operator`): the component's own authority.
	 */
	readonly needed?: Role;
	/** For `use`: the project the resource is used in. */
	readonly projectId?: ProjectId;
	/** For `use`: the session it is used in. A use through a share is recorded against it. */
	readonly sessionId?: SessionId;
	/**
	 * The ways the check may pass; default all. Authority over a resource (sharing it, deciding its requests) passes
	 * only `["owner", "binding"]`: a share never lets its holder share on.
	 */
	readonly through?: readonly ("owner" | "binding" | "share")[];
	readonly operation: string;
}

/** How a resource check passed. */
export interface ResourceAccessResult {
	/** `owner`: the owner rules; `share`: an active share; `binding`: a maintainer or approver binding. */
	readonly via: "system" | "owner" | "share" | "binding";
	/** The project the actor acts in, when the check named or implied one. */
	readonly projectId?: ProjectId;
	/** The share that covered it, for `via: "share"`. A share pinned to a revision means that revision. */
	readonly share?: ResourceShare;
	readonly policy: ResourcePolicy;
}

export interface ProjectAccess {
	/** Resolves when `ctx.actor` may make the call; otherwise audits `access.denied` and rejects with `forbidden`. */
	require(ctx: CallContext, check: AccessCheck): Promise<AccessResult>;
	/** Whether `require` would pass, without auditing. For filtering lists to what the actor may see. */
	allows(ctx: CallContext, check: Omit<AccessCheck, "operation" | "subject">): Promise<boolean>;
	/**
	 * Resolves how `ctx.actor` may use or change a resource; otherwise audits `access.denied` and rejects with
	 * `forbidden`, as `require` does. A use through a share in a session is recorded (`SharingLookup.recordUse`).
	 */
	resource(ctx: CallContext, check: ResourceCheck): Promise<ResourceAccessResult>;
	/** What `resource` would resolve, or `undefined` where it would refuse; without auditing or recording. */
	allowsResource(ctx: CallContext, check: Omit<ResourceCheck, "operation">): Promise<ResourceAccessResult | undefined>;
}

/** `ProjectAccess` under the name it is moving to: it checks a project or an organisation scope. */
export type ScopeAccess = ProjectAccess;

/** The role an agent counts as holding on its own session's project. */
export const AGENT_ROLE: Role = "operator";

export interface ProjectAccessOptions {
	/** Role bindings and API keys. */
	readonly identity: Pick<IdentityDirectory, "roleOf">;
	/** The session directory; read with a system context in the call's organisation. */
	readonly sessions: Pick<SessionDirectory, "get">;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
	/** Shares, bindings and policies, for `resource`. Without it only the owner rules apply. */
	readonly sharing?: SharingLookup;
}

const ACCESS_ACTOR: Actor = { kind: "system", component: "access" };
const ACCESS_CONTEXT: SystemContext = systemContext("access");
const REFUSAL = "The caller may not do this in this project";
const WORKER_REFUSAL = "Only Harbour's own components may make this call";
const RESOURCE_REFUSAL = "The caller may not do this with this resource";

function sameSubject(a: BindingSubject, b: BindingSubject): boolean {
	switch (a.kind) {
		case "user":
			return b.kind === "user" && b.userId === a.userId;
		case "service":
			return b.kind === "service" && b.serviceId === a.serviceId;
		case "group":
			return b.kind === "group" && b.groupId === a.groupId;
	}
}

/**
 * The organisation `access.denied` rows go under when a refused worker call names none, such as a scheduler tick with
 * no caller. No organisation has this ID.
 */
export const PLATFORM_ORGANISATION: OrganisationId = "harbour:platform";

export interface RequireSystemOptions {
	/** Where the refusal is audited. A component passes its own sink; the audit store records into itself. */
	readonly audit?: AuditSink;
	readonly clock?: Clock;
	/** The organisation the call concerns, when it names one (an egress request's). Else the context's, if any. */
	readonly organisationId?: OrganisationId;
}

/**
 * The check every worker call makes first (settled question 13). Resolves when `ctx` is a `system` actor's; otherwise
 * audits `access.denied` once, with the operation and the caller's kind (`missing` when there is none), and rejects
 * with `forbidden`. The refusal says the same thing whoever called, and holds nothing from the call's input.
 */
export async function requireSystem(
	ctx: SystemContext | undefined,
	operation: string,
	options: RequireSystemOptions = {},
): Promise<void> {
	const actor: unknown = typeof ctx === "object" && ctx !== null ? ctx.actor : undefined;
	if (isSystemActor(actor)) return;
	if (options.audit !== undefined) {
		const caller = describeCaller(actor);
		const contextOrganisation = typeof ctx?.organisationId === "string" ? ctx.organisationId : undefined;
		const event: AuditEventInput = {
			id: `access:denied:${crypto.randomUUID()}`,
			at: (options.clock ?? systemClock).now(),
			source: "access",
			type: "access.denied",
			actor: caller.actor ?? ACCESS_ACTOR,
			organisationId: options.organisationId ?? contextOrganisation ?? PLATFORM_ORGANISATION,
			data: { operation, needed: "system", caller: caller.kind },
		};
		await options.audit.append(ACCESS_CONTEXT, [event]);
	}
	throw new HarbourError("forbidden", WORKER_REFUSAL, { operation });
}

/** The caller's kind for the audit row, and its actor when it is a well-formed one. */
function describeCaller(actor: unknown): { readonly kind: string; readonly actor?: Actor } {
	if (typeof actor !== "object" || actor === null) return { kind: "missing" };
	const candidate = actor as Actor;
	switch (candidate.kind) {
		case "human":
			return typeof candidate.userId === "string" ? { kind: "human", actor: candidate } : { kind: "malformed" };
		case "service":
			return typeof candidate.serviceId === "string" ? { kind: "service", actor: candidate } : { kind: "malformed" };
		case "agent":
			return typeof candidate.agentId === "string" && typeof candidate.sessionId === "string"
				? { kind: "agent", actor: candidate }
				: { kind: "malformed" };
		default:
			return { kind: "malformed" };
	}
}

/**
 * The reference `ProjectAccess`, over any `IdentityDirectory` and `SessionDirectory`. It holds no state of its own, so
 * every target can use it as it is.
 */
export function createProjectAccess(options: ProjectAccessOptions): ProjectAccess {
	const clock = options.clock ?? systemClock;

	const sessionOf = async (ctx: CallContext, sessionId: SessionId): Promise<SessionRecord | undefined> => {
		try {
			return await options.sessions.get({ actor: ACCESS_ACTOR, organisationId: ctx.organisationId }, sessionId);
		} catch {
			return undefined;
		}
	};

	const decide = async (
		ctx: CallContext,
		check: Omit<AccessCheck, "operation" | "subject">,
	): Promise<{ readonly allowed: boolean; readonly projectId?: ProjectId }> => {
		const actor = ctx.actor;
		const result = (allowed: boolean, projectId: ProjectId | undefined) =>
			projectId === undefined ? { allowed } : { allowed, projectId };
		let projectId = check.projectId;
		let target: SessionRecord | undefined;
		if (check.sessionId !== undefined) {
			target = await sessionOf(ctx, check.sessionId);
			// Harbour's own components may tidy up after a session the directory no longer knows.
			if (target === undefined) return result(actor.kind === "system", projectId);
			if (projectId !== undefined && target.projectId !== projectId) return result(false, projectId);
			projectId = target.projectId;
		}
		if (actor.kind === "system") return result(true, projectId);
		if (actor.kind === "agent") {
			if (!roleSatisfies(AGENT_ROLE, check.needed)) return result(false, projectId);
			const own = await sessionOf(ctx, actor.sessionId);
			if (own === undefined || own.agentId !== actor.agentId || own.status === "done") return result(false, projectId);
			// The agent's own session must be in the check's scope: the same project, or both the organisation. An
			// organisation check that names no session is one only an organisation session's agent passes.
			if (own.projectId !== projectId) return result(false, projectId);
			// An agent acts in its own session, or as the supervisor of a child session.
			if (target !== undefined && target.id !== own.id && target.parentSessionId !== own.id) {
				return result(false, projectId);
			}
			return result(true, projectId);
		}
		const held = await options.identity.roleOf(ACCESS_CONTEXT, actor, ctx.organisationId, projectId);
		return result(held !== undefined && roleSatisfies(held, check.needed), projectId);
	};

	const sharing = options.sharing;
	const passes = async (ctx: CallContext, check: Omit<AccessCheck, "operation" | "subject">) =>
		(await decide(ctx, check)).allowed;

	/** The groups a human or service is a member of, read once per check. */
	const subjectOf = (actor: Actor): BindingSubject | undefined =>
		actor.kind === "human"
			? { kind: "user", userId: actor.userId }
			: actor.kind === "service"
				? { kind: "service", serviceId: actor.serviceId }
				: undefined;

	const viaBinding = async (ctx: CallContext, check: Omit<ResourceCheck, "operation">): Promise<boolean> => {
		const subject = subjectOf(ctx.actor);
		if (sharing === undefined || subject === undefined || check.permission === "use") return false;
		const bindings = await sharing.bindingsOf(ACCESS_CONTEXT, ctx.organisationId, {
			kind: check.resource.kind,
			id: check.resource.id,
		});
		const relations = new Set(check.permission === "approve" ? ["approver"] : ["maintainer", "approver"]);
		const relevant = bindings.filter((binding) => relations.has(binding.relation));
		if (relevant.length === 0) return false;
		if (relevant.some((binding) => sameSubject(binding.subject, subject))) return true;
		const groups = new Set(await sharing.groupsOf(ACCESS_CONTEXT, ctx.organisationId, subject));
		return relevant.some((binding) => binding.subject.kind === "group" && groups.has(binding.subject.groupId));
	};

	/** The owner rules alone: whether the actor may use or change the resource without a share or binding. */
	const viaOwner = async (
		ctx: CallContext,
		check: Omit<ResourceCheck, "operation">,
		where: { readonly projectId?: ProjectId; readonly sessionId?: SessionId },
		needed: Role,
	): Promise<boolean> => {
		const actor = ctx.actor;
		const owner = check.owner;
		const ownSession = actor.kind === "agent" ? { sessionId: actor.sessionId } : {};
		if (check.permission === "use") {
			if (owner.kind === "platform" || owner.kind === "organisation") {
				// Organisation-wide resources stay usable in every project, as before sharing.
				if (where.projectId === undefined && where.sessionId === undefined) return actor.kind !== "agent";
				return passes(ctx, { ...where, needed });
			}
			if (owner.kind === "project") {
				if (where.projectId !== undefined && where.projectId !== owner.projectId) {
					// A person or service reading from another project still may as a member of the owner's; a session may not.
					return (
						where.sessionId === undefined &&
						actor.kind !== "agent" &&
						passes(ctx, { projectId: owner.projectId, needed })
					);
				}
				return passes(ctx, { ...where, projectId: owner.projectId, needed });
			}
			return actor.kind === "human" && actor.userId === owner.userId;
		}
		switch (owner.kind) {
			case "platform":
				return false;
			case "organisation":
				return passes(ctx, { ...ownSession, needed });
			case "project":
				return passes(ctx, { ...ownSession, projectId: owner.projectId, needed });
			case "user":
				// The person themselves; anyone else as on an organisation's resource, as components checked before sharing.
				if (actor.kind === "human" && actor.userId === owner.userId) return true;
				return passes(ctx, { ...ownSession, needed });
		}
		return false;
	};

	/** An active share of the resource covering the actor where it acts, at the permission asked. */
	const viaShare = async (
		ctx: CallContext,
		check: Omit<ResourceCheck, "operation">,
		where: { readonly projectId?: ProjectId; readonly sessionId?: SessionId },
		needed: Role,
	): Promise<{ readonly share: ResourceShare; readonly projectId?: ProjectId } | undefined> => {
		if (sharing === undefined) return undefined;
		const now = clock.now();
		// An agent above its cap is covered only by a share that lets agents write (and never to approve).
		const agentWrite = ctx.actor.kind === "agent" && !permissionSatisfies(AGENT_MAX_PERMISSION, check.permission);
		const candidates = (
			await sharing.sharesOf(ACCESS_CONTEXT, ctx.organisationId, {
				kind: check.resource.kind,
				id: check.resource.id,
			})
		).filter(
			(share) =>
				share.organisationId === ctx.organisationId &&
				shareActive(share, now) &&
				permissionSatisfies(share.permission, check.permission) &&
				(!agentWrite || (share.agentWrites && permissionSatisfies(AGENT_WRITES_PERMISSION, check.permission))) &&
				(share.resource.revision === undefined ||
					check.resource.revision === undefined ||
					share.resource.revision === check.resource.revision),
		);
		if (candidates.length === 0) return undefined;
		const actor = ctx.actor;
		// The session the actor acts in: the one named, else an agent's own.
		const sessionId = where.sessionId ?? (actor.kind === "agent" ? actor.sessionId : undefined);
		const session = sessionId === undefined ? undefined : await sessionOf(ctx, sessionId);
		if (sessionId !== undefined && session === undefined) return undefined;
		const projectId = where.projectId ?? session?.projectId;
		if (session !== undefined && projectId !== undefined && session.projectId !== projectId) return undefined;
		const matches = (grantee: ShareGrantee): boolean => {
			switch (grantee.kind) {
				case "project":
					return projectId !== undefined && grantee.projectId === projectId;
				case "session":
					return session !== undefined && grantee.sessionId === session.id;
				case "agent":
					return session !== undefined && grantee.agentId === session.agentId;
				case "user":
					return actor.kind === "human" && grantee.userId === actor.userId;
			}
		};
		if (check.permission === "use") {
			const share = candidates.find((candidate) => matches(candidate.grantee));
			if (share === undefined) return undefined;
			// The actor must also act in that project or session at all.
			if (projectId !== undefined || sessionId !== undefined) {
				const scope = {
					...(projectId === undefined ? {} : { projectId }),
					...(sessionId === undefined ? {} : { sessionId }),
				};
				if (!(await passes(ctx, { ...scope, needed }))) return undefined;
			} else if (share.grantee.kind !== "user") {
				return undefined;
			}
			return projectId === undefined ? { share } : { share, projectId };
		}
		// A change: through a project where the actor holds `needed`, as that user, or in that session or agent.
		for (const share of candidates) {
			const grantee = share.grantee;
			if (actor.kind === "agent") {
				const own = session ?? (await sessionOf(ctx, actor.sessionId));
				if (own === undefined || own.agentId !== actor.agentId || own.status === "done") continue;
				const covered =
					(grantee.kind === "project" && grantee.projectId === own.projectId) ||
					(grantee.kind === "session" && grantee.sessionId === own.id) ||
					(grantee.kind === "agent" && grantee.agentId === own.agentId);
				if (covered && (await passes(ctx, { sessionId: own.id, needed }))) return { share, projectId: own.projectId };
				continue;
			}
			if (grantee.kind === "user" && actor.kind === "human" && grantee.userId === actor.userId) return { share };
			if (grantee.kind === "project" && (await passes(ctx, { projectId: grantee.projectId, needed }))) {
				return { share, projectId: grantee.projectId };
			}
		}
		return undefined;
	};

	const decideResource = async (
		ctx: CallContext,
		check: Omit<ResourceCheck, "operation">,
	): Promise<ResourceAccessResult | undefined> => {
		const actor = ctx.actor;
		const owner = check.owner;
		if (owner.kind !== "platform" && owner.organisationId !== ctx.organisationId) return undefined;
		const policy = async (): Promise<ResourcePolicy> =>
			sharing === undefined
				? DEFAULT_RESOURCE_POLICY
				: await sharing.policyOf(ACCESS_CONTEXT, ctx.organisationId, {
						kind: check.resource.kind,
						id: check.resource.id,
					});
		// Where the actor acts: as named, else an agent's own session.
		const sessionId =
			check.sessionId ?? (actor.kind === "agent" && check.projectId === undefined ? actor.sessionId : undefined);
		// A person or service acts in the call's project unless the check names one.
		const projectId =
			check.projectId ?? (actor.kind !== "agent" && sessionId === undefined ? ctx.projectId : undefined);
		const where = {
			...(projectId === undefined ? {} : { projectId }),
			...(sessionId === undefined ? {} : { sessionId }),
		};
		if (actor.kind === "system") {
			return {
				via: "system",
				...(check.projectId === undefined ? {} : { projectId: check.projectId }),
				policy: await policy(),
			};
		}
		// Agents draft and propose; they never edit or approve, except to write through a share that opts in to it
		// (`agentWrites`), and then only through that share: not as the owner's, nor through a binding.
		const agentWrite = actor.kind === "agent" && !permissionSatisfies(AGENT_MAX_PERMISSION, check.permission);
		if (agentWrite && !permissionSatisfies(AGENT_WRITES_PERMISSION, check.permission)) return undefined;
		const needed = check.needed ?? (check.permission === "use" ? "viewer" : "operator");
		const through = new Set<"owner" | "binding" | "share">(
			agentWrite
				? (check.through ?? ["share"]).filter((way) => way === "share")
				: (check.through ?? ["owner", "binding", "share"]),
		);
		if (through.has("owner") && (await viaOwner(ctx, check, where, needed))) {
			const projectId = check.projectId ?? (owner.kind === "project" ? owner.projectId : undefined);
			return { via: "owner", ...(projectId === undefined ? {} : { projectId }), policy: await policy() };
		}
		if (through.has("binding") && (await viaBinding(ctx, check))) return { via: "binding", policy: await policy() };
		const shared = through.has("share") ? await viaShare(ctx, check, where, needed) : undefined;
		if (shared !== undefined) {
			return {
				via: "share",
				share: shared.share,
				...(shared.projectId === undefined ? {} : { projectId: shared.projectId }),
				policy: await policy(),
			};
		}
		return undefined;
	};

	return {
		async resource(ctx, check) {
			const decided = await decideResource(ctx, check);
			if (decided !== undefined) {
				const sessionId = check.sessionId ?? (ctx.actor.kind === "agent" ? ctx.actor.sessionId : undefined);
				if (
					decided.share !== undefined &&
					sharing !== undefined &&
					sessionId !== undefined &&
					check.permission === "use"
				) {
					const revision = check.resource.revision ?? decided.share.resource.revision;
					await sharing.recordUse(ACCESS_CONTEXT, {
						organisationId: ctx.organisationId,
						sessionId,
						resource: {
							kind: check.resource.kind,
							id: check.resource.id,
							...(revision === undefined ? {} : { revision }),
						},
						shareId: decided.share.id,
						usedAt: clock.now(),
					});
				}
				return decided;
			}
			if (options.audit !== undefined) {
				const projectId = check.projectId ?? (check.owner.kind === "project" ? check.owner.projectId : undefined);
				const event: AuditEventInput = {
					id: `access:denied:${crypto.randomUUID()}`,
					at: clock.now(),
					source: "access",
					type: "access.denied",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...(projectId === undefined ? {} : { projectId }),
					...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId, agentId: ctx.actor.agentId } : {}),
					subject: { kind: check.resource.kind, id: check.resource.id },
					data: {
						operation: check.operation,
						permission: check.permission,
						...(check.needed === undefined ? {} : { needed: check.needed }),
						...(check.sessionId === undefined ? {} : { targetSessionId: check.sessionId }),
					},
				};
				await options.audit.append(ACCESS_CONTEXT, [event]);
			}
			throw new HarbourError("forbidden", RESOURCE_REFUSAL, { operation: check.operation });
		},
		async allowsResource(ctx, check) {
			return decideResource(ctx, check);
		},
		async require(ctx, check) {
			const { allowed, projectId } = await decide(ctx, check);
			if (allowed) return { ...(projectId === undefined ? {} : { projectId }), scope: scopeOf({ projectId }) };
			if (options.audit !== undefined) {
				const event: AuditEventInput = {
					id: `access:denied:${crypto.randomUUID()}`,
					at: clock.now(),
					source: "access",
					type: "access.denied",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...(projectId === undefined ? {} : { projectId }),
					...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId, agentId: ctx.actor.agentId } : {}),
					...(check.subject === undefined ? {} : { subject: { kind: check.subject.kind, id: check.subject.id } }),
					data: {
						operation: check.operation,
						needed: check.needed,
						...(check.sessionId === undefined ? {} : { targetSessionId: check.sessionId }),
					},
				};
				await options.audit.append(ACCESS_CONTEXT, [event]);
			}
			throw new HarbourError("forbidden", REFUSAL, { operation: check.operation });
		},
		async allows(ctx, check) {
			return (await decide(ctx, check)).allowed;
		},
	};
}
