import { describe, expect, it } from "vitest";
import { QUICK_SANDBOX, showsCpu } from "./sandboxes-page.tsx";

describe("the sandboxes list", () => {
	const samples = [0.1, 0.4, 0.2];

	it("draws CPU only while a sandbox runs or has just failed, never a flat line for a stopped one", () => {
		expect(showsCpu({ state: "running", usage: samples })).toBe(true);
		expect(showsCpu({ state: "stopping", usage: samples })).toBe(true);
		expect(showsCpu({ state: "error", usage: samples })).toBe(true);
		for (const state of ["stopped", "paused", "starting"] as const)
			expect(showsCpu({ state, usage: samples })).toBe(false);
		// Nothing to draw yet.
		expect(showsCpu({ state: "running", usage: [] })).toBe(false);
		expect(showsCpu({ state: "running", usage: [0.3] })).toBe(false);
	});

	it("makes New's sandbox with New sandbox's defaults: a medium microVM that stops after an hour", () => {
		expect(QUICK_SANDBOX).toEqual({ kind: "microvm", size: "medium", autoStopMinutes: 60 });
	});
});
