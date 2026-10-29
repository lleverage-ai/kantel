/**
 * Identity and tenancy. Organisations own projects; users and service identities hold a role per project (or across
 * the organisation); host apps call with API keys scoped to projects. Every call resolves to an `Actor`.
 */
import {
	type Actor,
	type ApiKeyId,
	type CallContext,
	HarbourError,
	isHarbourError,
	type OrganisationId,
	type Page,
	type PageRequest,
	type ProjectId,
	type ServiceId,
	type SystemContext,
	type Timestamp,
	type UserId,
} from "./common.ts";

/** Roles, weakest first. Each includes what the ones before it may do. */
export type Role = "viewer" | "operator" | "admin";
export const ROLES: readonly Role[] = ["viewer", "operator", "admin"];

/** Whether `held` includes `needed`. */
export function roleSatisfies(held: Role, needed: Role): boolean {
	return ROLES.indexOf(held) >= ROLES.indexOf(needed);
}

export interface Organisation {
	readonly id: OrganisationId;
	readonly name: string;
	readonly createdAt: Timestamp;
}

export interface Project {
	readonly id: ProjectId;
	readonly organisationId: OrganisationId;
	readonly name: string;
	readonly createdAt: Timestamp;
}

export interface User {
	readonly id: UserId;
	readonly name: string;
	readonly email?: string;
	/** The subject at the sign-in provider (Cloudflare Access or OIDC). */
	readonly externalSubject?: string;
	readonly createdAt: Timestamp;
}

/** A host app (Sal's supervisor, Lleverage) acting inside one organisation. */
export interface ServiceIdentity {
	readonly id: ServiceId;
	readonly organisationId: OrganisationId;
	readonly name: string;
	readonly createdAt: Timestamp;
}

export type Principal =
	| { readonly kind: "user"; readonly userId: UserId }
	| { readonly kind: "service"; readonly serviceId: ServiceId };

/** A role held by a principal on one project, or on every project of the organisation when `projectId` is absent. */
export interface RoleBinding {
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly principal: Principal;
	readonly role: Role;
	readonly grantedAt: Timestamp;
	readonly grantedBy: Actor;
}

/** An API key's record. The secret is never stored or returned after issue; only its prefix is. */
export interface ApiKey {
	readonly id: ApiKeyId;
	readonly serviceId: ServiceId;
	readonly organisationId: OrganisationId;
	/** The only projects this key may act in. */
	readonly projectIds: readonly ProjectId[];
	readonly role: Role;
	/** What the key may do beyond its role on its projects (`API_KEY_PERMISSIONS`). Absent: nothing more. */
	readonly permissions?: readonly ApiKeyPermission[];
	readonly prefix: string;
	/** What the key is for, as its issuer named it ("Sal's supervisor"). Absent on keys issued without one. */
	readonly name?: string;
	readonly createdAt: Timestamp;
	/** When the key last signed a call in, to within `API_KEY_LAST_USED_PRECISION_MS`. Absent until its first use. */
	readonly lastUsedAt?: Timestamp;
	readonly expiresAt?: Timestamp;
	readonly revokedAt?: Timestamp;
}

/**
 * How fresh `ApiKey.lastUsedAt` is kept: a use records its time only when the recorded one is older than this, so a
 * busy key costs one write a minute, not one per call.
 */
export const API_KEY_LAST_USED_PRECISION_MS = 60_000;

/** The longest `ApiKey.name`, in characters. */
export const API_KEY_NAME_MAX_LENGTH = 100;

/**
 * Permissions an API key can carry on top of its role, each for named operations only and never a role:
 *
 * - `import`: load skills and memory snapshots into the key's organisation, as a host's import script does
 *   (`POST /v1/skills/import`, `POST /v1/memory/spaces/{spaceId}/snapshot`). It does not create memory spaces, and
 *   grants nothing else an organisation admin may do.
 *
 * Issuing a key with any of them needs admin on the organisation, as they reach beyond the key's projects.
 */
export const API_KEY_PERMISSIONS = ["import"] as const;
export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

export interface IssuedApiKey {
	readonly key: ApiKey;
	/** Shown once. */
	readonly secret: string;
}

/** What an authenticated credential may do. */
export interface Authentication {
	readonly actor: Actor;
	readonly organisationId: OrganisationId;
	/** For an API key, its projects; for a user, absent (roles decide per project). */
	readonly projectIds?: readonly ProjectId[];
	readonly role?: Role;
}

