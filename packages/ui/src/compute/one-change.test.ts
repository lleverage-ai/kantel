import { describe, expect, it } from "vitest";
import { autoStopChanges } from "./one-change.ts";

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

	it("frees a sandbox once a change fails, for another try", async () => {
		await expect(
			autoStopChanges.run("sbx_c", async () => {
				throw new Error("offline");
			}),
		).rejects.toThrow("offline");
		expect(await autoStopChanges.run("sbx_c", async () => 15)).toBe(15);
	});
});
