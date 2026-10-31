/**
 * Connections on Cloudflare (epic #322): their records in D1 with the stack, their secrets in the VaultDO
 * (`connectionSecret` over RPC), and every request a session makes through one sent from the stack object, not from an
 * isolate (which has no network).
 *
 * The Worker's vars:
 *
 * - `HARBOUR_HOSTNAME`: the deployment's hostname (the deploy config sets it). Redirect URIs, connect URLs and the
 *   client ID metadata document's URL are built from it, so without it there are no connections.
 * - `HARBOUR_CONNECTIONS`: `off` turns connections off. Anything else (the default) has them.
 * - `HARBOUR_CONNECTIONS_CIMD`: `on` once `/v1/connections/oauth/client-metadata.json` is reachable without signing in
 *   (a Cloudflare Access Bypass policy on that path). Only then is CIMD offered to authorisation servers; until then
 *   remote MCP servers are connected with dynamic registration or a registered client.
 * - `HARBOUR_CONNECTIONS_PERSONAL`: `on` for a deployment with one person, where every session acting for them is
 *   theirs alone, so their personal connections work everywhere. Default off: a session is seen by its project. The
 *   deploy config sets it from the repository variable of the same name (scripts/deploy-config.ts).
 * A rule's `ask` waits on an approval of the exact request (#333), kept in the VaultDO (`connectionApproval` over RPC)
 * and decided on the connection request page, as every connection request is.
 * - `HARBOUR_OAUTH_CLIENTS`: the deployment's own OAuth clients (#326), a JSON array of
 *   `{ templateId?, issuer?, clientId, secretEnv?, scopes?, label? }`. A confidential client's secret is a Worker secret
 *   named by `secretEnv`, never written in the JSON; one with no `secretEnv` is a public client (the device flow where
 *   the provider has it). A bad entry is logged and left out.
 */

import { parsePlatformClients } from "@harbour/connections/platform-clients";
import { vaultCeiling } from "@harbour/connections/rules";
import { vaultCredentials } from "@harbour/connections/vault-store";
import type {
	CallContext,
	ConnectionApprovalCall,
	ConnectionApprovalResult,
	ConnectionSecretCall,
	ConnectionSecretResult,
	SystemContext,
} from "@harbour/contracts";
import type { StackConnections } from "./stack.ts";
import { type ApprovalCallResult, type CeilingMethod, ceilingVaultOver } from "./vault.ts";

export interface ConnectionsVars {
	readonly HARBOUR_HOSTNAME?: string;
	readonly HARBOUR_CONNECTIONS?: string;
	readonly HARBOUR_CONNECTIONS_CIMD?: string;
	readonly HARBOUR_CONNECTIONS_PERSONAL?: string;
	readonly HARBOUR_OAUTH_CLIENTS?: string;
}

export interface ConnectionSecretsRpc {
	connectionSecret(ctx: SystemContext, call: ConnectionSecretCall): Promise<ConnectionSecretResult>;
	/** The organisation's ceiling, which bounds connection rules (#332). Absent: rules have no ceiling. */
	ceilingCall?(method: CeilingMethod, ctx: CallContext, args: readonly unknown[]): Promise<ApprovalCallResult>;
	/** Approvals bound to the exact request (#333). */
	connectionApproval(ctx: SystemContext, call: ConnectionApprovalCall): Promise<ConnectionApprovalResult>;
}

const flag = (value: string | undefined) => (value ?? "").trim().toLowerCase();

/** The stack's connections, or undefined when they are off or the deployment has no hostname. */
export function stackConnectionsFrom(
	vars: ConnectionsVars,
	vault: () => ConnectionSecretsRpc,
): StackConnections | undefined {
	if (flag(vars.HARBOUR_CONNECTIONS) === "off") return undefined;
	const hostname = flag(vars.HARBOUR_HOSTNAME);
	if (hostname === "" || !/^[a-z0-9.-]+(:\d+)?$/.test(hostname)) return undefined;
	const local = hostname.startsWith("localhost") || hostname.startsWith("127.0.0.1");
	const personal = flag(vars.HARBOUR_CONNECTIONS_PERSONAL) === "on";
	// A `secretEnv` names another var or Worker secret on the same env, so it is read off whatever object was passed.
	const env = vars as unknown as { readonly [name: string]: unknown };
	const platform = parsePlatformClients(vars.HARBOUR_OAUTH_CLIENTS, (name) => {
		const value = env[name];
		return typeof value === "string" ? value : undefined;
	});
	for (const problem of platform.problems) console.warn(`harbour: ${problem}`);
	return {
		credentials: vaultCredentials({ connectionSecret: (ctx, call) => vault().connectionSecret(ctx, call) }),
		ceiling: vaultCeiling(() =>
			ceilingVaultOver(async (method, ctx, args) => {
				const rpc = vault();
				if (rpc.ceilingCall === undefined) {
					return method === "getCeiling"
						? { ok: false, code: "not_found", message: "No ceiling" }
						: { ok: false, code: "not_supported", message: "This deployment keeps no ceiling for connections" };
				}
				return rpc.ceilingCall(method, ctx, args);
			}),
		),
		approvals: { connectionApproval: (ctx, call) => vault().connectionApproval(ctx, call) },
		deployment: {
			origin: `${local ? "http" : "https"}://${hostname}`,
			clientMetadataPublic: flag(vars.HARBOUR_CONNECTIONS_CIMD) === "on",
			// Reported by `GET /v1/connections/settings`, so the console can warn about a connection no session could use.
			...(personal ? { personal: true } : {}),
			...(platform.clients.length === 0 ? {} : { platformClients: platform.clients }),
		},
		...(personal ? { personal: true } : {}),
	};
}
