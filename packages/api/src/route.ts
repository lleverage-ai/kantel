/**
 * What a route is: its method and path, the schemas of its path parameters, query, headers and body, and its answer.
 * The server's router (`router.ts`), the OpenAPI document (`openapi.ts`) and the SDK (`sdk.ts`) are all made from the
 * same definitions, so a route is written once.
 */
import type { ErrorCode } from "@harbour/contracts";
import type { Static, TObject, TSchema } from "typebox";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteAnswer {
	/** The success status. 204 has no body. */
	readonly status: 200 | 201 | 202 | 204;
	readonly description: string;
	/** The body's schema; absent for 204. */
	readonly schema?: TSchema;
}

export interface RouteDefinition {
	/** The SDK's method name and the OpenAPI operation ID, such as `createSession`. */
	readonly operationId: string;
	readonly method: HttpMethod;
	/** Relative to the version's base path (`/v1`), with OpenAPI's `{name}` parameters: `/sessions/{sessionId}`. */
	readonly path: string;
	readonly summary: string;
	readonly description?: string;
	/** Groups the route in the OpenAPI document, such as `sessions`. */
	readonly tag: string;
	/** One string property per `{name}` in the path. */
	readonly params?: TObject;
	readonly query?: TObject;
	/** A JSON object body. A route with a body still takes an empty one when every property is optional. */
	readonly body?: TObject;
	readonly answer: RouteAnswer;
	/**
	 * Other successful answers, each with its own status, such as a result route's 202 while the run is still going. The
	 * handler answers one by returning a `Response` of its own; the SDK's method resolves with whichever body came back.
	 */
	readonly otherAnswers?: readonly RouteAnswer[];
	/**
	 * Takes an `Idempotency-Key` header: a retry with the same key gets the first call's answer and does nothing again.
	 * The handler is given the key (`input.idempotencyKey`) and keeps the promise.
	 */
	readonly idempotent?: true;
	/**
	 * Answers a stream of frames instead of one JSON body: over a WebSocket (101) when the request upgrades, each message
	 * a JSON array of frames, and as server-sent events otherwise, one frame per event. The handler returns the
	 * `Response` itself, and the SDK's method opens the WebSocket.
	 */
	readonly stream?: { readonly frame: TSchema };
	/** The error codes the route documents, besides `unauthenticated` (401), which every route can answer. */
	readonly errors: readonly ErrorCode[];
}

/** Keeps a definition's literal types, so its input and output types follow from it. */
export const defineRoute = <const R extends RouteDefinition>(route: R): R => route;

/** A schema's type read-only all the way down, as the contracts' types are, so a contract's value can be returned. */
export type DeepReadonly<T> = T extends (infer E)[]
	? readonly DeepReadonly<E>[]
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

type StaticOf<S, Otherwise> = S extends TSchema ? DeepReadonly<Static<S>> : Otherwise;

export type RouteParams<R extends RouteDefinition> = StaticOf<R["params"], Record<string, never>>;
export type RouteQuery<R extends RouteDefinition> = StaticOf<R["query"], Record<string, never>>;
export type RouteBody<R extends RouteDefinition> = StaticOf<R["body"], undefined>;
export type RouteOutput<R extends RouteDefinition> = StaticOf<R["answer"]["schema"], undefined>;

/** What a handler is given: every part of the request, checked against the route's schemas. */
export interface RouteInput<R extends RouteDefinition> {
	readonly params: RouteParams<R>;
	readonly query: RouteQuery<R>;
	readonly body: RouteBody<R>;
	/** The `Idempotency-Key` header, on an idempotent route that was sent one. */
	readonly idempotencyKey?: string;
}

/** The header an idempotent route reads. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** The longest idempotency key a route takes. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** The status each HarbourError code answers with; `unauthenticated` is 401. */
export const STATUS_BY_CODE: { readonly [code in ErrorCode]: number } = {
	invalid: 400,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	expired: 410,
	refused: 422,
	exhausted: 429,
	aborted: 409,
	not_supported: 501,
	unavailable: 503,
};

export const UNAUTHENTICATED_STATUS = 401;

/** The names of a path's `{name}` parameters, in order. */
export function pathParameters(path: string): readonly string[] {
	return [...path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1] as string);
}

/** A path's matcher: each `{name}` takes one non-empty segment. */
export function pathPattern(path: string): RegExp {
	const source = path
		.split(/(\{[A-Za-z][A-Za-z0-9]*\})/)
		.map((part) => (/^\{.+\}$/.test(part) ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
		.join("");
	return new RegExp(`^${source}$`);
}
