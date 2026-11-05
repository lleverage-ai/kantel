import type { KantelClient, LiveFrame, StreamHandlers } from "@kantel/api/sdk";
import { describe, expect, it } from "vitest";
import { liveSandboxes } from "./live-sandboxes.ts";

interface Opened {
	readonly account: string | undefined;
	readonly handlers: StreamHandlers<LiveFrame>;
	closed: boolean;
}

/** An API whose streams the test drives, and a clock whose timers it runs. */
function harness() {
	const opened: Opened[] = [];
	const api: Pick<KantelClient, "watchEvents"> = {
		watchEvents(handlers, query) {
			const stream: Opened = { account: query?.account, handlers, closed: false };
			opened.push(stream);
			return {
				cursor: undefined,
				close() {
					stream.closed = true;
				},
			};
		},
	};
	const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
	const live = liveSandboxes(api, {
		retryMs: [100, 200],
		setTimeout: (run, ms) => {
			const timer = { run, ms, cancelled: false };
			timers.push(timer);
			return timer;
		},
		clearTimeout: (timer) => {
			(timer as { cancelled: boolean }).cancelled = true;
		},
	});
	const runTimers = () => {
		for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
	};
	return { opened, timers, live, runTimers };
}

const hello: LiveFrame = { type: "hello", at: 1 };
const sandbox = (sandboxId: string, state: "running" | "stopped" | "deleted"): LiveFrame => ({
	type: "sandbox",
	sandboxId,
	accountId: "acc_1",
	state,
	at: 2,
});

describe("liveSandboxes", () => {
	it("opens one stream per account however many watch it, and closes it with the last", () => {
		const { opened, live } = harness();
		const seen: string[] = [];
		const stopA = live.watch("acc_1", (id) => seen.push(`a:${id ?? "all"}`));
		const stopB = live.watch("acc_1", (id) => seen.push(`b:${id ?? "all"}`));
		const stopC = live.watch("acc_2", (id) => seen.push(`c:${id ?? "all"}`));
		expect(opened.map((stream) => stream.account)).toEqual(["acc_1", "acc_2"]);

		opened[0]?.handlers.onFrames([hello, sandbox("sbx_1", "running")]);
		expect(seen).toEqual(["a:all", "b:all", "a:sbx_1", "b:sbx_1"]);

		stopA();
		stopA();
		expect(opened[0]?.closed).toBe(false);
		stopB();
		expect(opened[0]?.closed).toBe(true);
		expect(opened[1]?.closed).toBe(false);
		stopC();
		expect(opened[1]?.closed).toBe(true);
	});

	it("says which sandbox was deleted", () => {
		const { opened, live } = harness();
		const seen: [string | undefined, boolean | undefined][] = [];
		live.watch("acc_1", (id, deleted) => seen.push([id, deleted]));
		opened[0]?.handlers.onFrames([sandbox("sbx_1", "stopped"), sandbox("sbx_1", "deleted")]);
		expect(seen).toEqual([
			["sbx_1", false],
			["sbx_1", true],
		]);
	});

	it("opens a dropped stream again, after a pause that grows while it keeps failing, and reads again on its hello", () => {
		const { opened, timers, live, runTimers } = harness();
		const seen: (string | undefined)[] = [];
		live.watch("acc_1", (id) => seen.push(id));

		// It fails to open, twice: 100 ms, then 200 ms.
		opened[0]?.handlers.onClose?.({ code: 1006, reason: "down" });
		expect(timers.map((timer) => timer.ms)).toEqual([100]);
		runTimers();
		expect(opened).toHaveLength(2);
		opened[1]?.handlers.onClose?.({ code: 1006, reason: "down" });
		expect(timers.map((timer) => timer.ms)).toEqual([200]);
		runTimers();

		// It opens: its hello tells the watcher to read again, for what it missed.
		opened[2]?.handlers.onFrames([hello]);
		expect(seen).toEqual([undefined]);

		// The server ends a stream that had opened (its lifetime): it opens again almost at once.
		opened[2]?.handlers.onClose?.({ code: 1000, reason: "The server ended the stream" });
		expect(timers[0]?.ms).toBe(250);
		runTimers();
		expect(opened).toHaveLength(4);
		// And the pauses started over.
		opened[3]?.handlers.onClose?.({ code: 1006, reason: "down" });
		expect(timers[0]?.ms).toBe(100);
	});

	it("ignores a stream it has left, and stops reconnecting once nobody watches", () => {
		const { opened, timers, live, runTimers } = harness();
		const seen: (string | undefined)[] = [];
		const stop = live.watch("acc_1", (id) => seen.push(id));
		opened[0]?.handlers.onClose?.({ code: 1006, reason: "down" });
		stop();
		expect(timers[0]?.cancelled).toBe(true);
		runTimers();
		expect(opened).toHaveLength(1);
		opened[0]?.handlers.onFrames([hello, sandbox("sbx_1", "running")]);
		expect(seen).toEqual([]);

		// A new watcher gets a stream of its own, and the old one's frames still go nowhere.
		live.watch("acc_1", (id) => seen.push(id));
		expect(opened).toHaveLength(2);
		opened[0]?.handlers.onFrames([sandbox("sbx_old", "running")]);
		opened[1]?.handlers.onFrames([sandbox("sbx_new", "running")]);
		expect(seen).toEqual(["sbx_new"]);
	});
});
