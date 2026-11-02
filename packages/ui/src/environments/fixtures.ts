// Fixtures for the Environments page: a project's environments in each state (a running one two sessions hold, an idle
// one counting down, a stopped one, one whose start failed), and an in-memory source that starts and stops them the way
// `/v1/environments` does, with a short wait on each call and on each move between states. Stories and the console's
// recorded mode use them; no machine here is real.

import {
	type Actor,
	ENVIRONMENT_SIZES,
	type Environment,
	type EnvironmentDetail,
	type EnvironmentEvent,
	type EnvironmentGrant,
	type EnvironmentLease,
	environmentUp,
} from "@kantel/contracts";
import type { EnvironmentLinks, EnvironmentsDirectory, EnvironmentsSource } from "./environments-model.ts";

export const FIXTURE_NOW = Date.UTC(2026, 10, 2, 15, 30);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ORGANISATION_ID = "org_acme";
export const PROJECTS = [
	{ id: "proj_lleverage", name: "Lleverage" },
	{ id: "proj_kantel", name: "Kantel" },
] as const;
const PEOPLE: Readonly<Record<string, string>> = { usr_tom: "Tom", usr_bethan: "Bethan" };
const TOM: Actor = { kind: "human", userId: "usr_tom" };
const BETHAN: Actor = { kind: "human", userId: "usr_bethan" };

/** The sessions the fixtures' leases and grants name, by title. */
export const SESSIONS: Readonly<Record<string, string>> = {
	ses_flaky: "Fix the flaky workflow-engine test",
	ses_tables: "Data tables: add the CSV export",
	ses_review: "Review Bethan's knowledge-service PR",
	ses_render: "Render the warehouse walkthrough",
};

export const directory: EnvironmentsDirectory = {
	project: (id) => PROJECTS.find((project) => project.id === id)?.name,
	person: (id) => PEOPLE[id],
	session: (id) => SESSIONS[id],
};

export const links: EnvironmentLinks = { session: (id) => `#/sessions/${id}` };

const base = {
	organisationId: ORGANISATION_ID,
	provider: "boat" as const,
	egress: "unmanaged" as const,
	placeholders: true,
	idleTimeoutMs: 15 * MINUTE,
};

export const DEV_ENV: Environment = {
	...base,
	id: "env_01lleverage",
	owner: { projectId: "proj_lleverage", userId: "usr_tom" },
	name: "lleverage-dev",
	alias: "dev",
	description: "The Lleverage dev stack with its Docker dependencies",
	size: ENVIRONMENT_SIZES.large,
	definition: {
		version: 3,
		template: "lleverage-dev-v3",
		repository: "lleverage-ai/lleverage",
		composeFile: "docker-compose.dev.yml",
		readiness: "docker compose ls",
	},
	sharing: "shared",
	state: "running",
	createdAt: FIXTURE_NOW - 6 * DAY,
	createdBy: TOM,
	updatedAt: FIXTURE_NOW - 40 * MINUTE,
	lastStartedAt: FIXTURE_NOW - 40 * MINUTE,
	lastStoppedAt: FIXTURE_NOW - 3 * HOUR,
	leaseCount: 2,
	resume: { lastMs: 3_140, p50Ms: 3_420, samples: 12 },
	runningMsThisMonth: 3.6 * HOUR,
};

export const SCRATCH_ENV: Environment = {
	...base,
	id: "env_02scratch",
	owner: { projectId: "proj_kantel", userId: "usr_tom" },
	name: "kantel-scratch",
	alias: "scratch",
	description: "A spare machine for trying things",
	size: ENVIRONMENT_SIZES.default,
	definition: { version: 1 },
	sharing: "shared",
	state: "idle",
	createdAt: FIXTURE_NOW - 2 * DAY,
	createdBy: TOM,
	updatedAt: FIXTURE_NOW - 6 * MINUTE,
	lastStartedAt: FIXTURE_NOW - 50 * MINUTE,
	idleStopAt: FIXTURE_NOW + 9 * MINUTE,
	leaseCount: 0,
	resume: { lastMs: 2_870, p50Ms: 2_870, samples: 1 },
	runningMsThisMonth: 50 * MINUTE,
};

export const RENDER_ENV: Environment = {
	...base,
	id: "env_03render",
	owner: { projectId: "proj_lleverage", userId: "usr_bethan" },
	name: "warehouse-render",
	alias: "render",
	description: "CPU renders of the warehouse scenes",
	size: ENVIRONMENT_SIZES.xlarge,
	definition: { version: 1, template: "blender-4-3" },
	sharing: "exclusive",
	state: "stopped",
	createdAt: FIXTURE_NOW - 9 * DAY,
	createdBy: BETHAN,
	updatedAt: FIXTURE_NOW - 26 * HOUR,
	lastStartedAt: FIXTURE_NOW - 28 * HOUR,
	lastStoppedAt: FIXTURE_NOW - 26 * HOUR,
	leaseCount: 0,
	resume: { lastMs: 4_910, p50Ms: 4_400, samples: 5 },
	runningMsThisMonth: 2 * HOUR,
};

