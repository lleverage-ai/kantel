/**
 * The isolate-ready measurement (#17's definition of done: a new session's isolate is ready, its workspace listed, in
 * ≤100 ms p50 and ≤300 ms p95 on the deployed stack, 50 runs, as in M0).
 *
 * `POST /v1/measurements/isolate-ready`, body `{ "backend"?: "in-process" | "dynamic-worker", "placement"?: true,
 * "keep"?: true, "sessionId"?: string }`, signed in like any API call. A cold run (the default):
 *
 * 1. creates a new session in the caller's default project, on the measurement workspace;
 * 2. runs `ls -1R` in that session's isolate on the chosen backend (default: the one sessions use);
 * 3. answers the times, then closes the session, which ends its lease.
 *
 * A warm batch (#17's target is for a warm session) opens one session and runs on it again and again:
 *
 * - `keep: true` makes a cold run that leaves its session open (the warm-up), and answers its `sessionId`;
 * - `sessionId` runs `ls -1R` again on that open measurement session, on the same backend, and leaves it open: its
 *   lease and the backend's isolate are already there, so the run measures a warm session's command. Its `total` is
 *   the run alone; `lookup`, the session's directory read that checks it is a measurement session, is answered
 *   beside it, because a real session's tool call already has its session;
 * - the caller closes the session with the session API (`POST /v1/sessions/:id/close`), which ends its lease.
 *
 * With `tools: true` (on the backend sessions use), the session's file tools run first, before the command, through
 * the environment its tools get (`Stack.environment`, as its agent): `read` of one file, `ls` of `src`, and `write` of
 * `scratch/measure.txt`. Their times are answered as `timings.read`, `timings.ls` and `timings.write`, and
 * `leasedBeforeBash` says how many leases the session held after them. On a cold run that is 0 (the file tools went
 * straight to the workspace), and the command that follows is the session's first `bash` call. On a warm run
 * (`sessionId`) the session is already open, so the times are the tools' alone: a cold run's also hold whatever the
 * session's opening left for the next I/O, because a Worker's clock stands still during synchronous work such as the
 * opening's SQLite schema.
 *
 * With `placement`, the answer also says where the stack runs (`Placement`): the stack object's colo, the request's
 * edge colo, and D1's region, colo and per-query latency as the object sees them. It is probed after the run, so it
 * adds nothing to the run's times.
 *
 * The measurement workspace is the M0 fixture's shape: 61 small files, made once in the project and reused, so a run
 * measures the session and the isolate, not seeding. After a restart it is found again through the last measurement
 * session's `workspaceId` (sessions are labelled `measurement: isolate-ready`), so restarts don't add workspaces. The caller needs operator access to the project,
 * as for any session. Server times leave out the round trip to the caller; the script times that too.
 *
 * Beside `timings`, `clock` answers each mark as Unix milliseconds (`entered` and `signedIn` from the gateway, then the
 * run's own). Deployed, `Date.now()` and `performance.now()` only move on I/O (and workerd may hold them at a timer's
 * deadline), so a mark can be older than the request: the script checks each mark against its own send and receive
 * times rather than trusting a server step that came out longer than the whole call.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { type CallContext, isKantelError, KantelError, type SessionRecord, type WorkspaceId } from "@kantel/contracts";
import type { TieredSandboxes } from "@kantel/sandbox/tiered";
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
	/** A run on an open session (`sessionId`), not a new one. */
	readonly warm: boolean;
	/** The session is still open: `keep` or a warm run. The caller closes it. */
	readonly open: boolean;
	readonly exitCode: number;
	/** Lines `ls -1R` printed, so a run that listed nothing is visible. */
	readonly listed: number;
	/** With `tools`: the session's live leases after its file tools ran, before its first command. */
	readonly leasedBeforeBash?: number;
	/** Milliseconds: `session` (create), `isolate` (acquire and run), `total`, then the sandbox's own phases. */
	readonly timings: Record<string, number>;
	/**
	 * The marks `timings` is worked out from, as Unix milliseconds (`Date.now()`): `started`, `created` and `ran` on a
	 * cold run, `looking`, `started` and `ran` on a warm one. Deployed, the Worker clock only moves on I/O, so the
	 * script compares these with its own send and receive times to tell a stale mark from a slow step.
	 */
	readonly clock: Record<string, number>;
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
			if (isKantelError(error, "not_found")) return undefined;
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

export interface MeasureInput {
	readonly backend?: string;
	/** Leave the new session open after the run: the warm-up of a warm batch. */
	readonly keep?: boolean;
	/** Run on this open measurement session instead of a new one: a warm run. */
	readonly sessionId?: string;
	/** Run the session's file tools before its first command (a cold run on the sessions' backend). */
	readonly tools?: boolean;
}

/** The file the `tools` run writes, the same in every run. */
export const MEASURE_WRITE_PATH = "scratch/measure.txt";

