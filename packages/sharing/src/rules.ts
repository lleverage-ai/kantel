/**
 * The rules every sharing store applies, whatever keeps its records (docs/design/sharing.md). Each check goes through
 * `ProjectAccess`: authority over a resource is `ProjectAccess.resource` with `approve` through its owner or a binding,
 * never a share. Every change is audited under the `sharing` source, in one shape for shares, requests and decisions.
 */
import {
	type AccessRequest,
	type AccessRequestQuery,
	type Actor,
	AGENT_MAX_PERMISSION,
	type AuditEventInput,
	type AuditSink,
	type BindingInput,
	type BindingObject,
	type BindingQuery,
	type BindingSubject,
	bindingSubjectKey,
	type CallContext,
	type Clock,
	type CreateShareInput,
	DEFAULT_RESOURCE_POLICY,
	type DecideRequestInput,
	granteeKey,
	HarbourError,
	isBuiltInResourceKind,
	type JsonValue,
	type OrganisationId,
	type OwnerRef,
	type Page,
	type PageRequest,
	type ProjectAccess,
	permissionSatisfies,
	type RegisteredResource,
	type RequestAccessInput,
	type ResourceBinding,
	type ResourcePolicy,
	type ResourceRef,
	type ResourceResolver,
	type ResourceSelector,
	type ResourceShare,
	requireSystem,
	type ShareGrantee,
	type ShareQuery,
	type ShareUse,
	type Sharing,
	type SharingLookup,
	type SystemContext,
	shareActive,
	systemClock,
	systemContext,
} from "@harbour/contracts";
import {
	note,
	reason,
	resourceName,
	sameGrantee,
	sameResource,
	validateBinding,
	validateBindingObject,
	validateGrantee,
	validateHostKind,
	validateOwner,
	validatePermission,
	validateResource,
	validateRevision,
	validateSelector,
	validateSubject,
} from "./index.ts";
import type { SharingRepository } from "./repository.ts";

/** A store: the API every caller uses, and the read seam `ProjectAccess.resource` reads through. */
export type SharingStore = Sharing & SharingLookup;

export interface SharingOptions {
	/**
	 * Every check. Pass the same `ProjectAccess` the components use, built over this store's lookup; a function is read
	 * on each call, so the two can be built in either order.
	 */
	readonly access: ProjectAccess | (() => ProjectAccess);
	/** Where Harbour's own kinds' owners come from, by kind (`RESOURCE_KINDS`). A kind without one can't be shared. */
	readonly resolvers?: { readonly [kind: string]: ResourceResolver };
	readonly audit?: AuditSink;
	readonly clock?: Clock;
	/** New record IDs; default random. */
	readonly newId?: (prefix: "shr" | "req") => string;
}

const AUDIT_CONTEXT = systemContext("sharing");
const RESOLVER_CONTEXT = systemContext("sharing");

function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new HarbourError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

function selectorJson(resource: ResourceSelector): JsonValue {
	return {
		kind: resource.kind,
		id: resource.id,
		...(resource.revision === undefined ? {} : { revision: resource.revision }),
	};
}

function actorJson(actor: Actor): JsonValue {
	switch (actor.kind) {
		case "human":
			return { kind: "human", userId: actor.userId };
		case "service":
			return { kind: "service", serviceId: actor.serviceId };
		case "agent":
			return { kind: "agent", agentId: actor.agentId, sessionId: actor.sessionId };
		case "system":
			return { kind: "system", component: actor.component };
	}
}

function ownerProject(owner: OwnerRef): string | undefined {
	return owner.kind === "project" ? owner.projectId : undefined;
}

