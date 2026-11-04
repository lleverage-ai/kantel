/**
 * Who is signed in and which projects they have, over HTTP: `GET /v1/me`, and `GET` and `POST /v1/projects` (`ME_PATH`
 * and `PROJECTS_PATH`); the organisations they may act in and the people in this one, by name: `GET /v1/organisations` and
 * `GET /v1/members` (`ORGANISATIONS_PATH` and `MEMBERS_PATH`, bodies below); an admin's invites: `GET` and `POST /v1/invites`,
 * `POST /v1/invites/:id/revoke` (`INVITES_PATH`); and a host app's API keys: `GET` and `POST /v1/keys`, `POST /v1/keys/:id/revoke` (`API_KEYS_PATH`;
 * the bodies are in `packages/contracts/src/identity.ts`). A Fetch-style handler behind the authenticator, so it
 * mounts in any Node, Bun or Worker router, and a client for these routes and for email one-time PIN sign-in
 * (`./otp-http.ts`), which the console and host apps call. Portable: Workers, Bun, Node and the browser.
 */
import {
	type Actor,
	API_KEY_NAME_MAX_LENGTH,
	API_KEY_PERMISSIONS,
	API_KEY_SCOPES,
	API_KEYS_PATH,
	type ApiKey,
	type ApiKeyPermission,
	type ApiKeyScope,
	type ApiKeysResponse,
	type AuthenticatedCaller,
	type Authenticator,
	apiKeyRevokePath,
	authenticationFailureOf,
	type CallContext,
	type Clock,
	type CreateApiKeyRequest,
	type CreateApiKeyResponse,
	type CreateInviteRequest,
	type CreateInviteResponse,
	type CreateProjectRequest,
	type CreateProjectResponse,
	callContextFor,
	DEFAULT_PROJECT_SETTINGS,
	type ErrorCode,
	type HeldRole,
	type IdentityDirectory,
	type IdentityErrorResponse,
	INVITES_PATH,
	type Invite,
	type InvitesResponse,
	type IssuedApiKey,
	inviteRevokePath,
	isKantelError,
	type JsonValue,
	KantelError,
	ME_PATH,
	ME_PREFERENCES_PATH,
	type MeResponse,
	OAUTH_SESSION_PATH,
	ORGANISATION_HEADER,
	ORGANISATION_KEY_MAX_ROLE,
	type OrganisationId,
	OTP_START_PATH,
	OTP_VERIFY_PATH,
	type OtpVerifyResponse,
	type Page,
	type PageRequest,
	PROJECT_NAME_MAX_LENGTH,
	PROJECTS_PATH,
	type Project,
	type ProjectSettings,
	type ProjectSettingsChange,
	type ProjectSettingsResponse,
	type ProjectsResponse,
	projectSettingsPath,
	ROLES,
	type Role,
	type RoleBinding,
	readHeader,
	roleSatisfies,
	SESSION_END_PATH,
	SIGN_IN_METHODS,
	type SignInMethod,
	systemClock,
	systemContext,
	type UnauthenticatedResponse,
	type UserId,
	type UserPreferences,
	type UserPreferencesChange,
} from "@kantel/contracts";
import { inviteEmail, inviteRole } from "./index.ts";
import type { InviteMailer } from "./invites.ts";
import { type SignedIn, signedInReaderOf } from "./signed-in.ts";

/**
 * `GET ORGANISATIONS_PATH`: the organisations the caller may act in, `OrganisationsResponse`. A person in several
 * needn't name one (`Kantel-Organisation`) for this call alone; when they do, or have only one, it is `current`. An
 * API key acts in its own organisation only.
 */
export const ORGANISATIONS_PATH = "/v1/organisations";

/**
 * `GET MEMBERS_PATH`: the people who hold a role in the caller's organisation, `MembersResponse`, for naming them (an
 * audit row's actor). Needs a role on the organisation; a caller with roles on projects only gets the people bound to
 * those projects. Names only: never an email.
 */
export const MEMBERS_PATH = "/v1/members";

/** An organisation, by name. */
export interface OrganisationSummary {
	readonly id: OrganisationId;
	readonly name: string;
}

export interface OrganisationsResponse {
	/** The current organisation first, when there is one, then by name. */
	readonly items: readonly OrganisationSummary[];
	/** The organisation the call acted in: the one it named, or the caller's only one. */
	readonly current?: OrganisationId;
}

/** A person who holds a role in the organisation. */
export interface Member {
	readonly userId: UserId;
	readonly name: string;
}

export interface MembersResponse {
	/** By name. */
	readonly items: readonly Member[];
}

/** The most organisations `GET /v1/organisations` names; past it, the rest are left out. */
export const ORGANISATIONS_CAP = 100;

/** The most people `GET /v1/members` names; past it, the rest are left out. */
export const MEMBERS_CAP = 1000;

/** The handler reads roles as itself: `roleOf` is a worker call. */
const IDENTITY_HTTP_CONTEXT = systemContext("identity.http");

/** The most projects `GET /v1/me` reads roles for; past it, project roles are left out (the organisation's stays). */
export const ME_ROLE_PROJECT_CAP = 500;

/** Every `ErrorCode` and the status it answers with, as the other Kantel APIs. */
const STATUS: Record<ErrorCode, number> = {
	invalid: 400,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	expired: 410,
	refused: 422,
	exhausted: 429,
	aborted: 499,
	not_supported: 501,
	unavailable: 503,
};

const isErrorCode = (code: unknown): code is ErrorCode => typeof code === "string" && Object.hasOwn(STATUS, code);

