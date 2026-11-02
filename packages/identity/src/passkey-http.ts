/**
 * A person's passkeys over HTTP (#132): `GET` and `POST /v1/me/passkeys`, `POST /v1/me/passkeys/registration`,
 * `POST /v1/me/passkeys/confirmation` and `POST /v1/me/passkeys/:id/remove` (`PASSKEYS_PATH`), and an admin's
 * `POST /v1/members/:userId/passkeys/reset` (the bodies are in `packages/contracts/src/passkey.ts`). A
 * Fetch-style handler behind the authenticator, so it mounts in any Node, Bun or Worker router, and a client for the
 * console. Portable: Workers, Bun, Node and the browser.
 *
 * The relying party is the origin the request was made to (`relyingPartyFor(request.url)`), unless the deployment
 * names one; a registration challenge remembers it, so a passkey is verified against the origin it was asked for on.
 */
import {
	type Authenticator,
	authenticationFailureOf,
	callContextFor,
	type ErrorCode,
	isKantelError,
	KantelError,
	PASSKEY_CONFIRMATION_PATH,
	PASSKEY_REGISTRATION_PATH,
	PASSKEYS_PATH,
	type Passkey,
	type PasskeyAssertion,
	type PasskeyAttestation,
	type PasskeyChallenge,
	type PasskeyChange,
	type PasskeyRegistrationOptions,
	type PasskeyResetResponse,
	type PasskeysResponse,
	passkeyRemovePath,
	passkeyResetPath,
	type RegisterPasskeyRequest,
	type RelyingParty,
	relyingPartyFor,
	SIGN_IN_METHODS,
	type SignInMethod,
	type UnauthenticatedResponse,
} from "@kantel/contracts";
import type { Passkeys } from "./passkey.ts";

/** The largest body a passkey route takes: a registration's attestation object and client data, a few KiB. */
export const PASSKEY_BODY_LIMIT = 64 * 1024;

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

function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
	return json(status, { error: { code, message, ...extra } });
}

function failed(error: unknown): Response {
	if (isKantelError(error) && isErrorCode(error.code)) {
		const passkey = error.details?.passkey;
		return errorResponse(STATUS[error.code], error.code, error.message, passkey === undefined ? {} : { passkey });
	}
	return errorResponse(500, "internal", "Internal error");
}

type Route =
	| { readonly name: "passkeys" | "registration" | "confirmation" }
	| { readonly name: "remove"; readonly passkeyId: string }
	| { readonly name: "reset"; readonly userId: string };

const ALLOW: Readonly<Record<Route["name"], readonly string[]>> = {
	passkeys: ["GET", "POST"],
	registration: ["POST"],
	confirmation: ["POST"],
	remove: ["POST"],
	reset: ["POST"],
};

const REMOVE_SUFFIX = "/remove";
const MEMBERS_PREFIX = "/v1/members/";
const RESET_SUFFIX = "/passkeys/reset";

/** The one path segment between `prefix` and `suffix`, decoded, or undefined. */
function segmentOf(path: string, prefix: string, suffix: string): string | undefined {
	if (!path.startsWith(prefix) || !path.endsWith(suffix) || path.length <= prefix.length + suffix.length) {
		return undefined;
	}
	const segment = path.slice(prefix.length, -suffix.length);
	if (segment.includes("/")) return undefined;
	try {
		return decodeURIComponent(segment);
	} catch {
		return undefined;
	}
}

function routeOf(path: string): Route | undefined {
	if (path === PASSKEYS_PATH) return { name: "passkeys" };
	if (path === PASSKEY_REGISTRATION_PATH) return { name: "registration" };
	if (path === PASSKEY_CONFIRMATION_PATH) return { name: "confirmation" };
	const passkeyId = segmentOf(path, `${PASSKEYS_PATH}/`, REMOVE_SUFFIX);
	if (passkeyId !== undefined) return { name: "remove", passkeyId };
	const userId = segmentOf(path, MEMBERS_PREFIX, RESET_SUFFIX);
	if (userId !== undefined) return { name: "reset", userId };
	return undefined;
}

/** The change a confirmation body names, or `invalid`. */
function changeOf(body: unknown): PasskeyChange {
	if (isRecord(body) && body.change === "register" && Object.keys(body).length === 1) return { change: "register" };
	if (
		isRecord(body) &&
		body.change === "remove" &&
		typeof body.passkeyId === "string" &&
		body.passkeyId !== "" &&
		Object.keys(body).length === 2
	) {
		return { change: "remove", passkeyId: body.passkeyId };
	}
	throw new KantelError("invalid", 'The body is { change: "register" } or { change: "remove", passkeyId }');
}

