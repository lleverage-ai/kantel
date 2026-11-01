import { themeCss } from "../tokens/theme-schema.ts";
import { DEFAULT_LIGHT_THEME, DEFAULT_THEME } from "../tokens/themes/index.ts";
import { BOOT_STYLE_ID, LEGACY_THEME_STORAGE_KEY, legacyThemeCss, THEME_STORAGE_KEY } from "./boot.ts";
import { createThemeRegistry, type ThemeRegistry } from "./registry.ts";

// Applying a theme to the page. A theme is a CSS rule on `[data-kt-theme="<id>"]`, and every theme's rule is in one
// stylesheet the controller adds to the page, so choosing a theme sets one attribute on <html>: the browser restyles
// the page in the next frame, and React renders nothing. Previewing (the picker's arrows) does the same without
// remembering; ending the preview puts the chosen theme back.
//
// What a person chose is their preference: a theme's ID, or "system", which follows the device between a dark and a
// light theme. This browser remembers it in localStorage with the CSS of the themes it may show, so the boot script
// (boot.ts) puts the right theme on the page before its first paint, before any JS bundle has loaded. The host keeps
// the preference for the person too (the console stores it as their user preference) and calls `choose` with what the
// server has, which wins.

/** Follow the device: the dark theme in dark mode, the light one in light mode. */
export const SYSTEM_THEME = "system";

/** What this browser remembers, for the boot script: version 1. */
export type ThemeCache = {
	readonly v: 1;
	/** A theme ID or "system". */
	readonly preference: string;
	/** System's dark and light themes. */
	readonly dark: string;
	readonly light: string;
	/** The CSS rule of each theme the preference may show. */
	readonly css: Readonly<Record<string, string>>;
};

export type ThemeState = {
	/** What the person chose: a theme ID or "system". */
	readonly preference: string;
	/** The theme on the page now: the preference's, or the one being previewed. */
	readonly applied: string;
	/** Whether `applied` is a preview the picker may still take back. */
	readonly previewing: boolean;
};

