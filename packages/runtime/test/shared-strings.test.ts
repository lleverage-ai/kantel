// Entry reads that share their long strings with the entry the session already holds (`shareEntryStrings`): reads
// return the parsed records as before, never the held objects, and leave the held entries alone.
import { type ConversationId, type EntryId, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { adoptStrings, shareEntryStrings } from "../src/shared-strings.ts";

const long = (seed: string) => `${seed} ${"x".repeat(4096)}`;

describe("adoptStrings", () => {
	it("takes the equal long strings and keeps its own otherwise", () => {
		const source = {
			model: [{ content: [{ type: "toolCall", arguments: { content: long("a"), path: "a.txt" } }] }],
			text: long("b"),
		};
		const target = structuredClone(source) as typeof source;
		target.text = long("changed");
		adoptStrings(target, source);
		expect(target.model[0]?.content[0]?.arguments).toEqual(source.model[0]?.content[0]?.arguments);
		expect(target.text).toBe(long("changed"));
		expect(target.model).not.toBe(source.model);
	});

	it("leaves a frozen target and a different shape alone", () => {
		const frozen = Object.freeze({ text: long("a") });
		expect(() => adoptStrings(frozen, { text: long("a") })).not.toThrow();
		const target = { items: [long("a")] };
		adoptStrings(target, { items: { 0: long("a") } });
		expect(target.items).toEqual([long("a")]);
	});
});

describe("shareEntryStrings", () => {
	const context = {} as Parameters<Storage["commit"]>[1];

	it("reads entries as the inner storage does, without handing out or changing the written entry", async () => {
		const inner = new MemoryStorage();
		const storage = shareEntryStrings(inner);
		const conversationId = await storage.mintId<ConversationId>();
		const entryId = await storage.mintId<EntryId>();
		const conversation = { id: conversationId, createdAt: 1 };
		const entry = {
			id: entryId,
			conversationId,
			kind: "test",
			createdAt: 1,
			model: [{ role: "user", content: long("prompt"), timestamp: 1 }],
		};
		await storage.commit(
			[
				{ type: "conversation", value: conversation },
				{ type: "entry", value: entry },
			] as unknown as Parameters<Storage["commit"]>[0],
			context,
		);
		const page = await storage.scanEntries({ conversationId }, 10, undefined, context);
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toEqual(entry);
		expect(page.items[0]).not.toBe(entry);
		const found = await storage.entry(entryId, context);
		expect(found?.entry).toEqual(entry);
		const scoped = await storage.entry(conversationId, entryId, context);
		expect(scoped?.entry).toEqual(entry);
		expect(Object.isFrozen(entry)).toBe(false);
		expect(await storage.findLatestHeadMarker(conversationId, undefined, context)).toBeUndefined();
		await storage.close(context);
	});
});