const NO_STORE = { "cache-control": "no-store" };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
	});
}

function errorResponse(status: number, code: string, message: string, headers?: Record<string, string>): Response {
	const body: IdentityErrorResponse = { error: { code, message } };
	return json(status, body, headers);
}

function failed(error: unknown): Response {
	if (isKantelError(error)) {
		const status = isErrorCode(error.code) ? STATUS[error.code] : 500;
		return errorResponse(status, error.code, status === 500 ? "Internal error" : error.message);
	}
	return errorResponse(500, "internal", "Internal error");
}

/** The largest body `POST /v1/keys` takes: a name, a few project IDs and a role. */
export const API_KEY_BODY_LIMIT = 16 * 1024;

/** The most projects one key may name. */
export const API_KEY_MAX_PROJECTS = 100;

export interface IdentityHandlerOptions {
	readonly identity: Pick<
		IdentityDirectory,
		| "getUser"
		| "getOrganisation"
		| "getProject"
		| "listProjects"
		| "createProject"
		| "listRoleBindings"
		| "roleOf"
		| "authorize"
		| "createServiceIdentity"
		| "issueApiKey"
		| "listApiKeys"
		| "revokeApiKey"
		| "userPreferences"
		| "setUserPreferences"
		| "projectSettings"
		| "setProjectSettings"
		| "createInvite"
		| "listInvites"
		| "revokeInvite"
	>;
	readonly authenticator: Authenticator;
	/** What a project gets for each setting it didn't set (the deployment's config). Default goal mode off, on Clef. */
	readonly projectDefaults?: Required<ProjectSettings>;
	/** How an invite reaches the person. Default: no email, and a link to the origin the request came to. */
	readonly invites?: InviteOptions;
	/** The clock a new key's expiry is checked against. Default the system's. */
	readonly clock?: Clock;
	/**
	 * How a person signs in to this deployment, named in every 401 so a console knows what to show: `email_otp` when
	 * the deployment serves `/auth/otp/*`, `cloudflare_access` when Access signs people in at the edge.
	 */
	readonly signIn?: readonly SignInMethod[];
}

export interface InviteOptions {
	/** Emails each invite; without one the admin sends the link themselves (`CreateInviteResponse.emailed` is false). */
	readonly mailer?: InviteMailer;
	/** Where an invited person signs in: the console. Default the origin the request came to, as `/`. */
	readonly link?: (request: Request) => string;
	/** A send that failed; the invite stands, and the admin gets the link to copy. Never given the link. */
	readonly onMailError?: (error: unknown, to: string) => void;
}

/** A positive integer from a query parameter, or an `invalid` error. */
function positiveInteger(value: string, name: string): number {
	if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new KantelError("invalid", `${name} must be a positive integer`);
	return Number(value);
}

function pageRequestOf(params: URLSearchParams): PageRequest {
	for (const name of params.keys()) {
		if (name !== "limit" && name !== "cursor") throw new KantelError("invalid", `Unknown parameter ${name}`);
	}
	const limit = params.get("limit");
	const cursor = params.get("cursor");
	if (cursor === "") throw new KantelError("invalid", "cursor must not be empty");
	return {
		...(limit === null ? {} : { limit: positiveInteger(limit, "limit") }),
		...(cursor === null ? {} : { cursor }),
	};
}

/** What a caller is called: a person's name and email, or a key's service ID. */
async function describe(
	identity: IdentityHandlerOptions["identity"],
	caller: AuthenticatedCaller,
	ctx: ReturnType<typeof callContextFor>,
): Promise<{ name: string; email?: string }> {
	const actor: Actor = caller.actor;
	if (actor.kind === "human") {
		const user = await identity.getUser(ctx, actor.userId);
		return { name: user.name, ...(user.email === undefined ? {} : { email: user.email }) };
	}
	if (actor.kind === "service") return { name: actor.serviceId };
	if (actor.kind === "agent") return { name: actor.agentId };
	return { name: actor.component };
}

const stronger = (role: Role, than: Role | undefined) =>
	than === undefined || ROLES.indexOf(role) > ROLES.indexOf(than);

