/**
 * The schedules' public API routes (`@harbour/api`'s `scheduleRoutes`, issue #150) over any `Schedules`: one route per
 * contract call, with the request checked against the route's schemas before the store sees it. Who the caller is stays
 * the host's job (`authenticate`); the store then checks the caller's organisation, project role and that no agent
 * changes a schedule.
 *
 * | Route | Contract call |
 * | --- | --- |
 * | `GET /schedules` | `list` |
 * | `POST /schedules` | `create` |
 * | `GET /schedules/{id}` | `get` |
 * | `PATCH /schedules/{id}` | `update` |
 * | `POST /schedules/{id}/pause`, `/resume` | `pause`, `resume` |
 * | `DELETE /schedules/{id}` | `end`: the schedule stays listed, ended, with its run history |
 * | `GET /schedules/{id}/preview` | `preview` |
 * | `GET /schedules/{id}/runs` | `listOccurrences` |
 *
 * The scheduler's worker calls (`tick`, `claim`, `complete`, `reportCheck`) are Harbour's own and have no route.
 */
import { createRouter, STATUS_BY_CODE, scheduleRoutes } from "@harbour/api";
import { type CallContext, isHarbourError, type ScheduleInput, type Schedules } from "@harbour/contracts";

type ScheduleUpdate = Parameters<Schedules["update"]>[2];

/** How many due times a preview lists when the query names none. */
export const DEFAULT_PREVIEW = 5;

export interface SchedulesApiOptions {
	readonly schedules: Schedules;
	/** Signs the request's caller in, or rejects (a `HarbourError` is answered with its status). */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
}

export interface SchedulesApi {
	/** Answers a schedule route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

/** A `HarbourError` as its status and `{ error: { code, message, details? } }`; anything else as a bare 500. */
export function scheduleErrorResponse(error: unknown): Response {
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
	return json({ error: { code: "unavailable", message: "The schedules API failed" } }, 500);
}

const pageOf = (query: { readonly limit?: number; readonly cursor?: string }) => ({
	...(query.limit === undefined ? {} : { limit: query.limit }),
	...(query.cursor === undefined ? {} : { cursor: query.cursor }),
});

export function createSchedulesApi(options: SchedulesApiOptions): SchedulesApi {
	const { schedules } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const router = createRouter(
		scheduleRoutes,
		{
			listSchedules: (ctx: CallContext, { query }) => {
				const { kind, status } = query;
				return schedules.list(
					ctx,
					{ ...(kind === undefined ? {} : { kind }), ...(status === undefined ? {} : { status }) },
					pageOf(query),
				);
			},
			// The router has checked the body against the schema and dropped what it doesn't name.
			createSchedule: (ctx: CallContext, { body }) => schedules.create(ctx, body as ScheduleInput),
			getSchedule: (ctx: CallContext, { params }) => schedules.get(ctx, params.scheduleId),
			updateSchedule: (ctx: CallContext, { params, body }) =>
				schedules.update(ctx, params.scheduleId, body as ScheduleUpdate),
			pauseSchedule: (ctx: CallContext, { params }) => schedules.pause(ctx, params.scheduleId),
			resumeSchedule: (ctx: CallContext, { params }) => schedules.resume(ctx, params.scheduleId),
			deleteSchedule: (ctx: CallContext, { params }) => schedules.end(ctx, params.scheduleId),
			previewSchedule: async (ctx: CallContext, { params, query }) => ({
				dueAt: await schedules.preview(ctx, params.scheduleId, query.n ?? DEFAULT_PREVIEW),
			}),
			listScheduleRuns: (ctx: CallContext, { params, query }) =>
				schedules.listOccurrences(ctx, params.scheduleId, pageOf(query)),
		},
		{ basePath },
	);
	const under = `${basePath}/schedules`;

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
				return scheduleErrorResponse(error);
			}
		},
	};
}
