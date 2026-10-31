/**
 * Who a person's credentials name, before an organisation is chosen: the person and every organisation they may act
 * in. `authenticate` settles on one organisation (the one the request names, or their only one) and refuses a person
 * in several who names none; the identity API's `GET /v1/organisations` needs the whole list, for the console to
 * offer the others. An authenticator `createAuthenticator` makes registers how it reads this here, so the identity
 * handler can ask it without a change to the `Authenticator` contract. Kept apart from `./authenticator.ts`, so the
 * HTTP client the browser loads doesn't bring in its JWT verification.
 */
import type {
	Actor,
	AuthenticationMethod,
	Authenticator,
	AuthenticatorRequest,
	OrganisationId,
} from "@kantel/contracts";

/** A signed-in person and every organisation they may act in, in no particular order. */
export interface SignedIn {
	readonly method: AuthenticationMethod;
	readonly actor: Actor;
	readonly organisationIds: readonly OrganisationId[];
}

/** Reads a request's person; undefined for credentials that aren't a person's (an API key acts in one organisation). */
export type SignedInReader = (request: AuthenticatorRequest) => Promise<SignedIn | undefined>;

const readers = new WeakMap<Authenticator, SignedInReader>();

/** Registers how `authenticator` reads a request's person. */
export function registerSignedIn(authenticator: Authenticator, read: SignedInReader): void {
	readers.set(authenticator, read);
}

/** How `authenticator` reads a request's person, or undefined when it can't (one `createAuthenticator` didn't make). */
export function signedInReaderOf(authenticator: Authenticator): SignedInReader | undefined {
	return readers.get(authenticator);
}
