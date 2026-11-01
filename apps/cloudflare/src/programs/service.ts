/**
 * Programs (experimental, `KANTEL_PROGRAMS=on`; docs/site/src/content/docs/api/programs.md): saved, versioned code mode programs that run
 * through the API with no model in the loop.
 *
 * - **A version is a profile.** Saving version N of a program also saves an agent profile, `program-<id>-v<N>`, in the
 *   program's project, whose tools are `codemode` and the version's `tools` and nothing else, and whose model is the
 *   program runner (`./runner-model.ts`). So the version's tool allowlist is enforced the way any agent's is.
 * - **A run is a session.** Running a version creates a session of that profile as the caller, in the program's project,
 *   and prompts it with the run (the program, its input and its budget). The runner calls `codemode` with the program
 *   and answers with its output. The session is an ordinary one: its tool calls go through the project's rules,
 *   approvals and audit; code mode journals the program, so a run survives the stack object restarting; stopping the
 *   session stops the run; and a person can open it to read what happened.
 * - **Access.** Reading needs viewer on the project, saving, deleting and running operator; an agent counts as operator
 *   on its own session's project, so it can save programs there, and run them only as any operator could.
 */
import {
	type AgentProfiles,
	type AuditSink,
	type CallContext,
	type JsonValue,
	KantelError,
	type ProjectAccess,
	type RunResult,
	type SessionRuntime,
	systemContext,
} from "@kantel/contracts";
import Value from "typebox/value";
import { PROGRAM_MODEL_ROUTE, parseProgramOutcome, programRunPrompt } from "./runner-model.ts";
import type { ProgramRecord, ProgramRunRecord, ProgramStore, ProgramVersionRecord } from "./store.ts";

/** A run's deadline when its version names none, and the output's budget. */
export const DEFAULT_PROGRAM_TIMEOUT_MS = 300_000;
export const DEFAULT_PROGRAM_MAX_OUTPUT_TOKENS = 10_000;
/** How long a sync run call waits before answering 202 with the running run. */
export const DEFAULT_PROGRAM_WAIT_MS = 30_000;
/** Tools a program never gets: code mode is how it runs, and the others would start more agents or programs. */
const WITHHELD_TOOLS = new Set(["codemode", "subagent", "save_program"]);
const RUNS_LISTED = 100;

/** A program as the API answers it. */
export interface ProgramView {
	readonly id: string;
	readonly organisationId: string;
	readonly projectId: string;
	readonly name: string;
	readonly description?: string;
	readonly latestVersion?: number;
	readonly versions: readonly number[];
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly createdBy: ProgramRecord["createdBy"];
}

export interface ProgramRunView extends Omit<ProgramRunRecord, "organisationId" | "submissionId" | "idempotencyKey"> {
	readonly waiting?: "approval";
}

export interface ProgramVersionInput {
	readonly code: string;
	readonly description?: string;
	readonly inputSchema?: { readonly [key: string]: JsonValue };
	readonly outputSchema?: { readonly [key: string]: JsonValue };
	readonly tools?: readonly string[];
	readonly timeoutMs?: number;
	readonly maxOutputTokens?: number;
}

export interface RunProgramInput {
	readonly input?: JsonValue;
	readonly version?: number;
	readonly mode?: "sync" | "async";
	readonly waitMs?: number;
}

export interface ProgramsServiceOptions {
	readonly store: ProgramStore;
	readonly access: () => ProjectAccess;
	readonly runtime: () => SessionRuntime;
	readonly profiles: () => AgentProfiles;
	readonly audit: AuditSink;
	readonly now: () => number;
	/** Keeps work going after a call has answered, such as a Durable Object's `waitUntil`. */
	readonly background?: (work: Promise<unknown>) => void;
	readonly newId?: (prefix: string) => string;
}

