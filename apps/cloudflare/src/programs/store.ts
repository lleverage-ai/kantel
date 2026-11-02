/**
 * Where programs, their versions and their runs are kept: in memory for tests, and in SQL (the stack's D1) deployed.
 * Each record is one JSON column; the other columns are only for finding it.
 */
import type { Actor, JsonValue } from "@kantel/contracts";
import { type SqlDriver, sql } from "@kantel/sql";

export interface ProgramRecord {
	readonly id: string;
	readonly organisationId: string;
	readonly projectId: string;
	readonly name: string;
	readonly description?: string;
	/** The versions not deleted, oldest first. */
	readonly versions: readonly number[];
	/** The number the next version gets: numbers are never reused, even after a delete. */
	readonly nextVersion: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly createdBy: Actor;
}

export interface ProgramVersionRecord {
	readonly programId: string;
	readonly version: number;
	readonly code: string;
	readonly description?: string;
	readonly inputSchema?: { readonly [key: string]: JsonValue };
	readonly outputSchema?: { readonly [key: string]: JsonValue };
	readonly tools: readonly string[];
	readonly timeoutMs: number;
	readonly maxOutputTokens: number;
	readonly createdAt: number;
	readonly createdBy: Actor;
	readonly sessionId?: string;
}

/** `waiting`: paused on a wait (`ProgramStepRecord.wait`), with no session run going until it is resumed. */
export type ProgramRunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface ProgramRunRecord {
	readonly id: string;
	readonly organisationId: string;
	readonly projectId: string;
	readonly programId: string;
	readonly version: number;
	readonly status: ProgramRunStatus;
	readonly input: JsonValue;
	readonly output?: JsonValue;
	readonly logs?: readonly string[];
	readonly error?: string;
	readonly sessionId: string;
	/** The submission of the run's current activation. */
	readonly submissionId: string;
	/**
	 * Which run of the script this is (`KANTEL_PROGRAM_WAITS`): 1 at first, one more each time a paused run resumes.
	 * Each activation runs the script from the top; calls an earlier one finished come from the run's journal.
	 */
	readonly activation?: number;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly startedBy: Actor;
	/** The `Idempotency-Key` the run was started with, so a retry gets the same run. */
	readonly idempotencyKey?: string;
}

/** What a paused step waits on: a person's input, or an agent session's answer. */
export interface ProgramWaitRecord {
	/** The wait's ID, which `resume` names. */
	readonly id: string;
	readonly kind: "input" | "agent";
	/** The name the program gave the step (`key`), if any. */
	readonly key?: string;
	readonly prompt: string;
	/** The JSON Schema the input, or the agent's answer, must match. */
	readonly schema?: { readonly [key: string]: JsonValue };
	readonly since: number;
	/** An agent step: the profile, and the session it runs in once started. */
	readonly agentId?: string;
	readonly sessionId?: string;
	readonly submissionId?: string;
	/** Once resolved: the value the step returns, or the error it throws. */
	readonly value?: JsonValue;
	readonly error?: string;
	readonly resolvedAt?: number;
	readonly resolvedBy?: Actor;
}

/**
 * One step of a run's journal (`KANTEL_PROGRAM_WAITS`): a tool call the program made, or a wait. A step is the
 * `occurrence`th call of `tool` with arguments whose digest is `fingerprint`; a later activation that makes the same
 * call gets the step's result back instead of making it again.
 */
export interface ProgramStepRecord {
	readonly runId: string;
	readonly tool: string;
	readonly fingerprint: string;
	readonly occurrence: number;
	readonly kind: "call" | "input" | "agent";
	/** `done`: a call's result is kept; `waiting`: a wait not resolved yet; `resolved`: a wait with its value. */
	readonly status: "done" | "waiting" | "resolved";
	/** The activation that made it, and the latest that took it, under code mode's key for the call (`c<N>`). */
	readonly firstActivation: number;
	readonly activation: number;
	readonly callKey: string;
	/** The arguments, cut short, for reading the journal. */
	readonly argsPreview: string;
	/** A call's result as code mode got it; absent when it was too large to keep (the call then runs again). */
	readonly result?: JsonValue;
	readonly executedAt: number;
	readonly durationMs?: number;
	/** How many later activations took the step from the journal instead of running it. */
	readonly replays: number;
	readonly wait?: ProgramWaitRecord;
	/** A resolved wait whose value an activation has taken, or that one started after it was resolved. */
	readonly consumed?: boolean;
}

