import { describe, expect, it, vi } from "vitest";
import { syncTheme } from "./theme-sync.ts";

const controller = (preference: string, remembered: boolean) => {
	let current = preference;
	return {
		state: () => ({ preference: current, applied: current, previewing: false }),
		remembered: () => remembered,
		choose: vi.fn((next: string) => {
			current = next;
		}),
	};
};

describe("syncTheme", () => {
	it("takes the server's theme when it differs from this browser's", () => {
		const page = controller("harbour", true);
		const save = vi.fn();
		syncTheme(page, { theme: "nord" }, save);
		expect(page.choose).toHaveBeenCalledWith("nord");
		expect(save).not.toHaveBeenCalled();
	});

	it("leaves the page alone when they agree", () => {
		const page = controller("nord", true);
		syncTheme(page, { theme: "nord" });
		expect(page.choose).not.toHaveBeenCalled();
	});

	it("keeps this browser's choice for a person with none saved", () => {
		const page = controller("catppuccin-latte", true);
		const save = vi.fn();
		syncTheme(page, {}, save);
		expect(save).toHaveBeenCalledWith("catppuccin-latte");
	});

	it("saves nothing for a person who never chose: they get the default", () => {
		const page = controller("harbour", false);
		const save = vi.fn();
		syncTheme(page, {}, save);
		syncTheme(page, undefined, save);
		expect(save).not.toHaveBeenCalled();
		expect(page.choose).not.toHaveBeenCalled();
	});
});
