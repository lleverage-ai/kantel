/**
 * The browsers' public API routes (`@harbour/api`'s `browserRoutes`, docs/design/browser-runtime.md) over any
 * `Browser` broker. Who the caller is stays the host's job (`authenticate`); the broker checks the caller may view the
 * session and that it is no agent.
 *
 * | Route | Broker call |
 * | --- | --- |
 * | `POST /sessions/{sessionId}/browsers/{browserSessionId}/embed` | `embed`, once `get` has shown the browser is the session's |
 *
 * Harbour's own browsers answer a link relative to the console (`/browser/<id>#<token>`), so an outside app gets it
 * made absolute against `publicOrigin`, or the request's origin when none is set.
 */
import { browserRoutes, createRouter, STATUS_BY_CODE } from "@harbour/api";
import { type Browser, type CallContext, HarbourError, isHarbourError } from "@harbour/contracts";

export interface BrowserApiOptions {
	readonly browser: Browser;
	/** Signs the request's caller in, or rejects (a `HarbourError` is answered with its status). */
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

/** A `HarbourError` as its status and `{ error: { code, message } }`; anything else as a bare 500. */
export function browserErrorResponse(error: unknown): Response {
	if (isHarbourError(error)) {
		return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
	}
	// Never echo an unexpected error's message: it may hold anything, a provider's link included.
	return json({ error: { code: "unavailable", message: "The browser API failed" } }, 500);
}

/** `/v1/sessions/{sessionId}/browsers/...`: the only paths this API answers. */
const BROWSER_PATH = /^\/sessions\/[^/]+\/browsers\//;

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
					throw new HarbourError("not_found", "No such browser in this session");
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
			if (!path.startsWith(basePath) || !BROWSER_PATH.test(path.slice(basePath.length))) return undefined;
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
