import { createMemoryCapabilityRegistry } from "@kantel/codemode/memory";
import { isKantelError } from "@kantel/contracts";
import { registerCapabilityConformance } from "@kantel/testing/capability";
import { describe, expect, it } from "vitest";

registerCapabilityConformance(
	{ describe, expect, it },
	"in-memory capability registry",
	async (deps, use) => {
		const crashing = new Set<string>();
		const registry = createMemoryCapabilityRegistry({
			clock: deps.clock,
			audit: deps.audit,
			access: deps.access,
			testing: { crashBeforeCommit: (callId) => crashing.delete(callId) },
		});
		await use({
			registry,
			async crashMidCall({ ctx, invoke }) {
				crashing.add(invoke.callId);
				try {
					await registry.invoke(ctx, invoke);
				} catch (error) {
					if (isKantelError(error, "unavailable")) return;
					throw error;
				}
				throw new Error(`Call ${invoke.callId} committed instead of crashing`);
			},
		});
	},
	{ projectAccess: true },
);