/**
 * A person a sign-in provider vouched for: the verified claims of a Cloudflare Access or OIDC token. Only an
 * authenticator that has checked the token's signature, issuer, audience and lifetime builds one.
 */
export interface ExternalIdentity {
	/** The token's `iss`: the Access team domain or the OIDC issuer URL. */
	readonly issuer: string;
	/** The token's `sub`, unique at the issuer. */
	readonly subject: string;
	readonly email?: string;
	/** Whether the provider verified the email. Only a verified email links an invited user. */
	readonly emailVerified?: boolean;
	readonly name?: string;
}

/** The `User.externalSubject` for a provider's subject: the issuer and subject, separated by a space. */
export function externalSubjectOf(issuer: string, subject: string): string {
	return `${issuer} ${subject}`;
}

/** How sign-in compares emails: trimmed and lower-cased. */
export function normaliseEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * The `ExternalIdentity.issuer` of Harbour's own email one-time PIN sign-in (self-hosted). Its subject is the normalised
 * email, and the email counts as verified: the person read the code from that inbox.
 */
export const EMAIL_OTP_ISSUER = "harbour:email-otp";

/** A signed-in person's user record and the organisations they may act in. */
export interface SignIn {
	readonly user: User;
	/** Organisations the user was created in or holds a role in, in no particular order. */
	readonly organisationIds: readonly OrganisationId[];
}

/** How a caller proved who it is. */
export type AuthenticationMethod =
	/** A host app's API key: `Authorization: Bearer hbr_…`. */
	| "api_key"
	/** A Cloudflare Access application token: the `Cf-Access-Jwt-Assertion` header. */
	| "cloudflare_access"
	/** An OIDC provider's token: `Authorization: Bearer <JWT>`. */
	| "oidc"
	/** A Harbour session a sign-in issued, such as an email one-time PIN's: `Authorization: Bearer hbs_…`. */
	| "harbour_session";

/** An authenticated caller: an `Authentication` and the method that proved it. */
export interface AuthenticatedCaller extends Authentication {
	readonly method: AuthenticationMethod;
}

/**
 * What an authenticator reads from a request: only its headers. A Fetch `Request` fits, so does a Hono context's
 * `req.raw`, a Durable Object's request or a Node adapter's.
 */
export interface AuthenticatorRequest {
	readonly headers: { get(name: string): string | null };
}

/** The header a human names the organisation they act in with. A key's organisation comes from the key. */
export const ORGANISATION_HEADER = "harbour-organisation";
/** The header Cloudflare Access puts its signed application token in. */
export const CLOUDFLARE_ACCESS_HEADER = "cf-access-jwt-assertion";

/**
 * Why authentication failed, carried as `details.authentication` on the `forbidden` error an authenticator throws:
 * - `missing`: no credential at all (HTTP 401).
 * - `invalid`: a credential that does not verify: a bad signature, issuer, audience or time; an unknown, revoked or
 *   expired API key; a signed-in person no user record matches (HTTP 401).
 * - `organisation`: the human named an organisation they hold no role in, or named none and hold roles in more than
 *   one (HTTP 403). A key's organisation is the key's, so a key never fails this way.
 */
export type AuthenticationFailure = "missing" | "invalid" | "organisation";

/** The `AuthenticationFailure` an authenticator's error carries, or undefined for any other error. */
export function authenticationFailureOf(error: unknown): AuthenticationFailure | undefined {
	if (!isHarbourError(error, "forbidden")) return undefined;
	const failure = error.details?.authentication;
	return failure === "missing" || failure === "invalid" || failure === "organisation" ? failure : undefined;
}

/** The error an authenticator throws: `forbidden`, with the failure in `details.authentication`. */
export function authenticationError(failure: AuthenticationFailure, message: string): HarbourError {
	return new HarbourError("forbidden", message, { authentication: failure });
}

/**
 * The middleware every Harbour API takes (M1-BE7). It turns a request's credentials into an `AuthenticatedCaller`:
 * a host app's service from an API key, or a human from a Cloudflare Access or OIDC token, whichever the deployment
 * configures. An API builds each call's `CallContext` from it with `callContextFor`.
 *
 * It authenticates and never authorises: what the caller may do in a project is `ProjectAccess`'s decision, which
 * honours a key's projects and role through `IdentityDirectory.roleOf` (the actor carries the key's ID). A failure
 * rejects with `forbidden` and an `AuthenticationFailure` in `details.authentication`, says nothing about which keys
 * or users exist, and never echoes a credential.
 */
