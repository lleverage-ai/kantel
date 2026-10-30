// Session placeholders: what a sandbox holds instead of a credential.
//
// The vault issues each sandbox start one random placeholder per credential it
// may name (`Vault.issueSessionPlaceholders`). The sandbox puts it where the
// key would go; this proxy swaps it for the real key on the way out, and only
// when all of these hold:
//
// - It is in an auth header (`Authorization` or `x-api-key`). One in the URL,
//   the query string, the body or any other header is never read or replaced,
//   so an upstream that echoes the request echoes the placeholder, never the
//   key, and a key never lands in a log line that records URLs.
// - The vault says it is one of the session's current placeholders (a restart
//   or the session's end retires the earlier ones) and that its item is bound
//   to the request's host. A placeholder sent to any other host is refused.
//
// The header that carried it is dropped and the vault's injection is set, so
// the key goes out in exactly one header the item names.

/** Keep in step with `SESSION_PLACEHOLDER_PATTERN` in `@harbour/contracts`. */
export const PLACEHOLDER = /harbour-ph-[0-9a-f]{32}/;

/** Keep in step with `PLACEHOLDER_AUTH_HEADERS` in `@harbour/contracts`. */
export const AUTH_HEADERS: readonly string[] = ["authorization", "x-api-key"];

export type PlaceholderFound =
	| { readonly kind: "none" }
	| { readonly kind: "one"; readonly header: string; readonly placeholder: string }
	/** Two different placeholders, or one header holding two: refused rather than guessed. */
	| { readonly kind: "ambiguous" };

/** The placeholder a request carries in its auth headers. Any other place is not looked at. */
export function placeholderIn(headers: Headers): PlaceholderFound {
	let found: { header: string; placeholder: string } | undefined;
	for (const header of AUTH_HEADERS) {
		const value = headers.get(header);
		if (value === null) continue;
		const all = value.match(new RegExp(PLACEHOLDER.source, "g")) ?? [];
		if (all.length === 0) continue;
		if (new Set(all).size > 1) return { kind: "ambiguous" };
		const placeholder = all[0]!;
		if (found !== undefined && found.placeholder !== placeholder) return { kind: "ambiguous" };
		found ??= { header, placeholder };
	}
	return found === undefined ? { kind: "none" } : { kind: "one", ...found };
}

/**
 * The headers to send upstream: every auth header that carried the placeholder dropped, then the vault's injection
 * set. Nothing else changes, so the URL and the other headers go out as the sandbox wrote them.
 */
export function withInjection(
	headers: Headers,
	found: PlaceholderFound,
	inject: { readonly header: string; readonly value: string } | undefined,
): Headers {
	const out = new Headers(headers);
	if (found.kind === "one") {
		for (const header of AUTH_HEADERS) {
			if (out.get(header)?.includes(found.placeholder)) out.delete(header);
		}
	}
	if (inject !== undefined) out.set(inject.header, inject.value);
	return out;
}
