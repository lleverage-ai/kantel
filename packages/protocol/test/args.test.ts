import {
	appendArgs,
	applyDelta,
	argsAppends,
	PROTOCOL_VERSION,
	ProtocolError,
	type SessionSnapshot,
	type ToolItem,
} from "@kantel/protocol";
import { describe, expect, it } from "vitest";

describe("argsAppends", () => {
	it("says a grown string, and a new one, as appends", () => {
		expect(argsAppends({}, { path: "a" })).toEqual([{ path: ["path"], append: "a" }]);
		expect(argsAppends({ path: "a" }, { path: "a.py", content: "x" })).toEqual([
			{ path: ["path"], append: ".py" },
			{ path: ["content"], append: "x" },
		]);
		expect(argsAppends({ path: "a" }, { path: "a" })).toEqual([]);
		// A key whose value has only begun: `"content": "`.
		expect(argsAppends({ path: "a" }, { path: "a", content: "" })).toEqual([{ path: ["content"], append: "" }]);
		expect(appendArgs({ path: "a" }, ["content"], "")).toEqual({ path: "a", content: "" });
	});

	it("creates arrays and objects on the way to a new string", () => {
		expect(argsAppends({ path: "a" }, { path: "a", edits: [{ oldText: "x" }] })).toEqual([
			{ path: ["edits", 0, "oldText"], append: "x" },
		]);
		expect(
			argsAppends(
				{ edits: [{ oldText: "x", newText: "y" }] },
				{ edits: [{ oldText: "x", newText: "yz" }, { oldText: "q" }] },
			),
		).toEqual([
			{ path: ["edits", 0, "newText"], append: "z" },
			{ path: ["edits", 1, "oldText"], append: "q" },
		]);
	});

	it("can't say a rewritten string, a new number, a removed key or an empty container", () => {
		expect(argsAppends({ path: "ab" }, { path: "ac" })).toBeUndefined();
		expect(argsAppends({ command: "ls" }, { command: "ls", timeout: 5 })).toBeUndefined();
		expect(argsAppends({ a: "x", b: "y" }, { a: "x" })).toBeUndefined();
		expect(argsAppends({}, { edits: [] })).toBeUndefined();
		expect(argsAppends({ timeout: 5 }, { timeout: 5 })).toEqual([]);
	});
});

describe("appendArgs", () => {
	it("appends at a path, copying only what is on the way", () => {
		const shared = { keep: true };
		const before = { path: "a", other: shared };
		const after = appendArgs(before, ["path"], ".py") as typeof before;
		expect(after).toEqual({ path: "a.py", other: { keep: true } });
		expect(after.other).toBe(shared);
		expect(before.path).toBe("a");
	});

	it("creates missing strings and containers", () => {
		expect(appendArgs(undefined, ["edits", 0, "oldText"], "x")).toEqual({ edits: [{ oldText: "x" }] });
	});

	it("refuses a path through a value that isn't a container or to a leaf that isn't a string", () => {
		expect(appendArgs({ timeout: 5 }, ["timeout"], "x")).toBeUndefined();
		expect(appendArgs({ path: "a" }, ["path", "x"], "y")).toBeUndefined();
	});

	it("reproduces any growth argsAppends describes", () => {
		const steps = [
			{},
			{ path: "src/a" },
			{ path: "src/a.ts", edits: [{ oldText: "con" }] },
			{ path: "src/a.ts", edits: [{ oldText: "const a", newText: "let" }] },
			{ path: "src/a.ts", edits: [{ oldText: "const a", newText: "let a" }, { oldText: "b" }] },
		];
		let args: unknown = steps[0];
		for (const next of steps.slice(1)) {
			for (const { path, append } of argsAppends(args, next) ?? []) args = appendArgs(args, path, append);
			expect(args).toEqual(next);
		}
	});
});

describe("the args op", () => {
	const tool: ToolItem = {
		kind: "tool",
		id: "t1",
		at: 0,
		callId: "c1",
		name: "write",
		label: "Writing",
		status: "running",
		args: { path: "a.py" },
		streaming: true,
	};
	const snapshot: SessionSnapshot = {
		v: PROTOCOL_VERSION,
		sessionId: "s",
		cursor: "c0",
		status: "running",
		attention: "working",
		items: [tool],
		hasEarlier: false,
		updatedAt: 0,
	};
	const delta = (ops: unknown[]) => ({ sessionId: "s", cursor: "c1", at: 1, ops }) as Parameters<typeof applyDelta>[1];

	it("grows a tool item's arguments", () => {
		const next = applyDelta(
			snapshot,
			delta([
				{ op: "args", itemId: "t1", path: ["content"], append: "import " },
				{ op: "args", itemId: "t1", path: ["content"], append: "sys" },
			]),
		);
		expect(next.items[0]).toEqual({ ...tool, args: { path: "a.py", content: "import sys" } });
	});

	it("refuses an unknown item, a non-tool item and a path to a non-string", () => {
		expect(() => applyDelta(snapshot, delta([{ op: "args", itemId: "x", path: ["a"], append: "b" }]))).toThrow(
			ProtocolError,
		);
		const withUser = {
			...snapshot,
			items: [...snapshot.items, { kind: "user", id: "u", at: 0, text: "", via: "prompt" }],
		};
		expect(() =>
			applyDelta(withUser as SessionSnapshot, delta([{ op: "args", itemId: "u", path: ["a"], append: "b" }])),
		).toThrow(ProtocolError);
		expect(() =>
			applyDelta(
				{ ...snapshot, items: [{ ...tool, args: { timeout: 5 } }] },
				delta([{ op: "args", itemId: "t1", path: ["timeout"], append: "1" }]),
			),
		).toThrow(ProtocolError);
	});

	it("skips an item older than the snapshot's page", () => {
		const paged = { ...snapshot, hasEarlier: true };
		expect(applyDelta(paged, delta([{ op: "args", itemId: "old", path: ["a"], append: "b" }])).items).toEqual([tool]);
	});
});
