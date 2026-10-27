import { readdirSync, readFileSync } from "node:fs";
import { applyFrames, parseFixture, type ServerFrame, serializeFixture, type TranscriptItem } from "@harbour/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Usage } from "../pi-durable/events.ts";
import { FixtureHost } from "../server-sim/fixture-host.ts";
import { parseRecording, toFrames } from "../server-sim/frames.ts";
import { Projector } from "../server-sim/project.ts";
import { splitBlocks } from "../ui/markdown.tsx";
import { COALESCE_MS, SessionClient, type Transport } from "./session-client.ts";

const root = new URL("../../../../fixtures/", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
const frames = (name: string): ServerFrame[] => parseFixture(read(`sessions/${name}.jsonl`));

const small = frames("small");
const long = frames("long-2000");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Run the host's whole fixture with clients attached, advancing fake time in small steps. */
async function playOut(host: FixtureHost, step = 37): Promise<void> {
	host.play();
	while (!host.finished) await vi.advanceTimersByTimeAsync(step);
	await vi.advanceTimersByTimeAsync(5_000);
}

const shape = (items: readonly TranscriptItem[]) => items.map((item) => JSON.stringify(item));

describe("frame fixtures", () => {
	it("small.jsonl is exactly what the projector makes of the small Pi recording", () => {
		const projected = serializeFixture(toFrames(parseRecording(read("pi-durable/small.jsonl"))));
		expect(read("sessions/small.jsonl")).toBe(projected);
	});

	it("every fixture in fixtures/sessions parses and applies cleanly with @harbour/protocol", () => {
		const names = readdirSync(new URL("sessions/", root)).filter((name) => name.endsWith(".jsonl"));
		expect(names).toContain("small.jsonl");
		for (const name of names) {
			const list = parseFixture(read(`sessions/${name}`));
			expect(list[0]?.type).toBe("hello");
			expect(list[1]?.type).toBe("snapshot");
			const cursors = list.flatMap((frame) => (frame.type === "delta" ? [frame.delta.cursor] : []));
			expect(new Set(cursors).size).toBe(cursors.length);
			const state = applyFrames(list);
			expect(state?.cursor).toBe(cursors.at(-1));
			// Nothing is left streaming once a recording ends.
			expect(state?.items.filter((item) => item.kind === "assistant" && item.streaming)).toEqual([]);
		}
	});

	it("projects the small recording into the turns, tools and final texts Pi committed", () => {
		const items = applyFrames(small)!.items;
		expect(items.map((item) => item.kind)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		const tools = items.filter((item) => item.kind === "tool");
		expect(tools.map((tool) => [tool.label, tool.status, tool.args])).toEqual([
			["Ran ls -la docs", "done", { command: "ls -la docs" }],
			["Read docs/release-notes.md", "done", { path: "docs/release-notes.md" }],
		]);
		const last = items.at(-1);
		expect(last?.kind === "assistant" && last.text).toMatch(/^The notes bury/);
	});
});

describe("projector", () => {
	const at = 1_000;
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const started: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage,
		stopReason: "pending",
		timestamp: at,
	};

	it("replaces a tool item whole as Pi trims and appends its output window", () => {
		const projector = new Projector();
		const call = { toolCallId: "c1", toolName: "bash" };
		projector.batch([{ type: "tool_execution_start", ...call, args: { command: "make" } }], at);
		const first = projector.batch([{ type: "tool_execution_update", ...call, output: { append: "one\ntwo\n" } }], at);
		const second = projector.batch(
			[{ type: "tool_execution_update", ...call, output: { trimStart: 4, append: "three\n" } }],
			at,
		);
		expect(first).toMatchObject([{ op: "replace", item: { output: "one\ntwo\n", status: "running" } }]);
		expect(second).toMatchObject([{ op: "replace", item: { output: "two\nthree\n", label: "Running make" } }]);
	});

	it("starts a new assistant item for text written after a tool call, so order is kept", () => {
		const projector = new Projector();
		const ops = projector.batch(
			[
				{ type: "message_start", message: started },
				{
					type: "message_update",
					usage,
					changes: [
						{ type: "text_start", contentIndex: 0, block: { type: "text", text: "Looking." } },
						{
							type: "toolcall_start",
							contentIndex: 1,
							block: { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.md" } },
						},
						{ type: "text_start", contentIndex: 2, block: { type: "text", text: "Done" } },
						{ type: "text_delta", contentIndex: 2, delta: "." },
					],
				},
			],
			at,
		);
		expect(
			ops.map((op) =>
				op.op === "text" ? `text ${op.itemId} ${op.append}` : `${op.op} ${"item" in op ? op.item.id : ""}`,
			),
		).toEqual([
			"append a:live:1",
			"text a:live:1 Looking.",
			"append tool:c1",
			"append a:live:1:1",
			"text a:live:1:1 Done",
			"text a:live:1:1 .",
		]);
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
		// The live run is about 35 s of recorded time and some 650 commits.
		expect(host.published).toBeGreaterThan(600);
		expect(client.getState().cursor).toBe(host.head);
		expect(renders).toBeLessThan(host.published / 3);
		expect(renders).toBeLessThan((35_000 / COALESCE_MS) * 1.5);
	});

	it("does not replace any earlier item while the long answer streams", async () => {
		const host = new FixtureHost(long, { latencyMs: 5 });
		const client = new SessionClient(host, host.sessionId);
		client.start();
		await vi.advanceTimersByTimeAsync(100);
		const atStart = client.getState().items;
		await playOut(host);
		const atEnd = client.getState().items;
		const kept = atStart.filter((item, index) => atEnd[index] === item).length;
		expect(kept).toBe(atStart.length);
		expect(atEnd.length).toBeGreaterThan(atStart.length);
	});

	it("pages earlier items in front without touching the ones it holds", async () => {
		const host = new FixtureHost(long, { latencyMs: 5 });
		const client = new SessionClient(host, host.sessionId);
		client.start();
		await vi.advanceTimersByTimeAsync(100);
		const page = client.getState().items;
		expect(client.getState().hasEarlier).toBe(true);
		client.loadOlder();
		await vi.advanceTimersByTimeAsync(100);
		const after = client.getState().items;
		expect(after.length).toBeGreaterThan(page.length);
		expect(after.slice(after.length - page.length)).toEqual(page);
		expect(after.at(-page.length)).toBe(page[0]);
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
		flaky.simulateDisconnect(3_000);
		// Dropping flushes what was received but still coalescing, so the cursor is everything the client got.
		const cursorAtDrop = flaky.getState().cursor!;
		expect(host.published).toBeGreaterThan(10);
		expect(flaky.getState().connection.status).toBe("offline");
		expect(flaky.getState().freshness.state).toBe("stale");
		await vi.advanceTimersByTimeAsync(3_200);
		const resume = flaky.getState().resumes.at(-1)!;
		expect(resume).toMatchObject({ from: cursorAtDrop, how: "deltas" });
		expect(resume.head).not.toBe(cursorAtDrop);
		while (!host.finished) await vi.advanceTimersByTimeAsync(50);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(flaky.getState().cursor).toBe(host.head);
		expect(shape(flaky.getState().items)).toEqual(shape(steady.getState().items));
		expect(flaky.getState().freshness).toEqual({ state: "current" });
	});

	it("falls back to a snapshot when the host no longer holds the deltas after the cursor", async () => {
		const host = new FixtureHost(long, { latencyMs: 5 });
		host.drain();
		const stale = new SessionClient(claimingOldCursor(host), host.sessionId);
		stale.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(stale.getState().resumes.at(-1)?.how).toBe("snapshot");
		expect(stale.getState().cursor).toBe(host.head);
		expect(shape(stale.getState().items)).toEqual(shape((await host.snapshot()).items));
		expect(stale.getState().hasEarlier).toBe(true);
	});
});

/** A transport whose hello claims a cursor the host never issued (or has long since dropped). */
function claimingOldCursor(host: FixtureHost): Transport {
	return {
		connect: (receive) => {
			const connection = host.connect(receive);
			return {
				send: (frame) => connection.send(frame.type === "hello" ? { ...frame, after: "c-forgotten" } : frame),
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
