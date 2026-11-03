/**
 * How people sign in to Kantel, and who a signed-in call is: the seam the console, the gateways and Kantel Connect
 * share. The implementation is `@kantel/identity` (`./sessions`, `./principal`, `./oauth`); the account and
 * organisation model a person acts in is the compute plane's (`@kantel/compute`: a personal account made the first
 * time they are seen, and organisations they join).
 *
 * - **Accounts.** A person is an identity `User`, found by the sign-in provider's subject (`externalSubjectOf(issuer,
 *   subject)`). GitHub is the provider today (`GITHUB_ISSUER`, subject the GitHub user's numeric ID); Google comes
 *   next, as another `SignInProviderId`. Their personal space is the compute plane's personal account, made on their
 *   first call; organisations and their invite links are the compute plane's too.
 * - **Who may sign in.** Kantel is invite-only, as `IdentityDirectory.signIn` says: someone it knows, or someone an
 *   admin invited by email (`POST /v1/invites`), matched against the emails GitHub has verified for them.
 * - **Sessions.** A sign-in starts a Kantel session: a `kts_` bearer token (only its SHA-256 is kept), 12 hours by
 *   default. Every Kantel API takes it as `Authorization: Bearer kts_…`, and resolves the person again on every call,
 *   so a removed user's session stops working at once.
 * - **The signed-in principal.** `SignedInPerson` is what a gateway route knows of a person once the authenticator has
 *   signed the call in: `signedInPerson(authenticator, identity, request)` in `@kantel/identity/principal` gives it,
 *   or `undefined` for an API key or no sign-in.
 *
 * Over HTTP, on the console's own origin (`/api/auth/…`, beside the API's `/v1/…`):
 *
 * - `GET AUTH_PROVIDERS_PATH`: `AuthProvidersResponse`, the providers this deployment offers and whether each is set up.
 * - `GET authStartPath(provider)?return=<path>`: redirects to the provider. Not set up: back to the
 *   console's sign-in page with `?error=not_configured`.
 * - `GET authCallbackPath(provider)`: the provider's redirect back. Signs the person in and redirects to
 *   `CONSOLE_SIGNED_IN_PATH#token=…&expiresAt=…&return=…` (the fragment never reaches a server or a log), or to
 *   `CONSOLE_SIGN_IN_PATH?error=<SignInError>`.
 * - `POST AUTH_LINK_PATH {token}`: redeems a one-time sign-in link (`ktl_…`, single use, 15 minutes) and answers
 *   `SessionResponse`. The console's `CONSOLE_SIGN_IN_LINK_PATH#ktl_…` page calls it.
 * - `POST AUTH_SESSION_END_PATH` with the session as bearer: ends it (204).
 */
import type { OrganisationId, Timestamp, UserId } from "./common.ts";
import type { AuthenticationMethod, User } from "./identity.ts";

/** A sign-in provider a deployment may offer. Google is the next one; add it here and in `@kantel/identity/oauth`. */
export type SignInProviderId = "github";
export const SIGN_IN_PROVIDERS: readonly SignInProviderId[] = ["github"];

/** The `ExternalIdentity.issuer` of a GitHub sign-in. Its subject is the GitHub user's numeric ID, as a string. */
export const GITHUB_ISSUER = "https://github.com";

/**
 * The `ExternalIdentity.issuer` of a session a one-time sign-in link (`ktl_…`) started. Its subject is the user's ID:
 * an operator with access to the deployment's database (`kantel-admin sign-in-link`) makes a link for a user, by
 * default the deployment's first admin, so a deployment works before any provider is set up. Only Kantel's own
 * sessions name this issuer; `signIn` finds its user by ID and links nothing.
 */
export const SIGN_IN_LINK_ISSUER = "kantel:sign-in-link";

