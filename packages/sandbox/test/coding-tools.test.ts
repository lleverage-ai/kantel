// The coding tools' concurrency classes: a round with `write`, `edit` or `bash` runs in the order the model made its
// calls (Pi Durable runs a round sequentially when one of its tools is `executionMode: "sequential"`), so a command sees
// a file written beside it; `read` and `ls` only read, so a round of only those still runs at once.
import { describe, expect, it } from "vitest";
import { CODING_TOOLS, codingTools, IN_CALL_ORDER, inCallOrder } from "../src/coding-tools.ts";

describe("coding tools' concurrency classes", () => {
	it("runs a round with write, edit or bash in call order and leaves read and ls to run at once", () => {
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
