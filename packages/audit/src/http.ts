/**
 * The audit query API over HTTP (`AUDIT_EVENTS_PATH` in the contract): a Fetch-style handler over any `AuditStore`,
 * and a client the audit view and host apps call it with. Portable: Workers, Bun and Node.
 */
import {
	AUDIT_EVENTS_PATH,
	type AuditErrorResponse,
	type AuditEvent,
	type AuditEventResponse,
	type AuditEventsResponse,
	type AuditQuery,
	type AuditStore,
	type Authenticator,
	auditQueryFromSearchParams,
	auditQueryToSearchParams,
	authenticationFailureOf,
	callContextFor,
	type ErrorCode,
	HarbourError,
	isHarbourError,
	type Page,
	type PageRequest,
} from "@harbour/contracts";

const STATUS: Partial<Record<ErrorCode, number>> = {
	invalid: 400,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	not_supported: 501,
	unavailable: 503,
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});
}

function errorResponse(status: number, code: string, message: string, headers?: Record<string, string>): Response {
	const body: AuditErrorResponse = { error: { code, message } };
	return json(status, body, headers);
}

export interface AuditQueryHandlerOptions {
	readonly store: Pick<AuditStore, "query" | "get">;
	readonly authenticator: Authenticator;
}

/**
 * Serves `GET /v1/audit/events` and `GET /v1/audit/events/<id>`. Every call is authenticated first; the store then
 * decides what the caller may see (agents are refused, project viewers see their projects). Unknown paths are 404,
 * other methods 405. Errors other than `HarbourError`s are 500 with no detail.
 */
export function createAuditQueryHandler(options: AuditQueryHandlerOptions): (request: Request) => Promise<Response> {
	return async (request) => {
		const url = new URL(request.url);
		const path = url.pathname;
		const isList = path === AUDIT_EVENTS_PATH || path === `${AUDIT_EVENTS_PATH}/`;
		const isOne = !isList && path.startsWith(`${AUDIT_EVENTS_PATH}/`);
		if (!isList && !isOne) return errorResponse(404, "not_found", "No such route");
		if (request.method !== "GET") return errorResponse(405, "invalid", "Use GET", { allow: "GET" });

		let caller: Awaited<ReturnType<Authenticator["authenticate"]>>;
		try {
			caller = await options.authenticator.authenticate(request);
		} catch (error) {
			const failure = authenticationFailureOf(error);
			if (failure === "organisation") return errorResponse(403, "forbidden", "Not a member of this organisation");
			if (failure !== undefined) {
				return errorResponse(401, "unauthenticated", "This call needs valid credentials", {
					"www-authenticate": `Bearer realm="harbour"`,
				});
			}
			return failed(error);
		}

		const requestId = request.headers.get("harbour-request-id") ?? undefined;
		try {
			if (isList) {
				const { query, page } = auditQueryFromSearchParams(url.searchParams);
				const ctx = callContextFor(caller, {
					...(query.projectId === undefined ? {} : { projectId: query.projectId }),
					...(requestId === undefined ? {} : { requestId }),
					signal: request.signal,
				});
				const result = await options.store.query(ctx, query, page);
				const body: AuditEventsResponse =
					result.nextCursor === undefined
						? { items: result.items }
						: { items: result.items, nextCursor: result.nextCursor };
				return json(200, body);
			}
			const raw = path.slice(AUDIT_EVENTS_PATH.length + 1);
			if (raw.includes("/")) throw new HarbourError("not_found", "No such route");
			let id: string;
			try {
				id = decodeURIComponent(raw);
			} catch {
				throw new HarbourError("invalid", "The event id is not valid URI encoding");
			}
			if ([...url.searchParams.keys()].length > 0) throw new HarbourError("invalid", "This route takes no parameters");
			const ctx = callContextFor(caller, {
				...(requestId === undefined ? {} : { requestId }),
				signal: request.signal,
			});
			const body: AuditEventResponse = { event: await options.store.get(ctx, id) };
			return json(200, body);
		} catch (error) {
			return failed(error);
		}
	};
}

function failed(error: unknown): Response {
	if (isHarbourError(error)) {
		const status = STATUS[error.code] ?? 500;
		return errorResponse(status, error.code, status === 500 ? "Internal error" : error.message);
	}
	return errorResponse(500, "internal", "Internal error");
}

export interface AuditClientOptions {
	/** Harbour's base URL, such as `https://harbour.example.com`. */
	readonly baseUrl: string;
	/** Headers for every call: credentials, and `Harbour-Organisation` for a human. */
	readonly headers?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
	readonly fetch?: typeof fetch;
}

export interface AuditClient {
	query(query?: AuditQuery, page?: PageRequest, signal?: AbortSignal): Promise<Page<AuditEvent>>;
	get(eventId: string, signal?: AbortSignal): Promise<AuditEvent>;
}

/**
 * A client for the audit query API. Failures reject with a `HarbourError` carrying the server's code (`unauthenticated`
 * answers become `forbidden` with `details.authentication: "invalid"`).
 */
export function createAuditClient(options: AuditClientOptions): AuditClient {
	const doFetch = options.fetch ?? fetch;
	const base = options.baseUrl.replace(/\/+$/, "");

	async function call<T>(path: string, signal: AbortSignal | undefined): Promise<T> {
		const headers = options.headers === undefined ? undefined : await options.headers();
		const response = await doFetch(`${base}${path}`, {
			method: "GET",
			...(headers === undefined ? {} : { headers }),
			...(signal === undefined ? {} : { signal }),
		});
		const body = (await response.json().catch(() => undefined)) as unknown;
		if (response.ok) return body as T;
		const error = (body as Partial<AuditErrorResponse> | undefined)?.error;
		const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
		if (response.status === 401) throw new HarbourError("forbidden", message, { authentication: "invalid" });
		const code = typeof error?.code === "string" && error.code in STATUS ? (error.code as ErrorCode) : "unavailable";
		throw new HarbourError(code, message);
	}

	return {
		async query(query = {}, page = {}, signal) {
			const params = auditQueryToSearchParams(query, page).toString();
			const body = await call<AuditEventsResponse>(`${AUDIT_EVENTS_PATH}${params === "" ? "" : `?${params}`}`, signal);
			return body.nextCursor === undefined ? { items: body.items } : { items: body.items, nextCursor: body.nextCursor };
		},
		async get(eventId, signal) {
			const body = await call<AuditEventResponse>(`${AUDIT_EVENTS_PATH}/${encodeURIComponent(eventId)}`, signal);
			return body.event;
		},
	};
}
