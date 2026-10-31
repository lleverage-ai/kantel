/**
 * Connection placeholders in a sandbox's own requests (#331): finding them, finding raw secrets, and swapping a
 * placeholder for its connection's credential. Pure: the connections service (`sandboxEgress`) decides whether a
 * request may have the credential at all, and this only rewrites it.
 *
 * - **Where a placeholder is looked for:** every header, the path and the query (as written, and percent-decoded), and
 *   a body up to `EGRESS_BODY_LIMIT`.
 * - **Where it is replaced:** headers, the path and the query always; a body only when the connection's template allows
 *   it, and then only a JSON or form body, with the credential escaped for it (JSON string escaping, or form encoding).
 * - **The standard header:** a header holding the placeholder alone, where the connection's credential goes
 *   (`Authorization` for OAuth), gets the standard form, such as `Bearer <token>`.
 */
import {
	CONNECTION_PLACEHOLDER_PATTERN,
	CONNECTION_PLACEHOLDER_PREFIX,
	EGRESS_BODY_LIMIT,
	type SandboxEgressRequest,
} from "@kantel/contracts";

/** A new placeholder: random, never derived from a value, an ID or an earlier placeholder. */
export function newConnectionPlaceholder(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return `${CONNECTION_PLACEHOLDER_PREFIX}${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const ALL = new RegExp(CONNECTION_PLACEHOLDER_PATTERN.source, "g");

function placeholdersIn(text: string): string[] {
	return text.match(ALL) ?? [];
}

function decoded(text: string): string {
	try {
		return decodeURIComponent(text.replaceAll("+", " "));
	} catch {
		return text;
	}
}

/** The body as text, when it is short enough to read. Undefined for none, or one too long. */
export function bodyText(request: SandboxEgressRequest): string | undefined {
	const body = request.body;
	if (body === undefined || body.byteLength === 0 || body.byteLength > EGRESS_BODY_LIMIT) return undefined;
	return new TextDecoder().decode(body);
}

export interface FoundPlaceholders {
	/** Every distinct placeholder, wherever it was. */
	readonly all: ReadonlySet<string>;
	/** Those in the body (read only up to the limit). */
	readonly inBody: ReadonlySet<string>;
}

/** The placeholders a request carries. */
export function findPlaceholders(request: SandboxEgressRequest): FoundPlaceholders {
	const all = new Set<string>();
	const inBody = new Set<string>();
	for (const value of Object.values(request.headers)) for (const found of placeholdersIn(value)) all.add(found);
	let url: URL | undefined;
	try {
		url = new URL(request.url);
	} catch {
		url = undefined;
	}
	const where = url === undefined ? request.url : `${url.pathname}${url.search}`;
	for (const found of [...placeholdersIn(where), ...placeholdersIn(decoded(where))]) all.add(found);
	const text = bodyText(request);
	if (text !== undefined) {
		for (const found of [...placeholdersIn(text), ...placeholdersIn(decoded(text))]) {
			all.add(found);
			inBody.add(found);
		}
	}
	return { all, inBody };
}

/** A `Basic` credential's decoded `user:password`, so a raw key inside one is found too. */
function basicDecoded(value: string): string | undefined {
	const match = /^\s*basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(value);
	if (match === null) return undefined;
	try {
		return new TextDecoder().decode(Uint8Array.from(atob(match[1]!), (char) => char.charCodeAt(0)));
	} catch {
		return undefined;
	}
}

/** The texts a raw secret is looked for in: headers (a Basic credential decoded), the URL and the body up to the limit. */
export function secretHaystack(request: SandboxEgressRequest): string[] {
	const texts: string[] = [];
	for (const value of Object.values(request.headers)) {
		texts.push(value);
		const basic = basicDecoded(value);
		if (basic !== undefined) texts.push(basic);
	}
	texts.push(request.url, decoded(request.url));
	const text = bodyText(request);
	if (text !== undefined) texts.push(text);
	return texts;
}

/** Whether a body is JSON or a form, by its content type: the only bodies a placeholder is replaced in. */
export function bodyKind(headers: { readonly [name: string]: string }): "json" | "form" | undefined {
	const type = (headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
	if (type === "application/json" || type.endsWith("+json")) return "json";
	if (type === "application/x-www-form-urlencoded") return "form";
	return undefined;
}

export interface Replacement {
	readonly url: string;
	readonly headers: { readonly [name: string]: string };
	readonly body?: Uint8Array;
	/** Every form of the credential that went out, to cut out of the answer. */
	readonly redact: readonly string[];
}

/**
 * The request with `placeholder` replaced by `value`: in every header (the standard header's form where it holds the
 * placeholder alone), the path and the query (percent-encoded), and the body when `body` allows it (escaped for JSON or
 * form). The caller has checked a body placeholder is allowed and the body is one of those kinds.
 */
export function replacePlaceholder(
	request: SandboxEgressRequest,
	placeholder: string,
	value: string,
	options: {
		/** Where the connection's credential goes, and its standard form there. */
		readonly standard?: { readonly header: string; readonly value: string };
		readonly body?: "json" | "form";
	},
): Replacement {
	const redact = new Set<string>([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
	const headers: { [name: string]: string } = {};
	for (const [name, current] of Object.entries(request.headers)) {
		if (!current.includes(placeholder)) {
			headers[name] = current;
			continue;
		}
		const standard = options.standard;
		const sent =
			standard !== undefined && name === standard.header.toLowerCase() && current.trim() === placeholder
				? standard.value
				: current.split(placeholder).join(value);
		headers[name] = sent;
		redact.add(sent);
		const space = sent.indexOf(" ");
		if (space > 0) redact.add(sent.slice(space + 1));
	}
	const url = request.url.split(placeholder).join(encodeURIComponent(value));
	let body = request.body;
	if (options.body !== undefined && body !== undefined && body.byteLength <= EGRESS_BODY_LIMIT) {
		const text = new TextDecoder().decode(body);
		if (text.includes(placeholder)) {
			const escaped = options.body === "json" ? JSON.stringify(value).slice(1, -1) : encodeURIComponent(value);
			body = new TextEncoder().encode(text.split(placeholder).join(escaped));
		}
	}
	return { url, headers, ...(body === undefined ? {} : { body }), redact: [...redact].filter((s) => s.length >= 8) };
}
