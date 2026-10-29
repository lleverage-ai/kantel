import { createMemorySkills } from "@harbour/skills/memory";
import { registerSkillsConformance } from "@harbour/testing/skills";
import { describe, expect, it } from "vitest";

registerSkillsConformance(
	{ describe, expect, it },
	"in-memory skills",
	async (deps, use, settings) => {
		await use({
			skills: createMemorySkills({ clock: deps.clock, audit: deps.audit, access: deps.access, ...settings }),
		});
	},
	{ projectAccess: true, writes: true },
);
