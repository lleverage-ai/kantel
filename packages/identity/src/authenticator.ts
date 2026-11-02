/**
 * The authenticator every Kantel API takes, and a Fetch-style middleware around it. Portable: it reads only request
 * headers and uses only globals, so it runs on Workers, Bun and Node.
 *
 * Host apps authenticate with API keys. People sign in through the `SignInProvider`s a deployment configures
 * (`@kantel/identity/jwt`): a Cloudflare Access token, an OIDC token, or both; self-hosted, a Kantel session from
 * email one-time PIN sign-in (`@kantel/identity/otp`).
 */
import {
	type AuthenticatedCaller,
	type AuthenticationFailure,
	type Authenticator,
	type AuthenticatorRequest,
	authenticationError,
	authenticationFailureOf,
	type IdentityDirectory,
	isKantelError,
	KantelError,
	ORGANISATION_HEADER,
	type OrganisationId,
	readHeader,
	type SignIn,
	systemContext,
} from "@kantel/contracts";
import { decodeJwt } from "jose";
import { isApiKeySecret } from "./index.ts";
import type { SignInProvider } from "./jwt.ts";
import { isSessionToken } from "./otp.ts";
import { registerSignedIn, type SignedIn } from "./signed-in.ts";

/** The authenticator resolves keys and sign-ins as itself: `authenticateApiKey` and `signIn` are worker calls. */
const AUTHENTICATOR_CONTEXT = systemContext("authenticator");

const INVALID_MESSAGE = "The credentials are not valid";

export interface AuthenticatorOptions {
	/** Resolves API keys and, when `providers` are given, signed-in people. */
	readonly identity: Pick<IdentityDirectory, "authenticateApiKey"> & Partial<Pick<IdentityDirectory, "signIn">>;
	/** The sign-in providers people may use. None means API keys only. */
	readonly providers?: readonly SignInProvider[];
}

/** The bearer token in an `Authorization` header, or undefined when there is none. Malformed headers are `invalid`. */
export function bearerToken(request: AuthenticatorRequest): string | undefined {
	const header = request.headers.get("authorization");
	if (header === null || header.trim() === "") return undefined;
	const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header);
	if (match?.[1] === undefined) throw authenticationError("invalid", "The Authorization header must be a bearer token");
	return match[1];
}

/**
 * Which of `providers` (all of one method) verifies `token`: the only one, or the one whose issuer the token's
 * unverified `iss` names. The claim only picks a provider; the provider then verifies it.
 */
function providerFor(providers: readonly SignInProvider[], token: string): SignInProvider {
	if (providers.length === 1 && providers[0] !== undefined) return providers[0];
	let issuer: unknown;
	try {
		issuer = decodeJwt(token).iss;
	} catch {
		throw authenticationError("invalid", INVALID_MESSAGE);
	}
	const provider = providers.find((candidate) => candidate.issuer === issuer);
	if (provider === undefined) throw authenticationError("invalid", INVALID_MESSAGE);
	return provider;
}

/** The organisation a signed-in person acts in: the one they name, or their only one. */
function organisationFor(request: AuthenticatorRequest, organisationIds: readonly OrganisationId[]): OrganisationId {
	const named = readHeader(request.headers, ORGANISATION_HEADER)?.trim();
	if (named !== undefined && named !== "") {
		if (organisationIds.includes(named)) return named;
		throw authenticationError("organisation", "You may not act in this organisation");
	}
	const [only] = organisationIds;
	if (organisationIds.length === 1 && only !== undefined) return only;
	throw authenticationError("organisation", `Name the organisation to act in with the ${ORGANISATION_HEADER} header`);
}

