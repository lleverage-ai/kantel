/**
 * The deployed tier backends behind `CloudflareSandboxes`: the Dynamic Worker isolate and the Container Durable Object.
 */
import type { SandboxLease } from "@harbour/contracts";
import ISOLATE_BUNDLE from "../dist/isolate.bundle.txt";
import type { ContainerCall } from "./container-tier.ts";
import type { ShellOutcome, ShellRequest } from "./isolate/shell.ts";
import type { BackendExec, BackendOutput, ContainerBackend, IsolateBackend, PendingChanges } from "./sandbox.ts";

type IsolateStub = {
	exec(request: ShellRequest): Promise<ShellOutcome & { isolate: { bootedAt: number; calls: number } }>;
	ping(): Promise<{ bootedAt: number; calls: number }>;
};

/** Dynamic Worker tier: just-bash in a Worker loaded at runtime, with only the workspace view and the vault. */
export class DynamicWorkerIsolate implements IsolateBackend {
	constructor(
		private readonly env: Env,
		private readonly exports: Cloudflare.Exports,
		private readonly sessionId: string,
		/** Changes the loader ID, so the next exec loads a fresh isolate. The cold-start harness sets it. */
		private readonly generation = "0",
	) {}

	#stub(workspaceId: string): IsolateStub {
		const id = `harbour-m0-isolate:${this.sessionId}:${workspaceId}:${this.generation}:${BUNDLE_ID}`;
		const worker = this.env.LOADER.get(id, async () => ({
			compatibilityDate: "2026-10-01",
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "isolate.js",
			modules: { "isolate.js": ISOLATE_BUNDLE },
			env: {
				WORKSPACE: this.exports.WorkspaceGateway({ props: { workspaceId, sessionId: this.sessionId } }),
			},
			// Every fetch() from the isolate, including just-bash's curl, goes to the vault. No other way out.
			globalOutbound: this.exports.VaultGateway({ props: { sessionId: this.sessionId, tier: "isolate" } }),
		}));
		return worker.getEntrypoint("HarbourIsolate") as unknown as IsolateStub;
	}

	async exec({ lease, record, request }: BackendExec): Promise<BackendOutput> {
		const started = performance.now();
		const { isolate: _isolate, ...outcome } = await this.#stub(lease.workspaceId).exec({
			...request,
			baseVersion: record.head,
			mounts: record.mounts.map((mount) => ({ path: mount.path })),
		});
		return { ...outcome, timings: { ...outcome.timings, "isolate.call": round(performance.now() - started) } };
	}
}

/**
 * Container tier: one Container Durable Object per lease's bound name (the session ID unless the measurement routes
 * pick another), `durable_object` scheduling policy. `nameFor` must return the same name for every call on a lease, so
 * a lease's commit and release reach the container that holds its changes.
 */
export class ContainerDOBackend implements ContainerBackend {
	constructor(
		private readonly env: Env,
		private readonly nameFor: (lease: SandboxLease) => string,
	) {}

	#stub(lease: SandboxLease) {
		return this.env.CONTAINER.getByName(this.nameFor(lease));
	}

	#call(lease: SandboxLease, ctx: BackendExec["ctx"], head: number): ContainerCall {
		return {
			leaseId: lease.id,
			sessionId: lease.sessionId,
			workspaceId: lease.workspaceId,
			head,
			ctx: {
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(ctx.projectId ? { projectId: ctx.projectId } : {}),
			},
		};
	}

	async exec({ ctx, lease, record, request }: BackendExec): Promise<BackendOutput> {
		const started = performance.now();
		const result = await this.#stub(lease).exec({ ...this.#call(lease, ctx, record.head), request });
		return { ...result, timings: { ...result.timings, "container.call": round(performance.now() - started) } };
	}

	async pending({ ctx, lease, record }: Omit<BackendExec, "request">): Promise<PendingChanges> {
		return this.#stub(lease).pending(this.#call(lease, ctx, record.head));
	}

	async committed(lease: SandboxLease, version: number, stamp: number): Promise<void> {
		await this.#stub(lease).committed({ leaseId: lease.id, version, stamp });
	}

	async ended(lease: SandboxLease, options: { readonly discard: boolean }): Promise<void> {
		await this.#stub(lease).ended({ leaseId: lease.id, discard: options.discard });
	}
}

/** Stops the named container now, as the cold-start harness needs. */
export async function stopContainer(env: Env, name: string): Promise<void> {
	await env.CONTAINER.getByName(name).stop();
}

/** Changes whenever the bundle changes, so a deploy never reuses an isolate with old code. */
const BUNDLE_ID = (() => {
	let hash = 2166136261;
	for (let i = 0; i < ISOLATE_BUNDLE.length; i += 997) hash = Math.imul(hash ^ ISOLATE_BUNDLE.charCodeAt(i), 16777619);
	return `${ISOLATE_BUNDLE.length.toString(36)}${(hash >>> 0).toString(36)}`;
})();

function round(ms: number) {
	return Math.round(ms * 10) / 10;
}
