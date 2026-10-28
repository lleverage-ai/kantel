/**
 * Who is signed in and which projects they have, over HTTP: `GET /v1/me` and `GET /v1/projects` (`ME_PATH` and
 * `PROJECTS_PATH`), and a host app's API keys: `GET` and `POST /v1/keys`, `POST /v1/keys/:id/revoke` (`API_KEYS_PATH`;
 * the bodies are in `packages/contracts/src/identity.ts`). A Fetch-style handler behind the authenticator, so it
 * mounts in any Node, Bun or Worker router, and a client for these routes and for email one-time PIN sign-in
 * (`./otp-http.ts`), which the console and host apps call. Portable: Workers, Bun, Node and the browser.
 */
import {
	type Actor,
	API_KEY_NAME_MAX_LENGTH,
	API_KEYS_PATH,
	type ApiKey,
	type ApiKeysResponse,
	type AuthenticatedCaller,
	type Authenticator,
	apiKeyRevokePath,
	authenticationFailureOf,
	type CallContext,
	type Clock,
	type CreateApiKeyRequest,
	type CreateApiKeyResponse,
	callContextFor,
	type ErrorCode,
	HarbourError,
	type HeldRole,
	type IdentityDirectory,
	type IdentityErrorResponse,
	type IssuedApiKey,
	isHarbourError,
	type JsonValue,
	ME_PATH,
	type MeResponse,
	OTP_START_PATH,
	OTP_VERIFY_PATH,
	type OtpVerifyResponse,
	type Page,
	type PageRequest,
	PROJECTS_PATH,
	type Project,
	type ProjectsResponse,
	ROLES,
	type Role,
	roleSatisfies,
	SESSION_END_PATH,
	SIGN_IN_METHODS,
	type SignInMethod,
	systemClock,
	systemContext,
	type UnauthenticatedResponse,
} from "@harbour/contracts";

/** The handler reads roles as itself: `roleOf` is a worker call. */
const IDENTITY_HTTP_CONTEXT = systemContext("identity.http");

/** The most projects `GET /v1/me` reads roles for; past it, project roles are left out (the organisation's stays). */
export const ME_ROLE_PROJECT_CAP = 500;

/** Every `ErrorCode` and the status it answers with, as the other Harbour APIs. */
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
	if (isHarbourError(error)) {
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
		| "getProject"
		| "listProjects"
		| "roleOf"
		| "authorize"
		| "createServiceIdentity"
		| "issueApiKey"
		| "listApiKeys"
		| "revokeApiKey"
	>;
	readonly authenticator: Authenticator;
	/** The clock a new key's expiry is checked against. Default the system's. */
	readonly clock?: Clock;
	/**
	 * How a person signs in to this deployment, named in every 401 so a console knows what to show: `email_otp` when
	 * the deployment serves `/auth/otp/*`, `cloudflare_access` when Access signs people in at the edge.
	 */
	readonly signIn?: readonly SignInMethod[];
}

/** A positive integer from a query parameter, or an `invalid` error. */
function positiveInteger(value: string, name: string): number {
	if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new HarbourError("invalid", `${name} must be a positive integer`);
	return Number(value);
}

function pageRequestOf(params: URLSearchParams): PageRequest {
	for (const name of params.keys()) {
		if (name !== "limit" && name !== "cursor") throw new HarbourError("invalid", `Unknown parameter ${name}`);
	}
	const limit = params.get("limit");
	const cursor = params.get("cursor");
	if (cursor === "") throw new HarbourError("invalid", "cursor must not be empty");
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

type Route = { readonly name: "me" | "projects" | "keys" } | { readonly name: "revoke"; readonly keyId: string };

const ALLOW: Readonly<Record<Route["name"], readonly string[]>> = {
	me: ["GET"],
	projects: ["GET"],
	keys: ["GET", "POST"],
	revoke: ["POST"],
};

const REVOKE_SUFFIX = "/revoke";

function routeOf(path: string): Route | undefined {
	if (path === ME_PATH) return { name: "me" };
	if (path === PROJECTS_PATH) return { name: "projects" };
	if (path === API_KEYS_PATH) return { name: "keys" };
	if (!path.startsWith(`${API_KEYS_PATH}/`) || !path.endsWith(REVOKE_SUFFIX)) return undefined;
	const segment = path.slice(API_KEYS_PATH.length + 1, -REVOKE_SUFFIX.length);
	if (segment === "" || segment.includes("/")) return undefined;
	try {
		return { name: "revoke", keyId: decodeURIComponent(segment) };
	} catch {
		return undefined;
	}
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

/** Whether a POST says it carries JSON. */
const sendsJson = (request: Request): boolean =>
	/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "");

/** The body as JSON, refused past `API_KEY_BODY_LIMIT` bytes; an empty body is `{}`. */
async function readJson(request: Request): Promise<unknown> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > API_KEY_BODY_LIMIT) throw new HarbourError("invalid", "The body is too large");
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > API_KEY_BODY_LIMIT) {
		throw new HarbourError("invalid", "The body is too large");
	}
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new HarbourError("invalid", "The body must be JSON");
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const CREATE_FIELDS = new Set(["name", "projectIds", "role", "expiresAt", "serviceId"]);

