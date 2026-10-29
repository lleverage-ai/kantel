/**
 * The gateway's side of a view link (`/browser#<token>` in the console, its data under `/v1/browser/view/<browser>`): a
 * live view or a replay of one browser, for whoever holds the token and nothing more. The token is the only auth here
 * (an iframe in another app can't send a credential); it was minted for a person or app the broker checked
 * (src/runtime/view-token.ts).
 *
 * The token is never in a URL, so it is in no access log: the link carries it in its fragment, which a browser doesn't
 * send, and the viewer's page sends it as `Authorization: Bearer <token>`, or for the live socket (which can't have
 * headers) as a WebSocket subprotocol, `harbour-view-token.<token>`, beside `harbour-view.v1`, which the answer picks.
 *
 *   GET /v1/browser/view/{browser}                       { mode, control, expiresAt, status }
 *   WS  /v1/browser/view/{browser}/live                  the live view (joined by the host: `pipeLive`)
 *   GET /v1/browser/view/{browser}/recording             the recording's manifest (replay tokens only)
 *   GET /v1/browser/view/{browser}/recording/{page}/{n}  one chunk of JPEG frames in Matroska (replay tokens only)
 *
 * `{browser}` must be the token's own browser: it names the browser in the path (for routing and caching) without
 * being any part of the auth.
 *
 * `pipeLive` joins the browser's live socket to the viewer's, letting a watch-only viewer's frame acks and canvas size
 * through and nothing else, and closing both when the token expires: ported from brwsr's share links
 * (tvdavies/brwsr@0d22bf8, src/share.ts: `watchMessage`, `pipeShared`). Portable: WHATWG sockets and `fetch` only.
 */
import type { BrowserHostClient } from "./provider.ts";
import type { BrowserViewClaims, BrowserViewSigner } from "./view-token.ts";

export const BROWSER_VIEW_API = "/v1/browser/view/";

/** The live socket's query parameters a viewer may set (the agent's `/live`, protocol v2). */
export const LIVE_PARAMS = ["page", "quality", "w", "h", "fps", "scale", "adapt"] as const;

/** Close codes the viewer reads: the token expired, or the browser ended. */
export const CLOSE_EXPIRED = 4001;
export const CLOSE_ENDED = 1001;

const headers = {
	"content-type": "application/json",
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

const failure = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

/** The subprotocol a live socket's answer picks, and the prefix of the one that carries the token. */
export const VIEW_PROTOCOL = "harbour-view.v1";
export const VIEW_TOKEN_PROTOCOL = "harbour-view-token.";

const TOKEN = /^[A-Za-z0-9_.-]{1,1024}$/;

/** `{ browser, rest }` for a path under `/v1/browser/view/`, or `undefined`. */
export function parseViewPath(pathname: string): { readonly browser: string; readonly rest: string } | undefined {
	if (!pathname.startsWith(BROWSER_VIEW_API)) return undefined;
	const tail = pathname.slice(BROWSER_VIEW_API.length);
	const slash = tail.indexOf("/");
	const browser = slash < 0 ? tail : tail.slice(0, slash);
	if (!/^[A-Za-z0-9-]{1,64}$/.test(browser)) return undefined;
	return { browser, rest: slash < 0 ? "" : tail.slice(slash) };
}

/** The view token a request carries: `Authorization: Bearer`, or the live socket's subprotocol. */
export function viewTokenOf(request: Request): string | undefined {
	const authorization = request.headers.get("authorization") ?? "";
	if (authorization.startsWith("Bearer ")) {
		const token = authorization.slice(7).trim();
		return TOKEN.test(token) ? token : undefined;
	}
	for (const offered of (request.headers.get("sec-websocket-protocol") ?? "").split(",")) {
		const protocol = offered.trim();
		if (!protocol.startsWith(VIEW_TOKEN_PROTOCOL)) continue;
		const token = protocol.slice(VIEW_TOKEN_PROTOCOL.length);
		return TOKEN.test(token) ? token : undefined;
	}
	return undefined;
}

/** A view request's claims: its token checked, and for the browser its path names. `undefined` when it isn't. */
export async function viewClaims(
	request: Request,
	views: BrowserViewSigner,
	now: number,
): Promise<{ readonly claims: BrowserViewClaims; readonly rest: string } | undefined> {
	const parsed = parseViewPath(new URL(request.url).pathname);
	const token = viewTokenOf(request);
	if (parsed === undefined || token === undefined) return undefined;
	const claims = await views.verify(token, now);
	return claims?.browser === parsed.browser ? { claims, rest: parsed.rest } : undefined;
}

export interface BrowserViewHandlerOptions {
	readonly views: BrowserViewSigner;
	readonly host: BrowserHostClient;
	readonly now?: () => number;
}

export interface BrowserViewRequest {
	/** The answer, for everything but a live socket. */
	readonly response?: Response;
	/** A live socket to join: the host-relative path of the browser's `/live` and the token's claims. */
	readonly live?: { readonly claims: BrowserViewClaims; readonly path: string };
}

/**
 * Handles a request under `/v1/browser/view/`. A live socket comes back as `live` for the host's gateway to open and
 * join (`pipeLive`), since joining sockets is different on Workers and in Node.
 */
export async function handleBrowserView(
	request: Request,
	options: BrowserViewHandlerOptions,
): Promise<BrowserViewRequest> {
	const now = options.now ?? Date.now;
	const url = new URL(request.url);
	if (parseViewPath(url.pathname) === undefined) return { response: failure(404, "not_found", "No such view") };
	const checked = await viewClaims(request, options.views, now());
	if (checked === undefined) {
		return { response: failure(401, "expired", "This view link has expired or is not valid") };
	}
	if (request.method !== "GET") return { response: failure(405, "invalid", "Views are read with GET") };
	const { claims, rest } = checked;
	if (rest === "" || rest === "/") {
		let status = "unknown";
		try {
			const answer = await options.host.fetch(claims.browser, "/status");
			const body = (await answer.json()) as { status?: unknown };
			status = answer.ok && typeof body.status === "string" ? body.status : "gone";
		} catch {
			status = "unknown";
		}
		return { response: json({ mode: claims.mode, control: claims.control, expiresAt: claims.expiresAt, status }) };
	}
	if (rest === "/live") {
		if (claims.mode !== "live") return { response: failure(403, "forbidden", "This link is for a replay") };
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return { response: failure(426, "invalid", "The live view is a WebSocket") };
		}
		const query = new URLSearchParams({ v: "2" });
		for (const name of LIVE_PARAMS) {
			const value = url.searchParams.get(name);
			if (value !== null && /^[\w.-]{1,40}$/.test(value)) query.set(name, value);
		}
		return { live: { claims, path: `/live?${query}` } };
	}
	if (claims.mode !== "replay") return { response: failure(403, "forbidden", "This link is for a live view") };
	if (rest === "/recording" || /^\/recording\/\d+\/\d{1,5}$/.test(rest)) {
		const answer = await options.host.fetch(claims.browser, rest);
		const out = new Headers(answer.headers);
		// A chunk never changes, but its URL holds no token: only this viewer's own cache may keep it, keyed on its auth.
		out.set("cache-control", rest === "/recording" ? "no-store" : "private, max-age=3600, immutable");
		out.set("vary", "authorization");
		out.set("referrer-policy", "no-referrer");
		out.set("x-content-type-options", "nosniff");
		return { response: new Response(answer.body, { status: answer.status, headers: out }) };
	}
	return { response: failure(404, "not_found", "No such view route") };
}

