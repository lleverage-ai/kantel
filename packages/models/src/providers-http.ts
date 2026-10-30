/**
 * The model providers' public API routes (`@harbour/api`'s `modelProviderRoutes`) over any `ModelProviders`: one
 * route per contract call, with the request checked against the route's schemas before the service sees it. Who the
 * caller is stays the host's job (`authenticate`); the service then checks the caller's role and that no agent writes.
 *
 * | Route | Contract call |
 * | --- | --- |
 * | `GET /model-providers` | `list` |
 * | `PUT /model-providers/{providerId}/key` | `connectKey` |
 * | `POST /model-providers/{providerId}/sign-ins` | `startSignIn` |
 * | `GET /model-providers/{providerId}/sign-ins/{signInId}` | `signInStatus` |
 * | `POST /model-providers/{providerId}/sign-ins/{signInId}/finish` | `finishSignIn` |
 * | `DELETE /model-providers/{providerId}` | `disconnect` |
 */
import { createRouter, modelProviderRoutes, STATUS_BY_CODE } from "@harbour/api";
import { type CallContext, isHarbourError, type ModelProviders } from "@harbour/contracts";

export interface ModelProvidersApiOptions {
	readonly providers: ModelProviders;
	/** Signs the request's caller in, or rejects (a `HarbourError` is answered with its status). */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
}

export interface ModelProvidersApi {
	/** Answers a model provider route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

function errorResponse(error: unknown): Response {
	if (isHarbourError(error)) {
		return json(
			{
				error: {
					code: error.code,
					message: error.message,
					...(error.details === undefined ? {} : { details: error.details }),
				},
			},
			STATUS_BY_CODE[error.code],
		);
	}
	// Never echo an unexpected error's message: it may hold anything, a key included.
	return json({ error: { code: "unavailable", message: "The model providers API failed" } }, 500);
}

export function createModelProvidersApi(options: ModelProvidersApiOptions): ModelProvidersApi {
	const { providers } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	// The router has checked each provider ID and body against the route's schemas.
	const router = createRouter(
		modelProviderRoutes,
		{
			listModelProviders: (ctx: CallContext) => providers.list(ctx),
			connectModelProviderKey: (ctx: CallContext, { params, body }) =>
				providers.connectKey(ctx, params.providerId, body),
			startModelSignIn: (ctx: CallContext, { params }) => providers.startSignIn(ctx, params.providerId),
			getModelSignIn: (ctx: CallContext, { params }) => providers.signInStatus(ctx, params.providerId, params.signInId),
			finishModelSignIn: (ctx: CallContext, { params, body }) =>
				providers.finishSignIn(ctx, params.providerId, params.signInId, body.redirectUrl),
			disconnectModelProvider: async (ctx: CallContext, { params }) => {
				await providers.disconnect(ctx, params.providerId);
				return undefined;
			},
		},
		{ basePath },
	);
	const under = `${basePath}/model-providers`;

	return {
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path !== under && !path.startsWith(`${under}/`)) return undefined;
			try {
				const ctx = await options.authenticate(request);
				const answered = await router(ctx, request);
				if (answered !== undefined) return answered;
				return json({ error: { code: "not_found", message: "No such route" } }, 404);
			} catch (error) {
				return errorResponse(error);
			}
		},
	};
}
