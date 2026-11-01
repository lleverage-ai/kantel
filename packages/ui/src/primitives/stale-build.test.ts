// A dynamic import that fails because the build moved on (or sign-in expired) reloads the page once, never in a loop.
import { describe, expect, it } from "vitest";
import {
	isChunkLoadError,
	reloadForNewBuild,
	STALE_BUILD_RELOAD_KEY,
	STALE_BUILD_RELOAD_WINDOW_MS,
} from "./stale-build.ts";

function memoryStorage() {
	const held = new Map<string, string>();
	return {
		getItem: (key: string) => held.get(key) ?? null,
		setItem: (key: string, value: string) => held.set(key, value),
		held,
	};
}

describe("isChunkLoadError", () => {
	it("knows each browser's words for a chunk that didn't load", () => {
		for (const message of [
			// Safari, as on an iPhone: the old chunk came back as the console's page.
			"'text/html' is not a valid JavaScript MIME type.",
			"Importing a module script failed.",
			"Failed to fetch dynamically imported module: https://harbour.myslop.app/assets/image-body-CKnoALoU.js",
			"error loading dynamically imported module: https://harbour.myslop.app/assets/x.js",
			"Unable to preload CSS for /assets/x.css",
		]) {
			expect(isChunkLoadError(new TypeError(message))).toBe(true);
		}
		expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
		expect(isChunkLoadError(undefined)).toBe(false);
	});
});

describe("reloadForNewBuild", () => {
	it("reloads once, then not again within the window, then again after it", () => {
		const storage = memoryStorage();
		let reloads = 0;
		let now = 1_000_000;
		const options = { storage, reload: () => (reloads += 1), now: () => now };
		expect(reloadForNewBuild(options)).toBe(true);
		expect(reloads).toBe(1);
		expect(storage.held.get(STALE_BUILD_RELOAD_KEY)).toBe("1000000");
		now += 5_000;
		expect(reloadForNewBuild(options)).toBe(false);
		expect(reloads).toBe(1);
		now += STALE_BUILD_RELOAD_WINDOW_MS;
		expect(reloadForNewBuild(options)).toBe(true);
		expect(reloads).toBe(2);
	});

	it("never reloads where it can't remember that it did", () => {
		let reloads = 0;
		const refusing = {
			getItem: () => null,
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		};
		expect(reloadForNewBuild({ storage: refusing, reload: () => (reloads += 1) })).toBe(false);
		expect(reloads).toBe(0);
	});
});
