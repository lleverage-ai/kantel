import type { ToolItem } from "@harbour/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { loadHighlighter } from "../code/code.tsx";
import { ToolCallChip } from "./tool-call.tsx";
import {
	commandEnd,
	openByDefault,
	readRange,
	shortCommand,
	splitHarness,
	toolView,
	toolViewLabel,
} from "./tool-views-model.ts";

const tool = (name: string, args: unknown, patch: Partial<ToolItem> = {}): ToolItem => ({
	kind: "tool",
	id: `t-${name}`,
	at: 0,
	callId: `c-${name}`,
	name,
	label: `Calling ${name}`,
	status: "done",
	args,
	...patch,
});

describe("toolView", () => {
	it("gives the coding tools their cards and leaves any other tool to the generic detail", () => {
		expect(toolView({ name: "write", args: { path: "a.py", content: "x" } })).toEqual({
			kind: "write",
			path: "a.py",
			content: "x",
		});
		expect(toolView({ name: "read", args: { path: "a.py", offset: 10, limit: 5 } })).toEqual({
			kind: "read",
			path: "a.py",
			offset: 10,
			limit: 5,
		});
		expect(toolView({ name: "bash", args: { command: "ls", timeout: 30 } })).toEqual({
			kind: "bash",
			command: "ls",
			timeout: 30,
		});
		expect(toolView({ name: "grep", args: { pattern: "x" } })).toBeUndefined();
		expect(toolView({ name: "write", args: "not an object" })).toBeUndefined();
		expect(toolView({ name: "write", args: { path: 3 } })).toBeUndefined();
	});

	it("takes whatever a streaming call has so far", () => {
		expect(toolView({ name: "write", args: {} })).toEqual({ kind: "write", path: "", content: "" });
		expect(toolView({ name: "write", args: undefined })).toEqual({ kind: "write", path: "", content: "" });
		expect(toolView({ name: "bash", args: {} })).toEqual({ kind: "bash", command: "" });
		expect(toolView({ name: "edit", args: { path: "a.ts", edits: [{ oldText: "con" }] } })).toEqual({
			kind: "edit",
			path: "a.ts",
			edits: [{ oldText: "con", newText: "" }],
		});
		expect(toolView({ name: "edit", args: { path: "a.ts", edits: [] }, streaming: true })).toEqual({
			kind: "edit",
			path: "a.ts",
			edits: [],
		});
	});

	it("leaves a finished edit with nothing to diff to the generic detail", () => {
		expect(toolView({ name: "edit", args: { path: "a.ts", old: "x", new: "y" } })).toBeUndefined();
	});

	it("reads an edit's single-edit form and edits sent as a JSON string", () => {
		expect(toolView({ name: "edit", args: { path: "a", oldText: "x", newText: "y" } })).toMatchObject({
			edits: [{ oldText: "x", newText: "y" }],
		});
		expect(
			toolView({ name: "edit", args: { path: "a", edits: JSON.stringify([{ oldText: "x", newText: "y" }]) } }),
		).toMatchObject({ edits: [{ oldText: "x", newText: "y" }] });
	});

	it("opens write, edit and bash cards and leaves a read to be opened", () => {
		expect(openByDefault(toolView({ name: "write", args: {} }))).toBe(true);
		expect(openByDefault(toolView({ name: "bash", args: {} }))).toBe(true);
		expect(openByDefault(toolView({ name: "read", args: {} }))).toBe(false);
		expect(openByDefault(undefined)).toBe(false);
	});
});

describe("toolViewLabel", () => {
	it("says what the call does in the tense of its status", () => {
		const write = toolView({ name: "write", args: { path: "notes/plan.py", content: "" } });
		if (write === undefined) throw new Error("no view");
		expect(toolViewLabel(write, "running")).toBe("Writing notes/plan.py");
		expect(toolViewLabel(write, "done")).toBe("Wrote notes/plan.py");
		expect(toolViewLabel({ kind: "write", path: "", content: "" }, "running")).toBe("Writing a file");
		expect(toolViewLabel({ kind: "bash", command: "pnpm test\npnpm lint" }, "error")).toBe("Ran pnpm test\u2026");
		expect(toolViewLabel({ kind: "bash", command: "" }, "running")).toBe("Running a command");
	});

	it("cuts a long command", () => {
		expect(shortCommand("x".repeat(100))).toBe(`${"x".repeat(72)}\u2026`);
	});
});

