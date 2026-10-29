/**
 * A person's passkeys over HTTP (#132): `GET` and `POST /v1/me/passkeys`, `POST /v1/me/passkeys/registration` and
 * `POST /v1/me/passkeys/:id/remove` (`PASSKEYS_PATH`; the bodies are in `packages/contracts/src/passkey.ts`). A
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
	HarbourError,
	isHarbourError,
	PASSKEY_REGISTRATION_PATH,
	PASSKEYS_PATH,
	type Passkey,
	type PasskeyAttestation,
	type PasskeyRegistrationOptions,
	type PasskeysResponse,
	passkeyRemovePath,
	type RegisterPasskeyRequest,
	type RelyingParty,
	relyingPartyFor,
	SIGN_IN_METHODS,
	type SignInMethod,
	type UnauthenticatedResponse,
} from "@harbour/contracts";
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
	if (isHarbourError(error) && isErrorCode(error.code)) {
		const passkey = error.details?.passkey;
		return errorResponse(STATUS[error.code], error.code, error.message, passkey === undefined ? {} : { passkey });
	}
	return errorResponse(500, "internal", "Internal error");
}

type Route = { readonly name: "passkeys" | "registration" } | { readonly name: "remove"; readonly passkeyId: string };

const ALLOW: Readonly<Record<Route["name"], readonly string[]>> = {
	passkeys: ["GET", "POST"],
	registration: ["POST"],
	remove: ["POST"],
};

const REMOVE_SUFFIX = "/remove";

function routeOf(path: string): Route | undefined {
	if (path === PASSKEYS_PATH) return { name: "passkeys" };
	if (path === PASSKEY_REGISTRATION_PATH) return { name: "registration" };
	if (!path.startsWith(`${PASSKEYS_PATH}/`) || !path.endsWith(REMOVE_SUFFIX)) return undefined;
	const segment = path.slice(PASSKEYS_PATH.length + 1, -REMOVE_SUFFIX.length);
	if (segment === "" || segment.includes("/")) return undefined;
	try {
		return { name: "remove", passkeyId: decodeURIComponent(segment) };
	} catch {
		return undefined;
	}
}

/** Whether the path is one this handler serves, for a router deciding where a request goes. */
export function isPasskeyPath(path: string): boolean {
	return routeOf(path) !== undefined;
}

const sendsJson = (request: Request): boolean =>
	/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "");

async function readJson(request: Request): Promise<unknown> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > PASSKEY_BODY_LIMIT) throw new HarbourError("invalid", "The body is too large");
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > PASSKEY_BODY_LIMIT) {
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
 * POSTs need a JSON content type (else 415). Errors other than `HarbourError`s are 500 with no detail.
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
			const requestId = request.headers.get("harbour-request-id") ?? undefined;
			ctx = callContextFor(caller, { ...(requestId === undefined ? {} : { requestId }), signal: request.signal });
		} catch (error) {
			const failure = authenticationFailureOf(error);
			if (failure === "organisation") {
				const message = isHarbourError(error) ? error.message : "You may not act here";
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
				return json(401, body, { "www-authenticate": `Bearer realm="harbour"` });
			}
			if (isHarbourError(error, "unavailable")) return errorResponse(503, "unavailable", "Sign-in is unavailable");
			return failed(error);
		}

		try {
			if (ctx.actor.kind !== "human") throw new HarbourError("forbidden", "Only a person has passkeys");
			if (request.method === "GET") {
				const body: PasskeysResponse = { items: await passkeys.list(ctx), approvals: passkeys.approvals };
				return json(200, body);
			}
			if (!sendsJson(request)) return errorResponse(415, "invalid", "Send the body as application/json");
			const body = await readJson(request);
			if (route.name === "registration" || route.name === "remove") {
				if (!isRecord(body) || Object.keys(body).length > 0) {
					throw new HarbourError("invalid", "The body is {}");
				}
				if (route.name === "remove") {
					await passkeys.remove(ctx, route.passkeyId);
					return new Response(null, { status: 204, headers: NO_STORE });
				}
				const options: PasskeyRegistrationOptions = await passkeys.registrationOptions(ctx, relyingParty(request));
				return json(200, options);
			}
			if (!isRecord(body) || !isRecord(body.response)) {
				throw new HarbourError("invalid", "The body is { response, name? }");
			}
			for (const field of Object.keys(body)) {
				if (field !== "response" && field !== "name") throw new HarbourError("invalid", `Unknown field ${field}`);
			}
			if (body.name !== undefined && typeof body.name !== "string") {
				throw new HarbourError("invalid", "name must be a string");
			}
			const registered: Passkey = await passkeys.register(
				ctx,
				body.response as unknown as PasskeyAttestation,
				body.name as string | undefined,
			);
			return json(201, registered);
		} catch (error) {
			return failed(error);
		}
	};
}

export interface PasskeyClientOptions {
	/** Where Harbour is served. Default the page's own origin. */
	readonly baseUrl?: string;
	/** Headers for every call, such as credentials. The browser behind Cloudflare Access needs none. */
	readonly headers?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
	readonly fetch?: typeof fetch;
}

export interface PasskeyClient {
	list(signal?: AbortSignal): Promise<PasskeysResponse>;
	registrationOptions(signal?: AbortSignal): Promise<PasskeyRegistrationOptions>;
	register(request: RegisterPasskeyRequest, signal?: AbortSignal): Promise<Passkey>;
	remove(passkeyId: string, signal?: AbortSignal): Promise<void>;
}

/**
 * A client for the passkey routes. Failures reject with a `HarbourError` carrying the server's code (and
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
			throw new HarbourError("unavailable", "Can't reach Harbour. Check your connection.");
		}
		if (response.status === 204) return undefined as T;
		const parsed = (await response.json().catch(() => undefined)) as unknown;
		if (response.ok) return parsed as T;
		const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
		const message = typeof error?.message === "string" ? error.message : `Harbour answered ${response.status}`;
		if (response.status === 401) throw new HarbourError("forbidden", message, { authentication: "invalid" });
		const code = error?.code;
		if (response.status === 404 && code === "not_found" && path === PASSKEYS_PATH) {
			throw new HarbourError("not_supported", "This Harbour has no passkeys");
		}
		const passkey = typeof error?.passkey === "string" ? { passkey: error.passkey } : undefined;
		throw new HarbourError(isErrorCode(code) ? code : "unavailable", message, passkey);
	}

	return {
		list: (signal) => call(PASSKEYS_PATH, { signal }),
		registrationOptions: (signal) => call(PASSKEY_REGISTRATION_PATH, { body: {}, signal }),
		register: (request, signal) => call(PASSKEYS_PATH, { body: request, signal }),
		remove: (passkeyId, signal) => call(passkeyRemovePath(passkeyId), { body: {}, signal }),
	};
}