/** The organisation-wide role, then each visible project's where it is stronger, up to `ME_ROLE_PROJECT_CAP` projects. */
async function heldRoles(
	identity: IdentityHandlerOptions["identity"],
	caller: AuthenticatedCaller,
	ctx: ReturnType<typeof callContextFor>,
): Promise<HeldRole[]> {
	const organisationRole = await identity.roleOf(IDENTITY_HTTP_CONTEXT, caller.actor, caller.organisationId);
	const roles: HeldRole[] = organisationRole === undefined ? [] : [{ role: organisationRole }];
	let cursor: string | undefined;
	let read = 0;
	do {
		const page = await identity.listProjects(ctx, { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
		for (const project of page.items) {
			if (read >= ME_ROLE_PROJECT_CAP) return roles;
			read += 1;
			const role = await identity.roleOf(IDENTITY_HTTP_CONTEXT, caller.actor, caller.organisationId, project.id);
			if (role !== undefined && stronger(role, organisationRole)) roles.push({ projectId: project.id, role });
		}
		cursor = page.nextCursor;
	} while (cursor !== undefined && read < ME_ROLE_PROJECT_CAP);
	return roles;
}

type Route =
	| { readonly name: "me" | "preferences" | "projects" | "keys" | "organisations" | "members" | "invites" }
	| { readonly name: "revoke"; readonly keyId: string }
	| { readonly name: "revokeInvite"; readonly inviteId: string }
	| { readonly name: "projectSettings"; readonly projectId: string };

const PROJECT_SETTINGS_SUFFIX = "/settings";

const ALLOW: Readonly<Record<Route["name"], readonly string[]>> = {
	me: ["GET"],
	preferences: ["PATCH"],
	projectSettings: ["GET", "PATCH"],
	projects: ["GET", "POST"],
	organisations: ["GET"],
	members: ["GET"],
	invites: ["GET", "POST"],
	keys: ["GET", "POST"],
	revoke: ["POST"],
	revokeInvite: ["POST"],
};

const REVOKE_SUFFIX = "/revoke";

/** The ID in `<base>/:id/revoke`, decoded, or undefined for any other path. */
function revokedId(path: string, base: string): string | undefined {
	if (!path.startsWith(`${base}/`) || !path.endsWith(REVOKE_SUFFIX)) return undefined;
	const segment = path.slice(base.length + 1, -REVOKE_SUFFIX.length);
	if (segment === "" || segment.includes("/")) return undefined;
	try {
		return decodeURIComponent(segment);
	} catch {
		return undefined;
	}
}

function routeOf(path: string): Route | undefined {
	if (path === ME_PATH) return { name: "me" };
	if (path === ME_PREFERENCES_PATH) return { name: "preferences" };
	if (path === PROJECTS_PATH) return { name: "projects" };
	if (path === ORGANISATIONS_PATH) return { name: "organisations" };
	if (path === MEMBERS_PATH) return { name: "members" };
	if (path === INVITES_PATH) return { name: "invites" };
	if (path === API_KEYS_PATH) return { name: "keys" };
	if (path.startsWith(`${PROJECTS_PATH}/`) && path.endsWith(PROJECT_SETTINGS_SUFFIX)) {
		const segment = path.slice(PROJECTS_PATH.length + 1, -PROJECT_SETTINGS_SUFFIX.length);
		if (segment === "" || segment.includes("/")) return undefined;
		try {
			return { name: "projectSettings", projectId: decodeURIComponent(segment) };
		} catch {
			return undefined;
		}
	}
	const keyId = revokedId(path, API_KEYS_PATH);
	if (keyId !== undefined) return { name: "revoke", keyId };
	const inviteId = revokedId(path, INVITES_PATH);
	return inviteId === undefined ? undefined : { name: "revokeInvite", inviteId };
}

/** Whether the path is one this handler serves, for a router deciding where a request goes. */
export function isIdentityPath(path: string): boolean {
	return routeOf(path) !== undefined;
}

/**
 * Whether the caller may reach the key routes: `operator` or stronger on the organisation, or on at least one of its
 * projects (up to `ME_ROLE_PROJECT_CAP` of them), so a viewer is refused here. This is only the route's gate: the
 * directory still decides each call, and it lets only an admin of every project a key covers issue, see or revoke it.
 * An operator who is not such an admin lists no keys and is refused each create and revoke with `forbidden`.
 */
async function mayReachKeys(
	identity: IdentityHandlerOptions["identity"],
	caller: AuthenticatedCaller,
	ctx: CallContext,
): Promise<boolean> {
	return (await heldRoles(identity, caller, ctx)).some((held) => roleSatisfies(held.role, "operator"));
}

/** Refuses any query parameter: the organisation and member reads take none. */
function noParameters(params: URLSearchParams): void {
	for (const name of params.keys()) throw new KantelError("invalid", `Unknown parameter ${name}`);
}

/**
 * The organisations `signedIn` may act in, by name: the current one first, then by name, up to `ORGANISATIONS_CAP`.
 * Each is read as the person in that organisation; one they may not read (they were invited to it but hold no role in
 * it yet) is named by its ID.
 */
async function organisationsOf(
	identity: IdentityHandlerOptions["identity"],
	signedIn: SignedIn,
	current: OrganisationId | undefined,
	context: { readonly requestId?: string; readonly signal?: AbortSignal },
): Promise<OrganisationsResponse> {
	const ids = [...new Set(signedIn.organisationIds)].slice(0, ORGANISATIONS_CAP);
	const items = await Promise.all(
		ids.map(async (organisationId): Promise<OrganisationSummary> => {
			const ctx = callContextFor({ actor: signedIn.actor, organisationId }, context);
			try {
				return { id: organisationId, name: (await identity.getOrganisation(ctx, organisationId)).name };
			} catch (error) {
				if (isKantelError(error, "forbidden") || isKantelError(error, "not_found")) {
					return { id: organisationId, name: organisationId };
				}
				throw error;
			}
		}),
	);
	const rank = (item: OrganisationSummary) => (item.id === current ? 0 : 1);
	items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "en-GB") || a.id.localeCompare(b.id));
	return current === undefined ? { items } : { items, current };
}

/**
 * The bindings the caller may list: the organisation's, or with no role on it, those of each project they hold a role
 * on (a project they may not list is left out).
 */
