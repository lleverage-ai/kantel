// The vault's side of the self-hosted egress proxy (apps/vault-proxy), for when the proxy takes its decisions from the
// vault (its HARBOUR_EGRESS_SOURCE=vault) instead of its static policy file. Mounted only when HARBOUR_EGRESS_KEY is
// set:
//
//   POST /v1/egress/decisions   the vault's egress decision API (@harbour/vault/egress-api), for the proxy alone: it
//                               presents HARBOUR_EGRESS_KEY and the vault sees it as the `egress-gateway` component.
//                               An allowed decision also carries `redact`: the item's own value, cut out of the
//                               rendered header by its template, which the proxy must redact from the response (a
//                               header such as `prefix-<key>` would not redact a bare `<key>` echoed back)
//   GET  /v1/egress/scope       the organisation and project the proxy decides for: the deployment's bootstrap ones.
//                               The M0 session hosts' sessions belong to no M1 organisation, so their sandboxes'
//                               egress is the deployment's
//
// On start the gateway imports the proxy's policy file (deploy/compose/vault-policy.json) into the vault: each route
// that injects a credential becomes an item, holding the secret its `secretEnv` names, and a policy for the
// deployment's project (`importHostGrants`). Routes with no credential stay the proxy's own "open" routes: the vault
// decides credentials, and has no way to allow a request without one.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	type CallContext,
	type EgressDecision,
	type EgressRequest,
	HarbourError,
	type HttpMethod,
	type OrganisationId,
	type ProjectId,
	type SystemContext,
} from "@harbour/contracts";
import { createEgressDecisionApi, createSharedKeyAuthenticator, EGRESS_API_PATHS } from "@harbour/vault/egress-api";
import type { HarbourVault } from "@harbour/vault/engine";
import { type HostGrant, type HostGrantImport, importHostGrants } from "@harbour/vault/import";

export const EGRESS_SCOPE_PATH = "/v1/egress/scope";

/** The component the proxy's key authenticates as. */
export const EGRESS_COMPONENT = "egress-gateway";

export interface EgressScope {
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
}

/** One route of the proxy's policy file, as apps/vault-proxy reads it. */
interface PolicyRoute {
	readonly id: string;
	readonly host: string;
	readonly ports?: readonly number[];
	readonly methods: readonly string[];
	readonly pathPrefix?: string;
	readonly inject?: { readonly header: string; readonly template: string; readonly secretEnv: string };
	readonly tunnel?: boolean;
}

export interface PolicyGrants {
	readonly grants: readonly HostGrant[];
	/** The routes left to the proxy: no credential to inject (open routes and raw TLS tunnels). */
	readonly leftToProxy: readonly string[];
}

/**
 * The vault grants for a policy file's credentialed routes, in `scope`. The proxy's `{secret}` is the vault's `{key}`.
 * Throws when a route's secret is not in `env`: the item would have no value, and every request on it would be denied.
 */
export function policyGrants(
	policy: unknown,
	scope: EgressScope,
	env: { readonly [name: string]: string | undefined },
): PolicyGrants {
	const routes = (policy as { routes?: unknown })?.routes;
	if (!Array.isArray(routes)) throw new Error("the egress policy file has no `routes` list");
	const grants: HostGrant[] = [];
	const leftToProxy: string[] = [];
	for (const route of routes as PolicyRoute[]) {
		if (route.inject === undefined || route.tunnel === true) {
			leftToProxy.push(route.id);
			continue;
		}
		const value = env[route.inject.secretEnv];
		if (value === undefined || value === "") {
			throw new Error(`the egress policy's route ${route.id} needs ${route.inject.secretEnv}, which is not set`);
		}
		const host = route.host.toLowerCase();
		grants.push({
			name: route.id,
			description: `Imported from the egress proxy's policy file (route ${route.id})`,
			hosts: [host],
			injection: { header: route.inject.header, template: route.inject.template.replaceAll("{secret}", "{key}") },
			value,
			routes: [{ host, methods: route.methods as HttpMethod[], pathPrefix: route.pathPrefix ?? "/" }],
			selector: { organisationId: scope.organisationId, projectId: scope.projectId },
		});
	}
	return { grants, leftToProxy };
}

/**
 * A fingerprint of the grants without their values, so a start imports again only when the routes changed. A changed
 * secret is not imported again either way: `importHostGrants` keeps a reused item's value.
 */
export function grantsDigest(grants: readonly HostGrant[]): string {
	const withoutValues = grants.map(({ value: _value, ...grant }) => grant);
	return createHash("sha256").update(JSON.stringify(withoutValues)).digest("hex");
}

