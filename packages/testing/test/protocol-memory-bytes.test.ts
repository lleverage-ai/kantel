import type { ServerFrame } from "@kantel/protocol";
import { approximateBytes, createMemorySessionStream } from "@kantel/protocol/memory";
import { describe, expect, it } from "vitest";

/** A tool chip whose output is `bytes` characters, as a long command's would be. */
const chip = (id: string, bytes: number) => ({
	op: "append" as const,
	item: {
		kind: "tool" as const,
		id,
		at: 0,
		callId: id,
		name: "bash",
		label: "Running a command",
		status: "done" as const,
		output: "x".repeat(bytes),
	},
});

async function framesAfter(stream: ReturnType<typeof createMemorySessionStream>, cursor: string) {
	const frames: ServerFrame[] = [];
	const connection = await stream.connect(cursor, (frame) => frames.push(frame));
	await connection.close();
	return frames;
}

describe("the in-memory stream's resume window", () => {
	it("counts strings at two bytes a character", () => {
		expect(approximateBytes("abcd")).toBe(8);
		expect(approximateBytes({ ab: "cd" })).toBeGreaterThanOrEqual(8 + 4 + 4);
	});

	it("keeps no more than retainBytes of deltas, so a client behind them gets a snapshot", async () => {
		const stream = createMemorySessionStream({ sessionId: "s", retainBytes: 100_000 });
		await stream.publish([{ op: "title", title: "start" }]);
		const behind = (await stream.snapshot()).cursor;
		// Three 40 KB chips (80 KB each at two bytes a character): only the newest fits.
		for (const id of ["t1", "t2", "t3"]) await stream.publish([chip(id, 40_000)]);
		const frames = await framesAfter(stream, behind);
		expect(frames[0]).toMatchObject({ type: "hello", resumed: false });
		expect(frames[1]?.type).toBe("snapshot");
		// What the snapshot holds is still every item: only the window shrank.
		const snapshot = frames[1]?.type === "snapshot" ? frames[1].snapshot : undefined;
		expect(snapshot?.items.map((item) => item.id)).toEqual(["t1", "t2", "t3"]);
	});

	it("still resumes a client inside the window", async () => {
		const stream = createMemorySessionStream({ sessionId: "s", retainBytes: 100_000 });
		for (const id of ["t1", "t2"]) await stream.publish([chip(id, 40_000)]);
		const after = (await stream.snapshot()).cursor;
		await stream.publish([{ op: "title", title: "later" }]);
		const frames = await framesAfter(stream, after);
		expect(frames[0]).toMatchObject({ type: "hello", resumed: true });
		expect(frames.slice(1).map((frame) => frame.type)).toEqual(["delta"]);
	});

	it("resumes a client at the newest cursor even when one delta is larger than the window", async () => {
		const stream = createMemorySessionStream({ sessionId: "s", retainBytes: 1_000 });
		await stream.publish([chip("t1", 40_000)]);
		const now = (await stream.snapshot()).cursor;
		const frames = await framesAfter(stream, now);
		expect(frames).toEqual([expect.objectContaining({ type: "hello", resumed: true })]);
	});
});
