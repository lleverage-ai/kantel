// biome-ignore lint/correctness/noNodejsModules: the test reads tokens.css from disk, in Node, to hold Harbour to it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createThemeRegistry } from "../theme/registry.ts";
import { contrast, distance } from "./colour.ts";
import { PALETTE_TOKENS, parseTheme, plainColour, type ResolvedTheme, THEME_TOKENS, themeCss } from "./theme-schema.ts";
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
	for (const match of css.matchAll(/--hb-([a-z0-9-]+):\s*([^;]+);/g))
		tokens.set(match[1] as string, (match[2] as string).trim());
	return tokens;
}

/** Status colours told apart: no pair closer than this in OKLab. Harbour's own closest pair, working and waiting, is about 0.1. */
const STATUS_DISTANCE = 0.08;
const STATUSES = ["working", "waiting", "approval", "done", "error"] as const;

describe("themes", () => {
	it("Harbour is tokens.css, colour for colour", () => {
		const harbour = registry.get("harbour")!;
		const root = rootTokens();
		for (const spec of THEME_TOKENS)
			expect([spec.name, harbour.tokens[spec.name]]).toEqual([spec.name, root.get(spec.name)]);
	});

	it("every colour token in tokens.css is a theme token", () => {
		const names = new Set(THEME_TOKENS.map((spec) => spec.name));
		// Colours that are the same in every theme: white on a solid colour, the scrim over an image.
		const fixed = new Set(["on-solid", "thumb-scrim"]);
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
		// A palette token it left out is Harbour's; a derived one follows its own colours.
		expect(theme?.tokens["status-done"]).toBe("#34d399");
		expect(theme?.tokens.hover).toBe("color-mix(in srgb, var(--hb-text) 5%, transparent)");
		expect(made.list().at(-1)?.id).toBe("custom-sea");
		expect(made.css()).toContain('[data-hb-theme="custom-sea"]');
	});

	it("a light theme falls back to Harbour light", () => {
		const { theme } = createThemeRegistry().register({ id: "custom-paper", name: "Paper", kind: "light", tokens: {} });
		expect(theme?.tokens.canvas).toBe("#ffffff");
		expect(theme?.tokens.border).toBe("color-mix(in srgb, var(--hb-text) 10%, transparent)");
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

	it("every palette token is set by Harbour and Harbour light", () => {
		for (const id of ["harbour", "harbour-light"]) {
			const own = builtinThemes.find((theme) => theme.id === id)!;
			expect(PALETTE_TOKENS.filter((name) => own.tokens[name] === undefined)).toEqual([]);
		}
	});
});
