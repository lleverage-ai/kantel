import { createMemoryPromptRules } from "@harbour/rules/memory";
import { registerRulesConformance } from "@harbour/testing/rules";
import { describe, expect, it } from "vitest";

registerRulesConformance(
	{ describe, expect, it },
	"in-memory prompt rules",
	async (deps, use) => {
		await use({ rules: createMemoryPromptRules({ access: deps.access, audit: deps.audit, clock: deps.clock }) });
	},
	{ projectAccess: true },
);