describe("splitHarness and commandEnd", () => {
	it("takes the harness's notes off a result and turns an exit code into the command's end", () => {
		const output = "Traceback\nValueError: bad\n\n<harness>\n[error] Command exited with code 2\n</harness>";
		const { body, notes } = splitHarness(output);
		expect(body).toBe("Traceback\nValueError: bad\n\n");
		expect(notes).toEqual([{ severity: "error", message: "Command exited with code 2" }]);
		expect(commandEnd("error", body, notes)).toEqual({ end: { kind: "exited", code: 2 }, notes: [] });
	});

	it("keeps other notes, and reads warnings", () => {
		const { notes } = splitHarness(
			"out\n<harness>\n[warn] Output truncated to its end: 10 lines, 400 bytes dropped\n[info] Full output: /tmp/x\n</harness>",
		);
		expect(commandEnd("done", "out", notes)).toEqual({
			end: { kind: "exited", code: 0 },
			notes: [
				{ severity: "warn", message: "Output truncated to its end: 10 lines, 400 bytes dropped" },
				{ severity: "info", message: "Full output: /tmp/x" },
			],
		});
	});

	it("tells a timeout, an interruption and a failure without an exit code", () => {
		expect(commandEnd("error", "partial\nCommand timed out after 30 seconds", []).end).toEqual({
			kind: "timed-out",
			message: "Command timed out after 30 seconds",
		});
		expect(commandEnd("interrupted", "", []).end).toEqual({ kind: "interrupted" });
		expect(commandEnd("error", "boom", [{ severity: "error", message: "No such sandbox" }]).end).toEqual({
			kind: "failed",
			message: "No such sandbox",
		});
		expect(commandEnd("running", "", []).end).toEqual({ kind: "running" });
	});

	it("leaves output without notes alone", () => {
		expect(splitHarness("a <harness> b")).toEqual({ body: "a <harness> b", notes: [] });
	});
});

describe("readRange", () => {
	it("numbers a read from its offset, and says when it read part of the file", () => {
		expect(readRange({ kind: "read", path: "a" }, 40, [])).toEqual({ start: 1, end: 40, partial: false });
		expect(readRange({ kind: "read", path: "a", offset: 120, limit: 10 }, 10, [])).toEqual({
			start: 120,
			end: 129,
			partial: true,
		});
		expect(
			readRange({ kind: "read", path: "a" }, 2000, [
				{ severity: "info", message: "Showing lines 1-2000 of 5000. Use offset=2001 to continue." },
			]).partial,
		).toBe(true);
	});
});

const render = (item: ToolItem) => renderToStaticMarkup(createElement(ToolCallChip, { item }));

