// biome-ignore lint/correctness/noNodejsModules: the test reads tokens.css from disk, in Node, to hold Kantel to it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createThemeRegistry } from "../theme/registry.ts";
import { contrast, distance } from "./colour.ts";
import {
	FONT_DISPLAY,
	FONT_MONO,
	FONT_SANS,
	PALETTE_TOKENS,
	parseTheme,
	plainColour,
	type ResolvedTheme,
	SYSTEM_FONT_MONO,
	SYSTEM_FONT_SANS,
	THEME_TOKENS,
	themeCss,
} from "./theme-schema.ts";
import { builtinThemes } from "./themes/index.ts";

const registry = createThemeRegistry();
const themes = registry.list();
const colour = (theme: ResolvedTheme, name: string): string => {
	const value = plainColour(theme, name);
	if (value === undefined) throw new Error(`${theme.id}: ${name} is not a plain #rrggbb colour`);
	return value;
};

/** tokens.css's custom properties on :root, name to value. */
function rootTokens(): Map<string, string> {
	const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const tokens = new Map<string, string>();
	for (const match of css.matchAll(/--kt-([a-z0-9-]+):\s*([^;]+);/g))
		tokens.set(match[1] as string, (match[2] as string).trim());
	return tokens;
}

/** Status colours told apart: no pair closer than this in OKLab. Kantel's own closest pair, working and waiting, is about 0.1. */
const STATUS_DISTANCE = 0.08;
const STATUSES = ["working", "waiting", "approval", "done", "error"] as const;

