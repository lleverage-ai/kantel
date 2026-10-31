/**
 * Prompt rules' public API routes (`@kantel/api`'s `ruleRoutes`) over any `PromptRules`: one route per contract call,
 * with the request checked against the route's schemas before the store sees it. Who the caller is stays the host's
 * job (`authenticate`); the store then checks the owner, the caller's roles and that no agent writes.
 *
 * | Route | Contract call |
 * | --- | --- |
 * | `GET /rules?owner=&projectId=&userId=` | `list` |
 * | `GET /rules/resolved?projectId=&userId=` | `forSession`: what a new session would get |
 * | `GET /rules/{ruleId}` | `get` |
 * | `PUT /rules` | `put` |
 * | `DELETE /rules/{ruleId}` | `get`, then `remove` |
 */
import { createRouter, ruleRoutes, STATUS_BY_CODE } from "@kantel/api";
import {
	type CallContext,
	KantelError,
	isKantelError,
	type OwnerRef,
	type PromptRules,
	type PutPromptRuleInput,
} from "@kantel/contracts";

export interface RulesApiOptions {
	readonly rules: PromptRules;
	/** Signs the request's caller in, or rejects (a `KantelError` is answered with its status). */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
}

export interface RulesApi {
	/** Answers a rules route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

function errorResponse(error: unknown): Response {
	if (isKantelError(error)) {
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
	return json({ error: { code: "unavailable", message: "The rules API failed" } }, 500);
}

/** The calling person, as the default user. */
const callerUser = (ctx: CallContext): string | undefined =>
	ctx.actor.kind === "human" ? ctx.actor.userId : undefined;

function ownerOf(
	ctx: CallContext,
	query: { readonly owner: OwnerRef["kind"]; readonly projectId?: string; readonly userId?: string },
): OwnerRef {
	const organisationId = ctx.organisationId;
	switch (query.owner) {
		case "platform":
			return { kind: "platform" };
		case "organisation":
			return { kind: "organisation", organisationId };
		case "project":
			if (query.projectId === undefined) throw new KantelError("invalid", "owner=project needs projectId");
			return { kind: "project", organisationId, projectId: query.projectId };
		case "user": {
			const userId = query.userId ?? callerUser(ctx);
			if (userId === undefined) throw new KantelError("invalid", "owner=user needs userId");
			return { kind: "user", organisationId, userId };
		}
	}
}

export function createRulesApi(options: RulesApiOptions): RulesApi {
	const { rules } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const router = createRouter(
		ruleRoutes,
		{
			listPromptRules: async (ctx: CallContext, { query }) => ({ items: await rules.list(ctx, ownerOf(ctx, query)) }),
			resolvePromptRules: async (ctx: CallContext, { query }) => {
				const userId = query.userId ?? callerUser(ctx);
				return {
					items: await rules.forSession(ctx, {
						...(query.projectId === undefined ? {} : { projectId: query.projectId }),
						...(userId === undefined ? {} : { userId }),
					}),
				};
			},
			getPromptRule: (ctx: CallContext, { params }) => rules.get(ctx, params.ruleId),
			// The router has checked the body against the schema and dropped what it doesn't name.
			putPromptRule: (ctx: CallContext, { body }) => rules.put(ctx, body as PutPromptRuleInput),
			removePromptRule: async (ctx: CallContext, { params }) => {
				const rule = await rules.get(ctx, params.ruleId);
				await rules.remove(ctx, rule.id);
				return rule;
			},
		},
		{ basePath },
	);
	const under = `${basePath}/rules`;

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
