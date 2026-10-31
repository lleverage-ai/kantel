import { describe, expect, it } from "vitest";
import { canonicalJson, snapshotOf, toolsFromList } from "../src/snapshot.ts";

describe("toolsFromList", () => {
	it("keeps what the server gave, fills the defaults and picks the known annotations", () => {
		const tools = toolsFromList([
			{
				name: "search",
				description: "Searches the notes",
				inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
				annotations: { title: "Search", readOnlyHint: true, openWorldHint: false, colour: "blue", idempotentHint: "y" },
			},
			{ name: "write" },
			{ name: "odd", description: 3, inputSchema: [], annotations: { readOnlyHint: "true" } },
			{ description: "no name" },
			{ name: "" },
			"not a tool",
		]);
		expect(tools).toEqual([
			{
				name: "search",
				description: "Searches the notes",
				inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
				annotations: { title: "Search", readOnlyHint: true, openWorldHint: false },
				replay: "safe",
			},
			{ name: "write", description: "", inputSchema: { type: "object" }, replay: "unsafe" },
			{ name: "odd", description: "", inputSchema: { type: "object" }, replay: "unsafe" },
		]);
	});
});

describe("snapshotOf", () => {
	const tools = toolsFromList([
		{ name: "a", description: "first", inputSchema: { type: "object", properties: { x: { type: "number" } } } },
		{ name: "b", annotations: { readOnlyHint: true, destructiveHint: false } },
	]);

	it("hashes the tools' canonical JSON with SHA-256", async () => {
		const snapshot = await snapshotOf(tools, 1234);
		expect(snapshot.tools).toBe(tools);
		expect(snapshot.takenAt).toBe(1234);
		expect(snapshot.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("gives the same hash whatever order each object's keys come in", async () => {
		const reordered = toolsFromList([
			{ inputSchema: { properties: { x: { type: "number" } }, type: "object" }, description: "first", name: "a" },
			{ annotations: { destructiveHint: false, readOnlyHint: true }, name: "b" },
		]);
		expect(canonicalJson(reordered)).toBe(canonicalJson(tools));
		expect((await snapshotOf(reordered, 1)).hash).toBe((await snapshotOf(tools, 2)).hash);
	});

	it("gives a different hash when anything changes", async () => {
		const before = (await snapshotOf(tools, 1)).hash;
		const described = toolsFromList([
			{ name: "a", description: "First", inputSchema: { type: "object", properties: { x: { type: "number" } } } },
			{ name: "b", annotations: { readOnlyHint: true, destructiveHint: false } },
		]);
		const added = [...tools, ...toolsFromList([{ name: "c" }])];
		expect((await snapshotOf(described, 1)).hash).not.toBe(before);
		expect((await snapshotOf(added, 1)).hash).not.toBe(before);
	});
});
