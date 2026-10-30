/**
 * The stack's sandboxes (#17, step 2): #94's tiered sandboxes over the stack's workspaces, with leases, the TTL sweep
 * and session-end release, inside the stack's Durable Object. Portable (no `cloudflare:workers`), so the tests run it
 * in Node.
 *
 * - **The isolate tier** runs on one of the backends in `ISOLATE_BACKENDS`, chosen by `HARBOUR_ISOLATE_BACKEND`.
 *   `in-process` is #94's just-bash shell running in this object, over the same workspaces (default).
 *   `dynamic-worker` runs the same shell in a Dynamic Worker per session (`src/dynamic-worker.ts`), when the Worker
 *   has the `LOADER` binding. Each backend gets its own sandboxes, so the isolate-ready measurement can run on any of
 *   them while sessions use the chosen one.
 * - **The container tier**, with `containers` (the `HarbourSandbox` objects, `src/sandbox-object.ts`, when the deploy
 *   runs sandbox containers): one container per session, started by its first command that needs one. A shell command
 *   goes there when the table says so (`npm`, `python3`, git writes) or when it starts a program the isolate doesn't
 *   have (`make`, `unzip`, ...; `escalatingRouter`), and its changes are committed after every command, so the file
 *   tools, which read the workspace itself, see them. Without `containers`, such a command is refused `unavailable`.
 * - **`git`**: the in-process isolate has isomorphic-git's read-only `git` (`@harbour/sandbox/isolate-git`), over the
 *   shallow `.git` a git seed writes (`@harbour/workspace/git-history`). Its reads (`status`, `log`, `show`, ...) run
 *   there, so they never wait for a container. With containers, git writes go to the container; without, every
 *   command that starts with `git` runs in the isolate, whose writes say they need the container tier.
 * - **Session close**: the session-end teardown releases the session's leases (a container lease commits its last
 *   changes), then, when the session closed for good (`session_ended`: a close or a delete), stops its container at
 *   once, so the instance is free for another session rather than held for the 10-minute inactivity timeout. An abort
 *   (the session stays usable) keeps the container warm for the next command.
 * - **Warm-up** (`warm`): reads the head's listing for the isolate and, with containers, starts the session's container
 *   (if it has used one) and re-bases it, so the first command after a pause waits for neither.
 * - **`node`**: with `nodeEngine` (the compiled QuickJS module), the in-process isolate has a `node` program that runs
 *   plain JavaScript in QuickJS (`@harbour/sandbox/isolate-node`), and a command that starts with `node` runs there
 *   instead of being refused. The Worker passes it; the tests may.
 * - **Leases** are kept in memory. An isolate lease holds no state outside its workspace, so one lost to an eviction
 *   costs nothing: the next command acquires another.
 */
import {
	type AuditSink,
	type CallContext,
	type Clock,
	DEFAULT_TIER_ROUTES,
	HarbourError,
	type LeaseEndReason,
	type ProjectAccess,
	type SandboxLease,
	type SessionId,
	type SystemContext,
	systemContext,
	type TierRoute,
	type WorkspaceId,
} from "@harbour/contracts";
import { createInProcessIsolateBackend, escalatingRouter, isolatePrograms } from "@harbour/sandbox/isolate";
import { createIsolateGitCommand, ISOLATE_GIT_ROUTE } from "@harbour/sandbox/isolate-git";
import { createIsolateNodeCommand, ISOLATE_NODE_ROUTE } from "@harbour/sandbox/isolate-node";
import {
	type ContainerBackend,
	createMemoryLeaseStore,
	createTieredSandboxes,
	type IsolateBackend,
	type TieredSandboxes,
} from "@harbour/sandbox/tiered";
import type { StoredWorkspaces } from "@harbour/workspace/stored";
import { type ContainerWarmth, createContainerBackend, type SandboxContainers } from "./container-backend.ts";

/** The isolate backends this Worker can run. */
export const ISOLATE_BACKENDS = ["in-process", "dynamic-worker"] as const;
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

const AUDIT_CONTEXT: SystemContext = systemContext("sandbox");

const NO_CONTAINERS =
	"This command needs the container tier, which this deployment doesn't run (HARBOUR_SANDBOX_CONTAINERS is off)";

/** Every `git` command to the isolate, whose `git` answers reads and refuses writes: there is no container tier. */
export const CLOUDFLARE_GIT_ROUTE: TierRoute = { tool: "bash", programs: ["git"], tier: "isolate" };

/**
 * The in-process isolate's routes, before the defaults: `git` (its reads only when there is a container tier for its
 * writes; all of it otherwise), and `node` when it has the engine.
 */
export function inProcessRoutes(node: boolean, containers = false): readonly TierRoute[] {
	return [
		containers ? ISOLATE_GIT_ROUTE : CLOUDFLARE_GIT_ROUTE,
		...(node ? [ISOLATE_NODE_ROUTE] : []),
		...DEFAULT_TIER_ROUTES,
	];
}

/**
 * The container tier's stand-in: refuses every command, and has nothing to commit or end. The tiered sandboxes acquire
 * a container lease before they run the command, so `pending` must answer (with no changes): the isolate checkpoints
 * that lease before each command, and releasing it flushes it, and a refusal there would stall the session.
 */
