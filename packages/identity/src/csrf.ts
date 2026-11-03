/**
 * Cross-site request refusal for the console's API, without relying on SameSite (TASK-4842).
 *
 * Kantel's hosted ports live under a name such as `ports.kantel.dev`. Until that domain is on the Public Suffix List,
 * a sandbox's page there is the same site as a console under the same registrable domain (`app.kantel.dev`), so a
 * browser sends the console's cookies with the page's requests whatever their SameSite says. Kantel's own sessions are
 * bearers the console sends in `Authorization`, which no other page can add, but a cookie can still sign a request in:
 * Cloudflare Access's, on a deployment behind it. So every gateway refuses a browser's state-changing request that
 * doesn't come from the console itself.
 *
 * `crossSiteRefusal` looks only at requests that change something (any method but GET, HEAD and OPTIONS) and carry no
 * `Authorization` header: an API key or a Kantel session sent as a bearer (the CLI, the SDK, MCP, and the console on
 * its own sign-in) is something a page elsewhere can't attach, so those pass unchanged. For the rest:
 *
 * 1. `Sec-Fetch-Site`, when the browser sends it, must be `same-origin`. `same-site` (a port's page) and `cross-site`
 *    are refused, as is `none`, which no page of the console sends with a write.
 * 2. `Origin`, when sent, must be exactly one of the console's origins: the request's own (the console and its API are
 *    one origin on both gateways), and any the gateway names (`KANTEL_PUBLIC_URL`). `null` is refused.
 * 3. With no `Origin`, a request that carries a cookie is refused: a browser sends `Origin` with every write, so a
 *    cookie without one is not the console. A request with neither (a script, `kantel login`'s device start, a host)
 *    can't carry anyone's ambient credential and passes; it still has to authenticate on its own.
 *
 * The bearer is the synchroniser token: the console proves it is the console by sending a secret no other origin can
 * read, which is why no separate CSRF cookie is needed. WebSocket upgrades are not checked here: every one the
 * gateways accept is authorised by a ticket in its URL or a host's bearer, never by a cookie.
 */
import type { IdentityErrorResponse } from "@kantel/contracts";

/** Methods that change nothing, so no cross-site check applies. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** What a refusal's error says. */
export const CROSS_SITE_REFUSED =
	"Refused a cross-site request: Kantel takes a browser's changes only from the console's own origin";

export interface CrossSiteOptions {
	/**
	 * The console's origins besides the request's own, such as `KANTEL_PUBLIC_URL`. Each is reduced to its origin
	 * (`https://kantel.example.com`).
	 */
	readonly origins?: readonly string[];
	/**
	 * Also accept the request's own host over https. For a gateway behind a proxy that ends TLS, whose request URLs are
	 * always `http:` (the self-hosted gateway): the browser's `Origin` there is `https://` the same host.
	 */
	readonly httpsTwin?: boolean;
}

/** Why a request was refused, for a test or a log; never anything from a credential. */
export type CrossSiteReason = "fetch-site" | "origin" | "no-origin";

/** Why `request` is a cross-site write the console didn't make, or undefined when it may go on. */
export function crossSiteReason(request: Request, options: CrossSiteOptions = {}): CrossSiteReason | undefined {
	if (SAFE_METHODS.has(request.method.toUpperCase())) return undefined;
	if ((request.headers.get("authorization") ?? "").trim() !== "") return undefined;
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site.trim().toLowerCase() !== "same-origin") return "fetch-site";
	const origin = request.headers.get("origin");
	if (origin !== null) return allowedOrigins(request, options).has(origin.trim()) ? undefined : "origin";
	return (request.headers.get("cookie") ?? "").trim() === "" ? undefined : "no-origin";
}

/** A 403 for a cross-site write, or undefined when `request` may go on. */
export function crossSiteRefusal(request: Request, options: CrossSiteOptions = {}): Response | undefined {
	if (crossSiteReason(request, options) === undefined) return undefined;
	const body: IdentityErrorResponse = { error: { code: "forbidden", message: CROSS_SITE_REFUSED } };
	return new Response(JSON.stringify(body), {
		status: 403,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", vary: "origin" },
	});
}

function allowedOrigins(request: Request, options: CrossSiteOptions): Set<string> {
	const own = new URL(request.url);
	const allowed = new Set<string>([own.origin]);
	if (options.httpsTwin === true && own.protocol === "http:") allowed.add(`https://${own.host}`);
	for (const origin of options.origins ?? []) {
		const parsed = originOf(origin);
		if (parsed !== undefined) allowed.add(parsed);
	}
	return allowed;
}

function originOf(value: string): string | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
	} catch {
		return undefined;
	}
}