export const FAILED_ENV: Environment = {
	...base,
	id: "env_04failed",
	owner: { projectId: "proj_kantel" },
	name: "kantel-ci",
	alias: "ci",
	description: "Shared runner for the project's integration tests",
	size: ENVIRONMENT_SIZES.default,
	definition: { version: 2, template: "kantel-ci" },
	sharing: "shared",
	state: "error",
	error: "boat refused the start: 12 starts a minute is the limit. Start it again in a minute.",
	createdAt: FIXTURE_NOW - 4 * DAY,
	createdBy: TOM,
	updatedAt: FIXTURE_NOW - 12 * MINUTE,
	lastStoppedAt: FIXTURE_NOW - 5 * HOUR,
	leaseCount: 0,
	runningMsThisMonth: 0,
};

export const ENVIRONMENTS: readonly Environment[] = [DEV_ENV, SCRATCH_ENV, RENDER_ENV, FAILED_ENV];

const grant = (id: string, environmentId: string, sessionId: string, alias: string, at: number): EnvironmentGrant => ({
	id,
	organisationId: ORGANISATION_ID,
	environmentId,
	sessionId,
	alias,
	rights: "worktree",
	grantedBy: { kind: "system", component: "environments.default" },
	createdAt: at,
	status: "active",
});

const lease = (
	id: string,
	environmentId: string,
	sessionId: string,
	grantId: string,
	slot: number,
	acquiredAt: number,
	commands: number,
): EnvironmentLease => ({
	id,
	environmentId,
	sessionId,
	grantId,
	worktree: `/home/user/kantel/worktrees/${sessionId}`,
	composeProject: `kt_${sessionId.replace(/^ses_/, "")}`,
	portBase: 20_000 + slot * 10,
	acquiredAt,
	renewedAt: FIXTURE_NOW - 30 * SECOND,
	expiresAt: FIXTURE_NOW + 9 * MINUTE,
	commands,
});

const DETAILS: Readonly<Record<string, Omit<EnvironmentDetail, "environment">>> = {
	[DEV_ENV.id]: {
		grants: [
			grant("eng_flaky", DEV_ENV.id, "ses_flaky", "dev", FIXTURE_NOW - 45 * MINUTE),
			grant("eng_tables", DEV_ENV.id, "ses_tables", "dev", FIXTURE_NOW - 20 * MINUTE),
			grant("eng_review", DEV_ENV.id, "ses_review", "dev", FIXTURE_NOW - 3 * HOUR - 30 * MINUTE),
		],
		leases: [
			lease("enl_flaky", DEV_ENV.id, "ses_flaky", "eng_flaky", 0, FIXTURE_NOW - 40 * MINUTE, 37),
			lease("enl_tables", DEV_ENV.id, "ses_tables", "eng_tables", 1, FIXTURE_NOW - 18 * MINUTE, 9),
		],
		events: [
			{ at: FIXTURE_NOW - 18 * MINUTE, kind: "lease.acquired", sessionId: "ses_tables" },
			{ at: FIXTURE_NOW - 20 * MINUTE, kind: "granted", sessionId: "ses_tables" },
			{ at: FIXTURE_NOW - 40 * MINUTE, kind: "lease.acquired", sessionId: "ses_flaky" },
			{ at: FIXTURE_NOW - 40 * MINUTE, kind: "started", durationMs: 3_140 },
			{ at: FIXTURE_NOW - 40 * MINUTE - 3 * SECOND, kind: "starting", sessionId: "ses_flaky" },
			{ at: FIXTURE_NOW - 3 * HOUR, kind: "stopped", reason: "idle" },
			{ at: FIXTURE_NOW - 3 * HOUR - 15 * MINUTE, kind: "lease.ended", sessionId: "ses_review" },
		],
	},
	[SCRATCH_ENV.id]: {
		grants: [],
		leases: [],
		events: [
			{ at: FIXTURE_NOW - 6 * MINUTE, kind: "lease.ended", sessionId: "ses_flaky" },
			{ at: FIXTURE_NOW - 50 * MINUTE, kind: "started", durationMs: 2_870 },
			{ at: FIXTURE_NOW - 2 * DAY, kind: "created", actor: TOM },
		],
	},
	[RENDER_ENV.id]: {
		grants: [grant("eng_render", RENDER_ENV.id, "ses_render", "render", FIXTURE_NOW - 28 * HOUR)],
		leases: [],
		events: [
			{ at: FIXTURE_NOW - 26 * HOUR, kind: "stopped", reason: "idle" },
			{ at: FIXTURE_NOW - 26 * HOUR - 15 * MINUTE, kind: "lease.ended", sessionId: "ses_render" },
			{ at: FIXTURE_NOW - 28 * HOUR, kind: "started", durationMs: 4_910 },
		],
	},
	[FAILED_ENV.id]: {
		grants: [],
		leases: [],
		events: [
			{
				at: FIXTURE_NOW - 12 * MINUTE,
				kind: "failed",
				message: "boat refused the start (rate_limited, minute)",
			},
			{ at: FIXTURE_NOW - 12 * MINUTE - 2 * SECOND, kind: "starting", actor: TOM },
		],
	},
};

