// When the outage drill (postgres.ts) counts a gateway as recovered, from the writes it sees start and finish.
import { describe, expect, it } from "vitest";
import { Settle } from "./settle.ts";

const settleMs = 10_000;

/** A writer on gateway 0 whose writes each take 10 ms and succeed, from `from` to `to`. */
function steady(settle: Settle, writer: number, from: number, to: number, gateway = 0) {
	for (let at = from; at + 10 <= to; at += 10) {
		settle.started(gateway, writer, at);
		settle.finished(gateway, writer, at, at + 10, true);
	}
}

describe("Settle", () => {
	it("counts sustained successful writes on every gateway as recovered", () => {
		const settle = new Settle(2, 0, settleMs);
		settle.outageFrom(1_000);
		steady(settle, 0, 0, 9_000, 0);
		steady(settle, 1, 0, 9_000, 1);
		expect(settle.all(9_000)).toBe(false);
		steady(settle, 0, 9_000, 12_000, 0);
		steady(settle, 1, 9_000, 12_000, 1);
		expect(settle.all(12_000)).toBe(true);
	});

	it("doesn't count one success followed by a write that hangs", () => {
		const settle = new Settle(1, 0, settleMs);
		settle.started(0, 0, 0);
		settle.finished(0, 0, 0, 10, true);
		settle.started(0, 0, 10);
		settle.started(0, 1, 20);
		// Quiet for longer than the window, but both writers are stuck.
		expect(settle.recovered(0, 15_000)).toBe(false);
		// The stuck writes fail: the window starts again from their failure.
		settle.finished(0, 0, 10, 20_010, false);
		settle.finished(0, 1, 20, 20_020, false);
		expect(settle.lastFailure(0)).toBe(20_020);
		expect(settle.recovered(0, 25_000)).toBe(false);
		steady(settle, 0, 20_020, 31_000);
		expect(settle.recovered(0, 31_000)).toBe(true);
	});

	it("doesn't count a gateway with no write since its last failure", () => {
		const settle = new Settle(1, 0, settleMs);
		steady(settle, 0, 0, 1_000);
		settle.finished(0, 0, 1_000, 1_100, false);
		// No failure for the window, but nothing written since either.
		expect(settle.recovered(0, 20_000)).toBe(false);
	});

	it("needs a recent success, not only an old one", () => {
		const settle = new Settle(1, 0, settleMs);
		settle.started(0, 0, 100);
		settle.finished(0, 0, 100, 110, true);
		settle.started(0, 0, 11_000);
		// Started within the window, so not stuck, but no write has succeeded in the last second.
		expect(settle.recovered(0, 11_500)).toBe(false);
		settle.finished(0, 0, 11_000, 11_400, true);
		expect(settle.recovered(0, 11_500)).toBe(true);
	});

	it("resets a gateway's window on a later failure, and only that gateway's", () => {
		const settle = new Settle(2, 0, settleMs);
		steady(settle, 0, 0, 15_000, 0);
		steady(settle, 1, 0, 15_000, 1);
		settle.started(1, 1, 15_000);
		settle.finished(1, 1, 15_000, 15_050, false);
		steady(settle, 0, 15_000, 20_000, 0);
		steady(settle, 1, 15_050, 20_000, 1);
		expect(settle.recovered(0, 20_000)).toBe(true);
		expect(settle.recovered(1, 20_000)).toBe(false);
		steady(settle, 1, 20_000, 25_100, 1);
		expect(settle.recovered(1, 25_100)).toBe(true);
	});

	it("doesn't count writes from before the outage", () => {
		const settle = new Settle(1, 0, settleMs);
		steady(settle, 0, 0, 20_000);
		settle.outageFrom(20_000);
		expect(settle.recovered(0, 20_500)).toBe(false);
		steady(settle, 0, 20_000, 30_000);
		expect(settle.recovered(0, 30_000)).toBe(true);
	});
});
