/**
 * Identity and tenancy. Organisations own projects; users and service identities hold a role per project (or across
 * the organisation); host apps call with API keys scoped to projects. Every call resolves to an `Actor`.
 */
import {
	type Actor,
	type ApiKeyId,
	type CallContext,
	isKantelError,
	KantelError,
	type OrganisationId,
	type Page,
	type PageRequest,
	type ProjectId,
	type ServiceId,
	type SystemContext,
	type Timestamp,
	type UserId,
} from "./common.ts";
import type { ModelThinking } from "./models.ts";

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

/** A host app (such as Lleverage) acting inside one organisation. */
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

/**
 * Where an API key's role applies (docs/site/src/content/docs/api/authentication.md):
 *
 * - `projects`: only on the projects it lists, and nothing across the organisation. Every key issued before scopes
 *   existed is one.
 * - `organisation`: across its organisation, as a person's organisation-wide binding is: on the organisation itself
 *   (organisation sessions, rules, skills and memory) and on every project, later ones included. Its role is at most
 *   `ORGANISATION_KEY_MAX_ROLE`.
 */
export type ApiKeyScope = "projects" | "organisation";
export const API_KEY_SCOPES: readonly ApiKeyScope[] = ["projects", "organisation"];

/**
 * The strongest role an organisation key may hold (docs/site/src/content/docs/api/authentication.md). Organisation
 * admin work (the organisation's rules, people's vault items, roles and keys) stays with people; a host app that has
 * to create projects gets the `create_projects` permission instead.
 */
export const ORGANISATION_KEY_MAX_ROLE: Role = "operator";

