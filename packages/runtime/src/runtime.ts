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
	type ConversationId,
	type ConversationView,
	createRegistry,
	defineExtension,
	type EntryRecord,
	type Extension,
	Harness,
	type Registry,
	type Storage,
	type SubmissionId,
	section,
	type ToolRegistration,
	type Wake,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
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
	type ModelThinking,
	type OrganisationId,
	type ProjectAccess,
	type PromptInput,
	type Sandboxes,
	type SessionBranching,
	type SessionDirectory,
	type SessionEnd,
	type SessionEndHook,
	type SessionHistory,
	type SessionId,
	type SessionModelState,
	type SessionModels,
	type SessionRecord,
	type SessionRuntime,
	type Submission,
	systemClock,
	systemContext,
	type WorkspaceId,
} from "@harbour/contracts";
import type { DeltaOp, ServerFrame } from "@harbour/protocol";
import { createMemorySessionStream, type MemorySessionStream } from "@harbour/protocol/memory";
import { ACTIVE_CONVERSATION, copyEntries, entryBefore, FORK_SKILLS } from "./branching.ts";
import {
	contextEntryOf,
	contextSkillsOf,
	MEMORY_TOOL_NAMES,
	memorySpacesOf,
	memoryToolDefinitions,
	memoryToolHandler,
	type SessionMemoryOptions,
	type SessionSkillsOptions,
	sessionContextEntry,
} from "./context.ts";
import { historyAnchor, historyLimit, readHistory } from "./history.ts";
import {
	ConversationProjector,
	createSessionEndHook,
	HARBOUR_USER_ENTRY,
	harbourUserEntry,
	hostToolAsPiTool,
	joinPromptLayers,
	matchesSessionFilter,
	paginate,
	piContext,
	type ResolvedModel,
	runResultOf,
} from "./index.ts";
import {
	clampThinking,
	isModelThinking,
	modelOptions,
	optionIdOf,
	requestedChoice,
	shownThinking,
} from "./session-models.ts";
import type { HostCallback, SessionStore, StoredHost, StoredSession } from "./store.ts";

export {
	HARBOUR_CONTEXT_ENTRY,
	type HarbourContextEntryData,
	type SessionMemoryOptions,
	type SessionSkillsOptions,
} from "./context.ts";

export interface SessionRuntimeOptions {
	/** Directory, profiles, submissions and host registrations. */
	readonly store: SessionStore;
	/**
	 * Opens the Pi Durable storage of one session, the same storage every time it is asked for the same session. The
	 * Harness owns what it is given and closes it when the session closes in this runtime.
	 */
	readonly storage: (session: SessionRecord) => Storage | Promise<Storage>;
	/**
	 * Archives a closed session's Pi storage, such as `archiveSqlPiStorage` from `@harbour/runtime/sql`, which keeps its
	 * records and drops its tables so a shared database's schema doesn't grow with every session it has held (#216).
	 * Called once the session has closed durably and its Harness has closed here: on `runtime.close`, and on the runtime's
	 * own close for a closed session it opened again. `storage` must open an archived session again, for reading. A
	 * failure goes to `onArchiveError` and leaves the session as it was. Without it nothing is archived.
	 */
	readonly archive?: (session: SessionRecord) => Promise<unknown>;
	/** Told when archiving a closed session failed. Default: ignored. */
	readonly onArchiveError?: (sessionId: SessionId, error: unknown) => void;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/**
	 * The Pi model collection sessions run on: one for every session, or a function giving each session its own when it
	 * opens, such as `harbourModels` from `@harbour/runtime/models`. A function needs `resolveModel`.
	 */
	readonly models: Models | ((session: SessionRecord) => Models | Promise<Models>);
	/** Maps a profile's model route to a Pi model. Default: the first model of the first provider of a shared `models`. */
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
	readonly sandboxes?: Pick<Sandboxes, "releaseSession"> & Partial<Pick<Sandboxes, "sweep">>;
	/**
	 * With `sandboxes.sweep`: how often this process sweeps expired leases while it holds a session open, as the alarm for
	 * lease expiry. `resume()` (a target's alarm) sweeps too. Default 60 s.
	 */
	readonly leaseSweepMs?: number;
	/** Told when a lease sweep failed; the next sweep tries again. Default: ignored. */
	readonly onSweepError?: (error: unknown) => void;
	/** How long `resume()` waits for its lease sweep before it recovers sessions anyway. Default 5 s. */
	readonly sweepWaitMs?: number;
	/**
	 * Serves a durable registration's tools (one stored with a callback), such as `callbackHostToolHandler` over its URL
	 * and secret. Without it only handlers registered in this process serve tools.
	 */
	readonly hostHandler?: (host: StoredHost) => HostToolHandler | undefined;
	/**
	 * Tools this deployment serves in its own process, beside host tools: Harbour's components as Pi tools, such as the
	 * browser's (`@harbour/browser`). Asked for each session as its tools install, bound to that session; the session
	 * gets those its profile names in `tools`, before its host's. Their results may carry images, which the transcript
	 * shows on the tool's item.
	 */
	readonly tools?: (session: SessionRecord) => readonly ToolRegistration[];
	/**
	 * The execution environment a session's tools work in (Pi Durable's `ExecutionEnv`, which `read`, `write`, `edit`
	 * and `bash` need), such as `createSandboxExecutionEnv` over the session's workspace. Built once when the session
	 * opens in this process and given to its Harness; `undefined` for a session with none, whose tools that need one
	 * then fail with an error result. Building it must acquire nothing: a sandbox is leased by the first command that
	 * needs one, and released by the session-end hook. Abort and close call its `cleanup`, which stops waiting for
	 * commands still running.
	 */
	readonly environment?: (session: SessionRecord) => ExecutionEnv | undefined;
	/**
	 * The workspace a session created without one gets, by the new session's ID, such as a keyed ID its environment
	 * creates on first use. Giving an ID creates nothing. Without it (or when it answers `undefined`), such a session has
	 * no workspace.
	 */
	readonly defaultWorkspaceId?: (sessionId: SessionId) => WorkspaceId | undefined;
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
	/**
	 * The skills sessions see (`./context.ts`): pinned on a session's first prompt, mounted by the host and listed through
	 * the host's renderer. Without it sessions get no skills.
	 */
	readonly skills?: SessionSkillsOptions;
	/**
	 * The memory sessions read (`./context.ts`): recalled over the profile's memory scopes on the first prompt, and the
	 * `memory_search` and `memory_read` tools. Without it sessions get no memory.
	 */
	readonly memory?: SessionMemoryOptions;
}

