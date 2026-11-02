import type { ToolItem, TranscriptItem } from "@kantel/protocol";
import { describe, expect, it } from "vitest";
import { type Outgoing, outgoingId } from "../state/outbox.ts";
import {
	browserRequestOf,
	composerState,
	createRequestIds,
	createWarmHint,
	delivering,
	deliveryOf,
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

	const grant = (status: "pending" | "granted" | "denied", callId?: string): TranscriptItem => ({
		kind: "card",
		id: `b:${callId ?? "x"}`,
		at: 0,
		card: {
			type: "browser.grant",
			requestId: callId ?? "x",
			reason: "Read the docs",
			status,
			...(callId === undefined ? {} : { callId, sites: ["example.com"] }),
		},
	});

	it("waits on a script's request from its pending card, naming the inner call", () => {
		const script = tool("codemode", "running", "c1");
		expect(browserRequestOf([script, grant("pending", "c1/c2")])).toEqual({
			callId: "c1/c2",
			reason: "Read the docs",
			sites: ["example.com"],
		});
		// Settled, or a card that names no call, there is nothing to answer.
		expect(browserRequestOf([script, grant("granted", "c1/c2")])).toBeUndefined();
		expect(browserRequestOf([script, grant("denied", "c1/c2")])).toBeUndefined();
		expect(browserRequestOf([script, grant("pending")])).toBeUndefined();
		// A newer script request after a model's finished one still waits.
		expect(browserRequestOf([tool("browser_request", "done", "c0"), script, grant("pending", "c1/c2")])).toMatchObject({
			callId: "c1/c2",
		});
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
		// A run held on a person (an approval, a browser request) is still running.
		expect(composerState(live, "waiting", false)).toBe("running");
		for (const status of ["idle", "done", "failed", "cancelled"] as const)
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
		expect(offersFollowUp(live, "waiting", false, "And then this")).toBe(true);
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

describe("createWarmHint", () => {
	it("sends one hint per interval, none while one is on its way, and drops a failed one", async () => {
		let now = 0;
		const calls: (() => void)[] = [];
		const fail: ((reason: unknown) => void)[] = [];
		const hint = createWarmHint(
			() =>
				new Promise<void>((resolve, reject) => {
					calls.push(resolve);
					fail.push(reject);
				}),
			{ intervalMs: 1_000, now: () => now },
		);
		hint();
		hint();
		expect(calls).toHaveLength(1);
		// Past the interval but the first is still on its way: nothing.
		now = 1_500;
		hint();
		expect(calls).toHaveLength(1);
		fail[0]?.(new Error("offline"));
		await Promise.resolve();
		await Promise.resolve();
		hint();
		expect(calls).toHaveLength(2);
		calls[1]?.();
		await Promise.resolve();
		await Promise.resolve();
		now = 2_000;
		hint();
		expect(calls).toHaveLength(2);
		now = 2_500;
		hint();
		expect(calls).toHaveLength(3);
	});
});

describe("what the transcript says of messages on their way", () => {
	const message = (requestId: string, status: Outgoing["status"], extra: Partial<Outgoing> = {}): Outgoing => ({
		requestId,
		via: "prompt",
		text: "Run the tests",
		at: 0,
		status,
		...extra,
	});

	it("says nothing with nothing outgoing", () => {
		expect(
			deliveryOf(
				[],
				() => {},
				() => {},
			),
		).toBeUndefined();
	});

	it("shows a message on its way as sent, and a failed one with Try again and Edit", () => {
		const retried: string[] = [];
		const edited: string[] = [];
		const delivery = deliveryOf(
			[message("r1", "sending"), message("r2", "sent"), message("r3", "failed", { reason: "Offline" })],
			(id) => retried.push(id),
			(id) => edited.push(id),
		);
		expect(delivery?.get(outgoingId("r1"))).toEqual({ state: "sending" });
		expect(delivery?.get(outgoingId("r2"))).toEqual({ state: "sending" });
		const failed = delivery?.get(outgoingId("r3"));
		expect(failed).toMatchObject({ state: "failed", reason: "Offline" });
		if (failed?.state !== "failed") throw new Error("expected a failed message");
		failed.onRetry();
		failed.onEdit?.();
		expect(retried).toEqual(["r3"]);
		expect(edited).toEqual(["r3"]);
	});

	it("offers only Try again for a failed message with files, which the composer can't take back", () => {
		const attachment = { id: "f1", name: "a.png", type: "image/png", size: 10, kind: "image" } as const;
		const failed = deliveryOf(
			[message("r1", "failed", { attachments: [attachment] })],
			() => {},
			() => {},
		)?.get(outgoingId("r1"));
		expect(failed).toMatchObject({ state: "failed" });
		expect(failed && "onEdit" in failed).toBe(false);
	});

	it("holds Edit from here while a message is still going, not once it has gone or failed", () => {
		expect(delivering(undefined)).toBe(false);
		expect(delivering([message("r1", "queued")])).toBe(true);
		expect(delivering([message("r1", "sending")])).toBe(true);
		expect(delivering([message("r1", "sent"), message("r2", "failed")])).toBe(false);
	});
});
