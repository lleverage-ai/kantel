import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../protocol-local/index.ts";
import { DELTA_RETENTION, FixtureHost, parseRecording, type Recording } from "../server-sim/fixture-host.ts";
import { splitBlocks } from "../ui/markdown.tsx";
import { COALESCE_MS, SessionClient } from "./session-client.ts";
import { applyOps, fromItems } from "./transcript.ts";

const fixture = (name: string): Recording =>
	parseRecording(readFileSync(new URL(`../../../../fixtures/sessions/${name}.jsonl`, import.meta.url), "utf8"));

const small = fixture("small");
const long = fixture("long-2000");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Run the host's whole recording with `client` attached, advancing fake time in small steps. */
async function playOut(host: FixtureHost, step = 37): Promise<void> {
	host.play();
	while (!host.finished) await vi.advanceTimersByTimeAsync(step);
	await vi.advanceTimersByTimeAsync(5_000);
}

const shape = (items: readonly TranscriptItem[]) => items.map((item) => JSON.stringify(item));

describe("applyOps", () => {
	const items: TranscriptItem[] = [
		{ kind: "user", id: "u:1", text: "hi", at: 0 },
		{ kind: "assistant", id: "a:1", parts: [{ kind: "text", text: "Hel" }], status: "streaming", at: 0 },
		{ kind: "tool", id: "tool:c1", callId: "c1", name: "bash", args: {}, status: "running", output: "", at: 0 },
	];

	it("replaces only the item an op names and keeps every other item's identity", () => {
		const before = fromItems(items);
		const { transcript, changed } = applyOps(before, [{ op: "text.append", id: "a:1", part: 0, text: "lo" }]);
		expect(transcript.items[0]).toBe(items[0]);
		expect(transcript.items[2]).toBe(items[2]);
		expect(transcript.items[1]).not.toBe(items[1]);
		expect(transcript.items[1]).toMatchObject({ parts: [{ kind: "text", text: "Hello" }] });
		expect([...changed]).toEqual(["a:1"]);
		// The input is untouched.
		expect(items[1]).toMatchObject({ parts: [{ text: "Hel" }] });
	});

	it("returns the same transcript when nothing changed", () => {
		const before = fromItems(items);
		expect(applyOps(before, [{ op: "run", state: "idle" }]).transcript).toBe(before);
	});

	it("applies tool output as a front trim then an append, like Pi's tool updates", () => {
		const before = fromItems(items);
		let { transcript } = applyOps(before, [{ op: "tool.update", id: "tool:c1", output: { append: "one\ntwo\n" } }]);
		({ transcript } = applyOps(transcript, [{ op: "tool.update", id: "tool:c1", output: { trimStart: 4, append: "three\n" } }]));
		expect(transcript.items[2]).toMatchObject({ output: "two\nthree\n" });
	});
});

describe("projection of the small recording", () => {
	it("ends with the turns, tools and final texts Pi committed", async () => {
		const host = new FixtureHost(small);
		host.drain();
		const items = host.snapshot().items;
		expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant", "tool", "assistant"]);
		const tools = items.filter((item) => item.kind === "tool");
		expect(tools.map((tool) => [tool.name, tool.status, tool.args])).toEqual([
			["bash", "done", { command: "ls -la docs" }],
			["read", "done", { path: "docs/release-notes.md" }],
		]);
		const last = items.at(-1);
		expect(last?.kind === "assistant" && last.status).toBe("done");
		expect(last?.kind === "assistant" && last.parts[0]?.kind === "text" && last.parts[0].text).toMatch(/^The notes bury/);
	});
});