export interface SessionRuntimeService {
	readonly runtime: SessionRuntime;
	/** Each session's transcript in pages, newest first, for a client scrolling back (proposed, issue #6). */
	readonly history: SessionHistory;
	/** The models each session may name and what it runs with now, for a client's model and thinking pickers. */
	readonly models: SessionModels;
	/** Forking a session from an answer, and editing a message to rerun from it (proposed, issue #6). */
	readonly branching: SessionBranching;
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
	 * fails to open is reported to `onResumeError` and skipped. It sweeps expired sandbox leases first (`sweepLeases`).
	 */
	resume(): Promise<number>;
	/**
	 * Releases every sandbox lease past its TTL through `sandboxes.sweep`, as the `session` component; says how many.
	 * Without `sweep` it does nothing. The runtime calls it from `resume()` and, while this process holds a session
	 * open, every `leaseSweepMs`; a failure goes to `onSweepError`.
	 */
	sweepLeases(): Promise<number>;
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
	/** The conversation the session shows and runs: the root, or the fork an edit made (`branching.ts`). */
	conversation: Conversation;
	/** The session's Pi models: what its prompts may name (`SessionModels`). */
	readonly models: Models;
	readonly registry: Registry;
	/** The session's execution environment (`SessionRuntimeOptions.environment`), if it has one. */
	readonly env: ExecutionEnv | undefined;
	view: AttachedReplicatedState<ConversationView>;
	/** Stops following `view`. */
	unsubscribeView: () => void;
	stream: MemorySessionStream;
	projector: ConversationProjector;
	/** Every `watch` of the session, so an edit can move each onto the new stream. */
	readonly watchers: Set<Watcher>;
	/** An edit in progress: a second one is refused until it is in. */
	editing: boolean;
	/**
	 * Stream publishes and directory writes, in order. Each step runs whether or not the one before it failed; a failure
	 * reaches whoever awaited that step.
	 */
	publishing: Promise<unknown>;
	/** The stored record is behind `record` (its last write failed or is still queued). */
	unsaved: boolean;
	/** The record last queued for writing. */
	saved: SessionRecord;
	/** Names this opening of the session's stream in the cursors it gives out; an edit starts a new one. */
	generation: string;
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
	/** Placing the session's skills and recall before its first prompt; later inputs wait for it. */
	givingContext?: Promise<void>;
}

/** How many of a transcript's first entries are read to tell whether the session has started. */
const CONTEXT_SCAN = 16;
/** The request ID of a session's context write, so it is admitted once. */
const CONTEXT_REQUEST = "harbour.context";

