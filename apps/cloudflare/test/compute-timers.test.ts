// The stack object's compute timers: a request runs the webhook dispatcher and the telemetry export until it has been
// idle a while; a host's usage tick keeps only the export going, as the metrics are fed from the ticks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_MS, whileBusy } from "../src/compute.ts";

function fakeApi() {
	const state = { dispatching: false, exporting: false, flushes: 0 };
	const api = {
		dispatcher: {
			start: () => {
				state.dispatching = true;
			},
			stop: () => {
				state.dispatching = false;
			},
		},
		exporter: {
			start: () => {
				state.exporting = true;
			},
			stop: () => {
				state.exporting = false;
			},
			flush: async () => {
				state.flushes += 1;
			},
		},
	} as unknown as Parameters<typeof whileBusy>[0];
	return { api, state };
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("whileBusy", () => {
	it("stops both after a request once idle, and flushes what's queued", () => {
		const { api, state } = fakeApi();
		const timers = whileBusy(api, () => Date.now());
		timers.touch();
		expect(state).toMatchObject({ dispatching: true, exporting: true });
		vi.advanceTimersByTime(IDLE_MS + IDLE_MS / 5);
		expect(state).toMatchObject({ dispatching: false, exporting: false, flushes: 1 });
	});

	it("keeps the export going while ticks come, with the dispatcher stopped", () => {
		const { api, state } = fakeApi();
		const timers = whileBusy(api, () => Date.now());
		timers.touch();
		for (let elapsed = 0; elapsed < 3 * IDLE_MS; elapsed += 5000) {
			timers.touchUsage();
			vi.advanceTimersByTime(5000);
		}
		expect(state).toMatchObject({ dispatching: false, exporting: true, flushes: 0 });
		// A request starts the dispatcher again.
		timers.touch();
		expect(state.dispatching).toBe(true);
		// Ticks stop: both stop.
		vi.advanceTimersByTime(IDLE_MS + IDLE_MS / 5);
		expect(state).toMatchObject({ dispatching: false, exporting: false, flushes: 1 });
	});

	it("starts the export from a tick alone", () => {
		const { api, state } = fakeApi();
		whileBusy(api, () => Date.now()).touchUsage();
		expect(state).toMatchObject({ dispatching: false, exporting: true });
	});
});
