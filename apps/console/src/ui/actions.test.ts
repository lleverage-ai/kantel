import { describe, expect, it } from "vitest";
import { composerState } from "./actions.ts";

describe("the composer's state", () => {
	const live = { live: true } as const;

	it("is disabled for a session that can't be controlled, whatever it is doing", () => {
		const recorded = { live: false, reason: "Recorded" } as const;
		expect(composerState(recorded, "running", false)).toBe("disabled");
		expect(composerState(recorded, "idle", true)).toBe("disabled");
	});

	it("steers or stops while the agent runs, and sends otherwise", () => {
		expect(composerState(live, "running", false)).toBe("running");
		for (const status of ["idle", "waiting", "done", "failed", "cancelled"] as const)
			expect(composerState(live, status, false)).toBe("idle");
	});

	it("shows a send on its way", () => {
		expect(composerState(live, "running", true)).toBe("sending");
	});
});
