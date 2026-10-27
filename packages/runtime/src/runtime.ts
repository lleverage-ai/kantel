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
	type Wake,
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
import type { DeltaOp, ServerFrame } from "@harbour/protocol";
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
import type { HostCallback, SessionStore, StoredHost, StoredSession } from "./store.ts";

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
	/** Told of each session `resume()` could not open. Default: ignored. */
	readonly onResumeError?: (sessionId: SessionId, error: unknown) => void;
	/** Told when storing a session's wake failed; the next change writes it again. Default: ignored. */
	readonly onWakeError?: (sessionId: SessionId, error: unknown) => void;
	/**
	 * Told each time a session will next need a process at `at` (epoch ms), so a target whose process can be evicted
	 * arms a wakeup for it (a Durable Object alarm) and calls `resume()` when it fires. In a process that stays up,
	 * the runtime's own timers do this.
	 */
	readonly onWakeAt?: (at: number) => void;
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
	/**
	 * Host registrations kept in the store with their callback, so they outlive this process: a runtime opened later on
	 * the same store serves them through `hostHandler`.
	 */
	readonly hosts: DurableHosts;
	/**
	 * Runs every session whose stored wake is due: work a previous process left mid-run (it marked the session before
	 * admitting it), and sleeps (timers, retry backoffs) that have fallen due. Then arms this process's timer for the
	 * next wake. Call it once after start, and from a target's alarm; says how many sessions it ran. A session that
	 * fails to open is reported to `onResumeError` and skipped.
	 */
	resume(): Promise<number>;
	/** Closes every open session's Harness. Their work stays in storage for a runtime that opens them again. */
	close(): Promise<void>;
}

export interface DurableHostRegistration {
	/** Names this registration: removing it needs the name, so a stale holder cannot remove its replacement. */
	readonly registration: string;
}

/** Host registrations whose tools are served over a callback, stored so they survive a restart. */
export interface DurableHosts {
	/**
	 * Registers (or replaces) the host's tools, served over `callback`. The same checks as `HostToolBridge.register`.
	 * `owner` names who registered it; only the same owner may remove it.
	 */
	register(
		ctx: CallContext,
		hostId: string,
		tools: readonly HostToolDefinition[],
		callback: HostCallback,
		owner: string,
	): Promise<DurableHostRegistration>;
	/**
	 * Removes the registration if it is still the host's current one and `owner` made it. `not_found` when it is not
	 * (it was replaced, or never was); `forbidden` when someone else made it.
	 */
	remove(ctx: CallContext, hostId: string, registration: string, owner: string): Promise<void>;
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
	/**
	 * Stream publishes and directory writes, in order. Each step runs whether or not the one before it failed; a failure
	 * reaches whoever awaited that step.
	 */
	publishing: Promise<unknown>;
	/** The stored record is behind `record` (its last write failed or is still queued). */
	unsaved: boolean;
	/** The record last queued for writing. */
	saved: SessionRecord;
	/** Names this opening of the session's stream in the cursors it gives out. */
	readonly generation: string;
	/** Bumped on every reinstall of the session's host tools, so an older, slower one never installs over a newer one. */
	toolsVersion: number;
	/** The latest reinstall of the session's host tools. */
	installing: Promise<void>;
	aborts: number;
	closed: boolean;
	/** A close in progress; a second close waits for it. */
	closing?: Promise<void>;
	/** The wake last written (or queued) to the store. */
	wakeAt?: number;
	/** Wake writes, in order. */
	waking: Promise<unknown>;
	/** Resumes the Harness when its earliest sleep falls due. */
	sleepTimer?: ReturnType<typeof setTimeout>;
	/** Pi submits and aborts in progress; while any is, the stored wake stays due. */
	admissions: number;
	/** The Harness has closed (by this runtime, or itself after a storage failure). */
	harnessClosed: boolean;
	/** The store records the session as closed. */
	durablyClosed: boolean;
	stopWatching(): void;
}