/** An API key's record. The secret is never stored or returned after issue; only its prefix is. */
export interface ApiKey {
	readonly id: ApiKeyId;
	readonly serviceId: ServiceId;
	readonly organisationId: OrganisationId;
	/** Where its role applies. Absent: `projects`, as on every key issued before scopes existed. */
	readonly scope?: ApiKeyScope;
	/** For a `projects` key, the only projects it may act in (at least one); for an `organisation` key, none. */
	readonly projectIds: readonly ProjectId[];
	readonly role: Role;
	/** What the key may do beyond its role on its projects (`API_KEY_PERMISSIONS`). Absent: nothing more. */
	readonly permissions?: readonly ApiKeyPermission[];
	readonly prefix: string;
	/** What the key is for, as its issuer named it. Absent on keys issued without one. */
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
 * - `create_projects`: create projects in the key's organisation (`POST /v1/projects`). Only an `organisation` key may
 *   carry it; the key then holds its role on each project it creates, as on every project of the organisation.
 *
 * Issuing a key with any of them needs admin on the organisation, as they reach beyond the key's projects.
 */
export const API_KEY_PERMISSIONS = ["import", "create_projects"] as const;
export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

export interface IssuedApiKey {
	readonly key: ApiKey;
	/** Shown once. */
	readonly secret: string;
}

/** An `Invite`'s ID: `inv_` and a UUID. */
export type InviteId = string;

/**
 * An invitation for a person, by email, to join an organisation with an organisation-wide role. It is pending until the
 * person signs in with a provider-verified email that matches it (`IdentityDirectory.signIn` accepts it then), an admin
 * revokes it, or it expires. Kantel stays invite-only: an invite is how an admin lets someone new in.
 */
export interface Invite {
	readonly id: InviteId;
	readonly organisationId: OrganisationId;
	/** As the admin typed it, trimmed. It matches a sign-in's email trimmed and lower-cased (`normaliseEmail`). */
	readonly email: string;
	/** The organisation-wide role the person gets on accepting. */
	readonly role: Role;
	readonly invitedBy: Actor;
	readonly createdAt: Timestamp;
	readonly expiresAt: Timestamp;
}

/** How long an invite stays pending: 14 days. */
export const INVITE_TTL_MILLISECONDS = 14 * 24 * 60 * 60 * 1000;

/** The longest email an invite takes, as SMTP carries. */
export const INVITE_EMAIL_MAX_LENGTH = 254;

/** What an authenticated credential may do. */
export interface Authentication {
	readonly actor: Actor;
	readonly organisationId: OrganisationId;
	/** For an API key, its projects (none for an organisation key); for a user, absent (roles decide per project). */
	readonly projectIds?: readonly ProjectId[];
	readonly role?: Role;
	/** For an API key, where its role applies; absent for anyone else, and on a `projects` key. */
	readonly scope?: ApiKeyScope;
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
 * The `ExternalIdentity.issuer` of Kantel's own email one-time PIN sign-in (self-hosted). Its subject is the normalised
 * email, and the email counts as verified: the person read the code from that inbox.
 */
export const EMAIL_OTP_ISSUER = "harbour:email-otp";

/** The `ExternalIdentity.issuer` of Kantel's own sign-in with GitHub. Its subject is the GitHub user's numeric ID. */
export const GITHUB_ISSUER = "kantel:github";

/** The `ExternalIdentity.issuer` of Kantel's own sign-in with Google. Its subject is the Google account's `sub`. */
export const GOOGLE_ISSUER = "kantel:google";

/**
 * The issuers of Kantel's own sign-ins: email codes, GitHub and Google. Each proves the email it carries as well as an
 * email code does, so `IdentityDirectory.signIn` links one of them by verified email to the person who already signs
 * in with another (see there). An Access or OIDC provider's issuer is never one of them.
 */
export const KANTEL_SIGN_IN_ISSUERS: readonly string[] = [EMAIL_OTP_ISSUER, GITHUB_ISSUER, GOOGLE_ISSUER];

export const isKantelSignInIssuer = (issuer: unknown): boolean =>
	typeof issuer === "string" && KANTEL_SIGN_IN_ISSUERS.includes(issuer);

/** Whether `externalSubject` (`externalSubjectOf`'s) is one of Kantel's own sign-ins'. */
export const isKantelSignInSubject = (externalSubject: unknown): boolean =>
	typeof externalSubject === "string" &&
	KANTEL_SIGN_IN_ISSUERS.some((issuer) => externalSubject.startsWith(externalSubjectOf(issuer, "")));

/**
 * The subject a user first made by one of Kantel's own sign-ins is made with, whichever it was: the email code's for the
 * address it proved (`externalSubjectOf(EMAIL_OTP_ISSUER, email)`, normalised). `external_subject` is UNIQUE, so two
 * first sign-ins with one email that race (an email code and GitHub, say) meet on it and make one user; the provider's
 * own subject is linked beside it. Undefined for any other sign-in, or one with no verified email.
 */
export function kantelPrimarySubject(identity: ExternalIdentity): string | undefined {
	if (!isKantelSignInIssuer(identity.issuer) || identity.emailVerified !== true || typeof identity.email !== "string") {
		return undefined;
	}
	const email = normaliseEmail(identity.email);
	return email === "" ? undefined : externalSubjectOf(EMAIL_OTP_ISSUER, email);
}

/** A signed-in person's user record and the organisations they may act in. */
export interface SignIn {
	readonly user: User;
	/** Organisations the user was created in or holds a role in, in no particular order. */
	readonly organisationIds: readonly OrganisationId[];
}

/** How a caller proved who it is. */
export type AuthenticationMethod =
	/** A host app's API key: `Authorization: Bearer ktk_…`. */
	| "api_key"
	/** A Cloudflare Access application token: the `Cf-Access-Jwt-Assertion` header. */
	| "cloudflare_access"
	/** An OIDC provider's token: `Authorization: Bearer <JWT>`. */
	| "oidc"
	/** A Kantel session a sign-in issued, such as an email one-time PIN's: `Authorization: Bearer kts_…`. */
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
export const ORGANISATION_HEADER = "kantel-organisation";
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
	if (!isKantelError(error, "forbidden")) return undefined;
	const failure = error.details?.authentication;
	return failure === "missing" || failure === "invalid" || failure === "organisation" ? failure : undefined;
}

/** The error an authenticator throws: `forbidden`, with the failure in `details.authentication`. */
export function authenticationError(failure: AuthenticationFailure, message: string): KantelError {
	return new KantelError("forbidden", message, { authentication: failure });
}

/**
 * The middleware every Kantel API takes. It turns a request's credentials into an `AuthenticatedCaller`:
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

	/**
	 * Needs admin on the organisation, or a live organisation API key of it with the `create_projects` permission.
	 * Audited as `identity.project.created`, with the caller (a key's ID included) as the actor.
	 */
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
	 * Issues a key for a service identity. A `projects` key (the default) is scoped to at least one project of its
	 * organisation and needs admin on each. An `organisation` key names no project (else `invalid`), holds at most
	 * `ORGANISATION_KEY_MAX_ROLE` (else `invalid`), and needs an organisation-wide admin who is not calling with a key
	 * (else `forbidden`), so a key never mints a key. A `name` is trimmed, must not be empty and holds at most
	 * `API_KEY_NAME_MAX_LENGTH` characters (else `invalid`). Audited as `identity.key.issued` with the scope and role.
	 */
	issueApiKey(
		ctx: CallContext,
		input: {
			readonly serviceId: ServiceId;
			/** Default `projects`. */
			readonly scope?: ApiKeyScope;
			/** For `projects`, at least one; for `organisation`, none (leave it out). */
			readonly projectIds?: readonly ProjectId[];
			readonly role: Role;
			readonly name?: string;
			readonly expiresAt?: Timestamp;
			/**
			 * Each one `API_KEY_PERMISSIONS` names (else `invalid`); any at all needs admin on the organisation, and
			 * `create_projects` an `organisation` key (else `invalid`).
			 */
			readonly permissions?: readonly ApiKeyPermission[];
		},
	): Promise<IssuedApiKey>;
	/** Needs admin on each of a `projects` key's projects, or on the organisation for an `organisation` key. */
	revokeApiKey(ctx: CallContext, keyId: ApiKeyId): Promise<void>;
	/**
	 * The organisation's keys the caller administers: a `projects` key when it is admin on each of its projects, an
	 * `organisation` key only when it is an organisation-wide admin. Revoked and expired keys included.
	 */
	listApiKeys(ctx: CallContext, input?: { readonly serviceId?: ServiceId }): Promise<readonly ApiKey[]>;

