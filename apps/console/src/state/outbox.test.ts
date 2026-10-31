import type { TranscriptItem, UserItem } from "@kantel/protocol";
import { describe, expect, it } from "vitest";
import { echoed, Outbox, type Outgoing, outgoingId, withOutbox } from "./outbox.ts";

/** A send the test settles by hand: each call to deliver waits until the test resolves or rejects it. */
function host() {
	const calls: { message: Outgoing<string>; resolve: () => void; reject: (reason: unknown) => void }[] = [];
	const deliver = (message: Outgoing<string>) =>
		new Promise<void>((resolve, reject) => {
			calls.push({ message, resolve, reject });
		});
	let next = 0;
	const outbox = new Outbox<string>(
		deliver,
		() => `r${++next}`,
		() => 1000,
	);
	return { outbox, calls };
}

/** Lets the outbox see a settled send (its handlers run on the microtask queue). */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const answer = (id: string): TranscriptItem => ({ kind: "assistant", id, at: 0, text: "Done.", streaming: false });
/** The session's own copy of a message, as the host projects it: its own id, the send's requestId. */
const echo = (requestId: string, text: string, id = `u-${requestId}`): UserItem => ({
	kind: "user",
	id,
	at: 2000,
	text,
	via: "prompt",
	requestId,
});

const statuses = (outbox: Outbox<string>) => outbox.getState().map((message) => [message.text, message.status]);

