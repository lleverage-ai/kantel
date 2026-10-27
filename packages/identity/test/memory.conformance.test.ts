import { createMemoryIdentity } from "@harbour/identity/memory";
import { registerIdentityConformance } from "@harbour/testing/identity";
import { describe, expect, it } from "vitest";

registerIdentityConformance({ describe, expect, it }, "in-memory identity", async (deps, use) => {
	await use({ identity: createMemoryIdentity({ clock: deps.clock, audit: deps.audit }) });
});
