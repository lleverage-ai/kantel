/**
 * The environments API's routes (`@kantel/api`'s `environmentRoutes`) over an `EnvironmentBroker`, and boat.dev's
 * signed webhook. Who the caller is stays the host's job (`authenticate`); the webhook is checked by its signature
 * alone, so the host serves it without a sign-in.
 */
import { createRouter, environmentRoutes, STATUS_BY_CODE } from "@kantel/api";
import { type CallContext, isKantelError } from "@kantel/contracts";
import { verifyBoatWebhook } from "./boat.ts";
import type { EnvironmentBroker } from "./broker.ts";

export interface EnvironmentsApiOptions {
	readonly broker: EnvironmentBroker;
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** boat.dev's webhook signing secret, `whsec_…`; absent, the webhook route answers 404. */
	readonly boatWebhookSecret?: string;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
	readonly now?: () => number;
}

export interface EnvironmentsApi {
	/** Answers an environments route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
}

export const ENVIRONMENTS_BODY_LIMIT = 32 * 1024;
const WEBHOOK_BODY_LIMIT = 64 * 1024;

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

function errorResponse(error: unknown): Response {
	if (isKantelError(error)) {
		return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
	}
	return json({ error: { code: "unavailable", message: "The environments API failed" } }, 500);
}

const trim = (basePath: string) => basePath.replace(/\/+$/, "");

/** Whether `path` is under `/v1/environments`. */
export function isEnvironmentsPath(path: string, basePath = "/v1"): boolean {
	const under = `${trim(basePath)}/environments`;
	return path === under || path.startsWith(`${under}/`);
}

/** The path boat.dev's webhook is registered at. */
export const boatWebhookPath = (basePath = "/v1") => `${trim(basePath)}/environment-webhooks/boat`;

export function createEnvironmentsApi(options: EnvironmentsApiOptions): EnvironmentsApi {
	const { broker } = options;
	const basePath = trim(options.basePath ?? "/v1");
	const router = createRouter(
		environmentRoutes,
		{
			listEnvironments: async (ctx: CallContext, { query }) => ({
				items: await broker.list(ctx, query.projectId === undefined ? {} : { projectId: query.projectId }),
			}),
			createEnvironment: (ctx: CallContext, { body }) => broker.create(ctx, body),
			getEnvironment: (ctx: CallContext, { params }) => broker.get(ctx, params.environmentId),
			updateEnvironment: (ctx: CallContext, { params, body }) => broker.update(ctx, params.environmentId, body),
			startEnvironment: (ctx: CallContext, { params }) => broker.start(ctx, params.environmentId),
			stopEnvironment: (ctx: CallContext, { params }) => broker.stop(ctx, params.environmentId),
			destroyEnvironment: (ctx: CallContext, { params }) => broker.destroy(ctx, params.environmentId),
			grantEnvironment: (ctx: CallContext, { params, body }) => broker.grant(ctx, params.environmentId, body),
			revokeEnvironmentGrant: async (ctx: CallContext, { params }) => {
				await broker.revoke(ctx, params.grantId);
				return undefined;
			},
		},
		{ basePath, maxBodyBytes: ENVIRONMENTS_BODY_LIMIT },
	);
	const webhook = boatWebhookPath(basePath);

	return {
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === webhook) {
				if (options.boatWebhookSecret === undefined) return undefined;
				if (request.method !== "POST") return json({ error: { code: "invalid", message: "POST only" } }, 405);
				const body = await request.text();
				if (body.length > WEBHOOK_BODY_LIMIT) return json({ error: { code: "invalid", message: "Too large" } }, 413);
				let report: Awaited<ReturnType<typeof verifyBoatWebhook>>;
				try {
					report = await verifyBoatWebhook({
						secret: options.boatWebhookSecret,
						headers: request.headers,
						body,
						...(options.now === undefined ? {} : { now: options.now() }),
					});
				} catch {
					// Say nothing about why: a caller without the secret learns only that it was refused.
					return json({ error: { code: "forbidden", message: "Not a signed boat delivery" } }, 401);
				}
				if (report !== undefined) await broker.report(report).catch(() => undefined);
				return new Response(null, { status: 204 });
			}
			if (!isEnvironmentsPath(path, basePath)) return undefined;
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