/** Every sign-in link token starts with this. */
export const SIGN_IN_LINK_PREFIX = "ktl_";
/** How long a sign-in link works: 15 minutes. */
export const SIGN_IN_LINK_TTL_MILLISECONDS = 15 * 60 * 1000;

export const AUTH_PROVIDERS_PATH = "/api/auth/providers";
export const authStartPath = (provider: SignInProviderId): string => `/api/auth/${provider}/start`;
export const authCallbackPath = (provider: SignInProviderId): string => `/api/auth/${provider}/callback`;
export const AUTH_LINK_PATH = "/api/auth/link";
export const AUTH_SESSION_END_PATH = "/api/auth/session/end";
/** Every sign-in route is under this, on the console's origin. */
export const AUTH_PATH_PREFIX = "/api/auth/";

/** The console's sign-in page; `?error=` carries a `SignInError`. */
export const CONSOLE_SIGN_IN_PATH = "/sign-in";
/** Where a provider sign-in lands: the session is in the fragment, `#token=…&expiresAt=…&return=…`. */
export const CONSOLE_SIGNED_IN_PATH = "/sign-in/done";
/** A one-time sign-in link's page: `CONSOLE_SIGN_IN_LINK_PATH#ktl_…`. */
export const CONSOLE_SIGN_IN_LINK_PATH = "/sign-in/link";

/**
 * Why a sign-in didn't finish, as the console's sign-in page is told (`?error=`):
 * - `not_configured`: the provider isn't set up on this deployment (no client ID or secret);
 * - `denied`: the person said no at the provider, or the provider refused;
 * - `not_invited`: nobody invited them (or none of the emails the provider verified);
 * - `state`: the sign-in's state didn't match (an old tab, or a forged callback): start again;
 * - `link`: a sign-in link that is unknown, used or expired;
 * - `failed`: anything else, such as the provider being down.
 */
export type SignInError = "not_configured" | "denied" | "not_invited" | "state" | "link" | "failed";
export const SIGN_IN_ERRORS: readonly SignInError[] = [
	"not_configured",
	"denied",
	"not_invited",
	"state",
	"link",
	"failed",
];

export interface SignInProviderStatus {
	readonly id: SignInProviderId;
	/** As a button says it: "GitHub". */
	readonly name: string;
	/** Whether the deployment has the provider's client ID and secret. */
	readonly configured: boolean;
	/** `authStartPath(id)`. */
	readonly startPath: string;
}

export interface AuthProvidersResponse {
	readonly providers: readonly SignInProviderStatus[];
}

/** A started session: what `POST AUTH_LINK_PATH` answers, and what a provider's callback puts in the fragment. */
export interface SessionResponse {
	/** The session token, shown once. Send it as `Authorization: Bearer <token>`. */
	readonly token: string;
	/** When the session ends, in milliseconds since the epoch. */
	readonly expiresAt: Timestamp;
	readonly user: User;
	/** The organisations the user may act in; name one with `ORGANISATION_HEADER` when there is more than one. */
	readonly organisationIds: readonly OrganisationId[];
}

/**
 * A signed-in person, as a gateway route sees them once the authenticator has signed the call in. API keys are not
 * people: they act for a service (identity's `ktk_`) or an account (the compute plane's `ksk_`).
 */
export interface SignedInPerson {
	readonly userId: UserId;
	/** Their name as Kantel keeps it: the provider's name, else their login or email. */
	readonly name: string;
	readonly email?: string;
	/** How they signed in: a Kantel session (`harbour_session`), Access or an OIDC token. */
	readonly method: AuthenticationMethod;
	/** The identity organisation the call acts in. */
	readonly organisationId: OrganisationId;
	/** Whether they are an admin across that organisation: the deployment's super-admin, who adds hosts. */
	readonly admin: boolean;
	/**
	 * The SHA-256 of their Kantel session's token, when they signed in with one: access a relay gives under it ends
	 * when the session does (sign-out, expiry).
	 */
	readonly session?: string;
}
