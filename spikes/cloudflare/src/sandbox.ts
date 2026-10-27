/**
 * `Sandboxes` (from @harbour/contracts) for the Cloudflare spike: lease bookkeeping, routing through the contract's
 * tier table, and commits, over two tier backends.
 *
 * - Isolate: a Dynamic Worker running just-bash. It returns what a command changed; this module commits it at once.
 * - Container: a Container Durable Object. It keeps its own working copy, re-based on the head before every command
 *   so it sees the isolate's last write, and its changes are committed when the lease is released.
 *
 * One addition to the contract, so a session sees one tree in both directions: `run` routing a command to the isolate
 * first commits the session's live container lease (a checkpoint; the lease stays live). The contract guarantees the
 * isolate-to-container direction only; see the README's reconciliation notes.
 *
 * Leases live in a `LeaseStore`: a Map in tests, the session Durable Object's SQLite when deployed, so a restarted
 * object still knows its leases.
 */
import {
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	DEFAULT_TIER_ROUTES,
	type ExecRequest,
	type ExecResult,
	HarbourError,
	isHarbourError,
	type LeaseEndReason,
	type Sandboxes,
	type SandboxLease,
	type SandboxTier,
	type SandboxUsage,
	type SessionId,
	systemClock,
	type TierRoute,
	type WorkspaceRecord,
} from "@harbour/contracts";
import { routeTool } from "@harbour/sandbox";
import { normalizeWorkspacePath } from "@harbour/workspace";
import { listAll, type ModedChange, type ObjectStoreWorkspaces } from "./workspace.ts";

const DEFAULT_TTL_MS = 15 * 60_000;
const TIERS: readonly SandboxTier[] = ["isolate", "container"];
const SWEEPER: Actor = { kind: "system", component: "sandbox.sweeper" };
const FLUSH_ATTEMPTS = 3;

/** One command on a tier, as a backend sees it. */
export interface BackendExec {
	readonly ctx: CallContext;
	readonly lease: SandboxLease;
	/** The workspace at its current head, mounts included. */
	readonly record: WorkspaceRecord;
	readonly request: ExecRequest;
}

export interface BackendOutput {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly truncated?: boolean;
	/** Milliseconds per phase, for the cold-start tables. */
	readonly timings?: Record<string, number>;
	/** Isolate only: what the command changed, relative to `record.head`, for this module to commit. */
	readonly changes?: readonly ModedChange[];
}

export interface IsolateBackend {
	exec(input: BackendExec): Promise<BackendOutput>;
}

export interface ContainerBackend {
	/** Runs a command on the lease's working copy, re-based on `record.head`. Changes stay in the container. */
	exec(input: BackendExec): Promise<BackendOutput>;
	/**
	 * Re-bases the working copy on `record.head` and returns its uncommitted changes relative to it, with a stamp that
	 * names exactly this set of changes.
	 */
	pending(input: Omit<BackendExec, "request">): Promise<PendingChanges>;
	/**
	 * The changes `pending` returned with `stamp` are committed as `version`. Changes the container made after that
	 * `pending` (a command that ran meanwhile) stay pending.
	 */
	committed(lease: SandboxLease, version: number, stamp: number): Promise<void>;
	/** The lease ended. `discard` drops uncommitted changes (an expired lease is never committed). */
	ended(lease: SandboxLease, options: { readonly discard: boolean }): Promise<void>;
}

export interface PendingChanges {
	readonly changes: readonly ModedChange[];
	readonly stamp: number;
}

/** What the store keeps per lease. */
export interface LeaseRow {
	readonly lease: SandboxLease;
	readonly organisationId: string;
	readonly projectId?: string;
	readonly busyMs: number;
}

export interface LeaseStore {
	get(id: string): LeaseRow | undefined;
	put(row: LeaseRow): void;
	all(): Iterable<LeaseRow>;
	/** Whether escalation to the container was audited for this key; marks it when `mark` is set. */
	escalated(key: string, mark: boolean): boolean;
}

export class MemoryLeaseStore implements LeaseStore {
	readonly #rows = new Map<string, LeaseRow>();
	readonly #escalated = new Set<string>();
	get(id: string) {
		return this.#rows.get(id);
	}
	put(row: LeaseRow) {
		this.#rows.set(row.lease.id, row);
	}
	all() {
		return this.#rows.values();
	}
	escalated(key: string, mark: boolean) {
		const seen = this.#escalated.has(key);
		if (mark) this.#escalated.add(key);
		return seen;
	}
}

