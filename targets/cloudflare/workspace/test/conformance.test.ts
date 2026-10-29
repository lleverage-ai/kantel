import { registerWorkspaceConformance } from "@harbour/testing/workspace";
import { createMemoryProjectFiles } from "@harbour/workspace/memory";
import { createWorkspaceProjectFiles } from "@harbour/workspace/mounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudflareWorkspaces, type R2BucketLike } from "../src/index.ts";
import { localR2, memoryHeadCache } from "./r2.ts";

// The conformance suite on R2 as `wrangler dev` runs it (Miniflare), each case under its own prefix.
let r2: Awaited<ReturnType<typeof localR2>>;
beforeAll(async () => {
	r2 = await localR2();
});
afterAll(() => r2.dispose());
const bucket: R2BucketLike = {
	get: (key) => r2.bucket.get(key),
	put: (key, value, options) => r2.bucket.put(key, value, options),
};

registerWorkspaceConformance(
	{ describe, expect, it },
	"Cloudflare workspaces on R2, memory project files",
	async (deps, use) => {
		const projectFiles = createMemoryProjectFiles({ access: deps.access });
		const workspaces = createCloudflareWorkspaces({
			bucket,
			prefix: `m1-be23/${crypto.randomUUID()}`,
			clock: deps.clock,
			audit: deps.audit,
			access: deps.access,
			sources: [projectFiles],
			seeders: deps.seeders,
			onSeedStatus: deps.onSeedStatus,
		});
		await use({ workspaces, projectFiles });
	},
	{ projectAccess: true, keyed: true, seeding: true },
);

// The same with heads kept in front of R2, as the stack object keeps them (apps/cloudflare/src/workspace-heads.ts).
registerWorkspaceConformance(
	{ describe, expect, it },
	"Cloudflare workspaces on R2 with a head cache, memory project files",
	async (deps, use) => {
		const projectFiles = createMemoryProjectFiles({ access: deps.access });
		const workspaces = createCloudflareWorkspaces({
			bucket,
			prefix: `m1-cf1/${crypto.randomUUID()}`,
			headCache: memoryHeadCache(),
			clock: deps.clock,
			audit: deps.audit,
			access: deps.access,
			sources: [projectFiles],
		});
		await use({ workspaces, projectFiles });
	},
	{ projectAccess: true, keyed: true },
);

registerWorkspaceConformance(
	{ describe, expect, it },
	"Cloudflare workspaces on R2, workspace-backed project files",
	async (deps, use) => {
		const prefix = `m1-be23/${crypto.randomUUID()}`;
		const trees = createCloudflareWorkspaces({ bucket, prefix, clock: deps.clock, access: deps.access });
		const projectFiles = createWorkspaceProjectFiles({ workspaces: trees, access: deps.access });
		const workspaces = createCloudflareWorkspaces({
			bucket,
			prefix,
			clock: deps.clock,
			audit: deps.audit,
			access: deps.access,
			sources: [projectFiles],
		});
		await use({ workspaces, projectFiles });
	},
	{ projectAccess: true, keyed: true },
);
