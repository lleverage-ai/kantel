/** Cloudflare workspaces: `@harbour/workspace/stored` over one R2 bucket. See ../README.md. */
import { createStoredWorkspaces, type StoredWorkspaces, type StoredWorkspacesOptions } from "@harbour/workspace/stored";
import { createR2WorkspaceStore, type R2BucketLike } from "./r2.ts";

export * from "./r2.ts";

export interface CloudflareWorkspacesOptions extends Omit<StoredWorkspacesOptions, "store"> {
	/** The workspace bucket binding (`env.WORKSPACES`). */
	readonly bucket: R2BucketLike;
	readonly prefix?: string;
}

export function createCloudflareWorkspaces(options: CloudflareWorkspacesOptions): StoredWorkspaces {
	const { bucket, prefix, ...rest } = options;
	return createStoredWorkspaces({
		...rest,
		store: createR2WorkspaceStore({ bucket, ...(prefix === undefined ? {} : { prefix }) }),
	});
}
