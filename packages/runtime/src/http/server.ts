/**
 * The session API over HTTP, as one portable fetch handler: it runs unchanged in a Worker, a Durable Object, Bun or
 * Node. It sits over the four runtime contracts, so it serves the in-memory runtime now and the persistent one later,
 * and takes the caller from an injected `Authenticator`. Routes are listed in `packages/runtime/HTTP.md`.
 */

import { createRouter, sessionRoutes as publicRoutes } from "@harbour/api";
import {
	type AgentProfile,
	type AgentProfiles,
	type AuthenticatedCaller,
	type Authenticator,
	authenticationFailureOf,
	type CallContext,
	type Clock,
	callContextFor,
	type EditSessionInput,
	HarbourError,
	type HostToolBridge,
	type HostToolDefinition,
	isHarbourError,
	type PageRequest,
	type PromptInput,
	type SessionBranching,
	type SessionDirectory,
	type SessionHistory,
	type SessionHistoryRequest,
	type SessionModels,
	type SessionOrganising,
	type SessionRecord,
	type SessionRuntime,
	type SessionUpdate,
	type Subscription,
	systemClock,
	type TranscriptImages,
} from "@harbour/contracts";
import type { ServerFrame } from "@harbour/protocol";
import { parseAttachments } from "../attachments.ts";
import type { DurableHosts } from "../runtime.ts";
import { callbackHostToolHandler, readBounded } from "./callback.ts";
import { encodeSse, frameEvent, readyEvent, SSE_COMMENT } from "./sse.ts";
import {
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
import {
	type AcceptWebSocket,
	frameBatcher,
	isWebSocketUpgrade,
	type ServerWebSocket,
	WS_CLOSE_GOING_AWAY,
	WS_KEEP_ALIVE,
} from "./ws.ts";

export interface SessionApiOptions {
	readonly runtime: SessionRuntime;
	/** Serves `GET /sessions/:id/history`, the transcript in pages, newest first: the runtime's `history`. */
	readonly history?: SessionHistory;
	/**
	 * Serves `GET /sessions/:id/images/:imageId`, an image the transcript names by reference: the runtime's `images`.
	 * Without it every image ID is `not_found` (the transcript's images are inline).
	 */
	readonly images?: TranscriptImages;
	/**
	 * Serves `GET /sessions/:id/models` (a session's models and what it runs with) and `GET /profiles/:id/models?projectId=`
	 * (what a new session would), for a client's model and thinking pickers: the runtime's `models`. Without it both are
	 * `not_supported`.
	 */
	readonly models?: SessionModels;
	/**
	 * Serves `POST /sessions/:id/fork` (a new session from an answer, 201 with its record; `not_supported` without it) and
	 * `POST /sessions/:id/edit` (rewind to a message and send it edited, 202 with the submission): the runtime's
	 * `branching`.
	 */
	readonly branching?: SessionBranching;
	/**
	 * Serves `POST /sessions/:id/warm`, a hint that a message is coming: gets the session's sandbox ready for its next
	 * command. Without it the route checks the session and answers `unavailable` for the container.
	 */
	readonly warm?: SessionWarmer;
	/**
	 * Serves `PATCH /sessions/:id` (body `{ title?, pinned?, archived?, unread? }`, 200 with the record as now stored) and
	 * `DELETE /sessions/:id` (closes and deletes the session, 204), for the console's session menu: the runtime's
	 * `organising`.
	 */
	readonly organising?: SessionOrganising;
	readonly directory: SessionDirectory;
	readonly profiles: AgentProfiles;
	readonly hostTools: HostToolBridge;
	/**
	 * Where host registrations are kept, when they should outlive this process: the runtime's `hosts`, with the runtime
	 * given `hostHandler: callbackHostHandlers(…)`. Without it a registration lives in this API instance and ends with
	 * it (or its `close()`).
	 */
	readonly hosts?: DurableHosts;
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
	/**
	 * Serves `GET /sessions/:id/events` over a WebSocket when the request asks to upgrade (`ws.ts`), on a platform that
	 * can accept one. Without it an upgrade gets the event stream, which a WebSocket client takes as a failed handshake.
	 */
	readonly acceptWebSocket?: AcceptWebSocket;
}

/** What `POST /sessions/:id/warm` calls, once the caller may see the session. */
export interface SessionWarmer {
	warm(
		ctx: CallContext,
		session: SessionRecord,
	): Promise<{ readonly container: "started" | "running" | "skipped" | "unavailable" }>;
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
	if (body.model !== undefined && (typeof body.model !== "string" || body.model === "")) {
		throw new HarbourError("invalid", "model must be a model ID");
	}
	if (body.thinking !== undefined && !THINKING_LEVELS.has(body.thinking)) {
		throw new HarbourError("invalid", "thinking must be a thinking level");
	}
	const attachments = parseAttachments(body.attachments);
	return {
		text: body.text,
		...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
		...(body.requestId === undefined ? {} : { requestId: body.requestId }),
		...(body.model === undefined ? {} : { model: body.model }),
		...(body.thinking === undefined ? {} : { thinking: body.thinking }),
	};
}

const THINKING_LEVELS = new Set<unknown>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** A session update's fields, each checked when given; any other field is ignored. */
function updateInput(body: { readonly [key in keyof SessionUpdate]?: unknown }): SessionUpdate {
	if (body.title !== undefined && typeof body.title !== "string") {
		throw new HarbourError("invalid", "title must be a string");
	}
	for (const flag of ["pinned", "archived", "unread"] as const) {
		if (body[flag] !== undefined && typeof body[flag] !== "boolean") {
			throw new HarbourError("invalid", `${flag} must be true or false`);
		}
	}
	const { title, pinned, archived, unread } = body as SessionUpdate;
	return {
		...(title === undefined ? {} : { title }),
		...(pinned === undefined ? {} : { pinned }),
		...(archived === undefined ? {} : { archived }),
		...(unread === undefined ? {} : { unread }),
	};
}

function editInput(body: Partial<EditSessionInput>): EditSessionInput {
	if (typeof body.itemId !== "string" || body.itemId === "")
		throw new HarbourError("invalid", "Name the message to edit");
	// The prompt's fields but its attachments: an edit reruns the words.
	const { attachments: _attachments, ...prompt } = promptInput(body);
	return { itemId: body.itemId, ...prompt };
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

/** `?cursor=` or `?before=`, and `?limit=`. */
function historyRequestOf(params: URLSearchParams): SessionHistoryRequest {
	const cursor = params.get("cursor");
	const before = params.get("before");
	const limit = params.get("limit");
	if (limit !== null && !/^\d{1,4}$/.test(limit)) throw new HarbourError("invalid", "limit must be a number");
	return {
		...(cursor === null ? {} : { cursor }),
		...(before === null ? {} : { before }),
		...(limit === null ? {} : { limit: Number(limit) }),
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

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");
const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";

/** An agent profile's shape, so a malformed one never reaches storage and breaks the sessions that use it. */
function validProfile(profile: Partial<AgentProfile>): AgentProfile {
	const { model, sandbox, promptLayers } = profile;
	const problems: string[] = [];
	if (typeof profile.id !== "string" || typeof profile.organisationId !== "string") problems.push("id, organisationId");
	if (typeof profile.name !== "string") problems.push("name");
	if (!isOptionalString(profile.projectId) || !isOptionalString(profile.hostId)) problems.push("projectId, hostId");
	if (
		typeof model !== "object" ||
		model === null ||
		typeof model.route !== "string" ||
		!isOptionalString(model.modelId) ||
		(model.thinking !== undefined && !["off", "low", "medium", "high"].includes(model.thinking))
	) {
		problems.push("model");
	}
	const { imageModel } = profile;
	if (
		imageModel !== undefined &&
		(typeof imageModel !== "object" ||
			imageModel === null ||
			typeof imageModel.route !== "string" ||
			imageModel.route === "" ||
			!isOptionalString(imageModel.modelId))
	) {
		problems.push("imageModel");
	}
	if (
		!Array.isArray(promptLayers) ||
		!promptLayers.every(
			(layer) =>
				typeof layer === "object" && layer !== null && typeof layer.name === "string" && typeof layer.text === "string",
		)
	) {
		problems.push("promptLayers");
	}
	if (!isStringList(profile.tools) || !isStringList(profile.skills) || !isStringList(profile.memoryScopes)) {
		problems.push("tools, skills, memoryScopes");
	}
	if (typeof sandbox !== "object" || sandbox === null || !isStringList(sandbox.tiers)) problems.push("sandbox");
	if (problems.length > 0) {
		throw new HarbourError("invalid", `The profile is malformed: ${problems.join("; ")}`);
	}
	return profile as AgentProfile;
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
			case "PATCH ":
				if (options.organising === undefined) break;
				return json(await options.organising.update(ctx, sessionId, updateInput(await readJson(request))));
			case "DELETE ":
				if (options.organising === undefined) break;
				await options.organising.remove(ctx, sessionId);
				return new Response(null, { status: 204 });
			case "GET children":
				return json({ items: await directory.children(ctx, sessionId) });
			case "GET snapshot":
				return json(await runtime.snapshot(ctx, sessionId));
			case "GET history":
				if (options.history === undefined) break;
				return json(await options.history.history(ctx, sessionId, historyRequestOf(url.searchParams)));
			case "POST edit":
				if (options.branching === undefined) break;
				return json(await options.branching.edit(ctx, sessionId, editInput(await readJson(request))), 202);
			case "POST prompt":
				return json(await runtime.prompt(ctx, sessionId, promptInput(await readJson(request))), 202);
			case "POST steer":
				return json(await runtime.steer(ctx, sessionId, promptInput(await readJson(request))), 202);
			case "POST follow-up":
				return json(await runtime.followUp(ctx, sessionId, promptInput(await readJson(request))), 202);
			case "GET events":
				return events(ctx, request, url, sessionId);
		}
		throw NOT_FOUND;
	};

	/** Waits for a run's result up to a bound; a run still going answers 202 with `status: "pending"`. */
	const result = async (
		ctx: CallContext,
		request: Request,
		sessionId: string,
		submissionId: string,
		asked: number | undefined,
	): Promise<Response> => {
		const timeoutMs = Math.min(asked ?? resultWaitMs, maxResultWaitMs);
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

	/**
	 * `watch` over a WebSocket (`ws.ts`), resuming after `?after=`. The watch is opened before the upgrade is accepted, so
	 * a refused or unknown session answers a JSON error, as the event stream does, and never opens a socket.
	 */
	const socketEvents = async (
		ctx: CallContext,
		request: Request,
		url: URL,
		sessionId: string,
		accept: AcceptWebSocket,
	): Promise<Response> => {
		const after = url.searchParams.get("after") ?? undefined;
		let socket: ServerWebSocket | undefined;
		let subscription: Subscription | undefined;
		let keepAlive: ReturnType<typeof setInterval> | undefined;
		let open = true;
		const queued: string[] = [];
		const stop = () => {
			if (!open) return;
			open = false;
			clearInterval(keepAlive);
			streams.delete(stop);
			void subscription?.close();
			try {
				socket?.close(WS_CLOSE_GOING_AWAY, "The watch ended");
			} catch {
				// Already closed.
			}
		};
		const send = (data: string) => {
			if (!open) return;
			if (socket === undefined) {
				queued.push(data);
				return;
			}
			try {
				socket.send(data);
			} catch {
				stop();
			}
		};
		const batch = frameBatcher(send);
		// The first frames arrive before `watch` resolves; they wait until the socket is accepted.
		const watching = await runtime.watch(
			ctx,
			sessionId,
			after === undefined || after === "" ? {} : { after },
			(frame) => batch.push(frame),
		);
		subscription = watching;
		let upgrade: ReturnType<AcceptWebSocket>;
		try {
			upgrade = accept(request);
		} catch (error) {
			await watching.close();
			throw error;
		}
		socket = upgrade.socket;
		streams.add(stop);
		keepAlive = setInterval(() => send(WS_KEEP_ALIVE), keepAliveMs);
		// What was batched while the watch opened goes first, then whatever is still waiting for its microtask.
		for (const data of queued.splice(0)) send(data);
		batch.flush();
		socket.addEventListener("close", stop);
		socket.addEventListener("error", stop);
		return upgrade.response;
	};

	/** `watch` as server-sent events, resuming after `?after=` or `Last-Event-ID`. */
	const events = async (ctx: CallContext, request: Request, url: URL, sessionId: string): Promise<Response> => {
		if (options.acceptWebSocket !== undefined && isWebSocketUpgrade(request)) {
			return socketEvents(ctx, request, url, sessionId, options.acceptWebSocket);
		}
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
				const scoped: CallContext = body.projectId === undefined ? ctx : { ...ctx, projectId: body.projectId };
				if (options.hosts !== undefined) {
					const stored = await options.hosts.register(
						scoped,
						hostId,
						tools,
						{ url: target.href, secret: callback.secret ?? (generated as string) },
						actorKey(ctx),
					);
					const response: RegisterHostResponse = {
						hostId,
						registration: stored.registration,
						tools,
						...(generated === undefined ? {} : { secret: generated }),
					};
					return json(response);
				}
				const handler = callbackHostToolHandler({
					url: target.href,
					secret: callback.secret ?? (generated as string),
					clock,
					...(options.fetch === undefined ? {} : { fetch: options.fetch }),
					...(options.callbackTimeoutMs === undefined ? {} : { timeoutMs: options.callbackTimeoutMs }),
				});
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
				if (named === null || named === "") throw new HarbourError("invalid", "Name the registration to remove");
				if (options.hosts !== undefined) {
					await options.hosts.remove(ctx, hostId, named, actorKey(ctx));
					return new Response(null, { status: 204 });
				}
				// A stale subscription (one since replaced) finds nothing of its own to remove.
				if (registration === undefined || named !== registration.registration) {
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
			const body = validProfile(await readJson<Partial<AgentProfile>>(request));
			if (body.id !== agentId) throw new HarbourError("invalid", "The profile's id must match the path");
			return json(await profiles.put(ctx, body));
		}
		throw NOT_FOUND;
	};

	/**
	 * The public API's routes (`@harbour/api`), each defined once there with its schemas: the router checks a request
	 * against them before a handler sees it. The routes below it are the ones not yet in the public API.
	 */
	const publicApi = createRouter(
		publicRoutes,
		{
			createSession: async (ctx: CallContext, { body }) => {
				const { message, ...input } = body;
				const session = await runtime.create(ctx, input);
				if (message === undefined) return session;
				try {
					return { ...session, submission: await runtime.prompt(ctx, session.id, message) };
				} catch (error) {
					// A session whose first message was refused would sit idle with nothing to do: close it, then refuse.
					await runtime.close(ctx, session.id).catch(() => undefined);
					throw error;
				}
			},
			listSessions: (ctx: CallContext, { query }) => {
				const { limit, cursor, label, ...filter } = query;
				return directory.list(
					ctx,
					{ ...filter, ...(label === undefined || Object.keys(label).length === 0 ? {} : { labels: label }) },
					{ ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) },
				);
			},
			getSession: (ctx: CallContext, { params }) => directory.get(ctx, params.sessionId),
			closeSession: async (ctx: CallContext, { params }) => {
				await runtime.close(ctx, params.sessionId);
				return undefined;
			},
			abortSession: async (ctx: CallContext, { params, body }) => {
				await runtime.abort(ctx, params.sessionId, body.reason);
				return undefined;
			},
			forkSession: async (ctx: CallContext, { params, body }) => {
				if (options.branching === undefined) {
					throw new HarbourError("not_supported", "This server doesn't fork sessions");
				}
				return options.branching.fork(ctx, params.sessionId, body);
			},
			getRunResult: (ctx: CallContext, { params, query }, request) =>
				result(ctx, request, params.sessionId, query.submission, query.timeoutMs),
			getSessionModels: (ctx: CallContext, { params }) => {
				if (options.models === undefined) {
					throw new HarbourError("not_supported", "This server doesn't list models");
				}
				return options.models.modelState(ctx, params.sessionId);
			},
			getNewSessionModels: (ctx: CallContext, { params, query }) => {
				if (options.models === undefined) {
					throw new HarbourError("not_supported", "This server doesn't list models");
				}
				// `?scope=organisation` names no project: the models a new organisation session would list.
				if (query.scope === "organisation" && query.projectId === undefined) {
					return options.models.startModels(ctx, { scope: "organisation", agentId: params.agentId });
				}
				if (query.projectId === undefined || query.projectId === "") {
					throw new HarbourError("invalid", "Name the project");
				}
				return options.models.startModels(ctx, { projectId: query.projectId, agentId: params.agentId });
			},
			sendMessage: async (ctx: CallContext, { params, body, idempotencyKey }) => {
				const { via = "prompt", ...message } = body;
				const input: PromptInput = {
					...message,
					...(idempotencyKey === undefined ? {} : { requestId: idempotencyKey }),
				};
				const submitted =
					via === "steer"
						? await runtime.steer(ctx, params.sessionId, input)
						: via === "followUp"
							? await runtime.followUp(ctx, params.sessionId, input)
							: await runtime.prompt(ctx, params.sessionId, input);
				// The runtime answers a key it has seen with that submission and submits nothing; a key reused for
				// another kind of message is the caller's mistake, not a retry.
				if (submitted.via !== via) {
					throw new HarbourError("conflict", `This Idempotency-Key was already used for a ${submitted.via}`);
				}
				return submitted;
			},
			warmSession: async (ctx: CallContext, { params }) => {
				// The session first, so a session the caller can't see is `not_found` whether or not this server warms.
				const session = await directory.get(ctx, params.sessionId);
				if (options.warm === undefined) return { container: "unavailable" as const };
				const { container } = await options.warm.warm(ctx, session);
				return { container };
			},
			streamSession: (ctx: CallContext, { params }, request) =>
				events(ctx, request, new URL(request.url), params.sessionId),
			getSessionHistory: async (ctx: CallContext, { params, query }) => {
				if (options.history === undefined) {
					throw new HarbourError("not_supported", "This server doesn't page through history");
				}
				return options.history.history(ctx, params.sessionId, query);
			},
			getSessionImage: async (ctx: CallContext, { params }) => {
				if (options.images === undefined) {
					// The session first, so one the caller can't see is `not_found` either way.
					await directory.get(ctx, params.sessionId);
					throw new HarbourError("not_found", `No image ${params.imageId} in session ${params.sessionId}`);
				}
				const image = await options.images.image(ctx, params.sessionId, params.imageId);
				return new Response(image.bytes as Uint8Array<ArrayBuffer>, {
					status: 200,
					headers: {
						"content-type": image.mimeType,
						"content-length": String(image.bytes.byteLength),
						// Named by the hash of its bytes, so it never changes: the browser keeps it for good. Private: it is read
						// with the caller's credentials.
						"cache-control": "private, max-age=31536000, immutable",
						etag: `"${params.imageId}"`,
						// Never run or sniffed as anything but the image it is.
						"x-content-type-options": "nosniff",
						"content-security-policy": "default-src 'none'; sandbox",
					},
				});
			},
		},
		{ basePath },
	);

	const route = async (ctx: CallContext, request: Request, url: URL, segments: readonly string[]) => {
		const answered = await publicApi(ctx, request);
		if (answered !== undefined) return answered;
		const [area, id, ...rest] = segments;
		if (area === "sessions" && id !== undefined) return sessionRoutes(ctx, request, url, id, rest);
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
