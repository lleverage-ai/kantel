import type { ToolItem, TranscriptItem } from "@harbour/protocol";
import { describe, expect, it } from "vitest";
import {
	browserRequestOf,
	composerState,
	createRequestIds,
	offersFollowUp,
	TITLE_MAX,
	titleFrom,
	transcriptWorking,
} from "./actions.ts";

describe("an agent's request for a browser", () => {
	const tool = (name: string, status: ToolItem["status"], callId: string, args?: unknown): ToolItem => ({
		kind: "tool",
		id: `item-${callId}`,
		at: 0,
		callId,
		name,
		label: name,
		status,
		...(args === undefined ? {} : { args }),
	});

	it("waits while its call runs, with why and the sites", () => {
		const items: TranscriptItem[] = [
			tool("browser_request", "running", "c1", { reason: "Read the docs", sites: ["example.com", 3] }),
		];
		expect(browserRequestOf(items)).toEqual({ callId: "c1", reason: "Read the docs", sites: ["example.com"] });
	});

	it("is answered once its call has finished, and only the last one counts", () => {
		expect(browserRequestOf([tool("browser_request", "done", "c1")])).toBeUndefined();
		expect(
			browserRequestOf([tool("browser_request", "running", "c1"), tool("browser_request", "error", "c2")]),
		).toBeUndefined();
		expect(browserRequestOf([tool("browser_open", "running", "c3")])).toBeUndefined();
		expect(browserRequestOf([])).toBeUndefined();
	});
});

describe("the transcript's working row", () => {
	it("shows from the moment a prompt is sent, timed from then, before the host says it runs", () => {
		expect(transcriptWorking("done", 1_000)).toEqual({ since: 1_000 });
	});

	it("follows the host's status otherwise", () => {
		expect(transcriptWorking("running", undefined)).toBe(true);
		expect(transcriptWorking("waiting", undefined)).toBe(false);
		expect(transcriptWorking("done", undefined)).toBe(false);
	});
});

describe("a new session's title", () => {
	it("is the first line with words, its spaces folded", () => {
		expect(titleFrom("\n  \n  Fix the   login bug \nThen the tests")).toBe("Fix the login bug");
	});

	it("is cut at a word with an ellipsis when it is long", () => {
		const title = titleFrom(`${"word ".repeat(40)}end`);
		expect(title?.length).toBeLessThanOrEqual(TITLE_MAX);
		expect(title).toMatch(/^word( word)*…$/);
	});

	it("is left out for a message with no words", () => {
		expect(titleFrom(" \n\t")).toBeUndefined();
	});
});

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
