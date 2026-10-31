/**
 * `Sandboxes` over two pluggable tier backends: lease bookkeeping, routing through the contract's tier table, and
 * commits. Ported from the Cloudflare spike's `CloudflareSandboxes` (spikes/cloudflare/src/sandbox.ts).
 *
 * - Isolate: the backend returns what a command changed; this module commits it at once. When another writer moved
 *   the head meanwhile, the changes are re-based on the new head as long as none of their paths changed in between
 *   (up to three attempts); otherwise the command fails with `conflict`.
 * - Container: the backend keeps its own working copy, re-based on the head before every command so it sees the
 *   isolate's last write, and its changes are committed when the lease is released (`pending`, `committed`, `ended`).
 *
 * One addition to the contract, so a session sees one tree in both directions: `run` routing a command to the isolate
 * first commits the session's live container lease (a checkpoint; the lease stays live). The contract guarantees the
 * isolate-to-container direction only.
 *
 * Leases live in a `LeaseStore`: a Map in tests and local runs, durable storage when deployed. A lease that passed its
 * TTL, whether `sweep` finds it or a call notices it, is ended as `expired` and never committed: the container backend
 * is told to discard its working copy. Every commit for a lease (an isolate command's, each re-based retry, a container
 * release or checkpoint) first re-checks that the lease is live and within its TTL, so nothing commits after expiry,
 * and the sweep ends an expired lease even while its release is in flight, so a hung release cannot keep it alive.
 *
 * Acquisition is serialised per organisation, session and tier in this process, so concurrent `acquire` or first `run`
 * calls see one live lease. A caller's cancelled `ctx.signal` stops an isolate command and commits nothing.
 *
 * Project access, audit events and errors match `createMemorySandboxes` exactly.
 */
import {
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	type CommitResult,
	DEFAULT_TIER_ROUTES,
	type ExecRequest,
	type ExecResult,
	KantelError,
	isKantelError,
	type LeaseEndReason,
	type ProjectAccess,
	type Role,
	requireSystem,
	type Sandboxes,
	type SandboxLease,
	type SandboxTier,
	type SandboxUsage,
	type SessionEndHook,
	type SessionId,
	type SystemContext,
	systemClock,
	systemContext,
	type TierRoute,
	type WorkspaceId,
	type WorkspaceRecord,
	type WorkspaceVersion,
} from "@kantel/contracts";
import { normalizeWorkspacePath } from "@kantel/workspace";
import { listAll, type ModedChange, type StoredCommitRequest, type StoredWorkspaces } from "@kantel/workspace/stored";
import { routeTool } from "./index.ts";

const DEFAULT_TTL_MS = 15 * 60_000;
const TIERS: readonly SandboxTier[] = ["isolate", "container"];
const SWEEPER: Actor = { kind: "system", component: "sandbox.sweeper" };
/** Looks a workspace up in the caller's organisation, before the caller's own access is checked. */
const LOOKUP: Actor = { kind: "system", component: "sandbox" };
/** The sandbox appends its audit events as itself. */
const AUDIT_CONTEXT: SystemContext = systemContext("sandbox");
/** Commit attempts when another writer moves the head between reading it and committing on it. */
const COMMIT_ATTEMPTS = 3;
const HISTORY_PAGE = 100;

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
	 * names exactly this set of changes. `final` (the lease is being released) fences the lease: from then on the
	 * backend refuses commands on it, so nothing can change the working copy after its last snapshot.
	 */
	pending(input: Omit<BackendExec, "request">, options?: { readonly final?: boolean }): Promise<PendingChanges>;
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

/** A `LeaseStore` in a Map, for tests and local runs. */
export function createMemoryLeaseStore(): LeaseStore {
	const rows = new Map<string, LeaseRow>();
	const escalated = new Set<string>();
	return {
		get: (id) => rows.get(id),
		put(row) {
			rows.set(row.lease.id, row);
		},
		all: () => rows.values(),
		escalated(key, mark) {
			const seen = escalated.has(key);
			if (mark) escalated.add(key);
			return seen;
		},
	};
}