async function visibleBindings(
	identity: IdentityHandlerOptions["identity"],
	ctx: CallContext,
): Promise<readonly RoleBinding[]> {
	try {
		return await identity.listRoleBindings(ctx);
	} catch (error) {
		if (!isKantelError(error, "forbidden")) throw error;
	}
	const bindings: RoleBinding[] = [];
	let cursor: string | undefined;
	do {
		const page = await identity.listProjects(ctx, { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
		for (const project of page.items) {
			try {
				bindings.push(...(await identity.listRoleBindings(ctx, { projectId: project.id })));
			} catch (error) {
				if (!isKantelError(error, "forbidden")) throw error;
			}
		}
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return bindings;
}

/** The people bound in the caller's organisation, by name, up to `MEMBERS_CAP`; one it can't read is left out. */
async function membersOf(identity: IdentityHandlerOptions["identity"], ctx: CallContext): Promise<Member[]> {
	const userIds = [
		...new Set(
			(await visibleBindings(identity, ctx)).flatMap((binding) =>
				binding.principal.kind === "user" ? [binding.principal.userId] : [],
			),
		),
	].slice(0, MEMBERS_CAP);
	const members: Member[] = [];
	// A few at a time: each is a read of its own.
	for (let start = 0; start < userIds.length; start += 10) {
		const read = await Promise.all(
			userIds.slice(start, start + 10).map(async (userId): Promise<Member | undefined> => {
				try {
					return { userId, name: (await identity.getUser(ctx, userId)).name };
				} catch (error) {
					if (isKantelError(error, "not_found")) return undefined;
					throw error;
				}
			}),
		);
		for (const member of read) if (member !== undefined) members.push(member);
	}
	return members.sort((a, b) => a.name.localeCompare(b.name, "en-GB") || a.userId.localeCompare(b.userId));
}

/** Whether a POST says it carries JSON. */
const sendsJson = (request: Request): boolean =>
	/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "");

/** The body as JSON, refused past `API_KEY_BODY_LIMIT` bytes; an empty body is `{}`. */
async function readJson(request: Request): Promise<unknown> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > API_KEY_BODY_LIMIT) throw new KantelError("invalid", "The body is too large");
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > API_KEY_BODY_LIMIT) {
		throw new KantelError("invalid", "The body is too large");
	}
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new KantelError("invalid", "The body must be JSON");
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const CREATE_FIELDS = new Set(["name", "scope", "projectIds", "role", "expiresAt", "serviceId", "permissions"]);

/** A `CreateApiKeyRequest`, checked field by field, or an `invalid` error naming what is wrong. */
function createRequestOf(body: unknown, now: number): CreateApiKeyRequest {
	const invalid = (message: string) => new KantelError("invalid", message);
	if (!isRecord(body)) {
		throw invalid("The body is { name, scope?, projectIds?, role, expiresAt?, serviceId?, permissions? }");
	}
	for (const field of Object.keys(body)) if (!CREATE_FIELDS.has(field)) throw invalid(`Unknown field ${field}`);
	const { name, scope, projectIds, role, expiresAt, serviceId, permissions } = body;
	if (typeof name !== "string" || name.trim() === "") throw invalid("name must be a non-empty string");
	if (name.trim().length > API_KEY_NAME_MAX_LENGTH) {
		throw invalid(`name is at most ${API_KEY_NAME_MAX_LENGTH} characters`);
	}
	if (scope !== undefined && !API_KEY_SCOPES.includes(scope as ApiKeyScope)) {
		throw invalid(`scope must be ${API_KEY_SCOPES.join(" or ")}`);
	}
	const organisation = scope === "organisation";
	if (organisation) {
		if (projectIds !== undefined && (!Array.isArray(projectIds) || projectIds.length > 0)) {
			throw invalid("An organisation key names no projects: leave projectIds out");
		}
	} else if (
		!Array.isArray(projectIds) ||
		projectIds.length === 0 ||
		projectIds.length > API_KEY_MAX_PROJECTS ||
		!projectIds.every((id) => typeof id === "string" && id !== "")
	) {
		throw invalid(`projectIds must list 1 to ${API_KEY_MAX_PROJECTS} project IDs`);
	}
	if (typeof role !== "string" || !ROLES.includes(role as Role))
		throw invalid("role must be viewer, operator or admin");
	if (expiresAt !== undefined) {
		if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) throw invalid("expiresAt must be a time in ms");
		if (expiresAt <= now) throw invalid("expiresAt must be in the future");
	}
	if (serviceId !== undefined && (typeof serviceId !== "string" || serviceId === "")) {
		throw invalid("serviceId must be a non-empty string");
	}
	if (
		permissions !== undefined &&
		(!Array.isArray(permissions) ||
			!permissions.every((permission) => API_KEY_PERMISSIONS.includes(permission as ApiKeyPermission)))
	) {
		throw invalid(`permissions must list only ${API_KEY_PERMISSIONS.join(", ")}`);
	}
	return {
		name: name.trim(),
		...(organisation ? { scope: "organisation" as const } : {}),
		projectIds: organisation ? [] : [...new Set(projectIds as string[])],
		role: role as Role,
		...(expiresAt === undefined ? {} : { expiresAt: expiresAt as number }),
		...(serviceId === undefined ? {} : { serviceId: serviceId as string }),
		...(permissions === undefined ? {} : { permissions: permissions as ApiKeyPermission[] }),
	};
}

/** A `CreateInviteRequest`, its email trimmed, or an `invalid` error naming what is wrong. */
function createInviteRequestOf(body: unknown): CreateInviteRequest {
	if (!isRecord(body)) throw new KantelError("invalid", "The body is { email, role }");
	for (const field of Object.keys(body)) {
		if (field !== "email" && field !== "role") throw new KantelError("invalid", `Unknown field ${field}`);
	}
	return { email: inviteEmail(body.email), role: inviteRole(body.role) };
}

/** A `CreateProjectRequest`, its name trimmed, or an `invalid` error naming what is wrong. */
function createProjectRequestOf(body: unknown): CreateProjectRequest {
	const invalid = (message: string) => new KantelError("invalid", message);
	if (!isRecord(body)) throw invalid("The body is { name }");
	for (const field of Object.keys(body)) if (field !== "name") throw invalid(`Unknown field ${field}`);
	const { name } = body;
	if (typeof name !== "string" || name.trim() === "") throw invalid("name must be a non-empty string");
	if (name.trim().length > PROJECT_NAME_MAX_LENGTH) {
		throw invalid(`name is at most ${PROJECT_NAME_MAX_LENGTH} characters`);
	}
	return { name: name.trim() };
}

