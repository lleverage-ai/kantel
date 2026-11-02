/**
 * Names Kantel had before the rename, when it was Harbour, that it still accepts beside today's (TASK-4492): HTTP
 * headers and token prefixes. A client, an image or a token made before the rename keeps working:
 *
 * - Headers: today's are `kantel-*` and `x-kantel-*`. A server reads today's name first and the old `harbour-*` or
 *   `x-harbour-*` one when it is absent (`readHeader`). Where something built before the rename reads a header Kantel
 *   sends (a host app checking a callback's signature, an older image), Kantel sends both (`withLegacyHeaders`).
 * - Token prefixes: API keys are `ktk_…` (were `hbr_…`), sign-in sessions `kts_…` (were `hbs_…`) and tunnel tokens
 *   `ktt_…` (were `hbt_…`). Only new ones get the new prefix: an issued token keeps its bytes, and its hash, for life.
 *
 * - Theme IDs: the built-in themes `harbour` and `harbour-light` (before the rename) are `kantel` and `kantel-light`.
 *
 * Environment variables have their own fallback, in `env.ts`.
 */

/** A header's name before the rename: `kantel-x` was `harbour-x`, `x-kantel-x` was `x-harbour-x`. */
export function legacyHeaderName(name: string): string | undefined {
	const lower = name.toLowerCase();
	if (lower.startsWith("kantel-")) return `harbour-${lower.slice("kantel-".length)}`;
	if (lower.startsWith("x-kantel-")) return `x-harbour-${lower.slice("x-kantel-".length)}`;
	return undefined;
}

/** A header by today's name, or by its name before the rename when today's isn't there. */
export function readHeader(headers: { get(name: string): string | null }, name: string): string | null {
	const value = headers.get(name);
	if (value !== null) return value;
	const legacy = legacyHeaderName(name);
	return legacy === undefined ? null : headers.get(legacy);
}

/** The headers given, each `kantel-*` one also under its name before the rename, for readers built before it. */
export function withLegacyHeaders(headers: { readonly [name: string]: string }): Record<string, string> {
	const out: Record<string, string> = { ...headers };
	for (const [name, value] of Object.entries(headers)) {
		const legacy = legacyHeaderName(name);
		if (legacy !== undefined && out[legacy] === undefined) out[legacy] = value;
	}
	return out;
}

/** A token's prefix today, by kind, and before the rename. */
export const TOKEN_PREFIXES = {
	apiKey: { current: "ktk_", legacy: "hbr_" },
	session: { current: "kts_", legacy: "hbs_" },
	tunnel: { current: "ktt_", legacy: "hbt_" },
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

/**
 * The built-in themes' IDs before the rename, and today's. A person's saved theme (`UserPreferences.theme`), a browser's
 * remembered one and a custom theme's `extends` may still name the old ones; each is read as today's.
 */
export const LEGACY_THEME_IDS: { readonly [legacy: string]: string } = {
	harbour: "kantel", // before the rename
	"harbour-light": "kantel-light", // before the rename
};

/** A theme ID (or `system`) as it is today: an ID from before the rename becomes today's, any other is kept. */
export function currentThemeId(id: string): string {
	return Object.hasOwn(LEGACY_THEME_IDS, id) ? (LEGACY_THEME_IDS[id] as string) : id;
}

/** Whether a token has its kind's prefix, today's or the one before the rename. */
export function hasTokenPrefix(token: string, kind: TokenKind): boolean {
	const { current, legacy } = TOKEN_PREFIXES[kind];
	return token.startsWith(current) || token.startsWith(legacy);
}
