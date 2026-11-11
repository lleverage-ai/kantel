/**
 * GitHub Actions runners (experimental, `KANTEL_GITHUB_RUNNERS`): the broker that answers a GitHub App's `workflow_job`
 * webhooks with ephemeral runners, as Blacksmith and Actions Runner Controller do.
 *
 * A queued job whose `runs-on` labels a pool matches is recorded as demand. Each pass makes runners until every queued
 * job of a pool (and, for a repository-scoped integration, of each repository) has one starting or waiting, up to the
 * pool's `maxRunners`: a microVM from the pool's template on the account's hosts, which, once running, is given a
 * just-in-time runner configuration and starts the runner. GitHub hands each runner one job with those labels, not
 * necessarily the one that called it up (any runner may take any matching job, as with ARC), so runners are counted
 * against the queue, never tied to a job until GitHub says which job one took (`in_progress`, by its name, which is its
 * sandbox's ID). The job's `completed` ends its runner.
 *
 * When no host has room (or the account is at its limit), the create is refused or the sandbox ends in `error` with that
 * placement reason: the runner is dropped, the job stays queued, and the pool waits (`CAPACITY_BACKOFF_MS`) or until one
 * of its runners goes before it tries again, one runner at a time. GitHub keeps a job queued for a day and sends its
 * webhook once, so this queue is what remembers that the job needs a runner.
 *
 * The rules that keep runners from leaking or doubling up:
 *
 * - One gateway at a time runs an integration's pass: it holds a lease on the integration record (`lease`), taken and
 *   renewed with a conditional update, and on one gateway passes run one after another. So two never count the same
 *   queue and both make its runners, nor register one sandbox twice.
 * - A runner's record goes only once its sandbox is confirmed gone and its runner on GitHub is confirmed gone or never
 *   made (`end`). A step that fails leaves the record `ending`, and the next pass tries again. A runner that GitHub may
 *   have registered without the broker learning its ID (`registering`, then a failure or a crash) is looked up by its
 *   name, which is its sandbox's ID.
 * - Ending a runner uses the integration's key whether or not it is still live (`cleanupPrincipalOf`): revoking the key
 *   stops new runners, never the deletion of the ones it made.
 * - A sandbox read that fails for any reason but its absence changes nothing: the runner is looked at again next pass.
 * - A job's record moves only forward (queued, in progress, completed), whichever order its webhooks arrive in.
 * - A deleted integration is kept, `retiringAt`, until its runners have ended, and hidden meanwhile.
 *
 * Runners act through an API key the integration makes for itself: its sandboxes are that key's, and every limit and
 * check a create has applies to them.
 */
import type { computeSchema } from "@kantel/api";
import { isKantelError, placementReasonOf } from "@kantel/contracts";
import type { KeyPrincipal } from "./auth.ts";
import { type GithubApp, type RunnerScope, verifyGithubSignature } from "./github-app.ts";
import { type SealedValue, type Sealer, sealedAt } from "./secrets.ts";
import type { Collection, ComputeStore } from "./store.ts";
import { bytesToBase64, randomId } from "./util.ts";

/** The sandbox label that marks a runner, with its integration's ID as the value. */
export const RUNNER_LABEL = "kantel.dev/github-runners";
/** The sandbox label with the pool's label. */
export const RUNNER_POOL_LABEL = "kantel.dev/github-runner-pool";
export const DEFAULT_MAX_RUNNERS = 20;
export const DEFAULT_TIMEOUT_MINUTES = 360;
export const DEFAULT_RUNNER_COMMAND =
	'runuser -u runner -- /home/runner/actions-runner/run.sh --jitconfig "$KANTEL_RUNNER_JITCONFIG"';
/** How long a pool waits after a create found no room before it tries again, unless one of its runners goes first. */
export const CAPACITY_BACKOFF_MS = 20_000;
/** How long a runner may take from its create to running before it is given up on. */
export const BOOT_TIMEOUT_MS = 15 * 60_000;
/** How long a registration may stay unfinished before the runner is ended (its gateway died part-way). */
export const REGISTER_TIMEOUT_MS = 2 * 60_000;
/** How long a runner waits for a job it was made for before, with nothing queued that it could take, it is removed. */
export const IDLE_GRACE_MS = 2 * 60_000;
/** How often a busy runner's job is asked of GitHub, for a `completed` webhook that never came. */
export const JOB_CHECK_EVERY_MS = 5 * 60_000;
/** How long a queued job is kept waiting: GitHub cancels one that waits a day. */
export const QUEUED_JOB_TTL_MS = 24 * 3_600_000;
/** How long an ended job's record is kept, for the list. */
export const ENDED_JOB_TTL_MS = 3 * 24 * 3_600_000;
/**
 * How long taking an unused runner off GitHub is tried for before it is left to GitHub, which removes a just-in-time
 * runner that never ran a job, and an ephemeral one that hasn't connected for a day, by itself. A runner's sandbox is
 * deleted however long that takes.
 */
export const END_GIVE_UP_MS = 24 * 3_600_000;
/** How often a pass runs while a pool has work (queued jobs, runners booting): the deployment is woken for it. */
export const ACTIVE_TICK_MS = 5_000;
/** How long a pass leaves between them when nothing is waiting: runners running jobs are checked on this often. */
export const IDLE_TICK_MS = 60_000;
/** How long a pass's lease on an integration lasts: longer than any pass (GitHub's calls time out at 15 s each). */
export const LEASE_MS = 2 * 60_000;
/** The largest webhook body read: a `workflow_job` delivery is a few kilobytes. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
/** The most runners a pass makes for one pool. */
const CREATES_PER_PASS = 10;
/** How many job records the list answers. */
const JOBS_LISTED = 200;
/** The labels a runner always has besides its pool's: GitHub's default self-hosted labels. */
const DEFAULT_RUNNER_LABELS = ["self-hosted", "linux", "x64"] as const;
/** Placement reasons that mean "no room now": the job waits, and the pool backs off. */
const WAITING_REASONS: ReadonlySet<string> = new Set([
	"insufficient_capacity",
	"account_limit",
	"no_host",
	"host_unavailable",
]);
const JOB_ORDER: { readonly [state in computeSchema.GithubRunnerJobState]: number } = {
	ignored: 0,
	queued: 1,
	in_progress: 2,
	completed: 3,
};

/** A pool as it is kept and read: `computeSchema.GithubRunnerPool`, read-only through and through. */
export interface RunnerPool {
	readonly label: string;
	readonly template: string;
	readonly resources: { readonly vcpus: number; readonly memoryMb: number; readonly diskGb?: number };
	readonly hostLabels?: { readonly [key: string]: string };
	readonly environments?: readonly string[];
	readonly maxRunners?: number;
	readonly timeoutMinutes?: number;
	readonly runnerCommand?: string;
	readonly stickyDisks?: readonly RunnerStickyDisk[];
}

