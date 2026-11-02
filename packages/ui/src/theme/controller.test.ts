// A choice remembered before the rename: under `harbour.theme`, with CSS on `--hb-*` and `data-hb-theme`.
// The boot script and the controller read it when `kantel.theme` isn't there, in today's names, and the controller
// moves it to the new key.

import { describe, expect, it } from "vitest";
import { themeCss } from "../tokens/theme-schema.ts";
import { LEGACY_THEME_STORAGE_KEY, legacyThemeCss, THEME_STORAGE_KEY, themeBootScript } from "./boot.ts";
import { createThemeController } from "./controller.ts";
import { createThemeRegistry } from "./registry.ts";

const memory = (entries: Record<string, string> = {}) => {
	const items = new Map(Object.entries(entries));
	return {
		items,
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
	};
};

const light = (matches: boolean) => ({ matches, addEventListener: () => undefined });

/** The CSS a browser remembered before the rename: today's rule, in the old names. */
const oldCss = (id: string): string => {
	const theme = createThemeRegistry().get(id);
	if (theme === undefined) throw new Error(id);
	return themeCss(theme)
		.replace(/--kt-/g, "--hb-")
		.replace(/data-kt-theme/g, "data-hb-theme")
		.replace(/\.kt-theme/g, ".hb-theme");
};

const legacyCache = (preference: string, ids: string[]) =>
	JSON.stringify({
		v: 1,
		preference,
		dark: "harbour",
		light: "harbour-light",
		css: Object.fromEntries(ids.map((id) => [id, oldCss(id)])),
	});

describe("a theme remembered before the rename", () => {
	it("maps old CSS to today's names", () => {
		const theme = createThemeRegistry().get("rose-pine");
		expect(theme).toBeDefined();
		expect(legacyThemeCss(oldCss("rose-pine"))).toBe(themeCss(theme!));
	});

	it("is chosen again and moved to the new key, with today's CSS", () => {
		const storage = memory({ [LEGACY_THEME_STORAGE_KEY]: legacyCache("rose-pine", ["rose-pine"]) });
		const controller = createThemeController({ storage, prefersLight: light(false) });
		expect(controller.remembered()).toBe(true);
		expect(controller.state()).toMatchObject({ preference: "rose-pine", applied: "rose-pine" });
		const moved = JSON.parse(storage.getItem(THEME_STORAGE_KEY) ?? "null");
		expect(moved.preference).toBe("rose-pine");
		expect(moved.css["rose-pine"]).toContain('[data-kt-theme="rose-pine"]');
		expect(JSON.stringify(moved)).not.toContain("--hb-");
	});

	it("keeps System and its two themes", () => {
		const storage = memory({ [LEGACY_THEME_STORAGE_KEY]: legacyCache("system", ["harbour", "harbour-light"]) });
		const controller = createThemeController({ storage, prefersLight: light(true) });
		expect(controller.state()).toMatchObject({ preference: "system", applied: "kantel-light" });
		expect(JSON.parse(storage.getItem(THEME_STORAGE_KEY) ?? "null").preference).toBe("system");
	});

	it("leaves a custom theme the host hasn't registered yet under the old key", () => {
		const storage = memory({
			[LEGACY_THEME_STORAGE_KEY]: JSON.stringify({
				v: 1,
				preference: "custom-sea",
				dark: "harbour",
				light: "harbour-light",
				css: {},
			}),
		});
		createThemeController({ storage, prefersLight: light(false) });
		expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull();
		expect(storage.getItem(LEGACY_THEME_STORAGE_KEY)).not.toBeNull();
	});

	it("loses to the new key when both are there", () => {
		const storage = memory({
			[LEGACY_THEME_STORAGE_KEY]: legacyCache("rose-pine", ["rose-pine"]),
			[THEME_STORAGE_KEY]: JSON.stringify({
				v: 1,
				preference: "neutral",
				dark: "harbour",
				light: "harbour-light",
				css: {},
			}),
		});
		expect(createThemeController({ storage, prefersLight: light(false) }).state().preference).toBe("neutral");
	});
});

