// biome-ignore lint/correctness/noNodejsModules: the test reads the token files from disk, in Node, to check them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, distance } from "./colour.ts";

// Kantel's two themes are CSS: dark.css and light.css each set one palette, and tokens.css the formulas built on them.
// This reads the files as the browser would apply them to <html> (tokens.css, then dark.css on :root, then light.css on
// [data-kt-theme="light"] over it) and checks each theme as a person would see it.

type Tokens = ReadonlyMap<string, string>;

/** A token file's custom properties, name (without `--kt-`) to value, and the `color-scheme` it sets. */
function declarations(file: string): { tokens: Map<string, string>; scheme?: string } {
	const css = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const tokens = new Map<string, string>();
	for (const match of css.matchAll(/--kt-([a-z0-9-]+):\s*([^;]+);/g))
		tokens.set(match[1] as string, (match[2] as string).trim());
	const scheme = /color-scheme:\s*(\w+)/.exec(css)?.[1];
	return scheme === undefined ? { tokens } : { tokens, scheme };
}

const shared = declarations("./tokens.css");
const dark = declarations("./dark.css");
const light = declarations("./light.css");
const themes: Record<"dark" | "light", Tokens> = {
	dark: new Map([...shared.tokens, ...dark.tokens]),
	light: new Map([...shared.tokens, ...dark.tokens, ...light.tokens]),
};

/**
 * Follows `var(--kt-...)` references to a plain colour, for contrast checks. An opaque `color-mix(in srgb, <a> N%, <b>)`
 * of two such colours (the terminal's bright ANSI colours) is mixed as CSS mixes it.
 */
function plain(theme: Tokens, value: string, depth = 0): string | undefined {
	if (depth > 8) return undefined;
	const reference = /^var\(--kt-([a-z0-9-]+)\)$/.exec(value);
	if (reference !== null) {
		const next = theme.get(reference[1] as string);
		return next === undefined ? undefined : plain(theme, next, depth + 1);
	}
	const mix =
		/^color-mix\(in srgb, (var\(--kt-[a-z0-9-]+\)|#[0-9a-f]{6}) (\d+)%, (var\(--kt-[a-z0-9-]+\)|#[0-9a-f]{6})\)$/i.exec(
			value,
		);
	if (mix !== null) {
		const a = plain(theme, mix[1] as string, depth + 1);
		const b = plain(theme, mix[3] as string, depth + 1);
		if (a === undefined || b === undefined) return undefined;
		const share = Number(mix[2]) / 100;
		const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
		const mixed = [1, 3, 5].map((at) => Math.round(channel(a, at) * share + channel(b, at) * (1 - share)));
		return `#${mixed.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
	}
	return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}

const colour = (name: keyof typeof themes, token: string): string => {
	const value = themes[name].get(token);
	const resolved = value === undefined ? undefined : plain(themes[name], value);
	if (resolved === undefined) throw new Error(`${name}: ${token} is not a plain #rrggbb colour (${value})`);
	return resolved;
};

/** Status colours told apart: no pair closer than this in OKLab. The closest pair, working and waiting, is about 0.1. */
const STATUS_DISTANCE = 0.08;
const STATUSES = ["working", "waiting", "approval", "done", "error"] as const;
const SYNTAX = ["comment", "keyword", "string", "number", "function", "type", "property", "operator", "tag"];
const NAMES = ["dark", "light"] as const;

/** A raw colour: a hex, an `rgb()`, or a mix with a raw colour in it. */
const isRawColour = (value: string): boolean => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(value);

describe("the two themes", () => {
	it("dark.css and light.css set the same tokens, so swapping either leaves nothing of the other", () => {
		expect([...light.tokens.keys()].sort()).toEqual([...dark.tokens.keys()].sort());
		expect([dark.scheme, light.scheme]).toEqual(["dark", "light"]);
	});

	it("every raw colour is in a palette: tokens.css holds only formulas on them, and the fixed few", () => {
		// The same in both themes: white on a solid colour, the scrim over an image, the mark's orange.
		const fixed = new Set(["on-solid", "thumb-scrim", "brand-fulcrum"]);
		const raw = [...shared.tokens].filter(([name, value]) => isRawColour(value) && !fixed.has(name));
		expect(raw).toEqual([]);
		// And no palette token is set twice.
		expect([...dark.tokens.keys()].filter((name) => shared.tokens.has(name))).toEqual([]);
	});

	it("every token a formula names is defined", () => {
		for (const name of NAMES) {
			const missing = [...themes[name].values()].flatMap((value) =>
				[...value.matchAll(/var\(--kt-([a-z0-9-]+)\)/g)]
					.map((match) => match[1] as string)
					.filter((token) => !themes[name].has(token)),
			);
			expect([name, missing]).toEqual([name, []]);
		}
	});

	it.each(NAMES)("%s: body text passes WCAG AA", (name) => {
		const failures: string[] = [];
		const check = (fg: string, bg: string, min: number) => {
			const ratio = contrast(colour(name, fg), colour(name, bg));
			if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
		};
		for (const surface of ["canvas", "panel", "raised", "user-message"]) {
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
		for (const token of [...SYNTAX, "text", "variable", "punctuation", "regexp", "meta", "inserted", "deleted"])
			check(`syntax-${token}`, "code", 4.5);
		expect(failures).toEqual([]);
	});

	it.each(NAMES)("%s: the terminal is the theme's own", (name) => {
		// On the theme's code surface, not a fixed dark well; its text, prompt, errors and every ANSI colour read on it.
		expect(colour(name, "terminal")).toBe(colour(name, "code"));
		const failures: string[] = [];
		const tokens = [
			"terminal-text",
			"terminal-prompt",
			"terminal-stderr",
			...Array.from({ length: 16 }, (_, i) => `ansi-${i}`),
		];
		for (const token of tokens) {
			const ratio = contrast(colour(name, token), colour(name, "terminal"));
			if (ratio < 4.5) failures.push(`${token}: ${ratio.toFixed(2)}`);
		}
		expect(failures).toEqual([]);
	});

	it.each(NAMES)("%s: status colours are told apart", (name) => {
		const close: string[] = [];
		for (const [i, a] of STATUSES.entries())
			for (const b of STATUSES.slice(i + 1)) {
				const gap = distance(colour(name, `status-${a}`), colour(name, `status-${b}`));
				if (gap < STATUS_DISTANCE) close.push(`${a} and ${b}: ${gap.toFixed(3)}`);
			}
		expect(close).toEqual([]);
	});

	it("the brand's ink is the approved artwork's: white on dark, grey 900 on light", () => {
		expect([colour("dark", "brand-ink"), colour("light", "brand-ink")]).toEqual(["#ffffff", "#252820"]);
		expect(colour("dark", "brand-fulcrum")).toBe("#ec7523");
	});
});
