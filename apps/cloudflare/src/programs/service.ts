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
 * - **Pauses** (`waits`, `KANTEL_PROGRAM_WAITS=on`; `./journal.ts`). A program can wait for a person's input
 *   (`waitForInput()`) or an agent's answer (`agent()`, when its version's tools name `agent`). The wait is recorded in
 *   the run's journal first; then the run is `waiting`, and its session's turn is stopped, so nothing runs while it
 *   waits. Supplying the value (`resume`), or the agent session answering, starts the next activation: the script runs
 *   again from the top, every call an earlier activation finished comes from the journal, and the step returns the
 *   value. One activation at a time: a run resumes once per value, and a value that arrives before the run has paused
 *   is taken by the activation that is still running.
 */

import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
	type AgentProfiles,
	type AuditSink,
	type CallContext,
	isKantelError,
	type JsonValue,
	KantelError,
	type ProjectAccess,
	type RunResult,
	type SessionRuntime,
	systemContext,
} from "@kantel/contracts";
import { isConnectionApprovalCard, type TranscriptItem } from "@kantel/protocol";
import Value from "typebox/value";
import {
	canonicalJson,
	fingerprintOf,
	isWaitTool,
	journaledCodemodeTool,
	type NestedResult,
	type ProgramSteps,
	programAgentParameters,
	programInputParameters,
} from "./journal.ts";
import {
	PROGRAM_AGENT_TOOL,
	PROGRAM_INPUT_TOOL,
	PROGRAM_MODEL_ROUTE,
	parseProgramOutcome,
	programRunPrompt,
} from "./runner-model.ts";
import type {
	ProgramRecord,
	ProgramRunRecord,
	ProgramStepRecord,
	ProgramStore,
	ProgramVersionRecord,
	ProgramWaitRecord,
} from "./store.ts";

/** A run's deadline when its version names none, and the output's budget. */
export const DEFAULT_PROGRAM_TIMEOUT_MS = 300_000;
export const DEFAULT_PROGRAM_MAX_OUTPUT_TOKENS = 10_000;
/** How long a sync run call waits before answering 202 with the running run. */
export const DEFAULT_PROGRAM_WAIT_MS = 30_000;
/** Tools a program never gets: code mode is how it runs, and the others would start more agents or programs. */
const WITHHELD_TOOLS = new Set(["codemode", "subagent", "save_program", PROGRAM_INPUT_TOOL, PROGRAM_AGENT_TOOL]);
/** The entry in a version's tools that lets it start agent steps (`agent()`); not a tool of the run's session. */
export const AGENT_STEP_ENTRY = "agent";
const RUNS_LISTED = 100;
/** How long a run that hit a wait lets other calls of the same moment register theirs before it pauses. */
const PAUSE_SETTLE_MS = 100;
/** A call result bigger than this isn't kept in the journal: after a pause the call runs again. */
const MAX_KEPT_RESULT_CHARS = 256 * 1024;
const ARGS_PREVIEW_CHARS = 200;

/** What a waiting run waits on: one shape for every kind, so a client handles each the same way. */
export type ProgramRunWait =
	| {
			readonly kind: "input";
			readonly id: string;
			readonly key?: string;
			readonly prompt: string;
			readonly schema?: { readonly [key: string]: JsonValue };
			readonly since: number;
	  }
	| {
			readonly kind: "agent";
			readonly id: string;
			readonly key?: string;
			readonly prompt: string;
			readonly schema?: { readonly [key: string]: JsonValue };
			readonly agentId: string;
			readonly sessionId?: string;
			readonly since: number;
	  }
	| ProgramApprovalWait;

/**
 * A running run whose script's tool call is held for a person: a connection request (decided on its request page,
 * `link`) or a browser request (answered from the session's card, or `POST /browser/decisions`
 * `{ sessionId, callId, allow }`).
 */
export type ProgramApprovalWait = {
	readonly kind: "approval";
	/** The run's session, which holds the call. */
	readonly sessionId: string;
	/** The held tool call in that session: the script's inner call, `<scriptCallId>/<key>`. */
	readonly callId: string;
	/** When it started waiting. */
	readonly since: number;
} & (
	| {
			readonly connection: {
				/** The connection request's ID, as the approval card and `/connections/requests/{id}` name it. */
				readonly requestId: string;
				readonly what: string;
				readonly host: string;
				/** Where a person decides it. */
				readonly link: string;
				readonly expiresAt: number;
			};
	  }
	| { readonly browser: { readonly reason: string; readonly sites: readonly string[] } }
);

/** One step of a run's journal, as the API answers it. */
export interface ProgramRunStepView {
	readonly tool: string;
	readonly kind: ProgramStepRecord["kind"];
	readonly occurrence: number;
	readonly status: ProgramStepRecord["status"];
	readonly args: string;
	readonly firstActivation: number;
	readonly lastActivation: number;
	/** How many later activations took it from the journal instead of running it again. */
	readonly replays: number;
	readonly kept: boolean;
	readonly isError?: boolean;
	readonly executedAt: number;
	readonly durationMs?: number;
	readonly waitId?: string;
}

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
	/** Kept for older clients: a running run whose session waits for a person to allow a tool call. */
	readonly waiting?: "approval";
	/**
	 * What the run waits on while its status is `waiting`: steps that pause it, or the approvals its running session
	 * holds (a running run held on a person is shown `waiting` too).
	 */
	readonly waitingOn?: readonly ProgramRunWait[];
}