export interface Authenticator {
	authenticate(request: AuthenticatorRequest): Promise<AuthenticatedCaller>;
}

/** The `CallContext` for one call by an authenticated caller, in `projectId` when the call names one. */
export function callContextFor(
	caller: Authentication,
	input: { readonly projectId?: ProjectId; readonly requestId?: string; readonly signal?: AbortSignal } = {},
): CallContext {
	return {
		actor: caller.actor,
		organisationId: caller.organisationId,
		...(input.projectId === undefined ? {} : { projectId: input.projectId }),
		...(input.requestId === undefined ? {} : { requestId: input.requestId }),
		...(input.signal === undefined ? {} : { signal: input.signal }),
	};
}

export interface IdentityDirectory {
	/** Creates an organisation. Only a `system` actor may (bootstrap); the creator names its first admin. */
	createOrganisation(
		ctx: CallContext,
		input: { readonly name: string; readonly admin: Principal },
	): Promise<Organisation>;
	getOrganisation(ctx: CallContext, id: OrganisationId): Promise<Organisation>;

	/** Needs admin on the organisation. */
	createProject(ctx: CallContext, input: { readonly name: string }): Promise<Project>;
	getProject(ctx: CallContext, id: ProjectId): Promise<Project>;
	/** Projects of `ctx.organisationId` that the actor holds any role on. */
	listProjects(ctx: CallContext, page?: PageRequest): Promise<Page<Project>>;

	createUser(
		ctx: CallContext,
		input: { readonly name: string; readonly email?: string; readonly externalSubject?: string },
	): Promise<User>;
	getUser(ctx: CallContext, id: UserId): Promise<User>;

	createServiceIdentity(ctx: CallContext, input: { readonly name: string }): Promise<ServiceIdentity>;

	/** Needs admin on the project (or organisation). Replaces an existing binding for the same principal and scope. */
	grantRole(
		ctx: CallContext,
		input: { readonly principal: Principal; readonly role: Role; readonly projectId?: ProjectId },
	): Promise<RoleBinding>;
	revokeRole(ctx: CallContext, input: { readonly principal: Principal; readonly projectId?: ProjectId }): Promise<void>;
	listRoleBindings(ctx: CallContext, input?: { readonly projectId?: ProjectId }): Promise<readonly RoleBinding[]>;

	/**
	 * Issues a key for a service identity, scoped to projects in its organisation. Needs admin on each project. A `name`
	 * is trimmed, must not be empty and holds at most `API_KEY_NAME_MAX_LENGTH` characters (else `invalid`).
	 */
	issueApiKey(
		ctx: CallContext,
		input: {
			readonly serviceId: ServiceId;
			readonly projectIds: readonly ProjectId[];
			readonly role: Role;
			readonly name?: string;
			readonly expiresAt?: Timestamp;
			/** Each one `API_KEY_PERMISSIONS` names (else `invalid`); any at all needs admin on the organisation. */
			readonly permissions?: readonly ApiKeyPermission[];
		},
	): Promise<IssuedApiKey>;
	revokeApiKey(ctx: CallContext, keyId: ApiKeyId): Promise<void>;
	listApiKeys(ctx: CallContext, input?: { readonly serviceId?: ServiceId }): Promise<readonly ApiKey[]>;

	/**
	 * Resolves an API key secret. Unknown, revoked or expired keys reject with `forbidden` (never `not_found`, so a
	 * caller learns nothing about which keys exist). A live key's use is recorded as its `lastUsedAt` (see
	 * `API_KEY_LAST_USED_PRECISION_MS`). A worker call (settled question 13): Harbour's gateway calls it as `system` to
	 * learn who a request is from; any other actor is `forbidden`.
	 */
	authenticateApiKey(ctx: SystemContext, secret: string): Promise<Authentication>;

	/**
	 * Resolves a person a sign-in provider vouched for to their user (M1-BE7). Harbour is invite-only: an admin creates
	 * the user first, and sign-in never creates one.
	 * - A user whose `externalSubject` is `externalSubjectOf(issuer, subject)` is that person. Issuer and subject compare
	 *   exactly, case included: OIDC subjects are opaque. `createUser` refuses a subject another user has (`conflict`).
	 * - Otherwise, when the provider verified the email, the one user with that email and no `externalSubject` is linked
	 *   to the subject, once, and audited as `identity.user.linked`. Emails compare trimmed and lower-cased
	 *   (`normaliseEmail`), on both sides, before deciding there is exactly one.
	 * - Anyone else, an unverified email, or an email two unlinked users share, is `forbidden`.
	 * A worker call (settled question 13): the authenticator makes it as `system`; any other actor is `forbidden`.
	 */
	signIn(ctx: SystemContext, identity: ExternalIdentity): Promise<SignIn>;

