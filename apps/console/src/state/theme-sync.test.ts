import type { ThemePreference } from "@kantel/contracts";
import { describe, expect, it, vi } from "vitest";
import { syncTheme } from "./theme-sync.ts";

const controller = (preference: ThemePreference, remembered: boolean) => {
	let current = preference;
	return {
		state: () => ({ preference: current, applied: current === "system" ? ("dark" as const) : current }),
		remembered: () => remembered,
		choose: vi.fn((next: string) => {
			current = next as ThemePreference;
		}),
	};
};

describe("syncTheme", () => {
	it("takes the server's theme when it differs from this browser's", () => {
		const page = controller("dark", true);
		const save = vi.fn();
		syncTheme(page, { theme: "light" }, save);
		expect(page.choose).toHaveBeenCalledWith("light");
		expect(save).not.toHaveBeenCalled();
	});

	it("reads a theme saved before light and dark as the nearer of the two, and saves it so", () => {
		const page = controller("dark", true);
		const save = vi.fn();
		syncTheme(page, { theme: "catppuccin-latte" }, save);
		expect(page.choose).toHaveBeenCalledWith("light");
		expect(save).toHaveBeenCalledWith("light");

		const same = controller("dark", true);
		const again = vi.fn();
		syncTheme(same, { theme: "harbour" /* before the rename */ }, again);
		expect(same.choose).not.toHaveBeenCalled();
		expect(again).toHaveBeenCalledWith("dark");

		const custom = controller("light", true);
		const unknown = vi.fn();
		syncTheme(custom, { theme: "custom-sea" }, unknown);
		expect(custom.choose).toHaveBeenCalledWith("system");
		expect(unknown).toHaveBeenCalledWith("system");
	});

	it("leaves the page alone when they agree", () => {
		const page = controller("system", true);
		const save = vi.fn();
		syncTheme(page, { theme: "system" }, save);
		expect(page.choose).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("keeps this browser's choice for a person with none saved", () => {
		const page = controller("light", true);
		const save = vi.fn();
		syncTheme(page, {}, save);
		expect(save).toHaveBeenCalledWith("light");
	});

	it("saves nothing for a person who never chose: they get the default", () => {
		const page = controller("dark", false);
		const save = vi.fn();
		syncTheme(page, {}, save);
		syncTheme(page, undefined, save);
		expect(save).not.toHaveBeenCalled();
		expect(page.choose).not.toHaveBeenCalled();
	});
});