export async function measureIsolateReady(
	stack: Stack,
	ctx: CallContext,
	workspace: (ctx: CallContext) => Promise<WorkspaceId>,
	input: MeasureInput,
): Promise<IsolateReady> {
	const backend = input.backend ?? stack.sandboxes.backend;
	if (!isIsolateBackend(backend)) throw new KantelError("invalid", `No isolate backend ${backend}`);
	const sandboxes = stack.sandboxes.on(backend);
	if (sandboxes === undefined) throw new KantelError("unavailable", `This Worker has no ${backend} isolate backend`);
	if (input.tools === true && backend !== stack.sandboxes.backend) {
		throw new KantelError("invalid", `The tools run is on the backend sessions use, ${stack.sandboxes.backend}`);
	}
	if (input.sessionId !== undefined) {
		return warmRun(stack, ctx, backend, sandboxes, input.sessionId, input.tools === true);
	}
	const workspaceId = await workspace(ctx);

	const started = performance.now();
	const startedAt = Date.now();
	const session = await stack.runtime.runtime.create(ctx, {
		projectId: stack.project.id,
		agentId: DEFAULT_AGENT_ID,
		title: "Isolate-ready measurement",
		labels: { ...MEASURE_LABELS, backend },
		workspaceId,
	});
	const created = performance.now();
	const createdAt = Date.now();
	let kept = false;
	try {
		const files = input.tools === true ? await fileTools(stack, ctx, sandboxes, session) : undefined;
		const toolsDone = performance.now();
		const result = await sandboxes.run(ctx, {
			sessionId: session.id,
			workspaceId,
			tool: "bash",
			request: { command: MEASURE_COMMAND },
		});
		const ran = performance.now();
		const ranAt = Date.now();
		// Kept open only when the run answered: a failed warm-up's session is closed like any other.
		kept = input.keep === true;
		return {
			backend,
			sessionId: session.id,
			workspaceId,
			warm: false,
			open: kept,
			exitCode: result.exitCode,
			listed: result.stdout.split("\n").filter((line) => line !== "").length,
			...(files === undefined ? {} : { leasedBeforeBash: files.leased }),
			timings: {
				session: round(created - started),
				...(files === undefined ? {} : files.timings),
				isolate: round(ran - toolsDone),
				total: round(ran - started),
				...result.timings,
			},
			clock: { started: startedAt, created: createdAt, ran: ranAt },
		};
	} finally {
		// Ends the session's lease through the runtime's sandbox teardown; the session stays listed, as done.
		if (!kept) await stack.runtime.runtime.close(ctx, session.id).catch(() => undefined);
	}
}

/** The session's file tools, timed, through the environment its tools get; then the leases it holds. */
async function fileTools(
	stack: Stack,
	ctx: CallContext,
	sandboxes: TieredSandboxes,
	session: SessionRecord,
): Promise<{ timings: Record<string, number>; leased: number }> {
	const env = stack.environment(session);
	if (env === undefined) throw new KantelError("unavailable", "The measurement session has no environment");
	const context = BACKGROUND_CONTEXT;
	const t0 = performance.now();
	getOrThrow(await env.readTextFile("src/file-00.txt", context));
	const t1 = performance.now();
	getOrThrow(await env.listDir("src", context));
	const t2 = performance.now();
	getOrThrow(await env.writeFile(MEASURE_WRITE_PATH, `measured in ${session.id}\n`, context));
	const t3 = performance.now();
	const leased = (await sandboxes.leases(ctx, { sessionId: session.id, live: true })).length;
	return { timings: { read: round(t1 - t0), ls: round(t2 - t1), write: round(t3 - t2) }, leased };
}

/** `ls -1R` again on an open measurement session on `backend`: its lease and isolate are warm. It stays open. */
async function warmRun(
	stack: Stack,
	ctx: CallContext,
	backend: IsolateBackendName,
	sandboxes: TieredSandboxes,
	sessionId: string,
	tools: boolean,
): Promise<IsolateReady> {
	const looking = performance.now();
	const lookingAt = Date.now();
	const session = await stack.runtime.directory.get(ctx, sessionId);
	const workspaceId = session.workspaceId;
	if (
		session.projectId !== stack.project.id ||
		session.labels.measurement !== MEASURE_LABELS.measurement ||
		session.labels.backend !== backend ||
		workspaceId === undefined
	) {
		throw new KantelError("invalid", `Session ${sessionId} is not an isolate-ready measurement session on ${backend}`);
	}
	if (session.status === "done") throw new KantelError("conflict", `Session ${sessionId} is closed`);
	const looked = performance.now();
	const files = tools ? await fileTools(stack, ctx, sandboxes, session) : undefined;
	const started = performance.now();
	const startedAt = Date.now();
	const result = await sandboxes.run(ctx, {
		sessionId: session.id,
		workspaceId,
		tool: "bash",
		request: { command: MEASURE_COMMAND },
	});
	const ran = performance.now();
	const ranAt = Date.now();
	return {
		backend,
		sessionId: session.id,
		workspaceId,
		warm: true,
		open: true,
		exitCode: result.exitCode,
		listed: result.stdout.split("\n").filter((line) => line !== "").length,
		...(files === undefined ? {} : { leasedBeforeBash: files.leased }),
		timings: {
			...(files === undefined ? {} : files.timings),
			lookup: round(looked - looking),
			isolate: round(ran - started),
			total: round(ran - started),
			...result.timings,
		},
		clock: { looking: lookingAt, started: startedAt, ran: ranAt },
	};
}
