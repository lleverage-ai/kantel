/**
 * The session API over HTTP, as one portable fetch handler: it runs unchanged in a Worker, a Durable Object, Bun or
 * Node. It sits over the four runtime contracts, so it serves the in-memory runtime now and the persistent one later,
 * and takes the caller from an injected `Authenticator`. Routes are listed in `packages/runtime/HTTP.md`.
 */
import {
	type AgentProfile,
	type AgentProfiles,
	type AuthenticatedCaller,
	type Authenticator,
	authenticationFailureOf,
	type CallContext,
	type Clock,
	callContextFor,
	HarbourError,
	type HostToolBridge,
	type HostToolDefinition,
	isHarbourError,
	type PageRequest,
	type PromptInput,
	type SessionDirectory,
	type SessionFilter,
	type SessionRuntime,
	type SessionStatus,
	type Subscription,
	systemClock,
} from "@harbour/contracts";
import type { ServerFrame } from "@harbour/protocol";
import { callbackHostToolHandler, readBounded } from "./callback.ts";
import { encodeSse, frameEvent, readyEvent, SSE_COMMENT } from "./sse.ts";
import {
	type AbortBody,
	type CreateSessionBody,
	DEFAULT_BASE_PATH,
	errorResponse,
	HEADERS,
	json,
	MIN_CALLBACK_SECRET_LENGTH,
	type PendingResult,
	type RegisterHostBody,
	type RegisterHostResponse,
	unauthenticated,
} from "./wire.ts";

export interface SessionApiOptions {
	readonly runtime: SessionRuntime;
	readonly directory: SessionDirectory;
	readonly profiles: AgentProfiles;
	readonly hostTools: HostToolBridge;
	/** The deployment's authenticator, as every Harbour API takes it: `createAuthenticator` from `@harbour/identity`. */
	readonly authenticator: Authenticator;
	/** The prefix of every route. Default `/v1`. */
	readonly basePath?: string;
	readonly clock?: Clock;
	/** Used to call hosts back. Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/**
	 * Which callback URLs a host may register. Default: `https:` only. Harbour calls whatever is registered, so a
	 * deployment should narrow this to its hosts.
	 */
	readonly allowCallbackUrl?: (url: URL) => boolean;
	/** How long a host-tool callback may take. Default ten minutes. */
	readonly callbackTimeoutMs?: number;
	/** How long `GET …/result` waits by default (`?timeoutMs=` overrides, up to `maxResultWaitMs`). Default 25 s. */
	readonly resultWaitMs?: number;
	/** Default 120 s. */
	readonly maxResultWaitMs?: number;
	/** How often an idle event stream gets a comment, to keep proxies from closing it. Default 15 s. */
	readonly keepAliveMs?: number;
}

export interface SessionApi {
	/** Answers one request. Never rejects: every failure is a JSON error response. */
	fetch(request: Request): Promise<Response>;
	/** Ends every open event stream and every host registration made through this API. */
	close(): Promise<void>;
}

interface Registration {
	readonly subscription: Subscription;
	/** The credential that registered it; only it may remove it. */
	readonly owner: string;
	/** Names this registration, so a stale subscription cannot remove its replacement. */
	readonly registration: string;
}

const SESSION_STATUSES = new Set<SessionStatus>(["idle", "running", "waiting", "done", "failed", "cancelled"]);

function actorKey(ctx: CallContext): string {
	const actor = ctx.actor;
	switch (actor.kind) {
		case "human":
			return `human:${actor.userId}`;
		case "service":
			// Bound to the API key too: another key of the same service may hold other projects or a weaker role.
			return `service:${actor.serviceId}:${actor.keyId ?? ""}`;
		case "agent":
			return `agent:${actor.agentId}:${actor.sessionId}`;
		case "system":
			return `system:${actor.component}`;
	}
}

async function readJson<T>(request: Request): Promise<T> {
	const text = await readBounded(request);
	if (text.trim() === "") return {} as T;
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new HarbourError("invalid", "The body must be a JSON object");
		}
		return value as T;
	} catch (error) {
		if (isHarbourError(error)) throw error;
		throw new HarbourError("invalid", "The body is not JSON");
	}
}

function promptInput(body: Partial<PromptInput>): PromptInput {
	if (typeof body.text !== "string") throw new HarbourError("invalid", "A prompt needs text");
	if (body.requestId !== undefined && typeof body.requestId !== "string") {
		throw new HarbourError("invalid", "requestId must be a string");
	}
	return body.requestId === undefined ? { text: body.text } : { text: body.text, requestId: body.requestId };
}

