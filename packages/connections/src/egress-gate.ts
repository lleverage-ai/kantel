/**
 * Placeholder-gated injection (#331): the pure part of the egress gate, which every target runs the same way. Portable
 * (Web Crypto, `TextEncoder`), so the Cloudflare stack and the self-hosted gateway share it.
 *
 * A sandbox holds a connection's placeholder (`kantel-cn-` and 32 hex digits, random, stable for the connection's
 * life), never its secret. The gate (`egress` on the connections service):
 *
 * 1. **Screens** the request as the sandbox wrote it for a stored secret's own value (`raw_secret`): a key that got
 *    into the sandbox by some other route is refused, not sent. Matching is by fingerprint (`fingerprintsOf`): the
 *    SHA-256 of each long run of token characters in a secret, compared with those of the request's runs, so the gate
 *    never opens a secret to screen.
 * 2. **Finds** placeholders in the headers, the path, the query and, for a JSON or form body up to
 *    `MAX_BODY_SUBSTITUTION_BYTES`, the body.
 * 3. **Decides**: the session may use the connection, the host is one of its hosts, https, the rules and approvals.
 *    A request with no placeholder is never given a credential.
 * 4. **Substitutes** each placeholder with its value, encoded for where it sits; an `Authorization` header that is the
 *    placeholder alone gets the connection's standard rendering (`Bearer <token>` for OAuth).
 *
 * A refusal is an HTTP 403 whose JSON body is an `EgressRefusal` (`EGRESS_REFUSAL_SCHEMA`).
 */
import {
	EGRESS_REFUSAL_CODES,
	type EgressRefusal,
	type EgressRefusalCode,
	type EgressRefusalFix,
} from "@kantel/contracts";

/** Every placeholder in a text: `CONNECTION_PLACEHOLDER_PATTERN` unanchored. */
export const CONNECTION_PLACEHOLDERS = /kantel-cn-[0-9a-f]{32}/g;

/** The largest JSON or form body whose placeholders are replaced. Larger bodies go as they are. */
export const MAX_BODY_SUBSTITUTION_BYTES = 256 * 1024;
/** The most of a body screened for a raw secret. */
export const MAX_BODY_SCREEN_BYTES = 1024 * 1024;
/** The shortest run of token characters fingerprinted: shorter runs match too much, and reveal too much. */
export const MIN_FINGERPRINT_RUN = 16;

/** The JSON Schema every refusal body validates against. */
export const EGRESS_REFUSAL_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	title: "EgressRefusal",
	description:
		"The body of the 403 Kantel's egress gate answers when it refuses a sandbox's outbound request (#331). `error` is machine-readable, `message` says why in a sentence, and `fix`, when there is one, is the next step. Never carries a secret.",
	type: "object",
	required: ["error", "message"],
	properties: {
		error: { type: "string", enum: [...EGRESS_REFUSAL_CODES] },
		message: { type: "string", minLength: 1 },
		fix: {
			type: "object",
			required: ["action", "message"],
			properties: {
				action: {
					type: "string",
					enum: [
						"use_placeholder",
						"change_host",
						"use_https",
						"request_connection",
						"ask_approval",
						"reconnect",
						"none",
					],
				},
				message: { type: "string", minLength: 1 },
				link: { type: "string" },
			},
			additionalProperties: false,
		},
		connectionId: { type: "string" },
		approvalId: { type: "string" },
		digest: { type: "string" },
		link: { type: "string" },
		bindingCode: { type: "string" },
		expiresAt: { type: "number" },
	},
	additionalProperties: false,
} as const;

/** One outbound request as the gate sees it. Header names are lower case. */
export interface EgressDraft {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body?: Uint8Array;
}

