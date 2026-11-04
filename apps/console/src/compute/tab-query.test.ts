import { describe, expect, it } from "vitest";
import { HOSTING_KEY, SOURCE_KEY, tabQueryOf } from "./tab-query.ts";

const session = (entries: Record<string, string>) => ({ getItem: (key: string) => entries[key] ?? null });

describe("a new tab's query", () => {
	it("carries the source and hosting this tab keeps, and the sample data it asked for", () => {
		expect(tabQueryOf("", session({}))).toBe("");
		expect(tabQueryOf("", session({ [SOURCE_KEY]: "recorded", [HOSTING_KEY]: "hosted" }))).toBe(
			"source=recorded&hosting=hosted",
		);
		expect(tabQueryOf("?data=sample&theme=dark", session({}))).toBe("data=sample");
		// Asked for in this address, with no storage to keep it in.
		expect(tabQueryOf("?hosting=self-hosted", undefined)).toBe("hosting=self-hosted");
	});

	it("ignores what it doesn't know, and storage that can't be read", () => {
		expect(tabQueryOf("?data=other", session({ [SOURCE_KEY]: "x", [HOSTING_KEY]: "y" }))).toBe("");
		const blocked = {
			getItem: () => {
				throw new Error("blocked");
			},
		};
		expect(tabQueryOf("", blocked)).toBe("");
	});
});
