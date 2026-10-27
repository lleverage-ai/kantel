import type { TranscriptItem } from "@harbour/protocol";
import { describe, expect, it } from "vitest";
import { assistant, finishedTurn, liveTurn, notice, tool, user } from "./fixtures.ts";
import { groupTranscript, type TranscriptRow } from "./transcript-model.ts";

const shape = (rows: readonly TranscriptRow[]) =>
	rows.map((row) =>
		row.kind === "item" ? `item ${row.id}` : `tools ${row.id} [${row.items.map((item) => item.id).join(",")}]${row.live ? " live" : ""}`,
	);

describe("groupTranscript", () => {
	it("groups consecutive tool calls into one row keyed by the first call", () => {
		expect(shape(groupTranscript(finishedTurn))).toEqual(["item u1", "tools t1 [t1,t2,t3,t4]", "item a1"]);
	});

	it("ends a group at any item that is not a tool call", () => {
		const items: TranscriptItem[] = [
			tool("x1", "read", "Read a.md"),
			tool("x2", "read", "Read b.md"),
			notice("n1", "warning", "The last command may have partly run."),
			tool("x3", "bash", "Ran ls"),
			assistant("a1", "Done."),
			tool("x4", "bash", "Ran pwd"),
		];
		expect(shape(groupTranscript(items))).toEqual([
			"tools x1 [x1,x2]",
			"item n1",
			"tools x3 [x3]",
			"item a1",
			"tools x4 [x4] live",
		]);
	});

	it("keeps a single tool call in a group, and marks only a trailing group live", () => {
		expect(shape(groupTranscript([user("u1", "Go"), tool("x1", "bash", "Running make", { status: "running" })]))).toEqual(
			["item u1", "tools x1 [x1] live"],
		);
		expect(shape(groupTranscript(liveTurn))).toEqual(["item u2", "tools t5 [t5,t6]", "item a2"]);
	});

	it("returns no rows for no items", () => {
		expect(groupTranscript([])).toEqual([]);
	});

	it("reuses every row whose items are unchanged while the last answer streams", () => {
		const items = [...finishedTurn, ...liveTurn];
		const first = groupTranscript(items);
		const last = items.at(-1);
		if (last?.kind !== "assistant") throw new Error("fixture changed");
		const streamed = [...items.slice(0, -1), { ...last, text: `${last.text}, all green so far` }];
		const second = groupTranscript(streamed, first);
		expect(second).not.toBe(first);
		expect(second.length).toBe(first.length);
		expect(second.slice(0, -1).every((row, index) => row === first[index])).toBe(true);
		expect(second.at(-1)).not.toBe(first.at(-1));
	});

	it("replaces only the group whose tool call changed", () => {
		const items = [...finishedTurn, ...liveTurn];
		const first = groupTranscript(items);
		const updated = items.map((item) =>
			item.id === "t6" && item.kind === "tool" ? { ...item, output: `${item.output}\n done` } : item,
		);
		const second = groupTranscript(updated, first);
		const changed = second.filter((row, index) => row !== first[index]).map((row) => row.id);
		expect(changed).toEqual(["t5"]);
	});

	it("returns the previous rows themselves when nothing changed", () => {
		const items = [...finishedTurn, ...liveTurn];
		const first = groupTranscript(items);
		expect(groupTranscript([...items], first)).toBe(first);
	});

	it("makes a new row when a trailing group stops being live", () => {
		const items: TranscriptItem[] = [user("u1", "Go"), tool("x1", "bash", "Ran make"), tool("x2", "bash", "Ran test")];
		const first = groupTranscript(items);
		expect(first.at(-1)).toMatchObject({ kind: "tools", live: true });
		const second = groupTranscript([...items, assistant("a1", "Both passed.")], first);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).not.toBe(first[1]);
		expect(second[1]).toMatchObject({ kind: "tools", id: "x1", live: false });
	});

	it("keeps a group's key as calls are added to it", () => {
		const items: TranscriptItem[] = [user("u1", "Go"), tool("x1", "bash", "Ran make")];
		const first = groupTranscript(items);
		const second = groupTranscript([...items, tool("x2", "bash", "Running test", { status: "running" })], first);
		expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
		expect(second[0]).toBe(first[0]);
	});
});
