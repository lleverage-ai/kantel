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

	it("takes what the address asks for over what this tab kept, as the app does when it starts", () => {
		const kept = session({ [SOURCE_KEY]: "api", [HOSTING_KEY]: "hosted" });
		expect(tabQueryOf("?hosting=self-hosted&source=recorded", kept)).toBe("source=recorded&hosting=self-hosted");
		expect(tabQueryOf("?hosting=other", kept)).toBe("source=api&hosting=hosted");
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
