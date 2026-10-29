// The vault's side of the self-hosted egress proxy (apps/vault-proxy), for when the proxy takes its decisions from the
// vault (its HARBOUR_EGRESS_SOURCE=vault) instead of its static policy file. Mounted only when HARBOUR_EGRESS_KEY is
// set:
//
//   POST /v1/egress/decisions   the vault's egress decision API (@harbour/vault/egress-api), for the proxy alone: it
//                               presents HARBOUR_EGRESS_KEY and the vault sees it as the `egress-gateway` component.
//                               An allowed decision also carries `redact`: the value of the item it injected (found
//                               through the decision's grant or policy), cut out of the rendered header by that
//                               item's template, which the proxy must redact from the response (a header such as
//                               `prefix-<key>` would not redact a bare `<key>` echoed back). Empty when it can't be
//                               found, and the proxy then refuses the request
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

/** A fingerprint of the grants without their values: which routes a deployment imported, so a later start can say
 * whether the file has changed since. */
export function grantsDigest(grants: readonly HostGrant[]): string {
	const withoutValues = grants.map(({ value: _value, ...grant }) => grant);
	return createHash("sha256").update(JSON.stringify(withoutValues)).digest("hex");
}

export interface PolicyImport {
	/** What was imported: this file's fingerprint on the first start, the first import's after. */
	readonly digest: string;
	/** The import, on the first start only. */
	readonly result?: HostGrantImport;
	/** Whether the file's credentialed routes differ from what was imported (and were not imported again). */
	readonly changed: boolean;
	readonly leftToProxy: readonly string[];
}

/**
 * Imports `file`'s credentialed routes into `vault` for `scope` on a deployment's first start only: once
 * `previousDigest` says it imported, the vault page owns its items and policies. Importing again would be additive
 * (`importHostGrants` never revokes), so a narrowed route would keep the old policy and a policy an admin revoked
 * would come back. A changed file is reported (`changed`), not imported. Refused grants are an error.
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
	if (previousDigest !== undefined) return { digest: previousDigest, changed: digest !== previousDigest, leftToProxy };
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
	return { digest, result, changed: false, leftToProxy };
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

/** A bound on reading policies page by page, against a cursor that never ends. */
const MAX_POLICY_PAGES = 1000;

/** The item an allowed decision injected, through its grant or policy; undefined when it can't be found. */
async function itemIdOf(vault: HarbourVault, ctx: CallContext, decision: EgressDecision): Promise<string | undefined> {
	if (decision.grantId !== undefined) return (await vault.getGrant(ctx, decision.grantId)).itemId;
	if (decision.policyId === undefined) return undefined;
	let cursor: string | undefined;
	for (let pages = 0; pages < MAX_POLICY_PAGES; pages += 1) {
		const page = await vault.listPolicies(ctx, cursor === undefined ? undefined : { cursor });
		const found = page.items.find((policy) => policy.id === decision.policyId);
		if (found !== undefined) return found.itemId;
		if (page.nextCursor === undefined) return undefined;
		cursor = page.nextCursor;
	}
	return undefined;
}

/**
 * The value of the item an allowed decision injected: the part of the injected header its template's `{key}` stands
 * for (the engine fills in the first). None when the item can't be found or its template doesn't fit the header.
 */
async function keysIn(
	vault: HarbourVault,
	ctx: SystemContext,
	request: EgressRequest,
	decision: EgressDecision & { readonly inject: { readonly header: string; readonly value: string } },
): Promise<string[]> {
	const read: CallContext = {
		...ctx,
		organisationId: request.organisationId,
		...(request.projectId === undefined ? {} : { projectId: request.projectId }),
	};
	const itemId = await itemIdOf(vault, read, decision);
	if (itemId === undefined) return [];
	const { injection } = await vault.getItem(read, itemId);
	const at = injection.template.indexOf("{key}");
	if (at < 0) return [];
	const prefix = injection.template.slice(0, at);
	const suffix = injection.template.slice(at + "{key}".length);
	const { value } = decision.inject;
	if (injection.header.toLowerCase() !== decision.inject.header.toLowerCase()) return [];
	if (value.length <= prefix.length + suffix.length || !value.startsWith(prefix) || !value.endsWith(suffix)) return [];
	return [value.slice(prefix.length, value.length - suffix.length)];
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
				const { inject } = decision;
				if (!decision.allow || inject === undefined) return decision;
				const redacting: RedactingDecision = {
					...decision,
					redact: await keysIn(vault, ctx, request, { ...decision, inject }),
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
