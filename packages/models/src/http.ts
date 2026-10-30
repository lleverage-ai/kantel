/**
 * The model gateway's HTTP API: pi-ai's `pi-messages` protocol, served by a Fetch-style handler over any
 * `ModelGateway`. Portable: Workers, Bun and Node.
 *
 * Routes, under `basePath` (default none):
 *
 * | Route | Returns |
 * | --- | --- |
 * | `GET /v1/config` | `{ baseUrl, models }`, the session's routes as pi models |
 * | `POST /messages` | `{ model, context, options }` in, an SSE stream of `ModelStreamEvent`s out (`data: <json>\n\n`) |
 * | `POST /images` | a `ModelImagesRequest` in, a `ModelImagesResult` out as JSON |
 *
 * Every request carries `Authorization: Bearer <session token>`; the handler verifies it as `system("model-gateway")`
 * and passes its claims to the gateway as the call's scope. Nothing else in the request names the scope, and no
 * request header reaches the upstream. A missing or invalid token is 401 `unauthenticated`, an expired one 401
 * `expired`. Errors before the stream starts are `{ "error": { "code", "message" } }` with a status from `STATUS`,
 * which pi-ai's client turns into `"<status> <statusText>: <message> (<code>)"`. Once streaming, every failure is the
 * stream's terminal `error` event. Cancelling the response body (a client disconnect) or aborting the request aborts
 * the call, which cancels the upstream request.
 */
import {
	type ErrorCode,
	HarbourError,
	isHarbourError,
	MODEL_GATEWAY_PATHS,
	type ModelCallScope,
	type ModelGateway,
	type ModelImagesRequest,
	type ModelMessagesRequest,
	type ModelSessionTokens,
	type ModelStreamEvent,
	systemContext,
} from "@harbour/contracts";
import { MODEL_GATEWAY_COMPONENT } from "./gateway.ts";

/** Every `ErrorCode` and the status it answers with. `refused` is 403, as on the vault's egress API. */
const STATUS: { readonly [code in ErrorCode]: number } = {
	invalid: 400,
	forbidden: 403,
	refused: 403,
	not_found: 404,
	conflict: 409,
	expired: 410,
	exhausted: 429,
	aborted: 499,
	not_supported: 501,
	unavailable: 503,
};

const isErrorCode = (code: unknown): code is ErrorCode => typeof code === "string" && Object.hasOwn(STATUS, code);

export interface ModelGatewayHttpOptions {
	readonly gateway: ModelGateway;
	readonly tokens: ModelSessionTokens;
	/** Route prefix, without a trailing slash, such as `/models`. Default none. */
	readonly basePath?: string;
}

/** Reason phrases, so pi-ai's client can say `<status> <statusText>` whether or not the host sets one. */
const STATUS_TEXT: { readonly [status: number]: string } = {
	200: "OK",
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	409: "Conflict",
	410: "Gone",
	429: "Too Many Requests",
	499: "Client Closed Request",
	500: "Internal Server Error",
	501: "Not Implemented",
	503: "Service Unavailable",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		statusText: STATUS_TEXT[status] ?? "",
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});
}

function errorResponse(status: number, code: string, message: string, headers?: Record<string, string>): Response {
	return json(status, { error: { code, message } }, headers);
}

function failed(error: unknown): Response {
	if (isHarbourError(error) && isErrorCode(error.code)) {
		return errorResponse(STATUS[error.code], error.code, error.message);
	}
	return errorResponse(500, "internal", "Internal error");
}

const UNAUTHENTICATED = { "www-authenticate": `Bearer realm="harbour-models"` };

/** The SSE body of one call: one `data:` line per event, each enqueued as soon as the gateway yields it. */
function sseBody(events: AsyncIterable<ModelStreamEvent>, abort: () => void): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const iterator = events[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) controller.close();
				else controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
			} catch (error) {
				abort();
				controller.error(error);
			}
		},
		async cancel() {
			// Abort first: the gateway's iterator may be waiting on the upstream, and `return` would wait for it.
			abort();
			await iterator.return?.();
		},
	});
}

/** Serves `GET <basePath>/v1/config`, `POST <basePath>/messages` and `POST <basePath>/images`. Unknown paths are 404, other methods 405. */
export function createModelGatewayHttp(options: ModelGatewayHttpOptions): (request: Request) => Promise<Response> {
	const basePath = (options.basePath ?? "").replace(/\/+$/, "");
	const configPath = `${basePath}${MODEL_GATEWAY_PATHS.config}`;
	const messagesPath = `${basePath}${MODEL_GATEWAY_PATHS.messages}`;
	const imagesPath = `${basePath}${MODEL_GATEWAY_PATHS.images}`;
	const gatewayContext = systemContext(MODEL_GATEWAY_COMPONENT);

	async function scopeOf(request: Request): Promise<ModelCallScope | Response> {
		const header = request.headers.get("authorization") ?? "";
		const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
		if (match === null) {
			return errorResponse(401, "unauthenticated", "This call needs a model session token", UNAUTHENTICATED);
		}
		try {
			return await options.tokens.verify(gatewayContext, match[1]!);
		} catch (error) {
			if (isHarbourError(error, "expired")) {
				return errorResponse(401, "expired", "The model session token has expired", UNAUTHENTICATED);
			}
			if (isHarbourError(error, "forbidden")) {
				return errorResponse(401, "unauthenticated", "The model session token is not valid", UNAUTHENTICATED);
			}
			return failed(error);
		}
	}

	return async (request) => {
		const path = new URL(request.url).pathname;
		const isConfig = path === configPath;
		const isMessages = path === messagesPath;
		const isImages = path === imagesPath;
		if (!isConfig && !isMessages && !isImages) return errorResponse(404, "not_found", "No such route");
		const method = isConfig ? "GET" : "POST";
		if (request.method !== method) return errorResponse(405, "invalid", `Use ${method}`, { allow: method });

		const scope = await scopeOf(request);
		if (scope instanceof Response) return scope;

		if (isConfig) {
			try {
				return json(200, await options.gateway.config(scope, request.signal));
			} catch (error) {
				return failed(error);
			}
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return errorResponse(400, "invalid", "The body must be JSON");
		}
		const controller = new AbortController();
		const abort = () => controller.abort(new HarbourError("aborted", "The client went away"));
		if (request.signal.aborted) abort();
		else request.signal.addEventListener("abort", abort, { once: true });
		if (isImages) {
			try {
				return json(200, await options.gateway.images(scope, body as ModelImagesRequest, controller.signal));
			} catch (error) {
				return failed(error);
			} finally {
				request.signal.removeEventListener("abort", abort);
			}
		}
		try {
			const events = await options.gateway.messages(scope, body as ModelMessagesRequest, controller.signal);
			return new Response(sseBody(events, abort), {
				status: 200,
				headers: {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-store",
					"x-accel-buffering": "no",
				},
			});
		} catch (error) {
			request.signal.removeEventListener("abort", abort);
			return failed(error);
		}
	};
}
