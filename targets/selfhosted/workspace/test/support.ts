import type { PGlite } from "@electric-sql/pglite";
import type { WorkspaceConformanceProvider } from "@harbour/testing/workspace";
import { createMemoryProjectFiles } from "@harbour/workspace/memory";
import { createWorkspaceProjectFiles } from "@harbour/workspace/mounts";
import {
	createSelfHostedWorkspaces,
	migrateWorkspaceStore,
	type ObjectBucket,
	type SqlDatabase,
} from "../src/index.ts";

/** PGlite (Postgres compiled to WebAssembly) as a `SqlDatabase`, so CI runs the real SQL without a server. */
export function pgliteDatabase(db: PGlite): SqlDatabase {
	const wrap =
		(target: Pick<PGlite, "query">): SqlDatabase["query"] =>
		async <R>(text: string, values: readonly unknown[] = []) => {
			const result = await target.query<R>(text, [...values]);
			return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
		};
	return {
		query: wrap(db),
		transaction: (work) => db.transaction((tx) => work({ query: wrap(tx) })),
	};
}

/** A fresh schema per case, named after the lane, so runs and cases never share rows. */
export function laneSchema(): string {
	return `m1be23_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * Providers for the conformance suite: `/project` from memory project files, and again from project files kept in
 * the same store (the source every target serves `/project` from).
 */
export function providers(
	connect: () => Promise<{ db: SqlDatabase; objects: ObjectBucket }>,
): Record<string, WorkspaceConformanceProvider> {
	async function open(deps: Parameters<WorkspaceConformanceProvider>[0]) {
		const { db, objects } = await connect();
		const schema = laneSchema();
		await migrateWorkspaceStore(db, schema);
		// The trees behind workspace-backed project files are built without the audit sink, as in the memory suite, so
		// the cases count only the workspace under test's events.
		return (sources?: Parameters<typeof createSelfHostedWorkspaces>[0]["sources"]) =>
			createSelfHostedWorkspaces({
				db,
				objects,
				schema,
				clock: deps.clock,
				access: deps.access,
				...(sources === undefined ? {} : { sources, audit: deps.audit }),
			});
	}
	return {
		"memory project files": async (deps, use) => {
			const make = await open(deps);
			const projectFiles = createMemoryProjectFiles({ access: deps.access });
			await use({ workspaces: make([projectFiles]), projectFiles });
		},
		"workspace-backed project files": async (deps, use) => {
			const make = await open(deps);
			const projectFiles = createWorkspaceProjectFiles({ workspaces: make(), access: deps.access });
			await use({ workspaces: make([projectFiles]), projectFiles });
		},
	};
}