	/**
	 * Whether `signIn` would accept `identity` now, without linking anyone or auditing. Email one-time PIN sign-in asks
	 * it before sending a code, so only an invited user's inbox ever gets one. It does the same lookups whoever the
	 * identity names, but that is no constant-time promise: a public route that asks it must keep its own response
	 * independent of the answer. Malformed identities are `false`. A worker call: any actor but `system` is `forbidden`.
	 */
	canSignIn(ctx: SystemContext, identity: ExternalIdentity): Promise<boolean>;

	/**
	 * The strongest role `actor` holds on `projectId` (organisation-wide bindings count), or undefined. A worker call
	 * (settled question 13): `ProjectAccess` asks it as `system`; any other actor is `forbidden`.
	 */
	roleOf(
		ctx: SystemContext,
		actor: Actor,
		organisationId: OrganisationId,
		projectId?: ProjectId,
	): Promise<Role | undefined>;

	/**
	 * Whether `actor` signed in with a live API key of `organisationId` that carries `permission`. People, agents and
	 * services without a key never do. A worker call: the gateway asks it as `system`; any other actor is `forbidden`.
	 */
	keyPermits(
		ctx: SystemContext,
		actor: Actor,
		organisationId: OrganisationId,
		permission: ApiKeyPermission,
	): Promise<boolean>;

	/**
	 * Rejects with `forbidden` unless `ctx.actor` holds at least `needed` on `ctx.projectId` (or on the organisation
	 * when the call has no project). `system` actors pass. An `agent` actor acts with its session's project only,
	 * resolved by the runtime, and is never authorised here.
	 */
	authorize(ctx: CallContext, needed: Role): Promise<void>;
}

/*
 * Email one-time PIN sign-in over HTTP (M1-BE7, self-hosted). Cloudflare puts Access's own one-time PIN in front of
 * Harbour instead, so a Cloudflare deployment does not serve these routes.
 *
 * `POST OTP_START_PATH` with `OtpStartRequest` always answers 202 with `OtpStartResponse`, the same body whoever the
 * email names: only an invited user's inbox gets a code, so the route cannot be used to probe for accounts. Codes are
 * 6 digits, single use, valid 10 minutes and stored hashed; 5 wrong tries burn a code; an email gets at most 5 codes an
 * hour.
 *
 * `POST OTP_VERIFY_PATH` with `OtpVerifyRequest` signs the person in (`signIn` with `EMAIL_OTP_ISSUER`) and answers 200
 * with `OtpVerifyResponse`: a Harbour session token the authenticator accepts as `Authorization: Bearer hbs_…`. A
 * wrong, expired, used or burned code, or an email with no code, is 401 with the same body.
 *
 * `POST SESSION_END_PATH` with the session as bearer ends it (204), whatever state it was in.
 *
 * Failures answer `IdentityErrorResponse`: 400 `invalid` (a malformed body), 401 `unauthenticated`, 503 `unavailable`.
 */
export const OTP_START_PATH = "/auth/otp/start";
export const OTP_VERIFY_PATH = "/auth/otp/verify";
export const SESSION_END_PATH = "/auth/session/end";

export interface OtpStartRequest {
	readonly email: string;
}

export interface OtpStartResponse {
	readonly status: "accepted";
}

export interface OtpVerifyRequest {
	readonly email: string;
	/** The 6-digit code from the email. */
	readonly code: string;
}

export interface OtpVerifyResponse {
	/** The session token, shown once. Send it as `Authorization: Bearer <token>`. */
	readonly token: string;
	/** When the session ends, in milliseconds since the epoch. */
	readonly expiresAt: Timestamp;
	readonly user: User;
	/** The organisations the user may act in; name one with `ORGANISATION_HEADER` when there is more than one. */
	readonly organisationIds: readonly OrganisationId[];
}

export interface IdentityErrorResponse {
	readonly error: { readonly code: string; readonly message: string };
}