export interface TieredSandboxesOptions {
	readonly workspaces: StoredWorkspaces;
	readonly isolate: IsolateBackend;
	readonly container: ContainerBackend;
	readonly leases?: LeaseStore;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** The tool-to-tier table; `DEFAULT_TIER_ROUTES` when absent. */
	readonly routes?: readonly TierRoute[];
	/**
	 * Routes a tool call itself, given the table's answer: a host that knows what its isolate can run (and has a
	 * container to send the rest to) refines the table here. Absent: the table decides.
	 */
	readonly router?: (tool: string, command: string | readonly string[] | undefined, tabled: SandboxTier) => SandboxTier;
	/**
	 * Commit a container lease's changes after every command on it (a checkpoint; the lease stays live), rather than
	 * only on release and before an isolate command. For a host whose container can stop or be evicted between
	 * commands, and whose file tools read the workspace itself: they see what the last command wrote.
	 */
	readonly checkpointContainer?: boolean;
	readonly defaultTtlMs?: number;
	/** Project access (settled question 7). Without it the sandboxes check only the organisation. */
	readonly access?: ProjectAccess;
	/** The session-end hook (settled question 8); when given, `releaseSession` is registered as the `sandbox` teardown. */
	readonly sessionEnd?: SessionEndHook;
}

/** The contract's result plus the version the command ran on and per-phase timings. */
export type TieredExecResult = ExecResult & {
	readonly baseVersion: number;
	readonly timings: Record<string, number>;
};

export interface TieredSandboxes extends Sandboxes {
	exec(ctx: CallContext, leaseId: string, request: ExecRequest): Promise<TieredExecResult>;
	run(ctx: CallContext, input: Parameters<Sandboxes["run"]>[1]): Promise<TieredExecResult>;
}

export function createTieredSandboxes(options: TieredSandboxesOptions): TieredSandboxes {
	const sandboxes = new Tiered(options);
	options.sessionEnd?.register("sandbox", (ctx, end) => sandboxes.releaseSession(ctx, end.sessionId, end.reason));
	return sandboxes;
}

/** A lease ended by `#end`, with the audit event to append (absent when another call ended it first). */
interface Ended {
	readonly lease: SandboxLease;
	readonly event?: AuditEventInput;
}

class Tiered implements TieredSandboxes {
	readonly #workspaces: StoredWorkspaces;
	readonly #isolate: IsolateBackend;
	readonly #container: ContainerBackend;
	readonly #leases: LeaseStore;
	readonly #clock: Clock;
	readonly #audit: AuditSink | undefined;
	readonly #routes: readonly TierRoute[];
	readonly #router: TieredSandboxesOptions["router"];
	readonly #checkpointContainer: boolean;
	readonly #defaultTtlMs: number;
	readonly #access: ProjectAccess | undefined;
	/** Releases in flight, so concurrent releases of one lease commit once. */
	readonly #releasing = new Map<string, Promise<SandboxLease>>();
	/** Ends in flight, so a sweep and a call that both notice an expired lease end it (and audit it) once. */
	readonly #ending = new Map<string, Promise<SandboxLease>>();
	readonly #fences = new Map<string, AbortController>();
	/** Per organisation, session and tier, the tail of the acquisitions in flight, so they run one at a time. */
	readonly #acquiring = new Map<string, Promise<void>>();

	constructor(options: TieredSandboxesOptions) {
		this.#workspaces = options.workspaces;
		this.#isolate = options.isolate;
		this.#container = options.container;
		this.#leases = options.leases ?? createMemoryLeaseStore();
		this.#clock = options.clock ?? systemClock;
		this.#audit = options.audit;
		this.#routes = options.routes ?? DEFAULT_TIER_ROUTES;
		this.#router = options.router;
		this.#checkpointContainer = options.checkpointContainer === true;
		this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
		this.#access = options.access;
	}

