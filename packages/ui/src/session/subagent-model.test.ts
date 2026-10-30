import { describe, expect, it } from "vitest";
import { tool } from "./fixtures.ts";
import { isSubagentCall, plainText, subagentOf } from "./subagent-model.ts";

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

	it("keeps plain text plain", () => {
		expect(plainText("a  b\n\nc")).toBe("a b c");
		expect(plainText("```ts\nconst x = 1;\n```\nDone")).toBe("Done");
	});
});