export interface CloudflareSandboxesOptions {
	readonly workspaces: ObjectStoreWorkspaces;
	readonly isolate: IsolateBackend;
	readonly container: ContainerBackend;
	readonly leases?: LeaseStore;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	readonly routes?: readonly TierRoute[];
	readonly defaultTtlMs?: number;
}

/** The contract's result plus what the spike's exec log and cold-start tables use. */
export type SpikeExecResult = ExecResult & {
	readonly baseVersion: number;
	readonly timings: Record<string, number>;
};

export class CloudflareSandboxes implements Sandboxes {
	readonly #workspaces: ObjectStoreWorkspaces;
	readonly #isolate: IsolateBackend;
	readonly #container: ContainerBackend;
	readonly #leases: LeaseStore;
	readonly #clock: Clock;
	readonly #audit: AuditSink | undefined;
	readonly #routes: readonly TierRoute[];
	readonly #defaultTtlMs: number;
	/** Releases in flight, so concurrent releases of one lease commit once. */
	readonly #releasing = new Map<string, Promise<SandboxLease>>();

	constructor(options: CloudflareSandboxesOptions) {
		this.#workspaces = options.workspaces;
		this.#isolate = options.isolate;
		this.#container = options.container;
		this.#leases = options.leases ?? new MemoryLeaseStore();
		this.#clock = options.clock ?? systemClock;
		this.#audit = options.audit;
		this.#routes = options.routes ?? DEFAULT_TIER_ROUTES;
		this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
	}

