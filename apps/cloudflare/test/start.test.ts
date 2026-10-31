// How KantelStack starts, with a recorded stand-in for `ctx.abort()` (on the platform it resets the object and does
// not return; here it returns, so the failed start's rejection is visible).
import { describe, expect, it } from "vitest";
import { START_FAILED, startOnce } from "../src/start.ts";

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (error: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("startOnce", () => {
	it("starts once for every caller that arrives while it starts, and keeps the result", async () => {
		const pending = deferred<string>();
		let starts = 0;
		const ready = startOnce({
			configure: () => "config",
			start: () => {
				starts += 1;
				return pending.promise;
			},
			reset: () => {
				throw new Error("not reset");
			},
		});
		const both = Promise.all([ready(), ready()]);
		pending.resolve("stack");
		expect(await both).toEqual(["stack", "stack"]);
		expect(await ready()).toBe("stack");
		expect(starts).toBe(1);
	});

	it("answers a configuration error without resetting, and tries again on the next call", async () => {
		const resets: string[] = [];
		let configured = false;
		let starts = 0;
		const ready = startOnce({
			configure: () => {
				if (!configured) throw new Error("KANTEL_ACCESS_AUD is not set");
				return "config";
			},
			start: async () => {
				starts += 1;
				return "stack";
			},
			reset: (reason) => resets.push(reason),
		});
		await expect(ready()).rejects.toThrow("KANTEL_ACCESS_AUD is not set");
		expect(resets).toEqual([]);
		expect(starts).toBe(0);
		configured = true;
		expect(await ready()).toBe("stack");
	});

	it("resets the object when the start fails, after reporting the error", async () => {
		const events: string[] = [];
		let fail = true;
		const ready = startOnce({
			configure: () => "config",
			start: async () => {
				if (fail) throw new Error("D1 is unavailable");
				return "stack";
			},
			reset: (reason) => events.push(`reset: ${reason}`),
			onStartError: (error) => events.push(`error: ${(error as Error).message}`),
		});
		const first = ready();
		const second = ready();
		await expect(first).rejects.toThrow("D1 is unavailable");
		await expect(second).rejects.toThrow("D1 is unavailable");
		// One reset for the one failed start, however many callers were waiting on it.
		expect(events).toEqual(["error: D1 is unavailable", `reset: ${START_FAILED}`]);
		// Where the reset returns (here only), the next call starts afresh rather than keeping the rejection.
		fail = false;
		expect(await ready()).toBe("stack");
	});
});
