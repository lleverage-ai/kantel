/**
 * The in-memory `IdentityDirectory`: the reference implementation the conformance suite runs against. Records live in
 * maps for the life of the instance; API keys are kept only as a SHA-256 hash and a display prefix.
 */
import {
	type Actor,
	type ApiKey,
	type ApiKeyId,
	type AuditEventType,
	type AuditSink,
	type Authentication,
	type CallContext,
	type Clock,
	HarbourError,
	type IdentityDirectory,
	type IssuedApiKey,
	type JsonValue,
	type Organisation,
	type OrganisationId,
	type Page,
	type PageRequest,
	type Principal,
	type Project,
	type ProjectId,
	ROLES,
	type Role,
	type RoleBinding,
	requireSystem,
	roleSatisfies,
	type ServiceId,
	type ServiceIdentity,
	systemClock,
	systemContext,
	type User,
	type UserId,
} from "@harbour/contracts";
import { apiKeyPrefix, generateApiKeySecret, hashApiKeySecret, strongestRole } from "./index.ts";

/** Identity appends its audit events as itself. */
const AUDIT_CONTEXT = systemContext("identity");

export interface MemoryIdentityOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
}

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;

interface StoredUser {
	readonly user: User;
	/** The organisation the creating call ran in; the user is visible there even before holding a role. */
	readonly createdInOrganisationId: OrganisationId;
}

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

const principalKey = (principal: Principal): string =>
	principal.kind === "user" ? `user:${principal.userId}` : `service:${principal.serviceId}`;

function principalOf(actor: Actor): Principal | undefined {
	if (actor.kind === "human") return { kind: "user", userId: actor.userId };
	if (actor.kind === "service") return { kind: "service", serviceId: actor.serviceId };
	return undefined;
}

function requireName(name: unknown, what: string): string {
	if (typeof name !== "string" || name.trim() === "") throw new HarbourError("invalid", `${what} needs a name`);
	return name;
}

function requireRoleValue(role: unknown): Role {
	if (typeof role !== "string" || !ROLES.includes(role as Role)) throw new HarbourError("invalid", "unknown role");
	return role as Role;
}

const forbidden = (message: string): HarbourError => new HarbourError("forbidden", message);
const notFound = (what: string): HarbourError => new HarbourError("not_found", `${what} not found`);