export function createSharingStore(repository: SharingRepository, options: SharingOptions): SharingStore {
	const clock = options.clock ?? systemClock;
	const access = (): ProjectAccess => (typeof options.access === "function" ? options.access() : options.access);
	const newId = options.newId ?? ((prefix: string) => `${prefix}_${crypto.randomUUID()}`);
	const resolvers = options.resolvers ?? {};

	const audit = async (
		ctx: CallContext,
		events: readonly Omit<AuditEventInput, "at" | "source" | "actor" | "organisationId">[],
	) => {
		if (options.audit === undefined || events.length === 0) return;
		const at = clock.now();
		await options.audit.append(
			AUDIT_CONTEXT,
			events.map((event) => ({
				...event,
				at,
				source: "sharing",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId, agentId: ctx.actor.agentId } : {}),
			})),
		);
	};

	const shareEvent = (type: string, share: ResourceShare, extra: { readonly [key: string]: JsonValue } = {}) => {
		const project = ownerProject(share.owner);
		return {
			id: `sharing:share:${share.id}:${type}`,
			type,
			...(project === undefined ? {} : { projectId: project }),
			subject: { kind: "sharing.share", id: share.id },
			data: {
				resource: selectorJson(share.resource),
				grantee: granteeKey(share.grantee),
				permission: share.permission,
				...(share.requestId === undefined ? {} : { requestId: share.requestId }),
				...(share.parentShareId === undefined ? {} : { parentShareId: share.parentShareId }),
				...(share.expiresAt === undefined ? {} : { expiresAt: share.expiresAt }),
				...extra,
			},
		};
	};

	const requestEvent = (type: string, request: AccessRequest, extra: { readonly [key: string]: JsonValue } = {}) => {
		const project = ownerProject(request.owner);
		return {
			id: `sharing:request:${request.id}:${type}`,
			type,
			...(project === undefined ? {} : { projectId: project }),
			subject: { kind: "sharing.request", id: request.id },
			data: {
				resource: selectorJson(request.resource),
				grantee: granteeKey(request.grantee),
				permission: request.permission,
				requestedBy: actorJson(request.requestedBy),
				...(request.sessionId === undefined ? {} : { requestSessionId: request.sessionId }),
				...extra,
			},
		};
	};

	/** The resource's owner: from its component's resolver, or as a host registered it. */
	const ownerOf = async (ctx: CallContext, resource: ResourceRef): Promise<OwnerRef> => {
		if (isBuiltInResourceKind(resource.kind)) {
			const resolver = resolvers[resource.kind];
			if (resolver === undefined) throw new HarbourError("not_supported", `${resource.kind} can't be shared here yet`);
			const found = await resolver.ownerOf({ ...RESOLVER_CONTEXT, organisationId: ctx.organisationId }, resource);
			if (found === undefined) throw new HarbourError("not_found", `No ${resource.kind} ${resource.id}`);
			return found.owner;
		}
		const registered = await repository.getResource(ctx.organisationId, resource);
		if (registered === undefined)
			throw new HarbourError("not_found", `No ${resource.kind} ${resource.id} is registered`);
		return registered.owner;
	};

	/** Authority over a resource: approve through its owner (admin where it lives) or an approver binding. Audited. */
	const requireAuthority = async (ctx: CallContext, resource: ResourceRef, owner: OwnerRef, operation: string) => {
		await access().resource(ctx, {
			resource: { kind: resource.kind, id: resource.id },
			owner,
			permission: "approve",
			needed: "admin",
			through: ["owner", "binding"],
			operation,
		});
	};

	const hasAuthority = async (ctx: CallContext, resource: ResourceRef, owner: OwnerRef): Promise<boolean> =>
		ctx.actor.kind !== "agent" &&
		(await access().allowsResource(ctx, {
			resource: { kind: resource.kind, id: resource.id },
			owner,
			permission: "approve",
			needed: "admin",
			through: ["owner", "binding"],
		})) !== undefined;

	/** Whether the caller acts on the grantee's side: viewer (or `needed`) where the grantee lives, or is the grantee. */
	const onGranteeSide = async (ctx: CallContext, grantee: ShareGrantee, needed: "viewer" | "operator" | "admin") => {
		const actor = ctx.actor;
		switch (grantee.kind) {
			case "project":
				return access().allows(ctx, { projectId: grantee.projectId, needed });
			case "session":
				return access().allows(ctx, { sessionId: grantee.sessionId, needed });
			case "agent":
				return (
					(actor.kind === "agent" && actor.agentId === grantee.agentId && needed !== "admin") ||
					access().allows(ctx, { needed })
				);
			case "user":
				return (actor.kind === "human" && actor.userId === grantee.userId) || access().allows(ctx, { needed });
		}
	};

	/** Whether the caller may read a share or request: either side of it. */
	const mayRead = async (
		ctx: CallContext,
		record: { readonly resource: ResourceRef; readonly owner: OwnerRef; readonly grantee: ShareGrantee },
	) => {
		if (ctx.actor.kind === "system") return true;
		if (await hasAuthority(ctx, record.resource, record.owner)) return true;
		const project = ownerProject(record.owner);
		if (
			project !== undefined &&
			ctx.actor.kind !== "agent" &&
			(await access().allows(ctx, { projectId: project, needed: "viewer" }))
		) {
			return true;
		}
		return onGranteeSide(ctx, record.grantee, "viewer");
	};

	const refuseRead = async (
		ctx: CallContext,
		record: { readonly resource: ResourceRef; readonly owner: OwnerRef },
		operation: string,
	) => {
		// Audited through the same check as authority, so a refusal looks like every other.
		await requireAuthority(ctx, record.resource, record.owner, operation);
	};

	const readShare = async (ctx: CallContext, shareId: string): Promise<ResourceShare> => {
		const share = await repository.getShare(ctx.organisationId, shareId);
		if (share === undefined) throw new HarbourError("not_found", `No share ${shareId}`);
		return share;
	};

	const readRequest = async (ctx: CallContext, requestId: string): Promise<AccessRequest> => {
		const request = await repository.getRequest(ctx.organisationId, requestId);
		if (request === undefined) throw new HarbourError("not_found", `No access request ${requestId}`);
		return request;
	};

	const assertFuture = (expiresAt: unknown): number | undefined => {
		if (expiresAt === undefined) return undefined;
		if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
			throw new HarbourError("invalid", "An expiry is a time");
		if (expiresAt <= clock.now()) throw new HarbourError("invalid", "An expiry must be in the future");
		return expiresAt;
	};

	/** A share an agent passes on: from one it holds, to a child session of its own, no wider. */
	const passOn = async (
		ctx: CallContext,
		input: CreateShareInput,
		resource: ResourceSelector,
		grantee: ShareGrantee,
	) => {
		const actor = ctx.actor;
		if (actor.kind !== "agent") throw new HarbourError("invalid", "Only a supervisor's agent passes a share on");
		const refuse = (message: string) => {
			throw new HarbourError("forbidden", message);
		};
		if (input.parentShareId === undefined) refuse("An agent may only pass on a share it holds");
		const parent = await repository.getShare(ctx.organisationId, input.parentShareId as string);
		if (parent === undefined || !shareActive(parent, clock.now()) || !sameResource(parent.resource, resource)) {
			return refuse("An agent may only pass on a share it holds");
		}
		const held =
			(parent.grantee.kind === "session" && parent.grantee.sessionId === actor.sessionId) ||
			(parent.grantee.kind === "agent" && parent.grantee.agentId === actor.agentId) ||
			(parent.grantee.kind === "project" &&
				(await access().allows(ctx, {
					projectId: parent.grantee.projectId,
					sessionId: actor.sessionId,
					needed: "operator",
				})));
		if (!held) refuse("An agent may only pass on a share it holds");
		if (grantee.kind !== "session" || grantee.sessionId === actor.sessionId) {
			refuse("An agent may pass a share on only to a child session, never to its own session or project");
		}
		// The agent's access check passes for another session only when it is the supervisor of that child.
		await access().require(ctx, {
			sessionId: (grantee as { sessionId: string }).sessionId,
			needed: "operator",
			operation: "sharing.createShare",
			subject: { kind: "sharing.share", id: parent.id },
		});
		const permission = validatePermission(input.permission);
		if (!permissionSatisfies(parent.permission, permission) || !permissionSatisfies(AGENT_MAX_PERMISSION, permission)) {
			refuse("A share passed on can't be wider than the one held");
		}
		const expiresAt = assertFuture(input.expiresAt) ?? parent.expiresAt;
		if (parent.expiresAt !== undefined && (expiresAt === undefined || expiresAt > parent.expiresAt)) {
			refuse("A share passed on can't outlive the one held");
		}
		if (
			parent.resource.revision !== undefined &&
			resource.revision !== undefined &&
			resource.revision !== parent.resource.revision
		) {
			refuse("A share passed on must keep the revision the held one pins");
		}
		const revision = resource.revision ?? parent.resource.revision;
		return {
			parent,
			permission,
			expiresAt,
			resource: { kind: resource.kind, id: resource.id, ...(revision === undefined ? {} : { revision }) },
		};
	};

	const revokeCascade = async (ctx: CallContext, root: ResourceShare, reasonText: string | undefined) => {
		const revocation = {
			revokedAt: clock.now(),
			revokedBy: ctx.actor,
			...(reasonText === undefined ? {} : { reason: reasonText }),
		};
		const revoked: string[] = [];
		let frontier = [root.id];
		const seen = new Set<string>();
		while (frontier.length > 0) {
			for (const id of frontier) seen.add(id);
			revoked.push(...(await repository.revokeShares(ctx.organisationId, frontier, revocation)));
			const children = await repository.findShares(ctx.organisationId, { parentShareIds: frontier });
			frontier = children.map((child) => child.id).filter((id) => !seen.has(id));
		}
		const events = [];
		for (const id of revoked) {
			const share = await repository.getShare(ctx.organisationId, id);
			if (share !== undefined) {
				events.push(
					shareEvent("sharing.share.revoked", share, {
						...(reasonText === undefined ? {} : { reason: reasonText }),
						...(id === root.id ? {} : { cascadedFrom: root.id }),
					}),
				);
			}
		}
		await audit(ctx, events);
	};

	/** The default grantee of a request: an agent's project, else the call's project. */
	const defaultGrantee = async (ctx: CallContext): Promise<ShareGrantee> => {
		if (ctx.actor.kind === "agent") {
			const { projectId } = await access().require(ctx, {
				sessionId: ctx.actor.sessionId,
				needed: "operator",
				operation: "sharing.requestAccess",
			});
			if (projectId !== undefined) return { kind: "project", projectId };
		}
		if (ctx.projectId !== undefined) return { kind: "project", projectId: ctx.projectId };
		throw new HarbourError("invalid", "A request needs a grantee");
	};

	/** The requester acts for the grantee: operator there; an agent only for its own session, agent or project. */
	const requireRequester = async (ctx: CallContext, grantee: ShareGrantee) => {
		const actor = ctx.actor;
		const operation = "sharing.requestAccess";
		if (actor.kind === "agent") {
			if (grantee.kind === "session" && grantee.sessionId === actor.sessionId) return;
			if (grantee.kind === "agent" && grantee.agentId === actor.agentId) return;
			if (grantee.kind === "project") {
				await access().require(ctx, {
					projectId: grantee.projectId,
					sessionId: actor.sessionId,
					needed: "operator",
					operation,
				});
				return;
			}
			throw new HarbourError("forbidden", "An agent requests access only for its own session, agent or project");
		}
		switch (grantee.kind) {
			case "project":
				await access().require(ctx, { projectId: grantee.projectId, needed: "operator", operation });
				return;
			case "session":
				await access().require(ctx, { sessionId: grantee.sessionId, needed: "operator", operation });
				return;
			case "agent":
				await access().require(ctx, { needed: "operator", operation });
				return;
			case "user":
				if (actor.kind === "human" && actor.userId === grantee.userId) return;
				await access().require(ctx, { needed: "operator", operation });
				return;
		}
	};

	const requireOrganisationAdmin = (ctx: CallContext, operation: string) =>
		access().require(ctx, { needed: "admin", operation });

	/** Reading a resource's records (its bindings, policy): someone who may use it, or holds authority over it. */
	const requireResourceRead = async (ctx: CallContext, resource: ResourceRef, owner: OwnerRef, operation: string) => {
		if (ctx.actor.kind === "system") return;
		const usable = await access().allowsResource(ctx, {
			resource,
			owner,
			permission: "use",
			through: ["owner", "binding"],
		});
		if (usable !== undefined || (await hasAuthority(ctx, resource, owner))) return;
		await requireAuthority(ctx, resource, owner, operation);
	};

	const lookupGuard = (ctx: SystemContext, operation: string) =>
		requireSystem(ctx, operation, { ...(options.audit === undefined ? {} : { audit: options.audit }), clock });

	const store: SharingStore = {
		async registerResource(ctx, input) {
			if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", "An agent can't register resources");
			const resource = { kind: validateHostKind(input.resource?.kind), id: validateResource(input.resource).id };
			const owner = validateOwner(input.owner);
			if (owner.kind === "platform" || owner.organisationId !== ctx.organisationId) {
				throw new HarbourError("invalid", "A resource is registered within the caller's organisation");
			}
			const name = resourceName(input.name);
			const existing = await repository.getResource(ctx.organisationId, resource);
			// The owner must be one the caller may administer: registering is how authority over it starts.
			await requireAuthority(ctx, resource, existing?.owner ?? owner, "sharing.registerResource");
			if (existing !== undefined) {
				if (JSON.stringify(existing.owner) !== JSON.stringify(owner)) {
					throw new HarbourError("conflict", `${resource.kind} ${resource.id} is registered to another owner`);
				}
				return existing;
			}
			const record: RegisteredResource = {
				organisationId: ctx.organisationId,
				resource,
				owner,
				...(name === undefined ? {} : { name }),
				registeredBy: ctx.actor,
				registeredAt: clock.now(),
			};
			const stored = await repository.putResource(record);
			await audit(ctx, [
				{
					id: `sharing:resource:${resource.kind}:${resource.id}:registered`,
					type: "sharing.resource.registered",
					...(ownerProject(owner) === undefined ? {} : { projectId: ownerProject(owner) as string }),
					subject: { kind: resource.kind, id: resource.id },
					data: { owner: owner.kind, ...(name === undefined ? {} : { name }) },
				},
			]);
			return stored;
		},

		async createShare(ctx, input) {
			const resource = validateSelector(input.resource);
			const grantee = validateGrantee(input.grantee);
			const permission = validatePermission(input.permission);
			const noteText = note(input.note);
			const owner = await ownerOf(ctx, resource);
			if (owner.kind === "project" && grantee.kind === "project" && grantee.projectId === owner.projectId) {
				throw new HarbourError("invalid", "A project already has what it owns");
			}
			let share: ResourceShare;
			if (ctx.actor.kind === "agent") {
				const passed = await passOn(ctx, input, resource, grantee);
				share = {
					id: newId("shr"),
					organisationId: ctx.organisationId,
					resource: passed.resource,
					owner,
					grantee,
					permission: passed.permission,
					grantedBy: ctx.actor,
					grantedAt: clock.now(),
					...(passed.expiresAt === undefined ? {} : { expiresAt: passed.expiresAt }),
					parentShareId: passed.parent.id,
					...(noteText === undefined ? {} : { note: noteText }),
				};
			} else {
				if (input.parentShareId !== undefined)
					throw new HarbourError("invalid", "Only a supervisor's agent passes a share on");
				await requireAuthority(ctx, resource, owner, "sharing.createShare");
				const expiresAt = assertFuture(input.expiresAt);
				share = {
					id: newId("shr"),
					organisationId: ctx.organisationId,
					resource,
					owner,
					grantee,
					permission,
					grantedBy: ctx.actor,
					grantedAt: clock.now(),
					...(expiresAt === undefined ? {} : { expiresAt }),
					...(noteText === undefined ? {} : { note: noteText }),
				};
			}
			await repository.insertShare(share);
			await audit(ctx, [shareEvent("sharing.share.created", share, noteText === undefined ? {} : { note: noteText })]);
			return share;
		},

		async getShare(ctx, shareId) {
			const share = await readShare(ctx, shareId);
			if (!(await mayRead(ctx, share))) await refuseRead(ctx, share, "sharing.getShare");
			return share;
		},

		async listShares(ctx, query: ShareQuery, page) {
			const now = clock.now();
			const filter = {
				...(query.resource === undefined ? {} : { resource: validateResource(query.resource) }),
				...(query.grantee === undefined ? {} : { granteeKeys: [granteeKey(validateGrantee(query.grantee))] }),
				...(query.ownerProjectId === undefined ? {} : { ownerProjectId: query.ownerProjectId }),
			};
			if (filter.resource === undefined && filter.granteeKeys === undefined && filter.ownerProjectId === undefined) {
				// Everything in the organisation: an organisation-wide role.
				await access().require(ctx, { needed: "viewer", operation: "sharing.listShares" });
			} else if (query.grantee !== undefined && filter.resource === undefined) {
				if (!(await onGranteeSide(ctx, validateGrantee(query.grantee), "viewer"))) {
					await access().require(ctx, { needed: "viewer", operation: "sharing.listShares" });
				}
			} else if (query.ownerProjectId !== undefined && filter.resource === undefined) {
				await access().require(ctx, {
					projectId: query.ownerProjectId,
					needed: "viewer",
					operation: "sharing.listShares",
				});
			}
			const found = await repository.findShares(ctx.organisationId, filter);
			const visible: ResourceShare[] = [];
			for (const share of found) {
				if (query.includeInactive !== true && !shareActive(share, now)) continue;
				if (filter.resource !== undefined && !(await mayRead(ctx, share))) continue;
				visible.push(share);
			}
			return paginate(visible, page);
		},

		async revokeShare(ctx, shareId, input) {
			const share = await readShare(ctx, shareId);
			const reasonText = note(input?.reason);
			const actor = ctx.actor;
			const passer =
				actor.kind === "agent" &&
				share.grantedBy.kind === "agent" &&
				share.grantedBy.sessionId === actor.sessionId &&
				share.parentShareId !== undefined;
			const detaching =
				actor.kind !== "agent" &&
				((share.grantee.kind === "project" &&
					(await access().allows(ctx, { projectId: share.grantee.projectId, needed: "admin" }))) ||
					(share.grantee.kind === "session" &&
						(await access().allows(ctx, { sessionId: share.grantee.sessionId, needed: "admin" }))));
			if (!passer && !detaching) await requireAuthority(ctx, share.resource, share.owner, "sharing.revokeShare");
			if (share.revokedAt !== undefined) return share;
			await revokeCascade(ctx, share, reasonText);
			return readShare(ctx, shareId);
		},

		async requestAccess(ctx, input: RequestAccessInput) {
			const resource = validateSelector(input.resource);
			const permission = input.permission === undefined ? "use" : validatePermission(input.permission);
			const reasonText = reason(input.reason);
			const expiresAt = assertFuture(input.expiresAt);
			const grantee = input.grantee === undefined ? await defaultGrantee(ctx) : validateGrantee(input.grantee);
			await requireRequester(ctx, grantee);
			const actor = ctx.actor;
			let sessionId: string | undefined;
			if (actor.kind === "agent") {
				sessionId = actor.sessionId;
			} else if (input.sessionId !== undefined) {
				await access().require(ctx, {
					sessionId: input.sessionId,
					needed: "operator",
					operation: "sharing.requestAccess",
				});
				sessionId = input.sessionId;
			}
			const owner = await ownerOf(ctx, resource);
			if (owner.kind === "project" && grantee.kind === "project" && grantee.projectId === owner.projectId) {
				throw new HarbourError("invalid", "A project already has what it owns");
			}
			// Asking again while the same request is pending returns it.
			const pending = await repository.findRequests(ctx.organisationId, {
				resource,
				granteeKey: granteeKey(grantee),
				status: "pending",
			});
			const same = pending.find(
				(request) => request.permission === permission && request.resource.revision === resource.revision,
			);
			if (same !== undefined) return same;
			const request: AccessRequest = {
				id: newId("req"),
				organisationId: ctx.organisationId,
				resource,
				owner,
				grantee,
				permission,
				reason: reasonText,
				requestedBy: actor,
				...(sessionId === undefined ? {} : { sessionId }),
				...(actor.kind === "agent" ? { agentId: actor.agentId } : {}),
				status: "pending",
				createdAt: clock.now(),
				...(expiresAt === undefined ? {} : { expiresAt }),
			};
			await repository.insertRequest(request);
			await audit(ctx, [requestEvent("sharing.request.created", request, { reason: reasonText })]);
			return request;
		},

		async getRequest(ctx, requestId) {
			const request = await readRequest(ctx, requestId);
			if (!(await mayRead(ctx, request))) await refuseRead(ctx, request, "sharing.getRequest");
			return request;
		},

		async listRequests(ctx, query: AccessRequestQuery, page) {
			const filter = {
				...(query.resource === undefined ? {} : { resource: validateResource(query.resource) }),
				...(query.grantee === undefined ? {} : { granteeKey: granteeKey(validateGrantee(query.grantee)) }),
				...(query.status === undefined ? {} : { status: query.status }),
				...(query.ownerProjectId === undefined ? {} : { ownerProjectId: query.ownerProjectId }),
				...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
			};
			if (query.sessionId !== undefined) {
				await access().require(ctx, {
					sessionId: query.sessionId,
					needed: "viewer",
					operation: "sharing.listRequests",
				});
			} else if (query.grantee !== undefined && query.resource === undefined && query.decidable !== true) {
				if (!(await onGranteeSide(ctx, validateGrantee(query.grantee), "viewer"))) {
					await access().require(ctx, { needed: "viewer", operation: "sharing.listRequests" });
				}
			} else if (query.ownerProjectId !== undefined && query.resource === undefined && query.decidable !== true) {
				await access().require(ctx, {
					projectId: query.ownerProjectId,
					needed: "viewer",
					operation: "sharing.listRequests",
				});
			}
			const found = await repository.findRequests(ctx.organisationId, filter);
			const visible: AccessRequest[] = [];
			for (const request of found) {
				if (query.decidable === true) {
					if (request.status === "pending" && (await hasAuthority(ctx, request.resource, request.owner)))
						visible.push(request);
					continue;
				}
				if (query.sessionId !== undefined || (await mayRead(ctx, request))) visible.push(request);
			}
			return paginate(visible, page);
		},

		async withdrawRequest(ctx, requestId) {
			const request = await readRequest(ctx, requestId);
			const actor = ctx.actor;
			const requester = request.requestedBy;
			const own =
				(actor.kind === "agent" && requester.kind === "agent" && requester.sessionId === actor.sessionId) ||
				(actor.kind === "human" && requester.kind === "human" && requester.userId === actor.userId) ||
				(actor.kind === "service" && requester.kind === "service" && requester.serviceId === actor.serviceId);
			if (!own && actor.kind !== "system") {
				if (actor.kind === "agent" || !(await onGranteeSide(ctx, request.grantee, "operator"))) {
					await access().require(ctx, {
						...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
						needed: "admin",
						operation: "sharing.withdrawRequest",
						subject: { kind: "sharing.request", id: request.id },
					});
				}
			}
			if (request.status !== "pending") throw new HarbourError("conflict", `The request is ${request.status}`);
			const settled: AccessRequest = {
				...request,
				status: "withdrawn",
				decision: { decidedBy: actor, decidedAt: clock.now() },
			};
			if (!(await repository.settleRequest(settled)))
				throw new HarbourError("conflict", "The request is no longer pending");
			await audit(ctx, [requestEvent("sharing.request.withdrawn", settled)]);
			return settled;
		},

		async decideRequest(ctx, requestId, input: DecideRequestInput) {
			const request = await readRequest(ctx, requestId);
			if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", "An agent can't decide access requests");
			await requireAuthority(ctx, request.resource, request.owner, "sharing.decideRequest");
			if (request.status !== "pending") throw new HarbourError("conflict", `The request is ${request.status}`);
			if (input.decision !== "grant" && input.decision !== "reject") {
				throw new HarbourError("invalid", "A decision is grant or reject");
			}
			const noteText = note(input.note);
			const decidedAt = clock.now();
			if (input.decision === "reject") {
				const settled: AccessRequest = {
					...request,
					status: "rejected",
					decision: { decidedBy: ctx.actor, decidedAt, ...(noteText === undefined ? {} : { note: noteText }) },
				};
				if (!(await repository.settleRequest(settled)))
					throw new HarbourError("conflict", "The request is no longer pending");
				await audit(ctx, [
					requestEvent("sharing.request.rejected", settled, noteText === undefined ? {} : { note: noteText }),
				]);
				return { request: settled };
			}
			const permission = input.permission === undefined ? request.permission : validatePermission(input.permission);
			if (!permissionSatisfies(request.permission, permission)) {
				throw new HarbourError("invalid", "A grant can't be wider than the request");
			}
			const expiresAt = assertFuture(input.expiresAt) ?? request.expiresAt;
			if (request.expiresAt !== undefined && (expiresAt === undefined || expiresAt > request.expiresAt)) {
				throw new HarbourError("invalid", "A grant can't outlast what was asked");
			}
			if (expiresAt !== undefined && expiresAt <= decidedAt)
				throw new HarbourError("expired", "The request's time has passed");
			const revision = input.revision === undefined ? request.resource.revision : validateRevision(input.revision);
			if (request.resource.revision !== undefined && revision !== request.resource.revision) {
				throw new HarbourError("invalid", "A grant keeps the revision the request pins");
			}
			const share: ResourceShare = {
				id: newId("shr"),
				organisationId: ctx.organisationId,
				resource: {
					kind: request.resource.kind,
					id: request.resource.id,
					...(revision === undefined ? {} : { revision }),
				},
				owner: request.owner,
				grantee: request.grantee,
				permission,
				grantedBy: ctx.actor,
				grantedAt: decidedAt,
				requestId: request.id,
				...(expiresAt === undefined ? {} : { expiresAt }),
				...(noteText === undefined ? {} : { note: noteText }),
			};
			const settled: AccessRequest = {
				...request,
				status: "granted",
				decision: {
					decidedBy: ctx.actor,
					decidedAt,
					...(noteText === undefined ? {} : { note: noteText }),
					shareId: share.id,
				},
			};
			if (!(await repository.settleRequest(settled, share)))
				throw new HarbourError("conflict", "The request is no longer pending");
			await audit(ctx, [
				requestEvent("sharing.request.granted", settled, {
					shareId: share.id,
					grantedPermission: permission,
					...(noteText === undefined ? {} : { note: noteText }),
				}),
				shareEvent("sharing.share.created", share),
			]);
			return { request: settled, share };
		},

		async addBinding(ctx, input: BindingInput) {
			const binding = validateBinding(input);
			if (binding.object.kind === "group") {
				await requireOrganisationAdmin(ctx, "sharing.addBinding");
			} else {
				if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", "An agent can't change bindings");
				const owner = await ownerOf(ctx, binding.object);
				await requireAuthority(ctx, binding.object, owner, "sharing.addBinding");
			}
			const stored = await repository.putBinding({
				organisationId: ctx.organisationId,
				...binding,
				grantedBy: ctx.actor,
				grantedAt: clock.now(),
			});
			await audit(ctx, [bindingEvent("sharing.binding.added", stored)]);
			return stored;
		},

		async removeBinding(ctx, input: BindingInput) {
			const binding = validateBinding(input);
			if (binding.object.kind === "group") {
				await requireOrganisationAdmin(ctx, "sharing.removeBinding");
			} else {
				if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", "An agent can't change bindings");
				const owner = await ownerOf(ctx, binding.object);
				await requireAuthority(ctx, binding.object, owner, "sharing.removeBinding");
			}
			const removed = await repository.deleteBinding({ organisationId: ctx.organisationId, ...binding });
			if (removed) {
				await audit(ctx, [
					bindingEvent("sharing.binding.removed", {
						organisationId: ctx.organisationId,
						...binding,
						grantedBy: ctx.actor,
						grantedAt: clock.now(),
					}),
				]);
			}
		},

		async listBindings(ctx, query: BindingQuery, page) {
			const object = query.object === undefined ? undefined : validateBindingObject(query.object);
			const subject = query.subject === undefined ? undefined : validateSubject(query.subject);
			if (object !== undefined && object.kind !== "group") {
				const owner = await ownerOf(ctx, object);
				await requireResourceRead(ctx, object, owner, "sharing.listBindings");
			} else if (!(subject !== undefined && sameActor(ctx.actor, subject))) {
				await access().require(ctx, { needed: "viewer", operation: "sharing.listBindings" });
			}
			const found = await repository.findBindings(ctx.organisationId, {
				...(object === undefined ? {} : { object: { kind: object.kind, id: object.id } }),
				...(subject === undefined ? {} : { subjectKey: bindingSubjectKey(subject) }),
				...(query.relation === undefined ? {} : { relation: query.relation }),
			});
			return paginate(found, page);
		},

		async setPolicy(ctx, resourceInput, policy) {
			const resource = validateResource(resourceInput);
			if (typeof policy?.twoPersonRule !== "boolean")
				throw new HarbourError("invalid", "A policy says whether the two-person rule applies");
			if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", "An agent can't set a resource's policy");
			const owner = await ownerOf(ctx, resource);
			await requireAuthority(ctx, resource, owner, "sharing.setPolicy");
			const stored: ResourcePolicy = { twoPersonRule: policy.twoPersonRule };
			await repository.putPolicy(ctx.organisationId, resource, stored, ctx.actor, clock.now());
			await audit(ctx, [
				{
					id: `sharing:policy:${resource.kind}:${resource.id}:${clock.now()}`,
					type: "sharing.policy.set",
					...(ownerProject(owner) === undefined ? {} : { projectId: ownerProject(owner) as string }),
					subject: { kind: resource.kind, id: resource.id },
					data: { resource: selectorJson(resource), twoPersonRule: stored.twoPersonRule },
				},
			]);
			return stored;
		},

		async getPolicy(ctx, resourceInput) {
			const resource = validateResource(resourceInput);
			const owner = await ownerOf(ctx, resource);
			await requireResourceRead(ctx, resource, owner, "sharing.getPolicy");
			return (await repository.getPolicy(ctx.organisationId, resource)) ?? DEFAULT_RESOURCE_POLICY;
		},

		async listUses(ctx, query) {
			if (typeof query?.sessionId !== "string" || query.sessionId === "")
				throw new HarbourError("invalid", "A session ID is required");
			await access().require(ctx, { sessionId: query.sessionId, needed: "viewer", operation: "sharing.listUses" });
			return repository.findUses(ctx.organisationId, query.sessionId);
		},

		async sharesOf(ctx, organisationId, resource) {
			await lookupGuard(ctx, "sharing.sharesOf");
			const now = clock.now();
			return (await repository.findShares(organisationId, { resource })).filter((share) => shareActive(share, now));
		},

		async bindingsOf(ctx, organisationId, object: BindingObject) {
			await lookupGuard(ctx, "sharing.bindingsOf");
			return repository.findBindings(organisationId, { object: { kind: object.kind, id: object.id } });
		},

		async groupsOf(ctx, organisationId, subject: BindingSubject) {
			await lookupGuard(ctx, "sharing.groupsOf");
			const memberships = await repository.findBindings(organisationId, {
				subjectKey: bindingSubjectKey(subject),
				relation: "member",
			});
			return memberships.filter((binding) => binding.object.kind === "group").map((binding) => binding.object.id);
		},

		async policyOf(ctx, organisationId, resource) {
			await lookupGuard(ctx, "sharing.policyOf");
			return (await repository.getPolicy(organisationId, resource)) ?? DEFAULT_RESOURCE_POLICY;
		},

		async recordUse(ctx, use: ShareUse) {
			await lookupGuard(ctx, "sharing.recordUse");
			await repository.putUse(use);
		},

		async sharedInto(ctx, organisationId: OrganisationId, grantees, kind) {
			await lookupGuard(ctx, "sharing.sharedInto");
			if (grantees.length === 0) return [];
			const now = clock.now();
			const found = await repository.findShares(organisationId, {
				granteeKeys: grantees.map(granteeKey),
				...(kind === undefined ? {} : { kind }),
			});
			return found.filter(
				(share) => shareActive(share, now) && grantees.some((grantee) => sameGrantee(grantee, share.grantee)),
			);
		},
	};

	function bindingEvent(type: string, binding: ResourceBinding) {
		const key = `${binding.object.kind}:${binding.object.id}:${binding.relation}:${bindingSubjectKey(binding.subject)}`;
		return {
			id: `sharing:binding:${key}:${type}:${binding.grantedAt}`,
			type,
			subject: { kind: binding.object.kind, id: binding.object.id },
			data: { relation: binding.relation, subject: bindingSubjectKey(binding.subject) },
		};
	}

	return store;
}

function sameActor(actor: Actor, subject: BindingSubject): boolean {
	return (
		(subject.kind === "user" && actor.kind === "human" && actor.userId === subject.userId) ||
		(subject.kind === "service" && actor.kind === "service" && actor.serviceId === subject.serviceId)
	);
}
