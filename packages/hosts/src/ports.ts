/**
 * Exposed ports: a sandbox's port at `https://{port}-{subdomain}.{domain}`, where `{domain}` is a wildcard name the
 * operator points at the gateway (`KANTEL_COMPUTE_PORTS_DOMAIN`). The sandbox has no address of its own: the gateway
 * answers the name and relays each request to the port over the connection the sandbox's host keeps open.
 *
 * Token-gated unless exposed `public`: the URL carries `?_token=…` (32 random bytes), which the gateway trades for a
 * cookie on that one name and takes off before the sandbox sees the request, as boat.dev does. An API client can send
 * the token in the query each time, or the cookie itself: `Cookie: __Host-kantel_port=…`. Exposing a port again, or
 * hiding it, ends its token. A request for a name nobody exposed, or without the token, never reaches a sandbox.
 *
 * The cookie (TASK-4887). Every port's name is the same site as every other under the domain (until the domain is on
 * the Public Suffix List), so `SameSite` doesn't stop a page on another sandbox's port from sending requests here with
 * this port's cookie attached. So:
 *
 * - It is a `__Host-` cookie over https (`__Host-kantel_port`: `Secure`, `Path=/`, no `Domain`, from
 *   `@kantel/identity/cookies`), so no other name can set or shadow it; `kantel_port` over plain http, where a browser
 *   refuses the prefix. The old `_kantel_port` is no longer read (a hard cut: open the port's URL again).
 * - It counts only for a request the port's own pages, the person or the same sandbox made (`cookieHonoured`):
 *   `Sec-Fetch-Site` `same-origin` or `none`; a top-level navigation that changes nothing (`Sec-Fetch-Mode: navigate`,
 *   `Sec-Fetch-Dest: document`, GET or HEAD); or an `Origin` (else a `Referer`) on this name or on another port of the
 *   same sandbox, so a frontend on one port can call its API on another. A WebSocket upgrade has only its `Origin` to
 *   go on. Otherwise the request is answered as if it had no cookie (401). A request that says nothing about where it
 *   comes from (no `Sec-Fetch-Site`, `Origin` or `Referer`) is not a browser's page, so the cookie counts.
 * - The token in the query always counts: it is the capability itself, which no other page knows.
 * - Every cookie of that name is tried against the token's hash, so one planted under it can't open a port, nor stop
 *   the real one being read.
 *
 * Exposures are kept in the relay store (`relay-store.ts`), so they outlast a gateway restart and every replica answers
 * every port's name. The store keeps the SHA-256 of a token, never the token: the URL with it is shown once, when the
 * port is exposed.
 */
import { consoleCookieName, setConsoleCookie } from "@kantel/identity/cookies";
import type { PortSink, PortStream } from "./hub.ts";
import { PortHttpError, proxyHttp } from "./port-http.ts";
import type { ExposureRecord, RelayStore } from "./relay-store.ts";
import { sameSecret, sha256Hex } from "./tunnel.ts";

export const PORT_TOKEN_PARAM = "_token";
/** The gate cookie's name, before the `__Host-` prefix https gives it. */
export const PORT_COOKIE_BASE = "kantel_port";
/** The gate cookie over https: `__Host-kantel_port`. */
export const PORT_COOKIE = consoleCookieName(PORT_COOKIE_BASE, true);
/** The name before TASK-4887: no longer read, only kept from the sandbox. */
export const LEGACY_PORT_COOKIE = "_kantel_port";

/** The gate cookie's name on a gateway reached over `scheme`. */
export function portCookieName(scheme: "https" | "http"): string {
	return consoleCookieName(PORT_COOKIE_BASE, scheme === "https");
}

/** What an upgrade's request says about where it comes from. */
export interface UpgradeSource {
	/** The `Origin` header: a browser sends it with every WebSocket upgrade. */
	readonly origin?: string | undefined;
}

export interface PortRouterOptions {
	/** The wildcard name's parent: `ports.kantel.example` for `*.ports.kantel.example`. */
	readonly domain: string;
	/** What the URLs use (default https). */
	readonly scheme?: "https" | "http";
	/** Opens a byte stream to a sandbox's port (`HostsService.sandboxes.openPort`). */
	openPort(sandboxId: string, port: number, sink: PortSink): Promise<PortStream>;
	/** Where exposures are kept: shared by the gateway's replicas. */
	readonly store: RelayStore;
	readonly now?: () => number;
	/**
	 * Whether whoever exposed a port still may use it (their key or sign-in still good, still in the account). Asked on
	 * every request and upgrade; absent, everyone may.
	 */
	stillAllowed?(grantee: string | undefined, sandboxId: string): Promise<boolean>;
}

/** Where an upgrade on a port's name may go, or why not. */
export type PortUpgrade =
	| {
			readonly ok: true;
			readonly sandboxId: string;
			readonly port: number;
			readonly path: string;
			readonly host: string;
			/** Who exposed it, as JSON, when they were named. */
			readonly grantee?: string;
	  }
	| { readonly ok: false; readonly status: number; readonly reason: string };

