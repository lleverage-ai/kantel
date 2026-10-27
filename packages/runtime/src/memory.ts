/**
 * The in-memory session runtime: one Pi Durable Harness per session, each on its own `MemoryStorage`, with the
 * session's root conversation as its transcript. Directory, profiles and host registrations live in maps.
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
	MemoryStorage,
	type Submission as PiSubmission,
	type Registry,
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
	type HostToolDefinition,
	type HostToolHandler,
	type IdentityDirectory,
	type ModelChoice,
	type OrganisationId,
	type ProjectAccess,
	type ProjectId,
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

export interface MemoryRuntimeOptions {
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
	/** How many items a snapshot holds. Default 50. */
	readonly pageSize?: number;
}

export interface MemoryRuntime {
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
	/** Closes every session's Harness. */
	close(): Promise<void>;
}

interface HostRegistration {
	readonly tools: readonly HostToolDefinition[];
	readonly handler: HostToolHandler;
	/** The project the host registered for; absent when it registered across the organisation. */
	readonly projectId?: ProjectId;
}

interface SubmissionEntry {
	readonly submission: Submission;
	readonly pi: PiSubmission;
}

interface SessionState {
	record: SessionRecord;
	readonly profile: AgentProfile;
	readonly sequence: number;
	readonly harness: Harness;
	readonly conversation: Conversation;
	readonly registry: Registry;
	readonly view: AttachedReplicatedState<ConversationView>;
	readonly stream: MemorySessionStream;
	readonly projector: ConversationProjector;
	readonly submissions: Map<string, SubmissionEntry>;
	publishing: Promise<unknown>;
	aborts: number;
	closed: boolean;
	stopWatching(): void;
}

const keyOf = (organisationId: OrganisationId, id: string) => `${organisationId}\u0000${id}`;

