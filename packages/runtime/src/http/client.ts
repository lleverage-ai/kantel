/**
 * A client for the session API that implements the runtime contracts (`SessionRuntime`, `SessionDirectory`,
 * `AgentProfiles`, `HostToolBridge`) over HTTP, so a host app such as Sal's supervisor codes against the contracts and
 * runs the same against the in-memory runtime or a deployed one. It needs only `fetch`, and no Pi.
 *
 * The server takes the caller from the request's credential, not from `ctx`: `credentials(ctx)` gives the headers for
 * a call (a host passes its API key whatever the context; the HTTP conformance test maps each context to a token).
 */
import {
	type AgentProfile,
	type AgentProfiles,
	type CallContext,
	HarbourError,
	type HostToolBridge,
	type HostToolHandler,
	type Page,
	type PageRequest,
	type RunResult,
	type SessionDirectory,
	type SessionFilter,
	type SessionRecord,
	type SessionRuntime,
	type Submission,
	type Subscription,
} from "@harbour/contracts";
import type { ServerFrame, SessionSnapshot } from "@harbour/protocol";
import { createHostToolEndpoint } from "./callback.ts";
import { readSse } from "./sse.ts";
import {
	errorFromResponse,
	HEADERS,
	type PendingResult,
	READY_EVENT,
	type RegisterHostBody,
	type RegisterHostResponse,
} from "./wire.ts";

/** Headers that authenticate a call. */
export type CredentialHeaders = { readonly [name: string]: string };

/** Where a host serves the callbacks for its tools. */
export interface HostCallbacks {
	/** The URL Harbour calls for `hostId`'s tools. */
	url(hostId: string): string;
	/** Starts serving `endpoint` at `url(hostId)`, or stops serving it when `endpoint` is undefined. */
	serve(hostId: string, endpoint: ((request: Request) => Promise<Response>) | undefined): void;
}

export interface SessionApiClientOptions {
	/** The API's base URL, such as `https://harbour.example/v1`. */
	readonly baseUrl: string;
	/** The headers that authenticate a call, such as `bearer(apiKey)`. */
	readonly credentials: (ctx: CallContext) => CredentialHeaders | Promise<CredentialHeaders>;
	readonly fetch?: typeof fetch;
	/** Needed for `hostTools.register`. */
	readonly hostCallbacks?: HostCallbacks;
	/** How long each `…/result` poll asks the server to wait. Default 25 s. */
	readonly resultPollMs?: number;
}

export interface SessionApiClient {
	readonly runtime: SessionRuntime;
	readonly directory: SessionDirectory;
	readonly profiles: AgentProfiles;
	readonly hostTools: HostToolBridge;
}

/** Credentials for a fixed bearer token, such as a host's API key. */
export function bearer(token: string): () => CredentialHeaders {
	return () => ({ authorization: `Bearer ${token}` });
}

const segment = encodeURIComponent;

function randomSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

function filterQuery(filter: SessionFilter | undefined, page: PageRequest | undefined): string {
	const params = new URLSearchParams();
	if (filter?.projectId !== undefined) params.set("projectId", filter.projectId);
	if (filter?.agentId !== undefined) params.set("agentId", filter.agentId);
	if (filter?.status !== undefined) params.set("status", filter.status);
	if (filter?.parentSessionId !== undefined) params.set("parentSessionId", filter.parentSessionId);
	for (const [key, value] of Object.entries(filter?.labels ?? {})) params.set(`label.${key}`, value);
	if (page?.limit !== undefined) params.set("limit", String(page.limit));
	if (page?.cursor !== undefined) params.set("cursor", page.cursor);
	const query = params.toString();
	return query === "" ? "" : `?${query}`;
}

