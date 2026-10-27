/**
 * The session runtime, independent of target: one Pi Durable Harness per session, opened on the session's own Pi
 * storage, with the directory, profiles, submissions and host registrations in a `SessionStore`. A target supplies the
 * store and how to open a session's Pi storage; the in-memory runtime passes maps and `MemoryStorage`.
 *
 * Sessions open on first use and stay open until the runtime closes. A runtime started over a store that already
 * holds sessions reopens each one when it is next used, so its transcript, profile and host tools carry on.
 */

import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationView,
	createRegistry,
	defineExtension,
	type Extension,
	Harness,
	type Registry,
	type Storage,
	type SubmissionId,
	section,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	type AccessCheck,
	type Actor,
	type AgentId,
	type AgentProfile,
	type AgentProfiles,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	createProjectAccess,
	HarbourError,
	type HostToolBridge,
	type HostToolHandler,
	type IdentityDirectory,
	type ModelChoice,
	type OrganisationId,
	type ProjectAccess,
	type PromptInput,
	type Sandboxes,
	type SessionDirectory,
	type SessionEnd,
	type SessionEndHook,
	type SessionId,
	type SessionRecord,
	type SessionRuntime,
	type Submission,
	systemClock,
	systemContext,
} from "@harbour/contracts";
import { createMemorySessionStream, type MemorySessionStream } from "@harbour/protocol/memory";
import {
	ConversationProjector,
	createSessionEndHook,
	harbourUserEntry,
	hostToolAsPiTool,
	joinPromptLayers,
	matchesSessionFilter,
	paginate,
	piContext,
	type ResolvedModel,
	runResultOf,
} from "./index.ts";
import type { SessionStore, StoredHost, StoredSession } from "./store.ts";

export interface SessionRuntimeOptions {
	/** Directory, profiles, submissions and host registrations. */
	readonly store: SessionStore;
	/**
	 * Opens the Pi Durable storage of one session, the same storage every time it is asked for the same session. The
	 * Harness owns what it is given and closes it when the session closes in this runtime.
	 */
	readonly storage: (session: SessionRecord) => Storage | Promise<Storage>;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** The Pi model collection sessions run on. */
	readonly models: Models;
	/** Maps a profile's model route to a Pi model. Default: the first model of the first provider. */
	readonly resolveModel?: (choice: ModelChoice) => ResolvedModel;
	/**
	 * Role bindings. When given, the runtime checks project access on every call, through `createProjectAccess` over
	 * these and its own directory, and exposes that check as `access` for components to share. Without it the runtime
	 * checks only the organisation; every target and every conformance run passes one.
	 */
	readonly identity?: Pick<IdentityDirectory, "roleOf">;
	/**
	 * Released on abort (`aborted`) and close (`session_ended`), as the `sandbox` teardown of the session-end hook.
	 * Kept for existing wiring: a sandbox created with `sessionEnd: runtime.sessionEnd` registers itself instead.
	 */
	readonly sandboxes?: Pick<Sandboxes, "releaseSession">;
	/**
	 * Serves a durable registration's tools (one stored with a callback), such as `callbackHostToolHandler` over its URL
	 * and secret. Without it only handlers registered in this process serve tools.
	 */
	readonly hostHandler?: (host: StoredHost) => HostToolHandler | undefined;
	/** How many items a snapshot holds. Default 50. */
	readonly pageSize?: number;
}

export interface SessionRuntimeService {
	readonly runtime: SessionRuntime;
	readonly directory: SessionDirectory;
	readonly profiles: AgentProfiles;
	readonly hostTools: HostToolBridge;
	/**
	 * The session-end hook this runtime runs on close and abort. Components register their teardown with it, such as
	 * `createMemoryBrowser({ sessionEnd })`.
	 */
	readonly sessionEnd: SessionEndHook;
	/** The project-access check over this runtime's sessions, when `identity` was given; components can share it. */
	readonly access?: ProjectAccess;
	/** Closes every open session's Harness. Their work stays in storage for a runtime that opens them again. */
	close(): Promise<void>;
}