/*
 * Who is signed in, and their projects, over HTTP (M1-BE7). Both routes are behind the authenticator, so any caller
 * may ask about itself: a person signed in through Access, OIDC or a Harbour session, or a host app's API key.
 *
 * `GET ME_PATH` answers 200 with `MeResponse`. `GET PROJECTS_PATH?limit=&cursor=` answers 200 with a page of the
 * projects the caller holds a role on in its organisation (`IdentityDirectory.listProjects`), as `ProjectsResponse`.
 *
 * A missing or invalid credential is 401 with `UnauthenticatedResponse`, whose `signIn` names how a person signs in to
 * this deployment, so a console knows whether to show its own sign-in screen (`email_otp`) or reload the page for the
 * edge to sign them in (`cloudflare_access`). An organisation the caller may not act in is 403; a malformed `limit` or
 * `cursor` is 400 `invalid`.
 */
export const ME_PATH = "/v1/me";
export const PROJECTS_PATH = "/v1/projects";

/** How a person signs in to a deployment: Harbour's email one-time PIN (self-hosted) or Cloudflare Access at the edge. */
export type SignInMethod = "email_otp" | "cloudflare_access";
export const SIGN_IN_METHODS: readonly SignInMethod[] = ["email_otp", "cloudflare_access"];

/** A role the caller holds: across the organisation when `projectId` is absent, else on that project. */
export interface HeldRole {
	readonly projectId?: ProjectId;
	readonly role: Role;
}

export interface MeResponse {
	readonly actor: Actor;
	readonly organisationId: OrganisationId;
	readonly method: AuthenticationMethod;
	/** A person's name; a host app's service ID, as a key carries no name of its own. */
	readonly name: string;
	readonly email?: string;
	/**
	 * The organisation-wide role first, when there is one, then each project where the caller holds more than that. A key
	 * holds its role on each of its projects and nothing across the organisation.
	 */
	readonly roles: readonly HeldRole[];
}

export interface ProjectsResponse {
	readonly items: readonly Project[];
	/** Present when more projects follow: pass it back as `cursor`. */
	readonly nextCursor?: string;
}

export interface UnauthenticatedResponse {
	readonly error: {
		readonly code: "unauthenticated";
		readonly message: string;
		/** How a person signs in here; absent when the deployment did not say. */
		readonly signIn?: readonly SignInMethod[];
	};
}

/*
 * API keys over HTTP (M1-BE7): issue, list and revoke a host app's keys, behind the authenticator like `ME_PATH`.
 * Only someone who may issue keys reaches them: `admin` on the organisation or on at least one project. Anyone else
 * signed in is 403 `forbidden`; a missing or invalid credential is 401 with `UnauthenticatedResponse`. The directory
 * then decides each call as `issueApiKey`, `listApiKeys` and `revokeApiKey` do.
 *
 * - `GET API_KEYS_PATH` answers 200 with `ApiKeysResponse`: the keys the caller administers (every project of the key),
 *   revoked ones included. Never a secret.
 * - `POST API_KEYS_PATH` with `CreateApiKeyRequest` answers 201 with `CreateApiKeyResponse`, the only answer that
 *   ever holds the key's secret. Without `serviceId` the key gets a service identity of its own, named after the key,
 *   which needs `admin` on the organisation.
 * - `POST apiKeyRevokePath(id)` revokes the key and answers 204, also for a key already revoked. The key's next call
 *   is refused.
 *
 * Both POSTs need `Content-Type: application/json` (else 415), so a page on another site can't send one with the
 * browser's sign-in cookie: a cross-site JSON request needs a CORS preflight the gateway never grants. A malformed
 * body is 400 `invalid`, an unknown project or key 404 `not_found`.
 */
export const API_KEYS_PATH = "/v1/keys";
/** `/v1/keys/:id/revoke`. */
export const apiKeyRevokePath = (keyId: ApiKeyId): string => `${API_KEYS_PATH}/${encodeURIComponent(keyId)}/revoke`;

export interface ApiKeysResponse {
	readonly items: readonly ApiKey[];
}

export interface CreateApiKeyRequest {
	/** What the key is for; also the name of its service identity when one is made for it. */
	readonly name: string;
	/** The projects the key may act in, at least one. */
	readonly projectIds: readonly ProjectId[];
	readonly role: Role;
	/** When the key stops working, in milliseconds since the epoch. Absent: it works until revoked. */
	readonly expiresAt?: Timestamp;
	/** An existing service identity to issue the key for, such as when rotating a host app's key. */
	readonly serviceId?: ServiceId;
	/** Permissions beyond the role (`API_KEY_PERMISSIONS`), such as `["import"]`; any needs admin on the organisation. */
	readonly permissions?: readonly ApiKeyPermission[];
}

/** The key's record and its secret, shown once: Harbour keeps only a hash of it. */
export type CreateApiKeyResponse = IssuedApiKey;
