/**
 * A session's coding tools (#196), for the self-hosted gateway: `read`, `write`, `edit` and `ls` work on the session's
 * workspace directly, through `Workspaces` (Postgres and S3 on the stack), and only `bash` runs in an isolate. This is
 * Cloudflare's `apps/cloudflare/src/coding-tools.ts` as it stood at #196, moved here to be shared; Cloudflare moves onto
 * it once #229 (which changes its copy) lands. The environment
 * is `createSandboxExecutionEnv` (`./pi-env.ts`) for the session's agent, so every file operation is checked and audited
 * as that agent, exactly as a command's writes from the isolate are:
 *
 * - **Scope.** Each call goes to the stack's `StoredWorkspaces` with the agent's context, which checks the session's
 *   project access (an agent counts as operator only on its own session's project, and never once it is closed).
 * - **Paths.** The workspace is at `/workspace`; a path outside it and its mounts is `permission_denied`, and the
 *   workspace refuses anything that is not a normalised relative path. Workspaces have no symbolic links.
 * - **Mounts** (skills, project files) are readable and never writable: `Workspaces.commit` refuses and audits a write.
 * - **Size.** A file over `MAX_TOOL_FILE_BYTES` is neither read (refused before its body is fetched) nor written.
 * - **Audit.** Every write is one commit, `workspace.committed`, with the agent as its actor.
 *
 * Building the environment acquires nothing. The first `bash` call leases the session's isolate (`Sandboxes.run`), and
 * the session-end hook releases it on abort and close; a session that never runs a command never holds one.
 * Only sessions with a workspace get these tools, and only those their profile names.
 *
 * **One round, in call order.** Pi Durable runs the tool calls of one model step (a round) at once unless one of them
 * is `executionMode: "sequential"`, which makes the whole round run one call after another in the order the model made
 * them. `read` and `ls` only read the workspace, so a round of them still runs at once. `write`, `edit` and `bash`
 * change it (or run a command that may), so a round with one of them runs in call order (`IN_CALL_ORDER`): a command
 * sees the file a `write` beside it made, and a `read` sees what a command beside it wrote. Without this, `write
 * hello.py` and `bash python3 hello.py` in one step ran at once, and the command read the workspace's head before the
 * write committed (seen on harbour.myslop.app, 30 Oct 2026). Pi's own per-file queue serialises `write` and `edit` of
 * one file only, never against `bash`.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import {
	type CallContext,
	HarbourError,
	type Sandboxes,
	type SessionRecord,
	type Workspaces,
} from "@harbour/contracts";
import { createSandboxExecutionEnv } from "./pi-env.ts";
import type { ContainerBackend } from "./tiered.ts";

/** The coding tools' names, for the default profile. */
export const CODING_TOOLS = ["read", "write", "edit", "ls", "bash"] as const;
/** The largest file a file tool reads or writes: the workspace read API's limit. */
export const MAX_TOOL_FILE_BYTES = 16 * 1024 * 1024;
/** The most entries `ls` lists. */
const LS_LIMIT = 500;

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
 * The coding tools that change the session's workspace, or run commands in its sandbox that may: a round with one of
 * them runs in call order. The others only read, and a round of only those runs at once.
 */
export const IN_CALL_ORDER: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

/** `tool`, made to run its round in call order (`executionMode: "sequential"`). */
export function inCallOrder<T extends ToolRegistration>(tool: T): T {
	return { ...tool, executionMode: "sequential" };
}

/**
 * The tools, built once: they hold no session state (the session's environment comes with each call). Those in
 * `IN_CALL_ORDER` run their round in call order.
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

export interface SessionEnvironmentOptions {
	/** The sandboxes `bash` runs in; asked at each command, so they may be built after the runtime. */
	readonly sandboxes: () => Sandboxes;
	/** The workspaces the file tools use; asked at each call, likewise. */
	readonly workspaces: () => Workspaces;
	readonly maxFileBytes?: number;
}

/**
 * Each session's environment for the runtime (`SessionRuntimeOptions.environment`): over its workspace, as its agent;
 * `undefined` for a session without a workspace.
 */
export function sessionEnvironments(
	options: SessionEnvironmentOptions,
): (record: SessionRecord) => ExecutionEnv | undefined {
	const sandboxes = late(options.sandboxes);
	const workspaces = late(options.workspaces);
	return (record) =>
		record.workspaceId === undefined
			? undefined
			: createSandboxExecutionEnv({
					ctx: agentContext(record),
					sessionId: record.id,
					workspaceId: record.workspaceId,
					sandboxes,
					workspaces,
					maxFileBytes: options.maxFileBytes ?? MAX_TOOL_FILE_BYTES,
				});
}

/** The session's tools for the runtime (`SessionRuntimeOptions.tools`): the coding tools when it has a workspace. */
export function sessionCodingTools(): (record: SessionRecord) => readonly ToolRegistration[] {
	const tools = codingTools();
	return (record) => (record.workspaceId === undefined ? [] : tools);
}

/**
 * The container tier for a deployment that has none: refuses every command `unavailable`, and has nothing to commit or
 * end. The tiered sandboxes acquire a container lease before they run a command routed to it, so `pending` must answer
 * (with no changes): the isolate checkpoints that lease before each command, and releasing it flushes it, and a
 * refusal there would stall the session.
 */
export function noContainers(message: string): ContainerBackend {
	return {
		exec: async () => {
			throw new HarbourError("unavailable", message);
		},
		pending: async () => ({ changes: [], stamp: 0 }),
		committed: async () => undefined,
		ended: async () => undefined,
	};
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
