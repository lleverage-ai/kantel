import { createMemoryMemory } from "@harbour/memory/memory";
import { registerMemoryConformance } from "@harbour/testing/memory";
import { describe, expect, it } from "vitest";

registerMemoryConformance(
	{ describe, expect, it },
	"in-memory memory",
	async (deps, use, settings) => {
		await use({
			memory: createMemoryMemory({ clock: deps.clock, audit: deps.audit, access: deps.access, ...settings }),
		});
	},
	{ projectAccess: true, writes: true },
);
