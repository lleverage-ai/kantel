/**
 * The container tier on Cloudflare, as the tiered sandboxes see it (`ContainerBackend`): one `KantelSandbox` Durable
 * Object per session, each with a Container running `images/sandbox` and its agent (`images/sandbox/agent/agent.ts`).
 * Portable (no `cloudflare:workers`): the stack object passes the objects in as `SandboxContainers`, and the tests pass
 * a stand-in.
 *
 * The container never reads storage and holds no credentials. This module reads the workspace with the caller's
 * context (the workspace's own checks apply) and sends the container a sync: the files that changed between the
 * version it holds and the head. The container answers `behind` when it holds another version than the sync starts
 * from (a restart, an eviction here): the sync is rebuilt from what it has, once. A large sync (a first one of a big
 * repository) goes in batches of about `SYNC_BATCH_BYTES`, read from storage one batch at a time, so neither the
 * stack object's memory nor an RPC message holds the whole tree.
 *
 * Its network is off (`enableInternet: false`, and nothing intercepted): like the isolate's, no request leaves it.
 */
import { type CallContext, KantelError, type SandboxLease, type SessionId, type WorkspaceId } from "@kantel/contracts";
import type { BackendExec, BackendOutput, ContainerBackend, PendingChanges } from "@kantel/sandbox/tiered";
import { listAll, type ModedChange, type ModedFileEntry, type StoredWorkspaces } from "@kantel/workspace/stored";

/** One file in a sync, its body in base64 (the agent's wire format). */
export interface SyncPut {
	readonly path: string;
	readonly mode: number;
	readonly content: string;
}

/** What turns the container's working copy from version `from` (null: empty) into `to`. */
export interface ContainerSync {
	readonly from: number | null;
	readonly to: number;
	readonly put: readonly SyncPut[];
	readonly remove: readonly string[];
}

/**
 * One batch of a large sync, ahead of the call that brings its last: written without moving the container's version.
 * `start` (ahead of a command or a warm-up) starts and claims the container for `leaseId` (the current owner when
 * absent); without it a batch goes only to the lease's own running container, as `changes` reads only that.
 */
export interface ContainerStage {
	readonly leaseId?: string;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly sync: ContainerSync;
	readonly start: boolean;
}

export interface ContainerCall {
	readonly leaseId: string;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly sync: ContainerSync;
}

export interface ContainerCommand {
	readonly command: string | readonly string[];
	readonly cwd?: string;
	readonly env?: { readonly [name: string]: string };
	readonly stdin?: string;
	readonly timeoutMs?: number;
}

/**
 * The container holds `have`, not the version the sync started from. A warm-up's probe says too whether it started
 * the container, and how long that took.
 */
export interface Behind {
	readonly kind: "behind";
	readonly have: number | null;
	readonly started?: boolean;
	readonly timings?: Record<string, number>;
}

export type ContainerStaged = { readonly kind: "staged" } | Behind;

export type ContainerRan =
	| {
			readonly kind: "ran";
			readonly exitCode: number;
			readonly stdout: string;
			readonly stderr: string;
			readonly truncated?: boolean;
			readonly timings: Record<string, number>;
	  }
	| Behind;

export type ContainerChanges =
	| {
			readonly kind: "changes";
			readonly put: readonly SyncPut[];
			readonly remove: readonly string[];
			readonly stamp: number;
	  }
	| Behind;

/**
 * What a close did to the session's container: `stopped` it, by `destroyed` (the object saw it running) or by a short
 * `inactivity` timeout (Cloudflare still ran one the object no longer saw, src/sandbox-stop.ts), or found none to stop.
 */
export type ContainerClosed =
	| { readonly stopped: false }
	| { readonly stopped: true; readonly via: "destroyed" | "inactivity" };

/** What a warm-up did: started the container, found it running, or skipped it (the session never needed one). */
export type ContainerWarmth = "started" | "running" | "skipped" | "unavailable";

export type ContainerWarmed =
	| { readonly kind: "warmed"; readonly state: ContainerWarmth; readonly timings: Record<string, number> }
	| Behind;

