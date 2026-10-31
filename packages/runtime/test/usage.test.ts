import type { CallContext } from "@kantel/contracts";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { describe, expect, it } from "vitest";

const operator: CallContext = {
	actor: { kind: "service", serviceId: "supervisor" },
	organisationId: "org-1",
	projectId: "proj-1",
};

describe("a session's usage", () => {
	it("is on the snapshot after a run, summed over every model response of the session", async () => {
		const { models, script } = createScriptedModel();
		const memory = createMemoryRuntime({ models });
		try {
			await memory.profiles.put(operator, {
				id: "agent-1",
				organisationId: "org-1",
				name: "Worker",
				model: { route: "default" },
				promptLayers: [],
				tools: [],
				skills: [],
				sandbox: { tiers: ["isolate"] },
				memoryScopes: [],
			});
			const session = await memory.runtime.create(operator, { projectId: "proj-1", agentId: "agent-1" });
			expect((await memory.runtime.snapshot(operator, session.id)).usage).toBeUndefined();

			script.reply({ text: "First answer" });
			const first = await memory.runtime.prompt(operator, session.id, { text: "Hello" });
			const firstRun = await memory.runtime.wait(operator, session.id, first.id);
			const afterFirst = (await memory.runtime.snapshot(operator, session.id)).usage;
			expect(afterFirst?.inputTokens).toBeGreaterThan(0);
			expect(afterFirst?.outputTokens).toBeGreaterThan(0);
			expect(afterFirst).toMatchObject({
				inputTokens: firstRun.usage?.inputTokens,
				outputTokens: firstRun.usage?.outputTokens,
			});

			script.reply({ text: "Second answer" });
			const second = await memory.runtime.prompt(operator, session.id, { text: "Again" });
			const secondRun = await memory.runtime.wait(operator, session.id, second.id);
			const afterSecond = (await memory.runtime.snapshot(operator, session.id)).usage;
			expect(afterSecond).toMatchObject({
				inputTokens: (afterFirst?.inputTokens ?? 0) + (secondRun.usage?.inputTokens ?? 0),
				outputTokens: (afterFirst?.outputTokens ?? 0) + (secondRun.usage?.outputTokens ?? 0),
			});
		} finally {
			await memory.close();
		}
	});
});
