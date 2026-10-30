import { createMemorySharing } from "@harbour/sharing/memory";
import { registerSharingConformance } from "@harbour/testing/sharing";
import { describe, expect, it } from "vitest";

registerSharingConformance({ describe, expect, it }, "in-memory sharing", async (deps, use) => {
	await use({
		sharing: createMemorySharing({
			access: deps.access,
			audit: deps.audit,
			clock: deps.clock,
			resolvers: deps.resolvers,
		}),
	});
});
