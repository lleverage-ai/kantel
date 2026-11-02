/**
 * Human sign-in providers: Cloudflare Access application tokens and OIDC tokens, verified with `jose`. Portable: keys
 * and discovery documents are fetched with an injectable `fetch`, time is read from an injectable clock, and signatures
 * are checked with WebCrypto, so it runs on Workers, Bun and Node.
 *
 * A provider turns a token into an `ExternalIdentity`; `createAuthenticator` turns that into a caller through
 * `IdentityDirectory.signIn`.
 */
import {
	type AuthenticatorRequest,
	authenticationError,
	CLOUDFLARE_ACCESS_HEADER,
	type Clock,
	type ExternalIdentity,
	isKantelError,
	KantelError,
	systemClock,
} from "@kantel/contracts";
import { type CryptoKey, createLocalJWKSet, errors, type JWSHeaderParameters, type JWTPayload, jwtVerify } from "jose";
import { bearerToken } from "./authenticator.ts";
import { isApiKeySecret } from "./index.ts";

/** A configured sign-in provider: where it finds its token in a request, and how it verifies one. */
export interface SignInProvider {
	/** `harbour_session` for Kantel's own sessions (`kantelSessionProvider` in `./otp.ts`). */
	readonly method: "cloudflare_access" | "oidc" | "harbour_session";
	/** The issuer its tokens must name in `iss`. The authenticator picks between providers of one method by it. */
	readonly issuer: string;
	/** The provider's token in `request`, or undefined when there is none. */
	token(request: AuthenticatorRequest): string | undefined;
	/**
	 * The person `token` vouches for. A token that does not verify rejects with `authenticationError("invalid", …)`;
	 * keys or discovery the provider cannot fetch reject with `unavailable`. No error carries the token.
	 */
	verify(token: string): Promise<ExternalIdentity>;
}

/** How long a key or discovery fetch may take before the provider counts as unavailable. */
const FETCH_TIMEOUT_MILLISECONDS = 5_000;

/** How long fetched keys are trusted before they are fetched again. */
export const JWKS_CACHE_MILLISECONDS = 10 * 60 * 1000;
/** The least time between two key fetches caused by tokens naming a key the cached set does not have. */
export const JWKS_COOLDOWN_MILLISECONDS = 30 * 1000;

/** What every OIDC provider accepts unless configured otherwise. */
export const DEFAULT_OIDC_ALGORITHMS: readonly string[] = ["RS256", "ES256", "EdDSA"];
const CLOUDFLARE_ACCESS_ALGORITHMS: readonly string[] = ["RS256"];

const INVALID_MESSAGE = "The credentials are not valid";

type Fetch = typeof fetch;
type KeyResolver = (header: JWSHeaderParameters) => Promise<CryptoKey>;

function unavailable(message: string): KantelError {
	return new KantelError("unavailable", message);
}

async function fetchJson(fetchImpl: Fetch, url: string, what: string): Promise<unknown> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
		});
	} catch {
		throw unavailable(`The sign-in provider's ${what} could not be fetched`);
	}
	if (!response.ok) throw unavailable(`The sign-in provider's ${what} answered ${response.status}`);
	try {
		return await response.json();
	} catch {
		throw unavailable(`The sign-in provider's ${what} is not JSON`);
	}
}

/**
 * Keys from a JWKS endpoint, cached for `JWKS_CACHE_MILLISECONDS`. A token naming a key the set lacks (the provider
 * rotated its keys) refetches once, unless the last fetch was under `JWKS_COOLDOWN_MILLISECONDS` ago. A failed fetch
 * is remembered for the cooldown too, so tokens arriving while the provider is down never fetch more than once per
 * cooldown, with or without cached keys. Loads are single-flight.
 */
