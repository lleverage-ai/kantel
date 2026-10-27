/**
 * Project access: the one check every component makes before it acts on a project's records.
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
 *   belongs to the project. It counts as an operator there, never an admin. When the call names a session, the agent
 *   must be acting in that session or in its parent (a supervisor of a child session).
 *
 * A refusal is `forbidden`, says the same thing whichever check failed, names no record beyond the project and holds no
 * secret, and is audited once as `access.denied`.
 *
 * Worker calls (settled 27 Oct 2026, open question 13) are the calls Harbour makes on its own behalf and no caller
 * reaches: scheduler ticks and claims, audit appends and relays, retention, the egress gateway's decision, the sandbox
 * sweep, the browser's session end, and identity's `roleOf` and `authenticateApiKey`. Each takes a `SystemContext` and
 * calls `requireSystem` first, which refuses anything but a `system` actor (a missing caller included) the same way.
 */
import type { AuditEventInput, AuditSink } from "./audit.ts";
import {
	type Actor,
	type CallContext,
	type Clock,
	HarbourError,
	isSystemActor,
	type OrganisationId,
	type ProjectId,
	type SessionId,
	type SystemContext,
	systemClock,
	systemContext,
} from "./common.ts";
import { type IdentityDirectory, type Role, roleSatisfies } from "./identity.ts";
import type { SessionDirectory, SessionRecord } from "./session.ts";

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
}

export interface ProjectAccess {
	/** Resolves when `ctx.actor` may make the call; otherwise audits `access.denied` and rejects with `forbidden`. */
	require(ctx: CallContext, check: AccessCheck): Promise<AccessResult>;
	/** Whether `require` would pass, without auditing. For filtering lists to what the actor may see. */
	allows(ctx: CallContext, check: Omit<AccessCheck, "operation" | "subject">): Promise<boolean>;
}

/** The role an agent counts as holding on its own session's project. */
export const AGENT_ROLE: Role = "operator";

export interface ProjectAccessOptions {
	/** Role bindings and API keys. */
	readonly identity: Pick<IdentityDirectory, "roleOf">;
	/** The session directory; read with a system context in the call's organisation. */
	readonly sessions: Pick<SessionDirectory, "get">;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
}

const ACCESS_ACTOR: Actor = { kind: "system", component: "access" };
const ACCESS_CONTEXT: SystemContext = systemContext("access");
const REFUSAL = "The caller may not do this in this project";
const WORKER_REFUSAL = "Only Harbour's own components may make this call";

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
			if (projectId === undefined || !roleSatisfies(AGENT_ROLE, check.needed)) return result(false, projectId);
			const own = await sessionOf(ctx, actor.sessionId);
			if (own === undefined || own.agentId !== actor.agentId || own.status === "done") return result(false, projectId);
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

	return {
		async require(ctx, check) {
			const { allowed, projectId } = await decide(ctx, check);
			if (allowed) return projectId === undefined ? {} : { projectId };
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
