/**
 * Local stand-ins for sign-in providers, for tests: an OIDC identity provider and a Cloudflare Access team. Each
 * signs tokens with real keys, publishes them as a JWKS, and answers requests through its own `fetch`, so a provider
 * from `@harbour/identity/jwt` verifies them without a network. Portable (WebCrypto through `jose`), so suites on
 * Workers, Bun and Node can use them.
 */
import { type Clock, systemClock } from "@harbour/contracts";
import { type CryptoKey, exportJWK, generateKeyPair, type JWK, type JWTHeaderParameters, SignJWT } from "jose";
import { cloudflareAccessIssuer } from "./jwt.ts";

/** The algorithms a mock provider can sign with. */
export type MockSigningAlgorithm = "RS256" | "ES256" | "EdDSA";

export interface MockSignOptions {
	/** The `kid` header; default the signing key's own. */
	readonly kid?: string;
	/** Lifetime from the clock's now; default 300. */
	readonly expiresInSeconds?: number;
	/** Sign with the provider's key for this algorithm (created and published on first use); default its algorithm. */
	readonly algorithm?: MockSigningAlgorithm;
	/** Extra protected header parameters. */
	readonly header?: Partial<JWTHeaderParameters>;
}

export interface MockJwks {
	readonly keys: readonly JWK[];
}

interface MockSigner {
	readonly issuer: string;
	readonly audience: string;
	/** The published keys: every current key, and rotated ones until `removeOld()`. */
	jwks(): MockJwks;
	/**
	 * A signed token. `iss`, `aud`, `sub`, `iat` and `exp` default from the provider and its clock; `claims` override
	 * them, and a claim set to `undefined` is left out (so `{ exp: undefined }` signs a token without `exp`).
	 */
	sign(claims?: Readonly<Record<string, unknown>>, options?: MockSignOptions): Promise<string>;
	/** Replaces each signing key with a new one under a new `kid`. The old keys stay published until `removeOld()`. */
	rotate(): Promise<void>;
	/** Stops publishing keys replaced by `rotate()`. */
	removeOld(): void;
	/** Answers the provider's well-known URLs with JSON, and anything else with 404. */
	readonly fetch: typeof fetch;
}

export interface MockIdp extends MockSigner {
	/** The discovery document served at `<issuer>/.well-known/openid-configuration`. */
	discovery(): { readonly issuer: string; readonly jwks_uri: string; readonly [field: string]: unknown };
}

export interface MockAccess extends MockSigner {
	readonly teamDomain: string;
}

interface SigningKey {
	readonly kid: string;
	readonly algorithm: MockSigningAlgorithm;
	readonly privateKey: CryptoKey;
	readonly publicJwk: JWK;
	retired: boolean;
}

interface SignerOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly defaultAudience: string | readonly string[];
	readonly algorithm: MockSigningAlgorithm;
	readonly clock: Clock;
	/** The JSON documents `fetch` serves, by URL, given the published keys. */
	readonly documents: (jwks: () => MockJwks) => Readonly<Record<string, () => unknown>>;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function createSigner(options: SignerOptions): MockSigner {
	const keys: SigningKey[] = [];
	let counter = 0;

	async function newKey(algorithm: MockSigningAlgorithm): Promise<SigningKey> {
		counter += 1;
		const kid = `${algorithm.toLowerCase()}-${counter}`;
		const { privateKey, publicKey } = await generateKeyPair(algorithm);
		const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: algorithm, use: "sig" };
		const key: SigningKey = { kid, algorithm, privateKey, publicJwk, retired: false };
		keys.push(key);
		return key;
	}

	async function current(algorithm: MockSigningAlgorithm): Promise<SigningKey> {
		return keys.find((key) => key.algorithm === algorithm && !key.retired) ?? newKey(algorithm);
	}

	const jwks = (): MockJwks => ({ keys: keys.map((key) => ({ ...key.publicJwk })) });
	const documents = options.documents(jwks);

	return {
		issuer: options.issuer,
		audience: options.audience,
		jwks,
		async sign(claims = {}, signOptions = {}) {
			const key = await current(signOptions.algorithm ?? options.algorithm);
			const now = Math.floor(options.clock.now() / 1000);
			const payload: Record<string, unknown> = {
				iss: options.issuer,
				aud: options.defaultAudience,
				sub: "user-1",
				iat: now,
				exp: now + (signOptions.expiresInSeconds ?? 300),
				...claims,
			};
			for (const [name, value] of Object.entries(payload)) if (value === undefined) delete payload[name];
			return new SignJWT(payload)
				.setProtectedHeader({
					alg: key.algorithm,
					typ: "JWT",
					...signOptions.header,
					kid: signOptions.kid ?? key.kid,
				})
				.sign(key.privateKey);
		},
		async rotate() {
			const algorithms = [...new Set(keys.filter((key) => !key.retired).map((key) => key.algorithm))];
			if (algorithms.length === 0) algorithms.push(options.algorithm);
			for (const key of keys) key.retired = true;
			for (const algorithm of algorithms) await newKey(algorithm);
		},
		removeOld() {
			for (let index = keys.length - 1; index >= 0; index -= 1) if (keys[index]?.retired) keys.splice(index, 1);
		},
		async fetch(input) {
			const document = documents[urlOf(input)];
			if (document === undefined) return new Response("Not found", { status: 404 });
			return Response.json(document());
		},
	};
}

/**
 * A local OIDC identity provider at `issuer`, for `audience` (the client ID). It signs with RS256 by default, serves
 * discovery at `<issuer>/.well-known/openid-configuration` and keys at `<issuer>/.well-known/jwks.json` through
 * `fetch`, and reads time from `clock`.
 */
export function createMockIdp(options: {
	readonly issuer: string;
	readonly audience: string;
	readonly algorithm?: "RS256" | "ES256";
	readonly clock?: Clock;
}): MockIdp {
	const base = options.issuer.replace(/\/+$/, "");
	const algorithm = options.algorithm ?? "RS256";
	const discovery = () => ({
		issuer: options.issuer,
		jwks_uri: `${base}/.well-known/jwks.json`,
		id_token_signing_alg_values_supported: [algorithm],
		response_types_supported: ["code"],
		subject_types_supported: ["public"],
	});
	const signer = createSigner({
		issuer: options.issuer,
		audience: options.audience,
		defaultAudience: options.audience,
		algorithm,
		clock: options.clock ?? systemClock,
		documents: (jwks) => ({
			[`${base}/.well-known/openid-configuration`]: discovery,
			[`${base}/.well-known/jwks.json`]: jwks,
		}),
	});
	return { ...signer, discovery };
}

/**
 * A local Cloudflare Access team at `teamDomain`, for the application with AUD tag `audience`. Its tokens are RS256,
 * issued by `https://<teamDomain>` for `[audience]`, and its keys are served at `/cdn-cgi/access/certs` through
 * `fetch`. Pass `email` in the claims as Access does; leave it out (and set `common_name`) for a service token.
 */
export function createMockAccess(options: {
	readonly teamDomain: string;
	readonly audience: string;
	readonly clock?: Clock;
}): MockAccess {
	const issuer = cloudflareAccessIssuer(options.teamDomain);
	const signer = createSigner({
		issuer,
		audience: options.audience,
		defaultAudience: [options.audience],
		algorithm: "RS256",
		clock: options.clock ?? systemClock,
		documents: (jwks) => ({ [`${issuer}/cdn-cgi/access/certs`]: jwks }),
	});
	return { ...signer, teamDomain: new URL(issuer).host };
}