	/**
	 * Invites a person by email to `ctx.organisationId` with an organisation-wide `role`. Needs a person or service with
	 * admin on the organisation (an API key is `forbidden`). An email that is not plausibly one address is `invalid`; an
	 * email with a pending invite here already, or whose user already holds a role here, is `conflict`. The invite is
	 * pending for `INVITE_TTL_MILLISECONDS`. Audited as `identity.invite.created` with the role, never the email.
	 */
	createInvite(ctx: CallContext, input: { readonly email: string; readonly role: Role }): Promise<Invite>;
	/** The organisation's pending invites, oldest first. Needs admin on the organisation. */
	listInvites(ctx: CallContext): Promise<readonly Invite[]>;
	/**
	 * Revokes a pending invite, so signing in with its email no longer joins. Needs admin on the organisation, as
	 * `createInvite`. An invite that is not pending in this organisation (unknown, accepted, revoked or expired) is
	 * `not_found`. Audited as `identity.invite.revoked`.
	 */
	revokeInvite(ctx: CallContext, inviteId: InviteId): Promise<void>;

	/**
	 * The signed-in person's own settings, such as the console's theme. They belong to the person, not the organisation,
	 * so they follow them into every organisation they act in. Needs a role in `ctx.organisationId`; only a person has
	 * settings, so any other actor is `forbidden`. A person who never set one has `{}`.
	 */
	userPreferences(ctx: CallContext): Promise<UserPreferences>;
	/**
	 * Changes the caller's settings, as `userPreferences` reads them, and answers with them as now kept. A field left out
	 * stays as it is; `null` clears it. A theme that isn't a `THEME_PREFERENCE_PATTERN` is `invalid`.
	 */
	setUserPreferences(ctx: CallContext, change: UserPreferencesChange): Promise<UserPreferences>;

	/**
	 * A project's own settings (`ProjectSettings`): what its sessions get beyond the platform's defaults. Needs viewer on
	 * the project (any role there); a project the caller can't see is `not_found`. A project that never set one has `{}`.
	 */
	projectSettings(ctx: CallContext, projectId: ProjectId): Promise<ProjectSettings>;
	/**
	 * Changes a project's settings, as `projectSettings` reads them, and answers with them as now kept. Needs admin on the
	 * project. A field left out stays as it is; `null` clears it, back to the platform's default. A value Kantel doesn't
	 * know is `invalid`.
	 */
	setProjectSettings(ctx: CallContext, projectId: ProjectId, change: ProjectSettingsChange): Promise<ProjectSettings>;

