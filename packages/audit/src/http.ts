/**
 * The audit query API over HTTP (`AUDIT_EVENTS_PATH` in the contract): a Fetch-style handler over any `AuditStore`,
 * and a client the audit view and host apps call it with. Portable: Workers, Bun and Node.
 */
import {
	AUDIT_EVENT_PATH,
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
	type CallContext,
	callContextFor,
	type ErrorCode,
	isKantelError,
	KantelError,
	type Page,
	type PageRequest,
	readHeader,
} from "@kantel/contracts";

/** Every `ErrorCode` and the status it answers with. */
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
	/**
	 * What the caller sees of each event the store let them read, such as Connections events from a private session they
	 * can't open, redacted (#335). Applied to every page and to a single event. Absent: events as stored.
	 */
	readonly present?: (ctx: CallContext, events: readonly AuditEvent[]) => Promise<readonly AuditEvent[]>;
}

/**
 * Serves `GET /v1/audit/events` and `GET /v1/audit/event?id=<id>`. Every call is authenticated first; the store then
 * decides what the caller may see (agents are refused, project viewers see their projects). Unknown paths are 404,
 * other methods 405. Errors other than `KantelError`s are 500 with no detail.
 */
export function createAuditQueryHandler(options: AuditQueryHandlerOptions): (request: Request) => Promise<Response> {
	return async (request) => {
		const url = new URL(request.url);
		const path = url.pathname;
		const isList = path === AUDIT_EVENTS_PATH;
		const isOne = path === AUDIT_EVENT_PATH;
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
					"www-authenticate": `Bearer realm="kantel"`,
				});
			}
			return failed(error);
		}

		const requestId = readHeader(request.headers, "kantel-request-id") ?? undefined;
		try {
			if (isList) {
				const { query, page } = auditQueryFromSearchParams(url.searchParams);
				const ctx = callContextFor(caller, {
					...(query.projectId === undefined ? {} : { projectId: query.projectId }),
					...(requestId === undefined ? {} : { requestId }),
					signal: request.signal,
				});
				const result = await options.store.query(ctx, query, page);
				const items = options.present === undefined ? result.items : await options.present(ctx, result.items);
				const body: AuditEventsResponse =
					result.nextCursor === undefined ? { items } : { items, nextCursor: result.nextCursor };
				return json(200, body);
			}
			const names = [...url.searchParams.keys()];
			const id = url.searchParams.get("id");
			if (names.length !== 1 || names[0] !== "id" || id === null || id === "") {
				throw new KantelError("invalid", "This route takes exactly one parameter, a non-empty id");
			}
			const ctx = callContextFor(caller, {
				...(requestId === undefined ? {} : { requestId }),
				signal: request.signal,
			});
			const event = await options.store.get(ctx, id);
			const [shown] = options.present === undefined ? [event] : await options.present(ctx, [event]);
			if (shown === undefined) throw new KantelError("not_found", `No audit event ${id}`);
			const body: AuditEventResponse = { event: shown };
			return json(200, body);
		} catch (error) {
			return failed(error);
		}
	};
}

function failed(error: unknown): Response {
	if (isKantelError(error)) {
		const status = isErrorCode(error.code) ? STATUS[error.code] : 500;
		return errorResponse(status, error.code, status === 500 ? "Internal error" : error.message);
	}
	return errorResponse(500, "internal", "Internal error");
}

export interface AuditClientOptions {
	/** Kantel's base URL, such as `https://kantel.example.com`. */
	readonly baseUrl: string;
	/** Headers for every call: credentials, and `Kantel-Organisation` for a human. */
	readonly headers?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
	readonly fetch?: typeof fetch;
}

export interface AuditClient {
	query(query?: AuditQuery, page?: PageRequest, signal?: AbortSignal): Promise<Page<AuditEvent>>;
	get(eventId: string, signal?: AbortSignal): Promise<AuditEvent>;
}

/**
 * A client for the audit query API. Failures reject with a `KantelError` carrying the server's code (`unauthenticated`
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
		if (response.status === 401) throw new KantelError("forbidden", message, { authentication: "invalid" });
		const code = isErrorCode(error?.code) ? error.code : "unavailable";
		throw new KantelError(code, message);
	}

	return {
		async query(query = {}, page = {}, signal) {
			const params = auditQueryToSearchParams(query, page).toString();
			const body = await call<AuditEventsResponse>(`${AUDIT_EVENTS_PATH}${params === "" ? "" : `?${params}`}`, signal);
			return body.nextCursor === undefined ? { items: body.items } : { items: body.items, nextCursor: body.nextCursor };
		},
		async get(eventId, signal) {
			if (typeof eventId !== "string" || eventId === "") throw new KantelError("invalid", "An event id is needed");
			const params = new URLSearchParams({ id: eventId }).toString();
			const body = await call<AuditEventResponse>(`${AUDIT_EVENT_PATH}?${params}`, signal);
			return body.event;
		},
	};
}