/** What one placeholder is replaced with. */
export interface Substitution {
	readonly placeholder: string;
	readonly value: string;
	/** The whole `Authorization` header when the sandbox sent the placeholder there alone, such as `Bearer <token>`. */
	readonly authorization?: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function headerOf(draft: EgressDraft, name: string): string | undefined {
	return draft.headers.find(([key]) => key === name)?.[1];
}

/** A body whose placeholders are replaced: JSON or a form, small enough. */
function substitutableBody(draft: EgressDraft): "json" | "form" | undefined {
	if (draft.body === undefined || draft.body.byteLength === 0 || draft.body.byteLength > MAX_BODY_SUBSTITUTION_BYTES) {
		return undefined;
	}
	const type = (headerOf(draft, "content-type") ?? "").toLowerCase();
	if (type.includes("application/x-www-form-urlencoded")) return "form";
	if (type.includes("json")) return "json";
	return undefined;
}

/** Every distinct placeholder in the request, in the order found. A body's count only when it is substituted. */
export function placeholdersIn(draft: EgressDraft): string[] {
	const found = new Set<string>();
	const scan = (text: string) => {
		for (const match of text.matchAll(CONNECTION_PLACEHOLDERS)) found.add(match[0]);
	};
	scan(draft.url);
	for (const [, value] of draft.headers) scan(value);
	if (substitutableBody(draft) !== undefined) scan(decoder.decode(draft.body));
	return [...found];
}

/** The request with each placeholder replaced, encoded for where it sits. */
export function substitute(draft: EgressDraft, substitutions: readonly Substitution[]): EgressDraft {
	const byPlaceholder = new Map(substitutions.map((each) => [each.placeholder, each]));
	const replace = (text: string, encode: (value: string) => string) =>
		text.replace(CONNECTION_PLACEHOLDERS, (placeholder) => {
			const found = byPlaceholder.get(placeholder);
			return found === undefined ? placeholder : encode(found.value);
		});
	const url = new URL(draft.url);
	// The placeholder is plain hex, so it reads the same encoded or not; its value is encoded for the URL.
	url.pathname = replace(url.pathname, encodeURIComponent);
	url.search = replace(url.search, encodeURIComponent);
	const headers = draft.headers.map(([name, value]): [string, string] => {
		if (name === "authorization") {
			const alone = byPlaceholder.get(value.trim());
			if (alone?.authorization !== undefined) return [name, alone.authorization];
		}
		return [name, replace(value, (secret) => secret)];
	});
	const kind = substitutableBody(draft);
	const body =
		kind === undefined
			? draft.body
			: encoder.encode(
					replace(
						decoder.decode(draft.body),
						kind === "json" ? (secret) => JSON.stringify(secret).slice(1, -1) : encodeURIComponent,
					),
				);
	return { method: draft.method, url: url.href, headers, ...(body === undefined ? {} : { body }) };
}

const BROAD_RUN = new RegExp(`[A-Za-z0-9+/_.~-]{${MIN_FINGERPRINT_RUN},}`, "g");
const NARROW_RUN = new RegExp(`[A-Za-z0-9+_~-]{${MIN_FINGERPRINT_RUN},}`, "g");

/**
 * The runs of token characters long enough to fingerprint, taken two ways. Broadly, `/` and `.` are part of a run, so a
 * base64 key or a JWT is one run; narrowly they split it, so a key in a URL's path (`/v1/<key>`) or after a host is a
 * run of its own, not glued to them. A secret is fingerprinted both ways, so either finds it. `=` and `:` always split
 * runs, so base64 padding drops off. A run is matched whole: a key the sandbox disguises on purpose (a character
 * stuck on, re-encoded) is not this screen's to catch, as nothing in a request could be.
 */
function runsOf(text: string): string[] {
	return [...(text.match(BROAD_RUN) ?? []), ...(text.match(NARROW_RUN) ?? [])];
}

async function sha256(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The fingerprints a secret is screened by: the SHA-256 of each run of its token characters at least
 * `MIN_FINGERPRINT_RUN` long. Kept with the secret's vault reference, never shown; a secret with no such run (a short
 * password) can't be screened.
 */
export async function fingerprintsOf(secret: string): Promise<string[]> {
	return [...new Set(await Promise.all(runsOf(secret).map(sha256)))];
}

function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text.replaceAll("+", " "));
	} catch {
		return text;
	}
}

/** What the request carries as the sandbox wrote it, for screening: the URL (raw and decoded), headers and body. */
function screenedText(draft: EgressDraft): string[] {
	const parts = [draft.url, safeDecode(draft.url)];
	for (const [name, value] of draft.headers) {
		parts.push(value, safeDecode(value));
		// A key in Basic credentials is base64 on the wire.
		const basic = name === "authorization" ? /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(value)?.[1] : undefined;
		if (basic !== undefined) {
			try {
				parts.push(atob(basic));
			} catch {
				// Not base64 after all: screened as written.
			}
		}
	}
	if (draft.body !== undefined && draft.body.byteLength > 0) {
		const text = decoder.decode(draft.body.subarray(0, MAX_BODY_SCREEN_BYTES));
		// Decoded too, whatever its content type says: a form's percent-encoding is undone either way.
		parts.push(text, safeDecode(text));
	}
	return parts;
}

/** The first fingerprint in `known` the request carries, if any: a stored secret's own value, not its placeholder. */
export async function rawSecretIn(draft: EgressDraft, known: ReadonlySet<string>): Promise<string | undefined> {
	if (known.size === 0) return undefined;
	const runs = new Set(screenedText(draft).flatMap(runsOf));
	for (const run of runs) {
		const fingerprint = await sha256(run);
		if (known.has(fingerprint)) return fingerprint;
	}
	return undefined;
}

