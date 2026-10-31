/**
 * The egress decision API: the HTTP surface the egress proxy (`apps/vault-proxy`) and the model gateway call the vault
 * through, a typed client for it, and a shared-key authenticator for those callers. Portable (fetch `Request` and
 * `Response`, Web Crypto), so the self-hosted vault and the Cloudflare VaultDO serve the same handler.
 *
 * Routes, under `basePath` (default none), both `POST` with a JSON body:
 *
 * | Route | Body | Returns |
 * | --- | --- | --- |
 * | `/v1/egress/decisions` | `EgressRequest` | `EgressDecision` |
 * | `/v1/connector-credentials` | `ConnectorCredentialRequest` | `ConnectorCredential` |
 * | `/v1/egress/session-placeholders` | `SessionPlaceholderRequest` | `SessionPlaceholders` |
 * | `/v1/egress/session-open` | `ModelCallScope` | `{ "open": true }`, or `refused` (403) for a blocked or ended session |
 *
 * All are worker calls: `authenticate` names the calling component as a `SystemContext`, and the vault refuses any
 * other caller. Errors are `{ "error": { "code", "message" } }` with one status per `ErrorCode`, and never carry a
 * value. Every response is `cache-control: no-store`.
 */
import {
	type ConnectorCredential,
	type ConnectorCredentialRequest,
	type EgressDecision,
	type EgressRequest,
	type ErrorCode,
	isKantelError,
	KantelError,
	type ModelCallScope,
	type SessionPlaceholderRequest,
	type SessionPlaceholders,
	type SystemContext,
	systemContext,
} from "@kantel/contracts";
import type { KantelVault } from "./engine.ts";
import { HTTP_METHODS } from "./index.ts";

export const EGRESS_API_PATHS = {
	decisions: "/v1/egress/decisions",
	connectorCredentials: "/v1/connector-credentials",
	sessionPlaceholders: "/v1/egress/session-placeholders",
	sessionOpen: "/v1/egress/session-open",
} as const;

type EgressApiRoute = keyof typeof EGRESS_API_PATHS;

/** Every `ErrorCode` and the status it answers with, as the workspace read API does. */
const STATUS: { readonly [code in ErrorCode]: number } = {
	invalid: 400,
	forbidden: 403,
	refused: 403,
	not_found: 404,
	conflict: 409,
	expired: 410,
	exhausted: 429,
	aborted: 499,
	not_supported: 501,
	unavailable: 503,
};

const isErrorCode = (code: unknown): code is ErrorCode => typeof code === "string" && Object.hasOwn(STATUS, code);

/** The HTTP status for a Kantel error code. */
export function egressErrorStatus(code: ErrorCode): number {
	return STATUS[code] ?? 500;
}

export interface EgressDecisionApiOptions {
	readonly vault: Pick<KantelVault, "decideEgress" | "readConnectorCredential"> &
		Partial<Pick<KantelVault, "issueSessionPlaceholders" | "assertSessionOpen">>;
	/**
	 * The calling component, from the request (such as `createSharedKeyAuthenticator`). Throw a `KantelError` to refuse;
	 * its code sets the status.
	 */
	readonly authenticate: (request: Request) => Promise<SystemContext>;
	/** Route prefix, without a trailing slash. Default none. */
	readonly basePath?: string;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});
}

function errorResponse(status: number, code: ErrorCode, message: string, headers?: Record<string, string>): Response {
	return json(status, { error: { code, message } }, headers);
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects with `invalid` unless `body` has the shape of an `EgressRequest`. */
function egressRequestOf(body: unknown): EgressRequest {
	const optional = (value: unknown) => value === undefined || typeof value === "string";
	if (
		!isRecord(body) ||
		typeof body.organisationId !== "string" ||
		typeof body.url !== "string" ||
		!HTTP_METHODS.includes(body.method as EgressRequest["method"]) ||
		!optional(body.projectId) ||
		!optional(body.agentId) ||
		!optional(body.sessionId) ||
		!optional(body.placeholder)
	) {
		throw new KantelError("invalid", "An egress request needs an organisation, a known method and a URL");
	}
	return body as unknown as EgressRequest;
}

/**
 * Serves the egress decision API. Paths outside it are `not_found` and other methods `not_supported` (405); a body
 * that is not JSON of the right shape is `invalid`. Errors other than `KantelError`s are 500 with no detail.
 */
export function createEgressDecisionApi(options: EgressDecisionApiOptions): (request: Request) => Promise<Response> {
	const base = (options.basePath ?? "").replace(/\/+$/, "");
	const { vault } = options;

	return async (request) => {
		const path = new URL(request.url).pathname;
		const route = (Object.keys(EGRESS_API_PATHS) as EgressApiRoute[]).find(
			(name) => path === `${base}${EGRESS_API_PATHS[name]}`,
		);
		if (route === undefined) return errorResponse(404, "not_found", "No such route");
		if (request.method !== "POST") return errorResponse(405, "not_supported", "Use POST", { allow: "POST" });
		try {
			const caller = await options.authenticate(request);
			const ctx: SystemContext = { ...caller, signal: request.signal };
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				throw new KantelError("invalid", "The body must be JSON");
			}
			if (route === "decisions") return json(200, await vault.decideEgress(ctx, egressRequestOf(body)));
			if (!isRecord(body)) throw new KantelError("invalid", "The body must be a JSON object");
			if (route === "sessionPlaceholders") {
				if (vault.issueSessionPlaceholders === undefined) {
					throw new KantelError("not_supported", "This vault issues no session placeholders");
				}
				return json(200, await vault.issueSessionPlaceholders(ctx, body as unknown as SessionPlaceholderRequest));
			}
			if (route === "sessionOpen") {
				if (vault.assertSessionOpen === undefined) {
					throw new KantelError("not_supported", "This vault keeps no session access");
				}
				await vault.assertSessionOpen(ctx, body as unknown as ModelCallScope);
				return json(200, { open: true });
			}
			return json(200, await vault.readConnectorCredential(ctx, body as unknown as ConnectorCredentialRequest));
		} catch (error) {
			if (isKantelError(error) && isErrorCode(error.code)) {
				return errorResponse(egressErrorStatus(error.code), error.code, error.message);
			}
			return errorResponse(500, "unavailable", "The egress decision API failed");
		}
	};
}