export interface PolicyImport {
	readonly digest: string;
	readonly result?: HostGrantImport;
	readonly leftToProxy: readonly string[];
}

/**
 * Imports `file`'s credentialed routes into `vault` for `scope`, unless `previousDigest` says this deployment already
 * imported the same grants: so a policy an admin revokes stays revoked across restarts. Refused grants are an error.
 */
export async function importPolicyFile(
	vault: HarbourVault,
	scope: EgressScope,
	file: string,
	env: { readonly [name: string]: string | undefined },
	previousDigest?: string,
): Promise<PolicyImport> {
	const { grants, leftToProxy } = policyGrants(JSON.parse(await readFile(file, "utf8")), scope, env);
	const digest = grantsDigest(grants);
	if (digest === previousDigest) return { digest, leftToProxy };
	const ctx: CallContext = {
		actor: { kind: "system", component: "selfhosted-egress" },
		organisationId: scope.organisationId,
		projectId: scope.projectId,
	};
	const result = await importHostGrants(vault, ctx, grants);
	if (result.refused.length > 0) {
		const reasons = result.refused.map((refused) => `${refused.name}: ${refused.message}`).join("; ");
		throw new Error(`the vault refused egress grants from ${file}: ${reasons}`);
	}
	return { digest, result, leftToProxy };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});

export interface EgressHandler {
	matches(path: string): boolean;
	fetch(request: Request): Promise<Response>;
}

/** An allowed decision, with the item values to redact from its response. */
export type RedactingDecision = EgressDecision & { readonly redact?: readonly string[] };

/** How many pages of items a decision reads to find the one it injected. */
const MAX_ITEM_PAGES = 20;

/**
 * The item values inside `inject`: for each item of the organisation injecting that header whose template could have
 * rendered it, the part its `{key}` stands for. Each is a substring of the injected value, so one too many only redacts
 * more.
 */
async function keysIn(
	vault: HarbourVault,
	ctx: SystemContext,
	request: EgressRequest,
	inject: { readonly header: string; readonly value: string },
): Promise<string[]> {
	const list: CallContext = {
		...ctx,
		organisationId: request.organisationId,
		...(request.projectId === undefined ? {} : { projectId: request.projectId }),
	};
	const keys = new Set<string>();
	let cursor: string | undefined;
	for (let pages = 0; pages < MAX_ITEM_PAGES; pages += 1) {
		const page = await vault.listItems(list, cursor === undefined ? undefined : { cursor });
		for (const item of page.items) {
			if (item.injection.header.toLowerCase() !== inject.header.toLowerCase()) continue;
			const at = item.injection.template.indexOf("{key}");
			if (at < 0) continue;
			const prefix = item.injection.template.slice(0, at);
			const suffix = item.injection.template.slice(at + "{key}".length);
			const { value } = inject;
			if (value.length <= prefix.length + suffix.length) continue;
			if (!value.startsWith(prefix) || !value.endsWith(suffix)) continue;
			keys.add(value.slice(prefix.length, value.length - suffix.length));
		}
		if (page.nextCursor === undefined) break;
		cursor = page.nextCursor;
	}
	return [...keys];
}

/** The proxy's routes: the vault's decisions and the scope, both behind the proxy's shared key. */
export function createEgressHandler(options: {
	readonly vault: HarbourVault;
	readonly key: string;
	readonly scope: EgressScope;
}): EgressHandler {
	const { vault } = options;
	const authenticate = createSharedKeyAuthenticator({ keys: { [EGRESS_COMPONENT]: options.key } });
	const decisions = createEgressDecisionApi({
		vault: {
			async decideEgress(ctx, request) {
				const decision = await vault.decideEgress(ctx, request);
				if (!decision.allow || decision.inject === undefined) return decision;
				const redacting: RedactingDecision = {
					...decision,
					redact: await keysIn(vault, ctx, request, decision.inject),
				};
				return redacting;
			},
			readConnectorCredential: (ctx, request) => vault.readConnectorCredential(ctx, request),
		},
		authenticate,
	});
	return {
		matches: (path) => path === EGRESS_API_PATHS.decisions || path === EGRESS_SCOPE_PATH,
		async fetch(request) {
			if (new URL(request.url).pathname !== EGRESS_SCOPE_PATH) return decisions(request);
			if (request.method !== "GET") {
				return json({ error: { code: "not_supported", message: "Use GET" } }, 405, { allow: "GET" });
			}
			try {
				await authenticate(request);
			} catch (error) {
				if (error instanceof HarbourError) return json({ error: { code: error.code, message: error.message } }, 403);
				throw error;
			}
			return json({ organisationId: options.scope.organisationId, projectId: options.scope.projectId });
		},
	};
}
