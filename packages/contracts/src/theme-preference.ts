/**
 * The console's theme: light, dark, or `system`, which follows the device's `prefers-color-scheme`. Kantel shipped a
 * dozen themes before 3 Nov 2026 (Kantel, Catppuccin, Dracula and the rest, from the agent console); a person's saved
 * theme (`UserPreferences.theme`) or a browser's remembered one may still name one of them, or a custom theme, and
 * `themePreference` reads each as the nearer of light and dark by its canvas's luminance, or as `system` where neither
 * is a clear match. Reading a value already light, dark or system gives it back, so the migration can run on every read.
 */

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

/** What a person chooses: follow the device, or one of the two themes. */
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** A theme on the page: what a preference shows. */
export type ThemeName = Exclude<ThemePreference, "system">;

export const isThemePreference = (value: unknown): value is ThemePreference =>
	(THEME_PREFERENCES as readonly unknown[]).includes(value);

/**
 * The canvas of every built-in theme Kantel had before light and dark, by ID, for the migration. The two Kantel themes
 * (and their IDs before the rename) were the light and dark of today.
 */
export const RETIRED_THEME_CANVAS: { readonly [id: string]: string } = {
	kantel: "#141e28",
	"kantel-light": "#f9f7f0",
	harbour: "#141e28", // before the rename
	"harbour-light": "#f9f7f0", // before the rename
	neutral: "#0a0a0a",
	"neutral-light": "#ffffff",
	"catppuccin-mocha": "#181825",
	"catppuccin-latte": "#eff1f5",
	dracula: "#21222c",
	gruvbox: "#1d2021",
	nord: "#2a303b",
	"one-dark": "#21252b",
	"rose-pine": "#191724",
	"tokyo-night": "#16161e",
	"github-light": "#ffffff",
	"solarized-light": "#fdf6e3",
};

/** The two themes' canvases the migration measures against: the Kantel themes' own, which light and dark kept. */
const DARK_CANVAS = "#141e28";
const LIGHT_CANVAS = "#f9f7f0";

/**
 * How much nearer, as a ratio of WCAG contrasts, a canvas must be to one theme's than to the other's to count as a clear
 * match. A mid grey is about as far from both, so it follows the device instead.
 */
const CLEAR_MATCH = 1.5;

const channel = (hex: string, at: number): number => {
	const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2 relative luminance of a `#rrggbb` colour; undefined for anything else. */
function luminance(hex: string): number | undefined {
	if (!/^#[0-9a-f]{6}$/i.test(hex)) return undefined;
	return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * The nearer of light and dark to a theme with this canvas, by luminance: the one it has the lower contrast with, when
 * that is at least `CLEAR_MATCH` times lower than with the other. Otherwise (or for a canvas that isn't `#rrggbb`)
 * `system`.
 */
export function themeForCanvas(canvas: string): ThemePreference {
	const own = luminance(canvas);
	if (own === undefined) return "system";
	const toDark = ratio(own, luminance(DARK_CANVAS) as number);
	const toLight = ratio(own, luminance(LIGHT_CANVAS) as number);
	if (toDark * CLEAR_MATCH <= toLight) return "dark";
	if (toLight * CLEAR_MATCH <= toDark) return "light";
	return "system";
}

/**
 * A saved theme as today's preference. Light, dark and system are kept; a retired built-in theme is the nearer of light
 * and dark by its canvas; anything else (a custom theme's ID, a theme from a newer console) is the nearer to `canvas`,
 * when the caller knows the theme's canvas (a browser remembers its CSS), else `system`. Idempotent.
 */
export function themePreference(saved: string, canvas?: string): ThemePreference {
	if (isThemePreference(saved)) return saved;
	const known = Object.hasOwn(RETIRED_THEME_CANVAS, saved) ? RETIRED_THEME_CANVAS[saved] : canvas;
	return known === undefined ? "system" : themeForCanvas(known);
}
