/**
 * A session's coding tools on Cloudflare (#196): `read`, `write`, `edit` and `ls` work on the session's workspace
 * directly, through `Workspaces` in R2, and only `bash` runs in an isolate. The environment is `createSandboxExecutionEnv`
 * (`@harbour/sandbox/pi-env`) for the session's agent, so every file operation is checked and audited as that agent,
 * exactly as a command's writes from the isolate are:
 *
 * - **Scope.** Each call goes to the stack's `StoredWorkspaces` with the agent's context, which checks the session's
 *   project access (an agent counts as operator only on its own session's project, and never once it is closed).
 * - **Paths.** The workspace is at `/workspace`; a path outside it and its mounts is `permission_denied`, and the
 *   workspace refuses anything that is not a normalised relative path. Workspaces have no symbolic links.
 * - **Mounts** (skills, project files) are readable and never writable: `Workspaces.commit` refuses and audits a write.
 * - **Size.** A file over `MAX_TOOL_FILE_BYTES` is neither read (refused before its body is fetched) nor written.
 * - **Time.** A command runs for at most the timeout `bash` names, `DEFAULT_COMMAND_TIMEOUT_MS` when it names none,
 *   and never over `MAX_COMMAND_TIMEOUT_MS`; then it stops with exit code 124.
 * - **Audit.** Every write is one commit, `workspace.committed`, with the agent as its actor.
 *
 * Building the environment acquires nothing. The first `bash` call leases the session's isolate (`Sandboxes.run`), and
 * the session-end hook releases it on abort and close; a session that never runs a command never holds one.
 *
 * Every session has a workspace. One created without one (no repository) gets its own, `session_<session ID>`
 * (`sessionWorkspaceId`, the runtime's `defaultWorkspaceId`), which exists only once a tool needs it: the session's
 * first file tool or command creates it, empty, in the session's project (`Workspaces.ensure`, so two racing calls get
 * the same one). A session that only talks creates nothing. Sessions get the tools their profile names.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import {
	type CallContext,
	type Sandboxes,
	type SessionId,
	type SessionRecord,
	scopeOwner,
	type WorkspaceId,
} from "@harbour/contracts";
import { IN_CALL_ORDER, inCallOrder } from "@harbour/sandbox/coding-tools";
import { createSandboxExecutionEnv } from "@harbour/sandbox/pi-env";
import type { KeyedWorkspaces } from "@harbour/workspace";

/** The coding tools' names, for the default profile. */
export const CODING_TOOLS = ["read", "write", "edit", "ls", "bash"] as const;
/** The largest file a file tool reads or writes: the workspace read API's limit. */
export const MAX_TOOL_FILE_BYTES = 16 * 1024 * 1024;
/** The most entries `ls` lists. */
const LS_LIMIT = 500;
/** How long a command runs when `bash` names no timeout. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000;
/** The longest a command may run, whatever timeout `bash` names. */
export const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: the current directory)" })),
});

/** `ls`: one directory's entries, directories with a trailing `/`, sorted, at most `LS_LIMIT`. */
export function createLsTool(): ToolRegistration<typeof lsSchema> {
	return defineTool({
		name: "ls",
		description: `List a directory's contents, sorted, with a trailing "/" on directories. At most ${LS_LIMIT} entries.`,
		parameters: lsSchema,
		async execute(args, api, context) {
			const env = api.env;
			if (env === undefined) throw new Error("This session has no files to list");
			const path = args.path === undefined || args.path === "" ? env.cwd : args.path;
			const entries = getOrThrow(await env.listDir(path, context))
				.map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name))
				.sort();
			const shown = entries.slice(0, LS_LIMIT);
			const more = entries.length - shown.length;
			const text =
				entries.length === 0
					? "(empty directory)"
					: `${shown.join("\n")}${more > 0 ? `\n[${more} more entries not shown]` : ""}`;
			return { output: [{ type: "text", text }] };
		},
	});
}

/**
 * The tools, built once: they hold no session state (the session's environment comes with each call). A round with
 * `write`, `edit` or `bash` runs in the order the model made its calls, so a command sees a file written beside it; a
 * round of only `read` and `ls` runs at once (`IN_CALL_ORDER`, `@harbour/sandbox/coding-tools`).
 */
export function codingTools(): readonly ToolRegistration[] {
	return [createReadTool(), createWriteTool(), createEditTool(), createLsTool(), createBashTool()].map((tool) =>
		IN_CALL_ORDER.has(tool.name) ? inCallOrder(tool) : tool,
	);
}

/** The context a session's tools act in: its own agent, in its organisation. */
export function agentContext(record: SessionRecord): CallContext {
	return {
		actor: { kind: "agent", agentId: record.agentId, sessionId: record.id },
		organisationId: record.organisationId,
	};
}

/** The prefix of a session's own workspace: one the session's tools create when they first need it. */
export const SESSION_WORKSPACE_PREFIX = "session_";

/** The workspace a session created without one runs in (the runtime's `defaultWorkspaceId`); it creates nothing. */
export function sessionWorkspaceId(sessionId: SessionId): WorkspaceId {
	return `${SESSION_WORKSPACE_PREFIX}${sessionId}`;
}

