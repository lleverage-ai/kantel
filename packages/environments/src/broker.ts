/**
 * The environment broker: the one place that changes an environment. It keeps the record, drives the provider, and
 * hands sessions their grants and leases.
 *
 * - **Lifecycle is the environment's own.** A command from a session starts a stopped environment (start on first
 *   use) and waits for it; the console starts and stops it too. When the last lease ends the environment goes `idle`
 *   and `sweep` stops it once `idleTimeoutMs` has passed with no lease. A new machine idles the same way.
 * - **Grants and leases.** A session reaches an environment only through a grant, by its alias. The project's default
 *   grants a session the environments its person owns there (`sharing: "person"`, the default) and the project-wide
 *   ones, the first time it asks. A lease is taken by a command and renewed by every command after; one not renewed
 *   in `leaseTtlMs` expires. Each lease has its own worktree, `COMPOSE_PROJECT_NAME` and ten ports, so two sessions'
 *   services don't collide on one machine. An `exclusive` environment takes one lease at a time.
 * - **Resume latency** is timed from the start call to the machine answering up, kept as the last twenty starts, and
 *   reported as the last and the median.
 * - **Nothing of the provider reaches an agent**: `exec` answers with the command's output only. No credential value
 *   is ever sent to a machine; a machine that still holds its provider account's logins is refused.
 *
 * Changes to one environment are serialised in this process. The gateway runs one broker; two would need the store
 * to arbitrate.
 */
import {
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	type CreateEnvironmentInput,
	DEFAULT_ENVIRONMENT_LEASE_TTL_MS,
	ENVIRONMENT_SIZES,
	type Environment,
	type EnvironmentDetail,
	type EnvironmentEvent,
	type EnvironmentFilter,
	type EnvironmentGrant,
	type EnvironmentId,
	type EnvironmentLease,
	type EnvironmentLeaseEndReason,
	type EnvironmentProvider,
	type EnvironmentProviderKind,
	type EnvironmentSettings,
	environmentUp,
	type GrantEnvironmentInput,
	type JsonValue,
	KantelError,
	type MachineExecRequest,
	type MachineExecResult,
	type MachineStateReport,
	type ProjectAccess,
	type ProjectId,
	type SessionId,
	systemClock,
	systemContext,
	type Timestamp,
	type UpdateEnvironmentInput,
	type UserId,
} from "@kantel/contracts";
import type { EnvironmentStore, StoredEnvironment } from "./store.ts";

/** The session a command comes from, as the runtime knows it. */
export interface EnvironmentSession {
	readonly sessionId: SessionId;
	readonly organisationId: string;
	readonly projectId?: ProjectId;
	/** The person the session works for. */
	readonly userId?: UserId;
}

/** One alias a session may give `bash`'s `env`, with what the model is told about it. */
export interface SessionEnvironmentAlias {
	readonly alias: string;
	readonly description?: string;
}

export interface EnvironmentBrokerOptions {
	readonly store: EnvironmentStore;
	readonly providers: Partial<Record<EnvironmentProviderKind, EnvironmentProvider>>;
	/** The provider a new environment gets when it names none. */
	readonly defaultProvider: EnvironmentProviderKind;
	readonly settings: EnvironmentSettings;
	readonly access: () => ProjectAccess;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
	readonly leaseTtlMs?: number;
	/** How often a waiting start or stop reads the machine's state. Default 1 s. */
	readonly pollMs?: number;
	/** How long a command waits for its environment to start. Default five minutes. */
	readonly startTimeoutMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly log?: (message: string) => void;
}

export interface EnvironmentBroker {
	create(ctx: CallContext, input: CreateEnvironmentInput): Promise<Environment>;
	list(ctx: CallContext, filter?: EnvironmentFilter): Promise<readonly Environment[]>;
	get(ctx: CallContext, id: EnvironmentId): Promise<EnvironmentDetail>;
	update(ctx: CallContext, id: EnvironmentId, input: UpdateEnvironmentInput): Promise<Environment>;
	/** Starts it; resolves once the start is under way. */
	start(ctx: CallContext, id: EnvironmentId): Promise<Environment>;
	/** Stops it, ending its leases; resolves once the stop is under way. */
	stop(ctx: CallContext, id: EnvironmentId): Promise<Environment>;
	/** Removes the machine and its disk. The record stays, `destroyed`. */
	destroy(ctx: CallContext, id: EnvironmentId): Promise<Environment>;
	grant(ctx: CallContext, id: EnvironmentId, input: GrantEnvironmentInput): Promise<EnvironmentGrant>;
	revoke(ctx: CallContext, grantId: string): Promise<void>;