function cachedJwks(jwksUri: () => Promise<string>, fetchImpl: Fetch, clock: Clock): KeyResolver {
	type KeySet = ReturnType<typeof createLocalJWKSet>;
	let cached: { readonly keys: KeySet; readonly fetchedAt: number } | undefined;
	let lastFetchAt = Number.NEGATIVE_INFINITY;
	let failure: { readonly error: KantelError; readonly until: number } | undefined;
	let pending: Promise<KeySet> | undefined;

	function load(): Promise<KeySet> {
		if (failure !== undefined && clock.now() < failure.until) return Promise.reject(failure.error);
		pending ??= (async () => {
			try {
				lastFetchAt = clock.now();
				const body = await fetchJson(fetchImpl, await jwksUri(), "keys");
				let keys: KeySet;
				try {
					keys = createLocalJWKSet(body as Parameters<typeof createLocalJWKSet>[0]);
				} catch {
					throw unavailable("The sign-in provider's keys are malformed");
				}
				cached = { keys, fetchedAt: clock.now() };
				failure = undefined;
				return keys;
			} catch (error) {
				const remembered = isKantelError(error, "unavailable")
					? error
					: unavailable("The sign-in provider's keys could not be loaded");
				failure = { error: remembered, until: lastFetchAt + JWKS_COOLDOWN_MILLISECONDS };
				throw remembered;
			} finally {
				pending = undefined;
			}
		})();
		return pending;
	}

	/** The key for `header` from `keys`. Selection failures stay jose's (a bad token); a key that will not import is the provider's fault. */
	async function select(keys: KeySet, header: JWSHeaderParameters): Promise<CryptoKey> {
		try {
			return await keys(header);
		} catch (error) {
			if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) throw error;
			throw unavailable("The sign-in provider's key could not be read");
		}
	}

	return async (header) => {
		const fresh = cached !== undefined && clock.now() - cached.fetchedAt < JWKS_CACHE_MILLISECONDS;
		const keys = fresh && cached !== undefined ? cached.keys : await load();
		try {
			return await select(keys, header);
		} catch (error) {
			if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
			if (clock.now() - lastFetchAt < JWKS_COOLDOWN_MILLISECONDS) throw error;
			return select(await load(), header);
		}
	};
}

interface VerifyOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly algorithms: readonly string[];
	readonly clock: Clock;
	readonly clockToleranceSeconds: number;
	readonly keys: KeyResolver;
}

