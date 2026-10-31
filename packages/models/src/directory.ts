/**
 * The connector directory in memory: `createMemoryModelConnectors` implements `ModelConnectors` (contracts/models.ts)
 * with the access rules of its doc comment, and audits every change (source `control`).
 *
 * - Platform connectors and routes are changed only by a `system` caller (Kantel's operator); anyone else is
 *   `forbidden`, audited as `access.denied`.
 * - An organisation's connectors and routes, and its projects' policies, need an organisation-wide admin; a project's
 *   routes need an admin on the project. Reads need viewer. Agents read and change nothing here.
 * - A route name never contains `:`. A route uses only a connector the platform or the route owner's organisation owns,
 *   and a project's route must pass its project's policy (`refused` otherwise).
 * - `resolve` is a worker call for the gateway (`requireSystem`).
 */
import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	CONNECTOR_PRESETS,
	type ConnectorOwner,
	KantelError,
	isSystemActor,
	type JsonValue,
	type ModelCallScope,
	type ModelConnector,
	type ModelConnectors,
	type ModelRoute,
	type ModelThinking,
	PLATFORM_ORGANISATION,
	type ProjectAccess,
	type ProjectId,
	type ProjectModelPolicy,
	type RouteOwner,
	requireSystem,
	type SystemContext,
	systemClock,
	systemContext,
} from "@kantel/contracts";
import { pageOf } from "./page.ts";
import { policyAllows, resolveRoutes } from "./resolution.ts";

export interface MemoryModelConnectorsOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/**
	 * Checks callers on organisation and project records. Without it the directory checks only the organisation, that
	 * the caller is not an agent, and that platform records are changed by `system`.
	 */
	readonly access?: ProjectAccess;
}

export const MODEL_THINKING_LEVELS: readonly ModelThinking[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const DIRECTORY_CONTEXT: SystemContext = systemContext("models");
const REFUSAL = "The caller may not do this in this project";

function ownerKey(owner: RouteOwner): string {
	switch (owner.kind) {
		case "platform":
			return "platform";
		case "organisation":
			return `organisation:${owner.organisationId}`;
		case "project":
			return `project:${owner.organisationId}:${owner.projectId}`;
	}
}

function organisationOf(owner: RouteOwner): string {
	return owner.kind === "platform" ? PLATFORM_ORGANISATION : owner.organisationId;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function isStringList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(isNonEmptyString);
}

function validConnectorOwner(owner: unknown): owner is ConnectorOwner {
	if (typeof owner !== "object" || owner === null) return false;
	const candidate = owner as { kind?: unknown; organisationId?: unknown };
	return (
		candidate.kind === "platform" || (candidate.kind === "organisation" && isNonEmptyString(candidate.organisationId))
	);
}

function validRouteOwner(owner: unknown): owner is RouteOwner {
	if (validConnectorOwner(owner)) return true;
	if (typeof owner !== "object" || owner === null) return false;
	const candidate = owner as { kind?: unknown; organisationId?: unknown; projectId?: unknown };
	return (
		candidate.kind === "project" && isNonEmptyString(candidate.organisationId) && isNonEmptyString(candidate.projectId)
	);
}

/** Rejects with `invalid` unless `baseUrl` is an http(s) URL. */
export function assertHttpUrl(baseUrl: unknown): void {
	let url: URL | undefined;
	try {
		url = typeof baseUrl === "string" ? new URL(baseUrl) : undefined;
	} catch {
		url = undefined;
	}
	if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
		throw new KantelError("invalid", "A connector's base URL must be an http(s) URL");
	}
}

function assertScope(scope: unknown): asserts scope is ModelCallScope {
	const candidate = scope as Partial<ModelCallScope> | undefined;
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		!isNonEmptyString(candidate.organisationId) ||
		// An organisation session's scope names no project.
		(candidate.projectId !== undefined && !isNonEmptyString(candidate.projectId)) ||
		!isNonEmptyString(candidate.agentId) ||
		!isNonEmptyString(candidate.sessionId)
	) {
		throw new KantelError("invalid", "A model call scope names an organisation, a project, an agent and a session");
	}
}

/**
 * The reference `ModelConnectors`, in memory. Targets with durable storage keep the same rules over their own store;
 * the model connector suite in `@kantel/testing/models` drives this one through the gateway.
 */