/** A pool's sticky disk, and when a runner's copy of it is committed. */
export interface RunnerStickyDisk {
	readonly disk: string;
	readonly path: string;
	readonly commit?: { readonly branches: readonly string[]; readonly beforeCommit?: string };
}

/** The run events whose jobs may commit: never a pull request's. */
const COMMITTING_EVENTS: ReadonlySet<string> = new Set(["push", "schedule", "workflow_dispatch"]);
/** How long a pool's `beforeCommit` may run. */
const BEFORE_COMMIT_TIMEOUT_MS = 10 * 60_000;

/** A pool as the API answers it. */
export const poolView = (pool: RunnerPool): computeSchema.GithubRunnerPool => ({
	label: pool.label,
	template: pool.template,
	resources: { ...pool.resources },
	...(pool.hostLabels === undefined ? {} : { hostLabels: { ...pool.hostLabels } }),
	...(pool.environments === undefined ? {} : { environments: [...pool.environments] }),
	...(pool.maxRunners === undefined ? {} : { maxRunners: pool.maxRunners }),
	...(pool.timeoutMinutes === undefined ? {} : { timeoutMinutes: pool.timeoutMinutes }),
	...(pool.runnerCommand === undefined ? {} : { runnerCommand: pool.runnerCommand }),
	...(pool.stickyDisks === undefined
		? {}
		: {
				stickyDisks: pool.stickyDisks.map((sticky) => ({
					disk: sticky.disk,
					path: sticky.path,
					...(sticky.commit === undefined
						? {}
						: {
								commit: {
									branches: [...sticky.commit.branches],
									...(sticky.commit.beforeCommit === undefined ? {} : { beforeCommit: sticky.commit.beforeCommit }),
								},
							}),
				})),
			}),
});