function pageOf(params: URLSearchParams): PageRequest {
	const limit = params.get("limit");
	const cursor = params.get("cursor");
	if (limit !== null && !/^\d{1,4}$/.test(limit)) throw new HarbourError("invalid", "limit must be a number");
	return {
		...(limit === null ? {} : { limit: Number(limit) }),
		...(cursor === null ? {} : { cursor }),
	};
}

/** `?projectId=&agentId=&status=&parentSessionId=&label.<key>=<value>` */
function filterOf(params: URLSearchParams): SessionFilter {
	const labels: { [key: string]: string } = {};
	for (const [key, value] of params) if (key.startsWith("label.") && key.length > 6) labels[key.slice(6)] = value;
	const status = params.get("status");
	if (status !== null && !SESSION_STATUSES.has(status as SessionStatus)) {
		throw new HarbourError("invalid", `Unknown status ${status}`);
	}
	const projectId = params.get("projectId");
	const agentId = params.get("agentId");
	const parentSessionId = params.get("parentSessionId");
	return {
		...(projectId === null ? {} : { projectId }),
		...(agentId === null ? {} : { agentId }),
		...(status === null ? {} : { status: status as SessionStatus }),
		...(parentSessionId === null ? {} : { parentSessionId }),
		...(Object.keys(labels).length === 0 ? {} : { labels }),
	};
}

function validTools(tools: unknown): readonly HostToolDefinition[] {
	if (!Array.isArray(tools)) throw new HarbourError("invalid", "tools must be a list");
	for (const tool of tools as Partial<HostToolDefinition>[]) {
		if (
			typeof tool !== "object" ||
			tool === null ||
			typeof tool.name !== "string" ||
			typeof tool.description !== "string" ||
			typeof tool.inputSchema !== "object" ||
			tool.inputSchema === null ||
			(tool.replay !== "safe" && tool.replay !== "idempotent" && tool.replay !== "unsafe")
		) {
			throw new HarbourError("invalid", "Each tool needs a name, description, inputSchema and replay policy");
		}
	}
	return tools as HostToolDefinition[];
}

function randomSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const NOT_FOUND = new HarbourError("not_found", "No such route");