describe("ToolCallChip with a card", () => {
	beforeAll(async () => {
		await loadHighlighter();
	});

	it("shows a write streaming in: its path, the code so far, highlighted, with a caret", () => {
		const html = render(
			tool(
				"write",
				{ path: "notes/plan.py", content: "import sys\nfrom datetime import date\nprint(" },
				{
					status: "running",
					streaming: true,
				},
			),
		);
		expect(html).toContain("Writing notes/plan.py");
		expect(html).toContain('class="hb-tool-card-file">plan.py');
		expect(html).toContain("Python");
		expect(html).toContain('<span class="hljs-keyword">import</span>');
		expect(html).toContain("hb-code-caret");
		// Line numbers in the gutter, not the escaped JSON the generic detail shows.
		expect(html).toContain("1\n2\n3\n");
		expect(html).not.toContain("\\n");
		expect(html).not.toContain("Arguments");
	});

	it("shows a written file whole, without a caret, and the tool's words under it", () => {
		const html = render(
			tool("write", { path: "a.py", content: "x = 1\n" }, { output: "Successfully wrote to a.py", endedAt: 5 }),
		);
		expect(html).toContain("Wrote a.py");
		expect(html).not.toContain("hb-code-caret");
		expect(html).toContain("Successfully wrote to a.py");
		expect(html).toContain("1 line");
	});

	it("shows a failed write's error in the error tone", () => {
		const html = render(
			tool("write", { path: "/etc/x", content: "y" }, { status: "error", output: "EACCES: permission denied" }),
		);
		expect(html).toContain("hb-tool-card-error");
		expect(html).toContain('class="hb-tool-card-result hb-tool-card-result-failed" role="alert"');
		expect(html).toContain("EACCES: permission denied");
	});

	it("shows a command as a terminal, with its exit code and failure", () => {
		const html = render(
			tool(
				"bash",
				{ command: "python notes/plan.py" },
				{
					status: "error",
					output:
						"Traceback (most recent call last):\n\u001b[31mValueError\u001b[0m: bad\n\n<harness>\n[error] Command exited with code 2\n</harness>",
				},
			),
		);
		expect(html).toContain("Ran python notes/plan.py");
		expect(html).toContain("hb-terminal-prompt");
		expect(html).toContain('class="hb-ansi-fg-1">ValueError');
		expect(html).toContain("Exit 2");
		expect(html).toContain("hb-status-error");
		expect(html).not.toContain("&lt;harness&gt;");
		expect(html).not.toContain("Command exited with code 2");
	});

	it("shows a successful command's exit code", () => {
		const html = render(tool("bash", { command: "ls" }, { output: "a.py\nb.py\n" }));
		expect(html).toContain("Exit 0");
		expect(html).toContain("hb-status-done");
	});

	it("shows a command being written with a caret after it and no output yet", () => {
		const html = render(tool("bash", { command: "pnpm te" }, { status: "running", streaming: true }));
		expect(html).toContain("Running pnpm te");
		expect(html).toContain("hb-code-caret");
		expect(html).not.toContain("hb-terminal-scroll");
	});

	it("shows a running command's output so far with a working caret", () => {
		const html = render(tool("bash", { command: "pnpm test" }, { status: "running", output: "RUN v4\n" }));
		expect(html).toContain("hb-terminal-caret");
		expect(html).toContain("RUN v4");
	});

	it("shows an edit as a diff with its counts", () => {
		const html = render(
			tool("edit", {
				path: "src/app.ts",
				edits: [{ oldText: "const a = 1;\nconst b = 2;", newText: "const a = 1;\nconst b = 3;" }],
			}),
		);
		expect(html).toContain("Edited src/app.ts");
		expect(html).toContain("hb-diff-row-del");
		expect(html).toContain("hb-diff-row-add");
		expect(html).toContain("+1");
		expect(html).toContain("\u22121");
	});

	it("leaves a read closed until it is opened, and its card numbers lines from the offset", () => {
		const closed = render(tool("read", { path: "a.py" }, { output: "x = 1\n" }));
		expect(closed).toContain("Read a.py");
		expect(closed).not.toContain("hb-tool-card");
		const open = renderToStaticMarkup(
			createElement(ToolCallChip, {
				item: tool(
					"read",
					{ path: "a.py", offset: 41, limit: 2 },
					{
						output: "x = 1\ny = 2\n\n<harness>\n[info] 10 more lines in file. Use offset=43 to continue.\n</harness>",
					},
				),
				defaultOpen: true,
			}),
		);
		expect(open).toContain("Lines 41");
		expect(open).toContain("41\n42\n");
		expect(open).toContain("10 more lines in file");
	});

	it("keeps the raw toggle on every card, and other tools on the generic detail", () => {
		expect(render(tool("write", { path: "a", content: "" }))).toContain('aria-pressed="false"');
		const other = renderToStaticMarkup(
			createElement(ToolCallChip, { item: tool("grep", { pattern: "x" }, { output: "a:1" }), defaultOpen: true }),
		);
		expect(other).toContain("Arguments");
		expect(other).not.toContain("hb-tool-card");
	});

	it("collapses a long file to a window with Show all", () => {
		const content = Array.from({ length: 40 }, (_, index) => `line_${index} = ${index}`).join("\n");
		const html = render(tool("write", { path: "long.py", content }));
		expect(html).toContain("hb-code-view-collapsed");
		expect(html).toContain("Show all 40 lines");
	});
});
