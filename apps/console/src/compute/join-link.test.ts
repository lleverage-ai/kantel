import { describe, expect, it } from "vitest";
import { createJoinLink, joinCodeOf } from "./join-link.ts";

function memoryStorage() {
	const items = new Map<string, string>();
	return {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
		removeItem: (key: string) => void items.delete(key),
	};
}

describe("an invite email's link", () => {
	it("carries the code in its fragment, and nothing else is one", () => {
		expect(joinCodeOf("#join=kji_abc123")).toBe("kji_abc123");
		expect(joinCodeOf("#join=kji_a%2Fb")).toBe("kji_a/b");
		expect(joinCodeOf("")).toBeUndefined();
		expect(joinCodeOf("#join=")).toBeUndefined();
		expect(joinCodeOf("#path=/home")).toBeUndefined();
		expect(joinCodeOf("#join=%E0%A4%A")).toBeUndefined();
	});

	it("keeps its code for the tab until Join is done with it, through a sign-in on a fresh page", () => {
		const storage = memoryStorage();
		const first = createJoinLink(() => storage);
		expect(first.take("#other")).toBe(false);
		expect(first.pending()).toBeUndefined();
		expect(first.take("#join=kji_abc123")).toBe(true);
		// The page after signing in, or signing out to sign in as someone else, has lost the fragment: the tab hasn't.
		const after = createJoinLink(() => storage);
		expect(after.pending()).toBe("kji_abc123");
		after.forget();
		expect(createJoinLink(() => storage).pending()).toBeUndefined();
	});

	it("keeps it for the page where there is no storage", () => {
		const link = createJoinLink(() => {
			throw new Error("no storage");
		});
		expect(link.take("#join=kji_abc123")).toBe(true);
		expect(link.pending()).toBe("kji_abc123");
		link.forget();
		expect(link.pending()).toBeUndefined();
	});
});
