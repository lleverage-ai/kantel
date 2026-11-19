import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Visibility } from "./live-sandboxes.ts";
import { READ_GAP_MS, READ_MAX_IDS, sandboxReads } from "./sandbox-reads.ts";

/** A tab the test hides and shows. */
function tab(startHidden = false) {
	let hidden = startHidden;
	const listeners = new Set<() => void>();
	const visibility: Visibility = {
		hidden: () => hidden,
		listen(changed) {
			listeners.add(changed);
			return () => listeners.delete(changed);
		},
	};
	const set = (to: boolean) => {
		hidden = to;
		for (const changed of [...listeners]) changed();
	};
	return { visibility, hide: () => set(true), show: () => set(false), listeners };
}

/** Calls the test answers by hand, recording each read as `list` or the ID it asked for, and when it started. */
function calls() {
	const made: string[] = [];
	const at: number[] = [];
	let running = 0;
	let mostRunning = 0;
	const started = (read: string) => {
		made.push(read);
		at.push(Date.now());
		running += 1;
		mostRunning = Math.max(mostRunning, running);
	};
	const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
	const answer = () =>
		new Promise<void>((resolve, reject) => {
			pending.push({
				resolve: () => {
					running -= 1;
					resolve();
				},
				reject: (error) => {
					running -= 1;
					reject(error);
				},
			});
		});
	return {
		made,
		at,
		mostRunning: () => mostRunning,
		calls: {
			list: () => {
				started("list");
				return answer();
			},
			get: (id: string) => {
				started(id);
				return answer();
			},
		},
		/** Answers the oldest read still waiting, and lets its settling run. */
		async settle(ok = true) {
			const next = pending.shift();
			if (ok) next?.resolve();
			else next?.reject(new Error("refused"));
			await vi.advanceTimersByTimeAsync(0);
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("sandboxReads", () => {
	it("reads the whole list at once on opening, then each sandbox asked for in its own turn, once however often asked", async () => {
		const { made, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		expect(made).toEqual(["list"]);
		await settle();

		reads.changed(["sbx_1"]);
		reads.changed(["sbx_2", "sbx_1"]);
		expect(made).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		expect(made).toEqual(["list", "sbx_1"]);
		await settle();
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		expect(made).toEqual(["list", "sbx_1", "sbx_2"]);
		await settle();
		await vi.advanceTimersByTimeAsync(READ_GAP_MS * 4);
		expect(made).toHaveLength(3);
		reads.stop();
	});

	it("starts every read of one sandbox a gap after the last read, one at a time", async () => {
		const { made, at, mostRunning, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		await settle();
		const ids = Array.from({ length: READ_MAX_IDS }, (_, index) => `sbx_${index}`);
		reads.changed(ids);
		for (let turn = 0; turn < READ_MAX_IDS * 2; turn += 1) {
			await vi.advanceTimersByTimeAsync(READ_GAP_MS);
			await settle();
		}
		expect(made).toEqual(["list", ...ids]);
		for (let index = 1; index < at.length; index += 1) {
			expect((at[index] ?? 0) - (at[index - 1] ?? 0)).toBeGreaterThanOrEqual(READ_GAP_MS);
		}
		expect(mostRunning()).toBe(1);
		reads.stop();
	});

	it("drops the sandboxes still waiting their turns when the whole list is read", async () => {
		const { made, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		await settle();
		reads.changed(["sbx_1", "sbx_2", "sbx_3"]);
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		expect(made).toEqual(["list", "sbx_1"]);
		reads.all();
		await settle();
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		expect(made).toEqual(["list", "sbx_1", "list"]);
		await settle();
		await vi.advanceTimersByTimeAsync(READ_GAP_MS * 4);
		expect(made).toHaveLength(3);
		reads.stop();
	});

	it("keeps to one read every gap however often it is asked", async () => {
		const { made, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		for (let second = 0; second < 60; second += 1) {
			reads.changed([`sbx_${second}`]);
			if (second % 7 === 0) reads.all();
			await vi.advanceTimersByTimeAsync(1_000);
			await settle();
		}
		// At 0 seconds and at the end of each gap up to 60.
		expect(made.length).toBeGreaterThanOrEqual(60_000 / READ_GAP_MS);
		expect(made.length).toBeLessThanOrEqual(60_000 / READ_GAP_MS + 1);
		reads.stop();
	});

	it("makes one read at a time, the next waiting for the last to answer", async () => {
		const { made, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		reads.changed(["sbx_1"]);
		await vi.advanceTimersByTimeAsync(READ_GAP_MS * 3);
		expect(made).toEqual(["list"]);
		await settle();
		expect(made).toEqual(["list", "sbx_1"]);
		reads.stop();
	});

	it("reads the whole list in place of more IDs than it reads one by one, and when the list is asked for too", async () => {
		const { made, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		await settle();
		reads.changed(Array.from({ length: READ_MAX_IDS + 1 }, (_, at) => `sbx_${at}`));
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		expect(made).toEqual(["list", "list"]);
		await settle();

		reads.changed(["sbx_1"]);
		reads.all();
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		expect(made).toEqual(["list", "list", "list"]);
		reads.stop();
	});

	it("reads nothing while the tab is hidden, and once when it's shown, opening included", async () => {
		const { made, calls: read, settle } = calls();
		const { visibility, hide, show, listeners } = tab(true);
		const reads = sandboxReads(read, { visibility });
		reads.changed(["sbx_1"]);
		await vi.advanceTimersByTimeAsync(READ_GAP_MS * 4);
		expect(made).toEqual([]);
		show();
		expect(made).toEqual(["list"]);
		await settle();

		// Hidden while a read waited out its gap: it waits for the tab instead.
		reads.changed(["sbx_2"]);
		hide();
		await vi.advanceTimersByTimeAsync(READ_GAP_MS * 4);
		expect(made).toEqual(["list"]);
		show();
		expect(made).toEqual(["list", "sbx_2"]);
		await settle();

		// Hidden and shown with nothing asked: no read.
		hide();
		show();
		await vi.advanceTimersByTimeAsync(READ_GAP_MS * 4);
		expect(made).toHaveLength(2);

		reads.stop();
		expect(listeners.size).toBe(0);
	});

	it("reads the whole list after a failed read of IDs", async () => {
		const { made, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		await settle();
		reads.changed(["sbx_1"]);
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		await settle(false);
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		expect(made).toEqual(["list", "sbx_1", "list"]);
		reads.stop();
	});

	it("after a failed read of the list, reads the whole list on the next change rather than its IDs", async () => {
		const { made, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		await settle(false);
		await vi.advanceTimersByTimeAsync(READ_GAP_MS * 4);
		// No retry by itself: the next ask brings it.
		expect(made).toEqual(["list"]);
		reads.changed(["sbx_1"]);
		expect(made).toEqual(["list", "list"]);
		await settle();

		reads.changed(["sbx_2"]);
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		expect(made).toEqual(["list", "list", "sbx_2"]);
		reads.stop();
	});

	it("reads the whole list next after a failed read of it, whether its IDs were asked before or after it failed", async () => {
		const { made, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		// Asked while the list is under way.
		reads.changed(["sbx_1"]);
		await settle(false);
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		expect(made).toEqual(["list", "list"]);
		await settle(false);

		// Asked after it failed.
		await vi.advanceTimersByTimeAsync(READ_GAP_MS * 4);
		expect(made).toEqual(["list", "list"]);
		reads.changed(["sbx_2"]);
		expect(made).toEqual(["list", "list", "list"]);
		await settle();

		// Read again, the list goes back to reading by ID.
		reads.changed(["sbx_3"]);
		await vi.advanceTimersByTimeAsync(READ_GAP_MS);
		expect(made).toEqual(["list", "list", "list", "sbx_3"]);
		reads.stop();
	});

	it("reads the list as soon as none is under way when asked to, as Try again does", async () => {
		const { made, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		await settle(false);
		reads.all(true);
		expect(made).toEqual(["list", "list"]);
		reads.stop();
	});

	it("reads nothing once stopped", async () => {
		const { made, calls: read, settle } = calls();
		const reads = sandboxReads(read);
		await settle();
		reads.changed(["sbx_1"]);
		reads.stop();
		await vi.advanceTimersByTimeAsync(READ_GAP_MS * 2);
		reads.all(true);
		expect(made).toEqual(["list"]);
	});
});
