// The theme controller and the boot script: light, dark or System, remembered in this browser, and a choice remembered
// before Kantel had only those two (version 1: a theme's ID with its CSS, maybe under `harbour.theme` from before the
// rename) migrated to the nearer of light and dark by its canvas, once.

import { describe, expect, it } from "vitest";
import { LEGACY_THEME_STORAGE_KEY, THEME_STORAGE_KEY, themeBootScript } from "./boot.ts";
import { createThemeController, readThemeCache } from "./controller.ts";

const memory = (entries: Record<string, string> = {}) => {
	const items = new Map(Object.entries(entries));
	return {
		items,
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
	};
};

/** A device in light mode or not, whose setting a test can change. */
const device = (matches: boolean) => {
	const listeners = new Set<() => void>();
	return {
		matches,
		addEventListener: (_: "change", listener: () => void) => void listeners.add(listener),
		removeEventListener: (_: "change", listener: () => void) => void listeners.delete(listener),
		set(next: boolean) {
			this.matches = next;
			for (const listener of listeners) listener();
		},
	};
};

/** <html>, as far as the controller touches it. */
const page = () => {
	const attributes = new Map<string, string>();
	return {
		attributes,
		root: {
			ownerDocument: undefined,
			getAttribute: (name: string) => attributes.get(name) ?? null,
			setAttribute: (name: string, value: string) => void attributes.set(name, value),
			classList: { add: () => undefined, remove: () => undefined },
		} as unknown as HTMLElement,
	};
};

/** A theme's CSS rule as a browser remembered it in version 1. `prefix` is `hb` for one from before the rename. */
const rule = (id: string, kind: "dark" | "light", canvas: string, prefix = "kt") =>
	`[data-${prefix}-theme="${id}"][data-${prefix}-theme], [data-${prefix}-theme="${id}"] .${prefix}-theme{color-scheme:${kind};--${prefix}-canvas:${canvas};--${prefix}-text:#e0def4;}`;

const v1 = (preference: string, css: Record<string, string> = {}) =>
	JSON.stringify({ v: 1, preference, dark: "kantel", light: "kantel-light", css });

const saved = (storage: ReturnType<typeof memory>) => JSON.parse(storage.getItem(THEME_STORAGE_KEY) ?? "null");

describe("the theme controller", () => {
	it("follows the device until a person chooses, and remembers nothing until then", () => {
		const storage = memory();
		const { root, attributes } = page();
		const prefersLight = device(true);
		const controller = createThemeController({ root, storage, prefersLight });
		expect(controller.state()).toEqual({ preference: "system", applied: "light" });
		expect(controller.remembered()).toBe(false);
		expect(attributes.get("data-kt-theme")).toBe("light");
		prefersLight.set(false);
		expect([controller.state().applied, attributes.get("data-kt-theme")]).toEqual(["dark", "dark"]);
		expect(storage.getItem(THEME_STORAGE_KEY)).toBeNull();
	});

	it("chooses light, dark or System, sets the attribute and remembers the choice", () => {
		const storage = memory();
		const { root, attributes } = page();
		const prefersLight = device(true);
		const controller = createThemeController({ root, storage, prefersLight });
		let told = 0;
		controller.subscribe(() => told++);
		controller.choose("light");
		expect([controller.state(), attributes.get("data-kt-theme")]).toEqual([
			{ preference: "light", applied: "light" },
			"light",
		]);
		expect(saved(storage)).toEqual({ v: 2, preference: "light" });
		controller.choose("system");
		expect(controller.state()).toEqual({ preference: "system", applied: "light" });
		// System follows the device as it changes.
		prefersLight.set(false);
		expect([controller.state().applied, attributes.get("data-kt-theme")]).toEqual(["dark", "dark"]);
		controller.choose("dark");
		prefersLight.set(true);
		expect(controller.state()).toEqual({ preference: "dark", applied: "dark" });
		expect(told).toBe(4);
		expect(controller.remembered()).toBe(true);
	});

	it("reads a retired theme's ID, as an older console kept it on the server, as the nearer of light and dark", () => {
		const controller = createThemeController({ storage: memory(), prefersLight: device(false) });
		controller.choose("catppuccin-latte");
		expect(controller.state().preference).toBe("light");
		controller.choose("tokyo-night");
		expect(controller.state().preference).toBe("dark");
		controller.choose("custom-sea");
		expect(controller.state().preference).toBe("system");
	});

	it("starts on what this browser remembers", () => {
		const storage = memory({ [THEME_STORAGE_KEY]: JSON.stringify({ v: 2, preference: "system" }) });
		const controller = createThemeController({ storage, prefersLight: device(true) });
		expect(controller.state()).toEqual({ preference: "system", applied: "light" });
		expect(controller.remembered()).toBe(true);
	});
});

