/**
 * Connections on the self-hosted gateway (epic #322): records in the gateway's store (Postgres, or memory), secrets in
 * its vault (`connectionSecret`), and every request a session makes through one sent from the gateway process, with
 * the credential added there, never in the sandbox.
 *
 * On with `HARBOUR_PUBLIC_URL` (redirect URIs and connect URLs are built from it) and a vault; off with
 * `HARBOUR_CONNECTIONS=off`. `HARBOUR_CONNECTIONS_CIMD=on` once `/v1/connections/oauth/client-metadata.json` is
 * reachable from the internet without signing in; `HARBOUR_CONNECTIONS_PERSONAL=on` for a deployment with one person.
 */
import { type ConnectionsService, createConnections } from "@harbour/connections";
import type { ConnectionsRepository } from "@harbour/connections/repository";
import { connectionTools } from "@harbour/connections/tools";
import { vaultCredentials } from "@harbour/connections/vault-store";
import type { AuditSink, ProjectAccess, SessionRecord } from "@harbour/contracts";
import type { SessionRuntimeOptions } from "@harbour/runtime/core";
import type { HarbourVault } from "@harbour/vault/engine";

export interface GatewayConnectionsConfig {
	/** The public origin people reach the console at. */
	readonly origin: string;
	readonly clientMetadataPublic: boolean;
	readonly personal: boolean;
}

/** Connections' configuration from the environment, or undefined when they are off. */
export function connectionsConfig(
	env: NodeJS.ProcessEnv,
	publicOrigin: string | undefined,
): GatewayConnectionsConfig | undefined {
	const flag = (name: string) => env[name]?.trim().toLowerCase() ?? "";
	if (flag("HARBOUR_CONNECTIONS") === "off" || publicOrigin === undefined) return undefined;
	return {
		origin: publicOrigin,
		clientMetadataPublic: flag("HARBOUR_CONNECTIONS_CIMD") === "on",
		personal: flag("HARBOUR_CONNECTIONS_PERSONAL") === "on",
	};
}

/**
 * The connections service once the vault exists (it is built after the runtime), and the session tools, which ask for
 * it per call. Without a vault there is no service and the tools are not offered.
 */
export function gatewayConnections(options: {
	readonly config: GatewayConnectionsConfig;
	readonly repository: ConnectionsRepository;
	readonly audit: AuditSink;
	readonly access: () => ProjectAccess;
}) {
	let service: ConnectionsService | undefined;
	let tools: ((record: SessionRecord) => ReturnType<ReturnType<typeof connectionTools>>) | undefined;
	return {
		/** Builds the service over the vault. Call once, after the vault is made. */
		attach(vault: HarbourVault): ConnectionsService {
			service = createConnections({
				repository: options.repository,
				credentials: vaultCredentials(vault),
				deployment: { origin: options.config.origin, clientMetadataPublic: options.config.clientMetadataPublic },
				access: options.access,
				audit: options.audit,
			});
			tools = connectionTools({ connections: service, personal: options.config.personal });
			return service;
		},
		/** The runtime's `tools`, with the connection tools added once the service is attached. */
		withTools(inner: SessionRuntimeOptions["tools"]): SessionRuntimeOptions["tools"] {
			return (record: SessionRecord) => [...(inner?.(record) ?? []), ...(tools?.(record) ?? [])];
		},
	};
}