/** One `watch`: its connection to the session's current stream, which an edit replaces. */
interface Watcher {
	closed: boolean;
	connection?: { close(): Promise<void> };
	/** Connects to the session's current stream: after `resumeFrom`, or with a snapshot. */
	connect(resumeFrom: string | undefined): Promise<void>;
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

/** The default `resolveModel`: the first model of the first provider. Per-session models have no default. */
function firstModelOf(models: SessionRuntimeOptions["models"]): (choice: ModelChoice) => ResolvedModel {
	if (typeof models === "function") throw new HarbourError("invalid", "Per-session models need resolveModel");
	return () => {
		const provider = models.getProviders()[0];
		const model = provider === undefined ? undefined : models.getModels(provider.id)[0];
		if (provider === undefined || model === undefined) throw new HarbourError("unavailable", "No model is configured");
		return { provider: provider.id, modelId: model.id };
	};
}

export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntimeService {
	const { store, models } = options;
	const clock = options.clock ?? systemClock;
	const open = new Map<SessionId, OpenSession>();
	const opening = new Map<SessionId, Promise<OpenSession>>();
	/** Closed sessions being archived (`options.archive`): opening one waits for it. */
	const archiving = new Map<SessionId, Promise<void>>();
	/** Handlers registered in this process, by registration. */
	const localHandlers = new Map<string, HostToolHandler>();
	let closed = false;

	const resolveModel = options.resolveModel ?? firstModelOf(models);

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
			if (session.admissions === 0 && !session.harnessClosed && !closed) {
				try {
					followWake(session, session.harness.wake());
				} catch {
					// The Harness is closing: the mark stays due, and the next opening sets the real wake.
				}
			}
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
		// The stream the ops were projected for: an edit may replace the session's stream before the step runs.
		const stream = session.stream;
		if (ops.length > 0) session.publishing = after(session.publishing, () => stream.publish(ops));
	};

	const newStream = (record: SessionRecord) =>
		createMemorySessionStream({
			sessionId: record.id,
			...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
			...(record.title === undefined ? {} : { title: record.title }),
			now: () => clock.now(),
		});

