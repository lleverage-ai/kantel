// The design loop's static gates: the token lint and the copy lint. Both run in CI through `pnpm test` (see
// token-lint.test.ts) and on their own with `node scripts/token-lint.ts`.
//
// Token lint: no raw colours or sizes outside src/tokens/tokens.css. A component's CSS reads custom properties;
// its TSX passes token names, never "#fff" or "12px", and its Tailwind classes use the token utilities that
// src/tokens/tailwind.css maps, never an arbitrary value such as `p-[13px]` or `bg-[#fff]`.
// Copy lint: Tom's copy rules made mechanical. No uppercase tracked labels, no middle-dot meta strings, no arrows on
// buttons or anywhere else in rendered text.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type Finding = { file: string; line: number; rule: string; text: string };

const TOKENS_FILE = "src/tokens/tokens.css";
// Tailwind's @theme: only var(--kt-*) references, plus Tailwind's 4px spacing step and its breakpoints.
const TAILWIND_THEME = "src/tokens/tailwind.css";
const THEMES_DIR = "src/tokens/themes/";
const THEME_SCHEMA = "src/tokens/theme-schema.ts";

const namedColours =
	/\b(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|aqua|fuchsia|lime|maroon|olive)\b/i;

const cssRules: { rule: string; test: (line: string) => boolean }[] = [
	{ rule: "raw colour: use a --kt- colour token", test: (line) => /#[0-9a-f]{3,8}\b/i.test(line) },
	{
		rule: "raw colour function: use a --kt- colour token",
		test: (line) => /\b(rgba?|hsla?|oklch|oklab|lab|lch|color-mix|color)\(/i.test(line),
	},
	{
		rule: "named colour: use a --kt- colour token",
		test: (line) => /^\s*(color|background|border|fill|stroke|outline)[\w-]*\s*:/.test(line) && namedColours.test(line),
	},
	{
		// Media and container queries are the exception: custom properties cannot be used in them.
		rule: "raw size in px or rem: use a --kt- size token",
		test: (line) => !/^\s*@(media|container)/.test(line) && /(?<![\w-])\d*\.?\d+(px|rem)\b/.test(line),
	},
	{
		// Only where a duration can be: animation and transition declarations, not selectors or keyframe names.
		rule: "raw duration: use a --kt-duration token",
		test: (line) =>
			/^\s*(animation|transition)[\w-]*\s*:/.test(line) &&
			/(?<![\w.-])\d*\.?\d+m?s\b/.test(line.slice(line.indexOf(":") + 1)),
	},
	{
		rule: "font-size must be a --kt-text token",
		test: (line) => /^\s*font-size\s*:/.test(line) && !/var\(--kt-|inherit/.test(line),
	},
	{
		rule: "border-radius must be a --kt-radius token",
		test: (line) =>
			/^\s*border-radius\s*:/.test(line) && !/var\(--kt-|inherit|^\s*border-radius\s*:\s*0\s*;/.test(line),
	},
	{ rule: "copy: no uppercase labels", test: (line) => /text-transform\s*:\s*uppercase/.test(line) },
	{ rule: "copy: no tracked labels", test: (line) => /^\s*letter-spacing\s*:/.test(line) },
];

// Arrows and the middle dot, in any string or JSX text a component renders.
const copyChars = /[·•→←↑↓↗↘↖↙⟶⟵⇒⇐»«➜➔]/;

const tsxRules: { rule: string; test: (line: string) => boolean }[] = [
	{
		rule: "raw colour in TSX: pass a token (token.status.done or var(--kt-...))",
		test: (line) => /["'`]#[0-9a-f]{3,8}["'`]/i.test(line) || /["'`](rgba?|hsla?|oklch)\(/i.test(line),
	},
	{
		rule: "raw size in TSX: use a --kt- size token",
		test: (line) =>
			/\b(width|height|size|fontSize|padding\w*|margin\w*|gap|top|left|right|bottom|inset|borderRadius|lineHeight)\s*[:=]\s*\{?\s*["'`][^"'`]*\d(px|rem)\b/.test(
				stripComment(line),
			),
	},
	{
		// React reads a bare number on these properties as px. Zero and unitless line heights are fine, and so is a
		// Ladle story's `meta` (its viewport width, not a style). Applied to .tsx only (see lintSource), where styles
		// live, so plain data such as `{ left: 1, top: 2 }` in a .ts module is left alone.
		rule: "raw numeric size in a style: use a --kt- size token",
		test: (line) =>
			!/\.meta\s*=/.test(line) &&
			/\b(width|height|minWidth|maxWidth|minHeight|maxHeight|fontSize|padding\w*|margin\w*|gap|rowGap|columnGap|top|left|right|bottom|inset\w*|borderRadius|borderWidth|outlineWidth|outlineOffset)\s*:\s*-?([1-9]\d*(\.\d+)?|0?\.\d*[1-9]\d*)\s*[,}]/.test(
				stripComment(line),
			),
	},
	{
		rule: "raw duration in TSX: use a --kt-duration token",
		test: (line) =>
			/\b(animation|transition)(Duration|Delay)?\s*:\s*["'`][^"'`]*(?<![\w.-])\d*\.?\d+m?s\b/.test(stripComment(line)),
	},
	{
		// A Tailwind arbitrary value with a raw size, colour or duration: `p-[13px]`, `max-w-[40rem]`, `bg-[#fff]`,
		// `text-[rgb(0_0_0)]`, `duration-[150ms]`. Use a spacing step or a token utility, or `p-(--kt-...)` for a token
		// that has no utility.
		rule: "arbitrary value in a utility class: use a spacing step or a token utility",
		test: (line) =>
			/[\w:-]-\[[^\]\s"'`]*(\d(px|rem|m?s)\b|#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|color-mix)\()/i.test(
				stripComment(line),
			),
	},
	{ rule: "copy: no arrows or middle dots in rendered text", test: (line) => copyChars.test(stripComment(line)) },
];

function stripComment(line: string): string {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
	const index = line.indexOf(" // ");
	return index === -1 ? line : line.slice(0, index);
}

function files(root: string, dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(join(root, dir))) {
		const path = join(dir, name);
		if (statSync(join(root, path)).isDirectory()) files(root, path, out);
		else out.push(path);
	}
	return out;
}

/** Lints one file's text. `path` is relative to the package root. */
export function lintSource(path: string, text: string): Finding[] {
	// Themes are tokens too: src/tokens/themes/ holds each built-in theme's colours, and the schema the derived ones.
	const tokens =
		path === TOKENS_FILE || path === TAILWIND_THEME || path === THEME_SCHEMA || path.startsWith(THEMES_DIR);
	if (tokens || path.endsWith(".test.ts") || path.endsWith(".d.ts")) return [];
	const rules = path.endsWith(".css")
		? cssRules
		: path.endsWith(".tsx")
			? tsxRules
			: path.endsWith(".ts")
				? tsxRules.filter((entry) => !entry.rule.startsWith("raw numeric size"))
				: [];
	const findings: Finding[] = [];
	let inBlockComment = false;
	text.split("\n").forEach((raw, index) => {
		let line = raw;
		if (path.endsWith(".css")) {
			// Ignore CSS comments, which may name raw values to explain a token.
			if (inBlockComment) {
				const end = line.indexOf("*/");
				if (end === -1) return;
				line = line.slice(end + 2);
				inBlockComment = false;
			}
			line = line.replace(/\/\*.*?\*\//g, "");
			const start = line.indexOf("/*");
			if (start !== -1) {
				line = line.slice(0, start);
				inBlockComment = true;
			}
		}
		for (const { rule, test } of rules) {
			if (test(line)) findings.push({ file: path, line: index + 1, rule, text: raw.trim() });
		}
	});
	return findings;
}

/** Lints every source file under src/ (and the workbench's own CSS) in the package at `root`. */
export function lintPackage(root: string): Finding[] {
	return [...files(root, "src"), ...files(root, ".ladle")]
		.filter((path) => /\.(css|tsx?|ts)$/.test(path))
		.flatMap((path) => lintSource(path, readFileSync(join(root, path), "utf8")));
}

/**
 * Lints a host app that builds on the library (apps/console): its CSS and TSX under src/, where its UI lives. Plain
 * .ts there is the app's logic (timers, protocol numbers), not styling, so it is left alone.
 */
export function lintHost(root: string): Finding[] {
	return files(root, "src")
		.filter((path) => /\.(css|tsx)$/.test(path))
		.flatMap((path) => lintSource(path, readFileSync(join(root, path), "utf8")));
}

// node scripts/token-lint.ts [host-app-dir ...]: the library itself, then each host app given.
if (import.meta.url === `file://${process.argv[1]}`) {
	const root = new URL("..", import.meta.url).pathname;
	const checked = [
		{ root, findings: lintPackage(root) },
		...process.argv.slice(2).map((dir) => ({ root: resolve(dir), findings: lintHost(resolve(dir)) })),
	];
	const findings = checked.flatMap((entry) => entry.findings);
	for (const entry of checked) {
		for (const finding of entry.findings) {
			console.log(
				`${relative(process.cwd(), join(entry.root, finding.file))}:${finding.line}  ${finding.rule}\n    ${finding.text}`,
			);
		}
	}
	console.log(
		findings.length === 0 ? "Token and copy lint: clean" : `Token and copy lint: ${findings.length} findings`,
	);
	process.exitCode = findings.length === 0 ? 0 : 1;
}
