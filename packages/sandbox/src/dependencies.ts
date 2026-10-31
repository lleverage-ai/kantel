/**
 * A seed's dependency stage (M2-BE1), run once the workspace's files are ready: each step, in spec order, either has
 * its layer restored by key or runs in its tier, after which its outputs are saved as the layer. The stage is then
 * recorded on the workspace (`recordDependencies`), which moves its readiness to `dependencies` and sends the
 * `seed.status` event. A step that exits non-zero, or a layer that cannot be restored or saved, fails the stage:
 * readiness becomes `failed` and the files stay as they are.
 *
 * Equal keys share a layer, so a changed lockfile rebuilds only its own step. Steps run through `Sandboxes`, on a
 * lease of their own tier that is released straight away (the container tier commits its changes on release). How a
 * layer is held is the `DependencyLayers` implementation's: `@kantel/workspace/dependency-layers` for archives in an
 * object store, or a target's overlay or snapshot layers.
 */
import {
	type CallContext,
	type DependencyLayers,
	isKantelError,
	KantelError,
	type Sandboxes,
	type SeedDependencyReport,
	type SessionId,
	type WorkspaceId,
	type WorkspaceRecord,
	type Workspaces,
} from "@kantel/contracts";

export interface PrepareDependenciesInput {
	readonly workspaces: Workspaces;
	readonly sandboxes: Pick<Sandboxes, "acquire" | "exec" | "release">;
	readonly layers: DependencyLayers;
	readonly workspaceId: WorkspaceId;
	/** The session the steps' leases belong to. Default: the workspace's own session. */
	readonly sessionId?: SessionId;
	/** The longest one step may run. Default 15 minutes. */
	readonly stepTimeoutMs?: number;
}

/**
 * Runs the dependency stage of a workspace at `files` with dependency steps, and returns the record as recorded. A
 * workspace at any other stage, or with no steps, is returned unchanged.
 */
export async function prepareDependencies(ctx: CallContext, input: PrepareDependenciesInput): Promise<WorkspaceRecord> {
	const { workspaces, sandboxes, layers, workspaceId } = input;
	const record = await workspaces.get(ctx, workspaceId);
	const steps = record.seed?.deps ?? [];
	const keyed = record.seedReport?.deps ?? [];
	if (record.seedReadiness !== "files" || steps.length === 0 || keyed.length !== steps.length) return record;
	if (workspaces.recordDependencies === undefined) {
		throw new KantelError("not_supported", "these workspaces cannot record a dependency stage");
	}
	const sessionId = input.sessionId ?? record.sessionId;
	const done: SeedDependencyReport[] = [];
	try {
		for (const [index, step] of steps.entries()) {
			const report = keyed[index] as SeedDependencyReport;
			const request = { workspaceId, ...(sessionId === undefined ? {} : { sessionId }), step, report };
			if (await layers.restore(ctx, request)) {
				done.push({ ...report, layer: "restored" });
				continue;
			}
			if (sessionId === undefined) {
				throw new KantelError("invalid", `step ${report.name} needs a session to run in`);
			}
			const lease = await sandboxes.acquire(ctx, { sessionId, workspaceId, tier: report.tier });
			let exit: { exitCode: number; stderr: string };
			try {
				exit = await sandboxes.exec(ctx, lease.id, {
					command: step.run,
					timeoutMs: input.stepTimeoutMs ?? 15 * 60_000,
				});
			} finally {
				await sandboxes.release(ctx, lease.id);
			}
			if (exit.exitCode !== 0) {
				throw new KantelError(
					"unavailable",
					`step ${report.name} exited with ${exit.exitCode}: ${exit.stderr.trim().split("\n").slice(-3).join(" ")}`.slice(
						0,
						500,
					),
					{ step: report.name, exitCode: exit.exitCode },
				);
			}
			await layers.save(ctx, request);
			done.push({ ...report, layer: "built" });
		}
	} catch (error) {
		if (isKantelError(error) && error.code === "aborted") throw error;
		const code = isKantelError(error) ? error.code : "unavailable";
		const message = error instanceof Error ? error.message : String(error);
		return workspaces.recordDependencies(ctx, workspaceId, { deps: done, error: { code, message } });
	}
	return workspaces.recordDependencies(ctx, workspaceId, { deps: done });
}
