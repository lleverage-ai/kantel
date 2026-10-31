/**
 * Check schedules' commands on Cloudflare (#23): `@kantel/schedules`' check handler hands each run's command here, and
 * it runs in the isolate tier, with no model, in the check's own workspace (`check_<scheduleId>`, made empty on its
 * first run and kept, so a check can leave itself state). A sandbox lease belongs to a session, so each run has one,
 * titled after the check and labelled with the schedule and occurrence, closed when the command ends; the console lists
 * it like any other. The handler reads the exit code and output by the check contract (0 healthy, 3 findings as JSON).
 *
 * The container tier isn't on Cloudflare yet, so a command that needs it (`git`, `node`, `python` and the rest of the
 * routing table's container commands) fails its run.
 *
 * Portable (no `cloudflare:workers`): the tests run it in Node.
 */
import type { AgentId, CallContext, JsonValue, ProjectId, SessionRuntime } from "@kantel/contracts";
import type { TieredSandboxes } from "@kantel/sandbox/tiered";
import { type CheckExecutor, OCCURRENCE_LABEL, SCHEDULE_LABEL } from "@kantel/schedules/handlers";
import type { StoredWorkspaces } from "@kantel/workspace/stored";
import { SCHEDULER_COMPONENT } from "./schedules.ts";

/** How long a check's command may run. */
export const CHECK_TIMEOUT_MS = 60_000;
/** The label a check run's session carries besides the schedule's. */
export const CHECK_RUN_LABEL = "harbour.check";

export interface IsolateCheckOptions {
	readonly defaultProjectId: ProjectId;
	/** The agent the run's session is for: a session needs one, though no model is called. */
	readonly agentId: AgentId;
	readonly runtime: Pick<SessionRuntime, "create" | "close">;
	readonly workspaces: Pick<StoredWorkspaces, "ensure">;
	readonly sandboxes: () => Pick<TieredSandboxes, "run">;
}

/** A check's payload as the sandbox runs it: one command line, or an argument list. */
export function checkCommand(command: JsonValue): string | readonly string[] {
	if (typeof command === "string" && command.trim() !== "") return command;
	if (Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string")) {
		return command as readonly string[];
	}
	throw new Error("A check's payload must be a command line or a list of arguments");
}

export function isolateCheckExecutor(options: IsolateCheckOptions): CheckExecutor {
	return async ({ organisationId, schedule, command, occurrenceId, signal }) => {
		const line = checkCommand(command);
		const projectId = schedule.owner.kind === "project" ? schedule.owner.projectId : options.defaultProjectId;
		const ctx: CallContext = {
			actor: { kind: "system", component: SCHEDULER_COMPONENT },
			organisationId,
			projectId,
			signal,
		};
		const workspace = await options.workspaces.ensure(ctx, `check_${schedule.id}`, {
			owner: { kind: "project", organisationId, projectId },
		});
		const session = await options.runtime.create(ctx, {
			projectId,
			agentId: options.agentId,
			title: `Check: ${schedule.title}`,
			labels: { [SCHEDULE_LABEL]: schedule.id, [OCCURRENCE_LABEL]: occurrenceId, [CHECK_RUN_LABEL]: "true" },
			workspaceId: workspace.id,
		});
		try {
			const result = await options.sandboxes().run(ctx, {
				sessionId: session.id,
				workspaceId: workspace.id,
				tool: "bash",
				request: { command: line, timeoutMs: CHECK_TIMEOUT_MS },
			});
			return { exitCode: result.exitCode, stdout: result.stdout };
		} finally {
			await options.runtime.close(ctx, session.id).catch(() => undefined);
		}
	};
}
