import type { ToolItem, TranscriptItem } from "@harbour/protocol";
import { describe, expect, it } from "vitest";
import { assistant, finishedTurn, liveTurn, notice, tool, user } from "./fixtures.ts";
import { browserViewSlots, finalAnswerIds, groupTranscript, type TranscriptRow } from "./transcript-model.ts";

const shape = (rows: readonly TranscriptRow[]) =>
	rows.map((row) =>
		row.kind === "item"
			? `item ${row.id}`
			: `tools ${row.id} [${row.items.map((item) => item.id).join(",")}]${row.live ? " live" : ""}`,
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
		expect(
			shape(groupTranscript([user("u1", "Go"), tool("x1", "bash", "Running make", { status: "running" })])),
		).toEqual(["item u1", "tools x1 [x1] live"]);
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

	it("never merges an older page's calls into a group already shown", () => {
		// The loaded page starts inside a run of calls: t3 and t4 show as a group of two.
		const page: TranscriptItem[] = [
			tool("t3", "bash", "Ran make"),
			tool("t4", "bash", "Ran make test"),
			assistant("a1", "Done."),
		];
		const shown = groupTranscript(page);
		expect(shape(shown)).toEqual(["tools t3 [t3,t4]", "item a1"]);
		// The page before it ends with t1 and t2. They form their own group; t3's group is the same row object, so the
		// reader's place, and the group's open or closed state, stay as they were.
		const older: TranscriptItem[] = [
			user("u1", "Go"),
			tool("t1", "read", "Read a.md"),
			tool("t2", "read", "Read b.md"),
		];
		const after = groupTranscript([...older, ...page], shown);
		expect(shape(after)).toEqual(["item u1", "tools t1 [t1,t2]", "tools t3 [t3,t4]", "item a1"]);
		expect(after[2]).toBe(shown[0]);
	});

	it("groups the same calls as one run when they arrive in one load", () => {
		const items: TranscriptItem[] = [
			tool("t1", "read", "Read a.md"),
			tool("t2", "read", "Read b.md"),
			tool("t3", "bash", "Ran make"),
			assistant("a1", "Done."),
		];
		expect(shape(groupTranscript(items))).toEqual(["tools t1 [t1,t2,t3]", "item a1"]);
	});
});

describe("finalAnswerIds", () => {
	it("picks each turn's last answer, not the words between tool calls", () => {
		const items: TranscriptItem[] = [
			user("u1", "Fix the bug."),
			assistant("a1", "Let me look."),
			tool("x1", "read", "Read a.md"),
			assistant("a2", "Fixed it."),
			notice("n1", "warning", "The last command may have partly run."),
			user("u2", "Thanks. Now the docs."),
			assistant("a3", "Reading them."),
			tool("x2", "read", "Read docs.md"),
		];
		expect([...finalAnswerIds(groupTranscript(items))]).toEqual(["a2"]);
	});

	it("counts a turn with only an answer", () => {
		const items: TranscriptItem[] = [
			user("u1", "Hi."),
			assistant("a1", "Hello."),
			user("u2", "Bye."),
			assistant("a2", "Bye."),
		];
		expect([...finalAnswerIds(groupTranscript(items))].sort()).toEqual(["a1", "a2"]);
	});
});

describe("browserViewSlots", () => {
	const shot = (data: string) => ({ mimeType: "image/png", data }) as const;
	const on = (item: ToolItem, browserSessionId: string, images?: ToolItem["images"]): ToolItem => ({
		...item,
		browserSessionId,
		...(images === undefined ? {} : { images }),
	});

	it("puts each browser's view under its newest call, with the last screenshot any call on it left", () => {
		const first = shot("first");
		const items: TranscriptItem[] = [
			user("u1", "Look it up"),
			tool("x1", "browser_request", "Asking for a browser"),
			on(tool("x2", "browser_open", "Opening example.com"), "bs_1", [first]),
			on(tool("x3", "browser_act", "Reading the page"), "bs_1"),
			assistant("a1", "Opening another."),
			on(tool("x4", "browser_open", "Opening example.org"), "bs_2", [shot("other")]),
		];
		const slots = browserViewSlots(groupTranscript(items));
		expect([...slots.keys()]).toEqual(["x1", "x4"]);
		expect(slots.get("x1")?.map((slot) => [slot.browserSessionId, slot.item.id, slot.screenshot])).toEqual([
			["bs_1", "x3", first],
		]);
		expect(slots.get("x4")?.map((slot) => [slot.browserSessionId, slot.item.id])).toEqual([["bs_2", "x4"]]);
	});

	it("moves a browser's view down to the row of its newest call, and keeps unchanged rows' slots", () => {
		const opened = on(tool("x1", "browser_open", "Opening example.com"), "bs_1", [shot("a")]);
		const other = on(tool("x2", "browser_open", "Opening example.org"), "bs_2");
		const before: TranscriptItem[] = [opened, other, assistant("a1", "Next.")];
		const rowsBefore = groupTranscript(before);
		const first = browserViewSlots(rowsBefore);
		expect(first.get("x1")?.map((slot) => slot.item.id)).toEqual(["x1", "x2"]);

		const stepped = on(tool("x3", "browser_act", "Clicking"), "bs_1", [shot("b")]);
		const after = browserViewSlots(groupTranscript([...before, stepped], rowsBefore), first);
		expect(after.get("x1")?.map((slot) => slot.item.id)).toEqual(["x2"]);
		expect(after.get("x3")?.map((slot) => slot.item.id)).toEqual(["x3"]);

		// Nothing changed: the same slot arrays come back, so their rows don't render again.
		const again = browserViewSlots(groupTranscript([...before, stepped], rowsBefore), after);
		expect(again.get("x1")).toBe(after.get("x1"));
		expect(again.get("x3")).toBe(after.get("x3"));
	});

	it("has no slots for calls that name no browser", () => {
		expect(browserViewSlots(groupTranscript(finishedTurn)).size).toBe(0);
	});
});
