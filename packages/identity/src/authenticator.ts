/**
 * The authenticator every Harbour API takes, and a Fetch-style middleware around it. Portable: it reads only request
 * headers and uses only globals, so it runs on Workers, Bun and Node.
 *
 * This first version authenticates host apps' API keys. Human sign-in (Cloudflare Access and OIDC) plugs in through
 * `AuthenticatorOptions` in a later change without changing the `Authenticator` contract.
 */
import {
	type AuthenticatedCaller,
	type AuthenticationFailure,
	type Authenticator,
	type AuthenticatorRequest,
	authenticationError,
	authenticationFailureOf,
	type IdentityDirectory,
	isHarbourError,
	systemContext,
} from "@harbour/contracts";
import { API_KEY_SECRET_PREFIX } from "./index.ts";

/** The authenticator resolves keys as itself: `authenticateApiKey` is a worker call. */
const AUTHENTICATOR_CONTEXT = systemContext("authenticator");

export interface AuthenticatorOptions {
	/** Resolves API keys. */
	readonly identity: Pick<IdentityDirectory, "authenticateApiKey">;
}

/** The bearer token in an `Authorization` header, or undefined when there is none. Malformed headers are `invalid`. */
export function bearerToken(request: AuthenticatorRequest): string | undefined {
	const header = request.headers.get("authorization");
	if (header === null || header.trim() === "") return undefined;
	const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header);
	if (match?.[1] === undefined) throw authenticationError("invalid", "The Authorization header must be a bearer token");
	return match[1];
}

export function createAuthenticator(options: AuthenticatorOptions): Authenticator {
	return {
		async authenticate(request) {
			const token = bearerToken(request);
			if (token === undefined) throw authenticationError("missing", "This call needs credentials");
			if (!token.startsWith(API_KEY_SECRET_PREFIX)) {
				throw authenticationError("invalid", "The credentials are not valid");
			}
			try {
				const authentication = await options.identity.authenticateApiKey(AUTHENTICATOR_CONTEXT, token);
				return { ...authentication, method: "api_key" } satisfies AuthenticatedCaller;
			} catch (error) {
				if (isHarbourError(error, "forbidden")) throw authenticationError("invalid", "The credentials are not valid");
				throw error;
			}
		},
	};
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
	const message = isHarbourError(error) ? error.message : "Authentication failed";
	const challenge: Record<string, string> =
		failure === "organisation" ? {} : { "www-authenticate": `Bearer realm="harbour"` };
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
