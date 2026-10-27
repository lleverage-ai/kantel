import type { CallContext, CapabilityInvocation, JsonValue } from "@harbour/contracts";
import {
	MEMORY_READ_CAPABILITY,
	MEMORY_SEARCH_CAPABILITY,
	memoryCapabilities,
	memoryCapabilityHandler,
} from "@harbour/memory";
import { createMemoryMemory } from "@harbour/memory/memory";
import { describe, expect, it } from "vitest";

const service: CallContext = { actor: { kind: "service", serviceId: "sal" }, organisationId: "org-a" };

function invocation(capability: string, args: JsonValue, organisationId = "org-a"): CapabilityInvocation {
	return {
		callId: `call-${capability}`,
		capability,
		version: "1",
		args,
		organisationId,
		projectId: "proj-a",
		sessionId: "session-1",
		agentId: "agent-1",
	};
}

async function setup() {
	const memory = createMemoryMemory();
	const space = await memory.createSpace(service, {
		owner: { kind: "organisation", organisationId: "org-a" },
		name: "Sal memory",
	});
	await memory.importSnapshot(service, space.id, {
		sourceId: "sal-memory",
		ref: "7fbf30f",
		concepts: [
			{
				id: "personal/pr-review-timing",
				title: "PR review timing",
				description: "When Tom reviews",
				statement: "Tom reviews pull requests after lunch.",
				scope: { kind: "global" },
				sources: ["slack:T1/C1/1"],
				setBy: "owner",
				status: "active",
				updatedAt: 1,
			},
		],
	});
	const handler = memoryCapabilityHandler({ memory, spaceIds: () => [space.id], now: () => 2 });
	return { handler, space };
}

describe("memory capabilities", () => {
	it("defines memory.search and memory.read as safe host capabilities", () => {
		expect(memoryCapabilities.map((definition) => [definition.name, definition.replay, definition.runsIn])).toEqual([
			[MEMORY_SEARCH_CAPABILITY, "safe", "host"],
			[MEMORY_READ_CAPABILITY, "safe", "host"],
		]);
	});

	it("searches and reads as the calling agent", async () => {
		const { handler } = await setup();
		const signal = new AbortController().signal;
		const search = await handler(invocation(MEMORY_SEARCH_CAPABILITY, { query: "pr review" }), signal);
		expect(search.isError).toBeUndefined();
		expect(search.output).toMatchObject({ ids: ["personal/pr-review-timing"] });
		expect((search.output as { text: string }).text).toContain(
			"- personal/pr-review-timing: PR review timing - When Tom reviews",
		);
		const none = await handler(invocation(MEMORY_SEARCH_CAPABILITY, { query: "kubernetes" }), signal);
		expect(none.output).toMatchObject({ text: "No matching concepts.", ids: [] });

		const read = await handler(invocation(MEMORY_READ_CAPABILITY, { concept: "personal/pr-review-timing" }), signal);
		expect((read.output as { text: string }).text).toContain("Tom reviews pull requests after lunch.");
		const missing = await handler(invocation(MEMORY_READ_CAPABILITY, { concept: "personal/missing" }), signal);
		expect(missing).toMatchObject({ isError: true, output: { text: "No concept personal/missing." } });
		const bad = await handler(invocation(MEMORY_SEARCH_CAPABILITY, { limit: 3 }), signal);
		expect(bad.isError).toBe(true);
	});

	it("reports another organisation's space as an error result, not a crash", async () => {
		const { handler } = await setup();
		const result = await handler(
			invocation(MEMORY_SEARCH_CAPABILITY, { query: "pr" }, "org-b"),
			new AbortController().signal,
		);
		expect(result.isError).toBe(true);
	});
});
