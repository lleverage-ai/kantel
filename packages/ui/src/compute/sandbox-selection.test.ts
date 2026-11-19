import { describe, expect, it } from "vitest";
import {
	forgetRead,
	keepShown,
	type LocalChange,
	retryTargets,
	stillToDo,
	withLocal,
	withRead,
} from "./sandbox-selection.ts";

describe("a change's answer", () => {
	const box = (state: string) => ({ id: "a", state });
	type Row = ReturnType<typeof box>;
	const shown = (local: ReadonlyMap<string, LocalChange<Row>>) => local.get("a")?.box;

	it("shows when nothing that started after its call is known of the sandbox", () => {
		const local = withRead(new Map<string, LocalChange<Row>>(), "a", box("stopping"), 1, 0);
		expect(shown(local)).toEqual(box("stopping"));
	});

	it("loses to a read that started after its call, whichever answers first", () => {
		// Stop sent at 1; the sandbox read again at 2, finding it stopped.
		const readFirst = withRead(withRead(new Map(), "a", box("stopped"), 2, 0), "a", box("stopping"), 1, 0);
		expect(shown(readFirst)).toEqual(box("stopped"));
		const stopFirst = withRead(withRead(new Map(), "a", box("stopping"), 1, 0), "a", box("stopped"), 2, 0);
		expect(shown(stopFirst)).toEqual(box("stopped"));
		// And to a read of the list that started after it.
		expect(withRead(new Map(), "a", box("stopping"), 1, 2).size).toBe(0);
	});

	it("doesn't bring back a sandbox deleted after its call (a create, a fork, a bulk stop)", () => {
		const deleted = withRead(new Map<string, LocalChange<Row>>(), "a", null, 2, 0);
		expect(withRead(deleted, "a", box("running"), 1, 0)).toBe(deleted);
		expect(shown(deleted)).toBeNull();
	});

	it("loses to a later change of the page's own", () => {
		const later = withRead(new Map<string, LocalChange<Row>>(), "a", box("running"), 3, 0);
		expect(shown(withRead(later, "a", box("stopping"), 2, 0))).toEqual(box("running"));
	});
});

describe("the ticked sandboxes", () => {
	it("drops one a search hides, so clearing the search doesn't tick it again", () => {
		let ticked: ReadonlySet<string> = new Set(["a"]);
		ticked = keepShown(ticked, ["b"]);
		ticked = new Set([...ticked, "b"]);
		ticked = keepShown(ticked, ["a", "b", "c"]);
		expect([...ticked]).toEqual(["b"]);
	});

	it("is unchanged by a refresh that still shows them all", () => {
		const ticked: ReadonlySet<string> = new Set(["a", "b"]);
		expect(keepShown(ticked, ["c", "b", "a"])).toBe(ticked);
	});
});

describe("a bulk delete that partly failed", () => {
	it("tries again only the ones that failed", () => {
		const results: PromiseSettledResult<unknown>[] = [
			{ status: "fulfilled", value: undefined },
			{ status: "rejected", reason: new Error("busy") },
			{ status: "fulfilled", value: undefined },
		];
		expect(stillToDo(["a", "b", "c"], results)).toEqual(["b"]);
		expect(stillToDo(["a"], [{ status: "fulfilled", value: undefined }])).toEqual([]);
	});

	const partly: PromiseSettledResult<unknown>[] = [
		{ status: "fulfilled", value: undefined },
		{ status: "rejected", reason: new Error("busy") },
	];

	it("keeps the confirmation open on the failed ones while it still asks about them", () => {
		const attempted = ["a", "b"];
		expect(retryTargets(attempted, attempted, partly)).toEqual(["b"]);
	});

	it("doesn't reopen a confirmation closed while it ran", () => {
		expect(retryTargets(undefined, ["a", "b"], partly)).toBeUndefined();
	});

	it("leaves a confirmation opened since on its own targets", () => {
		const newer = ["c"];
		expect(retryTargets(newer, ["a", "b"], partly)).toBe(newer);
		// The same names in a new confirmation are still a new confirmation.
		const again = ["a", "b"];
		expect(retryTargets(again, ["a", "b"], partly)).toBe(again);
	});
});

describe("the page's changes over the list", () => {
	type Box = { readonly id: string; readonly createdAt: number; readonly state: string };
	const box = (id: string, state = "running", createdAt = 1): Box => ({ id, createdAt, state });
	const local = (...each: [string, Box | null, number][]): ReadonlyMap<string, LocalChange<Box>> =>
		new Map(each.map(([id, changed, seq]) => [id, { box: changed, seq }]));

	it("shows each change over the list, a deletion as no row, newest first", () => {
		const shown = withLocal(
			[box("a", "running", 1), box("b", "running", 2)],
			local(["a", box("a", "stopping", 1), 1], ["b", null, 1], ["c", box("c", "starting", 3), 1]),
		);
		expect(shown).toEqual([box("c", "starting", 3), box("a", "stopping", 1)]);
	});

	it("lets a newer list have the last word, by listing a sandbox or by leaving it out", () => {
		const changes = local(["a", box("a", "stopped"), 1], ["b", null, 2], ["c", box("c"), 3]);
		// The list started after all three: `c` it leaves out was deleted while the feed was away.
		const after = forgetRead(changes, { seq: 4 });
		expect(after.size).toBe(0);
		expect(withLocal([box("a", "stopped"), box("b")], after)).toEqual([box("a", "stopped"), box("b")]);
	});

	it("keeps what it learnt after a list started, whatever that list answers", () => {
		// The feed said `a` stopped while the list was being read: the list may still say it runs.
		const changes = local(["a", box("a", "stopped"), 5], ["b", null, 5]);
		expect(forgetRead(changes, { seq: 4 })).toBe(changes);
		expect(withLocal([box("a", "running"), box("b")], changes)).toEqual([box("a", "stopped")]);
	});

	it("keeps a new sandbox's placeholder until its create answers", () => {
		const changes = local(["pending_x", box("pending_x"), 1]);
		expect(forgetRead(changes, { seq: 9 })).toBe(changes);
	});

	it("takes a read of one sandbox only when nothing newer is known of it", () => {
		const none: ReadonlyMap<string, LocalChange<Box>> = new Map();
		// Newer than the list: taken.
		const read = withRead(none, "a", box("a", "stopped"), 5, 4);
		expect(read.get("a")).toEqual({ box: box("a", "stopped"), seq: 5 });
		// Started before the list shown: the list knows better.
		expect(withRead(none, "a", box("a", "running"), 3, 4)).toBe(none);
		// Answers in the other order: the later read wins, the earlier is dropped.
		expect(withRead(read, "a", box("a", "running"), 4.5, 4)).toBe(read);
		const later = withRead(read, "a", box("a", "running"), 6, 4);
		expect(later.get("a")?.seq).toBe(6);
		// A change this page made after the read started wins over it.
		const deleted = local(["a", null, 7]);
		expect(withRead(deleted, "a", box("a"), 6, 4)).toBe(deleted);
	});

	it("drops a row a read of it says was deleted", () => {
		const none: ReadonlyMap<string, LocalChange<Box>> = new Map();
		const read = withRead(none, "a", null, 5, 4);
		expect(withLocal([box("a"), box("b")], read)).toEqual([box("b")]);
	});
});
