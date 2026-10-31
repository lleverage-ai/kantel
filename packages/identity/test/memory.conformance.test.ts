import { createMemoryIdentity } from "@kantel/identity/memory";
import { registerIdentityConformance } from "@kantel/testing/identity";
import { describe, expect, it } from "vitest";

registerIdentityConformance({ describe, expect, it }, "in-memory identity", async (deps, use) => {
	await use({ identity: createMemoryIdentity({ clock: deps.clock, audit: deps.audit }) });
});
