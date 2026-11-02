import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION_IDLE_SECONDS, sessionIdleFrom } from "../src/session-idle.ts";

describe("KANTEL_SESSION_IDLE_SECONDS", () => {
	it("defaults to two minutes", () => {
		expect(DEFAULT_SESSION_IDLE_SECONDS).toBe(120);
		expect(sessionIdleFrom({})).toEqual({ sessionIdleMs: 120_000 });
		expect(sessionIdleFrom({ KANTEL_SESSION_IDLE_SECONDS: " " })).toEqual({ sessionIdleMs: 120_000 });
	});

	it("takes whole seconds, or off for the old behaviour", () => {
		expect(sessionIdleFrom({ KANTEL_SESSION_IDLE_SECONDS: "30" })).toEqual({ sessionIdleMs: 30_000 });
		expect(sessionIdleFrom({ KANTEL_SESSION_IDLE_SECONDS: "off" })).toEqual({});
	});

	it("refuses anything else", () => {
		for (const value of ["0", "-5", "1.5", "two", "86401"]) {
			expect(() => sessionIdleFrom({ KANTEL_SESSION_IDLE_SECONDS: value })).toThrow(/KANTEL_SESSION_IDLE_SECONDS/);
		}
	});
});