/** A `CreateApiKeyRequest`, checked field by field, or an `invalid` error naming what is wrong. */
function createRequestOf(body: unknown, now: number): CreateApiKeyRequest {
	const invalid = (message: string) => new HarbourError("invalid", message);
	if (!isRecord(body)) throw invalid("The body is { name, projectIds, role, expiresAt?, serviceId? }");
	for (const field of Object.keys(body)) if (!CREATE_FIELDS.has(field)) throw invalid(`Unknown field ${field}`);
	const { name, projectIds, role, expiresAt, serviceId } = body;
	if (typeof name !== "string" || name.trim() === "") throw invalid("name must be a non-empty string");
	if (name.trim().length > API_KEY_NAME_MAX_LENGTH) {
		throw invalid(`name is at most ${API_KEY_NAME_MAX_LENGTH} characters`);
	}
	if (
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
	return {
		name: name.trim(),
		projectIds: [...new Set(projectIds as string[])],
		role: role as Role,
		...(expiresAt === undefined ? {} : { expiresAt: expiresAt as number }),
		...(serviceId === undefined ? {} : { serviceId: serviceId as string }),
	};
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
	if (serviceId === undefined) {
		for (const projectId of request.projectIds) await identity.getProject(ctx, projectId);
		await identity.authorize(ctx, "admin");
		serviceId = (await identity.createServiceIdentity(ctx, { name: request.name })).id;
	}
	return identity.issueApiKey(ctx, {
		serviceId,
		projectIds: request.projectIds,
		role: request.role,
		name: request.name,
		...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
	});
}

/**
 * Serves `GET /v1/me`, `GET /v1/projects`, `GET` and `POST /v1/keys` and `POST /v1/keys/:id/revoke`; any other path is
 * 404, any other method 405. Every call is authenticated first: a missing or bad credential is 401 with a
 * `WWW-Authenticate` challenge and the deployment's sign-in methods, an organisation the caller may not act in is 403.
 * The key routes then need `admin` somewhere in the organisation (else 403), and their POSTs a JSON content type (else
 * 415). Errors other than `HarbourError`s are 500 with no detail.
 */
export function createIdentityHandler(options: IdentityHandlerOptions): (request: Request) => Promise<Response> {
	const { identity, authenticator } = options;
	const clock = options.clock ?? systemClock;
	const signIn = options.signIn?.filter((method) => SIGN_IN_METHODS.includes(method));

	const unauthenticated = (message: string): Response => {
		const body: UnauthenticatedResponse = {
			error: { code: "unauthenticated", message, ...(signIn === undefined ? {} : { signIn }) },
		};
		return json(401, body, { "www-authenticate": `Bearer realm="harbour"` });
	};

	return async (request) => {
		const url = new URL(request.url);
		const route = routeOf(url.pathname);
		if (route === undefined) return errorResponse(404, "not_found", "No such route");
		const allowed = ALLOW[route.name];
		if (!allowed.includes(request.method)) {
			return errorResponse(405, "invalid", `Use ${allowed.join(" or ")}`, { allow: allowed.join(", ") });
		}

		let caller: AuthenticatedCaller;
		try {
			caller = await authenticator.authenticate(request);
		} catch (error) {
			const failure = authenticationFailureOf(error);
			if (failure === "organisation") {
				return json(403, {
					error: {
						code: "forbidden",
						failure,
						message: isHarbourError(error) ? error.message : "You may not act here",
					},
				});
			}
			if (failure !== undefined) {
				return unauthenticated(failure === "missing" ? "This call needs credentials" : "The credentials are not valid");
			}
			if (isHarbourError(error, "unavailable")) return errorResponse(503, "unavailable", "Sign-in is unavailable");
			return failed(error);
		}

		const requestId = request.headers.get("harbour-request-id") ?? undefined;
		const ctx = callContextFor(caller, { ...(requestId === undefined ? {} : { requestId }), signal: request.signal });
		try {
			if (route.name === "keys" || route.name === "revoke") {
				if (!(await mayReachKeys(identity, caller, ctx))) {
					return errorResponse(403, "forbidden", "API keys need the operator role or stronger");
				}
				if (request.method === "GET") {
					for (const name of url.searchParams.keys()) {
						if (name !== "serviceId") throw new HarbourError("invalid", `Unknown parameter ${name}`);
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
						throw new HarbourError("invalid", "A revocation's body is {}");
					}
					await identity.revokeApiKey(ctx, route.keyId);
					return new Response(null, { status: 204, headers: NO_STORE });
				}
				const issued: CreateApiKeyResponse = await issue(identity, ctx, createRequestOf(body, clock.now()));
				return json(201, issued);
			}
			if (route.name === "me") {
				const [described, roles] = await Promise.all([
					describe(identity, caller, ctx),
					heldRoles(identity, caller, ctx),
				]);
				const body: MeResponse = {
					actor: caller.actor,
					organisationId: caller.organisationId,
					method: caller.method,
					...described,
					roles,
				};
				return json(200, body);
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
	/** Harbour's base URL, such as `https://harbour.example.com`, or `""` for the page's own origin. */
	readonly baseUrl: string;
	/** Headers for every call: credentials, and `Harbour-Organisation` for a person in several organisations. */
	readonly headers?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
	readonly fetch?: typeof fetch;
}

export interface IdentityClient {
	me(signal?: AbortSignal): Promise<MeResponse>;
	/** One page of the caller's projects. */
	listProjects(page?: PageRequest, signal?: AbortSignal): Promise<Page<Project>>;
	/** Every one of the caller's projects, following the pages. */
	allProjects(signal?: AbortSignal): Promise<Project[]>;
	/** Asks for a sign-in code. Resolves the same whoever `email` names. */
	startOtp(email: string, signal?: AbortSignal): Promise<void>;
	/** Signs in with a code and starts a Harbour session. */
	verifyOtp(email: string, code: string, signal?: AbortSignal): Promise<OtpVerifyResponse>;
	/** Ends a Harbour session. */
	endSession(token: string, signal?: AbortSignal): Promise<void>;
	/** The keys the caller administers, revoked ones included. Never a secret. */
	listApiKeys(input?: { readonly serviceId?: string }, signal?: AbortSignal): Promise<ApiKey[]>;
	/** Issues a key; the answer is the only time its secret is ever sent. */
	createApiKey(input: CreateApiKeyRequest, signal?: AbortSignal): Promise<IssuedApiKey>;
	/** Revokes a key; its next call is refused. Resolves for a key already revoked too. */
	revokeApiKey(keyId: string, signal?: AbortSignal): Promise<void>;
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
 * A client for the identity routes and email one-time PIN sign-in. Failures reject with a `HarbourError`:
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
			throw new HarbourError("unavailable", "Can't reach Harbour");
		}
		if (response.ok) return response;
		throw await errorOf(response);
	}

	async function errorOf(response: Response): Promise<HarbourError> {
		const body = (await response.json().catch(() => undefined)) as
			| { error?: { code?: unknown; message?: unknown; failure?: unknown; signIn?: unknown } }
			| undefined;
		const error = body?.error;
		const message = typeof error?.message === "string" ? error.message : `Harbour answered ${response.status}`;
		if (response.status === 401) {
			const signIn = Array.isArray(error?.signIn)
				? error.signIn.filter((method): method is SignInMethod => SIGN_IN_METHODS.includes(method as SignInMethod))
				: undefined;
			const details: Record<string, JsonValue> = { authentication: "invalid" };
			if (signIn !== undefined) details.signIn = signIn;
			return new HarbourError("forbidden", message, details);
		}
		if (response.status === 403 && error?.failure === "organisation") {
			return new HarbourError("forbidden", message, { authentication: "organisation" });
		}
		if (response.status === 429) {
			const seconds = retryAfterSeconds(response.headers.get("retry-after"), Date.now());
			return new HarbourError("exhausted", message, seconds === undefined ? undefined : { retryAfterSeconds: seconds });
		}
		return new HarbourError(isErrorCode(error?.code) ? error.code : "unavailable", message);
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

		async startOtp(email, signal) {
			await post(OTP_START_PATH, { email }, signal);
		},

		async verifyOtp(email, code, signal) {
			return (await (await post(OTP_VERIFY_PATH, { email, code }, signal)).json()) as OtpVerifyResponse;
		},

		async endSession(token, signal) {
			await post(SESSION_END_PATH, {}, signal, { authorization: `Bearer ${token}` });
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
	};
	return client;
}

/** The sign-in methods a refusal from this client names, or undefined when it names none. */
export function signInMethodsOf(error: unknown): readonly SignInMethod[] | undefined {
	if (authenticationFailureOf(error) !== "invalid" || !isHarbourError(error)) return undefined;
	const methods = error.details?.signIn;
	return Array.isArray(methods) ? (methods as SignInMethod[]) : undefined;
}