describe("streaming", () => {
	it("coalesces token deltas to about one render per 200 ms", async () => {
		const host = new FixtureHost(long, { latencyMs: 5 });
		const client = new SessionClient(host, host.sessionId);
		client.start();
		await vi.advanceTimersByTimeAsync(100);
		const before = client.getState().flushes;
		await playOut(host);
		const renders = client.getState().flushes - before;
		const deltas = host.head;
		// The live run is about 35 s of recorded time and some 650 commits.
		expect(deltas).toBeGreaterThan(600);
		expect(renders).toBeLessThan(deltas / 3);
		expect(renders).toBeLessThan((35_000 / COALESCE_MS) * 1.5);
	});

	it("does not replace any earlier item while the long answer streams", async () => {
		const host = new FixtureHost(long, { latencyMs: 5 });
		const client = new SessionClient(host, host.sessionId);
		client.start();
		await vi.advanceTimersByTimeAsync(100);
		const atStart = client.getState().transcript.items;
		await playOut(host);
		const atEnd = client.getState().transcript.items;
		const kept = atStart.filter((item, index) => atEnd[index] === item).length;
		expect(kept).toBe(atStart.length);
		expect(atEnd.length).toBeGreaterThan(atStart.length);
	});
});

describe("resume after a disconnect", () => {
	it("resumes from the last cursor with only the missed deltas, and ends where an uninterrupted client ends", async () => {
		const host = new FixtureHost(long, { latencyMs: 5 });
		const steady = new SessionClient(host, host.sessionId);
		const flaky = new SessionClient(host, host.sessionId);
		steady.start();
		flaky.start();
		await vi.advanceTimersByTimeAsync(100);
		host.play();
		await vi.advanceTimersByTimeAsync(8_000);
		const appliedBefore = flaky.getState().cursor!;
		flaky.simulateDisconnect(3_000);
		// Dropping flushes what was received but still coalescing, so the cursor is everything the client got.
		const cursorAtDrop = flaky.getState().cursor!;
		expect(cursorAtDrop).toBeGreaterThanOrEqual(appliedBefore);
		expect(cursorAtDrop).toBeGreaterThan(10);
		expect(flaky.getState().connection.status).toBe("offline");
		expect(flaky.getState().freshness.state).toBe("stale");
		await vi.advanceTimersByTimeAsync(3_200);
		const resume = flaky.getState().resumes.at(-1)!;
		expect(resume).toMatchObject({ from: cursorAtDrop, how: "deltas" });
		expect(resume.head).toBeGreaterThan(cursorAtDrop);
		while (!host.finished) await vi.advanceTimersByTimeAsync(50);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(flaky.getState().cursor).toBe(host.head);
		expect(shape(flaky.getState().transcript.items)).toEqual(shape(steady.getState().transcript.items));
		expect(flaky.getState().freshness).toEqual({ state: "current", provisional: false });
	});

	it("falls back to a snapshot when the host no longer holds the deltas after the cursor", async () => {
		const host = new FixtureHost(long, { latencyMs: 5 });
		host.drain();
		// One recording is shorter than the host's window, so the client claims a cursor from before it.
		const stale = new SessionClient(claimingOldCursor(host), host.sessionId);
		stale.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(stale.getState().resumes.at(-1)?.how).toBe("snapshot");
		expect(stale.getState().cursor).toBe(host.head);
		expect(shape(stale.getState().transcript.items)).toEqual(shape(host.snapshot().items));
		expect(stale.getState().before).not.toBeNull();
	});
});

/** A transport whose hello claims a cursor below the host's retained window. */
function claimingOldCursor(host: FixtureHost) {
	return {
		connect: (receive: Parameters<FixtureHost["connect"]>[0]) => {
			const connection = host.connect(receive);
			return {
				send: (message: Parameters<typeof connection.send>[0]) =>
					connection.send(message.type === "hello" ? { ...message, cursor: -DELTA_RETENTION } : message),
				close: () => connection.close(),
			};
		},
	};
}

describe("splitBlocks", () => {
	it("splits at blank lines but never inside a code fence", () => {
		const text = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- one\n- two";
		expect(splitBlocks(text)).toEqual(["Intro\n", "```ts\nconst a = 1;\n\nconst b = 2;\n```\n", "- one\n- two"]);
	});

	it("keeps earlier blocks byte-identical as text streams in", () => {
		const full = "Para one.\n\nPara two is longer.\n\n```\ncode\n```";
		const early = splitBlocks(full.slice(0, 22));
		const late = splitBlocks(full);
		expect(late.slice(0, early.length - 1)).toEqual(early.slice(0, -1));
	});
});
