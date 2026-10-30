import { describe, expect, it } from "vitest";
import { assistant, tool, user } from "./fixtures.ts";
import {
	isSubagentCall,
	plainText,
	SUBAGENT_STOPPED,
	subagentActivity,
	subagentOf,
	subagentStatus,
} from "./subagent-model.ts";

describe("subagentOf", () => {
	it("reads the title, the task and, once done, the answer's opening in plain words", () => {
		const running = tool("s1", "subagent", "subagent", {
			status: "running",
			args: { task: "Find the **flaky** test in `billing/`\nthen fix it", title: "Find the flaky test" },
		});
		expect(isSubagentCall(running)).toBe(true);
		expect(isSubagentCall(tool("x1", "bash", "Ran ls"))).toBe(false);
		expect(subagentOf(running)).toEqual({
			title: "Find the flaky test",
			task: "Find the flaky test in billing/ then fix it",
			summary: undefined,
		});
		const done = { ...running, status: "done" as const, output: "## Found it\n- `refund.test.ts` [line 40](x)" };
		expect(subagentOf(done).summary).toBe("Found it refund.test.ts line 40");
	});

	it("names an untitled call after its task's first line, and one with nothing after itself", () => {
		expect(subagentOf(tool("s1", "subagent", "subagent", { args: { task: "# Count tests\nAll of them" } })).title).toBe(
			"Count tests",
		);
		expect(subagentOf(tool("s2", "subagent", "subagent", { args: {} })).title).toBe("Subagent");
	});

	it("says what a working subagent is doing: its latest call, else the last line it wrote, else thinking", () => {
		const task = user("u1", "Count the refund tests");
		expect(subagentActivity([])).toBeUndefined();
		expect(subagentActivity([task])).toBeUndefined();
		expect(subagentActivity([task, assistant("a1", "", { thinking: "Hmm" })])).toBe("Thinking");
		expect(subagentActivity([task, assistant("a1", "I'll look.\n\n**Reading** the tests")])).toBe("Reading the tests");
		expect(
			subagentActivity([task, assistant("a1", "I'll look."), tool("t1", "read", "Reading billing/refund.test.ts")]),
		).toBe("Reading billing/refund.test.ts");
		// An empty message after a call doesn't hide the call.
		expect(subagentActivity([task, tool("t1", "bash", "Calling bash"), assistant("a2", "")])).toBe("Calling bash");
	});

	it("names a subagent's own subagent by its title while it waits on it", () => {
		const nested = tool("s1", "subagent", "Calling subagent", {
			status: "running",
			args: { task: "Count the partial refunds", title: "Partial refunds" },
		});
		expect(subagentActivity([user("u1", "Go"), nested])).toBe("Waiting on its subagent: Partial refunds");
		expect(subagentActivity([user("u1", "Go"), { ...nested, status: "done" }])).toBe(
			"Heard back from its subagent: Partial refunds",
		);
	});

	it("keeps plain text plain", () => {
		expect(plainText("a  b\n\nc")).toBe("a b c");
		expect(plainText("```ts\nconst x = 1;\n```\nDone")).toBe("Done");
	});
});

describe("subagentStatus", () => {
	it("says a call whose subagent was stopped is stopped, not failed", () => {
		const call = tool("s1", "subagent", "subagent", { status: "running", args: { task: "Go" } });
		expect(subagentStatus(call)).toBe("running");
		expect(subagentStatus({ ...call, status: "error", output: SUBAGENT_STOPPED })).toBe("interrupted");
		expect(subagentStatus({ ...call, status: "error", output: "The subagent failed: no model" })).toBe("error");
		expect(subagentStatus({ ...call, status: "done", output: "Found it" })).toBe("done");
	});
});