export function createSessionApiClient(options: SessionApiClientOptions): SessionApiClient {
	const base = options.baseUrl.replace(/\/+$/, "");
	const doFetch = options.fetch ?? fetch;
	const resultPollMs = options.resultPollMs ?? 25_000;

	const send = async (
		ctx: CallContext,
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<Response> => {
		const headers = new Headers(await options.credentials(ctx));
		if (ctx.requestId !== undefined) headers.set(HEADERS.requestId, ctx.requestId);
		if (body !== undefined) headers.set("content-type", "application/json; charset=utf-8");
		const response = await doFetch(
			new Request(`${base}${path}`, {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				...(signal === undefined ? {} : { signal }),
			}),
		);
		if (!response.ok) throw await errorFromResponse(response);
		return response;
	};

	const call = async <T>(ctx: CallContext, method: string, path: string, body?: unknown): Promise<T> => {
		const response = await send(ctx, method, path, body, ctx.signal);
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	};

	const sessionPath = (sessionId: string, rest = "") => `/sessions/${segment(sessionId)}${rest}`;

	const runtime: SessionRuntime = {
		create: (ctx, input) => call<SessionRecord>(ctx, "POST", "/sessions", input),
		prompt: (ctx, sessionId, input) => call<Submission>(ctx, "POST", sessionPath(sessionId, "/prompt"), input),
		steer: (ctx, sessionId, input) => call<Submission>(ctx, "POST", sessionPath(sessionId, "/steer"), input),
		followUp: (ctx, sessionId, input) => call<Submission>(ctx, "POST", sessionPath(sessionId, "/follow-up"), input),
		abort: (ctx, sessionId, reason) =>
			call<void>(ctx, "POST", sessionPath(sessionId, "/abort"), reason === undefined ? {} : { reason }),
		close: (ctx, sessionId) => call<void>(ctx, "POST", sessionPath(sessionId, "/close"), {}),
		snapshot: (ctx, sessionId) => call<SessionSnapshot>(ctx, "GET", sessionPath(sessionId, "/snapshot")),
		async wait(ctx, sessionId, submissionId) {
			const path = sessionPath(sessionId, `/result?submission=${segment(submissionId)}&timeoutMs=${resultPollMs}`);
			for (;;) {
				ctx.signal?.throwIfAborted();
				const result = await call<RunResult | PendingResult>(ctx, "GET", path);
				if (result.status !== "pending") return result;
			}
		},
		async watch(ctx, sessionId, watchOptions, onFrame) {
			const controller = new AbortController();
			const signal = ctx.signal === undefined ? controller.signal : AbortSignal.any([ctx.signal, controller.signal]);
			const query = watchOptions.after === undefined ? "" : `?after=${segment(watchOptions.after)}`;
			const response = await send(ctx, "GET", sessionPath(sessionId, `/events${query}`), undefined, signal);
			if (response.body === null) throw new HarbourError("unavailable", "The event stream has no body");
			let ready: () => void = () => {};
			let failed: (error: unknown) => void = () => {};
			const started = new Promise<void>((resolve, reject) => {
				ready = resolve;
				failed = reject;
			});
			let isReady = false;
			const reading = readSse(response.body, (event) => {
				if (controller.signal.aborted) return false;
				if (event.event === READY_EVENT) {
					isReady = true;
					ready();
					return true;
				}
				onFrame(JSON.parse(event.data) as ServerFrame);
				return true;
			});
			reading.then(
				() => {
					if (!isReady) failed(new HarbourError("unavailable", "The event stream ended before it was ready"));
					else if (!controller.signal.aborted) {
						onFrame({ type: "error", code: "unavailable", message: "The event stream ended" });
					}
				},
				(error: unknown) => {
					if (!isReady) failed(error);
					else if (!controller.signal.aborted) {
						onFrame({ type: "error", code: "unavailable", message: "The event stream failed" });
					}
				},
			);
			try {
				await started;
			} catch (error) {
				controller.abort();
				throw error;
			}
			return {
				async close() {
					controller.abort();
					await reading.catch(() => {});
				},
			};
		},
	};

	const directory: SessionDirectory = {
		get: (ctx, sessionId) => call<SessionRecord>(ctx, "GET", sessionPath(sessionId)),
		list: (ctx, filter, page) => call<Page<SessionRecord>>(ctx, "GET", `/sessions${filterQuery(filter, page)}`),
		async children(ctx, sessionId) {
			return (await call<{ items: SessionRecord[] }>(ctx, "GET", sessionPath(sessionId, "/children"))).items;
		},
	};

	const profiles: AgentProfiles = {
		put: (ctx, profile) => call<AgentProfile>(ctx, "PUT", `/profiles/${segment(profile.id)}`, profile),
		get: (ctx, agentId) => call<AgentProfile>(ctx, "GET", `/profiles/${segment(agentId)}`),
		list: (ctx, page) => call<Page<AgentProfile>>(ctx, "GET", `/profiles${filterQuery(undefined, page)}`),
	};

	/** The endpoint each host currently serves, so a refused registration can put the earlier one back. */
	const serving = new Map<string, (request: Request) => Promise<Response>>();

	const hostTools: HostToolBridge = {
		async register(ctx, hostId, tools, handler: HostToolHandler): Promise<Subscription> {
			const callbacks = options.hostCallbacks;
			if (callbacks === undefined) throw new HarbourError("not_supported", "This client serves no host callbacks");
			const secret = randomSecret();
			const endpoint = createHostToolEndpoint(handler, { secret });
			const previous = serving.get(hostId);
			// Serve first, so a call that arrives as soon as the registration lands finds the endpoint.
			serving.set(hostId, endpoint);
			callbacks.serve(hostId, endpoint);
			const body: RegisterHostBody = {
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				tools,
				callback: { url: callbacks.url(hostId), secret },
			};
			let registered: RegisterHostResponse;
			try {
				registered = await call<RegisterHostResponse>(ctx, "PUT", `/hosts/${segment(hostId)}`, body);
			} catch (error) {
				if (serving.get(hostId) === endpoint) {
					if (previous === undefined) serving.delete(hostId);
					else serving.set(hostId, previous);
					callbacks.serve(hostId, previous);
				}
				throw error;
			}
			let closed = false;
			return {
				async close() {
					if (closed) return;
					closed = true;
					if (serving.get(hostId) !== endpoint) return;
					const path = `/hosts/${segment(hostId)}?registration=${segment(registered.registration)}`;
					await call<void>(ctx, "DELETE", path).catch((error: unknown) => {
						// Already gone, or replaced by someone else: nothing of ours is left to remove.
						if (!(error instanceof HarbourError) || (error.code !== "not_found" && error.code !== "forbidden")) {
							throw error;
						}
					});
					if (serving.get(hostId) === endpoint) {
						serving.delete(hostId);
						callbacks.serve(hostId, undefined);
					}
				},
			};
		},
		async list(ctx, hostId) {
			return (await call<{ items: RegisterHostBody["tools"] }>(ctx, "GET", `/hosts/${segment(hostId)}/tools`)).items;
		},
	};

	return { runtime, directory, profiles, hostTools };
}
