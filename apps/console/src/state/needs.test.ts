import type { Card, TranscriptItem } from "@harbour/protocol";
import { describe, expect, it } from "vitest";
import { needsOf } from "./needs.ts";

const card = (id: string, value: Card): TranscriptItem => ({ kind: "card", id, at: 0, card: value });
const question = (status: "open" | "answered"): Card => ({ type: "question", questionId: "q", text: "Which?", status });
const grant = (status: "pending" | "granted"): Card => ({
	type: "browser.grant",
	requestId: "r",
	reason: "Log in",
	status,
});

describe("what a waiting session needs", () => {
	it("is the newest open card: an approval or an answer", () => {
		expect(needsOf([card("1", question("open"))])).toBe("answer");
		expect(needsOf([card("1", question("open")), card("2", grant("pending"))])).toBe("approval");
		expect(needsOf([card("1", grant("pending")), card("2", question("open"))])).toBe("answer");
	});

	it("skips settled cards and other items, and is undefined with nothing open", () => {
		const user: TranscriptItem = { kind: "user", id: "u", at: 0, text: "Hi", via: "prompt" };
		expect(needsOf([card("1", question("open")), card("2", grant("granted")), user])).toBe("answer");
		expect(needsOf([card("1", question("answered"))])).toBeUndefined();
		expect(needsOf([])).toBeUndefined();
	});
});
