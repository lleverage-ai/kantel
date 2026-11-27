import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxesSource } from "./compute-model.ts";
import { followSandboxes, type SandboxBurst, type Visibility, WATCH_SETTLE_MS } from "./live-sandboxes.ts";

type Changed = (sandboxId?: string, deleted?: boolean) => void;

/** A source whose feed the test drives. */
function source() {
	const watchers = new Map<Changed, string>();
	const watched: Pick<SandboxesSource, "watch"> = {
		watch(accountId, changed) {
			watchers.set(changed, accountId);
			return () => watchers.delete(changed);
		},
	};
	const send = (sandboxId?: string, deleted?: boolean) => {
		for (const changed of [...watchers.keys()]) changed(sandboxId, deleted);
	};
	return { watched, watchers, send };
}

/** A tab the test hides and shows. */
function tab() {
	let hidden = false;
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

const ids = (...each: string[]): ReadonlySet<string> => new Set(each);

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("followSandboxes", () => {
	it("reads again once per burst of the account's changes", () => {
		const { watched, watchers, send } = source();
		const reload = vi.fn();
		const stop = followSandboxes(watched, "acc_1", reload);
		expect([...watchers.values()]).toEqual(["acc_1"]);

		send("sbx_1");
		send("sbx_2");
		send("sbx_1");
		expect(reload).not.toHaveBeenCalled();
		vi.advanceTimersByTime(WATCH_SETTLE_MS);
		expect(reload).toHaveBeenCalledTimes(1);

		send("sbx_3");
		vi.advanceTimersByTime(WATCH_SETTLE_MS);
		expect(reload).toHaveBeenCalledTimes(2);

		stop();
		expect(watchers.size).toBe(0);
	});

	it("reads again on a (re)connection, which says no sandbox", () => {
		const { watched, send } = source();
		const reload = vi.fn();
		followSandboxes(watched, "acc_1", reload, { sandboxId: "sbx_1" });
		send();
		vi.advanceTimersByTime(WATCH_SETTLE_MS);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("on a sandbox's page, minds only that sandbox, and says at once when it was deleted", () => {
		const { watched, send } = source();
		const reload = vi.fn();
		const onDeleted = vi.fn();
		followSandboxes(watched, "acc_1", reload, { sandboxId: "sbx_1", onDeleted });
		send("sbx_2");
		send("sbx_2", true);
		vi.advanceTimersByTime(WATCH_SETTLE_MS);
		expect(reload).not.toHaveBeenCalled();
		expect(onDeleted).not.toHaveBeenCalled();

		send("sbx_1");
		vi.advanceTimersByTime(WATCH_SETTLE_MS);
		expect(reload).toHaveBeenCalledTimes(1);
		send("sbx_1", true);
		expect(onDeleted).toHaveBeenCalledTimes(1);
	});

	it("on the list, a deletion is a change like any other", () => {
		const { watched, send } = source();
		const reload = vi.fn();
		followSandboxes(watched, "acc_1", reload);
		send("sbx_1", true);
		vi.advanceTimersByTime(WATCH_SETTLE_MS);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("reads nothing once stopped, even for a burst that had begun", () => {
		const { watched, send } = source();
		const reload = vi.fn();
		const stop = followSandboxes(watched, "acc_1", reload);
		send("sbx_1");
		stop();
		vi.advanceTimersByTime(WATCH_SETTLE_MS * 2);
		send("sbx_1");
		vi.advanceTimersByTime(WATCH_SETTLE_MS * 2);
		expect(reload).not.toHaveBeenCalled();
	});

	it("does nothing with a source that can't watch", () => {
		const reload = vi.fn();
		const stop = followSandboxes({}, "acc_1", reload);
		vi.advanceTimersByTime(WATCH_SETTLE_MS);
		stop();
		expect(reload).not.toHaveBeenCalled();
	});

	it("says which sandboxes a burst changed and which it deleted, each once", () => {
		const { watched, send } = source();
		const bursts: SandboxBurst[] = [];
		followSandboxes(watched, "acc_1", (burst) => bursts.push(burst));
		send("sbx_1");
		send("sbx_2");
		send("sbx_1");
		send("sbx_2", true);
		send("sbx_3", true);
		vi.advanceTimersByTime(WATCH_SETTLE_MS);
		expect(bursts).toEqual([{ all: false, changed: ids("sbx_1"), deleted: ids("sbx_2", "sbx_3") }]);
	});

	it("says everything on a (re)connection, keeping the deletions it saw", () => {
		const { watched, send } = source();
		const bursts: SandboxBurst[] = [];
		followSandboxes(watched, "acc_1", (burst) => bursts.push(burst));
		send("sbx_1");
		send("sbx_2", true);
		send();
		vi.advanceTimersByTime(WATCH_SETTLE_MS);
		expect(bursts).toEqual([{ all: true, deleted: ids("sbx_2") }]);
	});

	it("hands nothing over while the tab is hidden, and what it missed once when it's shown", () => {
		const { watched, send } = source();
		const { visibility, hide, show, listeners } = tab();
		const bursts: SandboxBurst[] = [];
		const stop = followSandboxes(watched, "acc_1", (burst) => bursts.push(burst), { visibility });
		hide();
		send("sbx_1");
		vi.advanceTimersByTime(WATCH_SETTLE_MS * 10);
		send("sbx_2");
		vi.advanceTimersByTime(WATCH_SETTLE_MS * 10);
		expect(bursts).toEqual([]);

		show();
		expect(bursts).toEqual([{ all: false, changed: ids("sbx_1", "sbx_2"), deleted: ids() }]);
		hide();
		show();
		expect(bursts).toHaveLength(1);

		stop();
		expect(listeners.size).toBe(0);
	});

	it("says everything on showing a tab that was hidden through a reconnection", () => {
		const { watched, send } = source();
		const { visibility, hide, show } = tab();
		const bursts: SandboxBurst[] = [];
		followSandboxes(watched, "acc_1", (burst) => bursts.push(burst), { visibility });
		hide();
		send();
		vi.advanceTimersByTime(WATCH_SETTLE_MS);
		show();
		expect(bursts).toEqual([{ all: true, deleted: ids() }]);
	});
});
