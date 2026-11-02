/**
 * The programs API (`@kantel/api`'s `programRoutes`) over a `ProgramsService`. Who the caller is stays the host's job
 * (`authenticate`).
 */
import { createRouter, programRoutes, STATUS_BY_CODE } from "@kantel/api";
import { type CallContext, isKantelError, KantelError } from "@kantel/contracts";
import type {
	ProgramRunView,
	ProgramsService,
	ProgramVersionInput,
	ResumeProgramRunInput,
	RunProgramInput,
} from "./service.ts";

/**
 * A run whose script still runs answers 202: running, or held on a person's approval (`waiting: "approval"`). A run
 * paused on a step has stopped its turn, and answers 200 as an ended one does.
 */
const still = (run: ProgramRunView): boolean => run.status === "running" || run.waiting === "approval";

export interface ProgramsApiOptions {
	readonly programs: ProgramsService;
	readonly authenticate: (request: Request) => Promise<CallContext>;
	readonly basePath?: string;
}

/** A program's code is up to 200 kB, and the JSON around it a little more. */
export const PROGRAMS_BODY_LIMIT = 512 * 1024;

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

export function isProgramsPath(path: string, basePath = "/v1"): boolean {
	const under = `${basePath.replace(/\/+$/, "")}/programs`;
	return path === under || path.startsWith(`${under}/`);
}

const versionNumber = (text: string): number => {
	const value = Number.parseInt(text, 10);
	if (!Number.isSafeInteger(value) || value < 1) throw new KantelError("invalid", "A version is a positive integer");
	return value;
};

export function createProgramsApi(options: ProgramsApiOptions) {
	const { programs } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const router = createRouter(
		programRoutes,
		{
			listPrograms: async (ctx: CallContext, { query }) => ({
				items: await programs.list(ctx, query.projectId === undefined ? {} : { projectId: query.projectId }),
			}),
			createProgram: (ctx: CallContext, { body }) =>
				programs.create(ctx, body as Parameters<ProgramsService["create"]>[1]),
			getProgram: (ctx: CallContext, { params }) => programs.get(ctx, params.programId),
			removeProgram: async (ctx: CallContext, { params }) => {
				await programs.remove(ctx, params.programId);
				return undefined;
			},
			listProgramVersions: async (ctx: CallContext, { params }) => ({
				items: await programs.versions(ctx, params.programId),
			}),
			createProgramVersion: (ctx: CallContext, { params, body }) =>
				programs.addVersion(ctx, params.programId, body as ProgramVersionInput),
			getProgramVersion: (ctx: CallContext, { params }) =>
				programs.version(ctx, params.programId, versionNumber(params.version)),
			removeProgramVersion: async (ctx: CallContext, { params }) => {
				await programs.removeVersion(ctx, params.programId, versionNumber(params.version));
				return undefined;
			},
			runProgram: async (ctx: CallContext, { params, body, idempotencyKey }) => {
				// The router parsed the body from JSON, so its `unknown`s are JSON values.
				const run = await programs.run(ctx, params.programId, body as RunProgramInput, idempotencyKey);
				return still(run) ? json(run, 202) : run;
			},
			listProgramRuns: async (ctx: CallContext, { params }) => ({ items: await programs.runs(ctx, params.programId) }),
			getProgramRun: (ctx: CallContext, { params }) => programs.getRun(ctx, params.programId, params.runId),
			cancelProgramRun: (ctx: CallContext, { params }) => programs.cancel(ctx, params.programId, params.runId),
			resumeProgramRun: async (ctx: CallContext, { params, body }) => {
				if (!programs.waits) throw new KantelError("not_found", "No such route");
				const run = await programs.resume(ctx, params.programId, params.runId, body as ResumeProgramRunInput);
				return still(run) ? json(run, 202) : run;
			},
			listProgramRunSteps: async (ctx: CallContext, { params }) => {
				if (!programs.waits) throw new KantelError("not_found", "No such route");
				return { items: await programs.steps(ctx, params.programId, params.runId) };
			},
		},
		{ basePath, maxBodyBytes: PROGRAMS_BODY_LIMIT },
	);

	return {
		async fetch(request: Request): Promise<Response | undefined> {
			const path = new URL(request.url).pathname;
			if (!isProgramsPath(path, basePath)) return undefined;
			try {
				const ctx = await options.authenticate(request);
				const answered = await router(ctx, request);
				return answered ?? json({ error: { code: "not_found", message: "No such route" } }, 404);
			} catch (error) {
				if (isKantelError(error)) {
					return json(
						{
							error: {
								code: error.code,
								message: error.message,
								...(error.details === undefined ? {} : { details: error.details }),
							},
						},
						STATUS_BY_CODE[error.code],
					);
				}
				console.error("kantel: the programs API failed", error);
				return json({ error: { code: "unavailable", message: "The programs API failed" } }, 500);
			}
		},
	};
}