/** One session's container object (`KantelSandbox`, `src/sandbox-object.ts`), over RPC. */
export interface SandboxContainer {
	exec(call: ContainerCall & { readonly request: ContainerCommand }): Promise<ContainerRan>;
	changes(call: ContainerCall & { readonly final?: boolean }): Promise<ContainerChanges>;
	ack(args: { readonly leaseId: string; readonly version: number; readonly stamp: number }): Promise<void>;
	ended(args: { readonly leaseId: string; readonly discard: boolean }): Promise<void>;
	/** Without `sync`, a probe: `warmed` when the container holds `head`, else `behind` with what it holds. */
	warm(args: {
		readonly sessionId: string;
		readonly workspaceId: string;
		readonly head: number;
		readonly sync?: ContainerSync;
		readonly force?: boolean;
	}): Promise<ContainerWarmed>;
	stage(call: ContainerStage): Promise<ContainerStaged>;
	/**
	 * The session has closed for good: its container stops now, rather than after the inactivity timeout, so its instance
	 * is free at once, and nothing starts it again (a command is refused, a warm-up skipped). Idempotent; a session that
	 * never ran a container changes nothing. `stopped` says whether a container was running, and `via` how it stops.
	 */
	closeSession(): Promise<ContainerClosed>;
}

/**
 * The container object of one session. Named by the session alone (session IDs are UUIDs): the tiered sandboxes check
 * the caller's access to the session before any call reaches it, and `committed` and `ended` see only the lease.
 */
export type SandboxContainers = (sessionId: SessionId) => SandboxContainer;

export interface CloudflareContainerBackend extends ContainerBackend {
	/**
	 * Starts the session's container (if it has ever used one, or `force`) and re-bases it on the workspace head, so its
	 * next command neither waits for a start nor copies files. Idempotent: a running, current container answers at once.
	 */
	warm(
		ctx: CallContext,
		input: { readonly sessionId: SessionId; readonly workspaceId: WorkspaceId; readonly force?: boolean },
	): Promise<{ readonly state: ContainerWarmth; readonly timings: Record<string, number> }>;
	/**
	 * The session has closed for good: stops its container at once (`SandboxContainer.closeSession`). Call it after the
	 * session's leases are released, so the container's last changes are committed first. Touches no other session.
	 */
	closeSession(sessionId: SessionId): Promise<ContainerClosed>;
}

/** R2 reads in parallel batches: one at a time costs a round trip per file. */
const SYNC_CONCURRENCY = 32;
/**
 * The file bytes in one sync message, before base64 (which adds a third). Well under an RPC message's 32 MiB and the
 * object's memory; a file larger than this goes alone.
 */
export const SYNC_BATCH_BYTES = 8 * 1024 * 1024;
/** A version no working copy holds (they are null or a workspace version, never negative): a sync from it is a probe. */
const UNKNOWN_VERSION = -1;

/** A sync before its files are read: what to write, in batches of about `SYNC_BATCH_BYTES`, and what to remove. */
interface SyncPlan {
	readonly from: number | null;
	readonly to: number;
	readonly batches: readonly (readonly ModedFileEntry[])[];
	readonly remove: readonly string[];
}

