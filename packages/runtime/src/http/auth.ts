/**
 * Who a session API request is from. The server takes the deployment's `Authenticator` (the contract every Harbour
 * API takes, M1-BE7); it never decides identity itself. In production that is `createAuthenticator` from
 * `@harbour/identity/authenticator`, which resolves API keys through `IdentityDirectory.authenticateApiKey`.
 */
import {
	type AuthenticatedCaller,
	type Authentication,
	type Authenticator,
	type AuthenticatorRequest,
	authenticationError,
} from "@harbour/contracts";

/** The bearer token of `Authorization: Bearer <token>`, if any. */
export function bearerToken(request: AuthenticatorRequest): string | undefined {
	const header = request.headers.get("authorization");
	const match = header === null ? null : /^Bearer\s+(\S+)\s*$/i.exec(header);
	return match?.[1];
}

/** Fixed bearer tokens, for tests and local development only. */
export function staticTokenAuthenticator(tokens: { readonly [token: string]: Authentication }): Authenticator {
	const table = new Map(Object.entries(tokens));
	return {
		async authenticate(request) {
			const token = bearerToken(request);
			if (token === undefined) throw authenticationError("missing", "This call needs credentials");
			const found = table.get(token);
			if (found === undefined) throw authenticationError("invalid", "The credentials are not valid");
			return { ...found, method: "api_key" } satisfies AuthenticatedCaller;
		},
	};
}