/** The values to cut out of a response once they went out: each value, encoded as it went, and a rendered header. */
export function redactionsOf(substitutions: readonly Substitution[]): string[] {
	const out = new Set<string>();
	for (const each of substitutions) {
		out.add(each.value);
		out.add(encodeURIComponent(each.value));
		out.add(JSON.stringify(each.value).slice(1, -1));
		if (each.authorization !== undefined) {
			out.add(each.authorization);
			const space = each.authorization.indexOf(" ");
			if (space > 0) out.add(each.authorization.slice(space + 1));
		}
	}
	// A value this short would cut ordinary words out of the answer; Kantel's credentials are never this short.
	return [...out].filter((value) => value.length >= 8);
}

/** Replaces every redaction in `text` with `[redacted]`, longest first; answers how many it replaced. */
export function redactText(
	text: string,
	redactions: readonly string[],
): { readonly text: string; readonly count: number } {
	let count = 0;
	let out = text;
	for (const secret of [...redactions].sort((a, b) => b.length - a.length)) {
		if (secret.length === 0 || !out.includes(secret)) continue;
		const parts = out.split(secret);
		count += parts.length - 1;
		out = parts.join("[redacted]");
	}
	return { text: out, count };
}

/**
 * `redactText` over bytes, as Latin-1 so a binary body keeps every byte it doesn't redact. A body cut short
 * (`truncated`) may end partway through a credential, which whole-credential matching can't see: after whole ones are
 * cut, the longest start of one that ends the body goes too.
 */
export function redactBytes(
	bytes: Uint8Array,
	redactions: readonly string[],
	options: { readonly truncated?: boolean } = {},
): { readonly bytes: Uint8Array; readonly count: number } {
	if (redactions.length === 0) return { bytes, count: 0 };
	let text = "";
	for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192));
	// Redactions as their UTF-8 bytes read as Latin-1, so they match what is on the wire.
	const latin = redactions.map((secret) => String.fromCharCode(...encoder.encode(secret)));
	const whole = redactText(text, latin);
	const clean = { text: whole.text, count: whole.count };
	if (options.truncated === true) {
		let tail = 0;
		for (const secret of latin) {
			for (let length = Math.min(secret.length - 1, clean.text.length); length > tail; length -= 1) {
				if (clean.text.endsWith(secret.slice(0, length))) {
					tail = length;
					break;
				}
			}
		}
		if (tail > 0) {
			clean.text = `${clean.text.slice(0, clean.text.length - tail)}[redacted]`;
			clean.count += 1;
		}
	}
	if (clean.count === 0) return { bytes, count: 0 };
	const out = new Uint8Array(clean.text.length);
	for (let at = 0; at < clean.text.length; at += 1) out[at] = clean.text.charCodeAt(at);
	return { bytes: out, count: clean.count };
}

/** A refusal, with its fix when there is one. */
export function refusal(
	error: EgressRefusalCode,
	message: string,
	extra: { readonly fix?: EgressRefusalFix; readonly connectionId?: string } = {},
): EgressRefusal {
	return {
		error,
		message,
		...(extra.fix === undefined ? {} : { fix: extra.fix }),
		...(extra.connectionId === undefined ? {} : { connectionId: extra.connectionId }),
	};
}

/** The refusal for a stored secret's own value going out. */
export function rawSecretRefusal(connectionId?: string): EgressRefusal {
	return refusal(
		"raw_secret",
		"The request carries a stored secret's own value rather than its placeholder, so Kantel did not send it.",
		{
			fix: {
				action: "use_placeholder",
				message:
					"Put the connection's placeholder where the credential goes (its KANTEL_CONNECTION_* variable, or connections_list) and Kantel adds the credential on the way out. Never copy a credential into the sandbox.",
			},
			...(connectionId === undefined ? {} : { connectionId }),
		},
	);
}

/** A refusal as the sandbox's HTTP client gets it: 403, JSON. */
export function refusalResponse(body: EgressRefusal): {
	readonly status: 403;
	readonly headers: Record<string, string>;
	readonly body: Uint8Array;
} {
	return {
		status: 403,
		headers: { "content-type": "application/json", "x-kantel-egress": "refused", "cache-control": "no-store" },
		body: encoder.encode(`${JSON.stringify(body)}\n`),
	};
}

/** The sandbox's environment variable for a connection's placeholder: `KANTEL_CONNECTION_` and its name in capitals. */
export function placeholderEnvName(name: string, taken: ReadonlySet<string>): string {
	const base = `KANTEL_CONNECTION_${
		name
			.normalize("NFKD")
			.replace(/[^A-Za-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.toUpperCase() || "UNNAMED"
	}`;
	let candidate = base;
	for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}_${n}`;
	return candidate;
}
