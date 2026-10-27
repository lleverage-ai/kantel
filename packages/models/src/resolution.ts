/**
 * Route resolution, as pure functions over the directory's records (docs/model-connectors.md, "Resolution and the
 * key"). Routes resolve platform → organisation → project, the nearest owner's route of a name winning; the project's
 * policy then filters the result, keeping a route only when its connector and model pass. A farther route of the same
 * name never stands in for a nearer one the policy drops.
 */
import type {
	ModelCallScope,
	ModelConnector,
	ModelRoute,
	ProjectModelPolicy,
	ResolvedModelRoute,
	RouteOwner,
} from "@harbour/contracts";

/** What a `POST /messages` model ID names: a route, and for an override the upstream model on the route's connector. */
export interface ModelRequestId {
	readonly route: string;
	readonly modelId?: string;
}

/**
 * Parses `<route>` or `<route>:<modelId>`, split at the first `:` since upstream model IDs may contain colons. An
 * empty route, or an empty model after the `:`, is undefined.
 */
export function parseModelRequestId(id: string): ModelRequestId | undefined {
	const at = id.indexOf(":");
	if (at === -1) return id.length === 0 ? undefined : { route: id };
	const route = id.slice(0, at);
	const modelId = id.slice(at + 1);
	return route.length === 0 || modelId.length === 0 ? undefined : { route, modelId };
}

/** The ID `config` lists an override under. */
export function overrideId(route: string, modelId: string): string {
	return `${route}:${modelId}`;
}

/** How near an owner is to `scope`: 0 for the project, 1 for its organisation, 2 for the platform, else undefined. */
export function ownerDistance(owner: RouteOwner, scope: Pick<ModelCallScope, "organisationId" | "projectId">) {
	switch (owner.kind) {
		case "project":
			return owner.organisationId === scope.organisationId && owner.projectId === scope.projectId ? 0 : undefined;
		case "organisation":
			return owner.organisationId === scope.organisationId ? 1 : undefined;
		case "platform":
			return 2;
		default:
			return undefined;
	}
}

/** Whether a connector may serve `organisationId`: the platform's serve everyone, an organisation's only itself. */
export function connectorServes(connector: Pick<ModelConnector, "owner">, organisationId: string): boolean {
	return connector.owner.kind === "platform" || connector.owner.organisationId === organisationId;
}

/** Whether the project's policy allows `modelId` on `connectorId`. No policy, or an absent list, allows everything. */
export function policyAllows(
	policy: Pick<ProjectModelPolicy, "connectors" | "models"> | undefined,
	connectorId: string,
	modelId: string,
): boolean {
	if (policy === undefined) return true;
	if (policy.connectors !== undefined && !policy.connectors.includes(connectorId)) return false;
	if (policy.models !== undefined && !policy.models.includes(modelId)) return false;
	return true;
}

/** For each route name, the nearest owner's route visible to `scope`. */
export function nearestRoutes(routes: readonly ModelRoute[], scope: ModelCallScope): readonly ModelRoute[] {
	const nearest = new Map<string, { readonly route: ModelRoute; readonly distance: number }>();
	for (const route of routes) {
		const distance = ownerDistance(route.owner, scope);
		if (distance === undefined) continue;
		const current = nearest.get(route.name);
		if (current === undefined || distance < current.distance) nearest.set(route.name, { route, distance });
	}
	return [...nearest.values()].map((entry) => entry.route).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The routes `scope` may use: the nearest route of each name, kept only when its connector exists, serves the
 * session's organisation and passes the project's policy along with the route's model. Sorted by name.
 */
export function resolveRoutes(input: {
	readonly routes: readonly ModelRoute[];
	readonly connectors: readonly ModelConnector[];
	readonly policy?: Pick<ProjectModelPolicy, "connectors" | "models">;
	readonly scope: ModelCallScope;
}): readonly ResolvedModelRoute[] {
	const byId = new Map(input.connectors.map((connector) => [connector.id, connector]));
	const resolved: ResolvedModelRoute[] = [];
	for (const route of nearestRoutes(input.routes, input.scope)) {
		const connector = byId.get(route.connectorId);
		if (connector === undefined || !connectorServes(connector, input.scope.organisationId)) continue;
		if (!policyAllows(input.policy, connector.id, route.modelId)) continue;
		resolved.push({ route, connector });
	}
	return resolved;
}
