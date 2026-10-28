/**
 * The isolate-ready measurement (#17's definition of done: a new session's isolate is ready, its workspace listed, in
 * ≤100 ms p50 and ≤300 ms p95 on the deployed stack, 50 runs, as in M0).
 *
 * `POST /v1/measurements/isolate-ready`, body `{ "backend"?: "in-process" }`, signed in like any API call. One run:
 *
 * 1. creates a new session in the caller's default project, on the measurement workspace;
 * 2. runs `ls -1R` in that session's isolate on the chosen backend (default: the one sessions use);
 * 3. answers the times, then closes the session, which ends its lease.
 *
 * The measurement workspace is the M0 fixture's shape: 61 small files, made once per object start in the project and
 * reused, so a run measures the session and the isolate, not seeding. The caller needs operator access to the project,
 * as for any session. Server times leave out the round trip to the caller; the script times that too.
 */
import { type CallContext, HarbourError, type WorkspaceId } from "@harbour/contracts";
import { type IsolateBackendName, isIsolateBackend } from "./sandboxes.ts";
import { DEFAULT_AGENT_ID, type Stack } from "./stack.ts";

export const MEASURE_PATH = "/v1/measurements/isolate-ready";
export const MEASURE_COMMAND = "ls -1R";
/** Files in the measurement workspace, as M0's `harbour-m0-bench`. */
export const MEASURE_FILES = 61;

export interface IsolateReady {
	readonly backend: IsolateBackendName;
	readonly sessionId: string;
	readonly workspaceId: WorkspaceId;
	readonly exitCode: number;
	/** Lines `ls -1R` printed, so a run that listed nothing is visible. */
	readonly listed: number;
	/** Milliseconds: `session` (create), `isolate` (acquire and run), `total`, then the sandbox's own phases. */
	readonly timings: Record<string, number>;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** The measurement workspace: made on the first run, then the same one for every run until the object restarts. */
export function measurementWorkspace(stack: Stack): (ctx: CallContext) => Promise<WorkspaceId> {
	let made: Promise<WorkspaceId> | undefined;
	return (ctx) => {
		if (made === undefined) {
			const making = (async () => {
				const owner = { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id } as const;
				const workspace = await stack.workspaces.create(ctx, { owner });
				const changes = Array.from({ length: MEASURE_FILES }, (_, i) => ({
					op: "put" as const,
					path: `${i < 30 ? "src" : i < 50 ? "docs" : "test"}/file-${String(i).padStart(2, "0")}.txt`,
					content: `measurement file ${i}\n`,
				}));
				await stack.workspaces.commit(ctx, workspace.id, { baseVersion: workspace.head, changes });
				return workspace.id;
			})();
			made = making;
			making.catch(() => {
				if (made === making) made = undefined;
			});
		}
		return made;
	};
}

export async function measureIsolateReady(
	stack: Stack,
	ctx: CallContext,
	workspace: (ctx: CallContext) => Promise<WorkspaceId>,
	input: { readonly backend?: string },
): Promise<IsolateReady> {
	const backend = input.backend ?? stack.sandboxes.backend;
	if (!isIsolateBackend(backend)) throw new HarbourError("invalid", `No isolate backend ${backend}`);
	const sandboxes = stack.sandboxes.on(backend);
	if (sandboxes === undefined) throw new HarbourError("unavailable", `This Worker has no ${backend} isolate backend`);
	const workspaceId = await workspace(ctx);

	const started = performance.now();
	const session = await stack.runtime.runtime.create(ctx, {
		projectId: stack.project.id,
		agentId: DEFAULT_AGENT_ID,
		title: "Isolate-ready measurement",
		labels: { measurement: "isolate-ready", backend },
		workspaceId,
	});
	const created = performance.now();
	try {
		const result = await sandboxes.run(ctx, {
			sessionId: session.id,
			workspaceId,
			tool: "bash",
			request: { command: MEASURE_COMMAND },
		});
		const ran = performance.now();
		return {
			backend,
			sessionId: session.id,
			workspaceId,
			exitCode: result.exitCode,
			listed: result.stdout.split("\n").filter((line) => line !== "").length,
			timings: {
				session: round(created - started),
				isolate: round(ran - created),
				total: round(ran - started),
				...result.timings,
			},
		};
	} finally {
		// Ends the session's lease through the runtime's sandbox teardown; the session stays listed, as done.
		await stack.runtime.runtime.close(ctx, session.id).catch(() => undefined);
	}
}
