/**
 * The isolate-ready measurement (#17's definition of done: a new session's isolate is ready, its workspace listed, in
 * ≤100 ms p50 and ≤300 ms p95 on the deployed stack, 50 runs, as in M0).
 *
 * `POST /v1/measurements/isolate-ready`, body `{ "backend"?: "in-process" | "dynamic-worker", "placement"?: true }`,
 * signed in like any API call. One run:
 *
 * 1. creates a new session in the caller's default project, on the measurement workspace;
 * 2. runs `ls -1R` in that session's isolate on the chosen backend (default: the one sessions use);
 * 3. answers the times, then closes the session, which ends its lease.
 *
 * With `placement`, the answer also says where the stack runs (`Placement`): the stack object's colo, the request's
 * edge colo, and D1's region, colo and per-query latency as the object sees them. It is probed after the run, so it
 * adds nothing to the run's times.
 *
 * The measurement workspace is the M0 fixture's shape: 61 small files, made once in the project and reused, so a run
 * measures the session and the isolate, not seeding. After a restart it is found again through the last measurement
 * session's `workspaceId` (sessions are labelled `measurement: isolate-ready`), so restarts don't add workspaces. The caller needs operator access to the project,
 * as for any session. Server times leave out the round trip to the caller; the script times that too.
 */
import { type CallContext, HarbourError, isHarbourError, type WorkspaceId } from "@harbour/contracts";
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

/** Where the stack runs, from inside its Durable Object (`placement: true`). Each field is left out when unknown. */
export interface Placement {
	/** The colo the stack object's own subrequests leave from (Cloudflare's `/cdn-cgi/trace`): where the object runs. */
	readonly objectColo?: string;
	/** The colo the request reached Cloudflare at (`request.cf.colo`). */
	readonly edgeColo?: string;
	readonly d1?: {
		/** D1's `meta.served_by_region`, `served_by_colo` and `served_by_primary` for the last query. */
		readonly region?: string;
		readonly colo?: string;
		readonly primary?: boolean;
		/** `SELECT 1` in turn from the object: the round trip, and D1's own `timings.sql_duration_ms`. */
		readonly queries: readonly { readonly roundTripMs: number; readonly sqlMs?: number }[];
	};
	/** The workspace bucket's round trip from the object: `head`s of a key that doesn't exist, in turn. */
	readonly r2?: { readonly queries: readonly { readonly roundTripMs: number }[] };
}

export type PlacementProbe = (request: Request) => Promise<Placement>;

const round = (ms: number) => Math.round(ms * 10) / 10;

/** The labels every measurement session carries; the last one's workspace is the measurement workspace. */
export const MEASURE_LABELS = { measurement: "isolate-ready" } as const;

/**
 * The measurement workspace: the last measurement session's, or made on the first run; then the same one for every run.
 * A workspace whose seeding commit failed is kept and its commit retried, not replaced.
 */
export function measurementWorkspace(stack: Stack): (ctx: CallContext) => Promise<WorkspaceId> {
	let made: Promise<WorkspaceId> | undefined;
	let unseeded: WorkspaceId | undefined;
	const previous = async (ctx: CallContext): Promise<WorkspaceId | undefined> => {
		const page = await stack.runtime.directory.list(
			ctx,
			{ projectId: stack.project.id, labels: MEASURE_LABELS },
			{ limit: 1 },
		);
		const workspaceId = page.items[0]?.workspaceId;
		if (workspaceId === undefined) return undefined;
		try {
			await stack.workspaces.get(ctx, workspaceId);
			return workspaceId;
		} catch (error) {
			if (isHarbourError(error, "not_found")) return undefined;
			throw error;
		}
	};
	return (ctx) => {
		if (made === undefined) {
			const making = (async () => {
				if (unseeded === undefined) {
					const found = await previous(ctx);
					if (found !== undefined) return found;
					const owner = {
						kind: "project",
						organisationId: stack.organisation.id,
						projectId: stack.project.id,
					} as const;
					unseeded = (await stack.workspaces.create(ctx, { owner })).id;
				}
				const workspaceId = unseeded;
				const record = await stack.workspaces.get(ctx, workspaceId);
				const changes = Array.from({ length: MEASURE_FILES }, (_, i) => ({
					op: "put" as const,
					path: `${i < 30 ? "src" : i < 50 ? "docs" : "test"}/file-${String(i).padStart(2, "0")}.txt`,
					content: `measurement file ${i}\n`,
				}));
				// Puts are idempotent, so a retry after a commit that did land only makes an empty version.
				await stack.workspaces.commit(ctx, workspaceId, { baseVersion: record.head, changes });
				unseeded = undefined;
				return workspaceId;
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
		labels: { ...MEASURE_LABELS, backend },
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
