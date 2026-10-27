import { describe, expect, it } from "vitest";
import { hasText, primaryAction, shouldSend, submits } from "./composer-model.ts";

describe("primaryAction", () => {
	it("sends from idle once there is text", () => {
		expect(primaryAction("idle", "Run the suite")).toBe("send");
		expect(primaryAction("idle", "")).toBe("send-empty");
		expect(primaryAction("idle", "  \n\t ")).toBe("send-empty");
	});

	it("steers a running agent with text and stops it without", () => {
		expect(primaryAction("running", "Use the staging database instead")).toBe("steer");
		expect(primaryAction("running", "")).toBe("stop");
		expect(primaryAction("running", "   ")).toBe("stop");
	});

	it("is busy while sending, whatever the draft", () => {
		expect(primaryAction("sending", "")).toBe("busy");
		expect(primaryAction("sending", "Run the suite")).toBe("busy");
	});

	it("does nothing while disabled, whatever the draft", () => {
		expect(primaryAction("disabled", "")).toBe("disabled");
		expect(primaryAction("disabled", "Run the suite")).toBe("disabled");
	});

	it("submits only for send and steer", () => {
		expect(submits("send")).toBe(true);
		expect(submits("steer")).toBe(true);
		expect(submits("stop")).toBe(false);
		expect(submits("busy")).toBe(false);
		expect(submits("send-empty")).toBe(false);
		expect(submits("disabled")).toBe(false);
	});

	it("treats whitespace as empty", () => {
		expect(hasText("")).toBe(false);
		expect(hasText(" \n ")).toBe(false);
		expect(hasText(" a ")).toBe(true);
	});
});

describe("shouldSend", () => {
	it("sends on plain Enter with a fine pointer", () => {
		expect(shouldSend({ key: "Enter" }, false)).toBe(true);
	});

	it("leaves Shift+Enter and Alt+Enter as a new line", () => {
		expect(shouldSend({ key: "Enter", shiftKey: true }, false)).toBe(false);
		expect(shouldSend({ key: "Enter", altKey: true }, false)).toBe(false);
		expect(shouldSend({ key: "Enter", shiftKey: true, metaKey: true }, false)).toBe(false);
	});

	it("never sends while an IME is composing", () => {
		expect(shouldSend({ key: "Enter", isComposing: true }, false)).toBe(false);
		expect(shouldSend({ key: "Enter", keyCode: 229 }, false)).toBe(false);
		expect(shouldSend({ key: "Enter", isComposing: true, metaKey: true }, true)).toBe(false);
	});

	it("leaves plain Enter as a new line on a coarse pointer", () => {
		expect(shouldSend({ key: "Enter" }, true)).toBe(false);
	});

	it("sends on Ctrl+Enter or Cmd+Enter with any pointer", () => {
		expect(shouldSend({ key: "Enter", ctrlKey: true }, true)).toBe(true);
		expect(shouldSend({ key: "Enter", metaKey: true }, true)).toBe(true);
		expect(shouldSend({ key: "Enter", metaKey: true }, false)).toBe(true);
	});

	it("ignores other keys, Escape included", () => {
		expect(shouldSend({ key: "a" }, false)).toBe(false);
		expect(shouldSend({ key: "Escape" }, false)).toBe(false);
		expect(shouldSend({ key: "Tab" }, false)).toBe(false);
	});
});