export function createAuthenticator(options: AuthenticatorOptions): Authenticator {
	const { identity } = options;
	const providers = options.providers ?? [];
	const signIn = identity.signIn?.bind(identity);
	if (providers.length > 0 && signIn === undefined) {
		throw new KantelError("invalid", "An authenticator with sign-in providers needs an identity directory with signIn");
	}
	const accessProviders = providers.filter((provider) => provider.method === "cloudflare_access");
	const oidcProviders = providers.filter((provider) => provider.method === "oidc");
	const sessionProviders = providers.filter((provider) => provider.method === "harbour_session");

	async function human(candidates: readonly SignInProvider[], token: string): Promise<SignedIn> {
		const provider = providerFor(candidates, token);
		const external = await provider.verify(token);
		if (signIn === undefined) throw authenticationError("invalid", INVALID_MESSAGE);
		let signedIn: SignIn;
		try {
			signedIn = await signIn(AUTHENTICATOR_CONTEXT, external);
		} catch (error) {
			if (isKantelError(error, "forbidden")) throw authenticationError("invalid", INVALID_MESSAGE);
			throw error;
		}
		return {
			method: provider.method,
			actor: { kind: "human", userId: signedIn.user.id },
			organisationIds: signedIn.organisationIds,
		};
	}

	/**
	 * The person a request's credentials name, with every organisation they may act in; undefined for an API key (the
	 * bearer `apiKey` is then the key). Missing or invalid credentials throw as `authenticate` does.
	 */
	async function person(request: AuthenticatorRequest): Promise<{ person?: SignedIn; apiKey?: string }> {
		// An API key comes first: a host app behind Cloudflare Access may also carry an Access service token.
		const token = bearerToken(request);
		// A Kantel session is a bearer of its own shape, so it never reaches a JWT provider.
		if (token !== undefined && isSessionToken(token)) {
			if (sessionProviders.length === 0) throw authenticationError("invalid", INVALID_MESSAGE);
			return { person: await human(sessionProviders, token) };
		}
		if (token === undefined || !isApiKeySecret(token)) {
			const accessToken = accessProviders[0]?.token(request);
			if (accessToken !== undefined) return { person: await human(accessProviders, accessToken) };
			if (token === undefined) throw authenticationError("missing", "This call needs credentials");
			if (oidcProviders.length === 0) throw authenticationError("invalid", INVALID_MESSAGE);
			return { person: await human(oidcProviders, token) };
		}
		return { apiKey: token };
	}

	const authenticator: Authenticator = {
		async authenticate(request) {
			const { person: signedIn, apiKey: token = "" } = await person(request);
			if (signedIn !== undefined) {
				return {
					method: signedIn.method,
					actor: signedIn.actor,
					organisationId: organisationFor(request, signedIn.organisationIds),
				};
			}
			try {
				const authentication = await identity.authenticateApiKey(AUTHENTICATOR_CONTEXT, token);
				return { ...authentication, method: "api_key" } satisfies AuthenticatedCaller;
			} catch (error) {
				if (isKantelError(error, "forbidden")) throw authenticationError("invalid", INVALID_MESSAGE);
				throw error;
			}
		},
	};
	registerSignedIn(authenticator, async (request) => (await person(request)).person);
	return authenticator;
}

const STATUS: Record<AuthenticationFailure, number> = { missing: 401, invalid: 401, organisation: 403 };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...headers },
	});
}

/**
 * The response for an authentication failure: 401 with a `WWW-Authenticate` challenge for missing or invalid
 * credentials, 403 for an organisation the caller may not act in. Undefined for any other error, which the API maps
 * itself. The body never echoes the credential.
 */
export function authenticationFailureResponse(error: unknown): Response | undefined {
	const failure = authenticationFailureOf(error);
	if (failure === undefined) return undefined;
	const message = isKantelError(error) ? error.message : "Authentication failed";
	const challenge: Record<string, string> =
		failure === "organisation" ? {} : { "www-authenticate": `Bearer realm="kantel"` };
	return json(
		STATUS[failure],
		{ error: { code: failure === "organisation" ? "forbidden" : "unauthenticated", failure, message } },
		challenge,
	);
}

export type AuthenticatedHandler = (request: Request, caller: AuthenticatedCaller) => Response | Promise<Response>;

/**
 * Wraps a Fetch-style handler so it runs only for an authenticated caller. Authentication failures become 401 or
 * 403 responses; anything else the authenticator throws (a directory that is down) propagates to the API's own
 * error handling.
 */
export function withAuthentication(
	authenticator: Authenticator,
	handler: AuthenticatedHandler,
): (request: Request) => Promise<Response> {
	return async (request) => {
		let caller: AuthenticatedCaller;
		try {
			caller = await authenticator.authenticate(request);
		} catch (error) {
			const response = authenticationFailureResponse(error);
			if (response !== undefined) return response;
			throw error;
		}
		return handler(request, caller);
	};
}
