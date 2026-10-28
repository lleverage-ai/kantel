/**
 * The model gateway as a Worker: `export default { fetch }`, with no route of its own. SessionDO reaches it through a
 * service binding and passes the binding's `fetch` to pi-ai's `pi-messages` client (docs/model-connectors.md,
 * "Deployment"). Deploying it, and binding a durable audit sink, is M1-CF1's (#17).
 *
 * Bindings:
 *
 * - `HARBOUR_MODEL_GATEWAY_CONFIG`: the `ModelGatewayConfig` as JSON.
 * - `HARBOUR_MODEL_TOKEN_KEY` (secret): the session token key, shared with the session runtime.
 * - `HARBOUR_VAULT_URL` and `HARBOUR_VAULT_TOKEN` (secret): the vault's egress decision API and the gateway's shared
 *   key for it. `VAULT`, a service binding to the vault, carries the calls when bound.
 *
 * Until #17 binds an outbox, audit events are written to the Worker's log as one JSON line each.
 */
import type { AuditSink } from "@harbour/contracts";
import { createEgressDecisionClient } from "@harbour/vault/egress-api";
import {
	createModelGatewayApp,
	egressConnectorCredentials,
	type ModelGatewayApp,
	parseModelGatewayConfig,
} from "./app.ts";

export interface ModelGatewayWorkerEnv {
	readonly HARBOUR_MODEL_GATEWAY_CONFIG: string;
	readonly HARBOUR_MODEL_TOKEN_KEY: string;
	readonly HARBOUR_VAULT_URL: string;
	readonly HARBOUR_VAULT_TOKEN: string;
	readonly VAULT?: { readonly fetch: typeof fetch };
}

/** Writes each event to the log, for the platform's log store to keep. */
export const logAuditSink: AuditSink = {
	async append(_ctx, events) {
		for (const event of events) console.log(JSON.stringify({ audit: event }));
	},
};

/** Builds the app from the Worker's bindings. */
export async function createWorkerApp(
	env: ModelGatewayWorkerEnv,
	audit: AuditSink = logAuditSink,
): Promise<ModelGatewayApp> {
	let config: unknown;
	try {
		config = JSON.parse(env.HARBOUR_MODEL_GATEWAY_CONFIG);
	} catch {
		throw new Error("HARBOUR_MODEL_GATEWAY_CONFIG must be JSON");
	}
	const vault = createEgressDecisionClient({
		baseUrl: env.HARBOUR_VAULT_URL,
		token: env.HARBOUR_VAULT_TOKEN,
		...(env.VAULT === undefined ? {} : { fetch: (input, init) => env.VAULT!.fetch(input, init) }),
	});
	return createModelGatewayApp({
		config: parseModelGatewayConfig(config),
		tokenKey: env.HARBOUR_MODEL_TOKEN_KEY,
		credentials: egressConnectorCredentials(vault),
		audit,
	});
}

/** One app per isolate, built on the first request; a failed build is retried on the next. */
let app: Promise<ModelGatewayApp> | undefined;

export default {
	async fetch(request: Request, env: ModelGatewayWorkerEnv): Promise<Response> {
		app ??= createWorkerApp(env);
		let built: ModelGatewayApp;
		try {
			built = await app;
		} catch (error) {
			app = undefined;
			console.error(JSON.stringify({ error: "model gateway config", message: String(error) }));
			return Response.json(
				{ error: { code: "unavailable", message: "The model gateway is not configured" } },
				{ status: 503, statusText: "Service Unavailable" },
			);
		}
		return built.handler(request);
	},
};
