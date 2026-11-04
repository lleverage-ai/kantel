import type { ThemePreference } from "@kantel/contracts";
import { describe, expect, it, vi } from "vitest";
import { orderedSaves, syncTheme } from "./theme-sync.ts";

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

describe("orderedSaves", () => {
	/** A server whose writes answer only when the test says, and which keeps the last one to land. */
	const server = () => {
		const pending: { preference: ThemePreference; settle: (ok: boolean) => void }[] = [];
		const state = { kept: undefined as ThemePreference | undefined, sent: [] as ThemePreference[] };
		const write = (preference: ThemePreference) =>
			new Promise<void>((resolve, reject) => {
				state.sent.push(preference);
				pending.push({
					preference,
					settle: (ok) => {
						if (ok) {
							state.kept = preference;
							resolve();
						} else reject(new Error("offline"));
					},
				});
			});
		const answer = async (ok = true) => {
			pending.shift()?.settle(ok);
			await new Promise((resolve) => setTimeout(resolve, 0));
		};
		return { state, write, answer, pending };
	};

	it("sends one save at a time, so the latest choice is what the server keeps", async () => {
		const { state, write, answer, pending } = server();
		const save = orderedSaves(write);
		save("system");
		save("light");
		save("dark");
		// Only the first is in flight; light was replaced by dark while it waited.
		expect(pending.map((each) => each.preference)).toEqual(["system"]);
		await answer();
		await answer();
		expect(state.sent).toEqual(["system", "dark"]);
		expect(state.kept).toBe("dark");
	});

	it("goes on after a save fails", async () => {
		const { state, write, answer } = server();
		const failed = vi.fn();
		const save = orderedSaves(write, failed);
		save("light");
		save("dark");
		await answer(false);
		expect(failed).toHaveBeenCalledOnce();
		await answer();
		expect(state.kept).toBe("dark");
		save("system");
		await answer();
		expect(state.sent).toEqual(["light", "dark", "system"]);
		expect(state.kept).toBe("system");
	});
});

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