/** Runs `step` after `queue` settles, whether it resolved or rejected. */
const after = (queue: Promise<unknown>, step: () => unknown): Promise<unknown> =>
	queue.then(step, step) as Promise<unknown>;

/**
 * Cursors carry the generation of the stream that issued them: a stream is rebuilt from the transcript each time a
 * runtime opens the session, so a cursor from an earlier generation names a position this stream never had, and the
 * client gets a snapshot instead of a false resume.
 */
const cursorIn = (generation: string, cursor: string) => `${generation}.${cursor}`;

function framesIn(generation: string, frame: ServerFrame): ServerFrame {
	switch (frame.type) {
		case "hello":
			return { ...frame, cursor: cursorIn(generation, frame.cursor) };
		case "snapshot":
			return { ...frame, snapshot: { ...frame.snapshot, cursor: cursorIn(generation, frame.snapshot.cursor) } };
		case "delta":
			return { ...frame, delta: { ...frame.delta, cursor: cursorIn(generation, frame.delta.cursor) } };
		default:
			return frame;
	}
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

	/**
	 * Queues a write of the session's record after the writes before it. The step writes the record as it is when the
	 * step runs, so a write that failed is made good by the next one.
	 */
	const persist = (session: OpenSession) => {
		session.unsaved = true;
		session.publishing = after(session.publishing, async () => {
			if (!session.unsaved) return;
			session.unsaved = false;
			try {
				await store.updateSession(session.record.id, { record: session.record });
			} catch (error) {
				session.unsaved = true;
				throw error;
			}
		});
	};

	/** Queues a write of when the session next needs a process, after the wake writes before it. */
	const writeWake = (session: OpenSession, at: number | undefined): Promise<unknown> => {
		if (session.wakeAt === at) return session.waking;
		session.wakeAt = at;
		session.waking = after(session.waking, () => store.setWake(session.record.id, at)).catch((error: unknown) => {
			// What the store holds is unknown now: NaN equals nothing and is never due, so the next wake writes again.
			if (session.wakeAt === at) session.wakeAt = Number.NaN;
			throw error;
		});
		if (at !== undefined) options.onWakeAt?.(at);
		return session.waking;
	};

	/**
	 * Runs `admit` (a Pi submit or abort) with the session marked as needing a process: the mark is stored first, and
	 * no wake from the Harness lowers it until `admit` has settled, so a process that dies between Pi's commit and the
	 * Harness's next wake leaves the session where `resume()` finds it. Then the stored wake follows the Harness again.
	 */
	const admitting = async <T>(session: OpenSession, admit: () => Promise<T>): Promise<T> => {
		session.admissions += 1;
		try {
			const now = clock.now();
			const marked = session.wakeAt !== undefined && session.wakeAt <= now;
			await (marked ? session.waking : writeWake(session, now));
			return await admit();
		} finally {
			session.admissions -= 1;
			if (session.admissions === 0 && !session.harnessClosed) followWake(session, session.harness.wake());
		}
	};

	/**
	 * Follows the Harness's wake (`HarnessOptions.onWake`): stores it, and arms this process's timer for its earliest
	 * sleep. With `onWake` set, Pi arms no timer of its own.
	 */
	const followWake = (session: OpenSession, wake: Wake) => {
		if (session.sleepTimer !== undefined) clearTimeout(session.sleepTimer);
		session.sleepTimer = undefined;
		const now = clock.now();
		const known = session.wakeAt !== undefined && Number.isFinite(session.wakeAt) ? session.wakeAt : now;
		const at = wake.active ? Math.min(known, now) : wake.at;
		// While input is being admitted the mark stays; `admitting` brings the wake up to date once it is in.
		if (session.admissions === 0 || (at !== undefined && at <= now)) {
			writeWake(session, at).catch((error: unknown) => options.onWakeError?.(session.record.id, error));
		}
		if (!wake.active && wake.at !== undefined && !session.closed && !session.harnessClosed && !closed) {
			session.sleepTimer = setTimeout(
				() => {
					session.sleepTimer = undefined;
					if (closed || session.harnessClosed || open.get(session.record.id) !== session) return;
					try {
						session.harness.resume();
					} catch (error) {
						options.onWakeError?.(session.record.id, error);
					}
				},
				Math.max(0, wake.at - clock.now()),
			);
			(session.sleepTimer as { unref?: () => void }).unref?.();
		}
	};

	const publish = (session: OpenSession, ops: readonly DeltaOp[]) => {
		if (ops.length > 0) session.publishing = after(session.publishing, () => session.stream.publish(ops));
	};

	const applyStatus = (session: OpenSession) => {
		const status = session.projector.status;
		if (session.record.status !== status) session.record = { ...session.record, status, updatedAt: clock.now() };
		if (session.record !== session.saved || session.unsaved) {
			session.saved = session.record;
			persist(session);
		}
	};

	/** Brings the stream and the directory record up to the session's current view. */
	const sync = (session: OpenSession): Promise<unknown> => {
		publish(session, session.projector.project(session.view.value));
		applyStatus(session);
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

	/** Installs the session's current host tools, unless a newer install started meanwhile. */
	const reinstallTools = (session: OpenSession): Promise<void> => {
		session.toolsVersion += 1;
		const version = session.toolsVersion;
		const installing = (async () => {
			const tools = await toolsFor(session);
			if (version === session.toolsVersion) session.registry.install(extensionFor(session, tools));
		})();
		session.installing = installing;
		return installing;
	};

	/** Waits until the latest install of the session's host tools is in, following any that supersede it meanwhile. */
	const toolsInstalled = async (session: OpenSession) => {
		for (;;) {
			const latest = session.installing;
			await latest;
			if (latest === session.installing) return;
		}
	};

	/** Reinstalls each affected open session's host tools after a registration changes. */
	const refreshHostTools = async (organisationId: OrganisationId, hostId: string) => {
		for (const session of open.values()) {
			if (session.record.organisationId !== organisationId || session.profile.hostId !== hostId) continue;
			await reinstallTools(session);
		}
	};

	/** Opens the session's Harness on its storage, or returns it if it is open already. */
	const ensureOpen = (stored: StoredSession): Promise<OpenSession> => {
		const id = stored.record.id;
		// A session is in `open` before it is ready (so registration changes reach it while its tools install); callers
		// wait for the opening to finish.
		const pending = opening.get(id);
		if (pending !== undefined) return pending;
		const current = open.get(id);
		if (current !== undefined) return Promise.resolve(current);
		if (closed) return Promise.reject(new HarbourError("unavailable", "The session runtime is closed"));
		const started = openSession(stored).finally(() => opening.delete(id));
		opening.set(id, started);
		return started;
	};

	const openSession = async (stored: StoredSession): Promise<OpenSession> => {
		const { record, profile } = stored;
		const model = resolveModel(profile.model);
		const registry = createRegistry();
		// No tools yet: they are installed once the session is open, where a registration change also reaches it.
		registry.install(extensionFor({ profile }, []));
		const context = BACKGROUND_CONTEXT;
		const storage = await options.storage(record);
		// Wakes go to the session once it exists; the first (from open) is read with `harness.wake()` below.
		let onWake: (wake: Wake) => void = () => {};
		const harness = await Harness.open(
			storage,
			{ models, registry, now: () => clock.now(), onWake: (wake) => onWake(wake) },
			context,
		);
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
			unsaved: false,
			saved: record,
			toolsVersion: 0,
			installing: Promise.resolve(),
			generation: crypto.randomUUID().slice(0, 8),
			aborts: stored.aborts,
			closed: stored.closed,
			durablyClosed: stored.closed,
			stopWatching: () => {},
			...(stored.wakeAt === undefined ? {} : { wakeAt: stored.wakeAt }),
			waking: Promise.resolve(),
			admissions: 0,
			harnessClosed: false,
		};
		onWake = (wake) => followWake(session, wake);
		open.set(record.id, session);
		const unsubscribe = view.subscribe(() => sync(session));
		// The Harness closes itself after a failed storage call: the session is then opened afresh on next use.
		const unsubscribeClose = harness.subscribeClose(() => {
			session.harnessClosed = true;
			if (session.sleepTimer !== undefined) clearTimeout(session.sleepTimer);
			session.sleepTimer = undefined;
			if (open.get(record.id) === session) open.delete(record.id);
		});
		session.stopWatching = () => {
			unsubscribe();
			unsubscribeClose();
			view.dispose();
		};
		try {
			// A registration change may start a newer install meanwhile; opening finishes once the latest is in.
			void reinstallTools(session);
			await toolsInstalled(session);
			if (session.closed) {
				publish(session, session.projector.project(view.value));
				publish(session, session.projector.close());
				applyStatus(session);
			} else {
				// Work a previous process left running (a model call, a tool call) carries on from its last commit.
				harness.resume();
				sync(session);
			}
			followWake(session, harness.wake());
			await session.publishing;
		} catch (error) {
			open.delete(record.id);
			session.stopWatching();
			await harness.close(context).catch(() => undefined);
			throw error;
		}
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
		await admitting(session, () => session.conversation.abort(piContext(ctx)));
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
		const pi = await admitting(session, () =>
			session.conversation.submit(
				{
					type: "input",
					content: input.text,
					whenBusy: via === "steer" ? "steer" : "followUp",
					entry: harbourUserEntry(via, input.requestId),
					...(input.requestId === undefined ? {} : { requestId: input.requestId }),
				},
				piContext(ctx),
			),
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
			const prefix = `${session.generation}.`;
			const resumeFrom = watchOptions.after?.startsWith(prefix) ? watchOptions.after.slice(prefix.length) : undefined;
			return session.stream.connect(resumeFrom, (frame) => onFrame(framesIn(session.generation, frame)));
		},
		async snapshot(ctx, sessionId) {
			await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.snapshot");
			const session = await requireOpen(ctx, sessionId);
			await sync(session);
			const snapshot = await session.stream.snapshot();
			return { ...snapshot, cursor: cursorIn(session.generation, snapshot.cursor) };
		},
		async close(ctx, sessionId) {
			const stored = await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "operator", "session.close");
			if (stored.closed) return;
			const session = await ensureOpen(stored);
			if (session.closing !== undefined) return session.closing;
			if (session.durablyClosed) return;
			// Input is refused from here on. A close that fails part way can be retried: teardowns are idempotent, and the
			// session counts as closed only once the store says so.
			session.closed = true;
			const closing = (async () => {
				await stopWork(ctx, session, "session_ended", "closed");
				publish(session, session.projector.close());
				applyStatus(session);
				await session.publishing;
				await store.updateSession(sessionId, { record: session.record, closed: true });
				session.durablyClosed = true;
			})();
			session.closing = closing;
			try {
				await closing;
			} finally {
				session.closing = undefined;
			}
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

	/**
	 * Stores a registration that replaces the host's last, after the checks: unique tool names, and operator on the
	 * project the call names (or across the organisation) and on the scope of the registration it replaces, so no one
	 * takes over another project's tools.
	 */
	const putRegistration = async (
		ctx: CallContext,
		hostId: string,
		tools: readonly HostToolDefinition[],
		serve: { readonly handler: HostToolHandler } | { readonly callback: HostCallback; readonly owner: string },
	): Promise<string> => {
		const names = new Set<string>();
		for (const tool of tools) {
			if (tool.name === "" || names.has(tool.name)) {
				throw new HarbourError("invalid", `Tool names must be unique and not empty: "${tool.name}"`);
			}
			names.add(tool.name);
		}
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
		if ("handler" in serve) localHandlers.set(registration, serve.handler);
		if (existing !== undefined) localHandlers.delete(existing.registration);
		await store.putHost({
			organisationId: ctx.organisationId,
			hostId,
			tools: [...tools],
			registration,
			...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			...("callback" in serve ? { callback: serve.callback, owner: serve.owner } : {}),
		});
		await refreshHostTools(ctx.organisationId, hostId);
		return registration;
	};

	/** Arms this process's timer for the earliest wake of a session not open here. */
	let resumeTimer: ReturnType<typeof setTimeout> | undefined;
	let resumeTimerAt: number | undefined;
	const armResume = (at: number) => {
		if (closed || (resumeTimerAt !== undefined && resumeTimerAt <= at)) return;
		if (resumeTimer !== undefined) clearTimeout(resumeTimer);
		resumeTimerAt = at;
		resumeTimer = setTimeout(
			() => {
				resumeTimer = undefined;
				resumeTimerAt = undefined;
				void resume().catch(() => undefined);
			},
			Math.max(0, at - clock.now()),
		);
		(resumeTimer as { unref?: () => void }).unref?.();
	};

	const resume = async (): Promise<number> => {
		let resumed = 0;
		const now = clock.now();
		for (const stored of await store.wakeable(now)) {
			try {
				const session = await ensureOpen(stored);
				// Already open here: its sleep is due, or its work was cut off; either way, run it.
				if (!session.closed) session.harness.resume();
				resumed += 1;
			} catch (error) {
				options.onResumeError?.(stored.record.id, error);
			}
		}
		// The earliest still to come: a due wake (a session running now) must not hide a later sleeper's.
		const next = await store.nextWake(now);
		if (next !== undefined) armResume(next);
		return resumed;
	};

	const hosts: DurableHosts = {
		async register(ctx, hostId, tools, callback, owner) {
			return { registration: await putRegistration(ctx, hostId, tools, { callback, owner }) };
		},
		async remove(ctx, hostId, registration, owner) {
			const current = await store.host(ctx.organisationId, hostId);
			// A stale holder (its registration since replaced) finds nothing of its own to remove.
			if (current === undefined || current.registration !== registration) {
				throw new HarbourError("not_found", `No such registration for host ${hostId}`);
			}
			if (current.owner !== owner) {
				throw new HarbourError("forbidden", "Only whoever registered a host may remove it");
			}
			// And only while they may still register there: an owner who has lost the project loses its hosts too.
			await check(ctx, {
				...(current.projectId === undefined ? {} : { projectId: current.projectId }),
				needed: "operator",
				operation: "session.hostTools.remove",
				subject: { kind: "session.host", id: hostId },
			});
			if (!(await store.deleteHost(ctx.organisationId, hostId, registration))) {
				throw new HarbourError("not_found", `No such registration for host ${hostId}`);
			}
			localHandlers.delete(registration);
			await refreshHostTools(ctx.organisationId, hostId);
		},
	};

	const hostTools: HostToolBridge = {
		async register(ctx, hostId, tools, handler) {
			const registration = await putRegistration(ctx, hostId, tools, { handler });
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
		hosts,
		sessionEnd: ends.hook,
		...(access === undefined ? {} : { access }),
		resume,
		async close() {
			closed = true;
			if (resumeTimer !== undefined) clearTimeout(resumeTimer);
			await Promise.allSettled([...opening.values()]);
			for (const session of [...open.values()]) {
				open.delete(session.record.id);
				if (session.sleepTimer !== undefined) clearTimeout(session.sleepTimer);
				session.stopWatching();
				await session.waking.catch(() => undefined);
				await session.publishing.catch(() => undefined);
				await session.harness.close(BACKGROUND_CONTEXT);
			}
		},
	};
}
