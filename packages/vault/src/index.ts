/**
 * Portable vault logic shared by every target: canonical hashing of proposal terms, binding codes, kind
 * classification, route checks and narrowing. No storage and no clock here.
 */
import {
	type AgentId,
	type ApprovalPair,
	type ApprovalRequest,
	type ApprovalRequestInput,
	HarbourError,
	type HttpMethod,
	MAX_APPROVAL_BODY_BYTES,
	type Narrowing,
	type ProposalKind,
	type ProposalTerms,
	READ_METHODS,
	type RouteScope,
	type SessionId,
} from "@harbour/contracts";

export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** Crockford base32: no I, L, O or U, so a code read aloud or retyped is unambiguous. */
export const BINDING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** JSON with object keys sorted recursively and no whitespace. `undefined` object fields are left out, as in JSON. */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "number":
			return Number.isFinite(value) ? JSON.stringify(value) : "null";
		case "string":
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) {
				return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
			}
			const record = value as { readonly [key: string]: unknown };
			const fields = Object.keys(record)
				.filter((key) => record[key] !== undefined && typeof record[key] !== "function")
				.sort()
				.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
			return `{${fields.join(",")}}`;
		}
		default:
			throw new HarbourError("invalid", `Cannot encode a ${typeof value} as canonical JSON`);
	}
}

async function sha256(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hex SHA-256 of the canonical terms. */
export async function hashTerms(terms: ProposalTerms): Promise<string> {
	return toHex(await sha256(canonicalJson(terms)));
}

/** Six Crockford base32 characters from SHA-256 of `<proposalId>:<termsHash>`, shown as `ABC-DEF`. */
export async function deriveBindingCode(proposalId: string, termsHash: string): Promise<string> {
	const digest = await sha256(`${proposalId}:${termsHash}`);
	let code = "";
	for (let index = 0; index < 6; index += 1) code += BINDING_CODE_ALPHABET[digest[index]! & 31];
	return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/**
 * Hop-by-hop headers: the connection drops them, so they never reach the upstream and are left out of an exact
 * request's digest. Every header that does go out counts, `accept` and `user-agent` included, since an upstream may act
 * on any of them.
 */
export const TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-connection",
	"te",
	"transfer-encoding",
	"upgrade",
]);

function byPair(a: ApprovalPair, b: ApprovalPair): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

/**
 * Freezes an exact request (#333): the URL taken apart (the port written out, the query sorted), the headers that
 * count and the body's hash, and the digest over them with the agent and the session. Rejects with `invalid` for a
 * URL that isn't http(s), or a body too long for a person to read.
 */
