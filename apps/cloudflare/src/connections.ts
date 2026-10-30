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
 *   theirs alone, so their personal connections work everywhere. Default off: a session is seen by its project.
 */

import { vaultCredentials } from "@harbour/connections/vault-store";
import type { ConnectionSecretCall, ConnectionSecretResult, SystemContext } from "@harbour/contracts";
import type { StackConnections } from "./stack.ts";

export interface ConnectionsVars {
	readonly HARBOUR_HOSTNAME?: string;
	readonly HARBOUR_CONNECTIONS?: string;
	readonly HARBOUR_CONNECTIONS_CIMD?: string;
	readonly HARBOUR_CONNECTIONS_PERSONAL?: string;
}

export interface ConnectionSecretsRpc {
	connectionSecret(ctx: SystemContext, call: ConnectionSecretCall): Promise<ConnectionSecretResult>;
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
	return {
		credentials: vaultCredentials({ connectionSecret: (ctx, call) => vault().connectionSecret(ctx, call) }),
		deployment: {
			origin: `${local ? "http" : "https"}://${hostname}`,
			clientMetadataPublic: flag(vars.HARBOUR_CONNECTIONS_CIMD) === "on",
		},
		...(flag(vars.HARBOUR_CONNECTIONS_PERSONAL) === "on" ? { personal: true } : {}),
	};
}
