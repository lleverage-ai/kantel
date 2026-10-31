// How one model step's tool calls (a Pi Durable round) run, with the partitioned rounds of Kantel's Pi Durable patch
// (patches/@earendil-works__pi-durable@1.4.0.patch): walking the calls in the order the model made them, consecutive
// calls of tools with no execution mode (or `parallel`) run at once as one batch, and a call of a tool that is
// `executionMode: "sequential"` is a barrier: it waits for every call before it, runs alone, and finishes before any
// call after it starts. Results reach the model in call order whatever order the calls finished in.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionMode, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentProfile } from "@kantel/contracts";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { describe, expect, it } from "vitest";

const ORG = "org-rounds";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
const TOOLS = ["read", "write", "bash", "fail", "fetch", "lookup"];

const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools: TOOLS,
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const labelSchema = Type.Object({ label: Type.String() });

function setUp() {
	const { models, script } = createScriptedModel();
	/** Every call's start and end, as `start <label>` and `end <label>`, in the order they happened. */
	const log: string[] = [];
	const tool = (name: string, mode: ToolExecutionMode | undefined, fails = false): ToolRegistration =>
		defineTool({
			name,
			description: `A stand-in ${name}`,
			parameters: labelSchema,
			...(mode === undefined ? {} : { executionMode: mode }),
			async execute(args) {
				log.push(`start ${args.label}`);
				// Long enough that calls started together overlap, so a batch shows as one group.
				await sleep(40);
				log.push(`end ${args.label}`);
				if (fails) throw new Error(`${args.label} failed`);
				return { output: [{ type: "text", text: `${name} ${args.label}` }] };
			},
		}) as unknown as ToolRegistration;
	const tools = [
		// Marked as Kantel marks its tools: `read` none, `write` and `bash` sequential (`inCallOrder()`).
		tool("read", undefined),
		tool("write", "sequential"),
		tool("bash", "sequential"),
		tool("fail", "sequential", true),
		// Explicitly parallel, and a tool with no mode at all: neither is a barrier.
		tool("fetch", "parallel"),
		tool("lookup", undefined),
	];
	const service = createMemoryRuntime({ models, tools: () => tools });
	/** Runs one step of `calls` (`[tool, label]`) and answers; returns the tool results the model got, in its order. */
	const step = async (calls: readonly (readonly [string, string])[]) => {
		await service.profiles.put(ctx, profile);
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ toolCalls: calls.map(([name, label]) => ({ name, args: { label } })) }, { text: "Done" });
		const submission = await service.runtime.prompt(ctx, session.id, { text: "Go" });
		expect(await service.runtime.wait(ctx, session.id, submission.id)).toMatchObject({ answer: "Done" });
		return (
			script.requests
				.at(-1)
				?.messages.filter((message) => message.role === "tool")
				.map((message) => message.text) ?? []
		);
	};
	return { service, log, step };
}

/** The log as groups of calls that ran at once: a group closes when nothing is running. */
function batches(log: readonly string[]): string[][] {
	const groups: string[][] = [];
	let current: string[] = [];
	let running = 0;
	for (const event of log) {
		const [kind, label] = event.split(" ") as [string, string];
		if (kind === "start") {
			current.push(label);
			running++;
		} else {
			running--;
			if (running === 0) {
				groups.push(current);
				current = [];
			}
		}
	}
	return groups;
}

describe("a round's tool calls, partitioned at its barriers", () => {
	it("runs read and read at once", async () => {
		const { service, log, step } = setUp();
		try {
			const results = await step([
				["read", "r1"],
				["read", "r2"],
			]);
			expect(batches(log)).toEqual([["r1", "r2"]]);
			expect(results).toEqual(["read r1", "read r2"]);
		} finally {
			await service.close();
		}
	});

	it("runs write then bash one after the other, in call order", async () => {
		const { service, log, step } = setUp();
		try {
			const results = await step([
				["write", "w"],
				["bash", "b"],
			]);
			expect(log).toEqual(["start w", "end w", "start b", "end b"]);
			expect(results).toEqual(["write w", "bash b"]);
		} finally {
			await service.close();
		}
	});

	it("runs read, read, write, read, read as [read, read] [write] [read, read], results in call order", async () => {
		const { service, log, step } = setUp();
		try {
			const results = await step([
				["read", "r1"],
				["read", "r2"],
				["write", "w"],
				["read", "r3"],
				["read", "r4"],
			]);
			expect(batches(log)).toEqual([["r1", "r2"], ["w"], ["r3", "r4"]]);
			expect(results).toEqual(["read r1", "read r2", "write w", "read r3", "read r4"]);
		} finally {
			await service.close();
		}
	});

	it("starts a round that opens with a barrier with that call alone", async () => {
		const { service, log, step } = setUp();
		try {
			await step([
				["bash", "b"],
				["read", "r1"],
				["read", "r2"],
				["write", "w1"],
				["write", "w2"],
			]);
			expect(batches(log)).toEqual([["b"], ["r1", "r2"], ["w1"], ["w2"]]);
		} finally {
			await service.close();
		}
	});

	it("treats a tool with no execution mode, or parallel, as safe to run at once", async () => {
		const { service, log, step } = setUp();
		try {
			await step([
				["lookup", "l"],
				["fetch", "f"],
				["read", "r"],
			]);
			expect(batches(log)).toEqual([["l", "f", "r"]]);
		} finally {
			await service.close();
		}
	});

	it("still runs the calls after a barrier that fails, as a sequential round did", async () => {
		const { service, log, step } = setUp();
		try {
			const results = await step([
				["read", "r1"],
				["fail", "x"],
				["read", "r2"],
				["write", "w"],
			]);
			expect(batches(log)).toEqual([["r1"], ["x"], ["r2"], ["w"]]);
			expect(results[0]).toBe("read r1");
			expect(results[1]).toContain("x failed");
			expect(results.slice(2)).toEqual(["read r2", "write w"]);
		} finally {
			await service.close();
		}
	});
});