export interface PortRouter {
	readonly domain: string;
	/** The URL, with its token unless public: the only time the token is shown. */
	expose(
		sandboxId: string,
		port: number,
		options: { readonly public: boolean; readonly subdomain: string; readonly grantee?: string },
	): Promise<{ url: string }>;
	hide(sandboxId: string, port: number): Promise<void>;
	/** Ends every port of a sandbox (deleted, stopped). */
	forget(sandboxId: string): Promise<void>;
	/** The answer for a request to a port's name; undefined when the request isn't for one. */
	fetch(request: Request, client?: { readonly address?: string }): Promise<Response | undefined>;
	/**
	 * For a WebSocket upgrade: undefined when it isn't for a port's name. `from` is what the request says about where it
	 * comes from: the cookie counts only from this port's name or another port of the same sandbox.
	 */
	upgrade(
		host: string,
		path: string,
		cookie: string | undefined,
		from: UpgradeSource,
	): Promise<PortUpgrade | undefined>;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A port's URL as the sandbox's records keep it: never with its token. */
export function withoutPortToken(url: string): string {
	const parsed = new URL(url);
	if (!parsed.searchParams.has(PORT_TOKEN_PARAM)) return url;
	parsed.searchParams.delete(PORT_TOKEN_PARAM);
	return parsed.toString();
}

function cookiesNamed(header: string | null | undefined, name: string): string[] {
	if (header === null || header === undefined) return [];
	return header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${name}=`))
		.map((part) => part.slice(name.length + 1));
}

/** Methods that change nothing: a navigation with one of these may carry the cookie from anywhere, as SameSite=Lax. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

const lowered = (value: string | null): string | null => (value === null ? null : value.trim().toLowerCase());

/** The origin of a `Referer`, or undefined when there's none or it isn't a URL. */
function referrerOrigin(value: string | null): string | undefined {
	if (value === null || value.trim() === "") return undefined;
	try {
		return new URL(value.trim()).origin;
	} catch {
		return undefined;
	}
}

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
	new Response(`${body}\n`, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
	});

export function createPortRouter(options: PortRouterOptions): PortRouter {
	const domain = options.domain.toLowerCase().replace(/^\.+|\.+$/g, "");
	const scheme = options.scheme ?? "https";
	const { store } = options;
	const now = options.now ?? Date.now;
	const cookieName = portCookieName(scheme);

	/** The exposure a host name is for: undefined when it isn't under the domain, null when it names none. */
	async function lookup(hostname: string): Promise<ExposureRecord | null | undefined> {
		const name = hostname.toLowerCase().replace(/\.$/, "");
		if (!name.endsWith(`.${domain}`)) return undefined;
		const label = name.slice(0, -(domain.length + 1));
		if (!/^\d{1,5}-[a-z0-9-]+$/.test(label)) return null;
		return (await store.getExposure(label)) ?? null;
	}

	/** The token a request carries that matches the exposure's, from the query or a cookie; "" for a public port. */
	async function admitted(
		exposure: ExposureRecord,
		query: string | null,
		cookie: string | null | undefined,
	): Promise<string | undefined> {
		const hash = exposure.tokenHash;
		if (hash === undefined) return "";
		const offered = query !== null ? [query] : cookiesNamed(cookie, cookieName);
		for (const value of offered) if (sameSecret(await sha256Hex(value), hash)) return value;
		return undefined;
	}

	/**
	 * Whether `source` (an `Origin`, or a `Referer`'s origin) is this port's own name or another port of the same
	 * sandbox. `null`, another scheme, another sandbox's port and any other site are not.
	 */
	async function sameSandbox(exposure: ExposureRecord, ownHostname: string, source: string): Promise<boolean> {
		let url: URL;
		try {
			url = new URL(source.trim());
		} catch {
			return false;
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") return false;
		const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
		if (hostname === ownHostname) return true;
		const other = await lookup(hostname);
		return other !== undefined && other !== null && other.sandboxId === exposure.sandboxId;
	}

	/**
	 * Whether a request's gate cookie counts: only when this port's pages, the person (a typed URL, a bookmark, a link
	 * followed to a page) or the same sandbox's other ports made the request. See the module's comment.
	 */
	async function cookieHonoured(exposure: ExposureRecord, request: Request, ownHostname: string): Promise<boolean> {
		const headers = request.headers;
		const site = lowered(headers.get("sec-fetch-site"));
		if (site === "same-origin" || site === "none") return true;
		if (
			lowered(headers.get("sec-fetch-mode")) === "navigate" &&
			lowered(headers.get("sec-fetch-dest")) === "document" &&
			SAFE_METHODS.has(request.method.toUpperCase())
		) {
			return true;
		}
		const source = headers.get("origin") ?? referrerOrigin(headers.get("referer"));
		// Nothing says where it came from: a script or an API client, not a page (a browser too old for Sec-Fetch-Site
		// and asked for a page's subresource with no Referer too).
		if (source === undefined) return site === null;
		return sameSandbox(exposure, ownHostname, source);
	}

	return {
		domain,
		async expose(sandboxId, port, { public: isPublic, subdomain, grantee }) {
			const label = `${port}-${subdomain.toLowerCase()}`;
			if (!/^[a-z0-9-]+$/.test(subdomain)) throw new Error("A sandbox's subdomain is letters, digits and dashes");
			const token = isPublic ? undefined : base64url(crypto.getRandomValues(new Uint8Array(32)));
			await store.putExposure({
				label,
				sandboxId,
				port,
				createdAt: now(),
				...(token === undefined ? {} : { tokenHash: await sha256Hex(token) }),
				...(grantee === undefined ? {} : { grantee }),
			});
			const url = `${scheme}://${label}.${domain}/`;
			return { url: token === undefined ? url : `${url}?${PORT_TOKEN_PARAM}=${token}` };
		},
		hide(sandboxId, port) {
			return store.removeExposures(sandboxId, port);
		},
		forget(sandboxId) {
			return store.removeExposures(sandboxId);
		},
		async fetch(request, client) {
			const url = new URL(request.url);
			const exposure = await lookup(url.hostname);
			if (exposure === undefined) return undefined;
			if (exposure === null) return text(404, "No sandbox port is exposed here.");
			const query = url.searchParams.get(PORT_TOKEN_PARAM);
			const cookie = request.headers.get("cookie");
			// A cookie another sandbox's page (or another site) sent along counts as no cookie: the same 401.
			const honoured =
				query !== null ||
				exposure.tokenHash === undefined ||
				(cookie !== null && (await cookieHonoured(exposure, request, url.hostname.toLowerCase())));
			const token = await admitted(exposure, query, honoured ? cookie : undefined);
			if (token === undefined) {
				return text(401, "This port needs its token: open the URL Kantel gave you, with its _token.");
			}
			if (options.stillAllowed !== undefined && !(await options.stillAllowed(exposure.grantee, exposure.sandboxId))) {
				return text(403, "Whoever exposed this port no longer has access to its sandbox.");
			}
			if (query !== null) {
				url.searchParams.delete(PORT_TOKEN_PARAM);
				if (exposure.tokenHash !== undefined && (request.method === "GET" || request.method === "HEAD")) {
					// Trade the token for a cookie on this one name, and take it out of the address bar and history.
					return new Response(null, {
						status: 303,
						headers: {
							location: `${url.pathname}${url.search}`,
							"set-cookie": setConsoleCookie(PORT_COOKIE_BASE, token, { secure: scheme === "https" }),
							"cache-control": "no-store",
							"referrer-policy": "no-referrer",
						},
					});
				}
			}
			const forwarded: Record<string, string> = { "x-forwarded-proto": scheme, "x-forwarded-host": url.host };
			if (client?.address !== undefined) forwarded["x-forwarded-for"] = client.address;
			try {
				return await proxyHttp((sink) => options.openPort(exposure.sandboxId, exposure.port, sink), request, {
					host: url.host,
					path: `${url.pathname}${url.search}`,
					forwarded,
					dropCookies: [cookieName, LEGACY_PORT_COOKIE],
				});
			} catch (error) {
				if (error instanceof PortHttpError) return text(error.status, error.message);
				return text(502, "The sandbox's port didn't answer.");
			}
		},
		async upgrade(host, path, cookie, from) {
			const hostname = host.replace(/:\d+$/, "");
			const exposure = await lookup(hostname);
			if (exposure === undefined) return undefined;
			if (exposure === null) return { ok: false, status: 404, reason: "No sandbox port is exposed here" };
			const url = new URL(path, "http://port");
			const query = url.searchParams.get(PORT_TOKEN_PARAM);
			// A browser sends Origin with every upgrade: the cookie counts only from this name or the same sandbox's ports.
			const honoured =
				query !== null ||
				from.origin === undefined ||
				(await sameSandbox(exposure, hostname.toLowerCase().replace(/\.$/, ""), from.origin));
			if ((await admitted(exposure, query, honoured ? cookie : undefined)) === undefined) {
				return { ok: false, status: 401, reason: "This port needs its token" };
			}
			if (options.stillAllowed !== undefined && !(await options.stillAllowed(exposure.grantee, exposure.sandboxId))) {
				return { ok: false, status: 403, reason: "Whoever exposed this port no longer has access" };
			}
			url.searchParams.delete(PORT_TOKEN_PARAM);
			return {
				ok: true,
				sandboxId: exposure.sandboxId,
				port: exposure.port,
				path: `${url.pathname}${url.search}`,
				host,
				...(exposure.grantee === undefined ? {} : { grantee: exposure.grantee }),
			};
		},
	};
}
