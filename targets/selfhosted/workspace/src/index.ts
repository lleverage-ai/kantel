/**
 * Self-hosted workspaces: `@harbour/workspace/stored` over Postgres (heads and versions) and an S3-compatible bucket
 * (blobs and trees). See ../README.md.
 */
import { createStoredWorkspaces, type StoredWorkspaces, type StoredWorkspacesOptions } from "@harbour/workspace/stored";
import { createPostgresWorkspaceStore, type ObjectBucket, type SqlDatabase } from "./postgres.ts";

export * from "./export-directory.ts";
export * from "./postgres.ts";
export * from "./s3.ts";

export interface SelfHostedWorkspacesOptions extends Omit<StoredWorkspacesOptions, "store"> {
	readonly db: SqlDatabase;
	readonly objects: ObjectBucket;
	readonly schema?: string;
}

export function createSelfHostedWorkspaces(options: SelfHostedWorkspacesOptions): StoredWorkspaces {
	const { db, objects, schema, ...rest } = options;
	return createStoredWorkspaces({
		...rest,
		store: createPostgresWorkspaceStore({ db, objects, ...(schema === undefined ? {} : { schema }) }),
	});
}