	const agentOf = (profile: AgentProfile) => {
		const model = resolveModel(profile.model);
		return {
			model: { provider: model.provider, modelId: model.modelId },
			...(profile.model.thinking === undefined ? {} : { thinkingLevel: profile.model.thinking }),
		};
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

	/** The memory tools' host in tool calls and their audit events. */
	const MEMORY_HOST = "harbour.memory";

	const toolsFor = async (session: Pick<OpenSession, "profile" | "record">): Promise<ToolRegistration[]> => {
		const { profile, record } = session;
		// The runtime's own tools come first; a memory or host tool of the same name doesn't replace one.
		const own = (options.tools?.(record) ?? []).filter((tool) => profile.tools.includes(tool.name));
		const tools: ToolRegistration[] = [...own];
		const taken = new Set(own.map((tool) => tool.name));
		// Every session with memory scopes gets the memory tools, served from the runtime's memory as its agent.
		const spaceIds = memorySpacesOf(options.memory, profile, record);
		const memory = options.memory;
		if (memory !== undefined && spaceIds.length > 0) {
			const handler = memoryToolHandler(memory, spaceIds, () => clock.now());
			for (const definition of memoryToolDefinitions)
				if (!taken.has(definition.name)) tools.push(asPiTool(record, MEMORY_HOST, definition, () => handler));
			for (const name of Object.values(MEMORY_TOOL_NAMES)) taken.add(name);
		}
		const hostId = profile.hostId;
		if (hostId === undefined) return tools;
		// A registration whose handler is gone (served by a process that has since stopped) offers nothing.
		const host = await store.host(record.organisationId, hostId);
		const served = host === undefined || handlerOf(host) === undefined ? [] : host.tools;
		for (const definition of served) {
			if (!profile.tools.includes(definition.name) || taken.has(definition.name)) continue;
			tools.push(
				asPiTool(record, hostId, definition, async () => {
					const host = await store.host(record.organisationId, hostId);
					return host?.tools.some((tool) => tool.name === definition.name) ? handlerOf(host) : undefined;
				}),
			);
		}
		return tools;
	};

	/** A tool as a Pi tool of the session, audited as it starts and finishes. */
	const asPiTool = (
		record: SessionRecord,
		hostId: string,
		definition: HostToolDefinition,
		handler: () => HostToolHandler | undefined | Promise<HostToolHandler | undefined>,
	): ToolRegistration => {
		const agentActor = { kind: "agent", agentId: record.agentId, sessionId: record.id } as const;
		return hostToolAsPiTool(definition, {
			call: {
				hostId,
				sessionId: record.id,
				organisationId: record.organisationId,
				projectId: record.projectId,
				agentId: record.agentId,
			},
			handler,
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
		});
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

	/**
	 * Opens the session's Harness on its storage, or returns it if it is open already. `seed` is the history a forked
	 * session starts with, copied into its root conversation when the root is created.
	 */
	const ensureOpen = (stored: StoredSession, seed?: readonly EntryRecord[]): Promise<OpenSession> => {
		const id = stored.record.id;
		// A session is in `open` before it is ready (so registration changes reach it while its tools install); callers
		// wait for the opening to finish.
		const pending = opening.get(id);
		if (pending !== undefined) return pending;
		const current = open.get(id);
		if (current !== undefined) return Promise.resolve(current);
		if (closed) return Promise.reject(new HarbourError("unavailable", "The session runtime is closed"));
		const archived = archiving.get(id);
		if (archived !== undefined) return archived.then(() => ensureOpen(stored, seed));
		const started = openSession(stored, seed).finally(() => opening.delete(id));
		opening.set(id, started);
		return started;
	};

	const openSession = async (stored: StoredSession, seed?: readonly EntryRecord[]): Promise<OpenSession> => {
		const { record, profile } = stored;
		const agent = agentOf(profile);
		const registry = createRegistry();
		// No tools yet: they are installed once the session is open, where a registration change also reaches it.
		registry.install(extensionFor({ profile }, []));
		const context = BACKGROUND_CONTEXT;
		const sessionModels = typeof models === "function" ? await models(record) : models;
		const storage = await options.storage(record);
		// Built here, acquiring nothing: what its commands need is acquired by the first command that needs it.
		const env = options.environment?.(record);
		// Wakes go to the session once it exists; the first (from open) is read with `harness.wake()` below.
		let onWake: (wake: Wake) => void = () => {};
		const harness = await Harness.open(
			storage,
			{
				models: sessionModels,
				registry,
				now: () => clock.now(),
				onWake: (wake) => onWake(wake),
				...(env === undefined ? {} : { env: () => env }),
			},
			context,
		);
		let conversation: Conversation;
		let view: AttachedReplicatedState<ConversationView>;
		try {
			conversation = await harness.root(context, {
				agent,
				...(seed === undefined ? {} : { init: (tx, conversationId) => copyEntries(tx, conversationId, seed) }),
			});
			// After an edit the session shows the fork the edit made, not the root.
			const active = (await harness.snapshot(ACTIVE_CONVERSATION, context))?.conversationId;
			if (active !== undefined && active !== conversation.id) {
				conversation = (await harness.conversation(active as ConversationId, context)) ?? conversation;
			}
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
			models: sessionModels,
			registry,
			env,
			view,
			unsubscribeView: () => {},
			stream: newStream(record),
			projector: new ConversationProjector({ now: () => clock.now() }),
			watchers: new Set(),
			editing: false,
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
		session.unsubscribeView = view.subscribe(() => sync(session));
		// The Harness closes itself after a failed storage call. Its timer goes with it; the session stays in `open`, so
		// calls fail rather than racing a second opening against this one's queued writes and close.
		const unsubscribeClose = harness.subscribeClose(() => {
			session.harnessClosed = true;
			if (session.sleepTimer !== undefined) clearTimeout(session.sleepTimer);
			session.sleepTimer = undefined;
		});
		session.stopWatching = () => {
			session.unsubscribeView();
			unsubscribeClose();
			session.view.dispose();
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
			armSweep();
		} catch (error) {
			open.delete(record.id);
			session.stopWatching();
			await harness.close(context).catch(() => undefined);
			throw error;
		}
		return session;
	};

	const requireOpen = async (ctx: CallContext, sessionId: SessionId) => ensureOpen(await requireStored(ctx, sessionId));

	/** Closes the session's Harness in this runtime, once what it queued is written. It stays in storage. */
	const shutDown = async (session: OpenSession): Promise<void> => {
		if (session.sleepTimer !== undefined) clearTimeout(session.sleepTimer);
		session.stopWatching();
		await session.waking.catch(() => undefined);
		await session.publishing.catch(() => undefined);
		await session.harness.close(BACKGROUND_CONTEXT);
		await session.env?.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
	};

	/**
	 * Takes a durably closed session out of this runtime and archives its Pi storage (`options.archive`). Opening it again
	 * meanwhile waits for the archive, then opens it from there. Never rejects: a failure goes to `onArchiveError`.
	 */
	const archiveClosed = (session: OpenSession, archive: NonNullable<SessionRuntimeOptions["archive"]>) => {
		const id = session.record.id;
		const running = (async () => {
			if (open.get(id) === session) open.delete(id);
			try {
				await shutDown(session);
				await archive(session.record);
			} catch (error) {
				try {
					options.onArchiveError?.(id, error);
				} catch {
					// A reporter that throws must not fail the close.
				}
			}
		})().finally(() => {
			if (archiving.get(id) === running) archiving.delete(id);
		});
		archiving.set(id, running);
		return running;
	};

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
		// Stops waiting for commands still running; what the session holds is released by the session-end hook below.
		await session.env?.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
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

	/**
	 * Places the session's skills and recall (`./context.ts`) before its first prompt, once: a session whose transcript
	 * already holds input or a context entry has been given it. The write's request ID makes a retry after a crash
	 * between the write and the prompt land nothing twice.
	 */
	const giveContext = async (ctx: CallContext, session: OpenSession, query: string): Promise<void> => {
		if (options.skills === undefined && options.memory === undefined) return;
		session.givingContext ??= (async () => {
			// A fork's transcript already holds its source's context; it mounts the source's revisions, once (#210).
			if (await mountForkSkills(ctx, session)) return;
			const first = await session.conversation.entries({ order: "ascending" }, CONTEXT_SCAN, undefined, piContext(ctx));
			const started = first.next !== undefined || contextEntryOf(first.items) !== undefined;
			if (started || first.items.some((entry) => entry.kind === "pi.user" || entry.kind === HARBOUR_USER_ENTRY)) {
				return;
			}
			const entry = await sessionContextEntry({
				record: session.record,
				profile: session.profile,
				query,
				skills: options.skills,
				memory: options.memory,
				now: clock.now(),
			});
			if (entry === undefined) return;
			const written = await admitting(session, () =>
				session.conversation.submit({ type: "write", entry, requestId: CONTEXT_REQUEST }, piContext(ctx)),
			);
			await written.wait(piContext(ctx));
		})();
		const giving = session.givingContext;
		try {
			await giving;
		} catch (error) {
			// Recall or pinning failed: this prompt fails, and the next one tries again.
			if (session.givingContext === giving) session.givingContext = undefined;
			throw error;
		}
	};

	/**
	 * Mounts a forked session's skills, the revisions its source pinned (`FORK_SKILLS`), unless it has done so already.
	 * Says whether the session is a fork, whose context needs nothing more: its transcript holds its source's.
	 */
	const mountForkSkills = async (ctx: CallContext, session: OpenSession): Promise<boolean> => {
		const fork = await session.harness.snapshot(FORK_SKILLS, piContext(ctx));
		if (fork?.skills === undefined) return false;
		if (fork.mounted === true || options.skills?.mount === undefined) return true;
		const pinnedAt = clock.now();
		await options.skills.mount(
			session.record,
			fork.skills.map((pin) => ({ sessionId: session.record.id, ...pin, pinnedAt })),
		);
		await session.harness.commit(async (tx) => {
			(await tx.doc(FORK_SKILLS)).mounted = true;
		}, piContext(ctx));
		return true;
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
		const chose = await applyChoice(ctx, session, input);
		await giveContext(ctx, session, input.text);
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
				data: {
					via,
					...(input.requestId === undefined ? {} : { requestId: input.requestId }),
					...(chose === undefined ? {} : chose),
				},
			},
		]);
		return submission;
	};

