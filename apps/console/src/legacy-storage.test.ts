// Settings stored under harbour.* keys before the rename (TASK-4231) move to kantel.* keys.

import { describe, expect, it } from "vitest";
import { moveLegacyKeys } from "./legacy-storage.ts";

const memory = (entries: Record<string, string>) => {
	const items = new Map(Object.entries(entries));
	return {
		items,
		get length() {
			return items.size;
		},
		key: (index: number) => [...items.keys()][index] ?? null,
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
	};
};

describe("moveLegacyKeys", () => {
	it("copies each harbour.* value to its kantel.* key, keeping the old one for a rollback", () => {
		const storage = memory({
			"harbour.console.session": '{"token":"t","expiresAt":1}',
			"harbour.sidebar.collapsed": "1",
			"harbour.preview.width": "0.4",
			unrelated: "x",
		});
		expect(moveLegacyKeys(storage).sort()).toEqual([
			"kantel.console.session",
			"kantel.preview.width",
			"kantel.sidebar.collapsed",
		]);
		expect(storage.getItem("kantel.console.session")).toBe('{"token":"t","expiresAt":1}');
		expect(storage.getItem("harbour.console.session")).toBe('{"token":"t","expiresAt":1}');
		expect(storage.getItem("kantel.sidebar.collapsed")).toBe("1");
	});

	it("never overwrites a kantel.* key that is already set", () => {
		const storage = memory({ "harbour.sessions.view": '"list"', "kantel.sessions.view": '"grid"' });
		expect(moveLegacyKeys(storage)).toEqual([]);
		expect(storage.getItem("kantel.sessions.view")).toBe('"grid"');
	});

	it("leaves the theme to the theme controller, which maps its CSS", () => {
		const storage = memory({ "harbour.theme": "{}" });
		expect(moveLegacyKeys(storage)).toEqual([]);
		expect(storage.getItem("kantel.theme")).toBeNull();
	});

	it("does nothing without storage, or when storage throws", () => {
		expect(moveLegacyKeys(undefined)).toEqual([]);
		const broken = {
			length: 1,
			key: () => "harbour.sidebar.collapsed",
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => undefined,
		};
		expect(moveLegacyKeys(broken)).toEqual([]);
	});
});