export interface EgressDecisionClientOptions {
	/** Where the API is served, including any base path, such as `http://vault.internal:8080`. */
	readonly baseUrl: string;
	/** The calling component's shared key, sent as `Authorization: Bearer <token>`. */
	readonly token: string;
	readonly fetch?: typeof fetch;
}

export interface EgressDecisionClient {
	decideEgress(request: EgressRequest, signal?: AbortSignal): Promise<EgressDecision>;
	readConnectorCredential(request: ConnectorCredentialRequest, signal?: AbortSignal): Promise<ConnectorCredential>;
	issueSessionPlaceholders(request: SessionPlaceholderRequest, signal?: AbortSignal): Promise<SessionPlaceholders>;
	assertSessionOpen(scope: ModelCallScope, signal?: AbortSignal): Promise<void>;
}

/** A client for the egress decision API. Failures reject with a `KantelError` carrying the server's code. */
export function createEgressDecisionClient(options: EgressDecisionClientOptions): EgressDecisionClient {
	const doFetch = options.fetch ?? fetch;
	const base = options.baseUrl.replace(/\/+$/, "");

	async function call<T>(path: string, body: unknown, signal: AbortSignal | undefined): Promise<T> {
		const response = await doFetch(`${base}${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			...(signal === undefined ? {} : { signal }),
		});
		const parsed = (await response.json().catch(() => undefined)) as unknown;
		if (response.ok) return parsed as T;
		const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
		const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
		throw new KantelError(isErrorCode(error?.code) ? error.code : "unavailable", message);
	}

	return {
		decideEgress: (request, signal) => call<EgressDecision>(EGRESS_API_PATHS.decisions, request, signal),
		readConnectorCredential: (request, signal) =>
			call<ConnectorCredential>(EGRESS_API_PATHS.connectorCredentials, request, signal),
		issueSessionPlaceholders: (request, signal) =>
			call<SessionPlaceholders>(EGRESS_API_PATHS.sessionPlaceholders, request, signal),
		assertSessionOpen: async (scope, signal) => {
			await call<unknown>(EGRESS_API_PATHS.sessionOpen, scope, signal);
		},
	};
}

export interface SharedKeyAuthenticatorOptions {
	/** Each calling component's shared key, such as `{ "egress-gateway": "<secret>" }`. */
	readonly keys: { readonly [component: string]: string };
}

async function digest(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Checks `Authorization: Bearer <key>` against each component's shared key in constant time (SHA-256 of both sides,
 * compared in full, every key tried) and resolves the matching component's `SystemContext`. Anything else is
 * `forbidden`, saying nothing about which keys exist.
 */
export function createSharedKeyAuthenticator(
	options: SharedKeyAuthenticatorOptions,
): (request: Request) => Promise<SystemContext> {
	const entries = Object.entries(options.keys);
	for (const [component, key] of entries) {
		if (component.length === 0 || key.length < 16) {
			throw new KantelError("invalid", "Each component needs a name and a shared key of at least 16 characters");
		}
	}
	const keyDigests = Promise.all(entries.map(async ([component, key]) => ({ component, digest: await digest(key) })));

	return async (request) => {
		const header = request.headers.get("authorization") ?? "";
		const match = /^Bearer (\S+)$/i.exec(header.trim());
		if (match === null) throw new KantelError("forbidden", "This call needs a component's shared key");
		const presented = await digest(match[1]!);
		let found: string | undefined;
		for (const candidate of await keyDigests) {
			let difference = 0;
			for (let index = 0; index < presented.length; index += 1) {
				difference |= presented[index]! ^ candidate.digest[index]!;
			}
			if (difference === 0 && found === undefined) found = candidate.component;
		}
		if (found === undefined) throw new KantelError("forbidden", "This call needs a component's shared key");
		return systemContext(found);
	};
}