	/**
	 * A prompt's `model` and `thinking`, kept with the session's conversation: Pi Durable reads them at each model call's
	 * start, so they apply from the run's next call and to every later run, and survive the session reopening. A level
	 * the model lacks is clamped to the nearest it has. Returns what changed, for the audit event, or undefined.
	 */
	const applyChoice = async (
		ctx: CallContext,
		session: OpenSession,
		input: PromptInput,
	): Promise<{ model?: string; thinking?: ModelThinking } | undefined> => {
		if (input.model === undefined && input.thinking === undefined) return undefined;
		const asked = requestedChoice(session.models, input);
		const agent = await session.conversation.agent(piContext(ctx));
		const current =
			agent.model === undefined ? undefined : session.models.getModel(agent.model.provider, agent.model.modelId);
		const model = asked.model ?? current;
		if (model === undefined) throw new HarbourError("invalid", "The session has no model to think with");
		const level = clampThinking(
			model,
			asked.thinking ?? (isModelThinking(agent.thinkingLevel) ? agent.thinkingLevel : "off"),
		);
		const sameModel = agent.model?.provider === model.provider && agent.model.modelId === model.id;
		if (sameModel && agent.thinkingLevel === level) return undefined;
		await session.conversation.configure(
			{
				...(sameModel ? {} : { model: { provider: model.provider, modelId: model.id } }),
				...(agent.thinkingLevel === level ? {} : { thinkingLevel: level }),
			},
			piContext(ctx),
		);
		return {
			...(sameModel ? {} : { model: optionIdOf(model) }),
			...(agent.thinkingLevel === level ? {} : { thinking: level }),
		};
	};