export const noContainers: ContainerBackend = {
	exec: async () => {
		throw new HarbourError("unavailable", NO_CONTAINERS);
	},
	pending: async () => ({ changes: [], stamp: 0 }),
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
	/** The compiled QuickJS module: with it, the in-process isolate runs `node` (see above). */
	readonly nodeEngine?: NodeEngine;
	/** The sessions' container objects, when the deploy runs sandbox containers. */
	readonly containers?: SandboxContainers;
}

/** What `warm` did, per tier. */
export interface SandboxWarmth {
	readonly isolate: "ready";
	readonly container: ContainerWarmth;
	readonly timings: Record<string, number>;
}

/** The compiled QuickJS module (`@jitl/quickjs-wasmfile-release-sync/wasm`), or how to get it. */
export type NodeEngine = WebAssembly.Module | (() => Promise<WebAssembly.Module>);

export interface StackSandboxes {
	/** The backend sessions run on, and its sandboxes. */
	readonly backend: IsolateBackendName;
	readonly sandboxes: TieredSandboxes;
	/** The sandboxes on `backend`, or `undefined` when this Worker doesn't have it. */
	on(backend: IsolateBackendName): TieredSandboxes | undefined;
	/**
	 * Ends a session's leases on every backend: the runtime's `sandbox` teardown. When the session closed for good
	 * (`session_ended`, the default), its container stops too, once the leases are released.
	 */
	releaseSession(ctx: CallContext, sessionId: SessionId, reason?: LeaseEndReason): Promise<void>;
	/** Sweeps expired leases on every backend. */
	sweep(ctx: SystemContext): Promise<readonly SandboxLease[]>;
	/**
	 * Gets a session's sandboxes ready for its next command (see above). Idempotent and cheap when they are. The caller
	 * must hold `operator` on the session (checked here); the workspace's own checks apply to its reads.
	 */
	warm(
		ctx: CallContext,
		input: { readonly sessionId: SessionId; readonly workspaceId: WorkspaceId; readonly force?: boolean },
	): Promise<SandboxWarmth>;
}

export function createStackSandboxes(options: StackSandboxesOptions): StackSandboxes {
	const commands = [
		createIsolateGitCommand(),
		...(options.nodeEngine === undefined ? [] : [createIsolateNodeCommand({ wasmModule: options.nodeEngine })]),
	];
	const inProcess = createInProcessIsolateBackend(options.workspaces, { commands });
	const backends: Partial<Record<IsolateBackendName, IsolateBackend>> = {
		"in-process": inProcess,
		...options.extraBackends?.(options.workspaces),
	};
	const container =
		options.containers === undefined
			? undefined
			: createContainerBackend({ workspaces: options.workspaces, containers: options.containers });
	/** The in-process isolate's table: git (reads, with containers) and `node` (when it has QuickJS) stay in the isolate. */
	const routes = inProcessRoutes(options.nodeEngine !== undefined, container !== undefined);
	const all = new Map<IsolateBackendName, TieredSandboxes>();
	for (const name of ISOLATE_BACKENDS) {
		const isolate = backends[name];
		if (isolate === undefined) continue;
		all.set(
			name,
			createTieredSandboxes({
				workspaces: options.workspaces,
				isolate,
				container: container ?? noContainers,
				leases: createMemoryLeaseStore(),
				clock: options.clock,
				audit: options.audit,
				access: options.access,
				...(name === "in-process" ? { routes } : {}),
				// With a container to escalate to, a command the isolate can't run goes there instead of failing.
				...(container === undefined
					? {}
					: {
							router: escalatingRouter(isolatePrograms(name === "in-process" ? commands : [])),
							checkpointContainer: true,
						}),
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
		async releaseSession(ctx, sessionId, reason = "session_ended") {
			// The leases first: a container lease's release commits its last changes. If one fails, the container is left to
			// its inactivity timeout rather than stopped with changes the workspace doesn't have.
			for (const each of all.values()) await each.releaseSession(ctx, sessionId, reason);
			if (container === undefined || reason !== "session_ended") return;
			// Asked of the session's container object itself, not of the leases this object holds in memory: an evicted or
			// redeployed stack object has forgotten them, and its container may still be running.
			await options.access.require(ctx, { sessionId, needed: "operator", operation: "sandbox.closeSession" });
			const { stopped } = await container.closeSession(sessionId);
			if (!stopped) return;
			await options.audit.append(AUDIT_CONTEXT, [
				{
					id: `sandbox:container:${ctx.organisationId}:${sessionId}:stopped`,
					at: options.clock.now(),
					source: "sandbox",
					type: "sandbox.container.stopped",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					sessionId,
					subject: { kind: "session", id: sessionId },
					data: { reason },
				},
			]);
		},
		async sweep(ctx) {
			const swept: SandboxLease[] = [];
			for (const each of all.values()) swept.push(...(await each.sweep(ctx)));
			return swept;
		},
		async warm(ctx, input) {
			await options.access.require(ctx, {
				sessionId: input.sessionId,
				needed: "operator",
				operation: "sandbox.warm",
			});
			const started = performance.now();
			const head = (await options.workspaces.get(ctx, input.workspaceId)).head;
			const [, warmed] = await Promise.all([
				options.backend === "in-process" ? inProcess.warm(ctx, input.workspaceId, head) : Promise.resolve(),
				container === undefined
					? Promise.resolve({ state: "unavailable" as const, timings: {} })
					: container.warm(ctx, input),
			]);
			return {
				isolate: "ready",
				container: warmed.state,
				timings: { ...warmed.timings, "warm.total": Math.round(performance.now() - started) },
			};
		},
	};
}