/** A `confirmation` field: absent, or an object for the passkeys to verify. */
function confirmationOf(value: unknown): PasskeyAssertion | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new KantelError("invalid", "confirmation must be a passkey assertion");
	return value as unknown as PasskeyAssertion;
}

/** Whether the path is one this handler serves, for a router deciding where a request goes. */
export function isPasskeyPath(path: string): boolean {
	return routeOf(path) !== undefined;
}

const sendsJson = (request: Request): boolean =>
	/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "");

async function readJson(request: Request): Promise<unknown> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > PASSKEY_BODY_LIMIT) throw new KantelError("invalid", "The body is too large");
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > PASSKEY_BODY_LIMIT) {
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

export interface PasskeyHandlerOptions {
	readonly passkeys: Passkeys;
	readonly authenticator: Authenticator;
	/** The relying party for a request. Default the request's own origin (`relyingPartyFor`). */
	readonly relyingParty?: (request: Request) => RelyingParty;
	/** How a person signs in here, named in every 401, as `createIdentityHandler` does. */
	readonly signIn?: readonly SignInMethod[];
}

/**
 * Serves the passkey routes; any other path is 404, any other method 405. Every call is authenticated first (401 with a
 * challenge, or 403 for an organisation the caller may not act in), and only a person has passkeys: anyone else is 403.
 * POSTs need a JSON content type (else 415). Errors other than `KantelError`s are 500 with no detail.
 */
export function createPasskeyHandler(options: PasskeyHandlerOptions): (request: Request) => Promise<Response> {
	const { passkeys, authenticator } = options;
	const relyingParty = options.relyingParty ?? ((request: Request) => relyingPartyFor(request.url));
	const signIn = options.signIn?.filter((method) => SIGN_IN_METHODS.includes(method));

	return async (request) => {
		const route = routeOf(new URL(request.url).pathname);
		if (route === undefined) return errorResponse(404, "not_found", "No such route");
		const allowed = ALLOW[route.name];
		if (!allowed.includes(request.method)) {
			return json(
				405,
				{ error: { code: "invalid", message: `Use ${allowed.join(" or ")}` } },
				{ allow: allowed.join(", ") },
			);
		}

		let ctx: ReturnType<typeof callContextFor>;
		try {
			const caller = await authenticator.authenticate(request);
			const requestId = request.headers.get("kantel-request-id") ?? undefined;
			ctx = callContextFor(caller, { ...(requestId === undefined ? {} : { requestId }), signal: request.signal });
		} catch (error) {
			const failure = authenticationFailureOf(error);
			if (failure === "organisation") {
				const message = isKantelError(error) ? error.message : "You may not act here";
				return json(403, { error: { code: "forbidden", failure, message } });
			}
			if (failure !== undefined) {
				const body: UnauthenticatedResponse = {
					error: {
						code: "unauthenticated",
						message: failure === "missing" ? "This call needs credentials" : "The credentials are not valid",
						...(signIn === undefined ? {} : { signIn }),
					},
				};
				return json(401, body, { "www-authenticate": `Bearer realm="kantel"` });
			}
			if (isKantelError(error, "unavailable")) return errorResponse(503, "unavailable", "Sign-in is unavailable");
			return failed(error);
		}

		try {
			if (ctx.actor.kind !== "human") throw new KantelError("forbidden", "Only a person has passkeys");
			if (request.method === "GET") {
				const body: PasskeysResponse = { items: await passkeys.list(ctx), approvals: passkeys.approvals };
				return json(200, body);
			}
			if (!sendsJson(request)) return errorResponse(415, "invalid", "Send the body as application/json");
			const body = await readJson(request);
			if (route.name === "registration" || route.name === "reset") {
				if (!isRecord(body) || Object.keys(body).length > 0) {
					throw new KantelError("invalid", "The body is {}");
				}
				if (route.name === "reset") {
					const reset: PasskeyResetResponse = { removed: await passkeys.reset(ctx, route.userId) };
					return json(200, reset);
				}
				const options: PasskeyRegistrationOptions = await passkeys.registrationOptions(ctx, relyingParty(request));
				return json(200, options);
			}
			if (route.name === "confirmation") {
				const challenge: PasskeyChallenge = await passkeys.changeChallenge(ctx, relyingParty(request), changeOf(body));
				return json(200, challenge);
			}
			if (route.name === "remove") {
				if (!isRecord(body) || Object.keys(body).some((field) => field !== "confirmation")) {
					throw new KantelError("invalid", "The body is { confirmation }");
				}
				await passkeys.remove(ctx, route.passkeyId, confirmationOf(body.confirmation));
				return new Response(null, { status: 204, headers: NO_STORE });
			}
			if (!isRecord(body) || !isRecord(body.response)) {
				throw new KantelError("invalid", "The body is { response, name?, confirmation? }");
			}
			for (const field of Object.keys(body)) {
				if (field !== "response" && field !== "name" && field !== "confirmation") {
					throw new KantelError("invalid", `Unknown field ${field}`);
				}
			}
			if (body.name !== undefined && typeof body.name !== "string") {
				throw new KantelError("invalid", "name must be a string");
			}
			const registered: Passkey = await passkeys.register(
				ctx,
				body.response as unknown as PasskeyAttestation,
				body.name as string | undefined,
				confirmationOf(body.confirmation),
			);
			return json(201, registered);
		} catch (error) {
			return failed(error);
		}
	};
}

export interface PasskeyClientOptions {
	/** Where Kantel is served. Default the page's own origin. */
	readonly baseUrl?: string;
	/** Headers for every call, such as credentials. The browser behind Cloudflare Access needs none. */
	readonly headers?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
	readonly fetch?: typeof fetch;
}

export interface PasskeyClient {
	list(signal?: AbortSignal): Promise<PasskeysResponse>;
	registrationOptions(signal?: AbortSignal): Promise<PasskeyRegistrationOptions>;
	register(request: RegisterPasskeyRequest, signal?: AbortSignal): Promise<Passkey>;
	/** A challenge for confirming `change` with one of the person's passkeys. */
	confirmation(change: PasskeyChange, signal?: AbortSignal): Promise<PasskeyChallenge>;
	remove(passkeyId: string, confirmation?: PasskeyAssertion, signal?: AbortSignal): Promise<void>;
	/** An admin removes every passkey a member has. */
	reset(userId: string, signal?: AbortSignal): Promise<PasskeyResetResponse>;
}

/**
 * A client for the passkey routes. Failures reject with a `KantelError` carrying the server's code (and
 * `details.passkey` for a refusal); a 401 is `forbidden` with `details.authentication: "invalid"`, a 404 for the
 * routes themselves `not_supported` (the deployment has no passkeys), and a network failure `unavailable`.
 */
export function createPasskeyClient(options: PasskeyClientOptions = {}): PasskeyClient {
	const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const base = (options.baseUrl ?? "").replace(/\/+$/, "");

	async function call<T>(path: string, init: { body?: unknown; signal: AbortSignal | undefined }): Promise<T> {
		const headers = new Headers((await options.headers?.()) ?? {});
		if (init.body !== undefined) headers.set("content-type", "application/json");
		let response: Response;
		try {
			response = await doFetch(`${base}${path}`, {
				method: init.body === undefined ? "GET" : "POST",
				headers,
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				...(init.signal === undefined ? {} : { signal: init.signal }),
			});
		} catch (error) {
			if (init.signal?.aborted) throw error;
			throw new KantelError("unavailable", "Can't reach Kantel. Check your connection.");
		}
		if (response.status === 204) return undefined as T;
		const parsed = (await response.json().catch(() => undefined)) as unknown;
		if (response.ok) return parsed as T;
		const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
		const message = typeof error?.message === "string" ? error.message : `Kantel answered ${response.status}`;
		if (response.status === 401) throw new KantelError("forbidden", message, { authentication: "invalid" });
		const code = error?.code;
		if (response.status === 404 && code === "not_found" && path === PASSKEYS_PATH) {
			throw new KantelError("not_supported", "This Kantel has no passkeys");
		}
		const passkey = typeof error?.passkey === "string" ? { passkey: error.passkey } : undefined;
		throw new KantelError(isErrorCode(code) ? code : "unavailable", message, passkey);
	}

	return {
		list: (signal) => call(PASSKEYS_PATH, { signal }),
		registrationOptions: (signal) => call(PASSKEY_REGISTRATION_PATH, { body: {}, signal }),
		register: (request, signal) => call(PASSKEYS_PATH, { body: request, signal }),
		confirmation: (change, signal) => call(PASSKEY_CONFIRMATION_PATH, { body: change, signal }),
		remove: (passkeyId, confirmation, signal) =>
			call(passkeyRemovePath(passkeyId), { body: confirmation === undefined ? {} : { confirmation }, signal }),
		reset: (userId, signal) => call(passkeyResetPath(userId), { body: {}, signal }),
	};
}