	/**
	 * Resolves an API key secret. Unknown, revoked or expired keys reject with `forbidden` (never `not_found`, so a
	 * caller learns nothing about which keys exist). A live key's use is recorded as its `lastUsedAt` (see
	 * `API_KEY_LAST_USED_PRECISION_MS`). A worker call: Kantel's gateway calls it as `system` to
	 * learn who a request is from; any other actor is `forbidden`.
	 */
	authenticateApiKey(ctx: SystemContext, secret: string): Promise<Authentication>;

	/**
	 * Resolves a person a sign-in provider vouched for to their user. Kantel is invite-only: an admin creates
	 * the user first, and sign-in never creates one.
	 * - A user whose `externalSubject` is `externalSubjectOf(issuer, subject)`, or who was linked to it as below, is that
	 *   person. Issuer and subject compare exactly, case included: OIDC subjects are opaque. `createUser` refuses a
	 *   subject another user has (`conflict`).
	 * - Otherwise, for one of Kantel's own sign-ins (`isKantelSignInIssuer`: an email code, GitHub, Google) with a
	 *   verified email, the one user with that email who already signs in with another of Kantel's own sign-ins is that
	 *   person: the subject is linked to them too, once, and audited as `identity.user.linked`. So someone who signed up
	 *   with an email code and then signs in with GitHub (or the other way round) stays one user, with one space.
	 * - Otherwise, when the provider verified the email, the one user with that email and no `externalSubject` is linked
	 *   to the subject, once, and audited as `identity.user.linked`. Emails compare trimmed and lower-cased
	 *   (`normaliseEmail`), on both sides, before deciding there is exactly one.
	 * - A provider-verified email accepts every pending invite to it: a person no user matches gets one (named by the
	 *   identity's name, or the email's local part, and linked to the subject), and each invite's organisation-wide role
	 *   is granted unless they hold a role in that organisation already. Each invite is accepted once, audited as
	 *   `identity.invite.accepted` with the person as actor.
	 * - Anyone else, an unverified email, or an email two unlinked users share, is `forbidden`.
	 * A worker call: the authenticator makes it as `system`; any other actor is `forbidden`.
	 */
	signIn(ctx: SystemContext, identity: ExternalIdentity): Promise<SignIn>;

	/**
	 * Whether `signIn` would accept `identity` now, without linking anyone or auditing: a pending invite to its verified
	 * email counts. Email one-time PIN sign-in asks it before sending a code, so only an invited person's inbox ever
	 * gets one. It does the same lookups whoever the
	 * identity names, but that is no constant-time promise: a public route that asks it must keep its own response
	 * independent of the answer. Malformed identities are `false`. A worker call: any actor but `system` is `forbidden`.
	 */
	canSignIn(ctx: SystemContext, identity: ExternalIdentity): Promise<boolean>;