export async function freezeRequest(
	input: ApprovalRequestInput,
	who: { readonly agentId: AgentId; readonly sessionId: SessionId },
): Promise<ApprovalRequest> {
	let url: URL;
	try {
		url = new URL(input.url);
	} catch {
		throw new HarbourError("invalid", "The request's URL is not a URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new HarbourError("invalid", "An exact request is an http(s) request");
	}
	if (!HTTP_METHODS.includes(input.method)) throw new HarbourError("invalid", `Unknown method ${String(input.method)}`);
	const body = input.body ?? "";
	const bodyBytes = new TextEncoder().encode(body);
	if (bodyBytes.byteLength > MAX_APPROVAL_BODY_BYTES) {
		throw new HarbourError(
			"invalid",
			`The request's body is ${bodyBytes.byteLength} bytes: at most ${MAX_APPROVAL_BODY_BYTES} can be approved`,
		);
	}
	const scheme = url.protocol === "https:" ? "https" : "http";
	const port = url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port);
	// Exactly as written on the wire, never decoded or reordered: `a+b` and `a%20b` are different requests, and so are
	// `op=read&op=delete` and `op=delete&op=read` to an upstream that takes the first.
	const search = url.search.slice(1);
	const query = search
		.split("&")
		.filter((part) => part.length > 0)
		.map((part): ApprovalPair => {
			const equals = part.indexOf("=");
			return equals < 0 ? { name: part, value: "" } : { name: part.slice(0, equals), value: part.slice(equals + 1) };
		});
	const headers = Object.entries(input.headers ?? {})
		.map(([name, value]): ApprovalPair => ({ name: name.trim().toLowerCase(), value: String(value) }))
		.filter(({ name }) => name.length > 0 && !TRANSPORT_HEADERS.has(name))
		.sort(byPair);
	const bodySha256 = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes)));
	const canonical = {
		v: 1,
		connectionId: input.connectionId,
		connectionVersion: input.connectionVersion,
		agentId: who.agentId,
		sessionId: who.sessionId,
		kind: input.kind,
		...(input.tool === undefined ? {} : { tool: input.tool }),
		method: input.method,
		scheme,
		host: url.hostname.toLowerCase(),
		port,
		path: url.pathname.length === 0 ? "/" : url.pathname,
		search,
		headers,
		bodySha256,
		rulesVersion: input.rulesVersion,
	};
	const digest = toHex(await sha256(canonicalJson(canonical)));
	return {
		connectionId: input.connectionId,
		connectionName: input.connectionName,
		connectionVersion: input.connectionVersion,
		owner: input.owner,
		kind: input.kind,
		...(input.tool === undefined ? {} : { tool: input.tool }),
		method: input.method,
		scheme,
		host: canonical.host,
		port,
		path: canonical.path,
		search,
		query,
		headers,
		...(input.body === undefined ? {} : { body: input.body }),
		bodySha256,
		rulesVersion: input.rulesVersion,
		digest,
	};
}

/** The full URL of a frozen request, query as written. */
export function frozenUrl(request: Pick<ApprovalRequest, "scheme" | "host" | "port" | "path" | "search">): string {
	const url = new URL(`${request.scheme}://${request.host}`);
	if (request.port !== (request.scheme === "https" ? 443 : 80)) url.port = String(request.port);
	url.pathname = request.path;
	return `${url.origin}${url.pathname}${request.search === "" ? "" : `?${request.search}`}`;
}

/**
 * The kind a proposal's terms ask for. `secret` when a value is to be pasted; `request` for an exact request; `route`
 * when more than one use is allowed; `write` when any method is not a read; else `read`.
 */
export function classifyProposal(terms: ProposalTerms): ProposalKind {
	if (terms.secret !== undefined) return "secret";
	if (terms.request !== undefined) return "request";
	const maxUses = terms.lifetime.maxUses;
	if (maxUses === undefined || maxUses > 1) return "route";
	if (terms.route.methods.some((method) => !READ_METHODS.includes(method))) return "write";
	return "read";
}

/** Rejects with `invalid` unless `host` is a bare lower-case host name. */
export function assertValidHost(host: string): void {
	if (host.length === 0 || host !== host.toLowerCase() || /[\s/:@?#]/.test(host)) {
		throw new HarbourError("invalid", `"${host}" is not a lower-case host name`);
	}
}

/** Rejects with `invalid` unless the route has a valid host, known methods and a path prefix starting with `/`. */
export function assertValidRoute(route: RouteScope): void {
	assertValidHost(route.host);
	if (route.methods.length === 0) throw new HarbourError("invalid", "A route needs at least one method");
	for (const method of route.methods) {
		if (!HTTP_METHODS.includes(method)) throw new HarbourError("invalid", `Unknown method ${String(method)}`);
	}
	if (!route.pathPrefix.startsWith("/")) throw new HarbourError("invalid", "A path prefix must start with /");
}

/** Whether `scope` allows `method` to `host` on `path`. */
/** Whether `path` lies under `prefix`, by whole segments: `/repos` covers `/repos/x` but not `/repositories`. */
export function pathUnder(path: string, prefix: string): boolean {
	if (prefix === "" || prefix === "/" || path === prefix) return true;
	const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
	return path.startsWith(base);
}

export function routeAllows(scope: RouteScope, method: HttpMethod, host: string, path: string): boolean {
	return scope.host === host.toLowerCase() && scope.methods.includes(method) && pathUnder(path, scope.pathPrefix);
}

/** Whether everything `inner` allows, `outer` allows too. */
export function routeWithin(inner: RouteScope, outer: RouteScope): boolean {
	return (
		inner.host === outer.host &&
		inner.methods.every((method) => outer.methods.includes(method)) &&
		pathUnder(inner.pathPrefix, outer.pathPrefix)
	);
}

function assertPositiveInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 1) throw new HarbourError("invalid", `${label} must be a positive integer`);
}