export interface ResumeProgramRunInput {
	/** The wait to resolve; optional when the run waits on exactly one. */
	readonly waitId?: string;
	/** The step's value: what `waitForInput()` (or `agent()`) returns. */
	readonly value?: JsonValue;
	/** Resolves the step with an error instead: the program's `await` throws it. */
	readonly error?: string;
	/** How long to wait for the resumed run before answering. Default 0. */
	readonly waitMs?: number;
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
	/** Durable pauses (`KANTEL_PROGRAM_WAITS=on`): `waitForInput()`, `agent()` and the run's journal. Default off. */
	readonly waits?: boolean;
	/** The profile an `agent()` step runs when it names none. */
	readonly defaultAgentId?: string;
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
	/** Supplies the value a waiting step waits on (or an error for it), and resumes the run. Needs operator. */
	resume(ctx: CallContext, programId: string, runId: string, input: ResumeProgramRunInput): Promise<ProgramRunView>;
	/** The run's journal: each call and wait, how often it was taken from the journal instead of run again. */
	steps(ctx: CallContext, programId: string, runId: string): Promise<ProgramRunStepView[]>;
	/** Whether runs can pause (`waits`). */
	readonly waits: boolean;
	/** A program run's code mode tool, journalled (`./journal.ts`); any other session's as it is. */
	codemodeFor(
		tool: ToolRegistration,
		record: { readonly labels: { readonly [key: string]: string } },
	): ToolRegistration;
	/** Picks up the agent steps runs were waiting on when the object stopped. */
	recover(): Promise<void>;
}

/**
 * The approvals a run's session waits on, from its transcript: pending connection approval cards and browser request
 * cards (a script's `browser_request`), each only while the tool call it names still runs, and any `browser_request`
 * the session's own model has running. Newest last.
 */