/**
 * Issues the request's key. Without a `serviceId` the key gets a service identity of its own, named after it: every
 * check that could refuse the key is made first (each project exists, the caller is an organisation admin), so a
 * refusal leaves no service behind.
 */
async function issue(
	identity: IdentityHandlerOptions["identity"],
	ctx: CallContext,
	request: CreateApiKeyRequest,
): Promise<IssuedApiKey> {
	let serviceId = request.serviceId;
	const projectIds = request.projectIds ?? [];
	if (serviceId === undefined) {
		for (const projectId of projectIds) await identity.getProject(ctx, projectId);
		await identity.authorize(ctx, "admin");
		// An organisation key's other refusals (a key calling, too strong a role) come before its service is made too.
		if (request.scope === "organisation") {
			if (ctx.actor.kind === "service" && ctx.actor.keyId !== undefined) {
				throw new KantelError("forbidden", "An API key cannot issue an organisation key");
			}
			if (!roleSatisfies(ORGANISATION_KEY_MAX_ROLE, request.role)) {
				throw new KantelError("invalid", `An organisation key's role is at most ${ORGANISATION_KEY_MAX_ROLE}`);
			}
		} else if (request.permissions?.includes("create_projects")) {
			throw new KantelError("invalid", "Only an organisation key may create projects");
		}
		serviceId = (await identity.createServiceIdentity(ctx, { name: request.name })).id;
	}
	return identity.issueApiKey(ctx, {
		serviceId,
		...(request.scope === undefined ? {} : { scope: request.scope }),
		projectIds,
		role: request.role,
		name: request.name,
		...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
		...(request.permissions === undefined ? {} : { permissions: request.permissions }),
	});
}

/**
 * Serves `GET /v1/me`, `GET` and `POST /v1/projects`, `GET /v1/organisations`, `GET /v1/members`, `GET` and
 * `POST /v1/invites` and `POST /v1/invites/:id/revoke` (an organisation admin's, as the directory decides), `GET` and
 * `POST /v1/keys` and `POST /v1/keys/:id/revoke`; any other path is 404, any other method 405. Every call is authenticated first: a missing or bad credential is 401 with a
 * `WWW-Authenticate` challenge and the deployment's sign-in methods, an organisation the caller may not act in is 403.
 * The key routes then need `admin` somewhere in the organisation (else 403), and their POSTs a JSON content type (else
 * 415). Errors other than `KantelError`s are 500 with no detail.
 */