export function createMemoryModelConnectors(options: MemoryModelConnectorsOptions = {}): ModelConnectors {
	const clock = options.clock ?? systemClock;
	const { audit, access } = options;
	const connectors = new Map<string, ModelConnector>();
	const routes = new Map<string, ModelRoute>();
	const policies = new Map<string, ProjectModelPolicy>();

	const policyKey = (organisationId: string, projectId: ProjectId) => `${organisationId}:${projectId}`;

	async function record(ctx: CallContext, event: Omit<AuditEventInput, "id" | "at" | "source" | "actor">) {
		if (audit === undefined) return;
		await audit.append(DIRECTORY_CONTEXT, [
			{
				...event,
				id: `models:${event.type}:${crypto.randomUUID()}`,
				at: clock.now(),
				source: "control",
				actor: ctx.actor,
			},
		]);
	}

	/** Refuses the call as `ProjectAccess` would: `forbidden`, audited once as `access.denied`. */
	async function deny(ctx: CallContext, operation: string, projectId?: ProjectId): Promise<never> {
		if (audit !== undefined) {
			const actor = ctx.actor;
			await audit.append(DIRECTORY_CONTEXT, [
				{
					id: `access:denied:${crypto.randomUUID()}`,
					at: clock.now(),
					source: "access",
					type: "access.denied",
					actor,
					organisationId: ctx.organisationId,
					...(projectId === undefined ? {} : { projectId }),
					...(actor.kind === "agent" ? { sessionId: actor.sessionId, agentId: actor.agentId } : {}),
					data: { operation, needed: "admin" },
				},
			]);
		}
		throw new KantelError("forbidden", REFUSAL, { operation });
	}

	function assertContext(ctx: CallContext): void {
		if (typeof ctx !== "object" || ctx === null || typeof ctx.actor !== "object" || ctx.actor === null) {
			throw new KantelError("forbidden", REFUSAL);
		}
	}

	/** The check every change makes: `system` for the platform's records, an admin for an organisation's or project's. */
	async function requireChange(ctx: CallContext, owner: RouteOwner, operation: string): Promise<void> {
		if (owner.kind === "platform") {
			await requireSystem(ctx, operation, {
				...(audit === undefined ? {} : { audit }),
				clock,
				...(typeof ctx?.organisationId === "string" ? { organisationId: ctx.organisationId } : {}),
			});
			return;
		}
		assertContext(ctx);
		if (isSystemActor(ctx.actor)) return;
		const projectId = owner.kind === "project" ? owner.projectId : undefined;
		if (ctx.actor.kind === "agent" || owner.organisationId !== ctx.organisationId) {
			return deny(ctx, operation, projectId);
		}
		await access?.require(ctx, {
			needed: "admin",
			operation,
			...(projectId === undefined ? {} : { projectId }),
		});
	}

	/** The check every read makes: viewer on the project named, or across the organisation. Agents read nothing here. */
	async function requireRead(ctx: CallContext, operation: string, projectId?: ProjectId): Promise<void> {
		assertContext(ctx);
		if (isSystemActor(ctx.actor)) return;
		if (ctx.actor.kind === "agent") return deny(ctx, operation, projectId);
		await access?.require(ctx, { needed: "viewer", operation, ...(projectId === undefined ? {} : { projectId }) });
	}

	const visibleConnector = (connector: ModelConnector | undefined, organisationId: string) =>
		connector !== undefined &&
		(connector.owner.kind === "platform" || connector.owner.organisationId === organisationId);

	function policyFor(organisationId: string, projectId: ProjectId | undefined): ProjectModelPolicy | undefined {
		if (projectId === undefined) return undefined;
		return policies.get(policyKey(organisationId, projectId));
	}

	const directory: ModelConnectors = {
		async putConnector(ctx, input) {
			if (!validConnectorOwner(input?.owner)) {
				throw new KantelError("invalid", "A connector is owned by the platform or an organisation");
			}
			await requireChange(ctx, input.owner, "models.putConnector");
			if (!isNonEmptyString(input.id)) throw new KantelError("invalid", "A connector needs an ID");
			if (!CONNECTOR_PRESETS.includes(input.preset)) {
				throw new KantelError("invalid", `Unknown connector preset ${String(input.preset)}`);
			}
			assertHttpUrl(input.baseUrl);
			if (!isNonEmptyString(input.vaultItemId)) throw new KantelError("invalid", "A connector names a vault item");
			const catalogue = input.catalogue;
			if (
				typeof catalogue !== "object" ||
				catalogue === null ||
				(catalogue.refresh !== "gateway" && catalogue.refresh !== "static") ||
				(catalogue.include !== undefined && !isStringList(catalogue.include))
			) {
				throw new KantelError("invalid", "A connector's catalogue refreshes from the gateway or is static");
			}
			const existing = connectors.get(input.id);
			if (existing !== undefined && ownerKey(existing.owner) !== ownerKey(input.owner)) {
				throw new KantelError("conflict", `Connector ID ${input.id} is taken`);
			}
			const now = clock.now();
			const connector: ModelConnector = {
				id: input.id,
				owner: input.owner,
				preset: input.preset,
				baseUrl: input.baseUrl,
				vaultItemId: input.vaultItemId,
				catalogue: {
					refresh: catalogue.refresh,
					...(catalogue.include === undefined ? {} : { include: [...catalogue.include] }),
					...(catalogue.overrides === undefined ? {} : { overrides: { ...catalogue.overrides } }),
				},
				...(input.compat === undefined ? {} : { compat: input.compat }),
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			connectors.set(connector.id, connector);
			await record(ctx, {
				type: "models.connector.put",
				organisationId: organisationOf(connector.owner),
				subject: { kind: "models.connector", id: connector.id },
				data: {
					preset: connector.preset,
					baseUrl: connector.baseUrl,
					vaultItemId: connector.vaultItemId,
					owner: connector.owner.kind,
					created: existing === undefined,
				},
			});
			return connector;
		},

		async getConnector(ctx, connectorId) {
			await requireRead(ctx, "models.getConnector", ctx?.projectId);
			const connector = connectors.get(connectorId);
			if (!visibleConnector(connector, ctx.organisationId)) {
				throw new KantelError("not_found", `No connector ${connectorId}`);
			}
			return connector!;
		},

		async listConnectors(ctx, page) {
			await requireRead(ctx, "models.listConnectors", ctx?.projectId);
			const visible = [...connectors.values()]
				.filter((connector) => visibleConnector(connector, ctx.organisationId))
				.sort((a, b) => a.id.localeCompare(b.id));
			return pageOf(visible, page);
		},

		async deleteConnector(ctx, connectorId) {
			assertContext(ctx);
			const connector = connectors.get(connectorId);
			if (connector === undefined || (!isSystemActor(ctx.actor) && !visibleConnector(connector, ctx.organisationId))) {
				throw new KantelError("not_found", `No connector ${connectorId}`);
			}
			await requireChange(ctx, connector.owner, "models.deleteConnector");
			connectors.delete(connectorId);
			await record(ctx, {
				type: "models.connector.delete",
				organisationId: organisationOf(connector.owner),
				subject: { kind: "models.connector", id: connector.id },
				data: { owner: connector.owner.kind },
			});
		},

		async putRoute(ctx, input) {
			if (!validRouteOwner(input?.owner)) {
				throw new KantelError("invalid", "A route is owned by the platform, an organisation or a project");
			}
			await requireChange(ctx, input.owner, "models.putRoute");
			if (!isNonEmptyString(input.name) || input.name.includes(":")) {
				throw new KantelError("invalid", "A route needs a name without `:`");
			}
			if (!isNonEmptyString(input.connectorId) || !isNonEmptyString(input.modelId)) {
				throw new KantelError("invalid", "A route names a connector and a model");
			}
			if (input.thinking !== undefined && !MODEL_THINKING_LEVELS.includes(input.thinking)) {
				throw new KantelError("invalid", `Unknown thinking level ${String(input.thinking)}`);
			}
			const connector = connectors.get(input.connectorId);
			const usable =
				connector !== undefined &&
				(connector.owner.kind === "platform" ||
					(input.owner.kind !== "platform" && connector.owner.organisationId === input.owner.organisationId));
			if (!usable) {
				throw new KantelError(
					"refused",
					`Connector ${input.connectorId} is neither the platform's nor the route owner's organisation's`,
				);
			}
			if (input.owner.kind === "project") {
				const policy = policyFor(input.owner.organisationId, input.owner.projectId);
				if (!policyAllows(policy, input.connectorId, input.modelId)) {
					throw new KantelError("refused", "The project's model policy excludes this connector or model");
				}
			}
			const route: ModelRoute = {
				name: input.name,
				owner: input.owner,
				connectorId: input.connectorId,
				modelId: input.modelId,
				...(input.thinking === undefined ? {} : { thinking: input.thinking }),
				updatedAt: clock.now(),
			};
			routes.set(`${ownerKey(route.owner)}|${route.name}`, route);
			await record(ctx, {
				type: "models.route.put",
				organisationId: organisationOf(route.owner),
				...(route.owner.kind === "project" ? { projectId: route.owner.projectId } : {}),
				subject: { kind: "models.route", id: `${ownerKey(route.owner)}|${route.name}` },
				data: {
					name: route.name,
					owner: route.owner.kind,
					connectorId: route.connectorId,
					modelId: route.modelId,
					...(route.thinking === undefined ? {} : { thinking: route.thinking }),
				},
			});
			return route;
		},

		async listRoutes(ctx, filter, page) {
			const projectId = filter?.projectId ?? ctx?.projectId;
			await requireRead(ctx, "models.listRoutes", projectId);
			const visible = [...routes.values()]
				.filter((route) => {
					const owner = route.owner;
					if (owner.kind === "platform") return true;
					if (owner.kind === "organisation") return owner.organisationId === ctx.organisationId;
					return (
						owner.organisationId === ctx.organisationId && (projectId === undefined || owner.projectId === projectId)
					);
				})
				.sort((a, b) => ownerKey(a.owner).localeCompare(ownerKey(b.owner)) || a.name.localeCompare(b.name));
			return pageOf(visible, page);
		},

		async deleteRoute(ctx, owner, name) {
			if (!validRouteOwner(owner)) {
				throw new KantelError("invalid", "A route is owned by the platform, an organisation or a project");
			}
			await requireChange(ctx, owner, "models.deleteRoute");
			const key = `${ownerKey(owner)}|${name}`;
			if (!routes.has(key)) throw new KantelError("not_found", `No route ${name}`);
			routes.delete(key);
			await record(ctx, {
				type: "models.route.delete",
				organisationId: organisationOf(owner),
				...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
				subject: { kind: "models.route", id: key },
				data: { name, owner: owner.kind },
			});
		},

		async setProjectPolicy(ctx, input) {
			if (!isNonEmptyString(input?.organisationId) || !isNonEmptyString(input.projectId)) {
				throw new KantelError("invalid", "A policy names its organisation and project");
			}
			// A policy bounds its project, so it takes an organisation-wide admin, not one on the project.
			await requireChange(
				ctx,
				{ kind: "organisation", organisationId: input.organisationId },
				"models.setProjectPolicy",
			);
			if (
				(input.connectors !== undefined && !isStringList(input.connectors)) ||
				(input.models !== undefined && !isStringList(input.models))
			) {
				throw new KantelError("invalid", "A policy's connectors and models are lists of IDs");
			}
			const policy: ProjectModelPolicy = {
				organisationId: input.organisationId,
				projectId: input.projectId,
				...(input.connectors === undefined ? {} : { connectors: [...input.connectors] }),
				...(input.models === undefined ? {} : { models: [...input.models] }),
				updatedAt: clock.now(),
			};
			policies.set(policyKey(policy.organisationId, policy.projectId), policy);
			const list = (values: readonly string[] | undefined): JsonValue => (values === undefined ? null : [...values]);
			await record(ctx, {
				type: "models.policy.set",
				organisationId: policy.organisationId,
				projectId: policy.projectId,
				subject: { kind: "models.policy", id: policy.projectId },
				data: { connectors: list(policy.connectors), models: list(policy.models) },
			});
			return policy;
		},

		async getProjectPolicy(ctx, projectId) {
			await requireRead(ctx, "models.getProjectPolicy", projectId);
			return (
				policyFor(ctx.organisationId, projectId) ?? { organisationId: ctx.organisationId, projectId, updatedAt: 0 }
			);
		},

		async resolve(ctx, scope) {
			await requireSystem(ctx, "models.resolve", {
				...(audit === undefined ? {} : { audit }),
				clock,
				...(typeof scope?.organisationId === "string" ? { organisationId: scope.organisationId } : {}),
			});
			assertScope(scope);
			return resolveRoutes({
				routes: [...routes.values()],
				connectors: [...connectors.values()],
				policy: policyFor(scope.organisationId, scope.projectId),
				scope,
			});
		},
	};
	return directory;
}
