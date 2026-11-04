import { describe, expect, it } from "vitest";
import { ChangeCounter, keepShown, retryTargets, stillToDo } from "./sandbox-selection.ts";

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
