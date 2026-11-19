import { describe, expect, it } from "vitest";
import {
	ChangeCounter,
	forgetRead,
	keepShown,
	type LocalChange,
	retryTargets,
	stillToDo,
	withLocal,
	withRead,
} from "./sandbox-selection.ts";

describe("a slow bulk-stop answer", () => {
	it("applies when nothing changed the sandbox after it was asked", () => {
		const changes = new ChangeCounter();
		const a = changes.ask("a");
		const b = changes.ask("b");
		expect(changes.take("a", a)).toBe(true);
		expect(changes.take("b", b)).toBe(true);
	});

	it("doesn't bring back a sandbox deleted while it was waiting", () => {
		const changes = new ChangeCounter();
		const asked = changes.ask("a");
		// A's stop answered, then A was deleted from its row's menu; B's slow stop is the only one still to come.
		expect(changes.take("a", asked)).toBe(true);
		expect(changes.take("a")).toBe(true);
		// Had A's stop been the slow one, its answer now is stale.
		expect(changes.take("a", asked)).toBe(false);
	});

	it("loses to a row action that answered first", () => {
		const changes = new ChangeCounter();
		const asked = changes.ask("a");
		expect(changes.take("a")).toBe(true);
		expect(changes.take("a", asked)).toBe(false);
		// The row's own changes always apply.
		expect(changes.take("a")).toBe(true);
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