export function createMemoryIdentity(options: MemoryIdentityOptions = {}): IdentityDirectory {
	const clock = options.clock ?? systemClock;
	const audit = options.audit;

	const organisations = new Map<OrganisationId, Organisation>();
	const projects = new Map<ProjectId, Project>();
	const users = new Map<UserId, StoredUser>();
	const services = new Map<ServiceId, ServiceIdentity>();
	/** Keyed by organisation, principal and scope, so a grant for the same principal and scope replaces the old one. */
	const bindings = new Map<string, RoleBinding>();
	const apiKeys = new Map<ApiKeyId, ApiKey>();
	const apiKeyIdsByHash = new Map<string, ApiKeyId>();

	const bindingKey = (organisationId: OrganisationId, principal: Principal, projectId: ProjectId | undefined): string =>
		`${organisationId}|${principalKey(principal)}|${projectId ?? "*"}`;

	const bindingsOf = (organisationId: OrganisationId): RoleBinding[] =>
		[...bindings.values()].filter((binding) => binding.organisationId === organisationId);

	const keyIsLive = (key: ApiKey): boolean =>
		key.revokedAt === undefined && (key.expiresAt === undefined || clock.now() < key.expiresAt);

	function projectIn(organisationId: OrganisationId, projectId: ProjectId): Project {
		const project = projects.get(projectId);
		if (project === undefined || project.organisationId !== organisationId) throw notFound("project");
		return project;
	}

	function serviceIn(organisationId: OrganisationId, serviceId: ServiceId): ServiceIdentity {
		const service = services.get(serviceId);
		if (service === undefined || service.organisationId !== organisationId) throw notFound("service identity");
		return service;
	}

	/** The strongest role `actor` holds on `projectId`, or on the organisation as a whole when it is absent. */
	function resolveRole(actor: Actor, organisationId: OrganisationId, projectId?: ProjectId): Role | undefined {
		if (actor.kind === "system") return "admin";
		if (actor.kind === "agent") return undefined;
		if (!organisations.has(organisationId)) return undefined;
		if (projectId !== undefined && projects.get(projectId)?.organisationId !== organisationId) return undefined;
		if (actor.kind === "service" && actor.keyId !== undefined) {
			const key = apiKeys.get(actor.keyId);
			if (key === undefined || key.serviceId !== actor.serviceId || key.organisationId !== organisationId) {
				return undefined;
			}
			if (!keyIsLive(key) || projectId === undefined || !key.projectIds.includes(projectId)) return undefined;
			return key.role;
		}
		const principal = principalOf(actor);
		if (principal === undefined) return undefined;
		const held = principalKey(principal);
		return strongestRole(
			bindingsOf(organisationId)
				.filter(
					(binding) =>
						principalKey(binding.principal) === held &&
						(binding.projectId === undefined || binding.projectId === projectId),
				)
				.map((binding) => binding.role),
		);
	}

	function requireRole(actor: Actor, organisationId: OrganisationId, projectId: ProjectId | undefined, needed: Role) {
		if (actor.kind === "agent") throw forbidden("identity never authorises an agent; the runtime does, by session");
		const held = resolveRole(actor, organisationId, projectId);
		if (held === undefined || !roleSatisfies(held, needed)) {
			throw forbidden(`needs ${needed} on the ${projectId === undefined ? "organisation" : "project"}`);
		}
	}

	/** Whether `actor` holds any role in the organisation: a binding anywhere in it, or a live key into it. */
	function isMember(actor: Actor, organisationId: OrganisationId): boolean {
		if (actor.kind === "system") return true;
		if (actor.kind === "agent") return false;
		if (actor.kind === "service" && actor.keyId !== undefined) {
			const key = apiKeys.get(actor.keyId);
			return (
				key !== undefined &&
				key.serviceId === actor.serviceId &&
				key.organisationId === organisationId &&
				keyIsLive(key)
			);
		}
		const principal = principalOf(actor);
		if (principal === undefined) return false;
		const held = principalKey(principal);
		return bindingsOf(organisationId).some((binding) => principalKey(binding.principal) === held);
	}

	function requireMember(ctx: CallContext): void {
		if (!isMember(ctx.actor, ctx.organisationId)) throw forbidden("the actor holds no role in this organisation");
	}

	async function emit(
		ctx: CallContext,
		type: AuditEventType,
		organisationId: OrganisationId,
		subject: { readonly kind: string; readonly id: string },
		data: { readonly [key: string]: JsonValue },
		projectId?: ProjectId,
	): Promise<void> {
		if (audit === undefined) return;
		await audit.append(AUDIT_CONTEXT, [
			{
				id: `identity:${type}:${crypto.randomUUID()}`,
				at: clock.now(),
				source: "identity",
				type,
				actor: ctx.actor,
				organisationId,
				...(projectId === undefined ? {} : { projectId }),
				subject,
				data,
			},
		]);
	}

	const principalData = (principal: Principal): { readonly [key: string]: JsonValue } =>
		principal.kind === "user"
			? { kind: "user", userId: principal.userId }
			: { kind: "service", serviceId: principal.serviceId };

	return {
		async createOrganisation(ctx, input) {
			if (ctx.actor.kind !== "system") throw forbidden("only a system actor may create an organisation");
			const name = requireName(input.name, "an organisation");
			if (input.admin.kind === "service") {
				throw new HarbourError("invalid", "a service identity belongs to one organisation and cannot found another");
			}
			if (!users.has(input.admin.userId)) throw notFound("user");
			const now = clock.now();
			const organisation: Organisation = Object.freeze({ id: newId("org"), name, createdAt: now });
			organisations.set(organisation.id, organisation);
			const binding: RoleBinding = Object.freeze({
				organisationId: organisation.id,
				principal: Object.freeze({ ...input.admin }),
				role: "admin",
				grantedAt: now,
				grantedBy: ctx.actor,
			});
			bindings.set(bindingKey(organisation.id, binding.principal, undefined), binding);
			await emit(
				ctx,
				"identity.organisation.created",
				organisation.id,
				{ kind: "identity.organisation", id: organisation.id },
				{
					name,
				},
			);
			await emit(
				ctx,
				"identity.role.granted",
				organisation.id,
				{ kind: "identity.organisation", id: organisation.id },
				{ principal: principalData(binding.principal), role: binding.role },
			);
			return organisation;
		},

		async getOrganisation(ctx, id) {
			requireMember(ctx);
			const organisation = organisations.get(id);
			if (organisation === undefined || id !== ctx.organisationId) throw notFound("organisation");
			return organisation;
		},

		async createProject(ctx, input) {
			requireRole(ctx.actor, ctx.organisationId, undefined, "admin");
			const name = requireName(input.name, "a project");
			const project: Project = Object.freeze({
				id: newId("prj"),
				organisationId: ctx.organisationId,
				name,
				createdAt: clock.now(),
			});
			projects.set(project.id, project);
			await emit(
				ctx,
				"identity.project.created",
				project.organisationId,
				{ kind: "identity.project", id: project.id },
				{
					name,
				},
				project.id,
			);
			return project;
		},

		async getProject(ctx, id) {
			requireMember(ctx);
			const project = projectIn(ctx.organisationId, id);
			if (resolveRole(ctx.actor, ctx.organisationId, id) === undefined) throw notFound("project");
			return project;
		},

		async listProjects(ctx, page?: PageRequest): Promise<Page<Project>> {
			const limit = page?.limit ?? DEFAULT_PAGE_LIMIT;
			if (!Number.isInteger(limit) || limit < 1) throw new HarbourError("invalid", "limit must be a positive integer");
			const visible = [...projects.values()].filter(
				(project) =>
					project.organisationId === ctx.organisationId &&
					resolveRole(ctx.actor, ctx.organisationId, project.id) !== undefined,
			);
			let start = 0;
			if (page?.cursor !== undefined) {
				const index = visible.findIndex((project) => project.id === page.cursor);
				if (index < 0) throw new HarbourError("invalid", "unknown cursor");
				start = index + 1;
			}
			const end = start + Math.min(limit, MAX_PAGE_LIMIT);
			const items = visible.slice(start, end);
			const last = items.at(-1);
			return end < visible.length && last !== undefined ? { items, nextCursor: last.id } : { items };
		},

		async createUser(ctx, input) {
			if (ctx.actor.kind !== "system") requireRole(ctx.actor, ctx.organisationId, undefined, "admin");
			const name = requireName(input.name, "a user");
			const user: User = Object.freeze({
				id: newId("usr"),
				name,
				...(input.email === undefined ? {} : { email: input.email }),
				...(input.externalSubject === undefined ? {} : { externalSubject: input.externalSubject }),
				createdAt: clock.now(),
			});
			users.set(user.id, { user, createdInOrganisationId: ctx.organisationId });
			await emit(ctx, "identity.user.created", ctx.organisationId, { kind: "identity.user", id: user.id }, {});
			return user;
		},

		async getUser(ctx, id) {
			requireMember(ctx);
			const stored = users.get(id);
			if (stored === undefined) throw notFound("user");
			const visible =
				stored.createdInOrganisationId === ctx.organisationId ||
				bindingsOf(ctx.organisationId).some(
					(binding) => binding.principal.kind === "user" && binding.principal.userId === id,
				);
			if (!visible) throw notFound("user");
			return stored.user;
		},

		async createServiceIdentity(ctx, input) {
			requireRole(ctx.actor, ctx.organisationId, undefined, "admin");
			const name = requireName(input.name, "a service identity");
			const service: ServiceIdentity = Object.freeze({
				id: newId("svc"),
				organisationId: ctx.organisationId,
				name,
				createdAt: clock.now(),
			});
			services.set(service.id, service);
			await emit(
				ctx,
				"identity.service.created",
				ctx.organisationId,
				{ kind: "identity.service", id: service.id },
				{
					name,
				},
			);
			return service;
		},

		async grantRole(ctx, input) {
			const role = requireRoleValue(input.role);
			if (input.projectId !== undefined) projectIn(ctx.organisationId, input.projectId);
			requireRole(ctx.actor, ctx.organisationId, input.projectId, "admin");
			if (input.principal.kind === "user") {
				if (!users.has(input.principal.userId)) throw notFound("user");
			} else {
				serviceIn(ctx.organisationId, input.principal.serviceId);
			}
			const binding: RoleBinding = Object.freeze({
				organisationId: ctx.organisationId,
				...(input.projectId === undefined ? {} : { projectId: input.projectId }),
				principal: Object.freeze({ ...input.principal }),
				role,
				grantedAt: clock.now(),
				grantedBy: ctx.actor,
			});
			bindings.set(bindingKey(ctx.organisationId, binding.principal, input.projectId), binding);
			await emit(
				ctx,
				"identity.role.granted",
				ctx.organisationId,
				input.projectId === undefined
					? { kind: "identity.organisation", id: ctx.organisationId }
					: { kind: "identity.project", id: input.projectId },
				{ principal: principalData(binding.principal), role },
				input.projectId,
			);
			return binding;
		},

		async revokeRole(ctx, input) {
			if (input.projectId !== undefined) projectIn(ctx.organisationId, input.projectId);
			requireRole(ctx.actor, ctx.organisationId, input.projectId, "admin");
			const key = bindingKey(ctx.organisationId, input.principal, input.projectId);
			const binding = bindings.get(key);
			if (binding === undefined) throw notFound("role binding");
			bindings.delete(key);
			await emit(
				ctx,
				"identity.role.revoked",
				ctx.organisationId,
				input.projectId === undefined
					? { kind: "identity.organisation", id: ctx.organisationId }
					: { kind: "identity.project", id: input.projectId },
				{ principal: principalData(binding.principal), role: binding.role },
				input.projectId,
			);
		},

		async listRoleBindings(ctx, input) {
			const projectId = input?.projectId;
			if (projectId !== undefined) projectIn(ctx.organisationId, projectId);
			requireRole(ctx.actor, ctx.organisationId, projectId, "viewer");
			const all = bindingsOf(ctx.organisationId);
			return projectId === undefined ? all : all.filter((binding) => binding.projectId === projectId);
		},

		async issueApiKey(ctx, input): Promise<IssuedApiKey> {
			const projectIds = [...new Set(input.projectIds)];
			if (projectIds.length === 0) throw new HarbourError("invalid", "a key needs at least one project");
			for (const projectId of projectIds) projectIn(ctx.organisationId, projectId);
			for (const projectId of projectIds) requireRole(ctx.actor, ctx.organisationId, projectId, "admin");
			serviceIn(ctx.organisationId, input.serviceId);
			const role = requireRoleValue(input.role);
			const now = clock.now();
			if (input.expiresAt !== undefined && input.expiresAt <= now) {
				throw new HarbourError("invalid", "a key cannot expire before it is issued");
			}
			const secret = generateApiKeySecret();
			const key: ApiKey = Object.freeze({
				id: newId("key"),
				serviceId: input.serviceId,
				organisationId: ctx.organisationId,
				projectIds: Object.freeze(projectIds),
				role,
				prefix: apiKeyPrefix(secret),
				createdAt: now,
				...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
			});
			apiKeys.set(key.id, key);
			apiKeyIdsByHash.set(await hashApiKeySecret(secret), key.id);
			await emit(
				ctx,
				"identity.key.issued",
				ctx.organisationId,
				{ kind: "identity.api_key", id: key.id },
				{
					serviceId: key.serviceId,
					projectIds: [...key.projectIds],
					role,
					...(key.expiresAt === undefined ? {} : { expiresAt: key.expiresAt }),
				},
			);
			return { key, secret };
		},

		async revokeApiKey(ctx, keyId) {
			const key = apiKeys.get(keyId);
			if (key === undefined || key.organisationId !== ctx.organisationId) throw notFound("API key");
			for (const projectId of key.projectIds) requireRole(ctx.actor, ctx.organisationId, projectId, "admin");
			if (key.revokedAt !== undefined) return;
			apiKeys.set(key.id, Object.freeze({ ...key, revokedAt: clock.now() }));
			await emit(
				ctx,
				"identity.key.revoked",
				ctx.organisationId,
				{ kind: "identity.api_key", id: key.id },
				{ serviceId: key.serviceId, projectIds: [...key.projectIds] },
			);
		},

		async listApiKeys(ctx, input) {
			requireMember(ctx);
			return [...apiKeys.values()].filter(
				(key) =>
					key.organisationId === ctx.organisationId &&
					(input?.serviceId === undefined || key.serviceId === input.serviceId) &&
					key.projectIds.every((projectId) => {
						const held = resolveRole(ctx.actor, ctx.organisationId, projectId);
						return held !== undefined && roleSatisfies(held, "admin");
					}),
			);
		},

		async authenticateApiKey(ctx, secret): Promise<Authentication> {
			await requireSystem(ctx, "identity.authenticateApiKey", { ...(audit === undefined ? {} : { audit }), clock });
			const keyId = typeof secret === "string" ? apiKeyIdsByHash.get(await hashApiKeySecret(secret)) : undefined;
			const key = keyId === undefined ? undefined : apiKeys.get(keyId);
			if (key === undefined || !keyIsLive(key)) throw forbidden("the API key is not valid");
			return {
				actor: { kind: "service", serviceId: key.serviceId, keyId: key.id },
				organisationId: key.organisationId,
				projectIds: key.projectIds,
				role: key.role,
			};
		},

		async roleOf(ctx, actor, organisationId, projectId) {
			await requireSystem(ctx, "identity.roleOf", { ...(audit === undefined ? {} : { audit }), clock, organisationId });
			return resolveRole(actor, organisationId, projectId);
		},

		async authorize(ctx, needed) {
			requireRole(ctx.actor, ctx.organisationId, ctx.projectId, needed);
		},
	};
}