export interface ProgramsService {
	list(ctx: CallContext, filter?: { readonly projectId?: string }): Promise<ProgramView[]>;
	create(
		ctx: CallContext,
		input: { readonly projectId: string; readonly name: string } & ProgramVersionInput,
	): Promise<ProgramView>;
	get(ctx: CallContext, programId: string): Promise<ProgramView>;
	remove(ctx: CallContext, programId: string): Promise<void>;
	versions(ctx: CallContext, programId: string): Promise<ProgramVersionRecord[]>;
	addVersion(ctx: CallContext, programId: string, input: ProgramVersionInput): Promise<ProgramVersionRecord>;
	version(ctx: CallContext, programId: string, version: number): Promise<ProgramVersionRecord>;
	removeVersion(ctx: CallContext, programId: string, version: number): Promise<void>;
	/** Saves `input` as the next version of the project's program `name`, creating the program when there is none. */
	save(
		ctx: CallContext,
		input: { readonly projectId: string; readonly name: string; readonly sessionId?: string } & ProgramVersionInput,
	): Promise<{ readonly program: ProgramView; readonly version: ProgramVersionRecord }>;
	run(ctx: CallContext, programId: string, input: RunProgramInput, idempotencyKey?: string): Promise<ProgramRunView>;
	runs(ctx: CallContext, programId: string): Promise<ProgramRunView[]>;
	getRun(ctx: CallContext, programId: string, runId: string): Promise<ProgramRunView>;
	cancel(ctx: CallContext, programId: string, runId: string): Promise<ProgramRunView>;
}

/** The profile a version runs as. */
export function programProfileId(programId: string, version: number): string {
	return `program-${programId}-v${version}`;
}

/** `undefined` when `value` matches `schema`, else a short list of what doesn't. */
export function schemaProblems(schema: { readonly [key: string]: JsonValue }, value: unknown): string | undefined {
	try {
		if (Value.Check(schema as never, value)) return undefined;
		const problems = [...Value.Errors(schema as never, value)]
			.slice(0, 5)
			.map((error) => `${error.instancePath === "" ? "/" : error.instancePath} ${error.message}`);
		return problems.length === 0 ? "does not match the schema" : problems.join("; ");
	} catch (error) {
		return `the schema can't be checked: ${error instanceof Error ? error.message : String(error)}`;
	}
}

