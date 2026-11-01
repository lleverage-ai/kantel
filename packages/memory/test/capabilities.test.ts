import { type CallContext, type CapabilityInvocation, type JsonValue, KantelError } from "@kantel/contracts";
import {
	MEMORY_READ_CAPABILITY,
	MEMORY_SEARCH_CAPABILITY,
	memoryCapabilities,
	memoryCapabilityHandler,
} from "@kantel/memory";
import { createMemoryMemory } from "@kantel/memory/memory";
import { describe, expect, it } from "vitest";

const service: CallContext = { actor: { kind: "service", serviceId: "atlas" }, organisationId: "org-a" };

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

async function addSpace(memory: ReturnType<typeof createMemoryMemory>, name: string, statement: string) {
	const space = await memory.createSpace(service, {
		owner: { kind: "organisation", organisationId: "org-a" },
		name,
	});
	await memory.importSnapshot(service, space.id, {
		sourceId: "team-memory",
		ref: "7fbf30f",
		concepts: [
			{
				id: "personal/pr-review-timing",
				title: "PR review timing",
				description: "When Tom reviews",
				statement,
				scope: { kind: "global" },
				sources: ["slack:T1/C1/1"],
				setBy: "owner",
				status: "active",
				updatedAt: 1,
			},
		],
	});
	return space;
}

async function setup() {
	const memory = createMemoryMemory();
	const space = await addSpace(memory, "Team memory", "Tom reviews pull requests after lunch.");
	const handler = memoryCapabilityHandler({ memory, spaceIds: () => [space.id], now: () => 2 });
	return { handler, space, memory };
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

	it("refuses arguments of the wrong type or unknown ones", async () => {
		const { handler } = await setup();
		const signal = new AbortController().signal;
		const cases: JsonValue[] = [
			{ query: "review", limit: "1" },
			{ query: "review", limit: 0 },
			{ query: "review", limit: 1.5 },
			{ query: "review", includeInactive: "true" },
			{ query: "review", extra: 1 },
		];
		for (const args of cases) {
			expect((await handler(invocation(MEMORY_SEARCH_CAPABILITY, args), signal)).isError).toBe(true);
		}
		const read = await handler(invocation(MEMORY_READ_CAPABILITY, { concept: "personal/x", space: 3 }), signal);
		expect(read.isError).toBe(true);
	});

	it("names the space of each hit when a session reads several, and reads from the one named", async () => {
		const memory = createMemoryMemory();
		const first = await addSpace(memory, "A", "Tom reviews pull requests after lunch.");
		const second = await addSpace(memory, "B", "Tom batches kubernetes upgrades.");
		const handler = memoryCapabilityHandler({ memory, spaceIds: () => [first.id, second.id], now: () => 2 });
		const signal = new AbortController().signal;
		const search = await handler(invocation(MEMORY_SEARCH_CAPABILITY, { query: "kubernetes" }), signal);
		expect(search.output).toMatchObject({ ids: ["personal/pr-review-timing"], spaces: [second.id] });
		expect((search.output as { text: string }).text).toContain(`space ${second.id}`);
		const fromFirst = await handler(
			invocation(MEMORY_READ_CAPABILITY, { concept: "personal/pr-review-timing" }),
			signal,
		);
		expect((fromFirst.output as { text: string }).text).toContain("after lunch");
		const fromSecond = await handler(
			invocation(MEMORY_READ_CAPABILITY, { concept: "personal/pr-review-timing", space: second.id }),
			signal,
		);
		expect((fromSecond.output as { text: string }).text).toContain("kubernetes");
		const other = await handler(
			invocation(MEMORY_READ_CAPABILITY, { concept: "personal/pr-review-timing", space: "space-elsewhere" }),
			signal,
		);
		expect(other.isError).toBe(true);
	});

	it("returns a KantelError from resolving the session's spaces as an error result", async () => {
		const { memory } = await setup();
		const signal = new AbortController().signal;
		const failing = [
			() => {
				throw new KantelError("forbidden", "no memory for this session");
			},
			async () => {
				throw new KantelError("not_found", "session not found");
			},
		];
		for (const spaceIds of failing) {
			const handler = memoryCapabilityHandler({ memory, spaceIds, now: () => 2 });
			const result = await handler(invocation(MEMORY_SEARCH_CAPABILITY, { query: "pr" }), signal);
			expect(result.isError).toBe(true);
		}
		const crashing = memoryCapabilityHandler({
			memory,
			spaceIds: () => {
				throw new Error("bug");
			},
			now: () => 2,
		});
		await expect(crashing(invocation(MEMORY_SEARCH_CAPABILITY, { query: "pr" }), signal)).rejects.toThrow("bug");
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
