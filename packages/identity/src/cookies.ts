/**
 * Cookies the console's origin sets for itself (TASK-4842).
 *
 * Kantel's sessions are not cookies: the console sends its session (`kts_…`) as a bearer and keeps it in the page's
 * localStorage, which no other origin can read, and neither gateway reads a session from a cookie. A cookie the
 * console's origin does need (a sign-in's short-lived state, say) goes through here, so a page under a sibling name (a
 * sandbox's port on a self-hosted install whose ports domain shares the console's registrable domain; hosted ports are
 * on `kantel.run`, a registrable domain of their own, and never share the console's site) can neither set it nor
 * shadow it:
 *
 * - Over HTTPS it is a `__Host-` cookie: `Secure`, `Path=/` and no `Domain`. A browser refuses a `__Host-` cookie set
 *   any other way, so another name can't plant one for the console, and the console reads only the prefixed name: a
 *   bare-named cookie of the same name, which anyone on the site could set with `Domain=`, is never read.
 * - Over plain http (a laptop on `localhost` or `127.0.0.1`, a self-hosted gateway with no TLS in front), where a browser
 *   refuses `Secure` and so `__Host-`, the name has no prefix and no `Secure`; the rest is the same. Whoever can reach
 *   plain http can change its traffic anyway.
 *
 * `secure` is whether people reach the console over https: the request URL's scheme on Cloudflare, and
 * `KANTEL_PUBLIC_URL`'s on the self-hosted gateway, whose request URLs are always `http:` behind a proxy that ends TLS.
 */

export const HOST_COOKIE_PREFIX = "__Host-";

export interface ConsoleCookieOptions {
	/** Whether people reach the console over https; see above. */
	readonly secure: boolean;
	/** How long the browser keeps it. Default: until the browser closes. */
	readonly maxAgeSeconds?: number;
	/** Default true: no script reads it. */
	readonly httpOnly?: boolean;
	/** Default `Lax`. A second line only: same-site pages are not stopped by it (`csrf.ts`). */
	readonly sameSite?: "Lax" | "Strict";
}

/** The name `name` is set and read under: `__Host-name` over https, `name` over plain http. */
export function consoleCookieName(name: string, secure: boolean): string {
	if (name.startsWith(HOST_COOKIE_PREFIX) || !/^[A-Za-z0-9_-]+$/.test(name)) {
		throw new Error(`A console cookie's name is letters, digits, "_" and "-", without a prefix: ${name}`);
	}
	return secure ? `${HOST_COOKIE_PREFIX}${name}` : name;
}

/** A `Set-Cookie` value for the console's own origin: `Path=/`, never a `Domain`, `Secure` over https. */
export function setConsoleCookie(name: string, value: string, options: ConsoleCookieOptions): string {
	if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(value)) {
		throw new Error("A console cookie's value must be cookie-safe (base64url, say)");
	}
	return [
		`${consoleCookieName(name, options.secure)}=${value}`,
		"Path=/",
		...(options.maxAgeSeconds === undefined ? [] : [`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`]),
		...(options.httpOnly === false ? [] : ["HttpOnly"]),
		...(options.secure ? ["Secure"] : []),
		`SameSite=${options.sameSite ?? "Lax"}`,
	].join("; ");
}

/** A `Set-Cookie` value that removes `name`. */
export function clearConsoleCookie(name: string, options: Pick<ConsoleCookieOptions, "secure">): string {
	return setConsoleCookie(name, "", { ...options, maxAgeSeconds: 0 });
}

/**
 * The value of the console's cookie `name` on `request`: only under `consoleCookieName(name, secure)`, so over https a
 * bare `name` (which a sibling name could set for the whole site) is never read. Undefined when it isn't there, or
 * when it is there more than once, since only one of them can be the console's.
 */
export function readConsoleCookie(
	request: Request,
	name: string,
	options: Pick<ConsoleCookieOptions, "secure">,
): string | undefined {
	const wanted = consoleCookieName(name, options.secure);
	const values: string[] = [];
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const index = part.indexOf("=");
		if (index > 0 && part.slice(0, index).trim() === wanted) values.push(part.slice(index + 1).trim());
	}
	return values.length === 1 ? values[0] : undefined;
}