/** A socket as both Workers and the `ws` package give one. */
export interface PipeSocket {
	send(data: string | ArrayBuffer | ArrayBufferView): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	addEventListener(type: "close", listener: (event: { readonly code: number; readonly reason: string }) => void): void;
	addEventListener(type: "error", listener: (event: unknown) => void): void;
}

/**
 * What a watch-only viewer may still send up: frame acks and its canvas size (live protocol v2), rebuilt from the fields
 * they need. Without the acks the browser stops sending frames. Never input.
 */
export function watchMessage(data: unknown): string | null {
	if (typeof data !== "string" || data.length > 200) return null;
	let message: { type?: unknown; w?: unknown; h?: unknown };
	try {
		message = JSON.parse(data);
	} catch {
		return null;
	}
	if (message?.type === "ack") return JSON.stringify({ type: "ack" });
	if (message?.type === "size" && Number.isFinite(message.w) && Number.isFinite(message.h)) {
		return JSON.stringify({ type: "size", w: message.w, h: message.h });
	}
	return null;
}

/**
 * Joins the browser's live socket (`up`) to the viewer's (`down`). Frames go down as they come; the viewer's input goes
 * up only with `control`. Either side closing closes the other; the token expiring closes both (`CLOSE_EXPIRED`).
 */
export function pipeLive(
	up: PipeSocket,
	down: PipeSocket,
	options: { readonly control: boolean; readonly expiresAt: number; readonly now?: () => number },
): { stop(): void } {
	const now = options.now ?? Date.now;
	let done = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const sendable = (code: number) =>
		code === 1000 || (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999)
			? code
			: CLOSE_ENDED;
	const stop = (downCode: number, downReason: string) => {
		if (done) return;
		done = true;
		if (timer !== undefined) clearTimeout(timer);
		try {
			down.close(downCode, downReason);
		} catch {}
		try {
			up.close(1000, "viewer left");
		} catch {}
	};
	// Binary frames may arrive as Blobs (workerd's default); send their bytes, in order.
	const forward = (to: PipeSocket) => {
		let chain = Promise.resolve();
		return (data: unknown) => {
			if (typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
				chain = chain.then(() => {
					if (!done) to.send(data as string | ArrayBuffer);
				});
			} else if (data !== null && typeof (data as Blob).arrayBuffer === "function") {
				const bytes = (data as Blob).arrayBuffer();
				chain = chain.then(async () => {
					const buffer = await bytes;
					if (!done) to.send(buffer);
				});
			}
			chain = chain.catch(() => undefined);
		};
	};
	const toDown = forward(down);
	const toUp = forward(up);
	up.addEventListener("message", (event) => {
		if (!done) toDown(event.data);
	});
	down.addEventListener("message", (event) => {
		if (done) return;
		if (options.control) return toUp(event.data);
		const message = watchMessage(typeof event.data === "string" ? event.data : null);
		if (message !== null) toUp(message);
	});
	up.addEventListener("close", (event) => stop(sendable(event.code), event.reason || "browser ended"));
	up.addEventListener("error", () => stop(1011, "browser socket failed"));
	down.addEventListener("close", () => stop(1000, ""));
	down.addEventListener("error", () => stop(1000, ""));
	timer = setTimeout(() => stop(CLOSE_EXPIRED, "link expired"), Math.max(0, options.expiresAt - now()));
	return { stop: () => stop(1000, "") };
}