	/** The aliases a session may name, granting the project's defaults on first ask. */
	aliases(session: EnvironmentSession): Promise<readonly SessionEnvironmentAlias[]>;
	/**
	 * Runs a command for a session on the environment it calls `alias`: starts the environment if it is stopped and
	 * waits, takes or renews the session's lease, and runs the command in the session's worktree.
	 */
	exec(session: EnvironmentSession, alias: string, request: MachineExecRequest): Promise<MachineExecResult>;
	/** Ends a session's leases and grants: it ended. */
	release(sessionId: SessionId, reason?: EnvironmentLeaseEndReason): Promise<void>;

	/** Expires leases, idles and stops environments, and reads the state of any that is on its way. */
	sweep(): Promise<void>;
	/** A provider's report of a machine's state (a webhook). */
	report(report: MachineStateReport): Promise<void>;
}

const HOME = "/home/user";
const WORKTREES = `${HOME}/kantel/worktrees`;
const FIRST_PORT = 20_000;
const PORTS_PER_LEASE = 10;
const RESUME_SAMPLES = 20;
const DETAIL_EVENTS = 50;
const ALIAS = /^[a-z][a-z0-9-]{0,31}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const randomId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const monthOf = (at: Timestamp) => new Date(at).toISOString().slice(0, 7);

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[middle] ?? 0)
		: Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/** The session's own Compose project name: lowercase letters, digits and underscores, as Compose wants. */
export function composeProjectFor(sessionId: SessionId): string {
	return `kt_${sessionId
		.toLowerCase()
		.replace(/^ses_/, "")
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 24)}`;
}

/** A person's ID from an actor: a human's own, an agent's session's person when the caller knows it. */
function personOf(actor: Actor): UserId | undefined {
	return actor.kind === "human" ? actor.userId : undefined;
}