/** Whether a workspace ID names a session's own workspace, which its tools create on first use. */
export function isSessionWorkspace(workspaceId: WorkspaceId): boolean {
	return workspaceId.startsWith(SESSION_WORKSPACE_PREFIX);
}

export interface SessionEnvironmentOptions {
	/** The sandboxes `bash` runs in; asked at each command, so they may be built after the runtime. */
	readonly sandboxes: () => Sandboxes;
	/** The workspaces the file tools use; asked at each call, likewise. */
	readonly workspaces: () => KeyedWorkspaces;
	readonly maxFileBytes?: number;
}

/** A command's time limit: the one asked for, `DEFAULT_COMMAND_TIMEOUT_MS` when none, never over the maximum. */
export function commandTimeoutMs(asked: number | undefined): number {
	if (asked === undefined || !Number.isFinite(asked) || asked <= 0) return DEFAULT_COMMAND_TIMEOUT_MS;
	return Math.min(asked, MAX_COMMAND_TIMEOUT_MS);
}

/** `sandboxes`, with every command's time bounded (`commandTimeoutMs`). */
function bounded(sandboxes: Sandboxes): Sandboxes {
	return new Proxy(sandboxes, {
		get(inner, key) {
			const value: unknown = Reflect.get(inner, key, inner);
			if (key !== "run" || typeof value !== "function") return value;
			const run = value as Sandboxes["run"];
			return ((ctx, input) =>
				run.call(inner, ctx, {
					...input,
					request: { ...input.request, timeoutMs: commandTimeoutMs(input.request.timeoutMs) },
				})) satisfies Sandboxes["run"];
		},
	});
}

/**
 * Each session's environment for the runtime (`SessionRuntimeOptions.environment`): over its workspace, as its agent;
 * `undefined` for a session without a workspace. Over a session's own workspace (`isSessionWorkspace`), the first call
 * that reaches the workspaces or the sandboxes creates it first, once.
 */
export function sessionEnvironments(
	options: SessionEnvironmentOptions,
): (record: SessionRecord) => ExecutionEnv | undefined {
	const sandboxes = bounded(late(options.sandboxes));
	const workspaces = late(options.workspaces);
	return (record) => {
		const workspaceId = record.workspaceId;
		if (workspaceId === undefined) return undefined;
		const ctx = agentContext(record);
		const ensure = isSessionWorkspace(workspaceId) ? ensureOnce(workspaces, ctx, record, workspaceId) : undefined;
		return createSandboxExecutionEnv({
			ctx,
			sessionId: record.id,
			workspaceId,
			sandboxes: ensure === undefined ? sandboxes : first(ensure, sandboxes),
			workspaces: ensure === undefined ? workspaces : first(ensure, workspaces),
			maxFileBytes: options.maxFileBytes ?? MAX_TOOL_FILE_BYTES,
		});
	};
}

/**
 * Creates the session's own workspace, empty and in its project, the first time it is called, as the session's agent
 * (who may create one only in its own session's project). Later calls wait for that one; a failure is not kept, so
 * the next call tries again.
 */
function ensureOnce(
	workspaces: KeyedWorkspaces,
	ctx: CallContext,
	record: SessionRecord,
	workspaceId: WorkspaceId,
): () => Promise<void> {
	let ensured: Promise<void> | undefined;
	return () => {
		if (ensured === undefined) {
			const ensuring = workspaces
				.ensure(ctx, workspaceId, {
					owner: scopeOwner(record),
				})
				.then(() => undefined);
			ensured = ensuring;
			ensuring.catch(() => {
				if (ensured === ensuring) ensured = undefined;
			});
		}
		return ensured;
	};
}

/** Methods of `Sandboxes` and `Workspaces` that answer at once, not with a promise: `first` leaves them as they are. */
const SYNCHRONOUS = new Set<PropertyKey>(["route"]);

/** `target`, whose every method that returns a promise waits for `before` first. */
function first<T extends object>(before: () => Promise<void>, target: T): T {
	return new Proxy(target, {
		get(inner, key) {
			const value: unknown = Reflect.get(inner, key, inner);
			if (typeof value !== "function" || SYNCHRONOUS.has(key)) return value;
			return async (...args: unknown[]) => {
				await before();
				return (value as (...a: unknown[]) => unknown).apply(inner, args);
			};
		},
	});
}

/**
 * The session's tools for the runtime (`SessionRuntimeOptions.tools`): the coding tools when it has a workspace, which
 * every session does when the runtime gives each its own (`sessionWorkspaceId`).
 */
export function sessionCodingTools(): (record: SessionRecord) => readonly ToolRegistration[] {
	const tools = codingTools();
	return (record) => (record.workspaceId === undefined ? [] : tools);
}

/**
 * `T` resolved at each property access. The stack builds its runtime before its workspaces and sandboxes (they need
 * the runtime's project access), and a session the runtime resumes as it starts opens before them; its environment
 * reaches them only when a tool runs, by when they exist.
 */
function late<T extends object>(get: () => T): T {
	return new Proxy({} as T, {
		get(_target, key) {
			const target = get();
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
