// The history pages a session's stream gives (history.ts): the latest page across the snapshot's edge, cursors that
// survive new items, and the refusals. The conformance suite covers the same through each runtime and HTTP.
import { KantelError, protocolHistoryPage, SESSION_HISTORY_MAX_LIMIT } from "@kantel/contracts";
import type { TranscriptItem } from "@kantel/protocol";
import { createMemorySessionStream } from "@kantel/protocol/memory";
import { historyCursor, itemOfCursor, readHistory } from "@kantel/runtime";
import { describe, expect, it } from "vitest";

const user = (id: string): TranscriptItem => ({ kind: "user", id, at: 0, text: id, via: "prompt" });

async function streamOf(count: number, pageSize = 5) {
	const stream = createMemorySessionStream({ sessionId: "s1", pageSize, now: () => 0 });
	for (let index = 0; index < count; index++) await stream.publish([{ op: "append", item: user(`i${index}`) }]);
	return stream;
}

const ids = (items: readonly TranscriptItem[]) => items.map((item) => item.id);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `i${from + index}`);

const code = async (operation: Promise<unknown>) => {
	try {
		await operation;
	} catch (error) {
		return error instanceof KantelError ? error.code : String(error);
	}
	return "resolved";
};

describe("readHistory", () => {
	it("serves the latest page newest first, reaching past the snapshot's page when the limit is larger", async () => {
		const stream = await streamOf(12, 5);
		const page = await readHistory(stream, "s1", { limit: 8 });
		expect(ids(page.items)).toEqual(range(4, 12).reverse());
		expect(page.nextCursor).toBe(historyCursor("i4"));
		const smaller = await readHistory(stream, "s1", { limit: 3 });
		expect(ids(smaller.items)).toEqual(["i11", "i10", "i9"]);
		expect(smaller.nextCursor).toBe(historyCursor("i9"));
	});

	it("says there is nothing older when the page reaches the first item", async () => {
		const stream = await streamOf(4, 5);
		const page = await readHistory(stream, "s1", { limit: 10 });
		expect(ids(page.items)).toEqual(range(0, 4).reverse());
		expect(page.nextCursor).toBeUndefined();
		const exact = await readHistory(await streamOf(5, 5), "s1", { limit: 5 });
		expect(exact.nextCursor).toBeUndefined();
	});

	it("pages back from a cursor the same way after new items arrive", async () => {
		const stream = await streamOf(10, 5);
		const latest = await readHistory(stream, "s1", { limit: 4 });
		for (let index = 10; index < 20; index++) await stream.publish([{ op: "append", item: user(`i${index}`) }]);
		const next = await readHistory(stream, "s1", { cursor: latest.nextCursor!, limit: 4 });
		expect(ids(next.items)).toEqual(["i5", "i4", "i3", "i2"]);
		const last = await readHistory(stream, "s1", { cursor: next.nextCursor!, limit: 4 });
		expect(ids(last.items)).toEqual(["i1", "i0"]);
		expect(last.nextCursor).toBeUndefined();
	});

	it("pages back from an item a client holds, which the protocol's history frame carries oldest first", async () => {
		const stream = await streamOf(10, 5);
		const page = await readHistory(stream, "s1", { before: "i6", limit: 3 });
		expect(ids(page.items)).toEqual(["i5", "i4", "i3"]);
		expect(protocolHistoryPage(page)).toEqual({
			sessionId: "s1",
			items: page.items.toReversed(),
			hasEarlier: true,
		});
	});

	it("cuts a large limit to the most a page holds and refuses a malformed request", async () => {
		const stream = await streamOf(SESSION_HISTORY_MAX_LIMIT + 10, 50);
		expect((await readHistory(stream, "s1", { limit: 10_000 })).items).toHaveLength(SESSION_HISTORY_MAX_LIMIT);
		expect((await readHistory(stream, "s1")).items).toHaveLength(50);
		expect(await code(readHistory(stream, "s1", { limit: 0 }))).toBe("invalid");
		expect(await code(readHistory(stream, "s1", { limit: 1.5 }))).toBe("invalid");
		expect(await code(readHistory(stream, "s1", { cursor: "h1.!!" }))).toBe("invalid");
		expect(await code(readHistory(stream, "s1", { cursor: "o12" }))).toBe("invalid");
		expect(await code(readHistory(stream, "s1", { cursor: historyCursor("i3"), before: "i3" }))).toBe("invalid");
		expect(await code(readHistory(stream, "s1", { before: "nope" }))).toBe("not_found");
		expect(await code(readHistory(stream, "s1", { cursor: historyCursor("nope") }))).toBe("not_found");
	});
});

describe("history cursors", () => {
	it("round-trip any item ID, including ones with separators and non-ASCII text", () => {
		for (const id of ["u12", "t7:toolu_01/ab+c", "a-é-✓"]) expect(itemOfCursor(historyCursor(id))).toBe(id);
	});
});