export function createEnvironmentBroker(options: EnvironmentBrokerOptions): EnvironmentBroker {
	const { store } = options;
	const clock = options.clock ?? systemClock;
	const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_ENVIRONMENT_LEASE_TTL_MS;
	const pollMs = options.pollMs ?? 1000;
	const startTimeoutMs = options.startTimeoutMs ?? 5 * 60_000;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const log = options.log ?? (() => undefined);
	const access = () => options.access();

	// One queue per environment: every change to it runs after the one before.
	const queues = new Map<EnvironmentId, Promise<unknown>>();
	function serial<T>(id: EnvironmentId, work: () => Promise<T>): Promise<T> {
		const before = queues.get(id) ?? Promise.resolve();
		const next = before.then(work, work);
		const settled = next.catch(() => undefined);
		queues.set(id, settled);
		void settled.then(() => {
			if (queues.get(id) === settled) queues.delete(id);
		});
		return next;
	}

	const providerOf = (stored: StoredEnvironment): EnvironmentProvider => {
		const provider = options.providers[stored.environment.provider];
		if (provider === undefined) {
			throw new KantelError("unavailable", `This deployment has no ${stored.environment.provider} provider configured`);
		}
		return provider;
	};
	const machineOf = (stored: StoredEnvironment) => {
		if (stored.machine === undefined) throw new KantelError("conflict", `${stored.environment.name} has no machine`);
		return stored.machine;
	};

	async function audit(
		actor: Actor,
		environment: Environment,
		type: string,
		data: { [key: string]: JsonValue } = {},
		sessionId?: SessionId,
	): Promise<void> {
		if (options.audit === undefined) return;
		const event: AuditEventInput = {
			id: `environments:${randomId("ev")}`,
			at: clock.now(),
			source: "environments",
			type,
			actor,
			organisationId: environment.organisationId,
			projectId: environment.owner.projectId,
			...(sessionId === undefined ? {} : { sessionId }),
			subject: { kind: "environment", id: environment.id },
			data: { name: environment.name, provider: environment.provider, egress: environment.egress, ...data },
		};
		try {
			await options.audit.append(systemContext("environments"), [event]);
		} catch (error) {
			log(`[environments] audit ${type} wasn't written: ${error}`);
		}
	}

	async function event(environmentId: EnvironmentId, entry: Omit<EnvironmentEvent, "at">) {
		await store.appendEvent(environmentId, { at: clock.now(), ...entry });
	}

	/** The record with its counters filled in: live leases, the month's running time, resume stats. */
	async function view(stored: StoredEnvironment): Promise<Environment> {
		const now = clock.now();
		const live = (await store.leases(stored.environment.id)).filter((lease) => lease.endedAt === undefined);
		const month = monthOf(now);
		const counted = stored.meter.month === month ? stored.meter.ms : 0;
		const since =
			stored.meter.since === undefined ? undefined : Math.max(stored.meter.since, Date.parse(`${month}-01T00:00:00Z`));
		const samples = stored.resumeSamples;
		const last = samples.at(-1);
		return {
			...stored.environment,
			leaseCount: live.length,
			runningMsThisMonth: counted + (since === undefined ? 0 : Math.max(0, now - since)),
			...(last === undefined ? {} : { resume: { lastMs: last, p50Ms: median(samples), samples: samples.length } }),
		};
	}

	async function load(id: EnvironmentId): Promise<StoredEnvironment> {
		const stored = await store.get(id);
		if (stored === undefined) throw new KantelError("not_found", `No environment ${id}`);
		return stored;
	}

	/** The environment, if the caller's organisation has it. Another organisation's is `not_found`. */
	async function visible(ctx: CallContext, id: EnvironmentId): Promise<StoredEnvironment> {
		const stored = await load(id);
		if (stored.environment.organisationId !== ctx.organisationId) {
			throw new KantelError("not_found", `No environment ${id}`);
		}
		return stored;
	}

	async function requireRole(
		ctx: CallContext,
		environment: Environment,
		needed: "viewer" | "operator" | "admin",
		operation: string,
	) {
		await access().require(ctx, {
			projectId: environment.owner.projectId,
			needed,
			operation,
			subject: { kind: "environment", id: environment.id },
		});
	}

	/** Changes the record, stamping it. */
	async function save(stored: StoredEnvironment, change: Partial<Environment>, extra: Partial<StoredEnvironment> = {}) {
		const next: StoredEnvironment = {
			...stored,
			...extra,
			environment: { ...stored.environment, ...change, updatedAt: clock.now() },
		};
		// `undefined` in a change clears the field.
		for (const key of Object.keys(change) as (keyof Environment)[]) {
			if (change[key] === undefined) delete (next.environment as Partial<Environment>)[key];
		}
		await store.put(next);
		return next;
	}

	/** The meter, with the machine up from now or down from now. */
	function meter(stored: StoredEnvironment, up: boolean): StoredEnvironment["meter"] {
		const now = clock.now();
		const month = monthOf(now);
		let ms = stored.meter.month === month ? stored.meter.ms : 0;
		if (stored.meter.since !== undefined) ms += now - Math.max(stored.meter.since, Date.parse(`${month}-01T00:00:00Z`));
		return up ? { month, ms, since: stored.meter.since ?? now } : { month, ms };
	}

	async function liveLeases(id: EnvironmentId) {
		return (await store.leases(id)).filter((lease) => lease.endedAt === undefined);
	}

	async function endLease(lease: EnvironmentLease, reason: EnvironmentLeaseEndReason, environment: Environment) {
		await store.putLease({ ...lease, endedAt: clock.now(), endReason: reason });
		await event(environment.id, { kind: "lease.ended", sessionId: lease.sessionId, reason });
		await audit(
			{ kind: "system", component: "environments" },
			environment,
			"environments.lease.ended",
			{ reason, commands: lease.commands },
			lease.sessionId,
		);
	}

	/** Up with no lease: idle, counting down from now. */
	async function idleIfFree(stored: StoredEnvironment): Promise<StoredEnvironment> {
		if (!environmentUp(stored.environment.state)) return stored;
		if ((await liveLeases(stored.environment.id)).length > 0) {
			return stored.environment.state === "running"
				? stored
				: save(stored, { state: "running", idleStopAt: undefined });
		}
		if (stored.environment.state === "idle") return stored;
		return save(stored, { state: "idle", idleStopAt: clock.now() + stored.environment.idleTimeoutMs });
	}

	/** The machine is up: record it, timing the start that brought it up. */
	async function cameUp(stored: StoredEnvironment): Promise<StoredEnvironment> {
		const now = clock.now();
		let samples = stored.resumeSamples;
		let durationMs: number | undefined;
		// A new machine's first boot is not a resume, and isn't counted as one.
		const wasCreating = stored.environment.state === "creating";
		if (stored.startingSince !== undefined && !wasCreating) {
			durationMs = now - stored.startingSince;
			samples = [...samples, durationMs].slice(-RESUME_SAMPLES);
		}
		const { startingSince: _, ...rest } = stored;
		// `idle` with no lease counts down; a lease taken next makes it `running`.
		const next = await save(
			{ ...rest, resumeSamples: samples },
			{ state: "idle", lastStartedAt: now, error: undefined, idleStopAt: now + stored.environment.idleTimeoutMs },
			{ meter: meter(stored, true) },
		);
		await event(stored.environment.id, { kind: "started", ...(durationMs === undefined ? {} : { durationMs }) });
		await audit({ kind: "system", component: "environments" }, next.environment, "environments.environment.started", {
			...(durationMs === undefined ? {} : { durationMs }),
		});
		return idleIfFree(next);
	}

	async function wentDown(
		stored: StoredEnvironment,
		reason: string | undefined,
		error?: string,
	): Promise<StoredEnvironment> {
		for (const lease of await liveLeases(stored.environment.id)) await endLease(lease, "stopped", stored.environment);
		const { startingSince: _, ...rest } = stored;
		const next = await save(
			rest,
			error === undefined
				? { state: "stopped", lastStoppedAt: clock.now(), idleStopAt: undefined, error: undefined }
				: { state: "error", error, idleStopAt: undefined },
			{ meter: meter(stored, false) },
		);
		if (error === undefined) {
			await event(stored.environment.id, { kind: "stopped", ...(reason === undefined ? {} : { reason }) });
			await audit({ kind: "system", component: "environments" }, next.environment, "environments.environment.stopped", {
				...(reason === undefined ? {} : { reason }),
			});
		} else {
			await event(stored.environment.id, { kind: "failed", message: error });
		}
		return next;
	}

	/** Reads the machine's state and moves the record to match. Serialised by the caller. */
	async function refresh(stored: StoredEnvironment): Promise<StoredEnvironment> {
		if (stored.machine === undefined || stored.environment.state === "destroyed") return stored;
		const state = await providerOf(stored).status(stored.machine);
		const current = stored.environment.state;
		if (state.holdsOwnerLogins === true) {
			// Stop it: the next start resumes it without the account's logins (boat's `noEnv` resume scrubs them).
			if (state.status === "running" || state.status === "starting") {
				await providerOf(stored)
					.stop(stored.machine)
					.catch(() => undefined);
			}
			return wentDown(stored, undefined, "The machine holds its provider account's logins; Kantel won't use it");
		}
		switch (state.status) {
			case "running":
				return environmentUp(current) ? idleIfFree(stored) : cameUp(stored);
			case "stopped":
				return current === "stopped" ? stored : wentDown(stored, current === "stopping" ? undefined : "provider");
			case "error":
				return current === "error" ? stored : wentDown(stored, undefined, state.error ?? "The machine failed");
			case "gone":
				return save(stored, { state: "destroyed", idleStopAt: undefined });
			default:
				return stored;
		}
	}

	/** Asks the provider to start the machine and records `starting`. Serialised by the caller. */
	async function beginStart(
		stored: StoredEnvironment,
		actor: Actor,
		sessionId?: SessionId,
	): Promise<StoredEnvironment> {
		const machine = machineOf(stored);
		const startedAt = clock.now();
		await event(stored.environment.id, { kind: "starting", actor, ...(sessionId === undefined ? {} : { sessionId }) });
		try {
			const state = await providerOf(stored).start(machine);
			if (state.holdsOwnerLogins === true) {
				throw new KantelError("refused", "The machine holds its provider account's logins; Kantel won't use it");
			}
			const next = await save(
				stored,
				{ state: "starting", error: undefined, idleStopAt: undefined },
				{ startingSince: startedAt },
			);
			if (state.status === "running") return cameUp(next);
			return next;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await wentDown(stored, undefined, message);
			throw error;
		}
	}

	async function beginStop(stored: StoredEnvironment, actor: Actor, reason?: string): Promise<StoredEnvironment> {
		const machine = machineOf(stored);
		for (const lease of await liveLeases(stored.environment.id)) await endLease(lease, "stopped", stored.environment);
		await event(stored.environment.id, { kind: "stopping", actor, ...(reason === undefined ? {} : { reason }) });
		const state = await providerOf(stored).stop(machine);
		const next = await save(stored, { state: "stopping", idleStopAt: undefined });
		if (state.status === "stopped") return wentDown(next, reason);
		return next;
	}

	/** Waits, outside the queue, until the environment is up; starts it if nobody has. */
	async function ensureUp(id: EnvironmentId, actor: Actor, sessionId: SessionId): Promise<StoredEnvironment> {
		const deadline = clock.now() + startTimeoutMs;
		for (;;) {
			const stored = await serial(id, async () => {
				let current = await load(id);
				if (current.environment.state === "destroyed") {
					throw new KantelError("expired", `${current.environment.name} was destroyed`);
				}
				if (["starting", "creating", "stopping"].includes(current.environment.state)) current = await refresh(current);
				if (current.environment.state === "stopped" || current.environment.state === "error") {
					current = await beginStart(current, actor, sessionId);
				}
				return current;
			});
			if (environmentUp(stored.environment.state)) return stored;
			if (clock.now() > deadline) {
				throw new KantelError("unavailable", `${stored.environment.name} didn't start in time; try again`);
			}
			await sleep(pollMs);
		}
	}

	/** Grants a session the project's default environments it doesn't have yet. */
	async function defaultGrants(session: EnvironmentSession): Promise<readonly EnvironmentGrant[]> {
		const existing = await store.sessionGrants(session.sessionId);
		if (session.projectId === undefined) return existing.filter((grant) => grant.status === "active");
		const have = new Set(existing.map((grant) => grant.environmentId));
		const taken = new Set(existing.filter((grant) => grant.status === "active").map((grant) => grant.alias));
		const added: EnvironmentGrant[] = [];
		for (const stored of await store.list(session.organisationId)) {
			const environment = stored.environment;
			if (environment.state === "destroyed" || environment.owner.projectId !== session.projectId) continue;
			if (have.has(environment.id) || taken.has(environment.alias)) continue;
			const owner = environment.owner.userId;
			if (owner !== undefined && owner !== session.userId) continue;
			const grant: EnvironmentGrant = {
				id: randomId("eng"),
				organisationId: session.organisationId,
				environmentId: environment.id,
				sessionId: session.sessionId,
				alias: environment.alias,
				rights: "worktree",
				grantedBy: { kind: "system", component: "environments.default" },
				createdAt: clock.now(),
				status: "active",
			};
			await store.putGrant(grant);
			await event(environment.id, { kind: "granted", sessionId: session.sessionId });
			taken.add(grant.alias);
			added.push(grant);
		}
		return [...existing.filter((grant) => grant.status === "active"), ...added];
	}

	async function takeLease(stored: StoredEnvironment, session: EnvironmentSession, grant: EnvironmentGrant) {
		const live = await liveLeases(stored.environment.id);
		const now = clock.now();
		const mine = live.find((lease) => lease.sessionId === session.sessionId);
		if (mine !== undefined) {
			const renewed = { ...mine, renewedAt: now, expiresAt: now + leaseTtlMs, commands: mine.commands + 1 };
			await store.putLease(renewed);
			return { lease: renewed, fresh: false };
		}
		if (stored.environment.sharing === "exclusive" && live.length > 0) {
			throw new KantelError(
				"conflict",
				`${stored.environment.name} is in use by another session; it takes one at a time`,
			);
		}
		const used = new Set(live.map((lease) => (lease.portBase - FIRST_PORT) / PORTS_PER_LEASE));
		let slot = 0;
		while (used.has(slot)) slot += 1;
		const lease: EnvironmentLease = {
			id: randomId("enl"),
			environmentId: stored.environment.id,
			sessionId: session.sessionId,
			grantId: grant.id,
			worktree: `${WORKTREES}/${session.sessionId}`,
			composeProject: composeProjectFor(session.sessionId),
			portBase: FIRST_PORT + slot * PORTS_PER_LEASE,
			acquiredAt: now,
			renewedAt: now,
			expiresAt: now + leaseTtlMs,
			commands: 1,
		};
		await store.putLease(lease);
		await event(stored.environment.id, { kind: "lease.acquired", sessionId: session.sessionId });
		await audit(
			{ kind: "system", component: "environments" },
			stored.environment,
			"environments.lease.acquired",
			{ composeProject: lease.composeProject, portBase: lease.portBase },
			session.sessionId,
		);
		return { lease, fresh: true };
	}

	/** The variables a command in a lease sees. Never a secret. */
	function leaseEnv(environment: Environment, lease: EnvironmentLease): Record<string, string> {
		return {
			COMPOSE_PROJECT_NAME: lease.composeProject,
			KANTEL_PORT_BASE: String(lease.portBase),
			KANTEL_WORKTREE: lease.worktree,
			KANTEL_ENVIRONMENT: environment.alias,
			KANTEL_EGRESS: environment.egress,
		};
	}

	/** A session's working directory: its worktree, or a path under it. */
	function cwdFor(lease: EnvironmentLease, cwd: string | undefined): string {
		if (cwd === undefined || cwd === "" || cwd === ".") return lease.worktree;
		const path = cwd.startsWith("/") ? cwd : `${lease.worktree}/${cwd}`;
		return path;
	}

	const broker: EnvironmentBroker = {
		async create(ctx, input) {
			if (ctx.actor.kind === "agent") throw new KantelError("forbidden", "An agent can't create environments");
			const name = input.name.trim().toLowerCase();
			if (!NAME.test(name)) throw new KantelError("invalid", "A name is lowercase letters, digits and dashes");
			const alias = (input.alias ?? "dev").trim().toLowerCase();
			if (!ALIAS.test(alias)) throw new KantelError("invalid", "An alias is a lowercase word, such as dev");
			const kind = input.provider ?? options.defaultProvider;
			const provider = options.providers[kind];
			if (provider === undefined) throw new KantelError("unavailable", `No ${kind} provider is configured`);
			const sizeName = input.size ?? "default";
			if (!provider.capabilities().sizes.includes(sizeName)) {
				throw new KantelError("not_supported", `${kind} has no ${sizeName} size`);
			}
			await access().require(ctx, { projectId: input.projectId, needed: "operator", operation: "environments.create" });
			const siblings = (await store.list(ctx.organisationId)).filter(
				(stored) => stored.environment.owner.projectId === input.projectId && stored.environment.state !== "destroyed",
			);
			if (siblings.some((stored) => stored.environment.name === name)) {
				throw new KantelError("conflict", `The project already has an environment called ${name}`);
			}
			const userId = input.projectWide === true ? undefined : personOf(ctx.actor);
			const sharing = input.sharing ?? (options.settings.sharing === "exclusive" ? "exclusive" : "shared");
			const idleTimeoutMs = input.idleTimeoutMs ?? options.settings.idleTimeoutMs;
			if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 60_000) {
				throw new KantelError("invalid", "The idle timeout is at least a minute");
			}
			const capabilities = provider.capabilities();
			const now = clock.now();
			const environment: Environment = {
				id: randomId("env"),
				organisationId: ctx.organisationId,
				owner: { projectId: input.projectId, ...(userId === undefined ? {} : { userId }) },
				name,
				alias,
				...(input.description === undefined ? {} : { description: input.description }),
				provider: kind,
				size: ENVIRONMENT_SIZES[sizeName],
				definition: { version: 1, ...input.definition },
				sharing,
				egress: capabilities.egress,
				placeholders: capabilities.egress === "managed" || options.settings.placeholders === "unmanaged",
				idleTimeoutMs,
				state: "creating",
				createdAt: now,
				createdBy: ctx.actor,
				updatedAt: now,
				leaseCount: 0,
				runningMsThisMonth: 0,
			};
			let stored: StoredEnvironment = { environment, resumeSamples: [], meter: { month: monthOf(now), ms: 0 } };
			await store.put(stored);
			return serial(environment.id, async () => {
				try {
					const machine = await provider.create({
						environmentId: environment.id,
						name: environment.name,
						size: sizeName,
						definition: environment.definition,
						labels: { "kantel.organisation": ctx.organisationId, "kantel.project": input.projectId },
					});
					stored = await save(stored, {}, { machine, startingSince: now });
				} catch (error) {
					await save(stored, { state: "error", error: error instanceof Error ? error.message : String(error) });
					throw error;
				}
				await event(environment.id, { kind: "created", actor: ctx.actor });
				await audit(ctx.actor, environment, "environments.environment.created", { size: sizeName, sharing });
				return view(await refresh(stored));
			});
		},

		async list(ctx, filter) {
			const all = (await store.list(ctx.organisationId)).filter(
				(stored) =>
					stored.environment.state !== "destroyed" &&
					(filter?.projectId === undefined || stored.environment.owner.projectId === filter.projectId),
			);
			const allowed = await Promise.all(
				all.map((stored) => access().allows(ctx, { projectId: stored.environment.owner.projectId, needed: "viewer" })),
			);
			const shown = all.filter((_, index) => allowed[index]);
			const views = await Promise.all(shown.map(view));
			return views.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		},

		async get(ctx, id) {
			const stored = await visible(ctx, id);
			await requireRole(ctx, stored.environment, "viewer", "environments.read");
			const leases = (await store.leases(id))
				.filter((lease) => lease.endedAt === undefined)
				.sort((a, b) => b.acquiredAt - a.acquiredAt);
			const grants = (await store.grants(id)).filter((grant) => grant.status === "active");
			return { environment: await view(stored), leases, grants, events: await store.events(id, DETAIL_EVENTS) };
		},

		async update(ctx, id, input) {
			const stored = await visible(ctx, id);
			await requireRole(ctx, stored.environment, "operator", "environments.update");
			return serial(id, async () => {
				const current = await load(id);
				const change: Partial<Environment> = {};
				if (input.description !== undefined) Object.assign(change, { description: input.description });
				if (input.idleTimeoutMs !== undefined) {
					if (input.idleTimeoutMs < 60_000) throw new KantelError("invalid", "The idle timeout is at least a minute");
					Object.assign(change, { idleTimeoutMs: input.idleTimeoutMs });
				}
				// A new size applies at the next start.
				if (input.size !== undefined) Object.assign(change, { size: ENVIRONMENT_SIZES[input.size] });
				return view(await save(current, change));
			});
		},

		async start(ctx, id) {
			const stored = await visible(ctx, id);
			await requireRole(ctx, stored.environment, "operator", "environments.start");
			return serial(id, async () => {
				const current = await load(id);
				if (current.environment.state === "destroyed") throw new KantelError("expired", "It was destroyed");
				if (current.environment.state !== "stopped" && current.environment.state !== "error") return view(current);
				return view(await beginStart(current, ctx.actor));
			});
		},

		async stop(ctx, id) {
			const stored = await visible(ctx, id);
			await requireRole(ctx, stored.environment, "operator", "environments.stop");
			return serial(id, async () => {
				const current = await load(id);
				if (!environmentUp(current.environment.state)) return view(current);
				return view(await beginStop(current, ctx.actor));
			});
		},

		async destroy(ctx, id) {
			const stored = await visible(ctx, id);
			await requireRole(ctx, stored.environment, "admin", "environments.destroy");
			return serial(id, async () => {
				const current = await load(id);
				if (current.environment.state === "destroyed") return view(current);
				for (const lease of await liveLeases(id)) await endLease(lease, "revoked", current.environment);
				for (const grant of await store.grants(id)) {
					if (grant.status === "active") await store.putGrant({ ...grant, status: "revoked" });
				}
				if (current.machine !== undefined) await providerOf(current).destroy(current.machine);
				const next = await save(
					current,
					{ state: "destroyed", idleStopAt: undefined },
					{ meter: meter(current, false) },
				);
				await event(id, { kind: "destroyed", actor: ctx.actor });
				await audit(ctx.actor, next.environment, "environments.environment.destroyed");
				return view(next);
			});
		},

		async grant(ctx, id, input) {
			const stored = await visible(ctx, id);
			if (stored.environment.state === "destroyed") throw new KantelError("expired", "It was destroyed");
			await access().require(ctx, {
				projectId: stored.environment.owner.projectId,
				sessionId: input.sessionId,
				needed: "operator",
				operation: "environments.grant",
				subject: { kind: "environment", id },
			});
			const alias = (input.alias ?? stored.environment.alias).toLowerCase();
			if (!ALIAS.test(alias)) throw new KantelError("invalid", "An alias is a lowercase word, such as dev");
			return serial(id, async () => {
				const held = (await store.sessionGrants(input.sessionId)).filter((grant) => grant.status === "active");
				const same = held.find((grant) => grant.environmentId === id);
				if (same !== undefined) return same;
				if (held.some((grant) => grant.alias === alias)) {
					throw new KantelError("conflict", `The session already has an environment called ${alias}`);
				}
				const grant: EnvironmentGrant = {
					id: randomId("eng"),
					organisationId: ctx.organisationId,
					environmentId: id,
					sessionId: input.sessionId,
					alias,
					rights: input.rights ?? "worktree",
					grantedBy: ctx.actor,
					createdAt: clock.now(),
					status: "active",
				};
				await store.putGrant(grant);
				await event(id, { kind: "granted", actor: ctx.actor, sessionId: input.sessionId });
				await audit(ctx.actor, stored.environment, "environments.grant.created", { alias }, input.sessionId);
				return grant;
			});
		},

		async revoke(ctx, grantId) {
			const all = await Promise.all((await store.list(ctx.organisationId)).map((s) => store.grants(s.environment.id)));
			const grant = all.flat().find((candidate) => candidate.id === grantId);
			if (grant === undefined) throw new KantelError("not_found", `No grant ${grantId}`);
			const stored = await visible(ctx, grant.environmentId);
			await requireRole(ctx, stored.environment, "operator", "environments.revoke");
			await serial(grant.environmentId, async () => {
				await store.putGrant({ ...grant, status: "revoked" });
				for (const lease of await liveLeases(grant.environmentId)) {
					if (lease.grantId === grantId) await endLease(lease, "revoked", stored.environment);
				}
				await event(grant.environmentId, { kind: "revoked", actor: ctx.actor, sessionId: grant.sessionId });
				await audit(
					ctx.actor,
					stored.environment,
					"environments.grant.revoked",
					{ alias: grant.alias },
					grant.sessionId,
				);
				await idleIfFree(await load(grant.environmentId));
			});
		},

		async aliases(session) {
			const grants = await defaultGrants(session);
			const out: SessionEnvironmentAlias[] = [];
			for (const grant of grants) {
				const stored = await store.get(grant.environmentId);
				if (stored === undefined || stored.environment.state === "destroyed") continue;
				out.push({
					alias: grant.alias,
					...(stored.environment.description === undefined ? {} : { description: stored.environment.description }),
				});
			}
			return out;
		},

		async exec(session, alias, request) {
			const grants = await defaultGrants(session);
			const grant = grants.find((candidate) => candidate.alias === alias);
			if (grant === undefined) {
				const known = grants.map((candidate) => candidate.alias);
				throw new KantelError(
					"not_found",
					known.length === 0
						? "This session has no environments. Leave out env to run the command in the session's own sandbox."
						: `This session has no environment called ${alias}. It has: ${known.join(", ")}.`,
				);
			}
			const actor: Actor = { kind: "system", component: "environments" };
			for (let attempt = 0; attempt < 2; attempt++) {
				await ensureUp(grant.environmentId, actor, session.sessionId);
				const held = await serial(grant.environmentId, async () => {
					let current = await load(grant.environmentId);
					// Stopped again while the command waited: go round and start it.
					if (!environmentUp(current.environment.state)) return undefined;
					const taken = await takeLease(current, session, grant);
					if (current.environment.state !== "running") {
						current = await save(current, { state: "running", idleStopAt: undefined });
					}
					const provider = providerOf(current);
					const machine = machineOf(current);
					if (taken.fresh) {
						// The session's own directory, made once per lease.
						await provider.exec(machine, { command: `mkdir -p ${taken.lease.worktree}`, timeoutMs: 30_000 });
					}
					return { lease: taken.lease, environment: current.environment, machine, provider };
				});
				if (held === undefined) continue;
				const { lease, environment, machine, provider } = held;
				try {
					return await provider.exec(machine, {
						...request,
						cwd: cwdFor(lease, request.cwd),
						env: { ...leaseEnv(environment, lease), ...request.env },
					});
				} catch (error) {
					// The machine stopped behind Kantel's back (the provider's own auto-stop): read it, start it, try once more.
					if (attempt === 0 && error instanceof KantelError && error.code === "conflict") {
						const down = await serial(grant.environmentId, async () => refresh(await load(grant.environmentId)));
						if (!environmentUp(down.environment.state)) continue;
					}
					throw error;
				}
			}
			throw new KantelError("unavailable", `The environment ${alias} kept stopping; try the command again`);
		},

		async release(sessionId, reason = "session_ended") {
			const leases = (await store.sessionLeases(sessionId)).filter((lease) => lease.endedAt === undefined);
			for (const lease of leases) {
				await serial(lease.environmentId, async () => {
					const stored = await load(lease.environmentId);
					await endLease(lease, reason, stored.environment);
					await idleIfFree(stored);
				});
			}
			for (const grant of await store.sessionGrants(sessionId)) {
				if (grant.status === "active") await store.putGrant({ ...grant, status: "ended" });
			}
		},

		async sweep() {
			const now = clock.now();
			for (const { environment } of await store.list()) {
				if (environment.state === "destroyed") continue;
				try {
					await serial(environment.id, async () => {
						let stored = await load(environment.id);
						for (const lease of await liveLeases(environment.id)) {
							if (lease.expiresAt <= now) await endLease(lease, "expired", stored.environment);
						}
						const state = stored.environment.state;
						if (state === "creating" || state === "starting" || state === "stopping") {
							stored = await refresh(stored);
						} else if (environmentUp(state)) {
							stored = await idleIfFree(stored);
						}
						const at = stored.environment.idleStopAt;
						if (stored.environment.state === "idle" && at !== undefined && at <= now) {
							stored = await beginStop(stored, { kind: "system", component: "environments.idle" }, "idle");
						}
					});
				} catch (error) {
					log(`[environments] sweeping ${environment.name} failed: ${error instanceof Error ? error.message : error}`);
				}
			}
		},

		async report(report) {
			const found = await store.byMachine(report.ref.machineId);
			if (found === undefined) return;
			await serial(found.environment.id, async () => {
				const stored = await load(found.environment.id);
				if (report.deliveryId !== undefined && stored.deliveries?.includes(report.deliveryId)) return;
				// A report older than the record's last change says nothing new; read the machine instead.
				const next = await refresh(stored);
				if (report.deliveryId !== undefined) {
					await store.put({ ...next, deliveries: [...(next.deliveries ?? []), report.deliveryId].slice(-50) });
				}
			});
		},
	};
	return broker;
}
