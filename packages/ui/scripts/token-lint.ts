// The design loop's static gates: the token lint and the copy lint. Both run in CI through `pnpm test` (see
// token-lint.test.ts) and on their own with `node scripts/token-lint.ts`.
//
// Token lint: no raw colours or sizes outside src/tokens/tokens.css. A component's CSS reads custom properties;
// its TSX passes token names, never "#fff" or "12px".
// Copy lint: Tom's copy rules made mechanical. No uppercase tracked labels, no middle-dot meta strings, no arrows on
// buttons or anywhere else in rendered text.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Finding = { file: string; line: number; rule: string; text: string };

const TOKENS_FILE = "src/tokens/tokens.css";

const namedColours =
	/\b(white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|aqua|fuchsia|lime|maroon|olive)\b/i;

const cssRules: { rule: string; test: (line: string) => boolean }[] = [
	{ rule: "raw colour: use a --hb- colour token", test: (line) => /#[0-9a-f]{3,8}\b/i.test(line) },
	{
		rule: "raw colour function: use a --hb- colour token",
		test: (line) => /\b(rgba?|hsla?|oklch|oklab|lab|lch|color-mix|color)\(/i.test(line),
	},
	{
		rule: "named colour: use a --hb- colour token",
		test: (line) => /^\s*(color|background|border|fill|stroke|outline)[\w-]*\s*:/.test(line) && namedColours.test(line),
	},
	{
		// Media queries are the exception: custom properties cannot be used in them.
		rule: "raw size in px or rem: use a --hb- size token",
		test: (line) => !/^\s*@media/.test(line) && /(?<![\w-])\d*\.?\d+(px|rem)\b/.test(line),
	},
	{
		rule: "font-size must be a --hb-text token",
		test: (line) => /^\s*font-size\s*:/.test(line) && !/var\(--hb-|inherit/.test(line),
	},
	{
		rule: "border-radius must be a --hb-radius token",
		test: (line) =>
			/^\s*border-radius\s*:/.test(line) && !/var\(--hb-|inherit|^\s*border-radius\s*:\s*0\s*;/.test(line),
	},
	{ rule: "copy: no uppercase labels", test: (line) => /text-transform\s*:\s*uppercase/.test(line) },
	{ rule: "copy: no tracked labels", test: (line) => /^\s*letter-spacing\s*:/.test(line) },
];

// Arrows and the middle dot, in any string or JSX text a component renders.
const copyChars = /[·•→←↑↓↗↘↖↙⟶⟵⇒⇐»«➜➔]/;

const tsxRules: { rule: string; test: (line: string) => boolean }[] = [
	{
		rule: "raw colour in TSX: pass a token (token.status.done or var(--hb-...))",
		test: (line) => /["'`]#[0-9a-f]{3,8}["'`]/i.test(line) || /["'`](rgba?|hsla?|oklch)\(/i.test(line),
	},
	{
		rule: "raw size in TSX: use a --hb- size token",
		test: (line) =>
			/\b(width|height|size|fontSize|padding\w*|margin\w*|gap|top|left|right|bottom|inset|borderRadius|lineHeight)\s*[:=]\s*\{?\s*["'`][^"'`]*\d(px|rem)\b/.test(
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
	if (path === TOKENS_FILE || path.endsWith(".test.ts") || path.endsWith(".d.ts")) return [];
	const rules = path.endsWith(".css") ? cssRules : path.endsWith(".tsx") || path.endsWith(".ts") ? tsxRules : [];
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

if (import.meta.url === `file://${process.argv[1]}`) {
	const root = new URL("..", import.meta.url).pathname;
	const findings = lintPackage(root);
	for (const finding of findings) {
		console.log(
			`${relative(process.cwd(), join(root, finding.file))}:${finding.line}  ${finding.rule}\n    ${finding.text}`,
		);
	}
	console.log(
		findings.length === 0 ? "Token and copy lint: clean" : `Token and copy lint: ${findings.length} findings`,
	);
	process.exitCode = findings.length === 0 ? 0 : 1;
}
