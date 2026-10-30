/**
 * Onboarding's public API routes (`@harbour/api`'s `onboardingRoutes`) over any `OnboardingService`: one route per
 * contract call, with the request checked against the route's schemas before the service sees it. Who the caller is
 * stays the host's job (`authenticate`); the service then checks the caller's role and that no agent writes.
 *
 * | Route | Contract call |
 * | --- | --- |
 * | `GET /onboarding` | `get` |
 * | `PUT /onboarding/steps/{step}` | `setStep` |
 * | `PUT /onboarding/current` | `goTo` |
 * | `POST /onboarding/dismiss` | `dismiss` |
 * | `POST /onboarding/reopen` | `reopen` |
 */
import { createRouter, onboardingRoutes, STATUS_BY_CODE } from "@harbour/api";
import { type CallContext, isHarbourError, type OnboardingService } from "@harbour/contracts";

export interface OnboardingApiOptions {
	readonly onboarding: OnboardingService;
	/** Signs the request's caller in, or rejects (a `HarbourError` is answered with its status). */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
}

export interface OnboardingApi {
	/** Answers an onboarding route, or resolves `undefined` when the request is for none of them. */
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
	// Never echo an unexpected error's message: it may hold anything.
	return json({ error: { code: "unavailable", message: "The onboarding API failed" } }, 500);
}

export function createOnboardingApi(options: OnboardingApiOptions): OnboardingApi {
	const { onboarding } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	// The router has checked each step and status against the route's schemas.
	const router = createRouter(
		onboardingRoutes,
		{
			getOnboarding: (ctx: CallContext) => onboarding.get(ctx),
			setOnboardingStep: (ctx: CallContext, { params, body }) => onboarding.setStep(ctx, params.step, body.status),
			setOnboardingCurrent: (ctx: CallContext, { body }) => onboarding.goTo(ctx, body.step),
			dismissOnboarding: (ctx: CallContext) => onboarding.dismiss(ctx),
			reopenOnboarding: (ctx: CallContext, { body }) => onboarding.reopen(ctx, body.step),
		},
		{ basePath },
	);
	const under = `${basePath}/onboarding`;

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
