// The coding tools' concurrency classes: each `write`, `edit` or `bash` call is a barrier in its round (Harbour's Pi
// Durable patch runs an `executionMode: "sequential"` call alone, after the calls before it), so a command sees a file
// written before it; `read` and `ls` only read, so consecutive calls of them run at once.
import { describe, expect, it } from "vitest";
import { CODING_TOOLS, codingTools, IN_CALL_ORDER, inCallOrder } from "../src/coding-tools.ts";

describe("coding tools' concurrency classes", () => {
	it("makes write, edit and bash barriers and leaves read and ls to run at once", () => {
		const modes = Object.fromEntries(codingTools().map((tool) => [tool.name, tool.executionMode]));
		expect(modes).toEqual({
			read: undefined,
			write: "sequential",
			edit: "sequential",
			ls: undefined,
			bash: "sequential",
		});
		expect([...IN_CALL_ORDER].every((name) => (CODING_TOOLS as readonly string[]).includes(name))).toBe(true);
	});

	it("inCallOrder changes nothing else about a tool", () => {
		const [read] = codingTools();
		const ordered = inCallOrder(read!);
		expect(ordered).toEqual({ ...read, executionMode: "sequential" });
		expect(ordered.execute).toBe(read!.execute);
		expect(read!.executionMode).toBeUndefined();
	});
});
