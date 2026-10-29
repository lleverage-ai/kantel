/**
 * The skills' public API routes (`@harbour/api`'s `skillRoutes`, #12 and #150) over any `Skills`: one route per contract
 * call, with the request checked against the route's schemas before the store sees it. Who the caller is stays the
 * host's job (`authenticate`); the store then checks the caller's organisation, project role and that no agent imports.
 *
 * | Route | Contract call |
 * | --- | --- |
 * | `GET /skills` | `list`: the platform's, the organisation's, `projectId`'s and the calling person's own |
 * | `GET /skills/{skillId}` | `get` |
 * | `GET /skills/{skillId}/revisions` | `listRevisions` |
 * | `GET /skills/{skillId}/revisions/{revision}` | `getRevision` |
 * | `GET /skills/{skillId}/revisions/{revision}/file?path=` | `readFile` |
 * | `POST /skills/import` | `importRevision`, after `authorizeImport` |
 *
 * Drafts, publishing and pins are not served yet: the console's authoring flow and the runtime's pins come later.
 */
import { createRouter, STATUS_BY_CODE, skillRoutes } from "@harbour/api";
import { type CallContext, isHarbourError, type Skills } from "@harbour/contracts";

type ImportInput = Parameters<Skills["importRevision"]>[1];

/** The largest import body: one skill's files, as JSON. */
export const SKILL_IMPORT_BODY_LIMIT = 8 * 1024 * 1024;

export interface SkillsApiOptions {
	readonly skills: Skills;
	/** Signs the request's caller in, or rejects (a `HarbourError` is answered with its status). */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/**
	 * A check an import makes before the store's own, such as the organisation's admin role. The store already refuses
	 * agents and checks a project owner's operator role.
	 */
	readonly authorizeImport?: (ctx: CallContext) => Promise<void>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
}

export interface SkillsApi {
	/** Answers a skills route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

/** A `HarbourError` as its status and `{ error: { code, message, details? } }`; anything else as a bare 500. */
export function skillsErrorResponse(error: unknown): Response {
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
	return json({ error: { code: "unavailable", message: "The skills API failed" } }, 500);
}

const pageOf = (query: { readonly limit?: number; readonly cursor?: string }) => ({
	...(query.limit === undefined ? {} : { limit: query.limit }),
	...(query.cursor === undefined ? {} : { cursor: query.cursor }),
});

export function createSkillsApi(options: SkillsApiOptions): SkillsApi {
	const { skills } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const router = createRouter(
		skillRoutes,
		{
			listSkills: (ctx: CallContext, { query }) => {
				const { projectId } = query;
				return skills.list(
					ctx,
					{
						...(projectId === undefined ? {} : { projectId }),
						...(ctx.actor.kind === "human" ? { userId: ctx.actor.userId } : {}),
					},
					pageOf(query),
				);
			},
			getSkill: (ctx: CallContext, { params }) => skills.get(ctx, params.skillId),
			listSkillRevisions: (ctx: CallContext, { params, query }) =>
				skills.listRevisions(ctx, params.skillId, pageOf(query)),
			getSkillRevision: (ctx: CallContext, { params }) =>
				skills.getRevision(ctx, params.skillId, Number(params.revision)),
			readSkillFile: async (ctx: CallContext, { params, query }) => ({
				path: query.path,
				content: await skills.readFile(ctx, params.skillId, Number(params.revision), query.path),
			}),
			importSkill: async (ctx: CallContext, { body }) => {
				await options.authorizeImport?.(ctx);
				// The router has checked the body against the schema and dropped what it doesn't name.
				return skills.importRevision(ctx, body as ImportInput);
			},
		},
		{ basePath, maxBodyBytes: SKILL_IMPORT_BODY_LIMIT },
	);
	const under = `${basePath}/skills`;

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
				return skillsErrorResponse(error);
			}
		},
	};
}