export function createIdentityHandler(options: IdentityHandlerOptions): (request: Request) => Promise<Response> {
	const { identity, authenticator } = options;
	const clock = options.clock ?? systemClock;
	const signIn = options.signIn?.filter((method) => SIGN_IN_METHODS.includes(method));
	const inviteLink = options.invites?.link ?? ((request: Request) => new URL("/", request.url).toString());

	/** Emails the invite when the deployment has mail; whether it went. A failed send leaves the invite standing. */
	const mailInvite = async (
		caller: AuthenticatedCaller,
		ctx: CallContext,
		invite: Invite,
		link: string,
	): Promise<boolean> => {
		const mailer = options.invites?.mailer;
		if (mailer === undefined) return false;
		try {
			const [organisation, inviter] = await Promise.all([
				identity.getOrganisation(ctx, ctx.organisationId),
				describe(identity, caller, ctx),
			]);
			await mailer.sendInvite({
				to: invite.email,
				organisation: organisation.name,
				invitedBy: inviter.name,
				link,
				expiresAt: invite.expiresAt,
			});
			return true;
		} catch (error) {
			options.invites?.onMailError?.(error, invite.email);
			return false;
		}
	};

	const unauthenticated = (message: string): Response => {
		const body: UnauthenticatedResponse = {
			error: { code: "unauthenticated", message, ...(signIn === undefined ? {} : { signIn }) },
		};
		return json(401, body, { "www-authenticate": `Bearer realm="kantel"` });
	};

	/** The answer to a call that didn't authenticate: 401, 403 for an organisation it may not act in, or as `failed`. */
	const refusal = (error: unknown): Response => {
		const failure = authenticationFailureOf(error);
		if (failure === "organisation") {
			return json(403, {
				error: {
					code: "forbidden",
					failure,
					message: isKantelError(error) ? error.message : "You may not act here",
				},
			});
		}
		if (failure !== undefined) {
			return unauthenticated(failure === "missing" ? "This call needs credentials" : "The credentials are not valid");
		}
		if (isKantelError(error, "unavailable")) return errorResponse(503, "unavailable", "Sign-in is unavailable");
		return failed(error);
	};

	return async (request) => {
		const url = new URL(request.url);
		const route = routeOf(url.pathname);
		if (route === undefined) return errorResponse(404, "not_found", "No such route");
		const allowed = ALLOW[route.name];
		if (!allowed.includes(request.method)) {
			return errorResponse(405, "invalid", `Use ${allowed.join(" or ")}`, { allow: allowed.join(", ") });
		}

		const requestId = readHeader(request.headers, "kantel-request-id") ?? undefined;
		const context = { ...(requestId === undefined ? {} : { requestId }), signal: request.signal };

		// A person in several organisations may list them without naming one, so this read asks who they are first.
		const readSignedIn = route.name === "organisations" ? signedInReaderOf(authenticator) : undefined;
		if (readSignedIn !== undefined) {
			try {
				noParameters(url.searchParams);
				const signedIn = await readSignedIn(request);
				if (signedIn !== undefined) {
					const named = readHeader(request.headers, ORGANISATION_HEADER)?.trim();
					const ids = signedIn.organisationIds;
					let current: OrganisationId | undefined;
					if (named !== undefined && named !== "") {
						// As `authenticate`: naming one they may not act in is refused.
						if (!ids.includes(named)) await authenticator.authenticate(request);
						current = named;
					} else if (ids.length === 1) {
						current = ids[0];
					}
					return json(200, await organisationsOf(identity, signedIn, current, context));
				}
			} catch (error) {
				return refusal(error);
			}
		}

		let caller: AuthenticatedCaller;
		try {
			caller = await authenticator.authenticate(request);
		} catch (error) {
			return refusal(error);
		}

		const ctx = callContextFor(caller, context);
		try {
			if (route.name === "organisations") {
				noParameters(url.searchParams);
				const signedIn: SignedIn = {
					actor: caller.actor,
					method: caller.method,
					organisationIds: [caller.organisationId],
				};
				return json(200, await organisationsOf(identity, signedIn, caller.organisationId, context));
			}
			if (route.name === "members") {
				noParameters(url.searchParams);
				const body: MembersResponse = { items: await membersOf(identity, ctx) };
				return json(200, body);
			}
			if (route.name === "invites" || route.name === "revokeInvite") {
				noParameters(url.searchParams);
				if (request.method === "GET") {
					const body: InvitesResponse = { items: await identity.listInvites(ctx) };
					return json(200, body);
				}
				if (!sendsJson(request)) return errorResponse(415, "invalid", "Send the body as application/json");
				const body = await readJson(request);
				if (route.name === "revokeInvite") {
					if (!isRecord(body) || Object.keys(body).length > 0) {
						throw new KantelError("invalid", "A revocation's body is {}");
					}
					await identity.revokeInvite(ctx, route.inviteId);
					return new Response(null, { status: 204, headers: NO_STORE });
				}
				const invite = await identity.createInvite(ctx, createInviteRequestOf(body));
				const link = inviteLink(request);
				const created: CreateInviteResponse = {
					invite,
					link,
					emailed: await mailInvite(caller, ctx, invite, link),
				};
				return json(201, created);
			}
			if (route.name === "keys" || route.name === "revoke") {
				if (!(await mayReachKeys(identity, caller, ctx))) {
					return errorResponse(403, "forbidden", "API keys need the operator role or stronger");
				}
				if (request.method === "GET") {
					for (const name of url.searchParams.keys()) {
						if (name !== "serviceId") throw new KantelError("invalid", `Unknown parameter ${name}`);
					}
					const serviceId = url.searchParams.get("serviceId");
					const items: readonly ApiKey[] = await identity.listApiKeys(
						ctx,
						serviceId === null || serviceId === "" ? undefined : { serviceId },
					);
					const body: ApiKeysResponse = { items };
					return json(200, body);
				}
				if (!sendsJson(request)) {
					return errorResponse(415, "invalid", "Send the body as application/json");
				}
				const body = await readJson(request);
				if (route.name === "revoke") {
					if (!isRecord(body) || Object.keys(body).length > 0) {
						throw new KantelError("invalid", "A revocation's body is {}");
					}
					await identity.revokeApiKey(ctx, route.keyId);
					return new Response(null, { status: 204, headers: NO_STORE });
				}
				const issued: CreateApiKeyResponse = await issue(identity, ctx, createRequestOf(body, clock.now()));
				return json(201, issued);
			}
			if (route.name === "projectSettings") {
				noParameters(url.searchParams);
				let settings: ProjectSettings;
				if (request.method === "PATCH") {
					if (!sendsJson(request)) return errorResponse(415, "invalid", "Send the body as application/json");
					settings = await identity.setProjectSettings(
						ctx,
						route.projectId,
						(await readJson(request)) as ProjectSettingsChange,
					);
				} else {
					settings = await identity.projectSettings(ctx, route.projectId);
				}
				const body: ProjectSettingsResponse = {
					settings,
					defaults: options.projectDefaults ?? DEFAULT_PROJECT_SETTINGS,
				};
				return json(200, body);
			}
			if (route.name === "preferences") {
				noParameters(url.searchParams);
				if (!sendsJson(request)) return errorResponse(415, "invalid", "Send the body as application/json");
				const body: UserPreferences = await identity.setUserPreferences(
					ctx,
					(await readJson(request)) as UserPreferencesChange,
				);
				return json(200, body);
			}
			if (route.name === "me") {
				const [described, roles, preferences] = await Promise.all([
					describe(identity, caller, ctx),
					heldRoles(identity, caller, ctx),
					// A person's settings; a directory that can't read them leaves them out rather than fail the call.
					caller.actor.kind === "human" ? identity.userPreferences(ctx).catch(() => undefined) : undefined,
				]);
				const body: MeResponse = {
					actor: caller.actor,
					organisationId: caller.organisationId,
					method: caller.method,
					...described,
					roles,
					...(preferences === undefined ? {} : { preferences }),
				};
				return json(200, body);
			}
			if (request.method === "POST") {
				noParameters(url.searchParams);
				if (!sendsJson(request)) return errorResponse(415, "invalid", "Send the body as application/json");
				const input = createProjectRequestOf(await readJson(request));
				const created: CreateProjectResponse = await identity.createProject(ctx, input);
				return json(201, created);
			}
			const page = await identity.listProjects(ctx, pageRequestOf(url.searchParams));
			const body: ProjectsResponse =
				page.nextCursor === undefined ? { items: page.items } : { items: page.items, nextCursor: page.nextCursor };
			return json(200, body);
		} catch (error) {
			return failed(error);
		}
	};
}