export interface StoredGithubRunners {
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	readonly appId: number;
	readonly owner: string;
	readonly scope: computeSchema.GithubRunnersScope;
	readonly runnerGroupId?: number;
	readonly repositories?: readonly string[];
	readonly pools: readonly RunnerPool[];
	readonly enabled: boolean;
	/** The API key its runners act through. */
	readonly keyId: string;
	/** Sealed at `sealedAt("githubRunners", id, "privateKey")`. Never answered. */
	readonly privateKey: SealedValue;
	/** Sealed at `sealedAt("githubRunners", id, "webhookSecret")`. Answered once, at its create. */
	readonly webhookSecret: SealedValue;
	readonly installationId?: number;
	readonly lastWebhookAt?: number;
	readonly lastError?: { readonly at: number; readonly message: string };
	/** Per demand key (`demandKey`): when it may try a create again after one found no room, and why it waits. */
	readonly backoff?: { readonly [key: string]: { readonly until: number; readonly reason: string } };
	/** The gateway running its pass, until when. */
	readonly lease?: { readonly owner: string; readonly until: number };
	/** When it was deleted: hidden from then, and kept until its runners have ended. */
	readonly retiringAt?: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** A job a webhook told of; its ID is `<integration>:<GitHub's job ID>`. */
export interface StoredGithubRunnerJob {
	readonly id: string;
	readonly integrationId: string;
	readonly accountId: string;
	readonly jobId: number;
	readonly runId: number;
	readonly repository: string;
	readonly name: string;
	readonly labels: readonly string[];
	readonly pool?: string;
	readonly state: computeSchema.GithubRunnerJobState;
	readonly conclusion?: string;
	readonly sandboxId?: string;
	readonly queuedAt: number;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly reason?: string;
	readonly updatedAt: number;
}

/**
 * A runner: its ID is its sandbox's. `booting` until its sandbox runs; `registering` while a pass asks GitHub for its
 * configuration and starts it; `idle` once started, until GitHub gives it a job (`busy`); `ending` while its sandbox and
 * its runner on GitHub are removed.
 */
export interface StoredGithubRunnerMachine {
	readonly id: string;
	readonly integrationId: string;
	readonly accountId: string;
	readonly pool: string;
	readonly state: "booting" | "registering" | "idle" | "busy" | "ending";
	readonly runnerId?: number;
	/**
	 * Where it was registered (or was being registered): kept with the runner, so taking it off GitHub goes there however
	 * the integration has changed since.
	 */
	readonly registration?: { readonly installationId: number; readonly scope: RunnerScope };
	/** The repository it is for, for a repository-scoped integration: chosen when it is made. */
	readonly repository?: string;
	readonly jobId?: number;
	readonly createdAt: number;
	readonly claimedAt?: number;
	readonly readyAt?: number;
	readonly busyAt?: number;
	readonly checkedAt?: number;
	/** It took a job: GitHub removes an ephemeral runner itself once its job ends. */
	readonly tookJob?: boolean;
	/** Its job succeeded and its pool commits sticky disks: the run to check before its copies are committed, once. */
	readonly commit?: { readonly runId: number; readonly repository: string; readonly done?: boolean };
	/** Ending: since when, why, whether its runner is gone from GitHub, and whether the pool keeps its backoff. */
	readonly endingAt?: number;
	readonly endReason?: string;
	readonly unregistered?: boolean;
	readonly keepBackoff?: boolean;
	readonly expiresAt: number;
	readonly updatedAt: number;
}

export interface GithubRunnersStore {
	readonly githubRunners: Collection<StoredGithubRunners>;
	readonly githubRunnerJobs: Collection<StoredGithubRunnerJob>;
	readonly githubRunnerMachines: Collection<StoredGithubRunnerMachine>;
}

/** The sandbox calls the broker makes, as its key: the service's own handlers. */
export interface RunnerSandboxes {
	create(
		principal: KeyPrincipal,
		body: computeSchema.CreateSandboxBody,
	): Promise<{ readonly id: string; readonly state: string }>;
	/** Its state and placement reason, or undefined once it is gone; any other failure rejects. */
	get(
		principal: KeyPrincipal,
		sandboxId: string,
	): Promise<{ readonly state: string; readonly placementReason?: string; readonly reason?: string } | undefined>;
	/** Deletes it; one already gone is no error. */
	delete(principal: KeyPrincipal, sandboxId: string): Promise<void>;
	/** Runs `command` and waits for it, at most `timeoutMs`: its exit code. */
	exec(principal: KeyPrincipal, sandboxId: string, command: string, timeoutMs: number): Promise<number>;
	/** Commits the sandbox's copy of a sticky disk (`commitStickyDisk`). */
	commit(principal: KeyPrincipal, sandboxId: string, disk: string): Promise<void>;
	/** Starts `command` detached, with `env`. */
	run(
		principal: KeyPrincipal,
		sandboxId: string,
		command: string,
		env: { readonly [name: string]: string },
	): Promise<void>;
	/** Sandboxes of the account carrying `labels`, any state but deleted. */
	listLabelled(
		accountId: string,
		labels: { readonly [key: string]: string },
	): Promise<readonly { readonly id: string; readonly createdAt: number }[]>;
}

export interface GithubRunnersOptions {
	readonly store: Pick<ComputeStore, "githubRunners" | "githubRunnerJobs" | "githubRunnerMachines">;
	readonly now: () => number;
	readonly sealer: () => Sealer;
	readonly sandboxes: RunnerSandboxes;
	/** The key's principal while it is live (`liveKeyPrincipal`): what makes runners. */
	readonly principalOf: (keyId: string) => Promise<KeyPrincipal | undefined>;
	/** The key's principal revoked or not, while its record exists: what ends runners. */
	readonly cleanupPrincipalOf: (keyId: string) => Promise<KeyPrincipal | undefined>;
	readonly github: (credentials: { readonly appId: number; readonly privateKey: string }) => GithubApp;
	/** Asks the deployment to run a pass at `at` (`ComputeServiceOptions.wakeAt`). */
	readonly wakeAt?: (at: number) => Promise<void> | void;
	readonly log?: (message: string) => void;
	/** This gateway's name in leases. Default a random one per process. */
	readonly gatewayId?: string;
}

export interface GithubRunners {
	/** Answers a webhook to `/github-runners/{id}/webhook`: checks its signature, records the job, and runs a pass. */
	receive(integrationId: string, request: Request): Promise<Response>;
	/** One pass over every integration; answers when the next is due. */
	tick(): Promise<number | undefined>;
	/** The integration's view, with its pools' queues and runners (`status`). */
	view(record: StoredGithubRunners, webhookUrl: string, status: boolean): Promise<computeSchema.GithubRunners>;
	/** A new webhook secret, and the record's sealed values for it and `privateKey`. */
	seal(
		id: string,
		privateKey: string,
		webhookSecret?: string,
	): Promise<{ readonly privateKey: SealedValue; readonly webhookSecret: SealedValue; readonly secret: string }>;
	/**
	 * Retires the integration: hidden and disabled at once, its runners ended, then its records gone. Answers whether it
	 * finished; when not, passes carry on until it has.
	 */
	retire(integrationId: string): Promise<boolean>;
	/**
	 * Forgets an account's integrations, whose sandboxes and key go with the account: tries once to take its runners off
	 * GitHub, then deletes the records.
	 */
	forgetAccount(accountId: string): Promise<void>;
	jobs(integrationId: string): Promise<computeSchema.GithubRunnerJob[]>;
}

/** Whether a job's labels pick `pool`: they name its label, and the runner has every one of them. */
export function poolFor(pools: readonly RunnerPool[], labels: readonly string[]): RunnerPool | undefined {
	const asked = labels.map((label) => label.toLowerCase());
	return pools.find((pool) => {
		const has = new Set<string>([...DEFAULT_RUNNER_LABELS, pool.label]);
		return asked.includes(pool.label) && asked.every((label) => has.has(label));
	});
}

/** The labels a pool's runner is registered with. */
export const runnerLabels = (pool: RunnerPool): string[] => [...DEFAULT_RUNNER_LABELS, pool.label];

const jobRecordId = (integrationId: string, jobId: number) => `${integrationId}:${jobId}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What a runner is counted against: its pool, and for a repository-scoped integration its repository too, as a runner
 * registered on one repository can't take another's job.
 */
const demandKey = (record: StoredGithubRunners, pool: string, repository: string | undefined): string =>
	record.scope === "repository" && repository !== undefined ? `${pool} ${repository}` : pool;

interface WorkflowJobEvent {
	readonly action: string;
	readonly installationId?: number;
	readonly job: {
		readonly id: number;
		readonly runId: number;
		readonly name: string;
		readonly labels: readonly string[];
		readonly conclusion?: string;
		readonly runnerName?: string;
	};
	readonly repository: string;
}

/** A `workflow_job` delivery's fields, or undefined when it lacks one this needs. */
function parseWorkflowJob(body: unknown): WorkflowJobEvent | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as {
		action?: unknown;
		installation?: { id?: unknown };
		workflow_job?: {
			id?: unknown;
			run_id?: unknown;
			name?: unknown;
			labels?: unknown;
			conclusion?: unknown;
			runner_name?: unknown;
		};
		repository?: { full_name?: unknown };
	};
	const job = record.workflow_job;
	if (
		typeof record.action !== "string" ||
		job === undefined ||
		typeof job.id !== "number" ||
		typeof job.run_id !== "number" ||
		!Array.isArray(job.labels) ||
		typeof record.repository?.full_name !== "string"
	) {
		return undefined;
	}
	return {
		action: record.action,
		...(typeof record.installation?.id === "number" ? { installationId: record.installation.id } : {}),
		job: {
			id: job.id,
			runId: job.run_id,
			name: typeof job.name === "string" ? job.name : "",
			labels: job.labels.filter((label): label is string => typeof label === "string"),
			...(typeof job.conclusion === "string" ? { conclusion: job.conclusion } : {}),
			...(typeof job.runner_name === "string" && job.runner_name !== "" ? { runnerName: job.runner_name } : {}),
		},
		repository: record.repository.full_name,
	};
}

/** Thrown when this gateway no longer holds an integration's lease: its pass stops before its next effect. */
class LeaseLost extends Error {
	constructor(integrationId: string) {
		super(`Another gateway holds ${integrationId}'s lease`);
		this.name = "LeaseLost";
	}
}

/** A request's body, at most `limit` bytes; undefined when it is longer. */
async function boundedBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > limit) return undefined;
	if (request.body === null) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