describe("a choice remembered before light and dark", () => {
	it("goes to the nearer of the two by its canvas, and is written again as version 2", () => {
		for (const [preference, css, today] of [
			["rose-pine", { "rose-pine": rule("rose-pine", "dark", "#191724") }, "dark"],
			["solarized-light", { "solarized-light": rule("solarized-light", "light", "#fdf6e3") }, "light"],
			["kantel-light", {}, "light"],
			["system", {}, "system"],
			// A custom theme Kantel never shipped: its remembered canvas decides.
			["custom-paper", { "custom-paper": rule("custom-paper", "light", "#fffaf0") }, "light"],
			["custom-grey", { "custom-grey": rule("custom-grey", "dark", "#777777") }, "system"],
			// Any opaque notation the old theme API accepted.
			["custom-white", { "custom-white": rule("custom-white", "light", "#fff") }, "light"],
			["custom-rgb", { "custom-rgb": rule("custom-rgb", "light", "rgb(255 255 255)") }, "light"],
			["custom-ink", { "custom-ink": rule("custom-ink", "dark", "rgb(11, 29, 42)") }, "dark"],
			["custom-glass", { "custom-glass": rule("custom-glass", "light", "rgb(255 255 255 / 0.4)") }, "system"],
			["custom-gone", {}, "system"],
		] as const) {
			const storage = memory({ [THEME_STORAGE_KEY]: v1(preference, css) });
			const controller = createThemeController({ storage, prefersLight: device(false) });
			expect([preference, controller.state().preference]).toEqual([preference, today]);
			expect([preference, saved(storage)]).toEqual([preference, { v: 2, preference: today }]);
		}
	});

	it("under the key from before the rename, with --hb- CSS, moves to the new key", () => {
		const storage = memory({
			[LEGACY_THEME_STORAGE_KEY]: v1("harbour-light", {
				"harbour-light": rule("harbour-light", "light", "#f9f7f0", "hb"),
			}),
		});
		const controller = createThemeController({ storage, prefersLight: device(false) });
		expect(controller.state()).toEqual({ preference: "light", applied: "light" });
		expect(saved(storage)).toEqual({ v: 2, preference: "light" });
		const custom = memory({
			[LEGACY_THEME_STORAGE_KEY]: v1("custom-sea", { "custom-sea": rule("custom-sea", "dark", "#0b1d2a", "hb") }),
		});
		expect(createThemeController({ storage: custom, prefersLight: device(true) }).state().preference).toBe("dark");
	});

	it("is migrated once: the next load reads the same and writes nothing", () => {
		const storage = memory({ [THEME_STORAGE_KEY]: v1("nord", { nord: rule("nord", "dark", "#2a303b") }) });
		createThemeController({ storage, prefersLight: device(false) });
		const once = storage.getItem(THEME_STORAGE_KEY);
		expect(readThemeCache(storage)).toEqual({ preference: "dark", rewrite: false });
		const writes: string[] = [];
		createThemeController({
			storage: { getItem: storage.getItem, setItem: (key, value) => void writes.push(`${key}=${value}`) },
			prefersLight: device(false),
		});
		expect(writes).toEqual([]);
		expect(storage.getItem(THEME_STORAGE_KEY)).toBe(once);
	});

	it("loses to the new key when both are there", () => {
		const storage = memory({
			[LEGACY_THEME_STORAGE_KEY]: v1("solarized-light"),
			[THEME_STORAGE_KEY]: JSON.stringify({ v: 2, preference: "dark" }),
		});
		expect(createThemeController({ storage, prefersLight: device(false) }).state().preference).toBe("dark");
	});

	it("ignores what it can't read", () => {
		for (const raw of [
			"not json",
			"null",
			JSON.stringify({ v: 3, preference: "light" }),
			JSON.stringify({ v: 2, preference: "nord" }),
		])
			expect(readThemeCache(memory({ [THEME_STORAGE_KEY]: raw }))).toBeUndefined();
	});
});

describe("the boot script", () => {
	/** Runs the inline script against a fake page; returns the theme it set on <html>. */
	const boot = (entries: Record<string, string>, light = false) => {
		const attributes = new Map<string, string>();
		new Function("localStorage", "matchMedia", "document", themeBootScript)(
			memory(entries),
			() => ({ matches: light }),
			{ documentElement: { setAttribute: (name: string, value: string) => void attributes.set(name, value) } },
		);
		return attributes.get("data-kt-theme");
	};

	it("paints the device's theme with nothing remembered, and what was chosen otherwise", () => {
		expect(boot({}, true)).toBe("light");
		expect(boot({}, false)).toBe("dark");
		expect(boot({ [THEME_STORAGE_KEY]: JSON.stringify({ v: 2, preference: "light" }) })).toBe("light");
		expect(boot({ [THEME_STORAGE_KEY]: JSON.stringify({ v: 2, preference: "system" }) }, true)).toBe("light");
		expect(boot({ [THEME_STORAGE_KEY]: JSON.stringify({ v: 2, preference: "system" }) }, false)).toBe("dark");
		expect(boot({ [THEME_STORAGE_KEY]: "not json" }, true)).toBe("light");
		expect(boot({ [THEME_STORAGE_KEY]: JSON.stringify({ v: 2, preference: "dark" }) }, true)).toBe("dark");
	});

	it("paints a version 1 choice as the kind of theme it was, under either key", () => {
		const latte = v1("catppuccin-latte", { "catppuccin-latte": rule("catppuccin-latte", "light", "#eff1f5") });
		expect(boot({ [THEME_STORAGE_KEY]: latte })).toBe("light");
		expect(boot({ [THEME_STORAGE_KEY]: v1("dracula", { dracula: rule("dracula", "dark", "#21222c") }) }, true)).toBe(
			"dark",
		);
		expect(boot({ [THEME_STORAGE_KEY]: v1("system") }, true)).toBe("light");
		const old = v1("harbour-light", { "harbour-light": rule("harbour-light", "light", "#f9f7f0", "hb") });
		expect(boot({ [LEGACY_THEME_STORAGE_KEY]: old })).toBe("light");
	});
});