const randomId = (prefix: string): string =>
	`${prefix}_${[...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

const delay = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

/** A context for work that outlives the call: the same caller, without the request's abort signal. */
const detached = (ctx: CallContext): CallContext => {
	const { signal: _signal, ...rest } = ctx;
	return rest;
};

export function createProgramsService(options: ProgramsServiceOptions): ProgramsService {
	const { store, audit, now } = options;
	const newId = options.newId ?? randomId;
	const background = options.background ?? ((work: Promise<unknown>) => void work.catch(() => undefined));
	/** Runs being settled in this process, so concurrent readers wait on one. */
	const settling = new Map<string, Promise<ProgramRunRecord>>();

	const view = (program: ProgramRecord): ProgramView => ({
		id: program.id,
		organisationId: program.organisationId,
		projectId: program.projectId,
		name: program.name,
		...(program.description === undefined ? {} : { description: program.description }),
		...(program.versions.length === 0 ? {} : { latestVersion: program.versions[program.versions.length - 1] }),
		versions: program.versions,
		createdAt: program.createdAt,
		updatedAt: program.updatedAt,
		createdBy: program.createdBy,
	});

	const runView = (run: ProgramRunRecord, waiting?: "approval"): ProgramRunView => {
		const { organisationId: _o, submissionId: _s, idempotencyKey: _k, ...rest } = run;
		return { ...rest, ...(waiting === undefined ? {} : { waiting }) };
	};

	const emit = async (
		ctx: CallContext,
		type: string,
		program: Pick<ProgramRecord, "id" | "projectId">,
		data: { readonly [key: string]: JsonValue },
		extra: { readonly sessionId?: string; readonly id?: string } = {},
	) => {
		await audit.append(systemContext("programs"), [
			{
				id: extra.id ?? `programs:${type}:${newId("evt")}`,
				at: now(),
				source: "programs",
				type,
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				projectId: program.projectId,
				...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
				subject: { kind: "program", id: program.id },
				data,
			},
		]);
	};

	const check = async (
		ctx: CallContext,
		projectId: string,
		needed: "viewer" | "operator",
		operation: string,
		id?: string,
	) => {
		await options.access().require(ctx, {
			projectId,
			needed,
			operation,
			...(id === undefined ? {} : { subject: { kind: "program", id } }),
		});
	};

	/** The program, once the caller may do `needed` with it; a program in another organisation is not found. */
	const programFor = async (ctx: CallContext, programId: string, needed: "viewer" | "operator", operation: string) => {
		const program = await store.program(programId);
		if (program === undefined || program.organisationId !== ctx.organisationId) {
			throw new KantelError("not_found", "No such program");
		}
		await check(ctx, program.projectId, needed, operation, program.id);
		return program;
	};

	const versionInput = (input: ProgramVersionInput) => {
		if (input.code.trim() === "") throw new KantelError("invalid", "A program needs code");
		const tools = [...new Set((input.tools ?? []).map((tool) => tool.trim()).filter((tool) => tool !== ""))];
		const withheld = tools.filter((tool) => WITHHELD_TOOLS.has(tool));
		if (withheld.length > 0) {
			throw new KantelError("invalid", `A program can't call ${withheld.join(", ")}`);
		}
		for (const [which, schema] of [
			["inputSchema", input.inputSchema],
			["outputSchema", input.outputSchema],
		] as const) {
			if (schema === undefined) continue;
			const problem = schemaProblems(schema, null);
			if (problem?.startsWith("the schema can't be checked") === true) {
				throw new KantelError("invalid", `${which}: ${problem}`);
			}
		}
		return { ...input, tools };
	};

	/** Adds version `nextVersion` of `program`, with its profile. */
	const addVersionTo = async (
		ctx: CallContext,
		program: ProgramRecord,
		input: ProgramVersionInput,
		sessionId?: string,
	): Promise<{ program: ProgramRecord; version: ProgramVersionRecord }> => {
		const checked = versionInput(input);
		const at = now();
		const version: ProgramVersionRecord = {
			programId: program.id,
			version: program.nextVersion,
			code: checked.code,
			...(checked.description === undefined ? {} : { description: checked.description }),
			...(checked.inputSchema === undefined ? {} : { inputSchema: checked.inputSchema }),
			...(checked.outputSchema === undefined ? {} : { outputSchema: checked.outputSchema }),
			tools: checked.tools,
			timeoutMs: checked.timeoutMs ?? DEFAULT_PROGRAM_TIMEOUT_MS,
			maxOutputTokens: checked.maxOutputTokens ?? DEFAULT_PROGRAM_MAX_OUTPUT_TOKENS,
			createdAt: at,
			createdBy: ctx.actor,
			...(sessionId === undefined ? {} : { sessionId }),
		};
		// The profile first: a version is only runnable through it, and saving it checks the tool entries.
		await options.profiles().put(ctx, {
			id: programProfileId(program.id, version.version),
			organisationId: program.organisationId,
			projectId: program.projectId,
			name: `Program ${program.name} v${version.version}`,
			model: { route: PROGRAM_MODEL_ROUTE },
			promptLayers: [],
			tools: ["codemode", ...version.tools],
			skills: [],
			sandbox: { tiers: ["isolate"] },
			memoryScopes: [],
		});
		try {
			await store.addVersion(version);
		} catch {
			throw new KantelError("conflict", "Another version was saved at the same time; try again");
		}
		const updated: ProgramRecord = {
			...program,
			versions: [...program.versions, version.version],
			nextVersion: version.version + 1,
			updatedAt: at,
			...(checked.description === undefined ? {} : { description: checked.description }),
		};
		await store.putProgram(updated);
		await emit(
			ctx,
			"programs.version.created",
			program,
			{ version: version.version, tools: [...version.tools] },
			{
				...(sessionId === undefined ? {} : { sessionId }),
			},
		);
		return { program: updated, version };
	};

	const createProgram = async (
		ctx: CallContext,
		input: { readonly projectId: string; readonly name: string } & ProgramVersionInput,
		sessionId?: string,
	) => {
		const name = input.name.trim();
		if (name === "") throw new KantelError("invalid", "A program needs a name");
		if ((await store.programByName(ctx.organisationId, input.projectId, name)) !== undefined) {
			throw new KantelError("conflict", `The project already has a program named ${name}`);
		}
		const at = now();
		const program: ProgramRecord = {
			id: newId("prog"),
			organisationId: ctx.organisationId,
			projectId: input.projectId,
			name,
			...(input.description === undefined ? {} : { description: input.description }),
			versions: [],
			nextVersion: 1,
			createdAt: at,
			updatedAt: at,
			createdBy: ctx.actor,
		};
		versionInput(input);
		await store.putProgram(program);
		await emit(ctx, "programs.program.created", program, { name });
		return addVersionTo(ctx, program, input, sessionId);
	};

	/** The run as it is now: settled from its session's result when the session has finished. */
	const settle = (ctx: CallContext, run: ProgramRunRecord, waitMs: number): Promise<ProgramRunRecord> => {
		if (run.status !== "running") return Promise.resolve(run);
		let pending = settling.get(run.id);
		if (pending === undefined) {
			const quiet = detached(ctx);
			pending = (async () => {
				const result: RunResult = await options.runtime().wait(quiet, run.sessionId, run.submissionId);
				const latest = (await store.run(run.id)) ?? run;
				if (latest.status !== "running") return latest;
				const version = await store.version(run.programId, run.version);
				const outcome = parseProgramOutcome(result.answer);
				let status: ProgramRunRecord["status"] = "failed";
				let error = result.error ?? outcome.error;
				if (result.status === "aborted") {
					status = "cancelled";
					error = result.error ?? "The run was stopped";
				} else if (result.status === "answered" && outcome.ok) {
					const problem =
						version?.outputSchema === undefined ? undefined : schemaProblems(version.outputSchema, outcome.output);
					status = problem === undefined ? "succeeded" : "failed";
					error = problem === undefined ? undefined : `The output does not match the output schema: ${problem}`;
				}
				const endedAt = now();
				const ended: ProgramRunRecord = {
					...latest,
					status,
					...(outcome.output === undefined ? {} : { output: outcome.output as JsonValue }),
					...(outcome.logs === undefined ? {} : { logs: outcome.logs }),
					...(error === undefined ? {} : { error }),
					endedAt,
				};
				await store.putRun(ended);
				await emit(
					quiet,
					"programs.run.ended",
					{ id: run.programId, projectId: run.projectId },
					{ runId: run.id, version: run.version, status, durationMs: endedAt - run.startedAt },
					{ sessionId: run.sessionId, id: `programs:run:${run.id}:ended` },
				);
				return ended;
			})().finally(() => settling.delete(run.id));
			settling.set(run.id, pending);
			background(pending);
		}
		return waitMs <= 0
			? Promise.race([pending, Promise.resolve(run)])
			: Promise.race([pending, delay(waitMs).then(() => run)]);
	};

	/** Whether a running run waits for a person: its session's attention is `waiting`. */
	const waitingOf = async (ctx: CallContext, run: ProgramRunRecord): Promise<"approval" | undefined> => {
		if (run.status !== "running") return undefined;
		try {
			const snapshot = await options.runtime().snapshot(ctx, run.sessionId);
			return snapshot.attention === "waiting" ? "approval" : undefined;
		} catch {
			return undefined;
		}
	};

	const runFor = async (
		ctx: CallContext,
		programId: string,
		runId: string,
		needed: "viewer" | "operator",
		operation: string,
	) => {
		const run = await store.run(runId);
		if (run === undefined || run.programId !== programId || run.organisationId !== ctx.organisationId) {
			throw new KantelError("not_found", "No such run");
		}
		await check(ctx, run.projectId, needed, operation, programId);
		return run;
	};

	return {
		async list(ctx, filter = {}) {
			const access = options.access();
			const found: ProgramView[] = [];
			const allowed = new Map<string, boolean>();
			for (const program of await store.programs(ctx.organisationId)) {
				if (filter.projectId !== undefined && program.projectId !== filter.projectId) continue;
				let may = allowed.get(program.projectId);
				if (may === undefined) {
					may = await access.allows(ctx, { projectId: program.projectId, needed: "viewer" });
					allowed.set(program.projectId, may);
				}
				if (may) found.push(view(program));
			}
			return found;
		},
		async create(ctx, input) {
			await check(ctx, input.projectId, "operator", "programs.create");
			return view((await createProgram(ctx, input)).program);
		},
		async get(ctx, programId) {
			return view(await programFor(ctx, programId, "viewer", "programs.get"));
		},
		async remove(ctx, programId) {
			const program = await programFor(ctx, programId, "operator", "programs.remove");
			await store.removeProgram(program.id);
			await emit(ctx, "programs.program.removed", program, { name: program.name });
		},
		async versions(ctx, programId) {
			const program = await programFor(ctx, programId, "viewer", "programs.versions");
			return store.versions(program.id);
		},
		async addVersion(ctx, programId, input) {
			const program = await programFor(ctx, programId, "operator", "programs.versions.create");
			return (await addVersionTo(ctx, program, input)).version;
		},
		async version(ctx, programId, version) {
			const program = await programFor(ctx, programId, "viewer", "programs.versions.get");
			const found = await store.version(program.id, version);
			if (found === undefined) throw new KantelError("not_found", `The program has no version ${version}`);
			return found;
		},
		async removeVersion(ctx, programId, version) {
			const program = await programFor(ctx, programId, "operator", "programs.versions.remove");
			if (!program.versions.includes(version))
				throw new KantelError("not_found", `The program has no version ${version}`);
			await store.removeVersion(program.id, version);
			await store.putProgram({
				...program,
				versions: program.versions.filter((kept) => kept !== version),
				updatedAt: now(),
			});
			await emit(ctx, "programs.version.removed", program, { version });
		},
		async save(ctx, input) {
			await check(ctx, input.projectId, "operator", "programs.save");
			const existing = await store.programByName(ctx.organisationId, input.projectId, input.name.trim());
			const saved =
				existing === undefined
					? await createProgram(ctx, input, input.sessionId)
					: await addVersionTo(ctx, existing, input, input.sessionId);
			return { program: view(saved.program), version: saved.version };
		},
		async run(ctx, programId, input, idempotencyKey) {
			const program = await programFor(ctx, programId, "operator", "programs.run");
			if (idempotencyKey !== undefined) {
				const earlier = await store.runByKey(program.id, idempotencyKey);
				if (earlier !== undefined) return runView(await settle(ctx, earlier, 0));
			}
			const number = input.version ?? program.versions[program.versions.length - 1];
			if (number === undefined) throw new KantelError("not_found", "The program has no versions");
			const version = await store.version(program.id, number);
			if (version === undefined) throw new KantelError("not_found", `The program has no version ${number}`);
			const value = input.input ?? null;
			if (version.inputSchema !== undefined) {
				const problem = schemaProblems(version.inputSchema, value);
				if (problem !== undefined)
					throw new KantelError("invalid", `The input does not match the input schema: ${problem}`);
			}
			const runId = newId("prun");
			const runtime = options.runtime();
			const session = await runtime.create(ctx, {
				projectId: program.projectId,
				agentId: programProfileId(program.id, version.version),
				title: `${program.name} v${version.version}`,
				labels: { programId: program.id, programVersion: String(version.version), programRun: runId },
			});
			const submission = await runtime.prompt(ctx, session.id, {
				text: programRunPrompt({
					runId,
					programId: program.id,
					name: program.name,
					version: version.version,
					code: version.code,
					input: value,
					timeoutMs: version.timeoutMs,
					maxOutputTokens: version.maxOutputTokens,
				}),
				requestId: `program-run:${runId}`,
			});
			const run: ProgramRunRecord = {
				id: runId,
				organisationId: program.organisationId,
				projectId: program.projectId,
				programId: program.id,
				version: version.version,
				status: "running",
				input: value,
				sessionId: session.id,
				submissionId: submission.id,
				startedAt: now(),
				startedBy: ctx.actor,
				...(idempotencyKey === undefined ? {} : { idempotencyKey }),
			};
			await store.putRun(run);
			await emit(
				ctx,
				"programs.run.started",
				program,
				{ runId, version: version.version, mode: input.mode ?? "sync" },
				{ sessionId: session.id, id: `programs:run:${runId}:started` },
			);
			const waitMs = input.mode === "async" ? 0 : (input.waitMs ?? DEFAULT_PROGRAM_WAIT_MS);
			const now_ = await settle(ctx, run, waitMs);
			return runView(now_, await waitingOf(ctx, now_));
		},
		async runs(ctx, programId) {
			const program = await programFor(ctx, programId, "viewer", "programs.runs");
			const runs = await store.runs(program.id, RUNS_LISTED);
			return Promise.all(runs.map(async (run) => runView(await settle(ctx, run, 0))));
		},
		async getRun(ctx, programId, runId) {
			const run = await settle(ctx, await runFor(ctx, programId, runId, "viewer", "programs.runs.get"), 50);
			return runView(run, await waitingOf(ctx, run));
		},
		async cancel(ctx, programId, runId) {
			const run = await runFor(ctx, programId, runId, "operator", "programs.runs.cancel");
			if (run.status !== "running") return runView(run);
			await options.runtime().abort(ctx, run.sessionId, "The program run was cancelled");
			return runView(await settle(ctx, run, 5_000));
		},
	};
}