	route(tool: string, command?: string | readonly string[]): SandboxTier {
		const tabled = routeTool(this.#routes, tool, command);
		return this.#router === undefined ? tabled : this.#router(tool, command, tabled);
	}

	async acquire(ctx: CallContext, input: Parameters<Sandboxes["acquire"]>[1]): Promise<SandboxLease> {
		const ttlMs = this.#ttl(input.ttlMs);
		if (!TIERS.includes(input.tier)) throw new KantelError("invalid", `unknown tier ${String(input.tier)}`);
		const workspace = await this.#workspaceInOrganisation(ctx, input.workspaceId);
		await this.#requireSession(ctx, input.sessionId, "operator", "sandbox.acquire", projectOf(workspace));
		return this.#serialised(acquireKey(ctx.organisationId, input.sessionId, input.tier), () =>
			this.#create(ctx, input, ttlMs),
		);
	}

	/**
	 * Creates the session's lease on `input.tier`, or rejects with `conflict` when it holds a live one. Runs under the
	 * session's acquisition lock (`#serialised`), so the check and the insert are not interleaved with another's.
	 */
	async #create(ctx: CallContext, input: Parameters<Sandboxes["acquire"]>[1], ttlMs: number): Promise<SandboxLease> {
		const record = await this.#workspaces.get(ctx, input.workspaceId);
		const expired: AuditEventInput[] = [];
		const existing = await this.#liveLease(ctx.organisationId, input.sessionId, input.tier, expired);
		await this.#emit(expired);
		if (existing !== undefined) {
			throw new KantelError("conflict", `session ${input.sessionId} already holds a live ${input.tier} lease`, {
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
		const loaded = this.#load(ctx, leaseId);
		await this.#requireSession(ctx, loaded.lease.sessionId, "operator", "sandbox.renew", { leaseId });
		const row = await this.#requireLive(ctx, leaseId);
		const lease = { ...row.lease, expiresAt: this.#clock.now() + value };
		this.#leases.put({ ...row, lease });
		return lease;
	}

	async release(ctx: CallContext, leaseId: string, reason: LeaseEndReason = "released"): Promise<SandboxLease> {
		const row = this.#load(ctx, leaseId);
		await this.#requireSession(ctx, row.lease.sessionId, "operator", "sandbox.release", { leaseId });
		if (row.lease.endedAt !== undefined) return row.lease;
		let releasing = this.#releasing.get(leaseId);
		if (releasing === undefined) {
			releasing = this.#doRelease(ctx, row, reason).finally(() => this.#releasing.delete(leaseId));
			this.#releasing.set(leaseId, releasing);
		}
		return releasing;
	}

	async exec(ctx: CallContext, leaseId: string, request: ExecRequest): Promise<TieredExecResult> {
		const loaded = this.#load(ctx, leaseId);
		await this.#requireSession(ctx, loaded.lease.sessionId, "operator", "sandbox.exec", { leaseId });
		const row = await this.#requireLive(ctx, leaseId);
		return this.#execOn(ctx, row, request);
	}

	async run(ctx: CallContext, input: Parameters<Sandboxes["run"]>[1]): Promise<TieredExecResult> {
		const workspace = await this.#workspaceInOrganisation(ctx, input.workspaceId);
		await this.#requireSession(ctx, input.sessionId, "operator", "sandbox.run", projectOf(workspace));
		const tier = this.route(input.tool, input.request.command);
		// Under the acquisition lock, so concurrent first runs share one lease instead of acquiring two.
		const row = await this.#serialised(acquireKey(ctx.organisationId, input.sessionId, tier), async () => {
			const expired: AuditEventInput[] = [];
			const found = await this.#liveLease(ctx.organisationId, input.sessionId, tier, expired);
			await this.#emit(expired);
			if (found !== undefined) {
				if (found.lease.workspaceId !== input.workspaceId) {
					throw new KantelError("conflict", `the session's ${tier} lease is on another workspace`, {
						leaseId: found.lease.id,
					});
				}
				return found;
			}
			// The checks `acquire` makes, then its body (the lock is already held).
			await this.#requireSession(ctx, input.sessionId, "operator", "sandbox.acquire", projectOf(workspace));
			const lease = await this.#create(
				ctx,
				{ sessionId: input.sessionId, workspaceId: input.workspaceId, tier },
				this.#ttl(undefined),
			);
			return this.#leases.get(lease.id)!;
		});
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
			const pastTtl: AuditEventInput[] = [];
			const container = await this.#liveLease(ctx.organisationId, input.sessionId, "container", pastTtl);
			await this.#emit(pastTtl);
			if (container !== undefined && container.lease.workspaceId === input.workspaceId) {
				await this.#flush(ctx, container);
			}
		}
		return this.#execOn(ctx, row, input.request);
	}

	async leases(ctx: CallContext, filter: Parameters<Sandboxes["leases"]>[1]): Promise<readonly SandboxLease[]> {
		const held = this.#leasesOf(ctx, filter.sessionId);
		// A session with no leases here lists nothing, as one in another organisation does.
		if (held.length === 0) return [];
		await this.#requireSession(ctx, filter.sessionId, "viewer", "sandbox.leases");
		const found: SandboxLease[] = [];
		for (const row of held) {
			const live = row.lease.endedAt === undefined && !this.#pastTtl(row);
			if (filter.live === undefined || filter.live === live) found.push(row.lease);
		}
		return found.sort((left, right) => left.acquiredAt - right.acquiredAt);
	}

	async releaseSession(ctx: CallContext, sessionId: SessionId, reason: LeaseEndReason = "session_ended") {
		const held = this.#leasesOf(ctx, sessionId).filter((row) => row.lease.endedAt === undefined);
		// Nothing held: a silent no-op, so the session-end teardown can run twice.
		if (held.length === 0) return;
		await this.#requireSession(ctx, sessionId, "operator", "sandbox.releaseSession");
		for (const row of held) {
			if (this.#leases.get(row.lease.id)?.lease.endedAt !== undefined) continue;
			await this.release(ctx, row.lease.id, reason);
		}
	}

	async sweep(ctx: SystemContext): Promise<readonly SandboxLease[]> {
		await requireSystem(ctx, "sandbox.sweep", {
			...(this.#audit === undefined ? {} : { audit: this.#audit }),
			clock: this.#clock,
		});
		const swept: SandboxLease[] = [];
		const events: AuditEventInput[] = [];
		const failures: unknown[] = [];
		for (const row of [...this.#leases.all()]) {
			// A release in flight does not keep an expired lease alive: its flush re-checks before committing, sees the lease
			// ended and commits nothing.
			if (!this.#pastTtl(row)) continue;
			try {
				const ended = await this.#end(row, "expired", SWEEPER);
				if (ended.event === undefined) continue;
				events.push(ended.event);
				swept.push(ended.lease);
			} catch (error) {
				// A backend that failed to tear down leaves its lease live; the next sweep retries it.
				failures.push(error);
			}
		}
		await this.#emit(events);
		if (failures.length > 0) {
			throw new AggregateError(failures, `the sweep could not end ${failures.length} expired lease(s)`);
		}
		return swept;
	}

	async usage(ctx: CallContext, sessionId: SessionId): Promise<readonly SandboxUsage[]> {
		const held = this.#leasesOf(ctx, sessionId);
		if (held.length > 0) await this.#requireSession(ctx, sessionId, "viewer", "sandbox.usage");
		const now = this.#clock.now();
		const usage = new Map<SandboxTier, { leases: number; heldMs: number; busyMs: number }>(
			TIERS.map((tier) => [tier, { leases: 0, heldMs: 0, busyMs: 0 }]),
		);
		for (const row of held) {
			const totals = usage.get(row.lease.tier)!;
			totals.leases++;
			totals.heldMs += (row.lease.endedAt ?? now) - row.lease.acquiredAt;
			totals.busyMs += row.busyMs;
		}
		return [...usage].map(([tier, totals]): SandboxUsage => ({ tier, ...totals }));
	}

	// ---- internals ---------------------------------------------------------------------------------------------------

	/** Requires `needed` on `sessionId`'s project (and, when given, that the session belongs to `projectId`). */
	async #requireSession(
		ctx: CallContext,
		sessionId: SessionId,
		needed: Role,
		operation: string,
		extra: { readonly projectId?: string; readonly leaseId?: string } = {},
	): Promise<void> {
		await this.#access?.require(ctx, {
			sessionId,
			needed,
			operation,
			...(extra.projectId === undefined ? {} : { projectId: extra.projectId }),
			...(extra.leaseId === undefined ? {} : { subject: { kind: "sandbox.lease", id: extra.leaseId } }),
		});
	}

	/** The workspace in the caller's organisation (`not_found` otherwise), read without the caller's project check. */
	#workspaceInOrganisation(ctx: CallContext, workspaceId: WorkspaceId): Promise<WorkspaceRecord> {
		return this.#workspaces.get({ actor: LOOKUP, organisationId: ctx.organisationId }, workspaceId);
	}

	/** The leases of `sessionId` in the caller's organisation. */
	#leasesOf(ctx: CallContext, sessionId: SessionId): LeaseRow[] {
		return [...this.#leases.all()].filter(
			(row) => row.organisationId === ctx.organisationId && row.lease.sessionId === sessionId,
		);
	}

	async #doRelease(ctx: CallContext, row: LeaseRow, reason: LeaseEndReason): Promise<SandboxLease> {
		if (this.#pastTtl(row) || reason === "expired") {
			// Expired leases are discarded, not committed.
			const ended = await this.#end(row, "expired", ctx.actor);
			await this.#emit(ended.event === undefined ? [] : [ended.event]);
			return ended.lease;
		}
		const committedVersion = row.lease.tier === "container" ? await this.#flush(ctx, row, true) : undefined;
		const ended = await this.#end(this.#leases.get(row.lease.id) ?? row, reason, ctx.actor, committedVersion);
		await this.#emit(ended.event === undefined ? [] : [ended.event]);
		return ended.lease;
	}

	/**
	 * Commits a container lease's working copy on top of the head. Returns the new version, if anything changed. After
	 * every wait it re-checks the lease (`#requireCommittable`), so a lease that expired or ended meanwhile commits
	 * nothing and the release or checkpoint rejects with `expired`.
	 */
	async #flush(ctx: CallContext, row: LeaseRow, final = false): Promise<number | undefined> {
		const { lease } = row;
		for (let attempt = 1; ; attempt++) {
			await this.#requireCommittable(ctx, row);
			const record = await this.#workspaces.get(ctx, lease.workspaceId);
			await this.#requireCommittable(ctx, row);
			const { changes: pending, stamp } = await this.#container.pending({ ctx, lease, record }, { final });
			await this.#requireCommittable(ctx, row);
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
			await this.#requireCommittable(ctx, row);
			try {
				const result = await this.#commit(ctx, row, {
					baseVersion: record.head,
					changes,
					writer: { sessionId: lease.sessionId, leaseId: lease.id },
					message: `container lease ${lease.id}`,
				});
				await this.#container.committed(lease, result.version, stamp);
				return result.version;
			} catch (error) {
				// Another writer moved the head between the re-base and the commit: re-base again.
				if (!isKantelError(error, "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
			}
		}
	}

	/**
	 * Commits an isolate command's changes, made relative to `base`. When the head moved meanwhile and none of the
	 * changed paths (or their parents or children) changed in between, the same changes are committed on the new head;
	 * otherwise `conflict`. Before every attempt the lease must still be live and within its TTL, and the caller must not
	 * have cancelled; otherwise `expired` (or `aborted`), with nothing committed.
	 */
	async #commitIsolate(
		ctx: CallContext,
		row: LeaseRow,
		base: WorkspaceVersion,
		changes: readonly ModedChange[],
	): Promise<number> {
		const { lease } = row;
		let baseVersion = base;
		for (let attempt = 1; ; attempt++) {
			requireNotCancelled(ctx, lease.id);
			await this.#requireCommittable(ctx, row);
			try {
				const result = await this.#commit(ctx, row, {
					baseVersion,
					changes,
					writer: { sessionId: lease.sessionId, leaseId: lease.id },
					message: `isolate lease ${lease.id}`,
				});
				return result.version;
			} catch (error) {
				if (!isKantelError(error, "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
				const head = (await this.#workspaces.get(ctx, lease.workspaceId)).head;
				if (head === baseVersion) throw error;
				const moved = await this.#changedBetween(ctx, lease.workspaceId, baseVersion, head);
				const clash = changes.map((change) => change.path).filter((path) => overlaps(path, moved));
				if (clash.length > 0) {
					throw new KantelError("conflict", "another writer changed the same paths while the command ran", {
						baseVersion: base,
						head,
						paths: clash,
					});
				}
				baseVersion = head;
			}
		}
	}

	/** The paths changed by versions after `base` up to and including `head`. */
	async #changedBetween(
		ctx: CallContext,
		workspaceId: WorkspaceId,
		base: WorkspaceVersion,
		head: WorkspaceVersion,
	): Promise<Set<string>> {
		const changed = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await this.#workspaces.history(ctx, workspaceId, {
				limit: HISTORY_PAGE,
				...(cursor === undefined ? {} : { cursor }),
			});
			for (const info of page.items) {
				if (info.version <= base) return changed;
				if (info.version <= head) for (const path of info.changed) changed.add(path);
			}
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return changed;
	}

	async #execOn(ctx: CallContext, row: LeaseRow, request: ExecRequest): Promise<TieredExecResult> {
		const { lease } = row;
		const record = await this.#workspaces.get(ctx, lease.workspaceId);
		const { cwd, ...rest } = request;
		const normalized: ExecRequest =
			cwd === undefined || cwd === "" ? rest : { ...rest, cwd: normalizeWorkspacePath(cwd) };
		const started = performance.now();
		const startedAt = this.#clock.now();
		const backend = lease.tier === "isolate" ? this.#isolate : this.#container;
		try {
			const output = await backend.exec({ ctx, lease, record, request: normalized });
			// A cancelled command is not reported as a success, and its changes are not committed.
			requireNotCancelled(ctx, lease.id);
			const timings: Record<string, number> = { ...output.timings };
			let workspaceVersion = record.head;
			if (lease.tier === "isolate" && output.changes !== undefined && output.changes.length > 0) {
				// A lease that expired while the command ran is never committed: `#commitIsolate` checks before each attempt.
				const at = performance.now();
				workspaceVersion = await this.#commitIsolate(ctx, row, record.head, output.changes);
				timings["isolate.commit"] = round(performance.now() - at);
			} else if (lease.tier === "container" && this.#checkpointContainer) {
				// `#flush` re-checks the lease before it commits, so one that ended meanwhile commits nothing.
				const at = performance.now();
				workspaceVersion = (await this.#flush(ctx, this.#leases.get(lease.id) ?? row)) ?? record.head;
				timings["container.commit"] = round(performance.now() - at);
			}
			timings[`${lease.tier}.total`] = round(performance.now() - started);
			return {
				exitCode: output.exitCode,
				stdout: output.stdout,
				stderr: output.stderr,
				...(output.truncated === undefined ? {} : { truncated: output.truncated }),
				tier: lease.tier,
				leaseId: lease.id,
				workspaceVersion,
				durationMs: Math.max(0, this.#clock.now() - startedAt),
				baseVersion: record.head,
				timings,
			};
		} finally {
			const durationMs = Math.max(0, this.#clock.now() - startedAt);
			const current = this.#leases.get(lease.id) ?? row;
			this.#leases.put({ ...current, busyMs: current.busyMs + durationMs });
		}
	}

	#load(ctx: CallContext, leaseId: string): LeaseRow {
		const row = typeof leaseId === "string" ? this.#leases.get(leaseId) : undefined;
		if (row === undefined || row.organisationId !== ctx.organisationId) {
			throw new KantelError("not_found", `lease ${String(leaseId)} not found`);
		}
		return row;
	}

	/** Rejects with `expired` when the lease has ended or passed its TTL (ending it first in that case). */
	async #requireLive(ctx: CallContext, leaseId: string): Promise<LeaseRow> {
		let row = this.#load(ctx, leaseId);
		if (this.#pastTtl(row)) {
			const ended = await this.#end(row, "expired", ctx.actor);
			await this.#emit(ended.event === undefined ? [] : [ended.event]);
			row = this.#leases.get(leaseId)!;
		}
		if (row.lease.endedAt !== undefined || this.#releasing.has(leaseId)) {
			throw new KantelError("expired", `lease ${leaseId} has ended`, { endReason: row.lease.endReason ?? "released" });
		}
		return row;
	}

	/**
	 * Before a commit for a lease: rejects with `expired`, committing nothing, when the lease has ended, is being ended or
	 * passed its TTL. A lease past its TTL is ended as `expired` through `#end`, so it is torn down (discarding a
	 * container's changes) and audited once, however many callers notice it.
	 */
	async #requireCommittable(ctx: CallContext, row: LeaseRow): Promise<void> {
		const id = row.lease.id;
		let current = this.#leases.get(id) ?? row;
		if (current.lease.endedAt === undefined && (this.#pastTtl(current) || this.#ending.has(id))) {
			const ended = await this.#end(current, "expired", ctx.actor);
			await this.#emit(ended.event === undefined ? [] : [ended.event]);
			current = this.#leases.get(id) ?? { ...current, lease: ended.lease };
		}
		if (current.lease.endedAt !== undefined) {
			throw new KantelError("expired", `lease ${id} ended before its changes were committed`, {
				endReason: current.lease.endReason ?? "expired",
			});
		}
	}

	/**
	 * Runs `task` after every earlier task with the same key has settled: an in-process keyed chain, so concurrent
	 * acquisitions for one organisation, session and tier see each other's leases. A `LeaseStore` shared across hosts
	 * must make the check and the insert atomic itself.
	 */
	async #serialised<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.#acquiring.get(key) ?? Promise.resolve();
		const result = previous.then(task);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.#acquiring.set(key, tail);
		try {
			return await result;
		} finally {
			if (this.#acquiring.get(key) === tail) this.#acquiring.delete(key);
		}
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
				const ended = await this.#end(row, "expired", SWEEPER);
				if (ended.event !== undefined) expired.push(ended.event);
				continue;
			}
			return row;
		}
		return undefined;
	}

	/**
	 * Ends a lease without committing; frees a container (dropping its changes when expired). Concurrent ends of one
	 * lease share the first; only that one returns the audit event.
	 */
	async #end(row: LeaseRow, reason: LeaseEndReason, actor: Actor, committedVersion?: number): Promise<Ended> {
		const id = row.lease.id;
		const inFlight = this.#ending.get(id);
		if (inFlight !== undefined) return { lease: await inFlight };
		const stored = this.#leases.get(id) ?? row;
		if (stored.lease.endedAt !== undefined) return { lease: stored.lease };
		// A commit for this lease still in flight stops before it moves the head (see `#commit`).
		const fence = this.#fence(id);
		fence.abort();
		const ending = (async (): Promise<Required<Ended>> => {
			const now = this.#clock.now();
			const lease: SandboxLease = { ...stored.lease, endedAt: now, endReason: reason };
			// The backend first, then the record: if the backend call fails, the lease is still live and the release can
			// be retried (`ended` is idempotent), instead of an ended lease whose container still belongs to it.
			if (lease.tier === "container") await this.#container.ended(lease, { discard: reason === "expired" });
			const current = this.#leases.get(id) ?? stored;
			this.#leases.put({ ...current, lease });
			const event = this.#event(current, actor, {
				id: `sandbox:lease:${lease.id}:released`,
				type: "sandbox.lease.released",
				subject: { kind: "sandbox.lease", id: lease.id },
				data: {
					tier: lease.tier,
					reason,
					heldMs: now - lease.acquiredAt,
					busyMs: current.busyMs,
					...(committedVersion === undefined ? {} : { committedVersion }),
				},
			});
			return { lease, event };
		})();
		const shared = ending.then((ended) => ended.lease);
		// Whoever started the end sees its failure; the shared copy must not count as unhandled.
		shared.catch(() => undefined);
		this.#ending.set(id, shared);
		try {
			return await ending;
		} catch (error) {
			// The lease is still live (the backend refused to end it): later commits may proceed again.
			if (this.#fences.get(id) === fence) this.#fences.delete(id);
			throw error;
		} finally {
			this.#ending.delete(id);
		}
	}

	/** The lease's commit fence: aborted once the lease starts to end, and kept so for good. */
	#fence(leaseId: string): AbortController {
		let fence = this.#fences.get(leaseId);
		if (fence === undefined) {
			fence = new AbortController();
			this.#fences.set(leaseId, fence);
		}
		return fence;
	}

	/**
	 * Commits for a lease under its fence and the caller's signal. Workspaces check the signal immediately before the
	 * head moves, so a lease that ends (or a caller that cancels) while the commit writes its objects commits nothing:
	 * `expired` when the lease ended, `aborted` when the caller cancelled.
	 */
	async #commit(ctx: CallContext, row: LeaseRow, request: Omit<StoredCommitRequest, "guard">): Promise<CommitResult> {
		const id = row.lease.id;
		const fence = this.#fence(id).signal;
		// Checked by the store just before the head moves, on this clock and the lease as it is then (a renewal meanwhile
		// counts, shorter or longer): a lease that has started to end or passed its TTL commits nothing.
		const guard = () => {
			const current = this.#leases.get(id) ?? row;
			if (fence.aborted || current.lease.endedAt !== undefined || this.#clock.now() >= current.lease.expiresAt) {
				throw new KantelError("expired", `lease ${id} ended before its changes were committed`);
			}
		};
		return this.#workspaces.commit(ctx, row.lease.workspaceId, { ...request, guard });
	}

	#pastTtl(row: LeaseRow): boolean {
		return row.lease.endedAt === undefined && this.#clock.now() >= row.lease.expiresAt;
	}

	#ttl(ttlMs: number | undefined): number {
		const value = ttlMs ?? this.#defaultTtlMs;
		if (!Number.isFinite(value) || value <= 0) throw new KantelError("invalid", "ttlMs must be a positive number");
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
		if (events.length > 0) await this.#audit?.append(AUDIT_CONTEXT, events);
	}
}

/** The project a project-owned workspace belongs to, for checking that a session acts in it. */
function projectOf(workspace: WorkspaceRecord): { readonly projectId?: string } {
	return workspace.owner.kind === "project" ? { projectId: workspace.owner.projectId } : {};
}

/** The key acquisitions are serialised on. */
function acquireKey(organisationId: string, sessionId: SessionId, tier: SandboxTier): string {
	return `${organisationId}\u0000${sessionId}\u0000${tier}`;
}

/** Rejects with `aborted` when the caller cancelled the call. */
function requireNotCancelled(ctx: CallContext, leaseId: string): void {
	if (ctx.signal?.aborted === true) {
		throw new KantelError("aborted", `the command on lease ${leaseId} was cancelled; nothing was committed`);
	}
}

function round(ms: number): number {
	return Math.round(ms * 10) / 10;
}

/** Whether `path` is one of `paths`, or a parent or child of one. */
function overlaps(path: string, paths: ReadonlySet<string>): boolean {
	if (paths.has(path)) return true;
	for (const other of paths) {
		if (other.startsWith(`${path}/`) || path.startsWith(`${other}/`)) return true;
	}
	return false;
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
