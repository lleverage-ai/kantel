import { describe, expect, it } from "vitest";
import { composerState, createRequestIds, offersFollowUp } from "./actions.ts";

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

describe("Send after this run", () => {
	const live = { live: true } as const;

	it("shows while the agent runs and there is something to send", () => {
		expect(offersFollowUp(live, "running", false, "And then this")).toBe(true);
		expect(offersFollowUp(live, "running", false, "  ")).toBe(false);
		expect(offersFollowUp(live, "idle", false, "And then this")).toBe(false);
		expect(offersFollowUp(live, "running", true, "And then this")).toBe(false);
		expect(offersFollowUp({ live: false, reason: "Recorded" }, "running", false, "And then this")).toBe(false);
	});
});

describe("request ids", () => {
	it("reuses a failed send's id when it is sent the same way again, and starts afresh after a success", () => {
		let next = 0;
		const ids = createRequestIds(() => `r${++next}`);
		expect(ids.for("prompt", "Hi")).toBe("r1");
		// It failed; the same send again keeps its id, so the host runs it once if it had taken the first.
		expect(ids.for("prompt", "Hi")).toBe("r1");
		// Something else, or the same text another way, is a new send.
		expect(ids.for("steer", "Hi")).toBe("r2");
		expect(ids.for("steer", "Hi there")).toBe("r3");
		ids.sent();
		expect(ids.for("steer", "Hi there")).toBe("r4");
	});
});
