/**
 * The model gateway as a Worker: `export default { fetch }`, with no route of its own. SessionDO reaches it through a
 * service binding and passes the binding's `fetch` to pi-ai's `pi-messages` client (packages/models/CONTRACT.md).
 * Deploying it, and binding a durable audit sink, is the Cloudflare deployment's (#17).
 *
 * Bindings:
 *
 * - `KANTEL_MODEL_GATEWAY_CONFIG`: the `ModelGatewayConfig` as JSON.
 * - `KANTEL_MODEL_TOKEN_KEY` (secret): the session token key, shared with the session runtime.
 * - `KANTEL_VAULT_URL` and `KANTEL_VAULT_TOKEN` (secret): the vault's egress decision API and the gateway's shared
 *   key for it. `VAULT`, a service binding to the vault, carries the calls when bound.
 *
 * Until #17 binds an outbox, audit events are written to the Worker's log as one JSON line each.
 */
import type { AuditSink } from "@kantel/contracts";
import { withKantelEnv } from "@kantel/contracts/env";
import { createEgressDecisionClient } from "@kantel/vault/egress-api";
import {
	createModelGatewayApp,
	egressConnectorCredentials,
	type ModelGatewayApp,
	parseModelGatewayConfig,
} from "./app.ts";

export interface ModelGatewayWorkerEnv {
	readonly KANTEL_MODEL_GATEWAY_CONFIG: string;
	readonly KANTEL_MODEL_TOKEN_KEY: string;
	readonly KANTEL_VAULT_URL: string;
	readonly KANTEL_VAULT_TOKEN: string;
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
		config = JSON.parse(env.KANTEL_MODEL_GATEWAY_CONFIG);
	} catch {
		throw new Error("KANTEL_MODEL_GATEWAY_CONFIG must be JSON");
	}
	const vault = createEgressDecisionClient({
		baseUrl: env.KANTEL_VAULT_URL,
		token: env.KANTEL_VAULT_TOKEN,
		...(env.VAULT === undefined ? {} : { fetch: (input, init) => env.VAULT!.fetch(input, init) }),
	});
	return createModelGatewayApp({
		config: parseModelGatewayConfig(config),
		tokenKey: env.KANTEL_MODEL_TOKEN_KEY,
		credentials: egressConnectorCredentials(vault),
		audit,
	});
}

/** One app per isolate, built on the first request; a failed build is retried on the next. */
let app: Promise<ModelGatewayApp> | undefined;

export default {
	async fetch(request: Request, env: ModelGatewayWorkerEnv): Promise<Response> {
		// Vars and secrets named before the rename (HARBOUR_*) still count.
		app ??= createWorkerApp(withKantelEnv(env));
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