export interface ProgramStore {
	program(id: string): Promise<ProgramRecord | undefined>;
	programByName(organisationId: string, projectId: string, name: string): Promise<ProgramRecord | undefined>;
	programs(organisationId: string): Promise<ProgramRecord[]>;
	putProgram(program: ProgramRecord): Promise<void>;
	/** Removes the program and its versions; its runs stay, for their sessions. */
	removeProgram(id: string): Promise<void>;
	version(programId: string, version: number): Promise<ProgramVersionRecord | undefined>;
	versions(programId: string): Promise<ProgramVersionRecord[]>;
	/** Rejects when the version exists. */
	addVersion(version: ProgramVersionRecord): Promise<void>;
	removeVersion(programId: string, version: number): Promise<void>;
	run(id: string): Promise<ProgramRunRecord | undefined>;
	runByKey(programId: string, idempotencyKey: string): Promise<ProgramRunRecord | undefined>;
	/** Newest first. */
	runs(programId: string, limit: number): Promise<ProgramRunRecord[]>;
	putRun(run: ProgramRunRecord): Promise<void>;
	/** The run's journal, in the order its steps were made. */
	steps(runId: string): Promise<ProgramStepRecord[]>;
	putStep(step: ProgramStepRecord): Promise<void>;
	/** The step whose wait has this ID. */
	stepByWait(waitId: string): Promise<ProgramStepRecord | undefined>;
	/**
	 * Steps still open, across runs: waiting, or resolved with no activation having taken the value. For picking up
	 * agent steps and resumes after the object restarts.
	 */
	openSteps(): Promise<ProgramStepRecord[]>;
}

const stepKey = (step: Pick<ProgramStepRecord, "runId" | "tool" | "fingerprint" | "occurrence">) =>
	`${step.runId}#${step.tool}#${step.fingerprint}#${step.occurrence}`;

const isOpen = (step: ProgramStepRecord) =>
	step.status === "waiting" || (step.status === "resolved" && step.consumed !== true);

const stepOrder = (a: ProgramStepRecord, b: ProgramStepRecord) =>
	a.executedAt - b.executedAt || a.callKey.localeCompare(b.callKey);

export function createMemoryProgramStore(): ProgramStore {
	const programs = new Map<string, ProgramRecord>();
	const versions = new Map<string, ProgramVersionRecord>();
	const runs = new Map<string, ProgramRunRecord>();
	const steps = new Map<string, ProgramStepRecord>();
	const versionKey = (programId: string, version: number) => `${programId}#${version}`;
	return {
		async program(id) {
			return programs.get(id);
		},
		async programByName(organisationId, projectId, name) {
			return [...programs.values()].find(
				(program) =>
					program.organisationId === organisationId && program.projectId === projectId && program.name === name,
			);
		},
		async programs(organisationId) {
			return [...programs.values()]
				.filter((program) => program.organisationId === organisationId)
				.sort((a, b) => a.name.localeCompare(b.name));
		},
		async putProgram(program) {
			programs.set(program.id, program);
		},
		async removeProgram(id) {
			programs.delete(id);
			for (const key of [...versions.keys()]) if (key.startsWith(`${id}#`)) versions.delete(key);
		},
		async version(programId, version) {
			return versions.get(versionKey(programId, version));
		},
		async versions(programId) {
			return [...versions.values()]
				.filter((version) => version.programId === programId)
				.sort((a, b) => a.version - b.version);
		},
		async addVersion(version) {
			const key = versionKey(version.programId, version.version);
			if (versions.has(key)) throw new Error(`version ${version.version} exists`);
			versions.set(key, version);
		},
		async removeVersion(programId, version) {
			versions.delete(versionKey(programId, version));
		},
		async run(id) {
			return runs.get(id);
		},
		async runByKey(programId, idempotencyKey) {
			return [...runs.values()].find((run) => run.programId === programId && run.idempotencyKey === idempotencyKey);
		},
		async runs(programId, limit) {
			return [...runs.values()]
				.filter((run) => run.programId === programId)
				.sort((a, b) => b.startedAt - a.startedAt)
				.slice(0, limit);
		},
		async putRun(run) {
			runs.set(run.id, run);
		},
		async steps(runId) {
			return [...steps.values()].filter((step) => step.runId === runId).sort(stepOrder);
		},
		async putStep(step) {
			steps.set(stepKey(step), step);
		},
		async stepByWait(waitId) {
			return [...steps.values()].find((step) => step.wait?.id === waitId);
		},
		async openSteps() {
			return [...steps.values()].filter(isOpen);
		},
	};
}

/** The programs' tables, for SQLite and Postgres alike. */
export function programsSchema(dialect: SqlDriver["dialect"]): string[] {
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS programs (
			id TEXT PRIMARY KEY,
			organisation_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			name TEXT NOT NULL,
			data TEXT NOT NULL,
			UNIQUE (organisation_id, project_id, name)
		)`,
		`CREATE TABLE IF NOT EXISTS program_versions (
			program_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			data TEXT NOT NULL,
			PRIMARY KEY (program_id, version)
		)`,
		`CREATE TABLE IF NOT EXISTS program_runs (
			id TEXT PRIMARY KEY,
			program_id TEXT NOT NULL,
			idempotency_key TEXT,
			started_at ${time} NOT NULL,
			data TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS program_runs_program ON program_runs (program_id, started_at)",
		`CREATE TABLE IF NOT EXISTS program_steps (
			run_id TEXT NOT NULL,
			tool TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			occurrence INTEGER NOT NULL,
			status TEXT NOT NULL,
			wait_id TEXT,
			executed_at ${time} NOT NULL,
			data TEXT NOT NULL,
			PRIMARY KEY (run_id, tool, fingerprint, occurrence)
		)`,
		"CREATE INDEX IF NOT EXISTS program_steps_wait ON program_steps (wait_id)",
		"CREATE INDEX IF NOT EXISTS program_steps_status ON program_steps (status)",
	];
}