	/** What a session's pickers show, off its models, the conversation's agent and the profile. */
	const modelStateOf = (
		sessionModels: Models,
		profile: AgentProfile,
		agent: { readonly model?: { provider: string; modelId: string }; readonly thinkingLevel?: string } | undefined,
	): SessionModelState => {
		const profileModel = resolveModel(profile.model);
		const options = modelOptions(sessionModels, profileModel);
		const defaultModel = sessionModels.getModel(profileModel.provider, profileModel.modelId);
		const defaultThinking = shownThinking(defaultModel, profile.model.thinking ?? "off");
		const defaults =
			defaultModel === undefined
				? undefined
				: { model: optionIdOf(defaultModel), ...(defaultThinking === undefined ? {} : { thinking: defaultThinking }) };
		if (agent === undefined)
			return { models: options, ...(defaults === undefined ? {} : { defaults, selected: defaults }) };
		const current =
			agent.model === undefined ? undefined : sessionModels.getModel(agent.model.provider, agent.model.modelId);
		const level = isModelThinking(agent.thinkingLevel) ? agent.thinkingLevel : "off";
		const thinking = current === undefined ? undefined : shownThinking(current, level);
		const selected =
			current === undefined
				? undefined
				: { model: optionIdOf(current), ...(thinking === undefined ? {} : { thinking }) };
		return {
			models: options,
			...(selected === undefined ? {} : { selected }),
			...(defaults === undefined ? {} : { defaults }),
		};
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
			const id = crypto.randomUUID();
			const workspaceId = input.workspaceId ?? options.defaultWorkspaceId?.(id);
			const record: SessionRecord = {
				id,
				organisationId: ctx.organisationId,
				projectId: input.projectId,
				agentId: profile.id,
				...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
				...(workspaceId === undefined ? {} : { workspaceId }),
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
			// An edit replaces the session's stream; the watcher then connects to the new one, which starts it with a hello
			// and a snapshot, as a client that reconnects gets.
			const watcher: Watcher = {
				closed: false,
				async connect(after) {
					const { stream, generation } = session;
					const connection = await stream.connect(after, (frame) => onFrame(framesIn(generation, frame)));
					if (watcher.closed) await connection.close();
					else watcher.connection = connection;
				},
			};
			session.watchers.add(watcher);
			await watcher.connect(resumeFrom);
			return {
				async close() {
					watcher.closed = true;
					session.watchers.delete(watcher);
					await watcher.connection?.close();
				},
			};
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
				if (options.archive !== undefined) await archiveClosed(session, options.archive);
			})();
			session.closing = closing;
			try {
				await closing;
			} finally {
				session.closing = undefined;
			}
		},
	};

	const sessionModelsService: SessionModels = {
		async listModels(ctx, sessionId) {
			return (await sessionModelsService.modelState(ctx, sessionId)).models;
		},
		async modelState(ctx, sessionId) {
			await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.models");
			const session = await requireOpen(ctx, sessionId);
			const agent = await session.conversation.agent(piContext(ctx));
			return modelStateOf(session.models, session.profile, agent);
		},
		async startModels(ctx, start) {
			const profile = await requireProfile(ctx, start.agentId);
			if (start.projectId === "") throw new HarbourError("invalid", "A session needs a project");
			if (profile.projectId !== undefined && profile.projectId !== start.projectId) {
				throw new HarbourError("invalid", `Agent profile ${profile.id} is for another project`);
			}
			await check(ctx, { projectId: start.projectId, needed: "operator", operation: "session.models.start" });
			if (typeof models !== "function") return modelStateOf(models, profile, undefined);
			// The models a session there would get: the same call a new session makes when it opens, for a session ID that
			// no session has, so nothing is pinned for it.
			const now = clock.now();
			const draft: SessionRecord = {
				id: crypto.randomUUID(),
				organisationId: ctx.organisationId,
				projectId: start.projectId,
				agentId: profile.id,
				status: "idle",
				labels: {},
				createdBy: ctx.actor,
				createdAt: now,
				updatedAt: now,
			};
			return modelStateOf(await models(draft), profile, undefined);
		},
	};

	/**
	 * Makes `conversation` the one the session shows and runs: a new projection of it on a new stream, under a new
	 * generation, and every watcher moved onto that stream with a snapshot. The old stream gets nothing more.
	 */
	const activate = async (session: OpenSession, conversation: Conversation): Promise<void> => {
		const view = await conversation.viewState(BACKGROUND_CONTEXT);
		// Everything the old view queued goes to the old stream first (`publish` holds the stream it projected for).
		await session.publishing.catch(() => undefined);
		session.unsubscribeView();
		session.view.dispose();
		session.conversation = conversation;
		session.view = view;
		session.projector = new ConversationProjector({ now: () => clock.now() });
		session.stream = newStream(session.record);
		session.generation = crypto.randomUUID().slice(0, 8);
		session.unsubscribeView = view.subscribe(() => sync(session));
		await sync(session);
		for (const watcher of [...session.watchers]) {
			const previous = watcher.connection;
			watcher.connection = undefined;
			await previous?.close();
			if (!watcher.closed) await watcher.connect(undefined);
		}
	};

	const branching: SessionBranching = {
		async fork(ctx, sessionId, input) {
			const stored = await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.fork");
			const source = await ensureOpen(stored);
			await sync(source);
			const found = source.projector.entryOf(input.itemId);
			if (found?.kind !== "assistant") {
				throw new HarbourError("not_found", `No answer ${input.itemId} in session ${sessionId}`);
			}
			const from = source.record;
			const { profile } = stored;
			// A new session in the source's project, under the same check as creating one there.
			await check(ctx, { projectId: from.projectId, needed: "operator", operation: "session.create" });
			// Refuses before anything is written when the agent's model no longer resolves.
			agentOf(profile);
			// The history as of the answer, as Pi would start a fork of it: from the newest head through the answer.
			const history = await source.conversation.context(piContext(ctx), { at: found.entry.id });
			const now = clock.now();
			const title = input.title ?? `${from.title ?? "Session"} (fork)`;
			const record: SessionRecord = {
				id: crypto.randomUUID(),
				organisationId: from.organisationId,
				projectId: from.projectId,
				agentId: from.agentId,
				...(from.workspaceId === undefined ? {} : { workspaceId: from.workspaceId }),
				title,
				status: "idle",
				labels: { ...from.labels },
				createdBy: ctx.actor,
				createdAt: now,
				updatedAt: now,
			};
			// The revisions the source pinned (its `harbour.context` entry), which the fork mounts on its first prompt.
			const sourceStart = await source.conversation.entries(
				{ order: "ascending" },
				CONTEXT_SCAN,
				undefined,
				piContext(ctx),
			);
			const skills = contextSkillsOf(contextEntryOf(history.entries) ?? contextEntryOf(sourceStart.items));
			const created = await store.createSession({ record, profile, aborts: 0, closed: false });
			const forked = await ensureOpen(created, history.entries);
			if (skills !== undefined && skills.length > 0) {
				await forked.harness.commit(async (tx) => {
					(await tx.doc(FORK_SKILLS)).skills = skills.map((pin) => ({ ...pin }));
				}, piContext(ctx));
			}
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
					data: { labels: record.labels, forkedFrom: { sessionId, itemId: input.itemId } },
				},
			]);
			return record;
		},
		async edit(ctx, sessionId, input) {
			const stored = await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "operator", "session.edit");
			if (stored.closed || open.get(sessionId)?.closed === true) {
				throw new HarbourError("conflict", `Session ${sessionId} is closed`);
			}
			if (input.text.trim() === "") throw new HarbourError("invalid", "An edited message needs text");
			const session = await ensureOpen(stored);
			if (session.closed) throw new HarbourError("conflict", `Session ${sessionId} is closed`);
			if (session.editing) throw new HarbourError("conflict", `Session ${sessionId} is already being edited`);
			await sync(session);
			if (session.projector.status === "running") {
				throw new HarbourError("conflict", "Stop the run before editing a message");
			}
			const found = session.projector.entryOf(input.itemId);
			if (found?.kind !== "user") {
				throw new HarbourError("not_found", `No message ${input.itemId} in session ${sessionId}`);
			}
			session.editing = true;
			try {
				const previous = session.conversation;
				const before = entryBefore(session.view.value.entries, found.entry.id);
				const context = piContext(ctx);
				// From just before the message: Pi's fork keeps everything up to there, and the agent's settings as they were.
				// The first message has nothing before it, so the session starts a new conversation with its profile's agent.
				const next =
					before === undefined
						? await session.harness.createConversation(
								{ ownership: { kind: "ownerless" }, agent: agentOf(session.profile) },
								context,
							)
						: await previous.fork(before.id, { ownership: { kind: "ownerless" } }, context);
				await session.harness.commit(async (tx) => {
					const active = await tx.doc(ACTIVE_CONVERSATION);
					active.conversationId = next.id;
				}, context);
				await activate(session, next);
				// Input that reached the old conversation meanwhile goes no further.
				await admitting(session, () => previous.abort(context));
				const { record } = session;
				await audit([
					{
						id: `session:${sessionId}:edited:${next.id}`,
						at: clock.now(),
						source: "session",
						type: "session.edited",
						actor: ctx.actor,
						organisationId: record.organisationId,
						projectId: record.projectId,
						sessionId,
						agentId: record.agentId,
						subject: { kind: "session", id: sessionId },
						data: { itemId: input.itemId },
					},
				]);
			} finally {
				session.editing = false;
			}
			const { itemId: _itemId, ...prompt } = input;
			return submit(ctx, sessionId, prompt, "prompt");
		},
	};

	const history: SessionHistory = {
		async history(ctx, sessionId, request = {}) {
			await requireStored(ctx, sessionId);
			await checkSession(ctx, sessionId, "viewer", "session.history");
			// A malformed request is refused before the session is opened for it.
			historyLimit(request.limit);
			historyAnchor(request);
			const session = await requireOpen(ctx, sessionId);
			await sync(session);
			return readHistory(session.stream, sessionId, request);
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

	const reportSweepError = (error: unknown) => {
		try {
			options.onSweepError?.(error);
		} catch {
			// A reporter that throws must not take a sweep, recovery or the process down with it.
		}
	};

	/** The sweep in progress: every caller (the timer, `resume()`, `sweepLeases()`) shares it, so sweeps never overlap. */
	let sweeping: Promise<number> | undefined;
	/** Releases every sandbox lease past its TTL (`Sandboxes.sweep`); how many it released. Never rejects. */
	const sweepLeases = (): Promise<number> => {
		if (sandboxes?.sweep === undefined || closed) return Promise.resolve(0);
		sweeping ??= (async () => {
			try {
				// After a turn, so `sweeping` is set before the sweep can settle (one that throws at once included).
				await undefined;
				return (await sandboxes.sweep!(systemContext("session"))).length;
			} catch (error) {
				reportSweepError(error);
				return 0;
			} finally {
				sweeping = undefined;
			}
		})();
		return sweeping;
	};

	const sweepWaitMs = options.sweepWaitMs ?? 5_000;
	// setTimeout's range: anything outside it would fire at once.
	if (!Number.isFinite(sweepWaitMs) || sweepWaitMs < 0 || sweepWaitMs > 2_147_483_647) {
		throw new HarbourError("invalid", "sweepWaitMs must be between 0 and 2147483647 milliseconds");
	}

	/** This process's alarm for lease expiry: a sweep every `leaseSweepMs` while it holds a session open. */
	const leaseSweepMs = options.leaseSweepMs ?? 60_000;
	if (!Number.isFinite(leaseSweepMs) || leaseSweepMs <= 0 || leaseSweepMs > 2_147_483_647) {
		throw new HarbourError("invalid", "leaseSweepMs must be a positive number of milliseconds, at most 2147483647");
	}
	let sweepTimer: ReturnType<typeof setTimeout> | undefined;
	const armSweep = () => {
		if (sandboxes?.sweep === undefined || closed || sweepTimer !== undefined || open.size === 0) return;
		sweepTimer = setTimeout(() => {
			// Held (not undefined) until the sweep settles, so nothing arms a second timer meanwhile.
			const done = open.size === 0 ? Promise.resolve(0) : sweepLeases();
			void done.finally(() => {
				sweepTimer = undefined;
				armSweep();
			});
		}, leaseSweepMs);
		(sweepTimer as { unref?: () => void }).unref?.();
	};

	const resume = async (): Promise<number> => {
		// A sweep that stalls (its sandbox host or audit sink hung) must not hold up recovering sessions.
		let bound: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			sweepLeases(),
			new Promise<void>((resolve) => {
				bound = setTimeout(() => {
					reportSweepError(
						new HarbourError("unavailable", `The lease sweep took over ${sweepWaitMs} ms; resuming anyway`),
					);
					resolve();
				}, sweepWaitMs);
				// Referenced, unlike the background timer: a process awaiting resume() must live to recover its sessions.
			}),
		]);
		clearTimeout(bound);
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
		history,
		models: sessionModelsService,
		branching,
		directory,
		profiles,
		hostTools,
		hosts,
		sessionEnd: ends.hook,
		...(access === undefined ? {} : { access }),
		resume,
		sweepLeases,
		async close() {
			closed = true;
			if (resumeTimer !== undefined) clearTimeout(resumeTimer);
			if (sweepTimer !== undefined) clearTimeout(sweepTimer);
			await Promise.allSettled([...opening.values(), ...archiving.values()]);
			for (const session of [...open.values()]) {
				// A closed session opened again (to read it) goes back to its archive.
				if (session.durablyClosed && session.closing === undefined && options.archive !== undefined) {
					await archiveClosed(session, options.archive);
					continue;
				}
				open.delete(session.record.id);
				await shutDown(session);
			}
			await Promise.allSettled([...archiving.values()]);
		},
	};
}
