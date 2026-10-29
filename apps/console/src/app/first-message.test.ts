import { describe, expect, it } from "vitest";
import { handOver, takeOver } from "./first-message.ts";

describe("a new session's first message", () => {
	it("is taken once by the session it was left for, with the picks that go with it", () => {
		handOver("s-1", { text: "Hello", choice: { model: "m", thinking: "low" } });
		expect(takeOver("s-2")).toBeUndefined();
		expect(takeOver("s-1")).toEqual({ text: "Hello", choice: { model: "m", thinking: "low" } });
		expect(takeOver("s-1")).toBeUndefined();
	});
});
