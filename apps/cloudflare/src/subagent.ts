/**
 * Subagents (experimental, `HARBOUR_SUBAGENTS=on`): the `subagent` tool hands one self-contained task to a new session
 * of the same agent, a child of the calling session, and answers with that session's final answer.
 *
 * - **A session of its own.** The child is an ordinary session (`parentSessionId` set), in the parent's project and on
 *   the parent's workspace, so it sees the same files. A person can open it and watch it stream, as any other; the
 *   console finds it from the call by its label, `subagentCall: <the tool call's ID>`, before the call returns.
 * - **Access.** The child is created, prompted and waited on as the parent's agent: the runtime lets an agent create a
 *   child of its own session and act on it, nothing else (`@harbour/contracts` access).
 * - **Stopping.** Stopping the parent stops the child (the runtime cascades an abort to children); a call aborted on its
 *   own aborts its child too.
 * - **Nested, to a limit.** A subagent's session is offered the tool too, so a subagent can start its own, down to
 *   `MAX_SUBAGENT_DEPTH` levels below the session a person started. Each child carries its depth as the label
 *   `subagentDepth`; a session at the limit isn't offered the tool. A child made some other way (the API's
 *   `parentSessionId`, without the label) counts as one level down.
 * - **After a crash** the call is not rerun (its replay is `unsafe`): it ends interrupted, and the child carries on as a
 *   session of its own.
 *
 * Harbour adds no prompt about it: the tool describes itself through its description and schema.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { CallContext, RunResult, SessionRecord, SessionRuntime } from "@harbour/contracts";

/** The tool's name, for the default profile and the console, which shows its calls as subagent cards. */
export const SUBAGENT_TOOL = "subagent";
/** The child session's label naming the call that started it, so a client can find the child while the call runs. */
export const SUBAGENT_CALL_LABEL = "subagentCall";
/** The child session's label saying how many levels below a top-level session it is: `1` for a subagent's own. */
export const SUBAGENT_DEPTH_LABEL = "subagentDepth";
/**
 * How many levels of subagents a top-level session may have under it: a subagent's subagent's subagent, and one more.
 * Enough for a task split and split again; the limit is there so a loop of delegation ends.
 */
export const MAX_SUBAGENT_DEPTH = 4;
/** The longest title a child session gets. */
const MAX_TITLE = 80;

export interface SubagentVars {
	/** `on` offers the `subagent` tool to the default agent's sessions, to `MAX_SUBAGENT_DEPTH`. Off by default. */
	readonly HARBOUR_SUBAGENTS?: string;
}

export function subagentsEnabled(vars: SubagentVars): boolean {
	return (vars.HARBOUR_SUBAGENTS ?? "").trim() === "on";
}

const subagentSchema = Type.Object({
	task: Type.String({
		description:
			"The whole task, written for someone who has seen none of this conversation: what to do, the files or facts it " +
			"needs, and what to answer with.",
	}),
	title: Type.Optional(Type.String({ description: "A few words naming the task, shown as the subagent's title." })),
});

/** The child session's title: the one given, or the task's first line, cut to `MAX_TITLE`. */
export function subagentTitle(task: string, title: string | undefined): string {
	const given = title?.trim() ?? "";
	const line = (given === "" ? (task.trim().split("\n")[0] ?? "") : given).trim();
	if (line === "") return "Subagent";
	return line.length <= MAX_TITLE ? line : `${line.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}

/** What the call answers when the subagent's run didn't end with an answer. */
function unanswered(result: RunResult): string {
	if (result.status === "aborted") return "The subagent was stopped before it answered.";
	return `The subagent failed: ${result.error ?? "its run ended without an answer"}`;
}

/**
 * How many levels below a top-level session `record` is: 0 for a top-level session, its `subagentDepth` label for a
 * subagent's, and 1 for a child without one.
 */
export function subagentDepth(record: Pick<SessionRecord, "parentSessionId" | "labels">): number {
	if (record.parentSessionId === undefined) return 0;
	const labelled = Number.parseInt(record.labels[SUBAGENT_DEPTH_LABEL] ?? "", 10);
	return Number.isFinite(labelled) && labelled >= 1 ? labelled : 1;
}

/**
 * The `subagent` tool for one session, or undefined for a session already `MAX_SUBAGENT_DEPTH` levels down. `runtime`
 * is asked for at call time: the stack builds its tools before its runtime.
 */
export function sessionSubagentTool(
	runtime: () => SessionRuntime,
	record: SessionRecord,
): ToolRegistration<typeof subagentSchema> | undefined {
	const depth = subagentDepth(record);
	if (depth >= MAX_SUBAGENT_DEPTH) return undefined;
	const ctx: CallContext = {
		actor: { kind: "agent", agentId: record.agentId, sessionId: record.id },
		organisationId: record.organisationId,
		projectId: record.projectId,
	};
	return defineTool({
		name: SUBAGENT_TOOL,
		description:
			"Hand one self-contained task to a subagent: a new session of this agent, in this project and on the same " +
			"files, that works through it on its own and answers when it's done. Returns its final answer. It sees none " +
			"of this conversation, so the task must say everything it needs.",
		parameters: subagentSchema,
		replay: "unsafe",
		async execute(args, api, context) {
			const sessions = runtime();
			const child = await sessions.create(ctx, {
				projectId: record.projectId,
				agentId: record.agentId,
				parentSessionId: record.id,
				title: subagentTitle(args.task, args.title),
				labels: { [SUBAGENT_CALL_LABEL]: api.callId, [SUBAGENT_DEPTH_LABEL]: String(depth + 1) },
				...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
			});
			const signal = context.abortSignal;
			const stop = () => {
				sessions.abort(ctx, child.id, "The call that started it was stopped").catch(() => {});
			};
			signal?.addEventListener("abort", stop, { once: true });
			try {
				const submitted = await sessions.prompt(ctx, child.id, {
					text: args.task,
					requestId: `subagent:${api.callId}`,
				});
				const result = await sessions.wait(ctx, child.id, submitted.id);
				const answered = result.status === "answered";
				return {
					output: [{ type: "text", text: answered ? (result.answer ?? "") : unanswered(result) }],
					isError: !answered,
					details: { subagentSessionId: child.id, status: result.status },
				};
			} finally {
				signal?.removeEventListener("abort", stop);
			}
		},
	});
}