export function createGithubRunners(options: GithubRunnersOptions): GithubRunners {
	const { store, now } = options;
	const log = options.log ?? (() => {});
	const gatewayId = options.gatewayId ?? randomId("gw");
	const apps = new Map<string, { readonly appId: number; readonly sealed: string; readonly app: GithubApp }>();
	/** Each integration's pass under way on this gateway: a webhook's pass and the sweep's run one after the other. */
	const passing = new Map<string, Promise<boolean>>();

	/** The integration's GitHub App, made again when its App or key changes. */
	async function appOf(record: StoredGithubRunners): Promise<GithubApp> {
		const sealed = JSON.stringify(record.privateKey);
		const cached = apps.get(record.id);
		if (cached !== undefined && cached.appId === record.appId && cached.sealed === sealed) return cached.app;
		const privateKey = await options
			.sealer()
			.openText(record.privateKey, sealedAt("githubRunners", record.id, "privateKey"));
		const app = options.github({ appId: record.appId, privateKey });
		apps.set(record.id, { appId: record.appId, sealed, app });
		return app;
	}

	const scopeOf = (record: StoredGithubRunners, repository: string | undefined): RunnerScope | undefined =>
		record.scope === "organization"
			? record.runnerGroupId === undefined
				? undefined
				: { kind: "organization", org: record.owner, runnerGroupId: record.runnerGroupId }
			: repository === undefined
				? undefined
				: { kind: "repository", repository };

	async function noteError(record: StoredGithubRunners, message: string): Promise<void> {
		log(`[github-runners] ${record.id}: ${message}`);
		await store.githubRunners
			.update(record.id, (current) => ({ ...current, lastError: { at: now(), message: message.slice(0, 1000) } }))
			.catch(() => undefined);
	}

	async function setBackoff(integrationId: string, key: string, reason: string | undefined): Promise<void> {
		await store.githubRunners
			.update(integrationId, (current) => {
				const backoff = { ...current.backoff };
				if (reason === undefined) {
					if (backoff[key] === undefined) return undefined;
					delete backoff[key];
				} else backoff[key] = { until: now() + CAPACITY_BACKOFF_MS, reason };
				return { ...current, backoff };
			})
			.catch(() => undefined);
	}

	/**
	 * Marks a runner to end, once: all a webhook does. The pass that holds the integration's lease does the ending (`end`),
	 * so a runner is never ended while that pass is registering it.
	 */
	async function markEnding(
		machineId: string,
		why: string,
		extra: {
			readonly keepBackoff?: boolean;
			readonly tookJob?: boolean;
			readonly commit?: StoredGithubRunnerMachine["commit"];
		} = {},
	): Promise<StoredGithubRunnerMachine | undefined> {
		const t = now();
		return store.githubRunnerMachines.update(machineId, (current) =>
			current.state === "ending"
				? extra.tookJob === true && current.tookJob !== true
					? { ...current, tookJob: true }
					: current
				: {
						...current,
						state: "ending",
						endingAt: t,
						endReason: why,
						...(extra.keepBackoff === true ? { keepBackoff: true } : {}),
						...(extra.tookJob === true ? { tookJob: true } : {}),
						...(extra.commit === undefined ? {} : { commit: extra.commit }),
						updatedAt: t,
					},
		);
	}

	/**
	 * Ends a runner, as the lease holder: marks it `ending`, takes its runner off GitHub unless GitHub does that itself,
	 * deletes its sandbox, and only then forgets it. A step that fails leaves it `ending` for the next pass; answers
	 * whether it has gone.
	 */
	async function end(
		record: StoredGithubRunners,
		machineId: string,
		why: string,
		endOptions: { readonly keepBackoff?: boolean } = {},
	): Promise<boolean> {
		await hold(record.id);
		const t = now();
		const machine = await markEnding(machineId, why, endOptions);
		if (machine === undefined) return true;
		if (machine.endingAt === t) log(`[github-runners] ending runner ${machine.id}: ${why}`);
		// Its sticky disks first, while its sandbox runs: once, whatever the outcome.
		if (machine.commit !== undefined && machine.commit.done !== true) {
			await commitCopies(record, machine);
			await store.githubRunnerMachines.update(machine.id, (current) =>
				current.commit === undefined ? undefined : { ...current, commit: { ...current.commit, done: true } },
			);
		}
		// Its runner on GitHub: one that took a job, GitHub removes once the job ends.
		if (machine.unregistered !== true && machine.tookJob !== true) {
			const removed = await unregister(record, machine).catch((error: unknown) => {
				if (error instanceof LeaseLost) throw error;
				log(`[github-runners] runner ${machine.id} not taken off GitHub yet: ${messageOf(error)}`);
				return false;
			});
			if (!removed && t - (machine.endingAt ?? t) <= END_GIVE_UP_MS) return false;
			if (!removed) await noteError(record, `left runner ${machine.id} for GitHub to remove: it never ran a job`);
			await store.githubRunnerMachines.update(machine.id, (current) => ({ ...current, unregistered: true }));
		}
		const principal = await options.cleanupPrincipalOf(record.keyId);
		if (principal !== undefined) {
			await hold(record.id);
			try {
				await options.sandboxes.delete(principal, machine.id);
			} catch (error) {
				if (!isKantelError(error, "not_found")) {
					log(`[github-runners] sandbox ${machine.id} not deleted yet: ${messageOf(error)}`);
					return false;
				}
			}
		}
		await hold(record.id);
		await store.githubRunnerMachines.delete(machine.id);
		// A runner gone is room: its pool may try again at once, unless it went for want of room.
		if (machine.keepBackoff !== true) {
			await setBackoff(record.id, demandKey(record, machine.pool, machine.repository), undefined);
		}
		return true;
	}

	/**
	 * Commits a runner's copies of its pool's sticky disks, for a job that succeeded, when GitHub says its run is a push,
	 * schedule or manual run of a branch the disk commits from, in the job's own repository. A failure is logged, never
	 * thrown: the runner ends either way, and the disk keeps the version it had.
	 */
	async function commitCopies(record: StoredGithubRunners, machine: StoredGithubRunnerMachine): Promise<void> {
		const commit = machine.commit;
		const pool = record.pools.find((candidate) => candidate.label === machine.pool);
		const rules = (pool?.stickyDisks ?? []).filter((sticky) => sticky.commit !== undefined);
		if (commit === undefined || rules.length === 0 || record.installationId === undefined) return;
		const principal = await options.principalOf(record.keyId);
		if (principal === undefined) return;
		try {
			const run = await (await appOf(record)).getRun(record.installationId, commit.repository, commit.runId);
			if (
				run === undefined ||
				!COMMITTING_EVENTS.has(run.event) ||
				run.headRepository !== commit.repository ||
				run.headBranch === undefined
			) {
				return;
			}
			const branch = run.headBranch;
			for (const sticky of rules) {
				if (sticky.commit?.branches.includes(branch) !== true) continue;
				await hold(record.id);
				if (sticky.commit.beforeCommit !== undefined) {
					const code = await options.sandboxes.exec(
						principal,
						machine.id,
						sticky.commit.beforeCommit,
						BEFORE_COMMIT_TIMEOUT_MS,
					);
					if (code !== 0) {
						log(`[github-runners] ${machine.id}: beforeCommit for ${sticky.disk} exited ${code}; not committed`);
						continue;
					}
				}
				await options.sandboxes.commit(principal, machine.id, sticky.disk);
				log(`[github-runners] ${machine.id}: committed ${sticky.disk} from ${commit.repository}@${branch}`);
			}
		} catch (error) {
			if (error instanceof LeaseLost) throw error;
			await noteError(record, `committing runner ${machine.id}'s sticky disks: ${messageOf(error)}`);
		}
	}

	/**
	 * Takes a runner off GitHub where it was registered: by its ID, or, for one whose registration never answered, by its
	 * name. True once it isn't there.
	 */
	async function unregister(record: StoredGithubRunners, machine: StoredGithubRunnerMachine): Promise<boolean> {
		const registration = machine.registration;
		if (registration === undefined) return true;
		await hold(record.id);
		const app = await appOf(record);
		const runnerId =
			machine.runnerId ?? (await app.findRunner(registration.installationId, registration.scope, machine.id));
		if (runnerId === undefined) return true;
		await app.removeRunner(registration.installationId, registration.scope, runnerId);
		return true;
	}

	/**
	 * Registers a running sandbox's runner on GitHub and starts it. It is `registering` (with where, so an end can find
	 * it) until the runner has started; only then `idle`, so a runner whose start never happened isn't counted as one
	 * waiting for a job, and a stalled registration is ended.
	 */
	async function register(
		record: StoredGithubRunners,
		machine: StoredGithubRunnerMachine,
		principal: KeyPrincipal,
		pool: RunnerPool,
	): Promise<void> {
		const scope = scopeOf(record, machine.repository);
		const installationId = record.installationId;
		if (scope === undefined || installationId === undefined) {
			await end(record, machine.id, "no installation, runner group or repository to register it in");
			return;
		}
		await hold(record.id);
		const t = now();
		const claimed = await store.githubRunnerMachines.update(machine.id, (current) =>
			current.state === "booting"
				? { ...current, state: "registering", claimedAt: t, registration: { installationId, scope }, updatedAt: t }
				: undefined,
		);
		if (claimed === undefined) return;
		try {
			const jit = await (await appOf(record)).generateJitConfig(installationId, scope, {
				name: machine.id,
				labels: runnerLabels(pool),
			});
			// Kept whatever its state now, so an end (marked meanwhile) takes it off GitHub by its ID.
			const registered = await store.githubRunnerMachines.update(machine.id, (current) => ({
				...current,
				runnerId: jit.runnerId,
			}));
			if (registered?.state !== "registering") return;
			await hold(record.id);
			await options.sandboxes.run(principal, machine.id, pool.runnerCommand ?? DEFAULT_RUNNER_COMMAND, {
				KANTEL_RUNNER_JITCONFIG: jit.encodedJitConfig,
			});
			await store.githubRunnerMachines.update(machine.id, (current) =>
				current.state === "registering" ? { ...current, state: "idle", readyAt: now(), updatedAt: now() } : undefined,
			);
		} catch (error) {
			if (error instanceof LeaseLost) throw error;
			await noteError(record, `registering runner ${machine.id}: ${messageOf(error)}`);
			await end(record, machine.id, "its registration failed");
		}
	}

	/** Renews this gateway's lease on the integration before an effect; `LeaseLost` once another gateway holds it. */
	async function hold(integrationId: string): Promise<void> {
		const t = now();
		const held = await store.githubRunners.update(integrationId, (current) =>
			current.lease?.owner === gatewayId || current.lease === undefined
				? { ...current, lease: { owner: gatewayId, until: t + LEASE_MS } }
				: undefined,
		);
		if (held === undefined && (await store.githubRunners.get(integrationId)) !== undefined) {
			throw new LeaseLost(integrationId);
		}
	}

	/** Takes or renews the integration's lease for this gateway; undefined when another gateway holds it. */
	async function lease(integrationId: string): Promise<StoredGithubRunners | undefined> {
		const t = now();
		return store.githubRunners.update(integrationId, (current) =>
			current.lease === undefined || current.lease.owner === gatewayId || current.lease.until <= t
				? { ...current, lease: { owner: gatewayId, until: t + LEASE_MS } }
				: undefined,
		);
	}

	async function release(integrationId: string): Promise<void> {
		await store.githubRunners
			.update(integrationId, (current) => {
				if (current.lease?.owner !== gatewayId) return undefined;
				const { lease: _lease, ...rest } = current;
				return rest;
			})
			.catch(() => undefined);
	}

	/** One pass over one integration, holding its lease; answers whether it wants the next pass soon. */
	async function pass(integrationId: string): Promise<boolean> {
		const record = await lease(integrationId);
		// Another gateway's pass is under way: it does this one's work, and this one looks again soon.
		if (record === undefined) return (await store.githubRunners.get(integrationId)) !== undefined;
		try {
			return await passHolding(record);
		} catch (error) {
			if (!(error instanceof LeaseLost)) throw error;
			log(`[github-runners] ${error.message}; its pass stopped`);
			return true;
		} finally {
			await release(integrationId);
		}
	}

	async function passHolding(record: StoredGithubRunners): Promise<boolean> {
		const machines = await store.githubRunnerMachines.list({ integrationId: record.id });
		const t = now();

		// Retiring: end every runner, and every sandbox labelled as one (its record never written), then forget it.
		if (record.retiringAt !== undefined) {
			let left = 0;
			for (const machine of machines) if (!(await end(record, machine.id, "its integration was deleted"))) left++;
			if ((await sweepOrphans(record, 0)) > 0) left++;
			if (left > 0) return true;
			await hold(record.id);
			for (const job of await store.githubRunnerJobs.list({ integrationId: record.id })) {
				await store.githubRunnerJobs.delete(job.id);
			}
			await store.githubRunners.delete(record.id);
			apps.delete(record.id);
			return false;
		}

		const principal = await options.principalOf(record.keyId);
		const jobs = await store.githubRunnerJobs.list({ integrationId: record.id });
		let active = false;

		// Jobs: forget ended ones after a while, and give up on queued ones GitHub has cancelled by now.
		for (const job of jobs) {
			if (job.state === "queued" && t - job.queuedAt > QUEUED_JOB_TTL_MS) {
				await store.githubRunnerJobs.update(job.id, (current) =>
					current.state === "queued"
						? {
								...current,
								state: "completed",
								reason: "GitHub cancels a job queued a day",
								completedAt: t,
								updatedAt: t,
							}
						: undefined,
				);
			} else if ((job.state === "completed" || job.state === "ignored") && t - job.updatedAt > ENDED_JOB_TTL_MS) {
				await store.githubRunnerJobs.delete(job.id);
			}
		}
		const queued = (key: string) =>
			jobs.filter(
				(job) =>
					job.state === "queued" && job.pool !== undefined && demandKey(record, job.pool, job.repository) === key,
			);

		// Runners: boot, register, time out, and notice ended jobs whose webhook never came.
		for (const machine of machines) {
			const pool = record.pools.find((candidate) => candidate.label === machine.pool);
			if (machine.state === "ending") {
				if (!(await end(record, machine.id, machine.endReason ?? "ending"))) active = true;
				continue;
			}
			if (t >= machine.expiresAt) {
				await end(record, machine.id, "timed out");
				continue;
			}
			if (principal === undefined) {
				await end(record, machine.id, "its key is revoked");
				continue;
			}
			if (pool === undefined) {
				await end(record, machine.id, "its pool is gone");
				continue;
			}
			if (machine.state === "registering") {
				// A registration whose gateway died part-way: the runner may be on GitHub, which the end looks for by name.
				if (t - (machine.claimedAt ?? t) > REGISTER_TIMEOUT_MS)
					await end(record, machine.id, "its registration stalled");
				else active = true;
				continue;
			}
			if (machine.state === "booting") {
				active = true;
				let sandbox: Awaited<ReturnType<RunnerSandboxes["get"]>>;
				try {
					sandbox = await options.sandboxes.get(principal, machine.id);
				} catch (error) {
					// Not known to be gone: looked at again next pass.
					log(`[github-runners] reading runner ${machine.id} failed: ${messageOf(error)}`);
					continue;
				}
				if (sandbox === undefined || sandbox.state === "deleted" || sandbox.state === "deleting") {
					await end(record, machine.id, "its sandbox is gone");
				} else if (sandbox.state === "running") {
					await register(record, machine, principal, pool);
				} else if (sandbox.state === "error") {
					const reason = sandbox.placementReason;
					const waiting = reason !== undefined && WAITING_REASONS.has(reason);
					const key = demandKey(record, machine.pool, machine.repository);
					if (waiting) await setBackoff(record.id, key, sandbox.reason ?? reason ?? "no room");
					else await noteError(record, `runner ${machine.id} failed: ${sandbox.reason ?? "its sandbox is in error"}`);
					await end(record, machine.id, waiting ? "no room" : "its sandbox failed", { keepBackoff: waiting });
				} else if (sandbox.state !== "starting" || t - machine.createdAt > BOOT_TIMEOUT_MS) {
					await end(
						record,
						machine.id,
						sandbox.state === "starting" ? "boot timed out" : `its sandbox is ${sandbox.state}`,
					);
				}
				continue;
			}
			if (machine.state === "idle") {
				const waiting = queued(demandKey(record, machine.pool, machine.repository)).length > 0;
				if (!waiting && t - (machine.readyAt ?? machine.createdAt) > IDLE_GRACE_MS) {
					await end(record, machine.id, "no job came for it");
				}
				continue;
			}
			if (machine.state === "busy" && t - (machine.checkedAt ?? machine.busyAt ?? t) > JOB_CHECK_EVERY_MS) {
				const job = jobs.find((candidate) => candidate.jobId === machine.jobId);
				await store.githubRunnerMachines.update(machine.id, (current) => ({ ...current, checkedAt: t }));
				if (job !== undefined && record.installationId !== undefined) {
					try {
						const status = await (await appOf(record)).getJob(record.installationId, job.repository, job.jobId);
						if (status === undefined || status.status === "completed") {
							await completeJob(record, job.jobId, status?.conclusion, machine.id);
						}
					} catch (error) {
						log(`[github-runners] checking job ${job.jobId} failed: ${messageOf(error)}`);
					}
				}
			}
		}

		// Demand: a runner starting or waiting for each queued job, within the pool's limit, unless it waits for room.
		const fresh = await store.githubRunners.get(record.id);
		if (fresh?.enabled && fresh.retiringAt === undefined && principal !== undefined) {
			if (fresh.installationId !== undefined) {
				const live: StoredGithubRunnerMachine[] = await store.githubRunnerMachines.list({ integrationId: fresh.id });
				const keys = new Map<string, { readonly pool: RunnerPool; readonly repository: string | undefined }>();
				for (const job of jobs) {
					const pool = fresh.pools.find((candidate) => candidate.label === job.pool);
					if (job.state !== "queued" || pool === undefined) continue;
					const repository = fresh.scope === "repository" ? job.repository : undefined;
					keys.set(demandKey(fresh, pool.label, repository), { pool, repository });
				}
				// The oldest queued job's key first, so a busy pool doesn't starve another of the account's room.
				const order = [...keys].sort(([a], [b]) => (queued(a)[0]?.queuedAt ?? 0) - (queued(b)[0]?.queuedAt ?? 0));
				for (const [key, { pool, repository }] of order) {
					active = true;
					const waiting = queued(key).length;
					const ofKey = live.filter(
						(machine) => machine.state !== "ending" && demandKey(fresh, machine.pool, machine.repository) === key,
					);
					const ofPool = live.filter((machine) => machine.state !== "ending" && machine.pool === pool.label);
					const supply = ofKey.filter(
						(machine) => machine.state === "booting" || machine.state === "registering" || machine.state === "idle",
					).length;
					const room = (pool.maxRunners ?? DEFAULT_MAX_RUNNERS) - ofPool.length;
					const backoff = fresh.backoff?.[key];
					if (backoff !== undefined && backoff.until > t) continue;
					// After waiting for room, one runner at a time probes for it.
					const wanted = Math.min(waiting - supply, room, backoff === undefined ? CREATES_PER_PASS : 1);
					for (let made = 0; made < wanted; made++) {
						const runner = await makeRunner(fresh, pool, repository, principal);
						if (runner === undefined) break;
						// Counted at once, so the next key's room is the pool's room less this one.
						live.push(runner);
					}
				}
			} else if (jobs.some((job) => job.state === "queued")) {
				active = true;
			}
		}

		await sweepOrphans(record, 60_000);
		return active;
	}

	/**
	 * Deletes sandboxes labelled as the integration's runners that have no record (a create whose record was never
	 * written), once older than `minAgeMs`; answers how many are left, a listing that failed counting as one.
	 */
	async function sweepOrphans(record: StoredGithubRunners, minAgeMs: number): Promise<number> {
		const cleanup = await options.cleanupPrincipalOf(record.keyId);
		if (cleanup === undefined) return 0;
		const t = now();
		const known = new Set(
			(await store.githubRunnerMachines.list({ integrationId: record.id })).map((machine) => machine.id),
		);
		let labelled: readonly { readonly id: string; readonly createdAt: number }[];
		try {
			labelled = await options.sandboxes.listLabelled(record.accountId, { [RUNNER_LABEL]: record.id });
		} catch (error) {
			log(`[github-runners] listing runner sandboxes failed: ${messageOf(error)}`);
			return 1;
		}
		let left = 0;
		for (const sandbox of labelled) {
			if (known.has(sandbox.id) || t - sandbox.createdAt < minAgeMs) continue;
			log(`[github-runners] deleting orphaned runner sandbox ${sandbox.id}`);
			await hold(record.id);
			try {
				await options.sandboxes.delete(cleanup, sandbox.id);
			} catch (error) {
				if (!isKantelError(error, "not_found")) left++;
			}
		}
		return left;
	}

	/** Makes one runner; undefined when there was no room (the key now backs off) or the create failed. */
	async function makeRunner(
		record: StoredGithubRunners,
		pool: RunnerPool,
		repository: string | undefined,
		principal: KeyPrincipal,
	): Promise<StoredGithubRunnerMachine | undefined> {
		await hold(record.id);
		const t = now();
		const key = demandKey(record, pool.label, repository);
		let sandbox: { readonly id: string; readonly state: string };
		try {
			sandbox = await options.sandboxes.create(principal, {
				name: `gh-${pool.label}`.slice(0, 63),
				type: "microvm",
				template: pool.template,
				resources: { ...pool.resources },
				...(pool.hostLabels === undefined ? {} : { hostLabels: { ...pool.hostLabels } }),
				...(pool.environments === undefined || pool.environments.length === 0
					? {}
					: { environments: [...pool.environments] }),
				labels: { [RUNNER_LABEL]: record.id, [RUNNER_POOL_LABEL]: pool.label },
				...(pool.stickyDisks === undefined || pool.stickyDisks.length === 0
					? {}
					: { stickyDisks: pool.stickyDisks.map((sticky) => ({ disk: sticky.disk, path: sticky.path })) }),
				autoStopMinutes: (pool.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) + 5,
			});
		} catch (error) {
			const reason = placementReasonOf(error);
			if (
				!(isKantelError(error) && (error.code === "exhausted" || (reason !== undefined && WAITING_REASONS.has(reason))))
			) {
				await noteError(record, `making a runner for ${pool.label}: ${messageOf(error)}`);
			}
			await setBackoff(record.id, key, messageOf(error));
			return undefined;
		}
		const machine: StoredGithubRunnerMachine = {
			id: sandbox.id,
			integrationId: record.id,
			accountId: record.accountId,
			pool: pool.label,
			state: "booting",
			...(repository === undefined ? {} : { repository }),
			createdAt: t,
			expiresAt: t + (pool.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000,
			updatedAt: t,
		};
		await store.githubRunnerMachines.put(machine);
		return machine;
	}

	/** Marks a job ended, and its runner to end (which the next pass does). */
	async function completeJob(
		record: StoredGithubRunners,
		jobId: number,
		conclusion: string | undefined,
		runnerName: string | undefined,
		run?: { readonly runId: number; readonly repository: string },
	): Promise<void> {
		const t = now();
		await store.githubRunnerJobs.update(jobRecordId(record.id, jobId), (current) =>
			current.state === "completed"
				? undefined
				: {
						...current,
						state: "completed",
						...(conclusion === undefined ? {} : { conclusion }),
						...(runnerName === undefined ? {} : { sandboxId: runnerName }),
						completedAt: t,
						updatedAt: t,
					},
		);
		if (runnerName === undefined) return;
		const machine = await store.githubRunnerMachines.get(runnerName);
		if (machine?.integrationId !== record.id) return;
		const pool = record.pools.find((candidate) => candidate.label === machine.pool);
		const commits =
			conclusion === "success" &&
			run !== undefined &&
			pool?.stickyDisks?.some((sticky) => sticky.commit !== undefined) === true;
		await markEnding(machine.id, "its job ended", { tookJob: true, ...(commits ? { commit: { ...run } } : {}) });
	}

	async function onWorkflowJob(record: StoredGithubRunners, event: WorkflowJobEvent): Promise<void> {
		const t = now();
		const id = jobRecordId(record.id, event.job.id);
		const pool = poolFor(record.pools, event.job.labels);
		if (pool === undefined) return;
		const allowed = record.repositories === undefined || record.repositories.includes(event.repository);
		const state: computeSchema.GithubRunnerJobState = !allowed
			? "ignored"
			: event.action === "queued"
				? "queued"
				: event.action === "in_progress"
					? "in_progress"
					: event.action === "completed"
						? "completed"
						: "ignored";
		const runner = event.job.runnerName;
		const machine = runner === undefined ? undefined : await store.githubRunnerMachines.get(runner);
		const ours = machine !== undefined && machine.integrationId === record.id;
		const fields = {
			...(event.job.conclusion === undefined || state !== "completed" ? {} : { conclusion: event.job.conclusion }),
			...(ours && (state === "in_progress" || state === "completed") ? { sandboxId: machine.id } : {}),
			...(state === "in_progress" ? { startedAt: t } : {}),
			...(state === "completed" ? { completedAt: t } : {}),
		};
		const reason = !allowed
			? `${event.repository} isn't one of the integration's repositories`
			: event.action === "waiting"
				? "Waiting for an approval or a concurrency group"
				: undefined;
		// Once, and only forward: a delivery sent again, or one arriving after a later one, changes nothing.
		const inserted = await store.githubRunnerJobs.insert({
			id,
			integrationId: record.id,
			accountId: record.accountId,
			jobId: event.job.id,
			runId: event.job.runId,
			repository: event.repository,
			name: event.job.name,
			labels: event.job.labels,
			pool: pool.label,
			state,
			...fields,
			...(reason === undefined ? {} : { reason }),
			queuedAt: t,
			updatedAt: t,
		});
		if (!inserted && allowed) {
			await store.githubRunnerJobs.update(id, (current) => {
				if (JOB_ORDER[state] <= JOB_ORDER[current.state]) return undefined;
				const { reason: _reason, ...rest } = current;
				return { ...rest, state, ...fields, updatedAt: t };
			});
		}
		if (state === "in_progress" && ours) {
			await store.githubRunnerMachines.update(machine.id, (current) =>
				current.state === "ending"
					? { ...current, tookJob: true }
					: { ...current, state: "busy", tookJob: true, jobId: event.job.id, busyAt: t, updatedAt: t },
			);
		}
		if (state === "completed") {
			await completeJob(record, event.job.id, event.job.conclusion, runner, {
				runId: event.job.runId,
				repository: event.repository,
			});
		}
	}

	async function webhookSecretOf(record: StoredGithubRunners): Promise<string> {
		return options.sealer().openText(record.webhookSecret, sealedAt("githubRunners", record.id, "webhookSecret"));
	}

	const answer = (status: number, message: string) =>
		new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json" } });

	function serialPass(integrationId: string): Promise<boolean> {
		const before = passing.get(integrationId) ?? Promise.resolve(false);
		const next = before.catch(() => false).then(() => pass(integrationId));
		passing.set(integrationId, next);
		const clear = () => {
			if (passing.get(integrationId) === next) passing.delete(integrationId);
		};
		next.then(clear, clear);
		return next;
	}

	/** Ends every runner of an integration once, and forgets it when they have all gone. */
	async function retireNow(integrationId: string): Promise<boolean> {
		await serialPass(integrationId).catch((error: unknown) => {
			log(`[github-runners] retiring ${integrationId}: ${messageOf(error)}`);
			return true;
		});
		return (await store.githubRunners.get(integrationId)) === undefined;
	}

	return {
		async receive(integrationId, request) {
			if (request.method !== "POST") return answer(405, "POST only");
			const record = await store.githubRunners.get(integrationId);
			if (record === undefined || record.retiringAt !== undefined) return answer(404, "No such integration");
			const body = await boundedBody(request, MAX_WEBHOOK_BYTES);
			if (body === undefined) return answer(413, "Too large for a workflow_job delivery");
			const signature = request.headers.get("x-hub-signature-256");
			if (!(await verifyGithubSignature(await webhookSecretOf(record), body, signature))) {
				return answer(401, "The signature doesn't match the integration's webhook secret");
			}
			const event = request.headers.get("x-github-event");
			if (event === "ping") return answer(200, "pong");
			if (event !== "workflow_job") return answer(202, `${event ?? "That event"} isn't one runners need`);
			let parsed: WorkflowJobEvent | undefined;
			try {
				parsed = parseWorkflowJob(JSON.parse(new TextDecoder().decode(body)));
			} catch {
				parsed = undefined;
			}
			if (parsed === undefined) return answer(400, "Not a workflow_job delivery");
			const installationId = parsed.installationId;
			const current = await store.githubRunners.update(record.id, (latest) =>
				latest.retiringAt === undefined
					? { ...latest, lastWebhookAt: now(), ...(installationId === undefined ? {} : { installationId }) }
					: undefined,
			);
			// Deleted while the body was read: nothing is recorded for it.
			if (current === undefined) return answer(404, "No such integration");
			await onWorkflowJob(current, parsed);
			// Deleted while the job was recorded: its retirement may have deleted the jobs before this one landed.
			const after = await store.githubRunners.get(record.id);
			if (after === undefined || after.retiringAt !== undefined) {
				if (after === undefined) await store.githubRunnerJobs.delete(jobRecordId(record.id, parsed.job.id));
				return answer(404, "No such integration");
			}
			// A pass now, so a queued job's runner starts at once: a create only places the sandbox, well inside
			// GitHub's 10 s.
			let active = true;
			try {
				active = await serialPass(record.id);
			} catch (error) {
				await noteError(current, `a pass after a webhook failed: ${messageOf(error)}`);
			}
			await options.wakeAt?.(now() + (active ? ACTIVE_TICK_MS : IDLE_TICK_MS));
			return answer(200, "ok");
		},

		async tick() {
			let active = false;
			let any = false;
			for (const record of await store.githubRunners.list()) {
				any = true;
				try {
					if (await serialPass(record.id)) active = true;
				} catch (error) {
					await noteError(record, `a pass failed: ${messageOf(error)}`);
					active = true;
				}
			}
			return any ? now() + (active ? ACTIVE_TICK_MS : IDLE_TICK_MS) : undefined;
		},

		async view(record, webhookUrl, status) {
			const pools = status
				? await (async () => {
						const [jobs, machines] = await Promise.all([
							store.githubRunnerJobs.list({ integrationId: record.id }),
							store.githubRunnerMachines.list({ integrationId: record.id }),
						]);
						return record.pools.map((pool) => {
							const queued = jobs
								.filter((job) => job.state === "queued" && job.pool === pool.label)
								.sort((a, b) => a.queuedAt - b.queuedAt);
							const mine = machines.filter((machine) => machine.pool === pool.label);
							const backoff = Object.entries(record.backoff ?? {}).find(
								([key]) => key === pool.label || key.startsWith(`${pool.label} `),
							)?.[1];
							const oldest = queued[0];
							return {
								label: pool.label,
								queued: queued.length,
								starting: mine.filter((machine) => machine.state === "booting" || machine.state === "registering")
									.length,
								idle: mine.filter((machine) => machine.state === "idle").length,
								busy: mine.filter((machine) => machine.state === "busy").length,
								...(oldest === undefined ? {} : { waitingSince: oldest.queuedAt }),
								...(oldest !== undefined && backoff !== undefined
									? { waitingFor: backoff.reason }
									: oldest !== undefined && !record.enabled
										? { waitingFor: "The integration is disabled" }
										: {}),
							};
						});
					})()
				: undefined;
			return {
				id: record.id,
				accountId: record.accountId,
				name: record.name,
				appId: record.appId,
				owner: record.owner,
				scope: record.scope,
				...(record.runnerGroupId === undefined ? {} : { runnerGroupId: record.runnerGroupId }),
				...(record.repositories === undefined ? {} : { repositories: [...record.repositories] }),
				pools: record.pools.map(poolView),
				enabled: record.enabled,
				webhookUrl,
				...(record.installationId === undefined ? {} : { installationId: record.installationId }),
				...(record.lastWebhookAt === undefined ? {} : { lastWebhookAt: record.lastWebhookAt }),
				...(record.lastError === undefined ? {} : { lastError: record.lastError }),
				...(pools === undefined ? {} : { status: pools }),
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
			};
		},

		async seal(id, privateKey, webhookSecret) {
			const sealer = options.sealer();
			const secret = webhookSecret ?? bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, "");
			return {
				privateKey: await sealer.seal(privateKey, sealedAt("githubRunners", id, "privateKey")),
				webhookSecret: await sealer.seal(secret, sealedAt("githubRunners", id, "webhookSecret")),
				secret,
			};
		},

		async retire(integrationId) {
			const t = now();
			const marked = await store.githubRunners.update(integrationId, (current) =>
				current.retiringAt === undefined ? { ...current, enabled: false, retiringAt: t, updatedAt: t } : current,
			);
			if (marked === undefined) return true;
			return retireNow(integrationId);
		},

		async forgetAccount(accountId) {
			for (const record of await store.githubRunners.list({ accountId })) {
				for (const machine of await store.githubRunnerMachines.list({ integrationId: record.id })) {
					if (machine.tookJob !== true && machine.unregistered !== true) {
						await unregister(record, machine).catch((error: unknown) =>
							log(`[github-runners] runner ${machine.id} left on GitHub as its account went: ${messageOf(error)}`),
						);
					}
					await store.githubRunnerMachines.delete(machine.id);
				}
				for (const job of await store.githubRunnerJobs.list({ integrationId: record.id })) {
					await store.githubRunnerJobs.delete(job.id);
				}
				await store.githubRunners.delete(record.id);
				apps.delete(record.id);
			}
		},

		async jobs(integrationId) {
			const jobs = await store.githubRunnerJobs.list({ integrationId });
			return jobs
				.sort((a, b) => b.queuedAt - a.queuedAt || b.jobId - a.jobId)
				.slice(0, JOBS_LISTED)
				.map((job) => ({
					id: String(job.jobId),
					runId: job.runId,
					repository: job.repository,
					name: job.name,
					labels: [...job.labels],
					...(job.pool === undefined ? {} : { pool: job.pool }),
					state: job.state,
					...(job.conclusion === undefined ? {} : { conclusion: job.conclusion }),
					...(job.sandboxId === undefined ? {} : { sandboxId: job.sandboxId }),
					queuedAt: job.queuedAt,
					...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
					...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
					...(job.reason === undefined ? {} : { reason: job.reason }),
				}));
		},
	};
}

export const newGithubRunnersId = (): string => randomId("ghr");
