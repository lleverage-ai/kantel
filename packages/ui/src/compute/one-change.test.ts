import { describe, expect, it } from "vitest";
import type { Sandbox, SandboxesSource } from "./compute-model.ts";
import { autoStopChanges } from "./one-change.ts";
import { setAutoStop } from "./sandbox-actions.tsx";
import { ChangeCounter, changeTaken } from "./sandbox-selection.ts";

/** The list's change path: its counter, the rows it shows (null for a deleted one), and how often it reads again. */
function list() {
	const changes = new ChangeCounter();
	const rows = new Map<string, Sandbox | null>();
	const read = { count: 0 };
	return {
		rows,
		read,
		asked: (id: string) => changes.ask(id),
		onChange: (box: Sandbox | null, id: string, asked?: number) => {
			const taken = changeTaken(changes, id, asked);
			if (taken.show) rows.set(id, box);
			if (taken.reload) read.count += 1;
		},
	};
}

const running = (id: string, state = "running") => ({ id, state }) as unknown as Sandbox;

/** A source whose auto-stop answers only when the test says. */
function slowAutoStop() {
	let answer: () => void = () => {};
	const source = {
		setAutoStop: (id: string, minutes: number | undefined) =>
			new Promise<Sandbox>((resolve) => {
				answer = () => resolve({ id, name: id, autoStopMinutes: minutes } as unknown as Sandbox);
			}),
	} as unknown as SandboxesSource;
	return { source, answer: () => answer() };
}

describe("a sandbox's auto-stop", () => {
	it("takes one change at a time, from its page or its row, so a slow earlier one can't undo a later one", async () => {
		let answer: (minutes: number) => void = () => {};
		const heard: boolean[] = [];
		const stop = autoStopChanges.subscribe(() => heard.push(autoStopChanges.changing().has("sbx_a")));
		// "15 minutes" from the page, still on its way when the page's dialog has gone.
		const first = autoStopChanges.run("sbx_a", () => new Promise<number>((resolve) => (answer = resolve)));
		// "Never" from the list's row meanwhile: refused, not sent after it.
		await expect(autoStopChanges.run("sbx_a", async () => 0)).rejects.toThrow(/still changing/);
		// Another sandbox's goes on.
		expect(await autoStopChanges.run("sbx_b", async () => 60)).toBe(60);
		answer(15);
		expect(await first).toBe(15);
		// Views heard it start and end.
		expect([heard[0], heard.at(-1)]).toEqual([true, false]);
		expect(autoStopChanges.changing().has("sbx_a")).toBe(false);
		stop();
	});

	it("shows an auto-stop's answer in the list unless a Delete or Stop answered after it was asked", async () => {
		const shown = list();
		const uncontested = slowAutoStop();
		const first = setAutoStop({ source: uncontested.source, ...shown }, "sbx_d", 15);
		uncontested.answer();
		await first;
		expect(shown.rows.get("sbx_d")).toMatchObject({ id: "sbx_d" });

		// Saved, the dialog closed, then deleted from its row: the late answer can't bring the row back.
		const late = slowAutoStop();
		const second = setAutoStop({ source: late.source, ...shown }, "sbx_d", undefined);
		shown.onChange(null, "sbx_d");
		const reads = shown.read.count;
		late.answer();
		await second;
		expect(shown.rows.get("sbx_d")).toBeNull();
		// Read again all the same: the list, not this answer, says what's there.
		expect(shown.read.count).toBe(reads + 1);

		// The sandbox page's menu has no counter: its answer applies, as before.
		const page = slowAutoStop();
		const applied: string[] = [];
		const third = setAutoStop({ source: page.source, onChange: (_box, id) => applied.push(id) }, "sbx_e", 60);
		page.answer();
		await third;
		expect(applied).toEqual(["sbx_e"]);
	});

	it("reads the list again when an auto-stop and a row's Stop overlap, whichever answers first", async () => {
		for (const first of ["auto-stop", "stop"] as const) {
			const shown = list();
			const id = `sbx_${first}`;
			const slow = slowAutoStop();
			const saving = setAutoStop({ source: slow.source, ...shown }, id, 15);
			// The row's Stop, asked meanwhile, as the row asks it.
			const stopAsked = shown.asked(id);
			const stopped = () => shown.onChange(running(id, "stopping"), id, stopAsked);
			if (first === "auto-stop") {
				slow.answer();
				await saving;
				stopped();
			} else {
				stopped();
				slow.answer();
				await saving;
			}
			// The one answering second is overtaken and not shown, but each was followed by a fresh read of the list,
			// so a Stop that answered second still ends with the list as it is now (stopping), not Running.
			expect(shown.read.count, first).toBe(2);
		}
	});

	it("frees a sandbox once a change fails, for another try", async () => {
		await expect(
			autoStopChanges.run("sbx_c", async () => {
				throw new Error("offline");
			}),
		).rejects.toThrow("offline");
		expect(await autoStopChanges.run("sbx_c", async () => 15)).toBe(15);
	});
});
