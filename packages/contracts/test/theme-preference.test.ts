// The console's two themes, and how a theme saved before them is read.

import { describe, expect, it } from "vitest";
import {
	isThemePreference,
	RETIRED_THEME_CANVAS,
	THEME_PREFERENCES,
	themeForCanvas,
	themePreference,
} from "../src/theme-preference.ts";

describe("themePreference", () => {
	it("keeps light, dark and system", () => {
		for (const preference of THEME_PREFERENCES) expect(themePreference(preference)).toBe(preference);
	});

	it("reads each retired built-in theme as the nearer of light and dark by its canvas", () => {
		const read = Object.fromEntries(Object.keys(RETIRED_THEME_CANVAS).map((id) => [id, themePreference(id)]));
		expect(read).toEqual({
			kantel: "dark",
			"kantel-light": "light",
			harbour: "dark",
			"harbour-light": "light",
			neutral: "dark",
			"neutral-light": "light",
			"catppuccin-mocha": "dark",
			"catppuccin-latte": "light",
			dracula: "dark",
			gruvbox: "dark",
			nord: "dark",
			"one-dark": "dark",
			"rose-pine": "dark",
			"tokyo-night": "dark",
			"github-light": "light",
			"solarized-light": "light",
		});
	});

	it("reads a theme it doesn't know by the canvas the caller gives, else as system", () => {
		expect(themePreference("custom-sea", "#0b1d2a")).toBe("dark");
		expect(themePreference("custom-paper", "#fffaf0")).toBe("light");
		expect(themePreference("custom-sea")).toBe("system");
		expect(themePreference("toString")).toBe("system");
		expect(themePreference("custom-x", "var(--kt-text)")).toBe("system");
	});

	it("is idempotent: reading what it gave gives the same", () => {
		const inputs: [string, string?][] = [
			...Object.keys(RETIRED_THEME_CANVAS).map((id): [string] => [id]),
			["custom-sea", "#0b1d2a"],
			["custom-grey", "#777777"],
			["custom-unknown"],
			["system"],
		];
		for (const [saved, canvas] of inputs) {
			const once = themePreference(saved, canvas);
			expect(isThemePreference(once)).toBe(true);
			expect(themePreference(once, canvas)).toBe(once);
		}
	});
});

describe("themeForCanvas", () => {
	it("is a clear match only when one theme is much nearer; a mid grey follows the device", () => {
		expect(themeForCanvas("#000000")).toBe("dark");
		expect(themeForCanvas("#ffffff")).toBe("light");
		expect(themeForCanvas("#777777")).toBe("system");
		expect(themeForCanvas("#5a5a5a")).toBe("dark");
		expect(themeForCanvas("red")).toBe("system");
	});
});
