import { systemContext } from "@harbour/contracts";
import type { ConformanceDeps } from "@harbour/testing/harness";
import type { ModelGatewaySubject, RecordingUpstream } from "@harbour/testing/models";
import {
	createEgressDecisionApi,
	createEgressDecisionClient,
	createSharedKeyAuthenticator,
} from "@harbour/vault/egress-api";
import { createMemoryVault } from "@harbour/vault/memory";
import { createModelGatewayApp, egressConnectorCredentials, type ModelGatewayApp } from "../src/app.ts";
import { serveOnNode } from "../src/node.ts";

export const TOKEN_KEY = "model-gateway-app-test-token-key-0123456789";
const VAULT_KEY = `model-gateway-${crypto.randomUUID()}`;

/**
 * The service as deployed, on loopback: a memory vault behind its egress decision API on one Node server, the gateway
 * app on another, reading keys from the first through `createEgressDecisionClient`. Clients reach it over real HTTP.
 */
export async function withNodeStack<Upstream extends RecordingUpstream>(
	deps: ConformanceDeps,
	upstream: Upstream,
	use: (subject: ModelGatewaySubject & { readonly upstream: Upstream; readonly app: ModelGatewayApp }) => Promise<void>,
): Promise<void> {
	const vault = createMemoryVault({ clock: deps.clock, audit: deps.audit, access: deps.access });
	const vaultServer = await serveOnNode(
		createEgressDecisionApi({
			vault,
			authenticate: createSharedKeyAuthenticator({ keys: { "model-gateway": VAULT_KEY } }),
		}),
	);
	let app: ModelGatewayApp | undefined;
	const gatewayServer = await serveOnNode(async (request) => app!.handler(request));
	try {
		app = await createModelGatewayApp({
			config: { baseUrl: gatewayServer.url, connectors: [], routes: [] },
			tokenKey: TOKEN_KEY,
			credentials: egressConnectorCredentials(
				createEgressDecisionClient({ baseUrl: vaultServer.url, token: VAULT_KEY }),
			),
			audit: deps.audit,
			clock: deps.clock,
			fetch: upstream.fetch,
		});
		const tokens = app.tokens;
		await use({
			fetch: globalThis.fetch,
			baseUrl: gatewayServer.url,
			mintToken: async (scope, ttlMs) => (await tokens.mint(systemContext("session-runtime"), scope, ttlMs)).token,
			connectors: app.connectors,
			upstream,
			credentials: vault,
			app,
		});
	} finally {
		await gatewayServer.close();
		await vaultServer.close();
	}
}