export function createMemoryRuntime(options: MemoryRuntimeOptions): MemoryRuntime {
	const clock = options.clock ?? systemClock;
	const models = options.models;
	const profilesByKey = new Map<string, AgentProfile>();
	const hosts = new Map<string, HostRegistration>();
	const sessions = new Map<SessionId, SessionState>();
	let sequence = 0;

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
		if (options.audit !== undefined) await options.audit.append(events);
	};

	const ends = createSessionEndHook({ ...(options.audit === undefined ? {} : { audit: options.audit }), clock });
	const sandboxes = options.sandboxes;
	if (sandboxes !== undefined) {
		ends.hook.register("sandbox", (ctx, end) => sandboxes.releaseSession(ctx, end.sessionId, end.reason));
	}

	// The check reads sessions straight from the map: going through the checked directory would check itself.
	const access: ProjectAccess | undefined =
		options.identity === undefined
			? undefined
			: createProjectAccess({
					identity: options.identity,
					sessions: { get: async (ctx, sessionId) => requireSession(ctx, sessionId).record },
					...(options.audit === undefined ? {} : { audit: options.audit }),
					clock,
				});

	const check = async (ctx: CallContext, accessCheck: AccessCheck): Promise<void> => {
		if (access !== undefined) await access.require(ctx, accessCheck);
	};

	/** Checks the caller may act on `sessionId` (already found in its organisation) with `needed`. */
	const checkSession = (ctx: CallContext, sessionId: SessionId, needed: AccessCheck["needed"], operation: string) =>
		check(ctx, { sessionId, needed, operation, subject: { kind: "session", id: sessionId } });

	const requireProfile = (ctx: CallContext, agentId: AgentId): AgentProfile => {
		const profile = profilesByKey.get(keyOf(ctx.organisationId, agentId));
		if (profile === undefined) throw new HarbourError("not_found", `No agent profile ${agentId}`);
		return profile;
	};

	const requireSession = (ctx: CallContext, sessionId: SessionId): SessionState => {
		const session = sessions.get(sessionId);
		if (session === undefined || session.record.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `No session ${sessionId}`);
		}
		return session;
	};

	/** Brings the stream and the directory record up to the session's current view. */
	const sync = (session: SessionState): Promise<unknown> => {
		const ops = session.projector.project(session.view.value);
		applyStatus(session);
		if (ops.length > 0) session.publishing = session.publishing.then(() => session.stream.publish(ops));
		return session.publishing;
	};

	const applyStatus = (session: SessionState) => {
		const status = session.projector.status;
		if (session.record.status !== status) session.record = { ...session.record, status, updatedAt: clock.now() };
	};

	const toolsFor = (session: SessionState): ToolRegistration[] => {
		const { profile, record } = session;
		const hostId = profile.hostId;
		if (hostId === undefined) return [];
		const hostKey = keyOf(record.organisationId, hostId);
		const served = hosts.get(hostKey)?.tools ?? [];
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
					handler: () => {
						const host = hosts.get(hostKey);
						return host?.tools.some((tool) => tool.name === definition.name) ? host.handler : undefined;
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

	const extensionFor = (session: Pick<SessionState, "profile" | "record">, tools: ToolRegistration[]): Extension => {
		const prompt = joinPromptLayers(session.profile.promptLayers);
		return defineExtension({
			name: "harbour",
			sections: [section("harbour-prompt", () => (prompt === "" ? undefined : prompt), { tag: false })],
			tools,
		});
	};

	/** Reinstalls each affected session's host tools after a registration changes. */
	const refreshHostTools = (organisationId: OrganisationId, hostId: string) => {
		for (const session of sessions.values()) {
			if (session.record.organisationId !== organisationId || session.profile.hostId !== hostId) continue;
			session.registry.install(extensionFor(session, toolsFor(session)));
		}
	};

	const endOf = (session: SessionState, reason: SessionEnd["reason"], endedBy: Actor): SessionEnd => {
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

	const childrenOf = (organisationId: OrganisationId, sessionId: SessionId): SessionState[] =>
		[...sessions.values()]
			.filter(
				(session) => session.record.organisationId === organisationId && session.record.parentSessionId === sessionId,
			)
			.sort((left, right) => left.sequence - right.sequence);

	const stopWork = async (
		ctx: CallContext,
		session: SessionState,
		release: "aborted" | "session_ended",
		reason?: string,
	): Promise<void> => {
		// One child failing (its audit sink, say) must not keep its siblings or this session from ending; the first
		// failure is rethrown once every session has run its teardowns. A closed child has already ended.
		let failure: { readonly error: unknown } | undefined;
		for (const child of childrenOf(session.record.organisationId, session.record.id)) {
			if (child.closed) continue;
			try {
				await stopWork(ctx, child, "aborted", `parent ${session.record.id} aborted`);
			} catch (error) {
				failure ??= { error };
			}
		}
		await session.conversation.abort(piContext(ctx));
		await sync(session);
		const run = session.aborts + 1;
		session.aborts = run;
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
		const session = requireSession(ctx, sessionId);
		await checkSession(ctx, sessionId, "operator", `session.${via}`);
		if (session.closed) throw new HarbourError("conflict", `Session ${sessionId} is closed`);
		if (input.text === "") throw new HarbourError("invalid", "A prompt needs text");
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
		const existing = session.submissions.get(id);
		if (existing !== undefined) return existing.submission;
		const submission: Submission = {
			id,
			sessionId,
			via,
			...(input.requestId === undefined ? {} : { requestId: input.requestId }),
		};
		session.submissions.set(id, { submission, pi });
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
			const profile = requireProfile(ctx, input.agentId);
			if (input.projectId === "") throw new HarbourError("invalid", "A session needs a project");
			// A project's profile runs only in that project; an organisation-wide one runs in any.
			if (profile.projectId !== undefined && profile.projectId !== input.projectId) {
				throw new HarbourError("invalid", `Agent profile ${profile.id} is for another project`);
			}
			if (input.parentSessionId !== undefined) requireSession(ctx, input.parentSessionId);
			// A child is in its parent's project, and an agent may create one only from its own session or its child.
			await check(ctx, {
				projectId: input.projectId,
				...(input.parentSessionId === undefined ? {} : { sessionId: input.parentSessionId }),
				needed: "operator",
				operation: "session.create",
			});
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
			const model = resolveModel(profile.model);
			const registry = createRegistry();
			const draft = { profile, record };
			registry.install(extensionFor(draft, []));
			const context = BACKGROUND_CONTEXT;
			const harness = await Harness.open(new MemoryStorage(), { models, registry, now: () => clock.now() }, context);
			const conversation = await harness.root(context, {
				agent: {
					model: { provider: model.provider, modelId: model.modelId },
					...(profile.model.thinking === undefined ? {} : { thinkingLevel: profile.model.thinking }),
				},
			});
			const view = await conversation.viewState(context);
			sequence += 1;
			const session: SessionState = {
				record,
				profile,
				sequence,
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
				submissions: new Map(),
				publishing: Promise.resolve(),
				aborts: 0,
				closed: false,
				stopWatching: () => {},
			};
			sessions.set(record.id, session);
			registry.install(extensionFor(session, toolsFor(session)));
			const unsubscribe = view.subscribe(() => sync(session));
			session.stopWatching = () => {
				unsubscribe();
				view.dispose();
			};
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
			const session = requireSession(ctx, sessionId);
			await checkSession(ctx, sessionId, "operator", "session.abort");
			if (session.closed) return;
			await stopWork(ctx, session, "aborted", reason);
		},
		async wait(ctx, sessionId, submissionId) {
			const session = requireSession(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.wait");
			const entry = session.submissions.get(submissionId);
			if (entry === undefined) throw new HarbourError("not_found", `No submission ${submissionId}`);
			const settled = await entry.pi.wait(piContext(ctx));
			await sync(session);
			const answerId = settled.status === "done" ? settled.answer : undefined;
			const answer =
				answerId === undefined
					? undefined
					: await session.conversation.commit((tx) => tx.entry(answerId), piContext(ctx));
			return runResultOf(sessionId, submissionId, settled, answer);
		},
		async watch(ctx, sessionId, watchOptions, onFrame) {
			const session = requireSession(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.watch");
			await sync(session);
			return session.stream.connect(watchOptions.after, onFrame);
		},
		async snapshot(ctx, sessionId) {
			const session = requireSession(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.snapshot");
			await sync(session);
			return session.stream.snapshot();
		},
		async close(ctx, sessionId) {
			const session = requireSession(ctx, sessionId);
			await checkSession(ctx, sessionId, "operator", "session.close");
			if (session.closed) return;
			session.closed = true;
			await stopWork(ctx, session, "session_ended", "closed");
			const ops = session.projector.close();
			applyStatus(session);
			if (ops.length > 0) session.publishing = session.publishing.then(() => session.stream.publish(ops));
			await session.publishing;
		},
	};

	const directory: SessionDirectory = {
		async get(ctx, sessionId) {
			const session = requireSession(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.get");
			return session.record;
		},
		async list(ctx, filter, page) {
			if (filter?.projectId !== undefined) {
				await check(ctx, { projectId: filter.projectId, needed: "viewer", operation: "session.list" });
			}
			const matching = [...sessions.values()]
				.filter((session) => session.record.organisationId === ctx.organisationId)
				.sort((left, right) => right.record.createdAt - left.record.createdAt || right.sequence - left.sequence)
				.map((session) => session.record)
				.filter((record) => matchesSessionFilter(record, filter));
			const records: SessionRecord[] = [];
			for (const record of matching) {
				if (access === undefined || (await access.allows(ctx, { sessionId: record.id, needed: "viewer" }))) {
					records.push(record);
				}
			}
			return paginate(records, page);
		},
		async children(ctx, sessionId) {
			requireSession(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.children");
			return childrenOf(ctx.organisationId, sessionId).map((session) => session.record);
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
			const existing = profilesByKey.get(keyOf(ctx.organisationId, profile.id));
			if (existing !== undefined && existing.projectId !== profile.projectId) {
				await check(ctx, {
					...(existing.projectId === undefined ? {} : { projectId: existing.projectId }),
					needed: "operator",
					operation: "session.profiles.put",
					subject: { kind: "session.profile", id: profile.id },
				});
			}
			profilesByKey.set(keyOf(ctx.organisationId, profile.id), profile);
			return profile;
		},
		async get(ctx, agentId) {
			const profile = requireProfile(ctx, agentId);
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
			const sorted = [...profilesByKey.values()]
				.filter((profile) => profile.organisationId === ctx.organisationId)
				.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
			for (const profile of sorted) {
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
			const key = keyOf(ctx.organisationId, hostId);
			const existing = hosts.get(key);
			for (const projectId of new Set([ctx.projectId, ...(existing === undefined ? [] : [existing.projectId])])) {
				await check(ctx, {
					...(projectId === undefined ? {} : { projectId }),
					needed: "operator",
					operation: "session.hostTools.register",
					subject: { kind: "session.host", id: hostId },
				});
			}
			const registration: HostRegistration = {
				tools: [...tools],
				handler,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			};
			hosts.set(key, registration);
			refreshHostTools(ctx.organisationId, hostId);
			return {
				async close() {
					if (hosts.get(key) !== registration) return;
					hosts.delete(key);
					refreshHostTools(ctx.organisationId, hostId);
				},
			};
		},
		async list(ctx, hostId) {
			const registration = hosts.get(keyOf(ctx.organisationId, hostId));
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
			for (const session of sessions.values()) {
				session.stopWatching();
				await session.harness.close(BACKGROUND_CONTEXT);
			}
		},
	};
}
