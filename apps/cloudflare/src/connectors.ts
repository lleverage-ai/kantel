/**
 * The console's view of the model gateway's connectors, beside the session API. The gateway itself decides who may see
 * and test what; this file only maps the routes onto it.
 *
 * - `GET /v1/connectors?projectId=<id>`: the connectors the caller can see and the models each offers, each with what
 *   it takes and gives (`input`, `output`) and, for an image model, the image API it is called over
 *   (`ModelGateway.listConnectorModels`, viewer on the project).
 * - `POST /v1/connectors/<id>/test-image`, body `{ "projectId", "modelId", "prompt"? }`: makes one small image with the
 *   model, to check the connector can, and answers with it (`ModelGateway.testImage`, admin on the project). Recorded
 *   and audited like any image call, never with the prompt or the image.
 *
 * A deployment on the echo model has no gateway: both answer `unavailable`.
 */
import { type CallContext, KantelError, type ModelGateway } from "@kantel/contracts";
import { errorResponse } from "@kantel/runtime/http";

export const CONNECTORS_PATH = "/v1/connectors";
const TEST_IMAGE = /^\/v1\/connectors\/([^/]+)\/test-image$/;
/** The most a test's JSON body may be: a prompt and two IDs. */
const BODY_LIMIT = 16 * 1024;

/** Whether `path` is one of the connectors routes. */
export const isConnectorsPath = (path: string) => path === CONNECTORS_PATH || TEST_IMAGE.test(path);

const json = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });

export function createConnectorsApi(options: {
	/** The deployment's model gateway, or undefined on the echo model. */
	readonly gateway: (() => Promise<ModelGateway>) | undefined;
	readonly authenticate: (request: Request) => Promise<CallContext>;
}): (request: Request) => Promise<Response> {
	return async (request) => {
		try {
			const url = new URL(request.url);
			if (url.pathname === CONNECTORS_PATH) {
				if (request.method !== "GET") throw new KantelError("invalid", "GET only");
				const projectId = url.searchParams.get("projectId") ?? "";
				if (projectId === "") throw new KantelError("invalid", "Name the project: ?projectId=");
				const ctx = await options.authenticate(request);
				const gateway = await gatewayOf(options);
				return json({ items: await gateway.listConnectorModels(ctx, { projectId }) });
			}
			const connectorId = decodeURIComponent(TEST_IMAGE.exec(url.pathname)?.[1] ?? "");
			if (request.method !== "POST") throw new KantelError("invalid", "POST only");
			const ctx = await options.authenticate(request);
			const text = await request.text();
			if (text.length > BODY_LIMIT) throw new KantelError("invalid", "The test's body is too large");
			const body = (() => {
				try {
					return JSON.parse(text) as { projectId?: unknown; modelId?: unknown; prompt?: unknown };
				} catch {
					throw new KantelError("invalid", "The body must be JSON");
				}
			})();
			if (typeof body.projectId !== "string" || typeof body.modelId !== "string") {
				throw new KantelError("invalid", "Name the project and the model: { projectId, modelId }");
			}
			if (body.prompt !== undefined && typeof body.prompt !== "string") {
				throw new KantelError("invalid", "prompt must be a string");
			}
			const gateway = await gatewayOf(options);
			return json(
				await gateway.testImage(ctx, {
					connectorId,
					projectId: body.projectId,
					modelId: body.modelId,
					...(body.prompt === undefined ? {} : { prompt: body.prompt }),
				}),
			);
		} catch (error) {
			await request.body?.cancel().catch(() => undefined);
			return errorResponse(error);
		}
	};
}

async function gatewayOf(options: { readonly gateway: (() => Promise<ModelGateway>) | undefined }) {
	if (options.gateway === undefined) {
		throw new KantelError("unavailable", "This deployment has no model gateway: its sessions run on the echo model");
	}
	return options.gateway();
}
