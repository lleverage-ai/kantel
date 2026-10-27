/**
 * Who a session API request is from. The server takes an injected `Authenticator`; it never decides identity itself.
 *
 * `apiKeyAuthenticator` resolves `Authorization: Bearer <secret>` through `IdentityDirectory.authenticateApiKey`, the
 * identity contract's worker call, so it works with the in-memory identity store now and identity v0 (M1-BE7) once it
 * lands. Human sign-in (Cloudflare Access or OIDC) will be another `Authenticator`.
 */
import { type Authentication, type IdentityDirectory, isHarbourError, systemContext } from "@harbour/contracts";

/** Resolves a request's credential, or `undefined` when it has none or a bad one (the server answers 401). */
export type Authenticator = (request: Request) => Promise<Authentication | undefined>;

/** The bearer token of `Authorization: Bearer <token>`, if any. */
export function bearerToken(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	const match = header === null ? null : /^Bearer\s+(\S+)\s*$/i.exec(header);
	return match?.[1];
}

/** API keys through the identity directory. Unknown, revoked and expired keys are unauthenticated. */
export function apiKeyAuthenticator(identity: Pick<IdentityDirectory, "authenticateApiKey">): Authenticator {
	const ctx = systemContext("session-api");
	return async (request) => {
		const token = bearerToken(request);
		if (token === undefined) return undefined;
		try {
			return await identity.authenticateApiKey(ctx, token);
		} catch (error) {
			if (isHarbourError(error, "forbidden")) return undefined;
			throw error;
		}
	};
}

/** Fixed bearer tokens, for tests and local development only. */
export function staticTokenAuthenticator(tokens: { readonly [token: string]: Authentication }): Authenticator {
	const table = new Map(Object.entries(tokens));
	return async (request) => {
		const token = bearerToken(request);
		return token === undefined ? undefined : table.get(token);
	};
}

/** Tries each authenticator in turn; the first that recognises the request wins. */
export function firstAuthenticator(...authenticators: readonly Authenticator[]): Authenticator {
	return async (request) => {
		for (const authenticate of authenticators) {
			const found = await authenticate(request);
			if (found !== undefined) return found;
		}
		return undefined;
	};
}