export interface IdentityClientOptions {
	/** Kantel's base URL, such as `https://kantel.example.com`, or `""` for the page's own origin. */
	readonly baseUrl: string;
	/** Headers for every call: credentials, and `Kantel-Organisation` for a person in several organisations. */
	readonly headers?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
	readonly fetch?: typeof fetch;
}

export interface IdentityClient {
	me(signal?: AbortSignal): Promise<MeResponse>;
	/** One page of the caller's projects. */
	listProjects(page?: PageRequest, signal?: AbortSignal): Promise<Page<Project>>;
	/** Every one of the caller's projects, following the pages. */
	allProjects(signal?: AbortSignal): Promise<Project[]>;
	/** Creates a project in the caller's organisation (`POST /v1/projects`). */
	createProject(input: CreateProjectRequest, signal?: AbortSignal): Promise<Project>;
	/** The organisations the caller may act in, the current one first. */
	organisations(signal?: AbortSignal): Promise<OrganisationsResponse>;
	/** The people who hold a role in the caller's organisation, by name. */
	members(signal?: AbortSignal): Promise<Member[]>;
	/** The organisation's pending invites, oldest first (`GET /v1/invites`). Needs admin on the organisation. */
	listInvites(signal?: AbortSignal): Promise<Invite[]>;
	/** Invites a person by email with an organisation-wide role (`POST /v1/invites`). */
	createInvite(input: CreateInviteRequest, signal?: AbortSignal): Promise<CreateInviteResponse>;
	/** Revokes a pending invite (`POST /v1/invites/:id/revoke`). */
	revokeInvite(inviteId: string, signal?: AbortSignal): Promise<void>;
	/** Asks for a sign-in code. Resolves the same whoever `email` names. */
	startOtp(email: string, signal?: AbortSignal): Promise<void>;
	/** Signs in with a code and starts a Kantel session. */
	verifyOtp(email: string, code: string, signal?: AbortSignal): Promise<OtpVerifyResponse>;
	/** Ends a Kantel session. */
	endSession(token: string, signal?: AbortSignal): Promise<void>;
	/**
	 * Picks up the session a sign-in with GitHub or Google left in its short-lived cookie (`POST OAUTH_SESSION_PATH`),
	 * once. Rejects `unauthenticated` when there is none. Only on the console's own origin: the cookie is its.
	 */
	oauthSession(signal?: AbortSignal): Promise<OtpVerifyResponse>;
	/** The keys the caller administers, revoked ones included. Never a secret. */
	listApiKeys(input?: { readonly serviceId?: string }, signal?: AbortSignal): Promise<ApiKey[]>;
	/** Issues a key; the answer is the only time its secret is ever sent. */
	createApiKey(input: CreateApiKeyRequest, signal?: AbortSignal): Promise<IssuedApiKey>;
	/** Revokes a key; its next call is refused. Resolves for a key already revoked too. */
	revokeApiKey(keyId: string, signal?: AbortSignal): Promise<void>;
	/** Changes the signed-in person's own settings (`null` clears one), and resolves with them as now kept. */
	setPreferences(change: UserPreferencesChange, signal?: AbortSignal): Promise<UserPreferences>;
	/** A project's settings and the platform's defaults beside them. */
	projectSettings(projectId: string, signal?: AbortSignal): Promise<ProjectSettingsResponse>;
	/** Changes a project's settings (`null` clears one), and resolves with them as now kept. Needs admin on it. */
	setProjectSettings(
		projectId: string,
		change: ProjectSettingsChange,
		signal?: AbortSignal,
	): Promise<ProjectSettingsResponse>;
}

