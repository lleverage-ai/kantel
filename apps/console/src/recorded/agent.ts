// The skills and memory pages' stand-in host, in the page: @harbour/ui's fixture skills and memory in in-memory stores,
// with authoring and proposals, for `source=recorded`. On `source=api` the pages run over the public API instead
// (`api/agent-http.ts`); nothing in src/app changes.

import { createMemoryScenario } from "@harbour/ui/memory/fixtures";
import { createSkillsScenario, ownerChoices, projectChoices, VIEWER } from "@harbour/ui/skills/fixtures";
import type { ConsoleAgent } from "../api/oversight.ts";

export interface RecordedAgent extends ConsoleAgent {
	/** The fixture skills' IDs by name, for the sharing fixtures to share one. */
	readonly skillIds: Readonly<Record<string, string>>;
}

export async function createRecordedAgent(): Promise<RecordedAgent> {
	const [skills, memory] = await Promise.all([createSkillsScenario(), createMemoryScenario()]);
	return {
		skillIds: skills.ids,
		skills: skills.source,
		viewer: VIEWER,
		author: skills.author,
		owners: ownerChoices,
		memory: memory.source,
		spaces: async () => [memory.space],
		profile: memory.profile,
		// The fixtures' projects (Billing, Platform, Website), not the recorded sessions'.
		projects: projectChoices.map((choice) => ({ id: choice.value, name: choice.label })),
	};
}
