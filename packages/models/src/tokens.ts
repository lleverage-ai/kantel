/**
 * Session tokens for the model gateway: `createHmacSessionTokens` implements `ModelSessionTokens` (contracts/models.ts).
 *
 * A token is `hms1.<claims>.<mac>`, both parts base64url: the claims are JSON `{ v, o, p, a, s, exp }` (version,
 * organisation, project, agent, session, expiry in epoch ms) and the mac is HMAC-SHA256 over `hms1.<claims>` with a
 * key only platform services hold. Web Crypto only, so it runs on Workers and Node alike. `mint` and `verify` are
 * worker calls; a token that doesn't verify is `forbidden` and one past its expiry `expired`. The mac is compared in
 * constant time.
 */
import {
	type AuditSink,
	type Clock,
	KantelError,
	type ModelCallScope,
	type ModelSessionTokens,
	requireSystem,
	systemClock,
} from "@kantel/contracts";

const PREFIX = "hms1";
const VERSION = 1;
/** A token lives this long when `mint` names no lifetime. */
export const DEFAULT_SESSION_TOKEN_TTL_MS = 15 * 60_000;
/** The longest lifetime `mint` gives unless the issuer sets `maxTtlMs`. */
export const DEFAULT_SESSION_TOKEN_MAX_TTL_MS = 60 * 60_000;
const MIN_KEY_BYTES = 32;
const INVALID = "The model session token is not valid";

export interface HmacSessionTokensOptions {
	/** The signing key: at least 32 bytes, or a string of at least 32 characters. */
	readonly key: string | Uint8Array;
	readonly clock?: Clock;
	/** Caps every token's lifetime. Default one hour. */
	readonly maxTtlMs?: number;
	/** Where refused worker calls are audited (`access.denied`). */
	readonly audit?: AuditSink;
}

interface Claims {
	readonly v: number;
	readonly o: string;
	/** Absent for an organisation session. */
	readonly p?: string;
	readonly a: string;
	readonly s: string;
	readonly exp: number;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
	try {
		const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return undefined;
	}
}

/** Equal-length byte arrays compared without an early exit. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	let difference = a.length ^ b.length;
	for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ (b[index % b.length] ?? 0);
	return difference === 0;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function assertScope(scope: ModelCallScope): void {
	if (
		typeof scope !== "object" ||
		scope === null ||
		!isNonEmptyString(scope.organisationId) ||
		(scope.projectId !== undefined && !isNonEmptyString(scope.projectId)) ||
		!isNonEmptyString(scope.agentId) ||
		!isNonEmptyString(scope.sessionId)
	) {
		throw new KantelError("invalid", "A model call scope names an organisation, a project, an agent and a session");
	}
}

export function createHmacSessionTokens(options: HmacSessionTokensOptions): ModelSessionTokens {
	const clock = options.clock ?? systemClock;
	const maxTtlMs = options.maxTtlMs ?? DEFAULT_SESSION_TOKEN_MAX_TTL_MS;
	const keyBytes = typeof options.key === "string" ? new TextEncoder().encode(options.key) : options.key;
	if (keyBytes.byteLength < MIN_KEY_BYTES) {
		throw new KantelError("invalid", "A model session token key needs at least 32 bytes");
	}
	if (!Number.isFinite(maxTtlMs) || maxTtlMs <= 0) throw new KantelError("invalid", "maxTtlMs must be positive");
	const key = crypto.subtle.importKey(
		"raw",
		keyBytes as Uint8Array<ArrayBuffer>,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const systemOptions = { ...(options.audit === undefined ? {} : { audit: options.audit }), clock };

	async function mac(signed: string): Promise<Uint8Array> {
		return new Uint8Array(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(signed)));
	}

	return {
		async mint(ctx, scope, ttlMs) {
			await requireSystem(ctx, "models.tokens.mint", systemOptions);
			assertScope(scope);
			const lifetime = Math.min(ttlMs ?? DEFAULT_SESSION_TOKEN_TTL_MS, maxTtlMs);
			if (!Number.isFinite(lifetime) || lifetime <= 0) throw new KantelError("invalid", "ttlMs must be positive");
			const expiresAt = clock.now() + lifetime;
			const claims: Claims = {
				v: VERSION,
				o: scope.organisationId,
				...(scope.projectId === undefined ? {} : { p: scope.projectId }),
				a: scope.agentId,
				s: scope.sessionId,
				exp: expiresAt,
			};
			const signed = `${PREFIX}.${base64url(new TextEncoder().encode(JSON.stringify(claims)))}`;
			return { token: `${signed}.${base64url(await mac(signed))}`, expiresAt };
		},

		async verify(ctx, token) {
			await requireSystem(ctx, "models.tokens.verify", systemOptions);
			const parts = typeof token === "string" ? token.split(".") : [];
			if (parts.length !== 3 || parts[0] !== PREFIX) throw new KantelError("forbidden", INVALID);
			const presented = fromBase64url(parts[2]!);
			const expected = await mac(`${parts[0]}.${parts[1]}`);
			if (presented === undefined || !constantTimeEqual(presented, expected)) {
				throw new KantelError("forbidden", INVALID);
			}
			let claims: Partial<Claims>;
			try {
				claims = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]!))) as Partial<Claims>;
			} catch {
				throw new KantelError("forbidden", INVALID);
			}
			if (
				claims.v !== VERSION ||
				!isNonEmptyString(claims.o) ||
				(claims.p !== undefined && !isNonEmptyString(claims.p)) ||
				!isNonEmptyString(claims.a) ||
				!isNonEmptyString(claims.s) ||
				typeof claims.exp !== "number"
			) {
				throw new KantelError("forbidden", INVALID);
			}
			if (clock.now() >= claims.exp) throw new KantelError("expired", "The model session token has expired");
			return {
				organisationId: claims.o,
				...(claims.p === undefined ? {} : { projectId: claims.p }),
				agentId: claims.a,
				sessionId: claims.s,
			};
		},
	};
}