	/**
	 * The strongest role `actor` holds on `projectId` (organisation-wide bindings count), or on the organisation as a
	 * whole when it is absent, or undefined. A key holds its role on its projects, or with `organisation` scope on the
	 * organisation and every project of it, and never in another organisation. A worker call:
	 * `ProjectAccess` asks it as `system`; any other actor is `forbidden`.
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
 * Email one-time PIN sign-in over HTTP (self-hosted). Cloudflare puts Access's own one-time PIN in front of
 * Kantel instead, so a Cloudflare deployment does not serve these routes.
 *
 * `POST OTP_START_PATH` with `OtpStartRequest` always answers 202 with `OtpStartResponse`, the same body whoever the
 * email names: only an invited user's inbox gets a code, so the route cannot be used to probe for accounts. Codes are
 * 6 digits, single use, valid 10 minutes and stored hashed; 5 wrong tries burn a code; an email gets at most 5 codes an
 * hour.
 *
 * `POST OTP_VERIFY_PATH` with `OtpVerifyRequest` signs the person in (`signIn` with `EMAIL_OTP_ISSUER`) and answers 200
 * with `OtpVerifyResponse`: a Kantel session token the authenticator accepts as `Authorization: Bearer kts_…`. A
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
 * Sign-in with GitHub or Google: OAuth 2.0's authorisation code flow with PKCE, run by the gateway, on the same origin
 * and the same terms as email one-time PIN sign-in (it issues the same Kantel sessions). A provider is on only where
 * the deployment has its client ID and secret; elsewhere its routes are 404 and the 401's `signIn` doesn't name it.
 *
 * - `GET oauthStartPath(provider)` sets a short-lived state cookie (the state and the PKCE verifier) and redirects to
 *   the provider's consent page.
 * - The provider redirects back to `GET oauthCallbackPath(provider)`. The gateway checks the state against the cookie,
 *   exchanges the code with the verifier, reads the person's verified email from the provider, signs them in
 *   (`IdentityDirectory.signIn` with the provider's issuer and its user ID as subject) and redirects to the console's
 *   page with `OAUTH_DONE_PARAM`, the new session in a short-lived HttpOnly cookie. Any failure redirects there with
 *   `OAUTH_ERROR_PARAM` naming an `OAuthSignInError` instead.
 * - The console then calls `POST OAUTH_SESSION_PATH` (same origin, no body): it answers 200 with `OtpVerifyResponse`
 *   for the session in that cookie and clears it, or 401 when there is none.
 */

/** The providers Kantel signs people in with itself, beside email codes. */
export const OAUTH_PROVIDERS = ["github", "google"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const isOAuthProvider = (value: unknown): value is OAuthProvider =>
	typeof value === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(value);

/** Every OAuth sign-in route is under this. */
export const OAUTH_PATH_PREFIX = "/auth/oauth/";
export const oauthStartPath = (provider: OAuthProvider): string => `${OAUTH_PATH_PREFIX}${provider}/start`;
export const oauthCallbackPath = (provider: OAuthProvider): string => `${OAUTH_PATH_PREFIX}${provider}/callback`;
export const OAUTH_SESSION_PATH = `${OAUTH_PATH_PREFIX}session`;

/** The query parameter the console's page gets after a successful OAuth sign-in: `?signed_in=github`. */
export const OAUTH_DONE_PARAM = "signed_in";
/**
 * The query parameter the console's page gets when an OAuth sign-in failed, `?sign_in_error=cancelled`, beside
 * `OAUTH_PROVIDER_PARAM` naming the provider: `&provider=google`.
 */
export const OAUTH_ERROR_PARAM = "sign_in_error";
export const OAUTH_PROVIDER_PARAM = "provider";

/**
 * Why an OAuth sign-in failed, as the console says it:
 * - `cancelled`: the person declined (or closed) the provider's consent page;
 * - `unverified_email`: the provider has no verified email for them (GitHub: no verified primary email);
 * - `state_mismatch`: the callback's state didn't match this browser's cookie, or the cookie had gone (a stale tab,
 *   another browser, or a forged link);
 * - `not_allowed`: the deployment doesn't let this person in (self-hosted is invite-only);
 * - `failed`: anything else, such as the provider refusing the code or being unreachable.
 */
export const OAUTH_SIGN_IN_ERRORS = [
	"cancelled",
	"unverified_email",
	"state_mismatch",
	"not_allowed",
	"failed",
] as const;
export type OAuthSignInError = (typeof OAUTH_SIGN_IN_ERRORS)[number];

export const isOAuthSignInError = (value: unknown): value is OAuthSignInError =>
	typeof value === "string" && (OAUTH_SIGN_IN_ERRORS as readonly string[]).includes(value);

/*
 * Who is signed in, and their projects, over HTTP. Both routes are behind the authenticator, so any caller
 * may ask about itself: a person signed in through Access, OIDC or a Kantel session, or a host app's API key.
 *
 * `GET ME_PATH` answers 200 with `MeResponse`. `GET PROJECTS_PATH?limit=&cursor=` answers 200 with a page of the
 * projects the caller holds a role on in its organisation (`IdentityDirectory.listProjects`), as `ProjectsResponse`.
 * `POST PROJECTS_PATH` with `CreateProjectRequest` (as `application/json`, else 415) creates a project in the caller's
 * organisation (`IdentityDirectory.createProject`) and answers 201 with the `Project`: it needs an organisation-wide
 * admin, or an organisation API key with the `create_projects` permission (else 403 `forbidden`). A malformed body is
 * 400 `invalid`.
 *
 * A missing or invalid credential is 401 with `UnauthenticatedResponse`, whose `signIn` names how a person signs in to
 * this deployment, so a console knows whether to show its own sign-in screen (`email_otp`) or reload the page for the
 * edge to sign them in (`cloudflare_access`). An organisation the caller may not act in is 403; a malformed `limit` or
 * `cursor` is 400 `invalid`.
 */
export const ME_PATH = "/v1/me";
export const PROJECTS_PATH = "/v1/projects";

/**
 * How a person signs in to a deployment: Kantel's email one-time PIN, Cloudflare Access at the edge, or Kantel's own
 * sign-in with GitHub or Google (`OAUTH_PROVIDERS`), each only where the deployment has that provider's client.
 */
export type SignInMethod = "email_otp" | "cloudflare_access" | OAuthProvider;
export const SIGN_IN_METHODS: readonly SignInMethod[] = ["email_otp", "cloudflare_access", "github", "google"];

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
	 * The organisation-wide role first, when there is one, then each project where the caller holds more than that. A
	 * `projects` key holds its role on each of its projects and nothing across the organisation; an `organisation` key
	 * holds its role across the organisation.
	 */
	readonly roles: readonly HeldRole[];
	/** A person's own settings (`UserPreferences`). Absent for any caller but a person. */
	readonly preferences?: UserPreferences;
}

/**
 * A person's own settings. `theme` is the console's theme: `light`, `dark`, or `system` to follow the device's light or
 * dark setting (`ThemePreference`). A theme's ID from before the console had only those two (`nord`,
 * `catppuccin-latte`, a custom theme's) is still accepted, and Kantel keeps and answers it as the nearer of light and
 * dark, or `system` (`themePreference`).
 *
 * `lastModel` and `lastThinking` are the model (a `ModelOption.id`) and thinking level the person last chose for a
 * session, which the console's New session offers first. Kantel keeps them as given and applies neither itself: a
 * client uses them only where the model is one the new session lists, and a session's first message still names what
 * it runs with.
 */
export interface UserPreferences {
	readonly theme?: string;
	readonly lastModel?: string;
	readonly lastThinking?: ModelThinking;
}

/** A change to a person's settings: a field left out stays as it is, `null` clears it. */
export type UserPreferencesChange = { readonly [K in keyof UserPreferences]?: UserPreferences[K] | null };

/**
 * A project's own settings. Each is absent until an admin sets it, and absent means the platform's default (the
 * deployment's config), so a project follows the platform until it says otherwise.
 *
 * - `browserGoalMode`: `on` offers the project's sessions `browser_run`, a whole goal handed to the browser's fast loop
 *   (Reflex's goal mode), beside the other browser tools; `off` doesn't. Experimental.
 * - `browserDecisionModel`: the System One model goal runs choose each step with: `clef` (Cloudflare's, through the
 *   deployment's Workers AI) or `jev` (TypeSafe's, with the deployment's key).
 */
export interface ProjectSettings {
	readonly browserGoalMode?: "on" | "off";
	readonly browserDecisionModel?: "clef" | "jev";
}

/** The platform's defaults when a deployment gives none: goal mode off, on Clef. */
export const DEFAULT_PROJECT_SETTINGS: Required<ProjectSettings> = {
	browserGoalMode: "off",
	browserDecisionModel: "clef",
};

/** A change to a project's settings: a field left out stays as it is, `null` clears it. */
export type ProjectSettingsChange = { readonly [K in keyof ProjectSettings]?: ProjectSettings[K] | null };

/**
 * A project's settings over HTTP. `GET projectSettingsPath(id)` answers 200 with its `ProjectSettings` and the
 * platform's defaults beside them (`ProjectSettingsResponse`); `PATCH` with a `ProjectSettingsChange` (as
 * `application/json`, else 415) answers the same, as now kept. Viewer on the project reads them; admin changes them
 * (else 403). A project the caller can't see is 404; a malformed body is 400.
 */
export const projectSettingsPath = (projectId: string): string =>
	`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/settings`;

export interface ProjectSettingsResponse {
	/** What the project set. */
	readonly settings: ProjectSettings;
	/** What it gets for each it didn't: the platform's defaults. */
	readonly defaults: Required<ProjectSettings>;
}

/**
 * What a theme preference may be when written: `light`, `dark` or `system`, or, from an older console, a theme's ID
 * (lower-case letters, digits and dashes, at most 64), which is kept as the nearer of light and dark.
 */
export const THEME_PREFERENCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The longest `UserPreferences.lastModel` kept, in characters. */
export const MAX_LAST_MODEL_LENGTH = 256;

/**
 * The signed-in person's settings over HTTP. `PATCH ME_PREFERENCES_PATH` with a `UserPreferencesChange` (as
 * `application/json`, else 415) answers 200 with the `UserPreferences` now kept. `GET ME_PATH` carries them too, as
 * `MeResponse.preferences`. Only a person has settings: any other caller is 403 `forbidden`. A malformed body is 400.
 */
export const ME_PREFERENCES_PATH = "/v1/me/preferences";

export interface ProjectsResponse {
	readonly items: readonly Project[];
	/** Present when more projects follow: pass it back as `cursor`. */
	readonly nextCursor?: string;
}

/** The longest project name `POST /v1/projects` takes, in characters, once trimmed. */
export const PROJECT_NAME_MAX_LENGTH = 100;

export interface CreateProjectRequest {
	/** The project's name: trimmed, not empty, at most `PROJECT_NAME_MAX_LENGTH` characters. */
	readonly name: string;
}

/** The project as created. */
export type CreateProjectResponse = Project;

export interface UnauthenticatedResponse {
	readonly error: {
		readonly code: "unauthenticated";
		readonly message: string;
		/** How a person signs in here; absent when the deployment did not say. */
		readonly signIn?: readonly SignInMethod[];
	};
}

/*
 * API keys over HTTP: issue, list and revoke a host app's keys, behind the authenticator like `ME_PATH`.
 * Only someone who may issue keys reaches them: `admin` on the organisation or on at least one project. Anyone else
 * signed in is 403 `forbidden`; a missing or invalid credential is 401 with `UnauthenticatedResponse`. The directory
 * then decides each call as `issueApiKey`, `listApiKeys` and `revokeApiKey` do.
 *
 * - `GET API_KEYS_PATH` answers 200 with `ApiKeysResponse`: the keys the caller administers (every project of a
 *   `projects` key; the organisation for an `organisation` key), revoked ones included. Never a secret.
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
	/**
	 * Where the key's role applies; default `projects`. An `organisation` key needs an organisation-wide admin signed in
	 * as a person, and holds at most `ORGANISATION_KEY_MAX_ROLE`.
	 */
	readonly scope?: ApiKeyScope;
	/** For a `projects` key, the projects it may act in, at least one. For an `organisation` key, leave it out or empty. */
	readonly projectIds?: readonly ProjectId[];
	readonly role: Role;
	/** When the key stops working, in milliseconds since the epoch. Absent: it works until revoked. */
	readonly expiresAt?: Timestamp;
	/** An existing service identity to issue the key for, such as when rotating a host app's key. */
	readonly serviceId?: ServiceId;
	/**
	 * Permissions beyond the role (`API_KEY_PERMISSIONS`), such as `["import"]`; any needs admin on the organisation, and
	 * `create_projects` an `organisation` key.
	 */
	readonly permissions?: readonly ApiKeyPermission[];
}

