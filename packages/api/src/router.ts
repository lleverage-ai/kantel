/**
 * The server side of the route definitions: matches a request to a route, checks its path parameters, query and body
 * against the route's schemas, and calls the route's handler. A server must give a handler for every route, so a route
 * added to `routes.ts` doesn't compile until it is served. It runs wherever `fetch` does (a Worker, a Durable Object,
 * Bun, Node) and has no opinion on authentication: the server signs the caller in first and passes the context.
 */
import { KantelError } from "@kantel/contracts";
import type { TObject, TSchema } from "typebox";
import Value from "typebox/value";
import {
	IDEMPOTENCY_KEY_HEADER,
	MAX_IDEMPOTENCY_KEY_LENGTH,
	pathParameters,
	pathPattern,
	type RouteDefinition,
	type RouteInput,
	type RouteOutput,
} from "./route.ts";

/** The longest a request body may be. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Answers one route. It returns the route's output, which the router sends with the route's status, or a `Response` of
 * its own (a stream or a WebSocket upgrade). It throws a `KantelError` to refuse.
 */
export type RouteHandler<R extends RouteDefinition, Ctx> = (
	ctx: Ctx,
	input: RouteInput<R>,
	request: Request,
) => Promise<RouteOutput<R> | Response>;

export type RouteHandlers<Rs extends { readonly [id: string]: RouteDefinition }, Ctx> = {
	readonly [K in keyof Rs]: RouteHandler<Rs[K], Ctx>;
};

export interface RouterOptions {
	/** The prefix before every route's path. Default `/v1`. */
	readonly basePath?: string;
	/** The longest body a route reads. Default 1 MiB. */
	readonly maxBodyBytes?: number;
}

/**
 * Answers a request for one of the routes, or resolves undefined when none matches its method and path, so the server
 * can try its other routes. A request that matches but fails a check rejects with an `invalid` KantelError.
 */
export type Router<Ctx> = (ctx: Ctx, request: Request) => Promise<Response | undefined>;

interface Compiled {
	readonly route: RouteDefinition;
	readonly pattern: RegExp;
	readonly names: readonly string[];
	readonly handler: RouteHandler<RouteDefinition, unknown>;
}

function paramsOf(names: readonly string[], pattern: RegExp, path: string): { [name: string]: string } | undefined {
	const match = pattern.exec(path);
	if (match === null) return undefined;
	const params: { [name: string]: string } = {};
	for (const [index, name] of names.entries()) {
		try {
			params[name] = decodeURIComponent(match[index + 1] as string);
		} catch {
			throw new KantelError("invalid", "The path is not valid");
		}
	}
	return params;
}

/**
 * The first thing wrong with a value against one of the API's schemas, as `where: what`, or undefined when it matches.
 * For bodies the API publishes but no route answers with, such as the egress gate's `EgressRefusal` (#331).
 */
export function schemaProblem(schema: TSchema, value: unknown, where = "body"): string | undefined {
	return problem(schema, value, where);
}

/** The first thing wrong with a value, as `where: what`, or undefined when it matches. */
function problem(schema: TSchema, value: unknown, where: string): string | undefined {
	if (Value.Check(schema, value)) return undefined;
	for (const error of Value.Errors(schema, value)) {
		const at = error.instancePath === "" ? where : `${where} ${error.instancePath.slice(1).replaceAll("/", ".")}`;
		return `${at}: ${error.message}`;
	}
	return `${where} is not valid`;
}

/** Checks `value` against `schema` and drops properties the schema doesn't name. */
function checked(schema: TSchema, value: unknown, where: string): unknown {
	const found = problem(schema, value, where);
	if (found !== undefined) throw new KantelError("invalid", found);
	return Value.Clean(schema, Value.Clone(value));
}

async function readBody(request: Request, limit: number): Promise<unknown> {
	if (request.body === null) return {};
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => undefined);
			throw new KantelError("invalid", `The body is larger than ${limit} bytes`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(bytes);
	if (text.trim() === "") return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new KantelError("invalid", "The body is not JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new KantelError("invalid", "The body must be a JSON object");
	}
	return value;
}

/**
 * The query as an object for the schema: the first value of each name, and `<name>.<key>=<value>` gathered into a record
 * under `name` when the schema has a `name` property (`label.ticket=PROJ-1` is `{ label: { ticket: "PROJ-1" } }`).
 */
function queryOf(schema: TObject, params: URLSearchParams): unknown {
	const raw: { [name: string]: string | { [key: string]: string } } = {};
	for (const [name, value] of params) {
		const dot = name.indexOf(".");
		const prefix = dot > 0 ? name.slice(0, dot) : undefined;
		if (prefix !== undefined && dot < name.length - 1 && prefix in schema.properties) {
			const record = typeof raw[prefix] === "object" ? raw[prefix] : {};
			const entry = name.slice(dot + 1);
			if (!(entry in record)) record[entry] = value;
			raw[prefix] = record;
		} else if (!(name in raw)) raw[name] = value;
	}
	// Query values arrive as strings; `limit=20` becomes a number where the schema says so.
	return Value.Convert(schema, raw);
}

/** The request's idempotency key: 1 to 255 visible ASCII characters, or undefined when it sent none. */
function idempotencyKeyOf(request: Request): string | undefined {
	const key = request.headers.get(IDEMPOTENCY_KEY_HEADER);
	if (key === null) return undefined;
	if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
		throw new KantelError(
			"invalid",
			`${IDEMPOTENCY_KEY_HEADER} must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} visible ASCII characters`,
		);
	}
	return key;
}

const answer = (status: number, body: unknown): Response =>
	status === 204 || body === undefined
		? new Response(null, { status: status === 204 ? 204 : status, headers: { "cache-control": "no-store" } })
		: new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
			});

/** A router for `routes`, with a handler for each. */
export function createRouter<const Rs extends { readonly [id: string]: RouteDefinition }, Ctx>(
	routes: Rs,
	handlers: RouteHandlers<Rs, Ctx>,
	options: RouterOptions = {},
): Router<Ctx> {
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
	const compiled: Compiled[] = Object.entries(routes).map(([id, route]) => ({
		route,
		pattern: pathPattern(route.path),
		names: pathParameters(route.path),
		handler: handlers[id as keyof Rs] as unknown as RouteHandler<RouteDefinition, unknown>,
	}));

	return async (ctx, request) => {
		const url = new URL(request.url);
		if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return undefined;
		const path = url.pathname.slice(basePath.length) || "/";
		for (const { route, pattern, names, handler } of compiled) {
			if (route.method !== request.method) continue;
			const rawParams = paramsOf(names, pattern, path);
			if (rawParams === undefined) continue;
			const params = route.params === undefined ? {} : checked(route.params, rawParams, "path");
			const query =
				route.query === undefined ? {} : checked(route.query, queryOf(route.query, url.searchParams), "query");
			const body =
				route.body === undefined ? undefined : checked(route.body, await readBody(request, maxBodyBytes), "body");
			const idempotencyKey = route.idempotent === true ? idempotencyKeyOf(request) : undefined;
			const input = {
				params,
				query,
				body,
				...(idempotencyKey === undefined ? {} : { idempotencyKey }),
			} as RouteInput<RouteDefinition>;
			const output = await handler(ctx, input, request);
			if (output instanceof Response) return output;
			return answer(route.answer.status, output);
		}
		return undefined;
	};
}
