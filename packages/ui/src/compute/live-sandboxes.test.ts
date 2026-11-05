import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxesSource } from "./compute-model.ts";
import { followSandboxes, WATCH_SETTLE_MS } from "./live-sandboxes.ts";

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
});