export type ThemeController = {
	readonly registry: ThemeRegistry;
	/** System's dark and light themes. */
	readonly system: { readonly dark: string; readonly light: string };
	state(): ThemeState;
	/** Whether this browser remembers a choice: one made here, now or on an earlier visit. */
	remembered(): boolean;
	/** Chooses a theme (or "system"), applies it and remembers it in this browser. An unknown ID is ignored. */
	choose(preference: string): void;
	/** Shows a theme without choosing it. */
	preview(id: string): void;
	/** Ends a preview: back to the chosen theme. */
	endPreview(): void;
	/** The theme a preference shows on this device now. */
	resolve(preference: string): string;
	subscribe(listener: () => void): () => void;
	/** Takes the stylesheet off the page and stops following the device, for tests and hot reload. */
	dispose(): void;
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export type ThemeControllerOptions = {
	registry?: ThemeRegistry;
	/** The element the attribute goes on. Default: <html>. */
	root?: HTMLElement;
	storage?: Storage;
	/** Light mode, for System. Default: the browser's prefers-color-scheme. */
	prefersLight?: { readonly matches: boolean; addEventListener(type: "change", listener: () => void): void };
	/** System's dark and light themes. */
	system?: { readonly dark: string; readonly light: string };
};

/** What this browser remembers, and whether it is under the key from before the rename. */
function readCache(storage: Storage | undefined): { cache: ThemeCache; legacy: boolean } | undefined {
	try {
		let raw = storage?.getItem(THEME_STORAGE_KEY);
		const legacy = raw === null || raw === undefined;
		if (legacy) raw = storage?.getItem(LEGACY_THEME_STORAGE_KEY);
		if (raw === null || raw === undefined) return undefined;
		const cache = JSON.parse(raw) as Partial<ThemeCache>;
		if (cache.v !== 1 || typeof cache.preference !== "string") return undefined;
		if (!legacy) return { cache: cache as ThemeCache, legacy };
		const css = Object.fromEntries(
			Object.entries(cache.css ?? {}).flatMap(([id, rule]) =>
				typeof rule === "string" ? [[id, legacyThemeCss(rule)]] : [],
			),
		);
		return { cache: { ...(cache as ThemeCache), css }, legacy };
	} catch {
		return undefined;
	}
}

const STYLE_ATTRIBUTE = "data-kt-themes";
/** On <html> for the frame a theme changes in, so no transition animates the switch. */
const SWITCHING_CLASS = "kt-theme-switching";

export function createThemeController(options: ThemeControllerOptions = {}): ThemeController {
	const registry = options.registry ?? createThemeRegistry();
	const doc = options.root?.ownerDocument ?? globalThis.document;
	const root = options.root ?? doc?.documentElement;
	const storage = options.storage ?? safeLocalStorage();
	const system = options.system ?? { dark: DEFAULT_THEME, light: DEFAULT_LIGHT_THEME };
	const prefersLight = options.prefersLight ?? globalThis.matchMedia?.("(prefers-color-scheme: light)");
	const listeners = new Set<() => void>();

	const resolve = (preference: string): string => {
		if (preference === SYSTEM_THEME) return prefersLight?.matches === true ? system.light : system.dark;
		return registry.get(preference) === undefined ? DEFAULT_THEME : preference;
	};
	const read = readCache(storage);
	const cached = read?.cache;
	let remembered = cached !== undefined;
	let preference =
		cached !== undefined && (cached.preference === SYSTEM_THEME || registry.get(cached.preference) !== undefined)
			? cached.preference
			: DEFAULT_THEME;
	let state: ThemeState = { preference, applied: resolve(preference), previewing: false };

	// Every theme's rule, in one stylesheet, kept in step with the registry.
	const style = doc?.createElement("style");
	if (style !== undefined && doc !== undefined) {
		style.setAttribute(STYLE_ATTRIBUTE, "");
		style.textContent = registry.css();
		doc.head.append(style);
		doc.getElementById(BOOT_STYLE_ID)?.remove();
	}
	const unsubscribe = registry.subscribe(() => {
		if (style !== undefined) style.textContent = registry.css();
		// A theme removed from under the page falls back.
		if (registry.get(state.applied) === undefined) set({ ...state, applied: resolve(state.preference) });
	});

	let settle: number | undefined;
	const paint = (id: string) => {
		if (root === undefined || root.getAttribute("data-kt-theme") === id) return;
		// No transition runs for the switch: every colour lands in the same frame.
		root.classList.add(SWITCHING_CLASS);
		root.setAttribute("data-kt-theme", id);
		if (settle !== undefined) globalThis.cancelAnimationFrame?.(settle);
		const raf = globalThis.requestAnimationFrame;
		if (raf === undefined) root.classList.remove(SWITCHING_CLASS);
		else
			settle = raf(() => {
				settle = raf(() => {
					settle = undefined;
					root.classList.remove(SWITCHING_CLASS);
				});
			});
	};
	const set = (next: ThemeState) => {
		state = next;
		paint(next.applied);
		for (const listener of listeners) listener();
	};
	const remember = () => {
		const shows = preference === SYSTEM_THEME ? [system.dark, system.light] : [resolve(preference)];
		const css: Record<string, string> = {};
		for (const id of shows) {
			const theme = registry.get(id);
			if (theme !== undefined) css[id] = themeCss(theme);
		}
		const cache: ThemeCache = { v: 1, preference, dark: system.dark, light: system.light, css };
		try {
			storage?.setItem(THEME_STORAGE_KEY, JSON.stringify(cache));
		} catch {
			// Private browsing without storage: the page still switches; the next load starts on the default.
		}
	};

	paint(state.applied);
	// A choice remembered under the old key moves to the new one, with today's CSS. Only once its theme is known here:
	// a custom theme the host hasn't registered yet stays under the old key until then, rather than become the default.
	if (read?.legacy === true && cached !== undefined && preference === cached.preference) remember();
	prefersLight?.addEventListener("change", () => {
		if (state.preference === SYSTEM_THEME && !state.previewing) set({ ...state, applied: resolve(SYSTEM_THEME) });
	});

	return {
		registry,
		system,
		state: () => state,
		remembered: () => remembered,
		choose(next) {
			if (next !== SYSTEM_THEME && registry.get(next) === undefined) return;
			preference = next;
			remembered = true;
			set({ preference, applied: resolve(next), previewing: false });
			remember();
		},
		preview(id) {
			if (registry.get(id) === undefined) return;
			set({ ...state, applied: id, previewing: true });
		},
		endPreview() {
			if (!state.previewing) return;
			set({ ...state, applied: resolve(state.preference), previewing: false });
		},
		resolve,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose() {
			unsubscribe();
			style?.remove();
			listeners.clear();
		},
	};
}

function safeLocalStorage(): Storage | undefined {
	try {
		return globalThis.localStorage ?? undefined;
	} catch {
		return undefined;
	}
}

let shared: ThemeController | undefined;

/** The page's one theme controller, made on first use. */
export function themeController(): ThemeController {
	shared ??= createThemeController();
	return shared;
}
