import { isThemePreference, type ThemeName, type ThemePreference, themePreference } from "@kantel/contracts";
import { DEFAULT_THEME_PREFERENCE, LEGACY_THEME_STORAGE_KEY, THEME_STORAGE_KEY } from "./boot.ts";

// Applying the theme to the page. Kantel has two, dark and light, and both palettes are in the page's stylesheet
// (src/tokens/dark.css, light.css), so applying one sets one attribute, `data-kt-theme`, on <html>: the browser
// restyles the page in the next frame, and React renders nothing.
//
// What a person chose is their preference: light, dark, or system, which follows the device's prefers-color-scheme
// and changes with it. This browser remembers it in localStorage, so the boot script (boot.ts) puts the right theme on
// the page before its first paint. The host keeps the preference for the person too (the console stores it as their
// user preference) and calls `choose` with what the server has, which wins.

/** Follow the device: dark in dark mode, light in light mode. */
export const SYSTEM_THEME = "system" satisfies ThemePreference;

/** What this browser remembers, for the boot script: version 2. */
export type ThemeCache = {
	readonly v: 2;
	readonly preference: ThemePreference;
};

/**
 * What a browser remembered before Kantel had only light and dark: a theme's ID (or system) with the CSS of the themes
 * it could show, which held each one's canvas.
 */
type ThemeCacheV1 = {
	readonly v: 1;
	readonly preference: string;
	readonly css?: Readonly<Record<string, unknown>>;
};

export type ThemeState = {
	/** What the person chose. */
	readonly preference: ThemePreference;
	/** The theme on the page now: the preference's, with System worked out for this device. */
	readonly applied: ThemeName;
};

export type ThemeController = {
	state(): ThemeState;
	/** Whether this browser remembers a choice: one made here, now or on an earlier visit. */
	remembered(): boolean;
	/**
	 * Chooses light, dark or system, applies it and remembers it in this browser. Anything else (a theme's ID from before
	 * light and dark, kept on the server by an older console) is read as the nearer of the two, or system.
	 */
	choose(preference: string): void;
	/** The theme a preference shows on this device now. */
	resolve(preference: ThemePreference): ThemeName;
	subscribe(listener: () => void): () => void;
	/** Stops following the device, for tests and hot reload. */
	dispose(): void;
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

type MediaQuery = {
	readonly matches: boolean;
	addEventListener(type: "change", listener: () => void): void;
	removeEventListener?(type: "change", listener: () => void): void;
};

export type ThemeControllerOptions = {
	/** The element the attribute goes on. Default: <html>. */
	root?: HTMLElement;
	storage?: Storage;
	/** Light mode, for System. Default: the browser's prefers-color-scheme. */
	prefersLight?: MediaQuery;
};

/** A theme's canvas in its remembered CSS rule, `--kt-canvas:#141e28;` (`--hb-canvas` before the rename). */
const canvasIn = (css: unknown): string | undefined =>
	typeof css === "string" ? /--(?:kt|hb)-canvas:\s*(#[0-9a-f]{6})\b/i.exec(css)?.[1] : undefined;

/**
 * What this browser remembers, as today's preference, and whether it must be written again: it was under the key from
 * before the rename, or in version 1, from before light and dark. Version 1 is migrated by `themePreference`, with the
 * remembered theme's canvas for a theme it doesn't know, so a custom theme goes to the nearer of the two too.
 */
export function readThemeCache(
	storage: Storage | undefined,
): { readonly preference: ThemePreference; readonly rewrite: boolean } | undefined {
	try {
		let raw = storage?.getItem(THEME_STORAGE_KEY);
		const legacy = raw === null || raw === undefined;
		if (legacy) raw = storage?.getItem(LEGACY_THEME_STORAGE_KEY);
		if (raw === null || raw === undefined) return undefined;
		const cache = JSON.parse(raw) as Partial<ThemeCache> | Partial<ThemeCacheV1> | null;
		if (cache?.v === 2 && isThemePreference(cache.preference)) return { preference: cache.preference, rewrite: legacy };
		if (cache?.v === 1 && typeof cache.preference === "string") {
			const old = cache as ThemeCacheV1;
			return { preference: themePreference(old.preference, canvasIn(old.css?.[old.preference])), rewrite: true };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** On <html> for the frame a theme changes in, so no transition animates the switch. */
const SWITCHING_CLASS = "kt-theme-switching";

export function createThemeController(options: ThemeControllerOptions = {}): ThemeController {
	const doc = options.root?.ownerDocument ?? globalThis.document;
	const root = options.root ?? doc?.documentElement;
	const storage = options.storage ?? safeLocalStorage();
	const prefersLight = options.prefersLight ?? globalThis.matchMedia?.("(prefers-color-scheme: light)");
	const listeners = new Set<() => void>();

	const resolve = (preference: ThemePreference): ThemeName =>
		preference === SYSTEM_THEME ? (prefersLight?.matches === true ? "light" : "dark") : preference;
	const read = readThemeCache(storage);
	let remembered = read !== undefined;
	const first = read?.preference ?? DEFAULT_THEME_PREFERENCE;
	let state: ThemeState = { preference: first, applied: resolve(first) };

	let settle: number | undefined;
	const paint = (theme: ThemeName) => {
		if (root === undefined || root.getAttribute("data-kt-theme") === theme) return;
		// No transition runs for the switch: every colour lands in the same frame.
		root.classList.add(SWITCHING_CLASS);
		root.setAttribute("data-kt-theme", theme);
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
		const changed = next.preference !== state.preference || next.applied !== state.applied;
		state = next;
		paint(next.applied);
		if (changed) for (const listener of listeners) listener();
	};
	const remember = () => {
		const cache: ThemeCache = { v: 2, preference: state.preference };
		try {
			storage?.setItem(THEME_STORAGE_KEY, JSON.stringify(cache));
		} catch {
			// Private browsing without storage: the page still switches; the next load follows the device.
		}
	};

	paint(state.applied);
	// A choice remembered under the old key, or from before light and dark, is written again as today's.
	if (read?.rewrite === true) remember();
	const onDevice = () => {
		if (state.preference === SYSTEM_THEME) set({ ...state, applied: resolve(SYSTEM_THEME) });
	};
	prefersLight?.addEventListener("change", onDevice);

	return {
		state: () => state,
		remembered: () => remembered,
		choose(named) {
			const preference = themePreference(named);
			remembered = true;
			set({ preference, applied: resolve(preference) });
			remember();
		},
		resolve,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose() {
			prefersLight?.removeEventListener?.("change", onDevice);
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
