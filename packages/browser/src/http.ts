/**
 * The browsers' public API routes (`@kantel/api`'s `browserRoutes`, docs/design/browser-runtime.md) over any
 * `Browser` broker. Who the caller is stays the host's job (`authenticate`); the broker checks the caller may view the
 * session and that it is no agent.
 *
 * | Route | Broker call |
 * | --- | --- |
 * | `POST /sessions/{sessionId}/browsers/{browserSessionId}/embed` | `embed`, once `get` has shown the browser is the session's |
 *
 * And, given the deployment's `SessionBrowser` (`./session.ts`), the console's own routes, beside the public one:
 *
 * | Route | Body | Answer |
 * | --- | --- | --- |
 * | `POST /browser/decisions` | `{ sessionId, callId, allow }` | a person's answer to an agent's waiting `browser_request` |
 * | `POST /browser/live` | `{ sessionId, browserSessionId }` | `{ kind: "embed", mode, url, endMessage?, expiresAt? }`, watch-only |
 * | `POST /browser/replay` | `{ sessionId, browserSessionId }` | the same, for the browser's recording |
 *
 * The console's links stay relative: it is served on the same origin.
 *
 * Kantel's own browsers answer a link relative to the console (`/browser/<id>#<token>`), so an outside app gets it
 * made absolute against `publicOrigin`, or the request's origin when none is set.
 */
import { browserRoutes, createRouter, STATUS_BY_CODE } from "@kantel/api";
import { type Browser, type CallContext, isKantelError, KantelError } from "@kantel/contracts";
import type { SessionBrowser } from "./session.ts";

export interface BrowserApiOptions {
	readonly browser: Browser;
	/** The deployment's session browser: with it, the console's routes too. */
	readonly session?: Pick<SessionBrowser, "decide" | "liveView" | "replay">;
	/** Signs the request's caller in, or rejects (a `KantelError` is answered with its status). */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
	/** Where the console is served, for a relative view link; default the request's own origin. */
	readonly publicOrigin?: string;
}

export interface BrowserApi {
	/** Answers a browser route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
}

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

/** A `KantelError` as its status and `{ error: { code, message } }`; anything else as a bare 500. */
export function browserErrorResponse(error: unknown): Response {
	if (isKantelError(error)) {
		return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
	}
	// Never echo an unexpected error's message: it may hold anything, a provider's link included.
	return json({ error: { code: "unavailable", message: "The browser API failed" } }, 500);
}

/** `/v1/sessions/{sessionId}/browsers/...`: the public API's paths. */
const BROWSER_PATH = /^\/sessions\/[^/]+\/browsers\//;
/** The console's routes, under the base path. */
export const BROWSER_DECISIONS = "/browser/decisions";
export const BROWSER_LIVE = "/browser/live";
export const BROWSER_REPLAY = "/browser/replay";
const CONSOLE_PATHS: ReadonlySet<string> = new Set([BROWSER_DECISIONS, BROWSER_LIVE, BROWSER_REPLAY]);
/** A console route's JSON body is a few IDs. */
export const BROWSER_BODY_LIMIT = 1024;

/** The request's JSON object body, at most `BROWSER_BODY_LIMIT` bytes, or `undefined`. */
async function smallJson(request: Request): Promise<{ readonly [key: string]: unknown } | undefined> {
	const reader = request.body?.getReader();
	if (reader === undefined) return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > BROWSER_BODY_LIMIT) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	try {
		const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		return typeof body === "object" && body !== null && !Array.isArray(body)
			? (body as { readonly [key: string]: unknown })
			: undefined;
	} catch {
		return undefined;
	}
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/** One of the console's routes, for a signed-in caller. */
async function consoleRoute(
	session: NonNullable<BrowserApiOptions["session"]>,
	route: string,
	ctx: CallContext,
	request: Request,
): Promise<Response> {
	const body = await smallJson(request);
	if (route === BROWSER_DECISIONS) {
		if (body === undefined || !nonEmpty(body.sessionId) || !nonEmpty(body.callId) || typeof body.allow !== "boolean") {
			throw new KantelError("invalid", 'The body is { "sessionId": string, "callId": string, "allow": boolean }');
		}
		return json(await session.decide(ctx, { sessionId: body.sessionId, callId: body.callId, allow: body.allow }), 200);
	}
	if (body === undefined || !nonEmpty(body.sessionId) || !nonEmpty(body.browserSessionId)) {
		throw new KantelError("invalid", 'The body is { "sessionId": string, "browserSessionId": string }');
	}
	const target = { sessionId: body.sessionId, browserSessionId: body.browserSessionId };
	const mode = route === BROWSER_LIVE ? "live" : "replay";
	const link = mode === "live" ? await session.liveView(ctx, target) : await session.replay(ctx, target);
	const embed = link.embed ?? { url: link.url };
	const answer = json(
		{
			kind: "embed",
			mode,
			url: embed.url,
			...(embed.endMessage === undefined ? {} : { endMessage: embed.endMessage }),
			...(link.expiresAt === undefined ? {} : { expiresAt: link.expiresAt }),
		},
		200,
	);
	answer.headers.set("referrer-policy", "no-referrer");
	return answer;
}

export function createBrowserApi(options: BrowserApiOptions): BrowserApi {
	const { browser } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const router = createRouter(
		browserRoutes,
		{
			embedBrowserSession: async (ctx: CallContext, { params, body }, request) => {
				// The broker hides another organisation's browser; one of another session in this one is just as absent.
				const session = await browser.get(ctx, params.browserSessionId);
				if (session.sessionId !== params.sessionId) {
					throw new KantelError("not_found", "No such browser in this session");
				}
				const link = await browser.embed(ctx, session.id, {
					mode: body.mode,
					...(body.minutes === undefined ? {} : { minutes: body.minutes }),
				});
				const origin = options.publicOrigin ?? new URL(request.url).origin;
				return {
					url: new URL(link.embed?.url ?? link.url, origin).href,
					mode: body.mode,
					...(link.expiresAt === undefined ? {} : { expiresAt: link.expiresAt }),
					...(link.embed?.endMessage === undefined ? {} : { endMessage: link.embed.endMessage }),
				};
			},
		},
		{ basePath },
	);

	return {
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (!path.startsWith(basePath)) return undefined;
			const route = path.slice(basePath.length);
			const session = options.session;
			if (session !== undefined && CONSOLE_PATHS.has(route)) {
				if (request.method !== "POST") {
					const refused = json({ error: { code: "invalid", message: "POST only" } }, 405);
					refused.headers.set("allow", "POST");
					return refused;
				}
				try {
					const ctx = await options.authenticate(request);
					return await consoleRoute(session, route, ctx, request);
				} catch (error) {
					return browserErrorResponse(error);
				}
			}
			if (!BROWSER_PATH.test(route)) return undefined;
			try {
				const ctx = await options.authenticate(request);
				const answered = await router(ctx, request);
				if (answered !== undefined) return answered;
				return json({ error: { code: "not_found", message: "No such route" } }, 404);
			} catch (error) {
				return browserErrorResponse(error);
			}
		},
	};
}