export function createSessionApi(options: SessionApiOptions): SessionApi {
	const { runtime, directory, profiles, hostTools } = options;
	const basePath = (options.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, "");
	const clock = options.clock ?? systemClock;
	const allowCallbackUrl = options.allowCallbackUrl ?? ((url: URL) => url.protocol === "https:");
	const resultWaitMs = options.resultWaitMs ?? 25_000;
	const maxResultWaitMs = options.maxResultWaitMs ?? 120_000;
	const keepAliveMs = options.keepAliveMs ?? 15_000;
	const registrations = new Map<string, Registration>();
	const streams = new Set<() => void>();

	const sessionRoutes = async (
		ctx: CallContext,
		request: Request,
		url: URL,
		sessionId: string,
		rest: readonly string[],
	): Promise<Response> => {
		const route = `${request.method} ${rest.join("/")}`;
		switch (route) {
			case "GET ":
				return json(await directory.get(ctx, sessionId));
			case "GET children":
				return json({ items: await directory.children(ctx, sessionId) });
			case "GET snapshot":
				return json(await runtime.snapshot(ctx, sessionId));
			case "POST prompt":
				return json(await runtime.prompt(ctx, sessionId, promptInput(await readJson(request))), 202);
			case "POST steer":
				return json(await runtime.steer(ctx, sessionId, promptInput(await readJson(request))), 202);
			case "POST follow-up":
				return json(await runtime.followUp(ctx, sessionId, promptInput(await readJson(request))), 202);
			case "POST abort": {
				const body = await readJson<AbortBody>(request);
				if (body.reason !== undefined && typeof body.reason !== "string") {
					throw new HarbourError("invalid", "reason must be a string");
				}
				await runtime.abort(ctx, sessionId, body.reason);
				return new Response(null, { status: 204 });
			}
			case "POST close":
				await runtime.close(ctx, sessionId);
				return new Response(null, { status: 204 });
			case "GET result":
				return result(ctx, request, url, sessionId);
			case "GET events":
				return events(ctx, request, url, sessionId);
		}
		throw NOT_FOUND;
	};

	/** Waits for a run's result up to a bound; a run still going answers 202 with `status: "pending"`. */
	const result = async (ctx: CallContext, request: Request, url: URL, sessionId: string): Promise<Response> => {
		const submissionId = url.searchParams.get("submission");
		if (submissionId === null || submissionId === "") throw new HarbourError("invalid", "Name the submission");
		const asked = url.searchParams.get("timeoutMs");
		if (asked !== null && !/^\d{1,7}$/.test(asked)) throw new HarbourError("invalid", "timeoutMs must be a number");
		const timeoutMs = Math.min(asked === null ? resultWaitMs : Number(asked), maxResultWaitMs);
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), timeoutMs);
		// A caller that goes away stops its wait (never the run); the deadline answers 202.
		const signal = AbortSignal.any([deadline.signal, request.signal]);
		try {
			const run = await runtime.wait({ ...ctx, signal }, sessionId, submissionId);
			return json(run);
		} catch (error) {
			if (request.signal.aborted) throw new HarbourError("aborted", "The caller went away");
			if (!deadline.signal.aborted) throw error;
			const pending: PendingResult = { status: "pending", sessionId, submissionId };
			return json(pending, 202);
		} finally {
			clearTimeout(timer);
		}
	};

	/** `watch` as server-sent events, resuming after `?after=` or `Last-Event-ID`. */
	const events = async (ctx: CallContext, request: Request, url: URL, sessionId: string): Promise<Response> => {
		const after = url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? undefined;
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let open = true;
		const queued: Uint8Array[] = [];
		const send = (chunk: Uint8Array) => {
			if (!open) return;
			if (controller === undefined) queued.push(chunk);
			else controller.enqueue(chunk);
		};
		// The first frames arrive before `watch` resolves; they are queued until the stream starts.
		const subscription = await runtime.watch(
			ctx,
			sessionId,
			after === undefined || after === "" ? {} : { after },
			(frame: ServerFrame) => send(encodeSse(frameEvent(frame))),
		);
		send(encodeSse(readyEvent));
		const keepAlive = setInterval(() => send(SSE_COMMENT), keepAliveMs);
		const stop = () => {
			if (!open) return;
			open = false;
			clearInterval(keepAlive);
			streams.delete(stop);
			request.signal.removeEventListener("abort", stop);
			void subscription.close();
			try {
				controller?.close();
			} catch {
				// Already closed or cancelled.
			}
		};
		streams.add(stop);
		request.signal.addEventListener("abort", stop, { once: true });
		// A caller that went away while the watch was being set up has missed the event.
		if (request.signal.aborted) stop();
		const body = new ReadableStream<Uint8Array>({
			start(started) {
				controller = started;
				for (const chunk of queued.splice(0)) started.enqueue(chunk);
				if (!open) started.close();
			},
			cancel: stop,
		});
		return new Response(body, {
			status: 200,
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				"x-accel-buffering": "no",
			},
		});
	};

	const hostRoutes = async (ctx: CallContext, request: Request, url: URL, hostId: string, rest: readonly string[]) => {
		const key = `${ctx.organisationId}\u0000${hostId}`;
		const route = `${request.method} ${rest.join("/")}`;
		switch (route) {
			case "PUT ": {
				const body = await readJson<Partial<RegisterHostBody>>(request);
				const tools = validTools(body.tools);
				const callback = body.callback;
				if (typeof callback !== "object" || callback === null || typeof callback.url !== "string") {
					throw new HarbourError("invalid", "A host needs a callback URL");
				}
				let target: URL;
				try {
					target = new URL(callback.url);
				} catch {
					throw new HarbourError("invalid", "The callback URL is not a URL");
				}
				if (target.username !== "" || target.password !== "" || !allowCallbackUrl(target)) {
					throw new HarbourError("refused", "This callback URL may not be registered");
				}
				if (
					callback.secret !== undefined &&
					(typeof callback.secret !== "string" || callback.secret.length < MIN_CALLBACK_SECRET_LENGTH)
				) {
					throw new HarbourError(
						"invalid",
						`A callback secret needs at least ${MIN_CALLBACK_SECRET_LENGTH} characters`,
					);
				}
				if (body.projectId !== undefined && typeof body.projectId !== "string") {
					throw new HarbourError("invalid", "projectId must be a string");
				}
				const generated = callback.secret === undefined ? randomSecret() : undefined;
				const handler = callbackHostToolHandler({
					url: target.href,
					secret: callback.secret ?? (generated as string),
					clock,
					...(options.fetch === undefined ? {} : { fetch: options.fetch }),
					...(options.callbackTimeoutMs === undefined ? {} : { timeoutMs: options.callbackTimeoutMs }),
				});
				const scoped: CallContext = body.projectId === undefined ? ctx : { ...ctx, projectId: body.projectId };
				const subscription = await hostTools.register(scoped, hostId, tools, handler);
				// The bridge replaced any earlier registration; closing that one now would change nothing.
				const registration = randomSecret();
				registrations.set(key, { subscription, owner: actorKey(ctx), registration });
				const response: RegisterHostResponse = {
					hostId,
					registration,
					tools,
					...(generated === undefined ? {} : { secret: generated }),
				};
				return json(response);
			}
			case "GET tools":
				return json({ items: await hostTools.list(ctx, hostId) });
			case "DELETE ": {
				const registration = registrations.get(key);
				const named = url.searchParams.get("registration");
				// A stale subscription (one since replaced) finds nothing of its own to remove.
				if (registration === undefined || (named !== null && named !== registration.registration)) {
					throw new HarbourError("not_found", `No such registration for host ${hostId}`);
				}
				if (registration.owner !== actorKey(ctx)) {
					throw new HarbourError("forbidden", "Only whoever registered a host may remove it");
				}
				registrations.delete(key);
				await registration.subscription.close();
				return new Response(null, { status: 204 });
			}
		}
		throw NOT_FOUND;
	};

	const profileRoutes = async (ctx: CallContext, request: Request, url: URL, rest: readonly string[]) => {
		const [agentId, ...more] = rest;
		if (agentId === undefined) {
			if (request.method === "GET") return json(await profiles.list(ctx, pageOf(url.searchParams)));
			throw NOT_FOUND;
		}
		if (more.length > 0) throw NOT_FOUND;
		if (request.method === "GET") return json(await profiles.get(ctx, agentId));
		if (request.method === "PUT") {
			const body = await readJson<AgentProfile>(request);
			if (body.id !== agentId) throw new HarbourError("invalid", "The profile's id must match the path");
			return json(await profiles.put(ctx, body));
		}
		throw NOT_FOUND;
	};

	const route = async (ctx: CallContext, request: Request, url: URL, segments: readonly string[]) => {
		const [area, id, ...rest] = segments;
		if (area === "sessions") {
			if (id === undefined) {
				if (request.method === "POST")
					return json(await runtime.create(ctx, await readJson<CreateSessionBody>(request)), 201);
				if (request.method === "GET") {
					return json(await directory.list(ctx, filterOf(url.searchParams), pageOf(url.searchParams)));
				}
				throw NOT_FOUND;
			}
			return sessionRoutes(ctx, request, url, id, rest);
		}
		if (area === "profiles") return profileRoutes(ctx, request, url, id === undefined ? [] : [id, ...rest]);
		if (area === "hosts" && id !== undefined) return hostRoutes(ctx, request, url, id, rest);
		throw NOT_FOUND;
	};

	return {
		async fetch(request) {
			try {
				const url = new URL(request.url);
				if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) throw NOT_FOUND;
				let segments: string[];
				try {
					segments = url.pathname
						.slice(basePath.length)
						.split("/")
						.filter((segment) => segment !== "")
						.map((segment) => decodeURIComponent(segment));
				} catch {
					throw new HarbourError("invalid", "The path is not valid");
				}
				let caller: AuthenticatedCaller;
				try {
					caller = await options.authenticator.authenticate(request);
				} catch (error) {
					const failure = authenticationFailureOf(error);
					if (failure === "organisation") {
						return errorResponse(new HarbourError("forbidden", "Not a member of this organisation"));
					}
					if (failure !== undefined) return unauthenticated();
					throw error;
				}
				// Harbour's own components call the runtime directly, never over HTTP.
				if (caller.actor.kind === "system") return unauthenticated();
				const requestId = request.headers.get(HEADERS.requestId);
				// The request's signal is not the call's: a run admitted by a prompt must outlive the request that sent
				// it. Only the result wait and the event stream end with their request.
				const ctx: CallContext = callContextFor(caller, requestId === null || requestId === "" ? {} : { requestId });
				return await route(ctx, request, url, segments);
			} catch (error) {
				return errorResponse(error);
			}
		},
		async close() {
			for (const stop of [...streams]) stop();
			const open = [...registrations.values()];
			registrations.clear();
			for (const registration of open) await registration.subscription.close();
		},
	};
}