	route(tool: string, command?: string | readonly string[]): SandboxTier {
		return routeTool(this.#routes, tool, command);
	}

	async acquire(ctx: CallContext, input: Parameters<Sandboxes["acquire"]>[1]): Promise<SandboxLease> {
		const ttlMs = this.#ttl(input.ttlMs);
		if (!TIERS.includes(input.tier)) throw new HarbourError("invalid", `unknown tier ${String(input.tier)}`);
		const record = await this.#workspaces.get(ctx, input.workspaceId);
		const expired: AuditEventInput[] = [];
		const existing = await this.#liveLease(ctx.organisationId, input.sessionId, input.tier, expired);
		await this.#emit(expired);
		if (existing !== undefined) {
			throw new HarbourError("conflict", `session ${input.sessionId} already holds a live ${input.tier} lease`, {
				leaseId: existing.lease.id,
			});
		}
		const now = this.#clock.now();
		const lease: SandboxLease = {
			id: `lease_${crypto.randomUUID()}`,
			sessionId: input.sessionId,
			workspaceId: input.workspaceId,
			tier: input.tier,
			baseVersion: record.head,
			acquiredAt: now,
			expiresAt: now + ttlMs,
		};
		const row: LeaseRow = {
			lease,
			organisationId: ctx.organisationId,
			...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			busyMs: 0,
		};
		this.#leases.put(row);
		await this.#emit([
			this.#event(row, ctx.actor, {
				id: `sandbox:lease:${lease.id}:acquired`,
				type: "sandbox.lease.acquired",
				subject: { kind: "sandbox.lease", id: lease.id },
				data: {
					tier: lease.tier,
					workspaceId: lease.workspaceId,
					baseVersion: lease.baseVersion,
					expiresAt: lease.expiresAt,
				},
			}),
		]);
		return lease;
	}

	async renew(ctx: CallContext, leaseId: string, ttlMs: number): Promise<SandboxLease> {
		const value = this.#ttl(ttlMs);
		const row = await this.#requireLive(ctx, leaseId);
		const lease = { ...row.lease, expiresAt: this.#clock.now() + value };
		this.#leases.put({ ...row, lease });
		return lease;
	}

	async release(ctx: CallContext, leaseId: string, reason: LeaseEndReason = "released"): Promise<SandboxLease> {
		const row = this.#load(ctx, leaseId);
		if (row.lease.endedAt !== undefined) return row.lease;
		let releasing = this.#releasing.get(leaseId);
		if (releasing === undefined) {
			releasing = this.#doRelease(ctx, row, reason).finally(() => this.#releasing.delete(leaseId));
			this.#releasing.set(leaseId, releasing);
		}
		return releasing;
	}

	async exec(ctx: CallContext, leaseId: string, request: ExecRequest): Promise<SpikeExecResult> {
		const row = await this.#requireLive(ctx, leaseId);
		return this.#execOn(ctx, row, request);
	}

	async run(ctx: CallContext, input: Parameters<Sandboxes["run"]>[1]): Promise<SpikeExecResult> {
		return this.runOn(ctx, { ...input, tier: this.route(input.tool, input.request.command) });
	}

	/**
	 * `run` on a tier the caller picks instead of the table: for the spike's measurement route, which times each tier.
	 * Not part of the contract.
	 */
	async runOn(
		ctx: CallContext,
		input: Parameters<Sandboxes["run"]>[1] & { readonly tier: SandboxTier },
	): Promise<SpikeExecResult> {
		const { tier } = input;
		const expired: AuditEventInput[] = [];
		let row = await this.#liveLease(ctx.organisationId, input.sessionId, tier, expired);
		await this.#emit(expired);
		if (row !== undefined && row.lease.workspaceId !== input.workspaceId) {
			throw new HarbourError("conflict", `the session's ${tier} lease is on another workspace`, {
				leaseId: row.lease.id,
			});
		}
		if (row === undefined) {
			const lease = await this.acquire(ctx, { sessionId: input.sessionId, workspaceId: input.workspaceId, tier });
			row = this.#leases.get(lease.id)!;
		}
		if (tier === "container") {
			const key = `${ctx.organisationId}\u0000${input.sessionId}`;
			if (!this.#leases.escalated(key, true)) {
				await this.#emit([
					this.#event(row, ctx.actor, {
						id: `sandbox:escalated:${ctx.organisationId}:${input.sessionId}`,
						type: "sandbox.escalated",
						subject: { kind: "session", id: input.sessionId },
						data: { tool: input.tool, leaseId: row.lease.id, workspaceId: input.workspaceId },
					}),
				]);
			}
		} else {
			// The mirror of the contract's rule: the isolate sees the container's last write.
			const container = await this.#liveLease(ctx.organisationId, input.sessionId, "container", []);
			if (container !== undefined && container.lease.workspaceId === input.workspaceId) {
				await this.#flush(ctx, container);
			}
		}
		return this.#execOn(ctx, row, input.request);
	}

	async leases(ctx: CallContext, filter: Parameters<Sandboxes["leases"]>[1]): Promise<readonly SandboxLease[]> {
		const found: SandboxLease[] = [];
		for (const row of this.#leases.all()) {
			if (row.organisationId !== ctx.organisationId || row.lease.sessionId !== filter.sessionId) continue;
			const live = row.lease.endedAt === undefined && !this.#pastTtl(row);
			if (filter.live === undefined || filter.live === live) found.push(row.lease);
		}
		return found.sort((left, right) => left.acquiredAt - right.acquiredAt);
	}

	async releaseSession(ctx: CallContext, sessionId: SessionId, reason: LeaseEndReason = "session_ended") {
		for (const row of [...this.#leases.all()]) {
			if (row.organisationId !== ctx.organisationId || row.lease.sessionId !== sessionId) continue;
			if (row.lease.endedAt !== undefined) continue;
			await this.release(ctx, row.lease.id, reason);
		}
	}

	async sweep(): Promise<readonly SandboxLease[]> {
		const swept: SandboxLease[] = [];
		const events: AuditEventInput[] = [];
		for (const row of [...this.#leases.all()]) {
			if (this.#releasing.has(row.lease.id) || !this.#pastTtl(row)) continue;
			const ended = await this.#end(row, "expired", SWEEPER);
			events.push(ended.event);
			swept.push(ended.lease);
		}
		await this.#emit(events);
		return swept;
	}

	async usage(ctx: CallContext, sessionId: SessionId): Promise<readonly SandboxUsage[]> {
		const now = this.#clock.now();
		const usage = new Map(TIERS.map((tier) => [tier, { leases: 0, heldMs: 0, busyMs: 0 }]));
		for (const row of this.#leases.all()) {
			if (row.organisationId !== ctx.organisationId || row.lease.sessionId !== sessionId) continue;
			const totals = usage.get(row.lease.tier)!;
			totals.leases++;
			totals.heldMs += (row.lease.endedAt ?? now) - row.lease.acquiredAt;
			totals.busyMs += row.busyMs;
		}
		return [...usage].map(([tier, totals]): SandboxUsage => ({ tier, ...totals }));
	}

	// ---- internals ---------------------------------------------------------------------------------------------------

	async #doRelease(ctx: CallContext, row: LeaseRow, reason: LeaseEndReason): Promise<SandboxLease> {
		if (this.#pastTtl(row) || reason === "expired") {
			// Expired leases are discarded, not committed.
			const ended = await this.#end(row, "expired", ctx.actor);
			await this.#emit([ended.event]);
			return ended.lease;
		}
		const committedVersion = row.lease.tier === "container" ? await this.#flush(ctx, row) : undefined;
		const ended = await this.#end(this.#leases.get(row.lease.id) ?? row, reason, ctx.actor, committedVersion);
		await this.#emit([ended.event]);
		return ended.lease;
	}

	/** Commits a container lease's working copy on top of the head. Returns the new version, if anything changed. */
	async #flush(ctx: CallContext, row: LeaseRow): Promise<number | undefined> {
		const { lease } = row;
		for (let attempt = 1; ; attempt++) {
			const record = await this.#workspaces.get(ctx, lease.workspaceId);
			const { changes: pending, stamp } = await this.#container.pending({ ctx, lease, record });
			if (pending.length === 0) return undefined;
			const present = new Set(
				(await listAll(this.#workspaces, ctx, lease.workspaceId, { version: record.head }))
					.filter((entry) => entry.kind === "file")
					.map((entry) => entry.path),
			);
			const changes = containerWins(pending, present);
			if (changes.length === 0) {
				await this.#container.committed(lease, record.head, stamp);
				return undefined;
			}
			try {
				const result = await this.#workspaces.commit(ctx, lease.workspaceId, {
					baseVersion: record.head,
					changes,
					writer: { sessionId: lease.sessionId, leaseId: lease.id },
					message: `container lease ${lease.id}`,
				});
				await this.#container.committed(lease, result.version, stamp);
				return result.version;
			} catch (error) {
				// Another writer moved the head between the re-base and the commit: re-base again.
				if (!isHarbourError(error, "conflict") || attempt >= FLUSH_ATTEMPTS) throw error;
			}
		}
	}

	async #execOn(ctx: CallContext, row: LeaseRow, request: ExecRequest): Promise<SpikeExecResult> {
		const { lease } = row;
		const record = await this.#workspaces.get(ctx, lease.workspaceId);
		const { cwd, ...rest } = request;
		const normalized: ExecRequest =
			cwd === undefined || cwd === "" ? rest : { ...rest, cwd: normalizeWorkspacePath(cwd) };
		const started = performance.now();
		const startedAt = this.#clock.now();
		const backend = lease.tier === "isolate" ? this.#isolate : this.#container;
		const output = await backend.exec({ ctx, lease, record, request: normalized });
		const timings: Record<string, number> = { ...output.timings };
		let workspaceVersion = record.head;
		if (lease.tier === "isolate" && output.changes !== undefined && output.changes.length > 0) {
			const at = performance.now();
			const result = await this.#workspaces.commit(ctx, lease.workspaceId, {
				baseVersion: record.head,
				changes: output.changes,
				writer: { sessionId: lease.sessionId, leaseId: lease.id },
				message: `isolate lease ${lease.id}`,
			});
			workspaceVersion = result.version;
			timings["isolate.commit"] = round(performance.now() - at);
		}
		timings[`${lease.tier}.total`] = round(performance.now() - started);
		const durationMs = Math.max(0, this.#clock.now() - startedAt);
		const current = this.#leases.get(lease.id) ?? row;
		this.#leases.put({ ...current, busyMs: current.busyMs + durationMs });
		return {
			exitCode: output.exitCode,
			stdout: output.stdout,
			stderr: output.stderr,
			...(output.truncated === undefined ? {} : { truncated: output.truncated }),
			tier: lease.tier,
			leaseId: lease.id,
			workspaceVersion,
			durationMs,
			baseVersion: record.head,
			timings,
		};
	}

	#load(ctx: CallContext, leaseId: string): LeaseRow {
		const row = typeof leaseId === "string" ? this.#leases.get(leaseId) : undefined;
		if (row === undefined || row.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `lease ${String(leaseId)} not found`);
		}
		return row;
	}

	/** Rejects with `expired` when the lease has ended or passed its TTL (ending it first in that case). */
	async #requireLive(ctx: CallContext, leaseId: string): Promise<LeaseRow> {
		let row = this.#load(ctx, leaseId);
		if (this.#pastTtl(row)) {
			const ended = await this.#end(row, "expired", ctx.actor);
			await this.#emit([ended.event]);
			row = this.#leases.get(leaseId)!;
		}
		if (row.lease.endedAt !== undefined || this.#releasing.has(leaseId)) {
			throw new HarbourError("expired", `lease ${leaseId} has ended`, { endReason: row.lease.endReason ?? "released" });
		}
		return row;
	}

	/** The session's live lease on `tier`, ending any that passed its TTL on the way. */
	async #liveLease(
		organisationId: string,
		sessionId: SessionId,
		tier: SandboxTier,
		expired: AuditEventInput[],
	): Promise<LeaseRow | undefined> {
		for (const row of [...this.#leases.all()]) {
			if (row.organisationId !== organisationId || row.lease.sessionId !== sessionId) continue;
			if (row.lease.tier !== tier || row.lease.endedAt !== undefined) continue;
			if (this.#pastTtl(row)) {
				expired.push((await this.#end(row, "expired", SWEEPER)).event);
				continue;
			}
			return row;
		}
		return undefined;
	}

	/** Ends a lease without committing; frees a container (dropping its changes when expired). */
	async #end(
		row: LeaseRow,
		reason: LeaseEndReason,
		actor: Actor,
		committedVersion?: number,
	): Promise<{ lease: SandboxLease; event: AuditEventInput }> {
		const now = this.#clock.now();
		const lease: SandboxLease = { ...row.lease, endedAt: now, endReason: reason };
		this.#leases.put({ ...row, lease });
		if (lease.tier === "container") await this.#container.ended(lease, { discard: reason === "expired" });
		const event = this.#event(row, actor, {
			id: `sandbox:lease:${lease.id}:released`,
			type: "sandbox.lease.released",
			subject: { kind: "sandbox.lease", id: lease.id },
			data: {
				tier: lease.tier,
				reason,
				heldMs: now - lease.acquiredAt,
				busyMs: row.busyMs,
				...(committedVersion === undefined ? {} : { committedVersion }),
			},
		});
		return { lease, event };
	}

	#pastTtl(row: LeaseRow): boolean {
		return row.lease.endedAt === undefined && this.#clock.now() >= row.lease.expiresAt;
	}

	#ttl(ttlMs: number | undefined): number {
		const value = ttlMs ?? this.#defaultTtlMs;
		if (!Number.isFinite(value) || value <= 0) throw new HarbourError("invalid", "ttlMs must be a positive number");
		return value;
	}

	#event(
		row: Pick<LeaseRow, "organisationId" | "projectId" | "lease">,
		actor: Actor,
		fields: Pick<AuditEventInput, "id" | "type" | "subject" | "data">,
	): AuditEventInput {
		return {
			at: this.#clock.now(),
			source: "sandbox",
			actor,
			organisationId: row.organisationId,
			...(row.projectId === undefined ? {} : { projectId: row.projectId }),
			sessionId: row.lease.sessionId,
			...(actor.kind === "agent" ? { agentId: actor.agentId } : {}),
			...fields,
		};
	}

	async #emit(events: readonly AuditEventInput[]): Promise<void> {
		if (events.length > 0) await this.#audit?.append(events);
	}
}

function round(ms: number): number {
	return Math.round(ms * 10) / 10;
}

/**
 * A container's changes as a commit on a head with `present` files, the container's tree winning: a delete of a path
 * the head no longer has is dropped (already done), and where the container put a file under what the head has as a
 * file, or put a file where the head has a directory, the head's side is deleted in the same commit.
 */
export function containerWins(pending: readonly ModedChange[], present: ReadonlySet<string>): ModedChange[] {
	const changes = pending.filter((change) => change.op === "put" || present.has(change.path));
	const puts = new Set(changes.filter((change) => change.op === "put").map((change) => change.path));
	const deletes = new Set(changes.filter((change) => change.op === "delete").map((change) => change.path));
	const extra = new Set<string>();
	for (const path of puts) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const parent = parts.slice(0, i).join("/");
			if (present.has(parent) && !puts.has(parent)) extra.add(parent);
		}
		for (const file of present) if (file.startsWith(`${path}/`)) extra.add(file);
	}
	for (const path of extra) if (!deletes.has(path)) changes.push({ op: "delete", path });
	return changes;
}
