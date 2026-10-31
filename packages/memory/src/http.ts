/**
 * Memory's public API routes (`@kantel/api`'s `memoryRoutes`, #12 and #150) over any `Memory`: one route per contract
 * call, with the request checked against the route's schemas before the memory sees it. Who the caller is stays the
 * host's job (`authenticate`); the memory then checks the caller's organisation, project role and that no agent writes.
 *
 * | Route | Contract call |
 * | --- | --- |
 * | `GET /memory/spaces` | `listSpaces` |
 * | `POST /memory/spaces` | `createSpace`, after `authorizeWrite` |
 * | `GET /memory/spaces/{spaceId}/concepts` | `listConcepts` |
 * | `GET /memory/spaces/{spaceId}/concepts/{conceptId}` | `getConcept` (the ID's slashes encoded) |
 * | `POST /memory/search` | `search` |
 * | `POST /memory/recall` | `recall` |
 * | `POST /memory/spaces/{spaceId}/snapshot` | `importSnapshot`, after `authorizeImport` (default `authorizeWrite`) |
 *
 * Proposals and their decisions (memory writes, #25) are not served yet.
 */
import { createRouter, memoryRoutes, STATUS_BY_CODE } from "@kantel/api";
import { type CallContext, isKantelError, type Memory, type MemorySnapshot } from "@kantel/contracts";

/** The largest body: a whole space's snapshot, as JSON. */
export const MEMORY_BODY_LIMIT = 16 * 1024 * 1024;

export interface MemoryApiOptions {
	readonly memory: Memory;
	/** Signs the request's caller in, or rejects (a `KantelError` is answered with its status). */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/**
	 * A check creating a space or importing a snapshot makes before the memory's own, such as the organisation's admin
	 * role. The memory already refuses agents and checks a project space's operator role.
	 */
	readonly authorizeWrite?: (ctx: CallContext) => Promise<void>;
	/**
	 * The check importing a snapshot makes instead of `authorizeWrite`, when a deployment lets more callers import than
	 * create spaces (an API key with the `import` permission). Default `authorizeWrite`.
	 */
	readonly authorizeImport?: (ctx: CallContext) => Promise<void>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
}

export interface MemoryApi {
	/** Answers a memory route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

/** A `KantelError` as its status and `{ error: { code, message, details? } }`; anything else as a bare 500. */
export function memoryErrorResponse(error: unknown): Response {
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
	return json({ error: { code: "unavailable", message: "The memory API failed" } }, 500);
}

const pageOf = (query: { readonly limit?: number; readonly cursor?: string }) => ({
	...(query.limit === undefined ? {} : { limit: query.limit }),
	...(query.cursor === undefined ? {} : { cursor: query.cursor }),
});

export function createMemoryApi(options: MemoryApiOptions): MemoryApi {
	const { memory } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const router = createRouter(
		memoryRoutes,
		{
			listMemorySpaces: (ctx: CallContext, { query }) => memory.listSpaces(ctx, pageOf(query)),
			createMemorySpace: async (ctx: CallContext, { body }) => {
				await options.authorizeWrite?.(ctx);
				return memory.createSpace(ctx, body);
			},
			listConcepts: (ctx: CallContext, { params, query }) =>
				memory.listConcepts(
					ctx,
					params.spaceId,
					query.status === undefined ? undefined : { status: query.status },
					pageOf(query),
				),
			getConcept: (ctx: CallContext, { params }) => memory.getConcept(ctx, params.spaceId, params.conceptId),
			searchMemory: async (ctx: CallContext, { body }) => ({ hits: await memory.search(ctx, body) }),
			recallMemory: (ctx: CallContext, { body }) => memory.recall(ctx, body),
			importMemorySnapshot: async (ctx: CallContext, { params, body }) => {
				await (options.authorizeImport ?? options.authorizeWrite)?.(ctx);
				// The router has checked the body against the schema and dropped what it doesn't name.
				return memory.importSnapshot(ctx, params.spaceId, body as MemorySnapshot);
			},
		},
		{ basePath, maxBodyBytes: MEMORY_BODY_LIMIT },
	);
	const under = `${basePath}/memory`;

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
				return memoryErrorResponse(error);
			}
		},
	};
}