export function runWaits(sessionId: string, items: readonly TranscriptItem[]): ProgramApprovalWait[] {
	const running = new Set<string>();
	for (const item of items) if (item.kind === "tool" && item.status === "running") running.add(item.callId);
	/** A card's call still runs: the call itself, or for a script's inner call, the script. */
	const live = (callId: string | undefined) =>
		callId !== undefined && (running.has(callId) || running.has(callId.split("/")[0] ?? ""));
	const waits: ProgramApprovalWait[] = [];
	for (const item of items) {
		if (item.kind === "tool" && item.name === "browser_request" && item.status === "running") {
			const args = (typeof item.args === "object" && item.args !== null ? item.args : {}) as {
				reason?: unknown;
				sites?: unknown;
			};
			const sites = Array.isArray(args.sites) ? args.sites.filter((site) => typeof site === "string") : [];
			waits.push({
				kind: "approval",
				sessionId,
				callId: item.callId,
				since: item.at,
				browser: { reason: typeof args.reason === "string" ? args.reason : "", sites },
			});
			continue;
		}
		if (item.kind !== "card") continue;
		const { card } = item;
		if (isConnectionApprovalCard(card) && card.status === "pending" && live(card.callId)) {
			waits.push({
				kind: "approval",
				sessionId,
				callId: card.callId ?? "",
				since: item.at,
				connection: {
					requestId: card.proposalId,
					what: card.what,
					host: card.host,
					link: card.link,
					expiresAt: card.expiresAt,
				},
			});
		} else if (card.type === "browser.grant" && card.status === "pending" && live(card.callId)) {
			waits.push({
				kind: "approval",
				sessionId,
				callId: card.callId ?? "",
				since: item.at,
				browser: { reason: card.reason, sites: [...(card.sites ?? [])] },
			});
		}
	}
	return waits;
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

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** A context for work that outlives the call: the same caller, without the request's abort signal. */
const detached = (ctx: CallContext): CallContext => {
	const { signal: _signal, ...rest } = ctx;
	return rest;
};

export function createProgramsService(options: ProgramsServiceOptions): ProgramsService {
	const { store, audit, now } = options;
	const newId = options.newId ?? randomId;
	const background = options.background ?? ((work: Promise<unknown>) => void work.catch(() => undefined));
	const waitsOn = options.waits === true;
	const defaultAgentId = options.defaultAgentId ?? "default";
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

	const runView = (run: ProgramRunRecord, waitingOn?: readonly ProgramRunWait[]): ProgramRunView => {
		const { organisationId: _o, submissionId: _s, idempotencyKey: _k, ...rest } = run;
		if (waitingOn === undefined || waitingOn.length === 0) return rest;
		const approval = waitingOn.some((wait) => wait.kind === "approval");
		// A running run held on a person's approval is shown waiting: nothing it does goes on until they answer.
		return { ...rest, status: "waiting", ...(approval ? { waiting: "approval" as const } : {}), waitingOn };
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
			// `agent` lets the program start agent steps; it is no tool of the run's own session.
			tools: ["codemode", ...version.tools.filter((tool) => tool !== AGENT_STEP_ENTRY)],
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
		// No submission yet: its activation is being started, and the one starting it settles it.
		if (run.status !== "running" || run.submissionId === "") return Promise.resolve(run);
		// One settle per activation: a paused run's next activation has a submission of its own.
		const settleKey = `${run.id}:${run.activation ?? 1}`;
		let pending = settling.get(settleKey);
		if (pending === undefined) {
			const quiet = detached(ctx);
			pending = (async () => {
				const result: RunResult = await options.runtime().wait(quiet, run.sessionId, run.submissionId);
				const latest = (await store.run(run.id)) ?? run;
				// Paused (its turn was stopped because it waits), resumed since, or ended another way.
				if (latest.status !== "running" || (latest.activation ?? 1) !== (run.activation ?? 1)) return latest;
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
				if (waitsOn) await stopAgentSteps(run.id);
				return ended;
			})().finally(() => settling.delete(settleKey));
			settling.set(settleKey, pending);
			background(pending);
		}
		return waitMs <= 0
			? Promise.race([pending, Promise.resolve(run)])
			: Promise.race([pending, delay(waitMs).then(() => run)]);
	};

	/**
	 * What a run waits on: a waiting run, its steps that wait; a running one, the tool calls its session holds for a
	 * person to allow, while the session is `waiting`.
	 */
	const waitingOf = async (ctx: CallContext, run: ProgramRunRecord): Promise<ProgramRunWait[] | undefined> => {
		if (run.status === "waiting") {
			const steps = await store.steps(run.id);
			// An agent step the object stopped watching (a restart) is picked up again by whoever looks.
			for (const step of steps) if (step.kind === "agent" && step.status === "waiting") void watchAgent(run, step);
			return steps.flatMap((step) =>
				step.status === "waiting" && step.wait !== undefined ? [waitView(step.wait)] : [],
			);
		}
		if (run.status !== "running") return undefined;
		try {
			const snapshot = await options.runtime().snapshot(ctx, run.sessionId);
			return snapshot.status === "waiting" ? runWaits(run.sessionId, snapshot.items) : undefined;
		} catch {
			return undefined;
		}
	};

	// Durable pauses (`./journal.ts`). Every change to a run's journal or status happens under the run's lock, which
	// orders them within this object; the store keeps them across restarts.
	const locks = new Map<string, Promise<unknown>>();
	const locked = <T>(runId: string, work: () => Promise<T>): Promise<T> => {
		const next = (locks.get(runId) ?? Promise.resolve()).then(work, work);
		const tail = next.catch(() => undefined);
		locks.set(runId, tail);
		void tail.then(() => {
			if (locks.get(runId) === tail) locks.delete(runId);
		});
		return next;
	};
	/** Occurrences of a call taken by calls still running, which have no step yet: `<run>#<tool>#<fingerprint>`. */
	const inflight = new Map<string, Set<number>>();
	/** Runs pausing now, so a value that arrives meanwhile is left to the pause. */
	const pausing = new Map<string, Promise<void>>();
	/** Agent steps whose session this object watches, by wait ID. */
	const watching = new Set<string>();
	/** Wait calls of a running activation, by wait ID, until it pauses or they get their value. */
	const parked = new Map<string, { readonly activation: number; readonly resolve: (result: NestedResult) => void }>();

	/** The run's caller: a run's session, its resumes and its agent steps all act as whoever started it. */
	const callerOf = (run: ProgramRunRecord): CallContext => ({
		actor: run.startedBy,
		organisationId: run.organisationId,
		projectId: run.projectId,
	});

	const waitView = (wait: ProgramWaitRecord): ProgramRunWait =>
		wait.kind === "input"
			? {
					kind: "input",
					id: wait.id,
					...(wait.key === undefined ? {} : { key: wait.key }),
					prompt: wait.prompt,
					...(wait.schema === undefined ? {} : { schema: wait.schema }),
					since: wait.since,
				}
			: {
					kind: "agent",
					id: wait.id,
					...(wait.key === undefined ? {} : { key: wait.key }),
					prompt: wait.prompt,
					...(wait.schema === undefined ? {} : { schema: wait.schema }),
					agentId: wait.agentId ?? defaultAgentId,
					...(wait.sessionId === undefined ? {} : { sessionId: wait.sessionId }),
					since: wait.since,
				};

	const stepView = (step: ProgramStepRecord): ProgramRunStepView => {
		const isError =
			step.kind === "call"
				? (step.result as { isError?: boolean } | undefined)?.isError
				: step.wait?.error !== undefined
					? true
					: undefined;
		return {
			tool: step.tool,
			kind: step.kind,
			occurrence: step.occurrence,
			status: step.status,
			args: step.argsPreview,
			firstActivation: step.firstActivation,
			lastActivation: step.activation,
			replays: step.replays,
			kept: step.kind !== "call" || step.result !== undefined,
			...(isError === undefined ? {} : { isError }),
			executedAt: step.executedAt,
			...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
			...(step.wait === undefined ? {} : { waitId: step.wait.id }),
		};
	};

	/** What a resolved wait gives the script: its value, or its error, which the script's `await` throws. */
	const waitResult = (wait: ProgramWaitRecord): NestedResult =>
		(wait.error === undefined
			? { taskId: "", isError: false, structuredOutput: wait.value ?? null, diagnostics: [] }
			: {
					taskId: "",
					isError: true,
					diagnostics: [{ severity: "error", message: wait.error, code: "program_wait" }],
				}) as unknown as NestedResult;

	const refused = (message: string): NestedResult =>
		({
			taskId: "",
			isError: true,
			diagnostics: [{ severity: "error", message, code: "program_wait" }],
		}) as unknown as NestedResult;

	type Claim =
		| { readonly step: ProgramStepRecord; readonly replayed: boolean }
		| { readonly occurrence: number; readonly release: () => void };

	/**
	 * Which step a call is. The same call (tool, arguments and code mode key) again in this activation, after code mode
	 * resumed its script: that step. Else the earliest step of the same tool and arguments no call of this activation has
	 * taken: an earlier activation's, from the journal. Else a new occurrence, held in memory until its result is kept.
	 */
	const claim = (runId: string, activation: number, key: string, tool: string, fingerprint: string): Promise<Claim> =>
		locked(runId, async () => {
			const same = (await store.steps(runId))
				.filter((step) => step.tool === tool && step.fingerprint === fingerprint)
				.sort((a, b) => a.occurrence - b.occurrence);
			const mine = same.find((step) => step.activation === activation && step.callKey === key);
			if (mine !== undefined) return { step: mine, replayed: false };
			const earlier = same.find((step) => step.activation < activation);
			if (earlier !== undefined) {
				const taken = earlier.status !== "waiting" && (earlier.kind !== "call" || earlier.result !== undefined);
				const step: ProgramStepRecord = {
					...earlier,
					activation,
					callKey: key,
					replays: earlier.replays + (taken ? 1 : 0),
					...(earlier.status === "resolved" ? { consumed: true } : {}),
				};
				await store.putStep(step);
				return { step, replayed: taken };
			}
			const flightKey = `${runId}#${tool}#${fingerprint}`;
			const flying = inflight.get(flightKey) ?? new Set<number>();
			const occurrence = Math.max(-1, ...same.map((step) => step.occurrence), ...flying) + 1;
			flying.add(occurrence);
			inflight.set(flightKey, flying);
			return {
				occurrence,
				release: () => {
					flying.delete(occurrence);
					if (flying.size === 0) inflight.delete(flightKey);
				},
			};
		});

	const emitStep = (run: ProgramRunRecord, type: string, data: { readonly [key: string]: JsonValue }) =>
		emit(
			callerOf(run),
			type,
			{ id: run.programId, projectId: run.projectId },
			{ runId: run.id, ...data },
			{
				sessionId: run.sessionId,
			},
		);

	/** A tool call of the script: from the journal when an earlier activation finished it, else made and kept. */
	const callStep = async (
		run: ProgramRunRecord,
		input: Parameters<ProgramSteps["step"]>[0],
		fingerprint: string,
		execute: () => Promise<NestedResult>,
	): Promise<NestedResult> => {
		const claimed = await claim(run.id, input.activation, input.key, input.name, fingerprint);
		const base = "step" in claimed ? claimed.step : undefined;
		if (base?.result !== undefined) {
			if ("replayed" in claimed && claimed.replayed) {
				await emitStep(run, "programs.step.replayed", {
					tool: input.name,
					occurrence: base.occurrence,
					activation: input.activation,
					firstActivation: base.firstActivation,
				});
			}
			return structuredClone(base.result) as unknown as NestedResult;
		}
		const release = "release" in claimed ? claimed.release : () => undefined;
		const started = now();
		let result: NestedResult;
		try {
			result = await execute();
		} catch (error) {
			release();
			throw error;
		}
		// A call the run's pause or cancel stopped never reached the script: it isn't a finished step.
		if (input.signal?.aborted === true || result.diagnostics.some((diagnostic) => diagnostic.code === "aborted")) {
			release();
			return result;
		}
		const text = JSON.stringify(result);
		const kept = text.length <= MAX_KEPT_RESULT_CHARS ? (JSON.parse(text) as JsonValue) : undefined;
		try {
			await locked(run.id, () =>
				store.putStep({
					runId: run.id,
					tool: input.name,
					fingerprint,
					occurrence: base?.occurrence ?? (claimed as { occurrence: number }).occurrence,
					kind: "call",
					status: "done",
					firstActivation: base?.firstActivation ?? input.activation,
					activation: input.activation,
					callKey: input.key,
					argsPreview: cut(canonicalJson(input.args), ARGS_PREVIEW_CHARS),
					...(kept === undefined ? {} : { result: kept }),
					executedAt: base?.executedAt ?? started,
					durationMs: now() - started,
					replays: base?.replays ?? 0,
				}),
			);
		} finally {
			release();
		}
		return result;
	};

	/**
	 * `waitForInput()` or `agent()`: the step's value once it has one; else the wait is kept (and an agent step's session
	 * started), the run pauses, and the call never returns: the pause stops the script.
	 */
	const waitStep = async (
		run: ProgramRunRecord,
		input: Parameters<ProgramSteps["step"]>[0],
		fingerprint: string,
	): Promise<NestedResult> => {
		const kind = input.name === PROGRAM_AGENT_TOOL ? "agent" : "input";
		const parameters = kind === "agent" ? programAgentParameters : programInputParameters;
		if (!Value.Check(parameters, input.args)) {
			const problems = [...Value.Errors(parameters, input.args)]
				.slice(0, 3)
				.map((error) => `${error.instancePath || "/"} ${error.message}`);
			return refused(`${kind === "agent" ? "agent()" : "waitForInput()"}: ${problems.join("; ")}`);
		}
		const args = input.args as {
			readonly prompt: string;
			readonly key?: string;
			readonly agentId?: string;
			readonly title?: string;
			readonly schema?: { readonly [key: string]: JsonValue };
		};
		if (kind === "agent") {
			const version = await store.version(run.programId, run.version);
			if (version?.tools.includes(AGENT_STEP_ENTRY) !== true) {
				return refused(`agent(): this program version can't start agents; add "${AGENT_STEP_ENTRY}" to its tools`);
			}
		}
		const claimed = await claim(run.id, input.activation, input.key, input.name, fingerprint);
		let step: ProgramStepRecord;
		if ("step" in claimed) step = claimed.step;
		else {
			const at = now();
			const wait: ProgramWaitRecord = {
				id: newId("pwait"),
				kind,
				...(args.key === undefined ? {} : { key: args.key }),
				prompt: args.prompt,
				...(args.schema === undefined ? {} : { schema: args.schema }),
				since: at,
				...(kind === "agent" ? { agentId: args.agentId ?? defaultAgentId } : {}),
			};
			step = {
				runId: run.id,
				tool: input.name,
				fingerprint,
				occurrence: claimed.occurrence,
				kind,
				status: "waiting",
				firstActivation: input.activation,
				activation: input.activation,
				callKey: input.key,
				argsPreview: cut(canonicalJson(input.args), ARGS_PREVIEW_CHARS),
				executedAt: at,
				replays: 0,
				wait,
			};
			try {
				await locked(run.id, () => store.putStep(step));
			} finally {
				claimed.release();
			}
			await emitStep(run, "programs.wait.created", {
				waitId: wait.id,
				kind,
				activation: input.activation,
				...(wait.key === undefined ? {} : { key: wait.key }),
			});
			if (kind === "agent") void watchAgent(run, step, args.title);
		}
		if (step.status === "resolved" && step.wait !== undefined) {
			if (step.consumed !== true) {
				const taken: ProgramStepRecord = { ...step, consumed: true };
				await locked(run.id, () => store.putStep(taken));
			}
			return waitResult(step.wait);
		}
		const waitId = step.wait?.id as string;
		// The pause stops this activation's turn, which aborts this call. A value that comes before it does is handed to
		// the call here (`resolveStep`), and then there is no pause.
		const parkedCall = new Promise<NestedResult>((resolve, reject) => {
			parked.set(waitId, { activation: input.activation, resolve });
			const signal = input.signal;
			if (signal === undefined) return;
			const stop = () => {
				if (parked.get(waitId)?.resolve === resolve) parked.delete(waitId);
				reject(signal.reason);
			};
			if (signal.aborted) stop();
			else signal.addEventListener("abort", stop, { once: true });
		});
		pause(run.id, input.activation);
		return parkedCall;
	};

	const steps: ProgramSteps = {
		async activation(runId) {
			const run = await store.run(runId);
			return run === undefined || run.status === "succeeded" || run.status === "failed" || run.status === "cancelled"
				? undefined
				: (run.activation ?? 1);
		},
		async step(input, execute) {
			const run = await store.run(input.runId);
			if (run === undefined) return execute();
			const fingerprint = await fingerprintOf(input.args);
			return isWaitTool(input.name) ? waitStep(run, input, fingerprint) : callStep(run, input, fingerprint, execute);
		},
	};

	/**
	 * Pauses the run's activation: once the calls of the moment have registered their waits, the run is `waiting` and
	 * its session's turn is stopped, so nothing runs while it waits. Then, a value that arrived meanwhile resumes it.
	 */
	const pause = (runId: string, activation: number): void => {
		if (pausing.has(runId)) return;
		const work = (async () => {
			await delay(PAUSE_SETTLE_MS);
			const run = await locked(runId, async () => {
				const latest = await store.run(runId);
				if (latest === undefined || (latest.activation ?? 1) !== activation) return undefined;
				// Already waiting: an eviction came between the pause and the turn's stop, so stop it again.
				if (latest.status === "waiting") return latest;
				if (latest.status !== "running") return undefined;
				// Every wait of the moment got its value while it settled: the activation goes on.
				const open = (await store.steps(runId)).some(
					(step) => step.status === "waiting" && step.activation === activation,
				);
				if (!open) return undefined;
				const waiting: ProgramRunRecord = { ...latest, status: "waiting" };
				await store.putRun(waiting);
				return waiting;
			});
			if (run === undefined) return;
			const waits = (await store.steps(runId)).flatMap((step) =>
				step.status === "waiting" && step.wait !== undefined ? [step.wait.id] : [],
			);
			await emitStep(run, "programs.run.waiting", { activation, waits });
			await options.runtime().abort(callerOf(run), run.sessionId, "The program is waiting");
		})()
			.catch((error) => console.error(`harbour: pausing program run ${runId} failed`, error))
			.finally(() => pausing.delete(runId));
		pausing.set(runId, work);
		background(work.then(() => continueIfResolved(runId)));
	};

	/** Starts the run's next activation when it is waiting and a wait has a value no activation has taken. */
	const continueIfResolved = async (runId: string): Promise<void> => {
		if (pausing.has(runId)) return;
		const started = await locked(runId, async () => {
			const run = await store.run(runId);
			if (run?.status !== "waiting") return undefined;
			const journal = await store.steps(runId);
			const fresh = journal.filter((step) => step.status === "resolved" && step.consumed !== true);
			if (fresh.length === 0) return undefined;
			// The next activation takes every value resolved so far.
			for (const step of fresh) await store.putStep({ ...step, consumed: true });
			const program = await store.program(run.programId);
			const version = await store.version(run.programId, run.version);
			if (program === undefined || version === undefined) {
				const ended: ProgramRunRecord = {
					...run,
					status: "failed",
					error: "The program version was deleted while the run waited",
					endedAt: now(),
				};
				await store.putRun(ended);
				return undefined;
			}
			const activation = (run.activation ?? 1) + 1;
			// The new activation is kept before its turn starts: its script reads which activation it is as it starts.
			const next: ProgramRunRecord = { ...run, status: "running", activation, submissionId: "" };
			await store.putRun(next);
			let submission: { readonly id: string };
			try {
				submission = await options.runtime().prompt(callerOf(run), run.sessionId, {
					text: programRunPrompt({
						runId: run.id,
						programId: run.programId,
						name: program.name,
						version: run.version,
						code: version.code,
						input: run.input,
						timeoutMs: version.timeoutMs,
						maxOutputTokens: version.maxOutputTokens,
						activation,
						waits: true,
					}),
					requestId: `program-run:${run.id}:${activation}`,
				});
			} catch (error) {
				// Not resumed: the run waits as it was, its values untaken, for the next try.
				await store.putRun(run);
				for (const step of fresh) await store.putStep(step);
				throw error;
			}
			const resumed: ProgramRunRecord = { ...next, submissionId: submission.id };
			await store.putRun(resumed);
			return { run: resumed, waits: fresh.flatMap((step) => (step.wait === undefined ? [] : [step.wait.id])) };
		});
		if (started === undefined) return;
		await emitStep(started.run, "programs.run.resumed", {
			activation: started.run.activation ?? 1,
			waits: started.waits,
		});
		void settle(callerOf(started.run), started.run, 0);
	};

	/** Resolves a waiting step with its value or error, once; then resumes the run if it is paused. */
	const resolveStep = async (
		runId: string,
		waitId: string,
		outcome: { readonly value?: JsonValue; readonly error?: string },
		by: ProgramRunRecord["startedBy"],
	): Promise<boolean> => {
		let handed: ((result: NestedResult) => void) | undefined;
		const resolved = await locked(runId, async () => {
			const step = await store.stepByWait(waitId);
			if (step?.wait === undefined || step.status !== "waiting") return undefined;
			const current = await store.run(runId);
			const call = parked.get(waitId);
			// The activation that made the wait hasn't paused yet: its call takes the value now.
			const live = call !== undefined && current?.status === "running" && (current.activation ?? 1) === call.activation;
			const next: ProgramStepRecord = {
				...step,
				status: "resolved",
				...(live ? { consumed: true } : {}),
				wait: {
					...step.wait,
					...(outcome.error === undefined ? { value: outcome.value ?? null } : { error: outcome.error }),
					resolvedAt: now(),
					resolvedBy: by,
				},
			};
			await store.putStep(next);
			if (live) {
				parked.delete(waitId);
				handed = call.resolve;
			}
			return next;
		});
		if (resolved === undefined) return false;
		if (handed !== undefined && resolved.wait !== undefined) handed(waitResult(resolved.wait));
		const run = await store.run(runId);
		if (run !== undefined) {
			await emit(
				{ actor: by, organisationId: run.organisationId, projectId: run.projectId },
				"programs.wait.resolved",
				{ id: run.programId, projectId: run.projectId },
				{
					runId,
					waitId,
					kind: resolved.kind,
					ok: outcome.error === undefined,
				},
				{ sessionId: run.sessionId },
			);
		}
		await continueIfResolved(runId);
		return true;
	};

	/** The value an agent step's session answered with: its answer, parsed and checked when the step gave a schema. */
	const agentOutcome = (result: RunResult, wait: ProgramWaitRecord): { value?: JsonValue; error?: string } => {
		if (result.status !== "answered") {
			return {
				error:
					result.status === "aborted"
						? "The agent step's session was stopped before it answered"
						: `The agent step failed: ${result.error ?? "its run ended without an answer"}`,
			};
		}
		const answer = result.answer ?? "";
		if (wait.schema === undefined) return { value: answer };
		const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(answer);
		let value: JsonValue;
		try {
			value = JSON.parse((fenced?.[1] ?? answer).trim()) as JsonValue;
		} catch {
			return { error: `The agent's answer is not JSON: ${cut(answer, 200)}` };
		}
		const problem = schemaProblems(wait.schema, value);
		return problem === undefined ? { value } : { error: `The agent's answer does not match the schema: ${problem}` };
	};

	/**
	 * Starts an agent step's session if it hasn't one (a session as the run's caller, of the step's profile, not a child
	 * of the run's, so pausing the run doesn't stop it), then watches it: its answer resolves the step. Each part is kept
	 * before the next, so a restart picks up where it was (`recover`); one session and one prompt per step.
	 */
	const watchAgent = async (run: ProgramRunRecord, given: ProgramStepRecord, title?: string): Promise<void> => {
		const waitId = given.wait?.id;
		if (waitId === undefined || watching.has(waitId)) return;
		watching.add(waitId);
		try {
			const caller = callerOf(run);
			const runtime = options.runtime();
			const update = (change: (wait: ProgramWaitRecord) => ProgramWaitRecord) =>
				locked(run.id, async () => {
					const step = await store.stepByWait(waitId);
					if (step?.wait === undefined) throw new KantelError("not_found", "The agent step is gone");
					const next = { ...step, wait: change(step.wait) };
					await store.putStep(next);
					return next;
				});
			let step = (await store.stepByWait(waitId)) ?? given;
			if (step.status !== "waiting" || step.wait === undefined) return;
			const wait = step.wait;
			if (wait.sessionId === undefined) {
				const child = await runtime.create(caller, {
					projectId: run.projectId,
					agentId: wait.agentId ?? defaultAgentId,
					title: cut((title ?? wait.key ?? wait.prompt.split("\n")[0] ?? "Agent step").trim(), 80),
					labels: { programId: run.programId, programRun: run.id, programWait: waitId },
				});
				step = await update((current) => ({ ...current, sessionId: child.id }));
			}
			const sessionId = step.wait?.sessionId as string;
			if (step.wait?.submissionId === undefined) {
				const submitted = await runtime.prompt(caller, sessionId, {
					text: wait.prompt,
					requestId: `program-wait:${waitId}`,
				});
				step = await update((current) => ({ ...current, submissionId: submitted.id }));
			}
			const result = await runtime.wait(caller, sessionId, step.wait?.submissionId as string);
			const outcome = agentOutcome(result, step.wait as ProgramWaitRecord);
			await resolveStep(run.id, waitId, outcome, {
				kind: "agent",
				agentId: step.wait?.agentId ?? defaultAgentId,
				sessionId,
			} as ProgramRunRecord["startedBy"]);
		} catch (error) {
			// The object closing (an eviction or a deploy) is no answer: the step stays waiting, and the next instance picks
			// it up (`recover`). Only a refusal, such as no such profile, fails it.
			if (!isKantelError(error)) {
				console.warn(`harbour: program run ${run.id}'s agent step ${waitId} is left waiting`, error);
				return;
			}
			console.error(`harbour: program run ${run.id}'s agent step ${waitId} failed`, error);
			await resolveStep(
				run.id,
				waitId,
				{ error: `The agent step failed: ${error instanceof Error ? error.message : String(error)}` },
				run.startedBy,
			).catch(() => undefined);
		} finally {
			watching.delete(waitId);
		}
	};

	/** Stops the sessions of a run's agent steps still waiting: the run ended without them. */
	const stopAgentSteps = async (runId: string): Promise<void> => {
		const run = await store.run(runId);
		if (run === undefined) return;
		for (const step of await store.steps(runId)) {
			const sessionId = step.wait?.sessionId;
			if (step.kind !== "agent" || step.status !== "waiting" || sessionId === undefined) continue;
			await options
				.runtime()
				.abort(callerOf(run), sessionId, "The program run ended")
				.catch(() => undefined);
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
			const draft: ProgramRunRecord = {
				id: runId,
				organisationId: program.organisationId,
				projectId: program.projectId,
				programId: program.id,
				version: version.version,
				status: "running",
				input: value,
				sessionId: session.id,
				submissionId: "",
				...(waitsOn ? { activation: 1 } : {}),
				startedAt: now(),
				startedBy: ctx.actor,
				...(idempotencyKey === undefined ? {} : { idempotencyKey }),
			};
			// With waits, the run is kept before its script starts: its journal and waits belong to it.
			if (waitsOn) await store.putRun(draft);
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
					...(waitsOn ? { activation: 1, waits: true } : {}),
				}),
				requestId: `program-run:${runId}`,
			});
			// A script that paused already has the run as `waiting`: keep that, with the submission.
			const run: ProgramRunRecord = waitsOn
				? await locked(runId, async () => {
						const kept = { ...((await store.run(runId)) ?? draft), submissionId: submission.id };
						await store.putRun(kept);
						return kept;
					})
				: { ...draft, submissionId: submission.id };
			if (!waitsOn) await store.putRun(run);
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
			return Promise.all(
				runs.map(async (run) => {
					const now_ = await settle(ctx, run, 0);
					return runView(now_, await waitingOf(ctx, now_));
				}),
			);
		},
		async getRun(ctx, programId, runId) {
			const run = await settle(ctx, await runFor(ctx, programId, runId, "viewer", "programs.runs.get"), 50);
			return runView(run, await waitingOf(ctx, run));
		},
		async cancel(ctx, programId, runId) {
			const run = await runFor(ctx, programId, runId, "operator", "programs.runs.cancel");
			if (run.status === "waiting") {
				// No turn is running: the run ends here, with the agent steps it waited on.
				const ended = await locked(run.id, async () => {
					const latest = (await store.run(run.id)) ?? run;
					if (latest.status !== "waiting") return latest;
					const cancelled: ProgramRunRecord = {
						...latest,
						status: "cancelled",
						error: "The program run was cancelled while it waited",
						endedAt: now(),
					};
					await store.putRun(cancelled);
					return cancelled;
				});
				if (ended.status === "cancelled") {
					await emit(
						ctx,
						"programs.run.ended",
						{ id: run.programId, projectId: run.projectId },
						{ runId: run.id, version: run.version, status: "cancelled", durationMs: now() - run.startedAt },
						{ sessionId: run.sessionId, id: `programs:run:${run.id}:ended` },
					);
					await stopAgentSteps(run.id);
				}
				return runView(ended);
			}
			if (run.status !== "running") return runView(run);
			await options.runtime().abort(ctx, run.sessionId, "The program run was cancelled");
			return runView(await settle(ctx, run, 5_000));
		},
		async resume(ctx, programId, runId, input) {
			if (!waitsOn) throw new KantelError("not_found", "Program runs don't pause here (KANTEL_PROGRAM_WAITS)");
			const run = await runFor(ctx, programId, runId, "operator", "programs.runs.resume");
			if (run.status !== "waiting" && run.status !== "running") {
				throw new KantelError("conflict", `The run has ${run.status}; it waits on nothing`);
			}
			const open = (await store.steps(run.id)).filter((step) => step.status === "waiting" && step.wait !== undefined);
			const step =
				input.waitId === undefined
					? open.length === 1
						? open[0]
						: undefined
					: open.find((candidate) => candidate.wait?.id === input.waitId);
			if (step?.wait === undefined && input.waitId !== undefined) {
				const named = await store.stepByWait(input.waitId);
				if (named?.runId === run.id && named.status === "resolved") {
					throw new KantelError("conflict", "The step already has its value");
				}
			}
			if (step?.wait === undefined) {
				throw input.waitId === undefined && open.length > 1
					? new KantelError("invalid", `The run waits on ${open.length} steps; name one with waitId`)
					: new KantelError("not_found", "The run doesn't wait on that");
			}
			if (step.kind !== "input") {
				throw new KantelError("invalid", "An agent step resolves when its session answers; prompt that session");
			}
			if (input.error === undefined && step.wait.schema !== undefined) {
				const problem = schemaProblems(step.wait.schema, input.value ?? null);
				if (problem !== undefined) {
					throw new KantelError("invalid", `The value does not match the step's schema: ${problem}`);
				}
			}
			const done = await resolveStep(
				run.id,
				step.wait.id,
				input.error === undefined ? { value: input.value ?? null } : { error: input.error },
				ctx.actor,
			);
			if (!done) throw new KantelError("conflict", "The step already has its value");
			const latest = (await store.run(run.id)) ?? run;
			const settled = await settle(ctx, latest, Math.max(0, input.waitMs ?? 0));
			return runView(settled, await waitingOf(ctx, settled));
		},
		async steps(ctx, programId, runId) {
			const run = await runFor(ctx, programId, runId, "viewer", "programs.runs.steps");
			return (await store.steps(run.id)).map(stepView);
		},
		waits: waitsOn,
		codemodeFor(tool, record) {
			const runId = record.labels.programRun;
			return waitsOn && runId !== undefined ? journaledCodemodeTool(tool, steps, runId) : tool;
		},
		async recover() {
			if (!waitsOn) return;
			const open = await store.openSteps();
			for (const step of open) {
				if (step.status !== "waiting") continue;
				const run = await store.run(step.runId);
				if (run === undefined) continue;
				if (run.status === "running" && (run.activation ?? 1) === step.activation) {
					// It stopped between keeping the wait and pausing: pause it now (its code mode, resumed, waits again).
					pause(run.id, run.activation ?? 1);
				}
				if ((run.status === "waiting" || run.status === "running") && step.kind === "agent") {
					void watchAgent(run, step);
				}
			}
			// A run that stopped between a value and its next activation.
			for (const runId of new Set(open.map((step) => step.runId))) await continueIfResolved(runId);
		},
	};
}