export function createContainerBackend(options: {
	readonly workspaces: StoredWorkspaces;
	readonly containers: SandboxContainers;
	/** The file bytes in one sync message; `SYNC_BATCH_BYTES` by default. */
	readonly batchBytes?: number;
}): CloudflareContainerBackend {
	const { workspaces, containers } = options;
	const batchBytes = options.batchBytes ?? SYNC_BATCH_BYTES;
	/** The version each session's container holds, as far as this object knows. Lost on eviction, which is safe. */
	const held = new Map<string, number | null>();

	async function files(ctx: CallContext, id: WorkspaceId, version: number): Promise<Map<string, ModedFileEntry>> {
		const entries = await listAll(workspaces, ctx, id, { version });
		return new Map(entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]));
	}

	async function planSync(ctx: CallContext, id: WorkspaceId, from: number | null, to: number): Promise<SyncPlan> {
		if (from === to) return { from, to, batches: [], remove: [] };
		const target = await files(ctx, id, to);
		const source = from === null ? new Map<string, ModedFileEntry>() : await files(ctx, id, from);
		const changed = [...target.values()].filter((entry) => {
			const before = source.get(entry.path);
			return before === undefined || before.digest !== entry.digest || (before.mode ?? 0o644) !== (entry.mode ?? 0o644);
		});
		const remove = [...source.keys()].filter((path) => !target.has(path));
		return { from, to, batches: batchesOf(changed, batchBytes), remove };
	}

	async function readBatch(ctx: CallContext, id: WorkspaceId, to: number, batch: readonly ModedFileEntry[]) {
		const put: SyncPut[] = [];
		for (let at = 0; at < batch.length; at += SYNC_CONCURRENCY) {
			const group = batch.slice(at, at + SYNC_CONCURRENCY);
			const bodies = await Promise.all(
				group.map((entry) => workspaces.readBlob(ctx, id, entry.digest ?? "", { version: to })),
			);
			for (const [index, entry] of group.entries()) {
				put.push({ path: entry.path, mode: entry.mode ?? 0o644, content: toBase64(bodies[index]!) });
			}
		}
		return put;
	}

	/**
	 * Calls the container with a sync from what it holds to `head`, its leading batches staged first (`stage`, with
	 * `start` and `leaseId` as the call would claim the container); when it holds something else, once more from that.
	 * Records what it holds after a call that took the sync.
	 */
	async function synced<T extends { readonly kind: string }>(
		ctx: CallContext,
		target: { readonly sessionId: string; readonly workspaceId: WorkspaceId; readonly leaseId?: string },
		head: number,
		start: boolean,
		call: (sync: ContainerSync) => Promise<T | Behind>,
	): Promise<{ result: T; syncMs: number }> {
		const { sessionId, workspaceId } = target;
		const container = containers(sessionId);
		let syncMs = 0;
		if (!held.has(sessionId)) {
			// This object doesn't know what the container holds (it was evicted, or never asked): ask with a sync from a
			// version no working copy holds, which reads nothing here. A running container answers with its version, so
			// it is sent only what it lacks; a call that needs no sync (`changes` of a stopped one) just answers.
			const probed = await call({ from: UNKNOWN_VERSION, to: UNKNOWN_VERSION, put: [], remove: [] });
			if (probed.kind !== "behind") return { result: probed as T, syncMs };
			held.set(sessionId, (probed as Behind).have);
		}
		attempts: for (let attempt = 0; attempt < 2; attempt++) {
			let started = performance.now();
			const plan = await planSync(ctx, workspaceId, held.has(sessionId) ? held.get(sessionId)! : null, head);
			const leading = plan.batches.slice(0, -1);
			for (const batch of leading) {
				const put = await readBatch(ctx, workspaceId, plan.to, batch);
				const staged = await container.stage({
					...(target.leaseId === undefined ? {} : { leaseId: target.leaseId }),
					sessionId,
					workspaceId,
					sync: { from: plan.from, to: plan.to, put, remove: [] },
					start,
				});
				if (staged.kind === "behind") {
					syncMs += performance.now() - started;
					held.set(sessionId, staged.have);
					continue attempts;
				}
			}
			const last = plan.batches.at(-1);
			const put = last === undefined ? [] : await readBatch(ctx, workspaceId, plan.to, last);
			syncMs += performance.now() - started;
			started = performance.now();
			const result = await call({ from: plan.from, to: plan.to, put, remove: plan.remove });
			if (result.kind === "behind") {
				held.set(sessionId, (result as Behind).have);
				continue;
			}
			held.set(sessionId, head);
			return { result: result as T, syncMs };
		}
		throw new KantelError("unavailable", "The sandbox container stayed out of step with the workspace");
	}

	const callOf = (lease: SandboxLease, sync: ContainerSync): ContainerCall => ({
		leaseId: lease.id,
		sessionId: lease.sessionId,
		workspaceId: lease.workspaceId,
		sync,
	});

	return {
		async exec({ ctx, lease, record, request }: BackendExec): Promise<BackendOutput> {
			const container = containers(lease.sessionId);
			const { result, syncMs } = await synced(ctx, targetOf(lease), record.head, true, (sync) =>
				container.exec({ ...callOf(lease, sync), request: commandOf(request) }),
			);
			if (result.kind !== "ran") throw new KantelError("unavailable", "The sandbox container gave no result");
			return {
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				...(result.truncated === true ? { truncated: true } : {}),
				timings: { ...result.timings, "container.read": round(syncMs) },
			};
		},

		async pending({ ctx, lease, record }, pendingOptions = {}): Promise<PendingChanges> {
			const container = containers(lease.sessionId);
			const { result } = await synced(ctx, targetOf(lease), record.head, false, (sync) =>
				container.changes({ ...callOf(lease, sync), ...(pendingOptions.final === true ? { final: true } : {}) }),
			);
			if (result.kind !== "changes") return { changes: [], stamp: 0 };
			return {
				changes: [
					...result.put.map(
						(file): ModedChange => ({ op: "put", path: file.path, content: fromBase64(file.content), mode: file.mode }),
					),
					...result.remove.map((path): ModedChange => ({ op: "delete", path })),
				],
				stamp: result.stamp,
			};
		},

		async committed(lease, version, stamp) {
			await containers(lease.sessionId).ack({ leaseId: lease.id, version, stamp });
			held.set(lease.sessionId, version);
		},

		async ended(lease, endOptions) {
			await containers(lease.sessionId).ended({ leaseId: lease.id, discard: endOptions.discard });
			if (endOptions.discard) held.delete(lease.sessionId);
		},

		async warm(ctx, input) {
			const container = containers(input.sessionId);
			const head = (await workspaces.get(ctx, input.workspaceId)).head;
			const base = {
				sessionId: input.sessionId,
				workspaceId: input.workspaceId,
				head,
				...(input.force === true ? { force: true } : {}),
			};
			// A probe first, which reads nothing: a session that never used a container is skipped at no cost, and a
			// container that holds the head (or that this object last synced) is sent no more than it lacks.
			const probe = await container.warm(base);
			if (probe.kind === "warmed") {
				if (probe.state === "skipped" || probe.state === "unavailable") held.delete(input.sessionId);
				else held.set(input.sessionId, head);
				return { state: probe.state, timings: probe.timings };
			}
			held.set(input.sessionId, probe.have);
			const { result, syncMs } = await synced(ctx, input, head, true, (sync) => container.warm({ ...base, sync }));
			if (result.kind !== "warmed") return { state: "unavailable", timings: {} };
			return {
				// The probe started the container; the sync found it running.
				state: probe.started === true ? "started" : result.state,
				timings: { ...probe.timings, ...result.timings, "container.read": round(syncMs) },
			};
		},

		async closeSession(sessionId) {
			const closed = await containers(sessionId).closeSession();
			held.delete(sessionId);
			return closed;
		},
	};
}

function targetOf(lease: SandboxLease) {
	return { sessionId: lease.sessionId, workspaceId: lease.workspaceId, leaseId: lease.id };
}

/** Files in order, cut into runs of about `limit` bytes; a file larger than `limit` makes a run of its own. */
export function batchesOf<T extends { readonly size: number }>(entries: readonly T[], limit: number): T[][] {
	const batches: T[][] = [];
	let current: T[] = [];
	let bytes = 0;
	for (const entry of entries) {
		if (current.length > 0 && bytes + entry.size > limit) {
			batches.push(current);
			current = [];
			bytes = 0;
		}
		current.push(entry);
		bytes += entry.size;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function commandOf(request: BackendExec["request"]): ContainerCommand {
	return {
		command: request.command,
		...(request.cwd === undefined ? {} : { cwd: request.cwd }),
		...(request.env === undefined ? {} : { env: request.env }),
		...(request.stdin === undefined ? {} : { stdin: request.stdin }),
		...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
	};
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function round(ms: number): number {
	return Math.round(ms * 10) / 10;
}