/** The verified claims of `token`, or `invalid`. Key fetch failures stay `unavailable`. */
async function verifiedClaims(token: string, options: VerifyOptions): Promise<JWTPayload> {
	try {
		const { payload } = await jwtVerify(token, (header) => options.keys(header), {
			issuer: options.issuer,
			audience: options.audience,
			algorithms: [...options.algorithms],
			clockTolerance: options.clockToleranceSeconds,
			currentDate: new Date(options.clock.now()),
			requiredClaims: ["exp"],
		});
		return payload;
	} catch (error) {
		if (isKantelError(error, "unavailable")) throw error;
		throw authenticationError("invalid", INVALID_MESSAGE);
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function checkClockTolerance(seconds: number): number {
	if (!Number.isFinite(seconds) || seconds < 0) {
		throw new KantelError("invalid", "clockToleranceSeconds must be a non-negative number");
	}
	return seconds;
}

export interface CloudflareAccessProviderOptions {
	/** The Access team domain, such as `example.cloudflareaccess.com`, with or without `https://`. */
	readonly teamDomain: string;
	/** The Access application's AUD tag. */
	readonly audience: string;
	readonly fetch?: Fetch;
	readonly clock?: Clock;
	/** Allowed clock skew when checking `exp`, `nbf` and `iat`. Default 0. */
	readonly clockToleranceSeconds?: number;
}

/** `https://<team domain>`, from a team domain given with or without a scheme or trailing slash. */
export function cloudflareAccessIssuer(teamDomain: string): string {
	const host = teamDomain
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/+$/, "");
	if (host === "" || host.includes("/")) throw new KantelError("invalid", "teamDomain must be a host name");
	return `https://${host}`;
}

/**
 * Verifies the Cloudflare Access application token in `Cf-Access-Jwt-Assertion`: RS256, issued by the team domain,
 * for the application's AUD tag, with keys from `<team domain>/cdn-cgi/access/certs`. Access verifies emails at its
 * own identity provider, so the email is verified. A token without a subject or email (a service token) is `invalid`:
 * host apps use API keys.
 */
export function cloudflareAccessProvider(options: CloudflareAccessProviderOptions): SignInProvider {
	const issuer = cloudflareAccessIssuer(options.teamDomain);
	if (options.audience === "") throw new KantelError("invalid", "audience must be the Access application's AUD tag");
	const clock = options.clock ?? systemClock;
	const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const certs = `${issuer}/cdn-cgi/access/certs`;
	const verifyOptions: VerifyOptions = {
		issuer,
		audience: options.audience,
		algorithms: CLOUDFLARE_ACCESS_ALGORITHMS,
		clock,
		clockToleranceSeconds: checkClockTolerance(options.clockToleranceSeconds ?? 0),
		keys: cachedJwks(async () => certs, fetchImpl, clock),
	};
	return {
		method: "cloudflare_access",
		issuer,
		token(request) {
			const token = request.headers.get(CLOUDFLARE_ACCESS_HEADER)?.trim();
			return token === undefined || token === "" ? undefined : token;
		},
		async verify(token) {
			const claims = await verifiedClaims(token, verifyOptions);
			const subject = nonEmptyString(claims.sub);
			const email = nonEmptyString(claims.email);
			if (subject === undefined || email === undefined) throw authenticationError("invalid", INVALID_MESSAGE);
			const name = nonEmptyString(claims.name);
			return { issuer, subject, email, emailVerified: true, ...(name === undefined ? {} : { name }) };
		},
	};
}

export interface OidcProviderOptions {
	/** The issuer URL, compared exactly with discovery's `issuer` and each token's `iss`. */
	readonly issuer: string;
	/** The client ID tokens must name in `aud`. */
	readonly audience: string;
	/** The JWKS URL. When absent, discovery at `<issuer>/.well-known/openid-configuration` names it. */
	readonly jwksUri?: string;
	/** Allowed signing algorithms; default `DEFAULT_OIDC_ALGORITHMS`. `none` and HMAC (`HS*`) are never allowed. */
	readonly algorithms?: readonly string[];
	readonly fetch?: Fetch;
	readonly clock?: Clock;
	/** Allowed clock skew when checking `exp`, `nbf` and `iat`. Default 0. */
	readonly clockToleranceSeconds?: number;
	/** The discovery document URL, when it is not `<issuer>/.well-known/openid-configuration`. */
	readonly discovery?: string;
}

/**
 * Verifies an OIDC token sent as `Authorization: Bearer <JWT>` (any bearer not starting with `ktk_`): issued exactly
 * by `issuer`, for `audience`, signed with an allowed algorithm by a key from the JWKS. Discovery is fetched once and
 * must name the same issuer. The email is verified only when the `email_verified` claim says so.
 */
export function oidcProvider(options: OidcProviderOptions): SignInProvider {
	const { issuer } = options;
	if (issuer === "") throw new KantelError("invalid", "issuer must be the OIDC issuer URL");
	if (options.audience === "") throw new KantelError("invalid", "audience must be the OIDC client ID");
	const algorithms = options.algorithms ?? DEFAULT_OIDC_ALGORITHMS;
	if (algorithms.length === 0 || algorithms.some((algorithm) => algorithm === "none" || /^HS/i.test(algorithm))) {
		throw new KantelError("invalid", "algorithms must be asymmetric: none and HS* are never allowed");
	}
	const clock = options.clock ?? systemClock;
	const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
	const discoveryUrl = options.discovery ?? `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

	let discovered: Promise<string> | undefined;
	function discoverJwksUri(): Promise<string> {
		discovered ??= (async () => {
			const document = await fetchJson(fetchImpl, discoveryUrl, "discovery document");
			const fields = (typeof document === "object" && document !== null ? document : {}) as {
				issuer?: unknown;
				jwks_uri?: unknown;
			};
			if (fields.issuer !== issuer) throw unavailable("The sign-in provider's discovery document names another issuer");
			if (typeof fields.jwks_uri !== "string" || fields.jwks_uri === "") {
				throw unavailable("The sign-in provider's discovery document names no keys");
			}
			return fields.jwks_uri;
		})().catch((error: unknown) => {
			discovered = undefined;
			throw error;
		});
		return discovered;
	}

	const { jwksUri } = options;
	const verifyOptions: VerifyOptions = {
		issuer,
		audience: options.audience,
		algorithms,
		clock,
		clockToleranceSeconds: checkClockTolerance(options.clockToleranceSeconds ?? 0),
		keys: cachedJwks(jwksUri === undefined ? discoverJwksUri : async () => jwksUri, fetchImpl, clock),
	};
	return {
		method: "oidc",
		issuer,
		token(request) {
			const token = bearerToken(request);
			return token === undefined || isApiKeySecret(token) ? undefined : token;
		},
		async verify(token) {
			const claims = await verifiedClaims(token, verifyOptions);
			const subject = nonEmptyString(claims.sub);
			if (subject === undefined) throw authenticationError("invalid", INVALID_MESSAGE);
			const email = nonEmptyString(claims.email);
			const name = nonEmptyString(claims.name);
			return {
				issuer,
				subject,
				...(email === undefined ? {} : { email }),
				emailVerified: claims.email_verified === true || claims.email_verified === "true",
				...(name === undefined ? {} : { name }),
			};
		},
	};
}