/** Applies an approver's narrowing. Anything that would widen the proposed terms rejects with `invalid`. */
export function narrow(terms: ProposalTerms, narrowing: Narrowing | undefined): ProposalTerms {
	if (narrowing === undefined) return terms;
	if (terms.request !== undefined) {
		throw new HarbourError("invalid", "An exact request is approved as it is or denied: narrowing belongs to rules");
	}
	let route = terms.route;
	let lifetime = terms.lifetime;
	if (narrowing.methods !== undefined) {
		if (narrowing.methods.length === 0) throw new HarbourError("invalid", "A narrowing must keep at least one method");
		const widened = narrowing.methods.filter((method) => !terms.route.methods.includes(method));
		if (widened.length > 0) throw new HarbourError("invalid", `Narrowing cannot add ${widened.join(", ")}`);
		route = { ...route, methods: [...narrowing.methods] };
	}
	if (narrowing.pathPrefix !== undefined) {
		if (!narrowing.pathPrefix.startsWith("/") || !pathUnder(narrowing.pathPrefix, terms.route.pathPrefix)) {
			throw new HarbourError("invalid", `Narrowing must keep paths under ${terms.route.pathPrefix}`);
		}
		route = { ...route, pathPrefix: narrowing.pathPrefix };
	}
	if (narrowing.ttlMs !== undefined) {
		assertPositiveInteger(narrowing.ttlMs, "ttlMs");
		if (terms.lifetime.ttlMs !== undefined && narrowing.ttlMs > terms.lifetime.ttlMs) {
			throw new HarbourError("invalid", "Narrowing cannot lengthen the lifetime");
		}
		lifetime = { ...lifetime, ttlMs: narrowing.ttlMs };
	}
	if (narrowing.maxUses !== undefined) {
		assertPositiveInteger(narrowing.maxUses, "maxUses");
		if (terms.lifetime.maxUses !== undefined && narrowing.maxUses > terms.lifetime.maxUses) {
			throw new HarbourError("invalid", "Narrowing cannot allow more uses");
		}
		lifetime = { ...lifetime, maxUses: narrowing.maxUses };
	}
	return { ...terms, route, lifetime };
}

/** A small deterministic generator (FNV-1a seed, mulberry32 steps); only for shuffling decoys, never for secrets. */
function seededRandom(seed: string): () => number {
	let state = 0x811c9dc5;
	for (let index = 0; index < seed.length; index += 1) {
		state ^= seed.charCodeAt(index);
		state = Math.imul(state, 0x01000193);
	}
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

/** The real code plus `decoys` distinct decoys (at least 3), shuffled; the same for the same code and seed. */
export function codeChoices(code: string, seed: string, decoys = 3): string[] {
	const random = seededRandom(`${seed}:${code}`);
	const choices = new Set<string>([code]);
	const wanted = Math.max(3, decoys) + 1;
	while (choices.size < wanted) {
		let decoy = "";
		for (let index = 0; index < 6; index += 1) {
			decoy += BINDING_CODE_ALPHABET[Math.floor(random() * BINDING_CODE_ALPHABET.length)];
		}
		choices.add(`${decoy.slice(0, 3)}-${decoy.slice(3)}`);
	}
	const shuffled = [...choices];
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const other = Math.floor(random() * (index + 1));
		[shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
	}
	return shuffled;
}