describe("themes", () => {
	it("Kantel is tokens.css, colour for colour", () => {
		const harbour = registry.get("harbour")!;
		const root = rootTokens();
		for (const spec of THEME_TOKENS)
			expect([spec.name, harbour.tokens[spec.name]]).toEqual([spec.name, root.get(spec.name)]);
	});

	it("every colour token in tokens.css is a theme token", () => {
		const names = new Set(THEME_TOKENS.map((spec) => spec.name));
		// Colours that are the same in every theme: white on a solid colour, the scrim over an image, a logo's tile.
		const fixed = new Set(["on-solid", "thumb-scrim", "logo-tile"]);
		const colours = [...rootTokens()].filter(([, value]) => /#|rgb\(|color-mix\(/.test(value)).map(([name]) => name);
		expect(colours.filter((name) => !names.has(name) && !fixed.has(name))).toEqual([]);
	});

	it("every built-in theme has every token, a unique ID and safe CSS", () => {
		expect(new Set(builtinThemes.map((theme) => theme.id)).size).toBe(builtinThemes.length);
		for (const theme of themes) {
			for (const spec of THEME_TOKENS)
				expect([theme.id, spec.name, theme.tokens[spec.name] !== undefined]).toEqual([theme.id, spec.name, true]);
			const css = themeCss(theme);
			expect([css.split("{").length, css.split("}").length, css.endsWith("}")]).toEqual([2, 2, true]);
		}
	});

	it.each(themes.map((theme) => [theme.id, theme] as const))("%s: body text passes WCAG AA", (_id, theme) => {
		const surfaces = ["canvas", "panel", "raised", "user-message"];
		const failures: string[] = [];
		const check = (fg: string, bg: string, min: number) => {
			const ratio = contrast(colour(theme, fg), colour(theme, bg));
			if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
		};
		for (const surface of surfaces) {
			check("text", surface, 4.5);
			check("text-muted", surface, 4.5);
		}
		for (const surface of ["canvas", "panel"]) check("text-faint", surface, 4.5);
		check("text-faint", "raised", 4);
		check("accent-text", "canvas", 4.5);
		check("accent-text", "panel", 4.5);
		check("accent-fg", "accent", 4.5);
		for (const status of [...STATUSES, "idle"]) {
			check(`status-${status}`, "canvas", 4.5);
			check(`status-${status}`, "panel", 4.5);
		}
		for (const spec of THEME_TOKENS.filter((entry) => entry.group === "syntax")) check(spec.name, "code", 4.5);
		expect(failures).toEqual([]);
	});

	it.each(themes.map((theme) => [theme.id, theme] as const))("%s: the terminal is the theme's own", (_id, theme) => {
		// On the theme's code surface, not a fixed dark well; its text, prompt, errors and every ANSI colour read on it.
		expect(colour(theme, "terminal")).toBe(colour(theme, "code"));
		const failures: string[] = [];
		const names = [
			"terminal-text",
			"terminal-prompt",
			"terminal-stderr",
			...Array.from({ length: 16 }, (_, i) => `ansi-${i}`),
		];
		for (const name of names) {
			const ratio = contrast(colour(theme, name), colour(theme, "terminal"));
			if (ratio < 4.5) failures.push(`${name}: ${ratio.toFixed(2)}`);
		}
		expect(failures).toEqual([]);
	});

	it.each(themes.map((theme) => [theme.id, theme] as const))("%s: status colours are told apart", (_id, theme) => {
		const close: string[] = [];
		for (const [i, a] of STATUSES.entries())
			for (const b of STATUSES.slice(i + 1)) {
				const gap = distance(colour(theme, `status-${a}`), colour(theme, `status-${b}`));
				if (gap < STATUS_DISTANCE) close.push(`${a} and ${b}: ${gap.toFixed(3)}`);
			}
		expect(close).toEqual([]);
	});
});

describe("custom themes", () => {
	it("a theme saved before the rename, with --hb- names and references, keeps its colours (TASK-4231)", () => {
		const made = createThemeRegistry();
		const { theme, problems } = made.register({
			id: "custom-rose-pine",
			name: "Rosé Pine (saved)",
			kind: "dark",
			extends: "harbour",
			tokens: { "--hb-canvas": "#191724", text: "#e0def4", accent: "#ebbcba", "accent-text": "var(--hb-canvas)" },
		});
		expect(problems).toEqual([]);
		expect(theme?.tokens.canvas).toBe("#191724");
		expect(theme?.tokens["accent-text"]).toBe("var(--kt-canvas)");
		const css = made.css();
		expect(css).toContain('[data-kt-theme="custom-rose-pine"]');
		expect(css).toContain("--kt-canvas:#191724;");
		expect(css).not.toContain("--hb-"); // Nothing left from before the rename.
		expect(plainColour(theme!, "accent-text")).toBe("#191724");
	});

	it("a theme of a few colours resolves to every token", () => {
		const made = createThemeRegistry();
		const { theme, problems } = made.register({
			id: "custom-sea",
			name: "Sea",
			kind: "dark",
			tokens: { canvas: "#0b1d2a", text: "#e6f1f8", accent: "#2fa4d9" },
		});
		expect(problems).toEqual([]);
		for (const spec of THEME_TOKENS) expect(theme?.tokens[spec.name]).toBeDefined();
		// A palette token it left out is Kantel's; a derived one follows its own colours.
		expect(theme?.tokens["status-done"]).toBe("#5cbf8a");
		expect(theme?.tokens.hover).toBe("color-mix(in srgb, var(--kt-text) 5%, transparent)");
		expect(made.list().at(-1)?.id).toBe("custom-sea");
		expect(made.css()).toContain('[data-kt-theme="custom-sea"]');
	});

	it("a light theme falls back to Kantel light", () => {
		const { theme } = createThemeRegistry().register({ id: "custom-paper", name: "Paper", kind: "light", tokens: {} });
		expect(theme?.tokens.canvas).toBe("#f9f7f0");
		expect(theme?.tokens.border).toBe("color-mix(in srgb, var(--kt-text) 10%, transparent)");
	});

	it("the brand's ink follows the theme's kind, and its fonts are the brand's unless a theme sets its own", () => {
		const made = createThemeRegistry();
		const dark = made.register({ id: "custom-night", name: "Night", kind: "dark", tokens: {} }).theme;
		const light = made.register({ id: "custom-day", name: "Day", kind: "light", tokens: {} }).theme;
		expect([dark?.tokens["brand-ink"], light?.tokens["brand-ink"]]).toEqual(["#ffffff", "#252820"]);
		expect(dark?.tokens["brand-fulcrum"]).toBe("#ec7523");
		expect(dark?.tokens["font-sans"]).toBe(FONT_SANS);
		expect(dark?.tokens["font-display"]).toBe(FONT_DISPLAY);
		expect(dark?.tokens["font-mono"]).toBe(FONT_MONO);
		const neutral = registry.get("neutral");
		expect([neutral?.tokens["font-sans"], neutral?.tokens["font-mono"]]).toEqual([SYSTEM_FONT_SANS, SYSTEM_FONT_MONO]);
		expect(themeCss(neutral!)).toContain(`--kt-font-sans:${SYSTEM_FONT_SANS};`);
	});

	it("takes a custom theme's own fonts, but nothing that could load a file or end the rule", () => {
		const { theme, problems } = parseTheme({
			id: "custom-type",
			name: "Type",
			kind: "dark",
			tokens: {
				"font-sans": "Inter, system-ui, sans-serif",
				"font-display": "url(https://example.com/x.woff2)",
				"font-mono": "'JetBrains Mono', monospace",
			},
		});
		expect(theme?.tokens).toEqual({ "font-sans": "Inter, system-ui, sans-serif" });
		expect(problems.map((problem) => problem.path)).toEqual(["tokens.font-display", "tokens.font-mono"]);
	});

	it("drops unknown and unsafe tokens and refuses a bad shape", () => {
		const { theme, problems } = parseTheme({
			id: "custom-x",
			name: "X",
			kind: "dark",
			tokens: {
				canvas: "red;} body{display:none",
				text: "url(https://evil.example/x.png)",
				nope: "#fff",
				panel: "#111111",
			},
		});
		expect(theme?.tokens).toEqual({ panel: "#111111" });
		expect(problems.map((problem) => problem.path)).toEqual(["tokens.canvas", "tokens.text", "tokens.nope"]);
		expect(parseTheme({ id: "Bad ID", name: "", kind: "dim", tokens: [] }).theme).toBeUndefined();
		expect(parseTheme("nope").problems).toHaveLength(1);
	});

	it("won't replace a built-in theme", () => {
		const made = createThemeRegistry();
		expect(made.register({ id: "dracula", name: "Mine", kind: "dark", tokens: {} }).theme).toBeUndefined();
		made.remove("dracula");
		expect(made.get("dracula")).toBeDefined();
	});

	it("every palette token is set by Kantel and Kantel light", () => {
		for (const id of ["harbour", "harbour-light"]) {
			const own = builtinThemes.find((theme) => theme.id === id)!;
			expect(PALETTE_TOKENS.filter((name) => own.tokens[name] === undefined)).toEqual([]);
		}
	});
});