export interface EnvironmentsScenarioOptions {
	readonly environments?: readonly Environment[];
	/** Every read waits forever: the loading state. */
	readonly hang?: boolean;
	/** Every read fails. */
	readonly fail?: boolean;
	/** Milliseconds each call waits. Default 250. */
	readonly delayMs?: number;
	/** Milliseconds a start or stop takes to settle. Default 2500. */
	readonly settleMs?: number;
	/** The clock the source stamps changes with; default the fixtures' fixed now. */
	readonly now?: () => number;
}

/** An in-memory source over the fixtures: start and stop move an environment through its states. */
export function createEnvironmentsScenario(options: EnvironmentsScenarioOptions = {}): EnvironmentsSource {
	const delayMs = options.delayMs ?? 250;
	const settleMs = options.settleMs ?? 2500;
	const now = options.now ?? (() => FIXTURE_NOW);
	const records = new Map<string, Environment>((options.environments ?? ENVIRONMENTS).map((env) => [env.id, env]));
	const details = new Map<string, Omit<EnvironmentDetail, "environment">>(
		[...records.keys()].map((id) => [id, DETAILS[id] ?? { grants: [], leases: [], events: [] }]),
	);
	const wait = async () => {
		if (options.hang) await new Promise(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		if (options.fail) throw new Error("Kantel couldn't be reached");
	};
	const find = (id: string): Environment => {
		const found = records.get(id);
		if (found === undefined) throw new Error("No such environment");
		return found;
	};
	const record = (id: string, change: Partial<Environment>, event?: EnvironmentEvent) => {
		const next = { ...find(id), ...change, updatedAt: now() };
		records.set(id, next);
		if (event !== undefined) {
			const detail = details.get(id) ?? { grants: [], leases: [], events: [] };
			details.set(id, { ...detail, events: [event, ...detail.events] });
		}
		return next;
	};

	return {
		async list(filter) {
			await wait();
			return [...records.values()]
				.filter((env) => filter?.projectId === undefined || env.owner.projectId === filter.projectId)
				.sort((a, b) => (a.name < b.name ? -1 : 1));
		},
		async get(id) {
			await wait();
			const environment = find(id);
			const detail = details.get(id) ?? { grants: [], leases: [], events: [] };
			return { environment, ...detail };
		},
		async start(id) {
			await wait();
			const env = find(id);
			if (environmentUp(env.state) || env.state === "starting") return env;
			const startedAt = now();
			const started = record(
				id,
				{ state: "starting", error: undefined },
				{ at: startedAt, kind: "starting", actor: TOM },
			);
			setTimeout(() => {
				const tookMs = 2_600 + Math.round(Math.random() * 900);
				const previous = find(id).resume;
				const samples = (previous?.samples ?? 0) + 1;
				record(
					id,
					{
						state: "idle",
						lastStartedAt: now(),
						idleStopAt: now() + env.idleTimeoutMs,
						resume: { lastMs: tookMs, p50Ms: previous?.p50Ms ?? tookMs, samples },
					},
					{ at: now(), kind: "started", durationMs: tookMs },
				);
			}, settleMs);
			return started;
		},
		async stop(id) {
			await wait();
			const env = find(id);
			if (!environmentUp(env.state)) return env;
			const detail = details.get(id);
			if (detail !== undefined)
				details.set(id, {
					...detail,
					leases: detail.leases.map((held) =>
						held.endedAt === undefined ? { ...held, endedAt: now(), endReason: "stopped" as const } : held,
					),
				});
			const stopping = record(
				id,
				{ state: "stopping", leaseCount: 0, idleStopAt: undefined },
				{ at: now(), kind: "stopping", actor: TOM },
			);
			setTimeout(() => {
				record(id, { state: "stopped", lastStoppedAt: now() }, { at: now(), kind: "stopped", actor: TOM });
			}, settleMs);
			return stopping;
		},
	};
}