/** The seconds a `Retry-After` header asks for, when it gives a number of them or a date. */
function retryAfterSeconds(header: string | null, now: number): number | undefined {
	if (header === null) return undefined;
	const trimmed = header.trim();
	if (/^[0-9]+$/.test(trimmed)) return Number(trimmed);
	const at = Date.parse(trimmed);
	return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * A client for the identity routes and email one-time PIN sign-in. Failures reject with a `KantelError`:
 * - 401 is `forbidden` with `details.authentication: "invalid"` and, when the deployment named them,
 *   `details.signIn`, its sign-in methods; a wrong, expired or used code is this too.
 * - 403 is `forbidden` with `details.authentication: "organisation"` when the caller may not act in the organisation,
 *   and a plain `forbidden` when its role is not enough: a viewer on the key routes, or an operator issuing or revoking
 *   a key for a project it is not an admin of.
 * - 429 (a deployment's per-address limit on sign-in) is `exhausted`, with `details.retryAfterSeconds` when the
 *   response said.
 * - A failed fetch is `unavailable`; anything else carries the server's code, or `unavailable`.
 */
export function createIdentityClient(options: IdentityClientOptions): IdentityClient {
	const doFetch = options.fetch ?? ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init));
	const base = options.baseUrl.replace(/\/+$/, "");

	async function call(path: string, init: RequestInit & { signal?: AbortSignal | undefined }): Promise<Response> {
		const headers = new Headers(init.headers);
		const extra = options.headers === undefined ? undefined : await options.headers();
		for (const [name, value] of Object.entries(extra ?? {})) if (!headers.has(name)) headers.set(name, value);
		let response: Response;
		try {
			response = await doFetch(`${base}${path}`, { ...init, headers });
		} catch (error) {
			if (init.signal?.aborted) throw error;
			throw new KantelError("unavailable", "Can't reach Kantel");
		}
		if (response.ok) return response;
		throw await errorOf(response);
	}

	async function errorOf(response: Response): Promise<KantelError> {
		const body = (await response.json().catch(() => undefined)) as
			| { error?: { code?: unknown; message?: unknown; failure?: unknown; signIn?: unknown } }
			| undefined;
		const error = body?.error;
		const message = typeof error?.message === "string" ? error.message : `Kantel answered ${response.status}`;
		if (response.status === 401) {
			const signIn = Array.isArray(error?.signIn)
				? error.signIn.filter((method): method is SignInMethod => SIGN_IN_METHODS.includes(method as SignInMethod))
				: undefined;
			const details: Record<string, JsonValue> = { authentication: "invalid" };
			if (signIn !== undefined) details.signIn = signIn;
			return new KantelError("forbidden", message, details);
		}
		if (response.status === 403 && error?.failure === "organisation") {
			return new KantelError("forbidden", message, { authentication: "organisation" });
		}
		if (response.status === 429) {
			const seconds = retryAfterSeconds(response.headers.get("retry-after"), Date.now());
			return new KantelError("exhausted", message, seconds === undefined ? undefined : { retryAfterSeconds: seconds });
		}
		return new KantelError(isErrorCode(error?.code) ? error.code : "unavailable", message);
	}

	const getJson = async <T>(path: string, signal?: AbortSignal): Promise<T> =>
		(await (await call(path, { method: "GET", signal })).json()) as T;

	const post = (path: string, body: unknown, signal?: AbortSignal, headers: Record<string, string> = {}) =>
		call(path, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal,
		});

	const client: IdentityClient = {
		me: (signal) => getJson<MeResponse>(ME_PATH, signal),

		async listProjects(page = {}, signal) {
			const query = new URLSearchParams();
			if (page.limit !== undefined) query.set("limit", String(page.limit));
			if (page.cursor !== undefined) query.set("cursor", page.cursor);
			const search = query.toString();
			const suffix = search === "" ? "" : `?${search}`;
			const body = await getJson<ProjectsResponse>(`${PROJECTS_PATH}${suffix}`, signal);
			return body.nextCursor === undefined ? { items: body.items } : { items: body.items, nextCursor: body.nextCursor };
		},

		async allProjects(signal) {
			const projects: Project[] = [];
			let cursor: string | undefined;
			do {
				const page = await client.listProjects({ limit: 100, ...(cursor === undefined ? {} : { cursor }) }, signal);
				projects.push(...page.items);
				cursor = page.nextCursor;
			} while (cursor !== undefined);
			return projects;
		},

		async createProject(input, signal) {
			return (await (await post(PROJECTS_PATH, input, signal)).json()) as CreateProjectResponse;
		},

		organisations: (signal) => getJson<OrganisationsResponse>(ORGANISATIONS_PATH, signal),

		async members(signal) {
			return [...(await getJson<MembersResponse>(MEMBERS_PATH, signal)).items];
		},

		async listInvites(signal) {
			return [...(await getJson<InvitesResponse>(INVITES_PATH, signal)).items];
		},

		async createInvite(input, signal) {
			return (await (await post(INVITES_PATH, input, signal)).json()) as CreateInviteResponse;
		},

		async revokeInvite(inviteId, signal) {
			await post(inviteRevokePath(inviteId), {}, signal);
		},

		async startOtp(email, signal) {
			await post(OTP_START_PATH, { email }, signal);
		},

		async verifyOtp(email, code, signal) {
			return (await (await post(OTP_VERIFY_PATH, { email, code }, signal)).json()) as OtpVerifyResponse;
		},

		async endSession(token, signal) {
			await post(SESSION_END_PATH, {}, signal, { authorization: `Bearer ${token}` });
		},

		async oauthSession(signal) {
			return (await (await post(OAUTH_SESSION_PATH, {}, signal)).json()) as OtpVerifyResponse;
		},

		async listApiKeys(input = {}, signal) {
			const suffix = input.serviceId === undefined ? "" : `?${new URLSearchParams({ serviceId: input.serviceId })}`;
			return [...(await getJson<ApiKeysResponse>(`${API_KEYS_PATH}${suffix}`, signal)).items];
		},

		async createApiKey(input, signal) {
			return (await (await post(API_KEYS_PATH, input, signal)).json()) as CreateApiKeyResponse;
		},

		async revokeApiKey(keyId, signal) {
			await post(apiKeyRevokePath(keyId), {}, signal);
		},

		async setPreferences(change, signal) {
			const response = await call(ME_PREFERENCES_PATH, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(change),
				signal,
			});
			return (await response.json()) as UserPreferences;
		},

		async projectSettings(projectId, signal) {
			const response = await call(projectSettingsPath(projectId), { signal });
			return (await response.json()) as ProjectSettingsResponse;
		},

		async setProjectSettings(projectId, change, signal) {
			const response = await call(projectSettingsPath(projectId), {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(change),
				signal,
			});
			return (await response.json()) as ProjectSettingsResponse;
		},
	};
	return client;
}

/** The sign-in methods a refusal from this client names, or undefined when it names none. */
export function signInMethodsOf(error: unknown): readonly SignInMethod[] | undefined {
	if (authenticationFailureOf(error) !== "invalid" || !isKantelError(error)) return undefined;
	const methods = error.details?.signIn;
	return Array.isArray(methods) ? (methods as SignInMethod[]) : undefined;
}