describe("a built-in theme remembered by its ID from before the rename", () => {
	const cache = (preference: string) =>
		JSON.stringify({ v: 1, preference, dark: "harbour", light: "harbour-light", css: {} });

	it("is today's theme, and is remembered again under today's ID", () => {
		for (const [old, today] of [
			["harbour", "kantel"],
			["harbour-light", "kantel-light"],
		] as const) {
			const storage = memory({ [THEME_STORAGE_KEY]: cache(old) });
			const controller = createThemeController({ storage, prefersLight: light(false) });
			expect(controller.state()).toMatchObject({ preference: today, applied: today });
			const saved = JSON.parse(storage.getItem(THEME_STORAGE_KEY) ?? "null");
			expect(saved).toMatchObject({ preference: today, dark: "kantel", light: "kantel-light" });
			expect(Object.keys(saved.css)).toEqual([today]);
		}
	});

	it("is found by the registry and the controller under either ID", () => {
		const registry = createThemeRegistry();
		expect(registry.get("harbour")?.id).toBe("kantel");
		expect(registry.get("harbour-light")?.id).toBe("kantel-light");
		expect(registry.builtin("harbour")).toBe(true);
		const controller = createThemeController({ registry, storage: memory(), prefersLight: light(false) });
		controller.choose("harbour-light");
		expect(controller.state()).toMatchObject({ preference: "kantel-light", applied: "kantel-light" });
		controller.preview("harbour");
		expect(controller.state()).toMatchObject({ applied: "kantel", previewing: true });
	});

	it("is the base of a custom theme that extends it", () => {
		const sea = (base: string) =>
			createThemeRegistry().register({ id: "custom-sea", name: "Sea", kind: "dark", extends: base, tokens: {} }).theme;
		const old = sea("harbour-light");
		expect(old?.id).toBe("custom-sea");
		// A dark theme on the light one: what it takes from its base shows which base it found.
		expect(themeCss(old!)).toBe(themeCss(sea("kantel-light")!));
		expect(themeCss(old!)).not.toBe(themeCss(sea("kantel")!));
	});
});

describe("the boot script", () => {
	/** Runs the inline script against a fake page; returns the CSS it added and the theme it set. */
	const boot = (entries: Record<string, string>) => {
		const added: { id: string; textContent: string }[] = [];
		const attributes = new Map<string, string>();
		const page = {
			localStorage: memory(entries),
			matchMedia: () => ({ matches: false }),
			document: {
				createElement: () => ({ id: "", textContent: "" }),
				head: { appendChild: (node: { id: string; textContent: string }) => void added.push(node) },
				documentElement: { setAttribute: (name: string, value: string) => void attributes.set(name, value) },
			},
		};
		new Function("localStorage", "matchMedia", "document", themeBootScript)(
			page.localStorage,
			page.matchMedia,
			page.document,
		);
		return { css: added[0]?.textContent, theme: attributes.get("data-kt-theme") };
	};

	it("paints a theme remembered under the old key, in today's names", () => {
		const { css, theme } = boot({ [LEGACY_THEME_STORAGE_KEY]: legacyCache("rose-pine", ["rose-pine"]) });
		expect(theme).toBe("rose-pine");
		expect(css).toBe(themeCss(createThemeRegistry().get("rose-pine")!));
	});

	it("prefers the new key and leaves its CSS as it is", () => {
		const rule = themeCss(createThemeRegistry().get("neutral")!);
		const { css, theme } = boot({
			[LEGACY_THEME_STORAGE_KEY]: legacyCache("rose-pine", ["rose-pine"]),
			[THEME_STORAGE_KEY]: JSON.stringify({
				v: 1,
				preference: "neutral",
				dark: "harbour",
				light: "harbour-light",
				css: { neutral: rule },
			}),
		});
		expect([theme, css]).toEqual(["neutral", rule]);
	});
});