interface OpenSession {
	record: SessionRecord;
	readonly profile: AgentProfile;
	readonly sequence: number;
	readonly harness: Harness;
	readonly conversation: Conversation;
	readonly registry: Registry;
	readonly view: AttachedReplicatedState<ConversationView>;
	readonly stream: MemorySessionStream;
	readonly projector: ConversationProjector;
	/** Stream publishes and directory writes, in order. */
	publishing: Promise<unknown>;
	aborts: number;
	closed: boolean;
	stopWatching(): void;
}

export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntimeService {
	const { store, models } = options;
	const clock = options.clock ?? systemClock;
	const open = new Map<SessionId, OpenSession>();
	const opening = new Map<SessionId, Promise<OpenSession>>();
	/** Handlers registered in this process, by registration. */
	const localHandlers = new Map<string, HostToolHandler>();
	let closed = false;

	const resolveModel =
		options.resolveModel ??
		((): ResolvedModel => {
			const provider = models.getProviders()[0];
			const model = provider === undefined ? undefined : models.getModels(provider.id)[0];
			if (provider === undefined || model === undefined)
				throw new HarbourError("unavailable", "No model is configured");
			return { provider: provider.id, modelId: model.id };
		});

	const audit = async (events: readonly AuditEventInput[]) => {
		if (options.audit !== undefined) await options.audit.append(systemContext("session"), events);
	};

	const ends = createSessionEndHook({ ...(options.audit === undefined ? {} : { audit: options.audit }), clock });
	const sandboxes = options.sandboxes;
	if (sandboxes !== undefined) {
		ends.hook.register("sandbox", (ctx, end) => sandboxes.releaseSession(ctx, end.sessionId, end.reason));
	}

	/** The session's current record: an open session's is newer than the stored one. */
	const recordOf = (stored: StoredSession): SessionRecord => open.get(stored.record.id)?.record ?? stored.record;

	/** The stored session, if it is in the caller's organisation. */
	const findSession = async (ctx: Pick<CallContext, "organisationId">, sessionId: SessionId) => {
		const stored = await store.session(sessionId);
		if (stored === undefined || stored.record.organisationId !== ctx.organisationId) return undefined;
		return stored;
	};

	const requireStored = async (ctx: Pick<CallContext, "organisationId">, sessionId: SessionId) => {
		const stored = await findSession(ctx, sessionId);
		if (stored === undefined) throw new HarbourError("not_found", `No session ${sessionId}`);
		return stored;
	};

	// The check reads sessions straight from the store: going through the checked directory would check itself.
	const access: ProjectAccess | undefined =
		options.identity === undefined
			? undefined
			: createProjectAccess({
					identity: options.identity,
					sessions: { get: async (ctx, sessionId) => recordOf(await requireStored(ctx, sessionId)) },
					...(options.audit === undefined ? {} : { audit: options.audit }),
					clock,
				});

	const check = async (ctx: CallContext, accessCheck: AccessCheck): Promise<void> => {
		if (access !== undefined) await access.require(ctx, accessCheck);
	};

	/** Checks the caller may act on `sessionId` (already found in its organisation) with `needed`. */
	const checkSession = (ctx: CallContext, sessionId: SessionId, needed: AccessCheck["needed"], operation: string) =>
		check(ctx, { sessionId, needed, operation, subject: { kind: "session", id: sessionId } });

	const requireProfile = async (ctx: CallContext, agentId: AgentId): Promise<AgentProfile> => {
		const profile = await store.profile(ctx.organisationId, agentId);
		if (profile === undefined) throw new HarbourError("not_found", `No agent profile ${agentId}`);
		return profile;
	};

	/** Queues a write of the session's record after the writes before it. */
	const persist = (session: OpenSession) => {
		const record = session.record;
		session.publishing = session.publishing.then(() => store.updateSession(record.id, { record }));
	};

	const applyStatus = (session: OpenSession) => {
		const status = session.projector.status;
		if (session.record.status === status) return;
		session.record = { ...session.record, status, updatedAt: clock.now() };
		persist(session);
	};

	/** Brings the stream and the directory record up to the session's current view. */
	const sync = (session: OpenSession): Promise<unknown> => {
		const ops = session.projector.project(session.view.value);
		applyStatus(session);
		if (ops.length > 0) session.publishing = session.publishing.then(() => session.stream.publish(ops));
		return session.publishing;
	};

	const handlerOf = (host: StoredHost): HostToolHandler | undefined =>
		localHandlers.get(host.registration) ?? (host.callback === undefined ? undefined : options.hostHandler?.(host));

	const toolsFor = async (session: Pick<OpenSession, "profile" | "record">): Promise<ToolRegistration[]> => {
		const { profile, record } = session;
		const hostId = profile.hostId;
		if (hostId === undefined) return [];
		// A registration whose handler is gone (served by a process that has since stopped) offers nothing.
		const host = await store.host(record.organisationId, hostId);
		const served = host === undefined || handlerOf(host) === undefined ? [] : host.tools;
		const agentActor = { kind: "agent", agentId: record.agentId, sessionId: record.id } as const;
		return served
			.filter((definition) => profile.tools.includes(definition.name))
			.map((definition) =>
				hostToolAsPiTool(definition, {
					call: {
						hostId,
						sessionId: record.id,
						organisationId: record.organisationId,
						projectId: record.projectId,
						agentId: record.agentId,
					},
					handler: async () => {
						const host = await store.host(record.organisationId, hostId);
						return host?.tools.some((tool) => tool.name === definition.name) ? handlerOf(host) : undefined;
					},
					onStarted: (call) =>
						audit([
							{
								id: `session:${record.id}:tool:${call.callId}:started`,
								at: clock.now(),
								source: "session",
								type: "session.tool.started",
								actor: agentActor,
								organisationId: record.organisationId,
								projectId: record.projectId,
								sessionId: record.id,
								agentId: record.agentId,
								subject: { kind: "session.tool", id: call.callId },
								data: { hostId, tool: call.tool },
							},
						]),
					onFinished: (call, outcome) =>
						audit([
							{
								id: `session:${record.id}:tool:${call.callId}:finished`,
								at: clock.now(),
								source: "session",
								type: "session.tool.finished",
								actor: agentActor,
								organisationId: record.organisationId,
								projectId: record.projectId,
								sessionId: record.id,
								agentId: record.agentId,
								subject: { kind: "session.tool", id: call.callId },
								data: { hostId, tool: call.tool, outcome },
							},
						]),
				}),
			);
	};

	const extensionFor = (session: Pick<OpenSession, "profile">, tools: ToolRegistration[]): Extension => {
		const prompt = joinPromptLayers(session.profile.promptLayers);
		return defineExtension({
			name: "harbour",
			sections: [section("harbour-prompt", () => (prompt === "" ? undefined : prompt), { tag: false })],
			tools,
		});
	};

	/** Reinstalls each affected open session's host tools after a registration changes. */
	const refreshHostTools = async (organisationId: OrganisationId, hostId: string) => {
		for (const session of open.values()) {
			if (session.record.organisationId !== organisationId || session.profile.hostId !== hostId) continue;
			session.registry.install(extensionFor(session, await toolsFor(session)));
		}
	};

	/** Opens the session's Harness on its storage, or returns it if it is open already. */
	const ensureOpen = (stored: StoredSession): Promise<OpenSession> => {
		const id = stored.record.id;
		const current = open.get(id);
		if (current !== undefined) return Promise.resolve(current);
		const pending = opening.get(id);
		if (pending !== undefined) return pending;
		if (closed) return Promise.reject(new HarbourError("unavailable", "The session runtime is closed"));
		const started = openSession(stored).finally(() => opening.delete(id));
		opening.set(id, started);
		return started;
	};

	const openSession = async (stored: StoredSession): Promise<OpenSession> => {
		const { record, profile } = stored;
		const model = resolveModel(profile.model);
		const registry = createRegistry();
		registry.install(extensionFor({ profile }, await toolsFor({ profile, record })));
		const context = BACKGROUND_CONTEXT;
		const storage = await options.storage(record);
		const harness = await Harness.open(storage, { models, registry, now: () => clock.now() }, context);
		let conversation: Conversation;
		let view: AttachedReplicatedState<ConversationView>;
		try {
			conversation = await harness.root(context, {
				agent: {
					model: { provider: model.provider, modelId: model.modelId },
					...(profile.model.thinking === undefined ? {} : { thinkingLevel: profile.model.thinking }),
				},
			});
			view = await conversation.viewState(context);
		} catch (error) {
			await harness.close(context).catch(() => undefined);
			throw error;
		}
		const session: OpenSession = {
			record,
			profile,
			sequence: stored.sequence,
			harness,
			conversation,
			registry,
			view,
			stream: createMemorySessionStream({
				sessionId: record.id,
				...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
				...(record.title === undefined ? {} : { title: record.title }),
				now: () => clock.now(),
			}),
			projector: new ConversationProjector({ now: () => clock.now() }),
			publishing: Promise.resolve(),
			aborts: stored.aborts,
			closed: stored.closed,
			stopWatching: () => {},
		};
		open.set(record.id, session);
		const unsubscribe = view.subscribe(() => sync(session));
		session.stopWatching = () => {
			unsubscribe();
			view.dispose();
		};
		if (session.closed) {
			sync(session);
			const ops = session.projector.close();
			if (ops.length > 0) session.publishing = session.publishing.then(() => session.stream.publish(ops));
			applyStatus(session);
		} else {
			// Work a previous process left running (a model call, a tool call) carries on from its last commit.
			harness.resume();
			sync(session);
		}
		await session.publishing;
		return session;
	};

	const requireOpen = async (ctx: CallContext, sessionId: SessionId) => ensureOpen(await requireStored(ctx, sessionId));

	const endOf = (session: OpenSession, reason: SessionEnd["reason"], endedBy: Actor): SessionEnd => {
		const { record } = session;
		return {
			sessionId: record.id,
			organisationId: record.organisationId,
			projectId: record.projectId,
			agentId: record.agentId,
			...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
			reason,
			endedBy,
			at: clock.now(),
		};
	};

	/** The session's children, oldest first. */
	const childrenOf = async (organisationId: OrganisationId, sessionId: SessionId) =>
		[...(await store.sessions(organisationId, { parentSessionId: sessionId }))].sort(
			(left, right) => left.sequence - right.sequence,
		);

	const stopWork = async (
		ctx: CallContext,
		session: OpenSession,
		release: "aborted" | "session_ended",
		reason?: string,
	): Promise<void> => {
		// One child failing (its audit sink, say) must not keep its siblings or this session from ending; the first
		// failure is rethrown once every session has run its teardowns. A closed child has already ended.
		let failure: { readonly error: unknown } | undefined;
		for (const stored of await childrenOf(session.record.organisationId, session.record.id)) {
			try {
				const child = await ensureOpen(stored);
				if (child.closed) continue;
				await stopWork(ctx, child, "aborted", `parent ${session.record.id} aborted`);
			} catch (error) {
				failure ??= { error };
			}
		}
		await session.conversation.abort(piContext(ctx));
		await sync(session);
		const run = session.aborts + 1;
		session.aborts = run;
		await store.updateSession(session.record.id, { aborts: run });
		await ends.run(endOf(session, release, ctx.actor), String(run));
		if (failure !== undefined) throw failure.error;
		await audit([
			{
				id: `session:${session.record.id}:aborted:${session.aborts}`,
				at: clock.now(),
				source: "session",
				type: "session.aborted",
				actor: ctx.actor,
				organisationId: session.record.organisationId,
				projectId: session.record.projectId,
				sessionId: session.record.id,
				agentId: session.record.agentId,
				subject: { kind: "session", id: session.record.id },
				data: reason === undefined ? { release } : { release, reason },
			},
		]);
	};

	const submit = async (
		ctx: CallContext,
		sessionId: SessionId,
		input: PromptInput,
		via: Submission["via"],
	): Promise<Submission> => {
		const stored = await requireStored(ctx, sessionId);
		await checkSession(ctx, sessionId, "operator", `session.${via}`);
		if (stored.closed || open.get(sessionId)?.closed === true) {
			throw new HarbourError("conflict", `Session ${sessionId} is closed`);
		}
		if (input.text === "") throw new HarbourError("invalid", "A prompt needs text");
		const session = await ensureOpen(stored);
		if (session.closed) throw new HarbourError("conflict", `Session ${sessionId} is closed`);
		const pi = await session.conversation.submit(
			{
				type: "input",
				content: input.text,
				whenBusy: via === "steer" ? "steer" : "followUp",
				entry: harbourUserEntry(via, input.requestId),
				...(input.requestId === undefined ? {} : { requestId: input.requestId }),
			},
			piContext(ctx),
		);
		const id = `${sessionId}/${pi.id}`;
		const existing = await store.submission(sessionId, id);
		if (existing !== undefined) return existing.submission;
		const submission: Submission = {
			id,
			sessionId,
			via,
			...(input.requestId === undefined ? {} : { requestId: input.requestId }),
		};
		await store.putSubmission({ submission, piSubmissionId: Number(pi.id) });
		await sync(session);
		const { record } = session;
		await audit([
			{
				id: `session:${sessionId}:submission:${id}`,
				at: clock.now(),
				source: "session",
				type: via === "steer" ? "session.steered" : "session.prompted",
				actor: ctx.actor,
				organisationId: record.organisationId,
				projectId: record.projectId,
				sessionId,
				agentId: record.agentId,
				subject: { kind: "session.submission", id },
				data: input.requestId === undefined ? { via } : { via, requestId: input.requestId },
			},
		]);
		return submission;
	};

	const runtime: SessionRuntime = {
		async create(ctx, input) {
			const profile = await requireProfile(ctx, input.agentId);
			if (input.projectId === "") throw new HarbourError("invalid", "A session needs a project");
			// A project's profile runs only in that project; an organisation-wide one runs in any.
			if (profile.projectId !== undefined && profile.projectId !== input.projectId) {
				throw new HarbourError("invalid", `Agent profile ${profile.id} is for another project`);
			}
			if (input.parentSessionId !== undefined) await requireStored(ctx, input.parentSessionId);
			// A child is in its parent's project, and an agent may create one only from its own session or its child.
			await check(ctx, {
				projectId: input.projectId,
				...(input.parentSessionId === undefined ? {} : { sessionId: input.parentSessionId }),
				needed: "operator",
				operation: "session.create",
			});
			// Resolve first, so a profile whose route resolves nowhere creates nothing.
			resolveModel(profile.model);
			const now = clock.now();
			const record: SessionRecord = {
				id: crypto.randomUUID(),
				organisationId: ctx.organisationId,
				projectId: input.projectId,
				agentId: profile.id,
				...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
				...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
				...(input.title === undefined ? {} : { title: input.title }),
				status: "idle",
				labels: { ...input.labels },
				createdBy: ctx.actor,
				createdAt: now,
				updatedAt: now,
			};
			const stored = await store.createSession({ record, profile, aborts: 0, closed: false });
			await ensureOpen(stored);
			await audit([
				{
					id: `session:${record.id}:created`,
					at: now,
					source: "session",
					type: "session.created",
					actor: ctx.actor,
					organisationId: record.organisationId,
					projectId: record.projectId,
					sessionId: record.id,
					agentId: record.agentId,
					subject: { kind: "session", id: record.id },
					data: {
						labels: record.labels,
						...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
					},
				},
			]);
			return record;
		},
		prompt: (ctx, sessionId, input) => submit(ctx, sessionId, input, "prompt"),
		steer: (ctx, sessionId, input) => submit(ctx, sessionId, input, "steer"),
		followUp: (ctx, sessionId, input) => submit(ctx, sessionId, input, "followUp"),
		async abort(ctx, sessionId, reason) {
			const stored = await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "operator", "session.abort");
			if (stored.closed) return;
			const session = await ensureOpen(stored);
			if (session.closed) return;
			await stopWork(ctx, session, "aborted", reason);
		},
		async wait(ctx, sessionId, submissionId) {
			await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.wait");
			const entry = await store.submission(sessionId, submissionId);
			if (entry === undefined) throw new HarbourError("not_found", `No submission ${submissionId}`);
			const session = await requireOpen(ctx, sessionId);
			const pi = await session.harness.submission(entry.piSubmissionId as SubmissionId, piContext(ctx));
			if (pi === undefined) throw new HarbourError("not_found", `No submission ${submissionId}`);
			const settled = await pi.wait(piContext(ctx));
			await sync(session);
			const answerId = settled.status === "done" ? settled.answer : undefined;
			const answer =
				answerId === undefined
					? undefined
					: await session.conversation.commit((tx) => tx.entry(answerId), piContext(ctx));
			return runResultOf(sessionId, submissionId, settled, answer);
		},
		async watch(ctx, sessionId, watchOptions, onFrame) {
			await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.watch");
			const session = await requireOpen(ctx, sessionId);
			await sync(session);
			return session.stream.connect(watchOptions.after, onFrame);
		},
		async snapshot(ctx, sessionId) {
			await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.snapshot");
			const session = await requireOpen(ctx, sessionId);
			await sync(session);
			return session.stream.snapshot();
		},
		async close(ctx, sessionId) {
			const stored = await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "operator", "session.close");
			if (stored.closed) return;
			const session = await ensureOpen(stored);
			if (session.closed) return;
			session.closed = true;
			await stopWork(ctx, session, "session_ended", "closed");
			const ops = session.projector.close();
			applyStatus(session);
			if (ops.length > 0) session.publishing = session.publishing.then(() => session.stream.publish(ops));
			await session.publishing;
			await store.updateSession(sessionId, { record: session.record, closed: true });
		},
	};

	const directory: SessionDirectory = {
		async get(ctx, sessionId) {
			const stored = await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.get");
			return recordOf(stored);
		},
		async list(ctx, filter, page) {
			if (filter?.projectId !== undefined) {
				await check(ctx, { projectId: filter.projectId, needed: "viewer", operation: "session.list" });
			}
			const stored = await store.sessions(ctx.organisationId, {
				...(filter?.projectId === undefined ? {} : { projectId: filter.projectId }),
				...(filter?.agentId === undefined ? {} : { agentId: filter.agentId }),
				...(filter?.parentSessionId === undefined ? {} : { parentSessionId: filter.parentSessionId }),
			});
			const records: SessionRecord[] = [];
			for (const session of stored) {
				const record = recordOf(session);
				if (!matchesSessionFilter(record, filter)) continue;
				if (access === undefined || (await access.allows(ctx, { sessionId: record.id, needed: "viewer" }))) {
					records.push(record);
				}
			}
			return paginate(records, page);
		},
		async children(ctx, sessionId) {
			await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.children");
			return (await childrenOf(ctx.organisationId, sessionId)).map(recordOf);
		},
	};

	const profiles: AgentProfiles = {
		async put(ctx, profile) {
			if (profile.organisationId !== ctx.organisationId) {
				throw new HarbourError("forbidden", "A profile belongs to the caller's organisation");
			}
			if (profile.id === "") throw new HarbourError("invalid", "A profile needs an ID");
			// A project's profile needs operator on it; an organisation-wide profile needs an organisation-wide role.
			await check(ctx, {
				...(profile.projectId === undefined ? {} : { projectId: profile.projectId }),
				needed: "operator",
				operation: "session.profiles.put",
				subject: { kind: "session.profile", id: profile.id },
			});
			// Replacing a profile needs the same on the profile it replaces, so no one moves another project's profile.
			const existing = await store.profile(ctx.organisationId, profile.id);
			if (existing !== undefined && existing.projectId !== profile.projectId) {
				await check(ctx, {
					...(existing.projectId === undefined ? {} : { projectId: existing.projectId }),
					needed: "operator",
					operation: "session.profiles.put",
					subject: { kind: "session.profile", id: profile.id },
				});
			}
			await store.putProfile(profile);
			return profile;
		},
		async get(ctx, agentId) {
			const profile = await requireProfile(ctx, agentId);
			// A project's profile is read with viewer on the project; an organisation-wide one by the organisation.
			if (profile.projectId !== undefined) {
				await check(ctx, {
					projectId: profile.projectId,
					needed: "viewer",
					operation: "session.profiles.get",
					subject: { kind: "session.profile", id: profile.id },
				});
			}
			return profile;
		},
		async list(ctx, page) {
			const items: AgentProfile[] = [];
			for (const profile of await store.profiles(ctx.organisationId)) {
				const visible =
					access === undefined ||
					profile.projectId === undefined ||
					(await access.allows(ctx, { projectId: profile.projectId, needed: "viewer" }));
				if (visible) items.push(profile);
			}
			return paginate(items, page);
		},
	};

	const hostTools: HostToolBridge = {
		async register(ctx, hostId, tools, handler) {
			const names = new Set<string>();
			for (const tool of tools) {
				if (tool.name === "" || names.has(tool.name)) {
					throw new HarbourError("invalid", `Tool names must be unique and not empty: "${tool.name}"`);
				}
				names.add(tool.name);
			}
			// A host registers for the project its call names, or across the organisation. Replacing a host registered
			// for another scope needs the same there, so no one takes over another project's tools.
			const existing = await store.host(ctx.organisationId, hostId);
			for (const projectId of new Set([ctx.projectId, ...(existing === undefined ? [] : [existing.projectId])])) {
				await check(ctx, {
					...(projectId === undefined ? {} : { projectId }),
					needed: "operator",
					operation: "session.hostTools.register",
					subject: { kind: "session.host", id: hostId },
				});
			}
			const registration = crypto.randomUUID();
			localHandlers.set(registration, handler);
			if (existing !== undefined) localHandlers.delete(existing.registration);
			await store.putHost({
				organisationId: ctx.organisationId,
				hostId,
				tools: [...tools],
				registration,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			});
			await refreshHostTools(ctx.organisationId, hostId);
			return {
				async close() {
					localHandlers.delete(registration);
					if (!(await store.deleteHost(ctx.organisationId, hostId, registration))) return;
					await refreshHostTools(ctx.organisationId, hostId);
				},
			};
		},
		async list(ctx, hostId) {
			const registration = await store.host(ctx.organisationId, hostId);
			if (registration === undefined) return [];
			if (registration.projectId !== undefined) {
				await check(ctx, {
					projectId: registration.projectId,
					needed: "viewer",
					operation: "session.hostTools.list",
					subject: { kind: "session.host", id: hostId },
				});
			}
			return registration.tools;
		},
	};

	return {
		runtime,
		directory,
		profiles,
		hostTools,
		sessionEnd: ends.hook,
		...(access === undefined ? {} : { access }),
		async close() {
			closed = true;
			await Promise.allSettled([...opening.values()]);
			for (const session of [...open.values()]) {
				open.delete(session.record.id);
				session.stopWatching();
				await session.publishing.catch(() => undefined);
				await session.harness.close(BACKGROUND_CONTEXT);
			}
		},
	};
}