describe("an optimistic send", () => {
	it("shows the message in the transcript at once, before the host has answered", () => {
		const { outbox, calls } = host();
		const items: TranscriptItem[] = [answer("a1")];
		outbox.send("prompt", "Run the tests", { options: "opus" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.message).toMatchObject({ requestId: "r1", text: "Run the tests", options: "opus" });
		const shown = withOutbox(items, outbox.getState());
		expect(shown).toHaveLength(2);
		expect(shown[1]).toEqual({
			kind: "user",
			id: outgoingId("r1"),
			at: 1000,
			text: "Run the tests",
			via: "prompt",
			requestId: "r1",
		});
	});

	it("gives way to the session's copy when the stream brings it, with no duplicate and nothing moved", async () => {
		const { outbox, calls } = host();
		outbox.send("prompt", "Run the tests");
		calls[0]?.resolve();
		await tick();
		expect(statuses(outbox)).toEqual([["Run the tests", "sent"]]);
		// Sent, but the stream hasn't brought it: still shown, still last.
		const before = withOutbox([answer("a1")], outbox.getState());
		expect(before.map((item) => item.id)).toEqual(["a1", outgoingId("r1")]);
		// The stream brings it: one message, in the same place, and the outbox lets go.
		const items = [answer("a1"), echo("r1", "Run the tests")];
		expect(withOutbox(items, outbox.getState())).toBe(items);
		outbox.settle(items);
		expect(outbox.getState()).toEqual([]);
	});

	it("shows the session's copy alone when it arrives before the host has answered the send", async () => {
		const { outbox, calls } = host();
		outbox.send("prompt", "Run the tests");
		const items = [answer("a1"), echo("r1", "Run the tests")];
		// Before the outbox settles, the transcript already shows one copy.
		expect(withOutbox(items, outbox.getState()).filter((item) => item.kind === "user")).toHaveLength(1);
		outbox.settle(items);
		expect(outbox.getState()).toEqual([]);
		// The send's answer comes late; nothing comes back.
		calls[0]?.resolve();
		await tick();
		expect(outbox.getState()).toEqual([]);
	});

	it("keeps a message whose send failed, marked failed with the host's reason", async () => {
		const { outbox, calls } = host();
		outbox.send("prompt", "Run the tests");
		calls[0]?.reject(new Error("The session is closed"));
		await tick();
		expect(outbox.getState()).toMatchObject([
			{ text: "Run the tests", status: "failed", reason: "The session is closed" },
		]);
		expect(withOutbox([answer("a1")], outbox.getState()).map((item) => item.id)).toEqual(["a1", outgoingId("r1")]);
	});

	it("tries a failed message again with the same requestId, so the host takes it once", async () => {
		const { outbox, calls } = host();
		outbox.send("prompt", "Run the tests", { options: "opus" });
		calls[0]?.reject(new Error("Network error"));
		await tick();
		outbox.retry("r1");
		expect(calls).toHaveLength(2);
		expect(calls[1]?.message).toMatchObject({ requestId: "r1", text: "Run the tests", options: "opus" });
		expect(statuses(outbox)).toEqual([["Run the tests", "sending"]]);
		expect(outbox.getState()[0]?.reason).toBeUndefined();
		calls[1]?.resolve();
		await tick();
		outbox.settle([echo("r1", "Run the tests")]);
		expect(outbox.getState()).toEqual([]);
	});

	it("lets go of a failed message whose copy arrives anyway: the host had it after all", async () => {
		const { outbox, calls } = host();
		outbox.send("prompt", "Run the tests");
		calls[0]?.reject(new Error("Timed out"));
		await tick();
		outbox.settle([echo("r1", "Run the tests")]);
		expect(outbox.getState()).toEqual([]);
	});

	it("takes a failed message out, for its words to go back to the composer", async () => {
		const { outbox, calls } = host();
		outbox.send("prompt", "Run the tests");
		expect(outbox.take("r1")).toBeUndefined(); // only a failed one
		calls[0]?.reject(new Error("Network error"));
		await tick();
		expect(outbox.take("r1")).toMatchObject({ text: "Run the tests" });
		expect(outbox.getState()).toEqual([]);
	});

	it("sends two quick messages one after the other, in order, each shown at once", async () => {
		const { outbox, calls } = host();
		outbox.send("prompt", "First");
		outbox.send("prompt", "Second");
		// Both show straight away, in the order they were sent; only the first has gone.
		expect(withOutbox([], outbox.getState()).map((item) => (item.kind === "user" ? item.text : ""))).toEqual([
			"First",
			"Second",
		]);
		expect(calls.map((call) => call.message.text)).toEqual(["First"]);
		calls[0]?.resolve();
		await tick();
		expect(calls.map((call) => call.message.text)).toEqual(["First", "Second"]);
		// The first arrives while the second is on its way: still in order, no duplicate.
		const items = [echo("r1", "First")];
		expect(withOutbox(items, outbox.getState()).map((item) => item.id)).toEqual(["u-r1", outgoingId("r2")]);
		outbox.settle(items);
		calls[1]?.resolve();
		await tick();
		const both = [echo("r1", "First"), answer("a1"), echo("r2", "Second")];
		expect(withOutbox(both, outbox.getState())).toBe(both);
		outbox.settle(both);
		expect(outbox.getState()).toEqual([]);
	});

	it("fails the messages queued behind a failed one, rather than let them overtake it", async () => {
		const { outbox, calls } = host();
		outbox.send("prompt", "First");
		outbox.send("steer", "Second");
		calls[0]?.reject(new Error("Network error"));
		await tick();
		expect(calls).toHaveLength(1);
		expect(statuses(outbox)).toEqual([
			["First", "failed"],
			["Second", "failed"],
		]);
		// Trying the first again sends it; the second waits to be tried itself.
		outbox.retry("r1");
		expect(calls.map((call) => call.message.text)).toEqual(["First", "First"]);
		expect(statuses(outbox)).toEqual([
			["Second", "failed"],
			["First", "sending"],
		]);
	});

	it("moves a retried message after anything sent since, where the host will put it", async () => {
		const { outbox, calls } = host();
		outbox.send("prompt", "First");
		calls[0]?.reject(new Error("Network error"));
		await tick();
		outbox.send("prompt", "Second");
		calls[1]?.resolve();
		await tick();
		outbox.retry("r1");
		expect(outbox.getState().map((message) => message.text)).toEqual(["Second", "First"]);
	});

	it("tells its listeners of each change, and only of changes", async () => {
		const { outbox, calls } = host();
		let told = 0;
		outbox.subscribe(() => {
			told += 1;
		});
		outbox.settle([answer("a1")]);
		expect(told).toBe(0);
		outbox.send("prompt", "Run the tests");
		const afterSend = told;
		expect(afterSend).toBeGreaterThan(0);
		outbox.settle([answer("a1")]);
		expect(told).toBe(afterSend);
		calls[0]?.resolve();
		await tick();
		expect(told).toBeGreaterThan(afterSend);
	});
});

describe("finding the session's copies", () => {
	it("looks from the end and finds only the requestIds it is asked for", () => {
		const items: TranscriptItem[] = [echo("r1", "One"), answer("a1"), echo("r2", "Two"), echo("r3", "Three")];
		expect(echoed(items, new Set(["r1", "r3", "r9"]))).toEqual(new Set(["r1", "r3"]));
		expect(echoed(items, new Set())).toEqual(new Set());
	});

	it("passes the session's items through untouched with nothing outgoing", () => {
		const items: TranscriptItem[] = [answer("a1")];
		expect(withOutbox(items, [])).toBe(items);
	});
});