export async function migratePrograms(driver: SqlDriver): Promise<void> {
	await driver.batch(programsSchema(driver.dialect).map((text) => ({ sql: text })));
}

const parsed = <T>(row: Record<string, unknown> | undefined): T | undefined =>
	row === undefined ? undefined : (JSON.parse(String(row.data)) as T);

/** Records in SQL. Run `migratePrograms` first. */
export function createSqlProgramStore(driver: SqlDriver): ProgramStore {
	return {
		async program(id) {
			return parsed((await driver.query("SELECT data FROM programs WHERE id = ?", [id]))[0]);
		},
		async programByName(organisationId, projectId, name) {
			const rows = await driver.query(
				"SELECT data FROM programs WHERE organisation_id = ? AND project_id = ? AND name = ?",
				[organisationId, projectId, name],
			);
			return parsed(rows[0]);
		},
		async programs(organisationId) {
			const rows = await driver.query("SELECT data FROM programs WHERE organisation_id = ? ORDER BY name", [
				organisationId,
			]);
			return rows.map((row) => parsed<ProgramRecord>(row) as ProgramRecord);
		},
		async putProgram(program) {
			await driver.query(
				`INSERT INTO programs (id, organisation_id, project_id, name, data) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET name = excluded.name, data = excluded.data`,
				[program.id, program.organisationId, program.projectId, program.name, JSON.stringify(program)],
			);
		},
		async removeProgram(id) {
			await driver.batch([
				sql("DELETE FROM program_versions WHERE program_id = ?", id),
				sql("DELETE FROM programs WHERE id = ?", id),
			]);
		},
		async version(programId, version) {
			const rows = await driver.query("SELECT data FROM program_versions WHERE program_id = ? AND version = ?", [
				programId,
				version,
			]);
			return parsed(rows[0]);
		},
		async versions(programId) {
			const rows = await driver.query("SELECT data FROM program_versions WHERE program_id = ? ORDER BY version", [
				programId,
			]);
			return rows.map((row) => parsed<ProgramVersionRecord>(row) as ProgramVersionRecord);
		},
		async addVersion(version) {
			await driver.query("INSERT INTO program_versions (program_id, version, data) VALUES (?, ?, ?)", [
				version.programId,
				version.version,
				JSON.stringify(version),
			]);
		},
		async removeVersion(programId, version) {
			await driver.query("DELETE FROM program_versions WHERE program_id = ? AND version = ?", [programId, version]);
		},
		async run(id) {
			return parsed((await driver.query("SELECT data FROM program_runs WHERE id = ?", [id]))[0]);
		},
		async runByKey(programId, idempotencyKey) {
			const rows = await driver.query("SELECT data FROM program_runs WHERE program_id = ? AND idempotency_key = ?", [
				programId,
				idempotencyKey,
			]);
			return parsed(rows[0]);
		},
		async runs(programId, limit) {
			const rows = await driver.query(
				"SELECT data FROM program_runs WHERE program_id = ? ORDER BY started_at DESC LIMIT ?",
				[programId, limit],
			);
			return rows.map((row) => parsed<ProgramRunRecord>(row) as ProgramRunRecord);
		},
		async putRun(run) {
			await driver.query(
				`INSERT INTO program_runs (id, program_id, idempotency_key, started_at, data) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
				[run.id, run.programId, run.idempotencyKey ?? null, run.startedAt, JSON.stringify(run)],
			);
		},
		async steps(runId) {
			const rows = await driver.query("SELECT data FROM program_steps WHERE run_id = ?", [runId]);
			return rows.map((row) => parsed<ProgramStepRecord>(row) as ProgramStepRecord).sort(stepOrder);
		},
		async putStep(step) {
			await driver.query(
				`INSERT INTO program_steps (run_id, tool, fingerprint, occurrence, status, wait_id, executed_at, data)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (run_id, tool, fingerprint, occurrence) DO UPDATE SET status = excluded.status, data = excluded.data`,
				[
					step.runId,
					step.tool,
					step.fingerprint,
					step.occurrence,
					step.status,
					step.wait?.id ?? null,
					step.executedAt,
					JSON.stringify(step),
				],
			);
		},
		async stepByWait(waitId) {
			return parsed((await driver.query("SELECT data FROM program_steps WHERE wait_id = ?", [waitId]))[0]);
		},
		async openSteps() {
			const rows = await driver.query(
				"SELECT data FROM program_steps WHERE status IN ('waiting', 'resolved') AND wait_id IS NOT NULL",
				[],
			);
			return rows.map((row) => parsed<ProgramStepRecord>(row) as ProgramStepRecord).filter(isOpen);
		},
	};
}
