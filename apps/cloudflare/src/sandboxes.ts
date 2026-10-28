/**
 * The stack's sandboxes (#17, step 2): #94's tiered sandboxes over the stack's workspaces, with leases, the TTL sweep
 * and session-end release, inside the stack's Durable Object. Portable (no `cloudflare:workers`), so the tests run it
 * in Node.
 *
 * - **The isolate tier** runs on one of the backends in `ISOLATE_BACKENDS`, chosen by `HARBOUR_ISOLATE_BACKEND`.
 *   `in-process` is #94's just-bash shell running in this object, over the same workspaces (default). Each backend
 *   gets its own sandboxes, so the isolate-ready measurement can run on any of them while sessions use the chosen one.
 * - **The container tier** is not on Cloudflare yet: a command routed to it (`git`, `node`, `python` and the rest of
 *   `DEFAULT_TIER_ROUTES`) is refused `unavailable`.
 * - **Leases** are kept in memory. An isolate lease holds no state outside its workspace, so one lost to an eviction
 *   costs nothing: the next command acquires another.
 */
import {
	type AuditSink,
	type CallContext,
	type Clock,
	HarbourError,
	type LeaseEndReason,
	type ProjectAccess,
	type SandboxLease,
	type SessionId,
	type SystemContext,
} from "@harbour/contracts";
import { createInProcessIsolateBackend } from "@harbour/sandbox/isolate";
import {
	type ContainerBackend,
	createMemoryLeaseStore,
	createTieredSandboxes,
	type IsolateBackend,
	type TieredSandboxes,
} from "@harbour/sandbox/tiered";
import type { StoredWorkspaces } from "@harbour/workspace/stored";

/** The isolate backends this Worker can run. */
export const ISOLATE_BACKENDS = ["in-process"] as const;
export type IsolateBackendName = (typeof ISOLATE_BACKENDS)[number];
export const DEFAULT_ISOLATE_BACKEND: IsolateBackendName = "in-process";

export interface SandboxVars {
	/** Which isolate backend sessions run on (`ISOLATE_BACKENDS`). Default `in-process`. */
	readonly HARBOUR_ISOLATE_BACKEND?: string;
}

export function isIsolateBackend(value: string): value is IsolateBackendName {
	return (ISOLATE_BACKENDS as readonly string[]).includes(value);
}

/** The backend sessions run on. Refuses (`invalid`) one this Worker doesn't have. */
export function isolateBackendName(vars: SandboxVars): IsolateBackendName {
	const value = (vars.HARBOUR_ISOLATE_BACKEND ?? "").trim();
	if (value === "") return DEFAULT_ISOLATE_BACKEND;
	if (!isIsolateBackend(value)) {
		throw new HarbourError("invalid", `HARBOUR_ISOLATE_BACKEND must be one of: ${ISOLATE_BACKENDS.join(", ")}`);
	}
	return value;
}

const NO_CONTAINERS = "The container tier is not on Cloudflare yet; this command needs it";

/** The container tier's stand-in: refuses every command, and has nothing to commit or end. */
export const noContainers: ContainerBackend = {
	exec: async () => {
		throw new HarbourError("unavailable", NO_CONTAINERS);
	},
	pending: async () => {
		throw new HarbourError("unavailable", NO_CONTAINERS);
	},
	committed: async () => undefined,
	ended: async () => undefined,
};

/** Builds the isolate backends a deployment adds to `in-process`, over the stack's workspaces. */
export type ExtraIsolateBackends = (
	workspaces: StoredWorkspaces,
) => Partial<Record<Exclude<IsolateBackendName, "in-process">, IsolateBackend>>;

export interface StackSandboxesOptions {
	readonly workspaces: StoredWorkspaces;
	readonly access: ProjectAccess;
	readonly audit: AuditSink;
	readonly clock: Clock;
	/** The backend sessions run on. */
	readonly backend: IsolateBackendName;
	readonly extraBackends?: ExtraIsolateBackends;
}

export interface StackSandboxes {
	/** The backend sessions run on, and its sandboxes. */
	readonly backend: IsolateBackendName;
	readonly sandboxes: TieredSandboxes;
	/** The sandboxes on `backend`, or `undefined` when this Worker doesn't have it. */
	on(backend: IsolateBackendName): TieredSandboxes | undefined;
	/** Ends a session's leases on every backend: the runtime's `sandbox` teardown. */
	releaseSession(ctx: CallContext, sessionId: SessionId, reason?: LeaseEndReason): Promise<void>;
	/** Sweeps expired leases on every backend. */
	sweep(ctx: SystemContext): Promise<readonly SandboxLease[]>;
}

export function createStackSandboxes(options: StackSandboxesOptions): StackSandboxes {
	const backends: Partial<Record<IsolateBackendName, IsolateBackend>> = {
		"in-process": createInProcessIsolateBackend(options.workspaces),
		...options.extraBackends?.(options.workspaces),
	};
	const all = new Map<IsolateBackendName, TieredSandboxes>();
	for (const name of ISOLATE_BACKENDS) {
		const isolate = backends[name];
		if (isolate === undefined) continue;
		all.set(
			name,
			createTieredSandboxes({
				workspaces: options.workspaces,
				isolate,
				container: noContainers,
				leases: createMemoryLeaseStore(),
				clock: options.clock,
				audit: options.audit,
				access: options.access,
			}),
		);
	}
	const sandboxes = all.get(options.backend);
	if (sandboxes === undefined) {
		throw new HarbourError("invalid", `This Worker has no ${options.backend} isolate backend`);
	}
	return {
		backend: options.backend,
		sandboxes,
		on: (backend) => all.get(backend),
		async releaseSession(ctx, sessionId, reason) {
			for (const each of all.values()) await each.releaseSession(ctx, sessionId, reason);
		},
		async sweep(ctx) {
			const swept: SandboxLease[] = [];
			for (const each of all.values()) swept.push(...(await each.sweep(ctx)));
			return swept;
		},
	};
}