/** The key's record and its secret, shown once: Kantel keeps only a hash of it. */
export type CreateApiKeyResponse = IssuedApiKey;

/*
 * Invites over HTTP: an organisation admin invites a person by email with a role, lists the pending invites and
 * revokes one, behind the authenticator like `ME_PATH`. The directory decides each call as `createInvite`,
 * `listInvites` and `revokeInvite` do: anyone but an organisation admin is 403 `forbidden`.
 *
 * - `GET INVITES_PATH` answers 200 with `InvitesResponse`.
 * - `POST INVITES_PATH` with `CreateInviteRequest` answers 201 with `CreateInviteResponse`: the invite, the link to
 *   send the person, and whether Kantel emailed it to them. A duplicate is 409 `conflict`, a malformed body 400.
 * - `POST inviteRevokePath(id)` with `{}` revokes it and answers 204; one that is not pending is 404 `not_found`.
 *
 * Both POSTs need `Content-Type: application/json` (else 415), as the key routes do. The person accepts by signing in
 * with the invited email, wherever the link takes them: it carries no secret.
 */
export const INVITES_PATH = "/v1/invites";
/** `/v1/invites/:id/revoke`. */
export const inviteRevokePath = (inviteId: InviteId): string =>
	`${INVITES_PATH}/${encodeURIComponent(inviteId)}/revoke`;

export interface InvitesResponse {
	/** Pending invites, oldest first. */
	readonly items: readonly Invite[];
}

export interface CreateInviteRequest {
	readonly email: string;
	readonly role: Role;
}

export interface CreateInviteResponse {
	readonly invite: Invite;
	/** Where the person signs in to accept: the console. It holds no secret, so anyone may be sent it. */
	readonly link: string;
	/** Whether Kantel emailed the person the link; false where the deployment sends no mail, or the send failed. */
	readonly emailed: boolean;
}
